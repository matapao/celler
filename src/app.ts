import { createHash, randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  CallToolRequestSchema, CallToolResultSchema, ErrorCode, ListToolsRequestSchema, McpError,
} from "@modelcontextprotocol/sdk/types.js"
import type { CallToolResult, Task, Tool } from "@modelcontextprotocol/sdk/types.js"
import { compileGraph, type Binding, type Graph, type Cell } from "./catalog.js"
import { discover, discoverTool, invocation, invokeTool } from "./discovery.js"
import { fail, parseWith, CellerError } from "./errors.js"
import { canonicalJson, normalizeJson } from "./json.js"
import { appLimits, withLimits } from "./limits.js"
import { freezeRun, openStore, raceAbort, type Run, type Write } from "./store.js"

type Args = Record<string, unknown>

/**
 * A host capability behind a tool. It either `call`s at once, or `prepare`s a complete packet that a person approves
 * before `send` delivers exactly that packet. Anything that moves data to a third party takes the second form.
 * `verify`, or else `send`, must refuse a packet the adapter would not produce now, such as one for another account.
 * A refusal in `verify` keeps the approval pending; a throw from `send` leaves the delivery `unknown`.
 */
export type Adapter =
  | { call(run: Run, args: Args, signal: AbortSignal): Promise<CallToolResult> }
  | {
      prepare(run: Run, args: Args, signal?: AbortSignal): Promise<Write>
      verify?(run: Run, write: Write): void | Promise<void>
      send(run: Run, write: Write, key: string, signal?: AbortSignal): Promise<CallToolResult>
    }

export type Platform = {
  /** The live policy for node `id`, asked on every listing and call: keep it fast. */
  allowed(run: Run, id: string): boolean
  /** Starts the harness, hands its MCP transport to `connect`, and settles with the run's result. */
  launch(spec: Run & { profile: string; context: Cell["context"]; input: unknown },
    connect: (transport: Transport, nativeDiscovery?: boolean) => Promise<void>,
    signal: AbortSignal): Promise<CallToolResult>
}

export type Start = Pick<Run, "owner" | "revision" | "entry" | "workspace"> & { input: unknown }
export type AppOptions = {
  database: DatabaseSync
  platform: Platform
  /** The host's adapters by id, read live: the host may add one for tools it publishes later. */
  adapters: ReadonlyMap<string, Adapter>
} & Partial<typeof appLimits>

const startRequest = z.strictObject({
  owner: z.string().min(1), revision: z.string().min(1), entry: z.string().min(1), workspace: z.string().min(1),
  input: z.unknown(),
})

function createLru<V>(limit: number) {
  const map = new Map<string, V>()
  return {
    get(key: string): V | undefined {
      const value = map.get(key)
      if (value !== undefined) {
        map.delete(key)
        map.set(key, value)
      }
      return value
    },
    set(key: string, value: V) {
      map.delete(key)
      map.set(key, value)
      if (map.size > limit) map.delete(map.keys().next().value!)
    },
  }
}

function checkedResult(current: Graph, id: string, value: unknown): CallToolResult {
  const parsed = CallToolResultSchema.safeParse(value)
  if (!parsed.success) fail("INVALID_OUTPUT", "Invalid tool result for " + id)
  if (!parsed.data.isError) current.validateOutput(id, parsed.data.structuredContent)
  return parsed.data
}

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
const codeOf = (error: unknown) => (error instanceof CellerError ? error.code : undefined)

// Without `celler/call-id`, the tool and arguments are the key, so a blind retry joins the first call's approval
// or child run.
function callKey(meta: Record<string, unknown> | undefined, tool: string, args: Args): string {
  const key = meta?.["celler/call-id"]
  if (key === undefined) return hash([tool, args])
  if (typeof key !== "string" || key.length === 0 || key.length > 128 || /[\x00-\x1f\x7f]/.test(key)) {
    throw new McpError(ErrorCode.InvalidParams, "Invalid celler/call-id metadata key")
  }
  return key
}

// Failures return as results the model can read and act on (MCP 2025-11-25). Only this library's own messages
// show: raw host, adapter and SQLite errors never reach the harness.
function refusal(error: unknown): CallToolResult {
  const text = error instanceof CellerError || error instanceof McpError ? error.message : "Tool execution failed"
  return { isError: true, content: [{ type: "text", text }] }
}

// The SDK reports tasks/cancel only as a status change, so this is where a cancelled task's work stops.
class TaskWork extends InMemoryTaskStore {
  readonly work = new Map<string, AbortController>()
  override async updateTaskStatus(taskId: string, status: Task["status"], message?: string, sessionId?: string) {
    if (status === "cancelled") this.work.get(taskId)?.abort()
    return super.updateTaskStatus(taskId, status, message, sessionId)
  }
}

export function createApp(options: AppOptions) {
  // The host's own map, read on each publish and call: an adapter it adds later serves what it publishes after.
  const { database, platform, adapters: registry } = options
  const limits = withLimits(appLimits, options)
  const store = openStore(database, limits)
  const adapterIds = () => new Set(registry.keys())
  const graphs = createLru<Graph>(limits.graphCacheSize)
  const runCache = createLru<{ run: Run; grants: ReadonlySet<string> }>(256)
  const activeCalls = new Map<string, number>() // run id → tool calls in flight
  const activeRuns = new Map<string, number>() // root run id → runs in flight in its delegation tree
  const lifetimes = new Map<string, AbortController>() // run id → ends everything the run owns
  const delegations = new Map<string, Map<string, Promise<CallToolResult>>>() // run id → its uncollected children
  const connections = new Map<string, Set<Server>>() // run id → its open MCP connections

  function graph(revision: string) {
    let current = graphs.get(revision)
    if (!current) {
      // Stored revisions skip the adapter check, so retiring an adapter fails only the calls that use it.
      current = compileGraph(store.revision(revision), adapterIds(), false)
      graphs.set(revision, current)
    }
    return current
  }

  function loadRunCached(id: string) {
    let cached = runCache.get(id)
    if (!cached) {
      const loaded = store.loadRun(id)
      cached = { run: loaded.run, grants: new Set(loaded.grants) }
      runCache.set(id, cached)
    }
    return cached
  }

  function access(run: Run) {
    const { grants } = loadRunCached(run.id)
    return (id: string) => grants.has(id) && platform.allowed(run, id)
  }

  /** The signal that ends what a run owns in this process: its calls, its waits and its delegated runs. */
  function lifetime(runId: string) {
    let controller = lifetimes.get(runId)
    if (!controller) lifetimes.set(runId, (controller = new AbortController()))
    return controller.signal
  }
  function stop(runId: string) {
    lifetimes.get(runId)?.abort()
    lifetimes.delete(runId)
    delegations.delete(runId)
  }
  function rootOf(runId: string) {
    let run = loadRunCached(runId).run
    while (run.parent) run = loadRunCached(run.parent.run).run
    return run.id
  }
  /** Counts work in flight under a key, refuses more than `limit`, and returns the release. */
  function admit(counts: Map<string, number>, key: string, limit: number, message: string) {
    const count = counts.get(key) ?? 0
    if (count >= limit) fail("LIMIT_EXCEEDED", message)
    counts.set(key, count + 1)
    return () => {
      const left = (counts.get(key) ?? 1) - 1
      if (left > 0) counts.set(key, left)
      else counts.delete(key)
    }
  }
  /** Waits for work that outlives the request: aborting detaches this caller only. Heartbeats keep clients waiting. */
  async function waitFor<T>(work: Promise<T>, signal: AbortSignal, heartbeat?: () => void): Promise<T> {
    const timer = heartbeat && limits.progressIntervalMs ? setInterval(heartbeat, limits.progressIntervalMs) : undefined
    timer?.unref()
    try {
      return await raceAbort(work, signal)
    } finally {
      clearInterval(timer)
    }
  }

  // `requireActive` refuses new calls under an ended ancestor; listings and staged approvals still work there.
  function checkAncestors(run: Run, requireActive = false) {
    let parent = run.parent
    while (parent) {
      const caller = loadRunCached(parent.run).run
      if (requireActive && store.ended(caller.id)) fail("RUN_ENDED", "Parent run has ended")
      if (!graph(caller.revision).reaches(caller.entry, parent.tool, access(caller))) fail("REVOKED", "Delegation revoked")
      parent = caller.parent
    }
  }

  function binding(run: Run, id: string, requireActive = false): Binding {
    checkAncestors(run, requireActive)
    const current = graph(run.revision)
    if (!current.reaches(run.entry, id, access(run))) fail("DENIED", "Tool outside this run: " + id)
    const node = current.get(id)
    if (node.kind !== "tool") fail("INVALID_ARGS", "Expected a tool: " + id)
    return node
  }

  async function startRun(request: Start, signal: AbortSignal, parent: Run["parent"]): Promise<CallToolResult> {
    signal.throwIfAborted()
    const input = normalizeJson(request.input)
    const { input: _raw, ...settings } = request
    const run = freezeRun({ ...settings, id: randomUUID(), parent })
    const current = graph(run.revision)
    const entry = current.runnableCell(run.entry)

    // Cap the depth, and keep denied whatever an ancestor could reach but was denied.
    const deniedByAncestors = new Set<string>()
    let depth = 0
    for (let ancestor = parent; ancestor;) {
      if (++depth > limits.maxDepth) fail("LIMIT_EXCEEDED", "Maximum delegation depth exceeded")
      const loaded = loadRunCached(ancestor.run)
      for (const id of graph(loaded.run.revision).staticReachable(loaded.run.entry)) {
        if (!loaded.grants.has(id)) deniedByAncestors.add(id)
      }
      ancestor = loaded.run.parent
    }

    // Policy is asked only about what this cell can reach, so rules can be scoped to cells.
    const grants = [...current.staticReachable(entry.id)]
      .filter(id => !deniedByAncestors.has(id) && platform.allowed(run, id))
    if (!grants.includes(entry.id)) fail("DENIED", "Cell denied: " + entry.id)

    const release = admit(activeRuns, parent ? rootOf(parent.run) : run.id, limits.maxRuns,
      "Too many active runs in this delegation tree")
    const launchSignal = AbortSignal.any([signal, lifetime(run.id)])
    try {
      store.saveRun(run, grants)
      runCache.set(run.id, { run, grants: new Set(grants) })
      store.record(run.id, "started", { entry: entry.id, parent })
      const raw = await platform.launch(
        { ...run, profile: entry.profile, context: structuredClone(entry.context), input },
        (channel, native) => connect(run, channel, native), launchSignal)
      launchSignal.throwIfAborted()
      const parsed = CallToolResultSchema.safeParse(raw)
      if (!parsed.success) fail("INVALID_OUTPUT", "Invalid run result from the platform")
      const status = parsed.data.isError ? "failed" : "ok"
      store.finishRun(run.id, status, { status, output: parsed.data })
      return parsed.data
    } catch (error) {
      const status = launchSignal.aborted ? "cancelled" : "failed"
      store.finishRun(run.id, status, { status })
      throw error
    } finally {
      stop(run.id)
      release()
    }
  }

  // A delegated run belongs to the calling run, not to the request: a caller that stops waiting only detaches, and a
  // retry with the same key and arguments joins the child or collects its result.
  async function delegate(
    run: Run, tool: string, cell: string, args: Args, key: string, signal: AbortSignal, heartbeat?: () => void,
  ): Promise<CallToolResult> {
    const calls = delegations.get(run.id) ?? new Map<string, Promise<CallToolResult>>()
    delegations.set(run.id, calls)
    const slot = hash([tool, key, args])
    let child = calls.get(slot)
    if (!child) {
      const started = startRun({ owner: run.owner, revision: run.revision, workspace: run.workspace, entry: cell, input: args },
        lifetime(run.id), { run: run.id, tool, key })
      started.catch(() => { if (calls.get(slot) === started) calls.delete(slot) }) // a failed child can be retried
      calls.set(slot, (child = started))
    }
    const value = await waitFor(child, signal, heartbeat)
    if (calls.get(slot) === child) calls.delete(slot) // collected: an identical later call is new work
    return value
  }

  async function execute(
    run: Run, node: Binding, args: Args, key: string, signal: AbortSignal, heartbeat?: () => void,
  ): Promise<unknown> {
    if ("cell" in node.target) return delegate(run, node.id, node.target.cell, args, key, signal, heartbeat)
    const adapter = registry.get(node.target.adapter)
    if (!adapter) fail("UNAVAILABLE", "Adapter unavailable: " + node.target.adapter)
    if ("call" in adapter) return adapter.call(run, args, signal)
    const approval = await store.stage(run, key, node.id, args, prepareSignal => adapter.prepare(run, args, prepareSignal), signal)
    return waitFor(store.result(run.owner, approval, signal), signal, heartbeat)
  }

  async function call(
    run: Run, id: string, args: Args, key: string, signal: AbortSignal,
    { heartbeat, asTask = false }: { heartbeat?: () => void; asTask?: boolean } = {},
  ): Promise<CallToolResult> {
    signal.throwIfAborted()
    const release = admit(activeCalls, run.id, limits.maxConcurrency, "Too many concurrent calls in this run")
    try {
      const ended = store.ended(run.id)
      let node: Binding
      try {
        node = binding(run, id, !ended)
      } catch (error) {
        if (!ended) store.record(run.id, "denied", { id, key, code: codeOf(error) })
        throw error
      }
      if (node.definition.execution?.taskSupport === "required" && !asTask) fail("INVALID_ARGS", `Call ${id} as a task`)
      if (Buffer.byteLength(JSON.stringify(args)) > limits.inlineLimit) fail("LIMIT_EXCEEDED", "Arguments exceed the inline limit")
      const current = graph(run.revision)
      current.validateInput(id, args)

      if (ended) {
        // An ended run can only collect the outcome of an approval it already staged.
        const approval = store.existingApproval(run, key, id, args)
        if (!approval) fail("RUN_ENDED", "Run has ended")
        return checkedResult(current, id, await waitFor(store.result(run.owner, approval, signal), signal, heartbeat))
      }

      store.record(run.id, "call", { id, key })
      try {
        const result = checkedResult(current, id, await execute(run, node, args, key, signal, heartbeat))
        store.record(run.id, "returned", { id, key, error: result.isError ?? false })
        return result
      } catch (error) {
        store.record(run.id, signal.aborted ? "cancelled" : "failed", { id, key, code: codeOf(error) })
        throw error
      }
    } finally {
      release()
    }
  }

  async function connect(run: Run, channel: Transport, native = false) {
    const tasks = new TaskWork()
    const server = new Server({ name: "celler", version: "0.1.0" }, {
      capabilities: { tools: { listChanged: true }, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } },
      taskStore: tasks,
    })
    const current = graph(run.revision)
    const connection = new AbortController()
    let advertised: Set<string> | undefined
    let invokeAdvertised = false

    function menu() {
      checkAncestors(run)
      const tools: Tool[] = []
      let jsonBytes = 2 // "[]"
      for (const id of current.view(run.entry, access(run)).keys()) {
        const meta = current.meta(id)
        if (meta.kind === "tool") {
          tools.push(meta.exposed)
          jsonBytes += meta.exposedBytes + (tools.length > 1 ? 1 : 0)
        }
      }
      // Once a connection moves to discover and invoke it stays there, so the model's `invoke` calls keep working.
      if (!invokeAdvertised && (native || jsonBytes <= limits.discoveryBytes)) {
        return { tools: [...tools, discoverTool] }
      }
      invokeAdvertised = true
      const pins = new Set(current.cell(run.entry).pins)
      return { tools: [...tools.filter(tool => pins.has(tool.name)), discoverTool, invokeTool] }
    }

    function list() {
      const result = menu()
      advertised = new Set(result.tools.map(tool => tool.name))
      return result
    }

    server.setRequestHandler(ListToolsRequestSchema, (_request, extra) => {
      try {
        return list()
      } catch (error) {
        if (error instanceof CellerError || extra.signal.aborted) throw error
        fail("UNAVAILABLE", "Tool listing failed") // never pass raw errors across the MCP boundary
      }
    })
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      if (!advertised) list()
      if (!advertised!.has(params.name)) throw new McpError(ErrorCode.InvalidParams, "Unknown tool: " + params.name)
      // The request or task, the connection, or the run can end this call. Approvals and delegated runs outlive it.
      const owned = store.ended(run.id) ? [] : [lifetime(run.id)]
      async function respond(signal: AbortSignal, heartbeat?: () => void): Promise<CallToolResult> {
        try {
          const args = params.arguments ?? {}
          if (params.name === "discover") {
            checkAncestors(run)
            return { content: [{ type: "text", text: discover(current, run.entry, access(run), args, limits.discoveryBytes) }] }
          }
          const request = params.name === "invoke"
            ? parseWith(invocation, "invoke arguments", args)
            : { name: params.name, arguments: args }
          const key = callKey(params._meta, request.name, request.arguments)
          return await call(run, request.name, request.arguments, key, signal, { heartbeat, asTask: !!params.task })
        } catch (error) {
          if (error instanceof McpError || signal.aborted) throw error
          return refusal(error)
        }
      }

      if (!params.task) {
        const progressToken = extra._meta?.progressToken
        let progress = 0
        const heartbeat = progressToken === undefined ? undefined : () => void extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: ++progress, message: "Still working" },
        }).catch(() => {})
        return respond(AbortSignal.any([extra.signal, connection.signal, ...owned]), heartbeat)
      }
      const task = await extra.taskStore!.createTask({ ttl: params.task.ttl })
      const work = new AbortController()
      tasks.work.set(task.taskId, work)
      void respond(AbortSignal.any([work.signal, connection.signal, ...owned]))
        .catch(refusal)
        .then(async result => {
          // A cancelled task keeps its status; any other outcome is stored for tasks/result.
          if (!work.signal.aborted) await extra.taskStore!.storeTaskResult(task.taskId, result.isError ? "failed" : "completed", result)
        })
        .catch(() => {})
        .finally(() => tasks.work.delete(task.taskId))
      return { task }
    })

    const group = connections.get(run.id) ?? new Set<Server>()
    connections.set(run.id, group)
    group.add(server)
    server.onclose = () => {
      connection.abort()
      group.delete(server)
      if (group.size === 0 && connections.get(run.id) === group) connections.delete(run.id)
    }
    await server.connect(channel)
  }

  async function notifyToolsChanged(runId?: string) {
    const targets = runId ? [...(connections.get(runId) ?? [])] : [...connections.values()].flatMap(set => [...set])
    await Promise.allSettled(targets.map(server => server.sendToolListChanged()))
  }

  return {
    publish(config: unknown) {
      const current = compileGraph(config, adapterIds(), true)
      const revision = store.saveRevision(current.snapshot)
      graphs.set(revision, current)
      return revision
    },
    async start(request: Start, signal: AbortSignal = new AbortController().signal): Promise<CallToolResult> {
      const valid = parseWith(startRequest, "start request", request)
      return startRun({ ...valid, input: valid.input }, signal, null)
    },
    reconnect(owner: string, runId: string, channel: Transport, native = false) {
      const { run } = loadRunCached(runId)
      if (run.owner !== owner) fail("NOT_FOUND", "Unknown run")
      return connect(run, channel, native)
    },
    /** Ends a run and every run it delegated, even ones left from before a restart, and stops their work here. */
    end(owner: string, runId: string) {
      const { run } = loadRunCached(runId)
      if (run.owner !== owner) fail("NOT_FOUND", "Unknown run")
      const tree = [run.id]
      for (let i = 0; i < tree.length; i++) tree.push(...store.children(tree[i]))
      for (const id of tree) store.finishRun(id, "cancelled", { status: "cancelled", by: "host" })
      for (const id of tree) stop(id)
    },
    notifyToolsChanged,
    history: store.history,
    human: {
      inbox: store.inbox,
      review: store.review,
      decline: store.decline,
      /** Settles an `unknown` delivery after the host has checked the destination. */
      reconcile(owner: string, id: string, outcome: "sent" | "failed", result?: CallToolResult) {
        const value = outcome === "sent" ? result ?? { content: [{ type: "text" as const, text: "Delivered (confirmed by the host)" }] } : undefined
        store.reconcile(owner, id, outcome, value)
      },
      async approve(owner: string, id: string, signal?: AbortSignal): Promise<CallToolResult> {
        let check = (value: CallToolResult) => value
        const value = await store.approve(owner, id, (run, tool) => {
          const node = binding(run, tool)
          const adapter = "adapter" in node.target ? registry.get(node.target.adapter) : undefined
          if (!adapter || !("send" in adapter)) fail("UNAVAILABLE", "Outbound adapter unavailable")
          check = result => checkedResult(graph(run.revision), tool, result)
          return {
            verify: adapter.verify ? write => adapter.verify!(run, write) : undefined,
            send: (write, key, sendSignal) => adapter.send(run, write, key, sendSignal),
          }
        }, signal)
        // The store saved the response as sent first, so a response that fails its schema keeps its receipt.
        return check(value)
      },
    },
  }
}
