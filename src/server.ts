import { randomBytes } from 'node:crypto';
import {
  isTerminal,
  type CreateTaskOptions,
  type TaskStore,
} from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Request, RequestId, Result, Task, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Calls } from './calls.js';
import { createDiscovery, instructionsFor, invocation, invokeTool } from './discovery.js';
import { fail, parseWith, CellerError } from './errors.js';
import { hash } from './json.js';
import { taskListing, type appLimits } from './limits.js';
import type { Runs } from './runs.js';
import type { Run, Store } from './store.js';

/**
 * This library's own version, which a client sees as the server's: its package's, as a test holds it. Written here,
 * not read from its package's file, which a host that bundles it doesn't have beside it.
 */
const VERSION = '0.7.0';

/** The client's own key for a call, if it gave one: a malformed one is its mistake, answered as a protocol error. */
function callIdOf(meta: Record<string, unknown> | undefined, maxChars: number): string | undefined {
  const key = meta?.['celler/call-id'];
  if (key === undefined) return undefined;
  // oxlint-disable-next-line no-control-regex -- a key may hold no control character: this finds them on purpose
  if (typeof key !== 'string' || key.length === 0 || key.length > maxChars || /[\x00-\x1f\x7f]/.test(key)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid celler/call-id metadata key');
  }
  return key;
}

// Failures return as results the model can read and act on (MCP 2025-11-25). Only this library's own messages
// show: raw host, adapter and SQLite errors never reach the harness.
function refusal(error: unknown): CallToolResult {
  const text = error instanceof CellerError ? error.message : 'Tool execution failed';
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * A connection's tasks, as MCP's task store keeps them: each kept while it works, however long a person takes, and for
 * its ttl once it has ended, as the SDK's CreateTaskOptions say. Its work, by task, is what tasks/cancel stops: the SDK
 * reports a cancel only as a status change.
 */
class TaskWork implements TaskStore {
  readonly work = new Map<string, AbortController>();
  private kept = new Map<
    string,
    { task: Task; result?: Result; sessionId: string | undefined; timer?: NodeJS.Timeout }
  >();

  /** A task its session may see: none of another session's. */
  private find(taskId: string, sessionId?: string) {
    const kept = this.kept.get(taskId);
    if (!kept || (sessionId !== undefined && kept.sessionId !== undefined && kept.sessionId !== sessionId))
      return undefined;
    return kept;
  }
  private found(taskId: string, sessionId?: string) {
    const kept = this.find(taskId, sessionId);
    if (!kept) throw new Error(`Task ${taskId} not found`);
    return kept;
  }

  /** Its new status, once: an ended task's stays. Kept for its ttl from its end. */
  private settle(taskId: string, status: Task['status'], sessionId?: string, message?: string) {
    const kept = this.found(taskId, sessionId);
    if (isTerminal(kept.task.status)) throw new Error(`Task ${taskId} has ended already`);
    kept.task = {
      ...kept.task,
      status,
      lastUpdatedAt: new Date().toISOString(),
      ...(message ? { statusMessage: message } : {}),
    };
    if (isTerminal(status) && kept.task.ttl !== null) {
      kept.timer = setTimeout(() => this.kept.delete(taskId), kept.task.ttl);
      kept.timer.unref();
    }
    return kept;
  }

  async createTask(options: CreateTaskOptions, _requestId: RequestId, _request: Request, sessionId?: string) {
    const now = new Date().toISOString();
    const task: Task = {
      taskId: randomBytes(16).toString('hex'),
      status: 'working',
      ttl: options.ttl ?? null,
      createdAt: now,
      lastUpdatedAt: now,
      pollInterval: options.pollInterval ?? taskListing.pollMs,
    };
    this.kept.set(task.taskId, { task, sessionId });
    return { ...task };
  }
  async getTask(taskId: string, sessionId?: string) {
    const kept = this.find(taskId, sessionId);
    return kept ? { ...kept.task } : null;
  }
  async storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result, sessionId?: string) {
    this.settle(taskId, status, sessionId).result = result;
  }
  async getTaskResult(taskId: string, sessionId?: string) {
    const { result } = this.found(taskId, sessionId);
    if (!result) throw new Error(`Task ${taskId} has no result yet`);
    return result;
  }
  async updateTaskStatus(taskId: string, status: Task['status'], message?: string, sessionId?: string) {
    this.settle(taskId, status, sessionId, message);
    if (status === 'cancelled') this.work.get(taskId)?.abort();
  }
  async listTasks(cursor?: string, sessionId?: string) {
    const ids = [...this.kept.keys()].filter((id) => this.find(id, sessionId));
    const start = cursor === undefined ? 0 : ids.indexOf(cursor) + 1;
    if (cursor !== undefined && start === 0) throw new Error(`Invalid cursor: ${cursor}`);
    const page = ids.slice(start, start + taskListing.pageSize);
    const tasks = page.flatMap((id) => {
      const kept = this.kept.get(id);
      return kept ? [{ ...kept.task }] : [];
    });
    const last = page.at(-1);
    return start + taskListing.pageSize < ids.length && last !== undefined ? { tasks, nextCursor: last } : { tasks };
  }

  /** Every task gone, and its timer with it: its connection has closed. */
  cleanup() {
    for (const { timer } of this.kept.values()) clearTimeout(timer);
    this.kept.clear();
  }
}

/**
 * A run's MCP server, one for each connection its agent opens: the tools it lists, the calls and tasks it takes, and
 * the word that the tools changed, to one run's connections or to all.
 */
export function createServer(runs: Runs, call: Calls['call'], store: Store, limits: typeof appLimits) {
  const discovery = createDiscovery(limits);
  const connections = new Map<string, Set<Server>>(); // run id → its open MCP connections

  /** What the run's server holds, in its host's words; none once the run may reach nothing, or its policy fails. */
  function instructions(run: Run): string | undefined {
    try {
      runs.checkAncestors(run);
      const graph = runs.graph(run.revision);
      return instructionsFor(graph, run.entry, runs.access(run), limits.instructionsChars) || undefined;
    } catch {
      return undefined;
    }
  }

  async function connect(run: Run, channel: Transport, native = false) {
    const tasks = new TaskWork();
    const told = instructions(run);
    const server = new Server(
      { name: 'celler', version: VERSION },
      {
        capabilities: {
          tools: { listChanged: true },
          tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        },
        ...(told === undefined ? {} : { instructions: told }),
        taskStore: tasks,
      },
    );
    const current = runs.graph(run.revision);
    const connection = new AbortController();
    let advertised: Set<string> | undefined;
    let invokeAdvertised = false;

    function menu() {
      runs.checkAncestors(run);
      const tools: Tool[] = [];
      let jsonBytes = 2; // "[]"
      for (const id of current.view(run.entry, runs.access(run)).keys()) {
        const meta = current.meta(id);
        if (meta.kind === 'tool') {
          tools.push(meta.exposed);
          jsonBytes += meta.exposedBytes + (tools.length > 1 ? 1 : 0);
        }
      }
      // An agent that searches its tools itself gets them all, and nothing to search them with besides.
      if (native) return { tools };
      // Once a connection moves to discover and invoke it stays there, so the model's `invoke` calls keep working.
      if (!invokeAdvertised && jsonBytes <= limits.discoveryBytes) return { tools: [...tools, discovery.tool] };
      invokeAdvertised = true;
      const pins = new Set(current.cell(run.entry).pins);
      return { tools: [...tools.filter((tool) => pins.has(tool.name)), discovery.tool, invokeTool] };
    }

    // The tools this connection is listed, in celler's words when the host's policy or the database fails: never raw
    // errors across the MCP boundary.
    function list(signal: AbortSignal) {
      try {
        const result = menu();
        advertised = new Set(result.tools.map((tool) => tool.name));
        return result;
      } catch (error) {
        if (error instanceof CellerError || signal.aborted) throw error;
        fail('UNAVAILABLE', 'Tool listing failed');
      }
    }

    server.setRequestHandler(ListToolsRequestSchema, (_request, extra) => list(extra.signal));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      // Before a call's own answer, as when the database fails as it begins, only this library's errors go out too.
      try {
        if (!advertised) list(extra.signal);
        if (!advertised!.has(params.name)) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool: ' + params.name);
        const callId = callIdOf(params._meta, limits.callIdChars);
        // The request or task, the connection, or the run can end this call. Approvals and delegated runs outlive it.
        const owned = store.ended(run.id) ? [] : [runs.lifetime(run.id)];
        // Whatever goes wrong from here, an adapter's or the host's own error too, the model reads in celler's words.
        async function respond(signal: AbortSignal, heartbeat?: () => void): Promise<CallToolResult> {
          try {
            const args = params.arguments ?? {};
            if (params.name === 'discover') {
              runs.checkAncestors(run);
              return {
                content: [{ type: 'text', text: discovery.discover(current, run.entry, runs.access(run), args) }],
              };
            }
            const request =
              params.name === 'invoke'
                ? parseWith(invocation, 'invoke arguments', args)
                : { name: params.name, arguments: args };
            // Without `celler/call-id`, the tool and arguments are the key, so a blind retry joins the first call's
            // approval or child run; the same call once its approval is settled is one of its own (store.callKey).
            const key = callId ?? store.callKey(run, hash([request.name, request.arguments]));
            return await call(run, request.name, request.arguments, key, signal, { heartbeat, asTask: !!params.task });
          } catch (error) {
            // Cut off by its run's end, a call hears that, never what its adapter threw as it stopped.
            const runEnded = owned.some((lifetimeSignal) => lifetimeSignal.aborted);
            return refusal(runEnded ? new CellerError('RUN_ENDED', 'Run has ended') : error);
          }
        }

        if (!params.task) {
          const progressToken = extra._meta?.progressToken;
          let progress = 0;
          const heartbeat =
            progressToken === undefined
              ? undefined
              : () =>
                  void extra
                    .sendNotification({
                      method: 'notifications/progress',
                      params: { progressToken, progress: ++progress, message: 'Still working' },
                    })
                    .catch(() => {});
          return await respond(AbortSignal.any([extra.signal, connection.signal, ...owned]), heartbeat);
        }
        // A connection works on only so many tasks at once, none kept longer than the app keeps one: MCP lets the
        // receiver say.
        if (tasks.work.size >= limits.maxTasks) fail('LIMIT_EXCEEDED', 'Too many tasks on this connection');
        const ttl = Math.min(params.task.ttl ?? limits.taskTtlMs, limits.taskTtlMs);
        const task = await extra.taskStore!.createTask({ ttl });
        const work = new AbortController();
        tasks.work.set(task.taskId, work);
        void respond(AbortSignal.any([work.signal, connection.signal, ...owned]))
          .then(async (result) => {
            // A cancelled task keeps its status; any other outcome is stored for tasks/result.
            if (!work.signal.aborted)
              await extra.taskStore!.storeTaskResult(task.taskId, result.isError ? 'failed' : 'completed', result);
          })
          .catch(() => {})
          .finally(() => tasks.work.delete(task.taskId));
        return { task };
      } catch (error) {
        if (error instanceof McpError || error instanceof CellerError) throw error;
        fail('UNAVAILABLE', 'Tool execution failed');
      }
    });

    const group = connections.get(run.id) ?? new Set<Server>();
    connections.set(run.id, group);
    group.add(server);
    function forget() {
      connection.abort();
      // Its tasks were this connection's alone: nothing can ask for them now, and their timers would outlive it.
      tasks.cleanup();
      group.delete(server);
      if (group.size === 0 && connections.get(run.id) === group) connections.delete(run.id);
    }
    server.onclose = forget;
    try {
      await server.connect(channel);
    } catch (error) {
      forget(); // a connection that never started is no one's to tell
      throw error;
    }
  }

  async function notifyToolsChanged(runId?: string) {
    const targets = runId ? [...(connections.get(runId) ?? [])] : [...connections.values()].flatMap((set) => [...set]);
    await Promise.allSettled(targets.map((server) => server.sendToolListChanged()));
  }

  return { connect, notifyToolsChanged };
}
