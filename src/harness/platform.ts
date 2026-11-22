// A Platform for createApp that runs each run's agent through the harness. The agent reaches its run's MCP server at
// a local address, in MCP sessions of its own; what it does and asks goes to the host; its result is the run's.

import { randomBytes, randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Platform } from "../app.js"
import { harnessLimits } from "../limits.js"
import { errorText, failure, type AgentAsk, type AskAnswer, type McpServerSpec, type RunHandle, type RunProgress, type RunResult, type RunSpec, type Runtime } from "./types.js"

/** A run as `launch` gets it: the run, its cell's profile and context, and the input it was started with. */
export type Launched = Parameters<Platform["launch"]>[0]

export interface HarnessPlatform {
  /** The agent that runs it: by its cell's profile, or by what the host started it with. */
  runtime(run: Launched): Runtime | undefined
  /** The live policy, as createApp asks it. */
  allowed: Platform["allowed"]
  /**
   * The harness run for a run: its prompt, model, session and the rest, from what the host started it with. Its
   * `mcpServers` are the host's own, beside the run's: their calls don't go through celler, so each checks its own.
   */
  spec(run: Launched): Omit<RunSpec, "cwd" | "systemPrompt" | "mcpServers" | "ask"> & { mcpServers?: McpServerSpec[] }
  /** The name the agent knows the run's MCP server by: its tools are that server's. */
  server: string
  /** The agent's process, once it started. */
  started?(run: Launched, pid: number | undefined): void
  /** What the agent does, as it happens. */
  progress?(run: Launched, p: RunProgress): void
  /** What the agent asks before it acts: put to a person, who answers; null when no one does. Without it, asks are cancelled. */
  ask?(run: Launched, q: AgentAsk, signal: AbortSignal): Promise<AskAnswer | null>
  /** What the agent ended with, also when the run was stopped, when createApp keeps no result: what it used was spent. */
  ended?(run: Launched, result: RunResult): void
}

/** The cell's context as the agent's instructions: its texts, in order. */
function instructions(context: Launched["context"]): string {
  return context.map(textOf).join("\n\n")
}

/** A part of a cell's context as text; one with none, such as an image, can't be part of an agent's instructions. */
function textOf(part: Launched["context"][number]): string {
  if (typeof part === "string") return part
  if (part.type === "text") return part.text
  if (part.type === "resource" && "text" in part.resource) return part.resource.text
  throw new Error(`A cell's context can't hold ${part.type} content for an agent run by the harness: only text`)
}

/**
 * A run's result as createApp gets it. The host's own run carries all of it: the host keeps its usage, cost, session
 * and what was refused. A delegated run's goes to the agent that called it, which sees only its agent's reply, or that
 * it failed in celler's own words, never a raw error of the host's or an agent's: the host hears it all in `ended`.
 */
function resultFor(run: Launched, result: RunResult): CallToolResult {
  if (!run.parent) {
    return { isError: !result.ok, content: [{ type: "text", text: result.text || result.error || "" }], structuredContent: { ...result } }
  }
  if (result.ok) return { content: [{ type: "text", text: result.text }] }
  return { isError: true, content: [{ type: "text", text: result.cancelled ? "The delegated run was cancelled" : "The delegated run failed" }] }
}

/**
 * A run's way in to its MCP server: how a connection is made, the sessions its agent has open, by their ids, and
 * whether the run is over, after which no session is kept.
 */
type Way = { connect: (transport: Transport) => Promise<void>; sessions: Map<string, StreamableHTTPServerTransport>; closed: boolean }

/**
 * No more sessions for a run, and the ones it has closed: at once, or after `graceMs`, so that the calls its end cut off
 * are answered first.
 */
function closeSessions(way: Way, graceMs = 0): void {
  way.closed = true
  const close = () => {
    for (const transport of way.sessions.values()) void transport.close()
    way.sessions.clear()
  }
  if (graceMs === 0) close()
  else setTimeout(close, graceMs).unref()
}

export function harnessPlatform(o: HarnessPlatform): Platform & { close(): Promise<void> } {
  // Each run's way in, by a token of its own, which only that run's agent is given.
  const runs = new Map<string, Way>()
  // The agents going, which close() stops.
  const going = new Set<{ cancel(): void }>()
  let http: Server | undefined
  let address: Promise<string> | undefined

  async function serve(req: IncomingMessage, res: ServerResponse) {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1]
    const way = token ? runs.get(token) : undefined
    if (!way || new URL(req.url ?? "/", "http://local").pathname !== "/mcp") return void res.writeHead(404).end()
    try {
      const transport = await sessionFor(way, req.headers["mcp-session-id"])
      if (!transport) return void res.writeHead(404).end()
      await transport.handleRequest(req, res)
      // A request that opened no session (anything but an initialize) leaves nothing behind.
      if (!transport.sessionId) void transport.close()
    } catch {
      if (!res.headersSent) res.writeHead(500).end()
    }
  }

  /**
   * The session a request is in: the one it names, or a new one. A session lasts while its agent keeps it, so what it
   * was listed and the tasks it started go on from one request to the next; one that has ended is gone (404).
   */
  async function sessionFor(way: Way, id: string | string[] | undefined): Promise<StreamableHTTPServerTransport | undefined> {
    if (id !== undefined) return typeof id === "string" ? way.sessions.get(id) : undefined
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (opened) => {
        // One that opens as its run ends is closed, not kept.
        if (way.closed) void transport.close()
        else way.sessions.set(opened, transport)
      },
    })
    // Set before connecting, which keeps it: the server's own goes after it.
    transport.onclose = () => {
      if (transport.sessionId) way.sessions.delete(transport.sessionId)
    }
    await way.connect(transport)
    return transport
  }

  function listening(): Promise<string> {
    address ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => void serve(req, res))
      // One that couldn't open isn't kept: the next run tries again.
      const failed = (err: Error) => {
        address = undefined
        http = undefined
        reject(err)
      }
      server.once("error", failed)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", failed)
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
      })
      http = server
    })
    return address
  }

  return {
    allowed: o.allowed,
    async launch(run, connect, signal): Promise<CallToolResult> {
      signal.throwIfAborted()
      const runtime = o.runtime(run)
      if (!runtime) return { isError: true, content: [{ type: "text", text: `No agent for the profile ${run.profile}` }] }
      const token = randomBytes(24).toString("base64url")
      // An agent that searches its tools itself is given them all; any other gets celler's menu.
      const native = runtime.nativeDiscovery === true
      const way: Way = { connect: (transport) => connect(transport, native), sessions: new Map(), closed: false }
      runs.set(token, way)
      try {
        const own = o.spec(run)
        // A model-only decision has no tools: no MCP server, not even the run's own.
        const mcpServers: McpServerSpec[] = own.purpose === "inference" ? [] : [
          { name: o.server, transport: "http", url: await listening(), headers: { Authorization: `Bearer ${token}` } },
          ...(own.mcpServers ?? []),
        ]
        // The run may have been cancelled while its MCP server was opening.
        signal.throwIfAborted()
        const ask = o.ask
        let handle: RunHandle
        try {
          handle = runtime.run(
            {
              ...own,
              cwd: run.workspace,
              systemPrompt: instructions(run.context),
              mcpServers,
              ...(ask ? { ask: (q: AgentAsk, s: AbortSignal) => ask(run, q, s) } : {}),
            },
            (p) => o.progress?.(run, p),
          )
        } catch (err) {
          // An agent that can't start ends as a failed run, which the host hears as it would any end.
          const result = failure(errorText(err))
          o.ended?.(run, result)
          return resultFor(run, result)
        }
        going.add(handle)
        const cancel = () => handle.cancel()
        signal.addEventListener("abort", cancel, { once: true })
        if (signal.aborted) cancel()
        let result: RunResult | undefined
        try {
          o.started?.(run, handle.pid)
          result = await handle.done
          o.ended?.(run, result)
          return resultFor(run, result)
        } finally {
          // A host's hook that threw before the run ended: its agent is stopped too, not left working.
          if (!result) handle.cancel()
          going.delete(handle)
          signal.removeEventListener("abort", cancel)
        }
      } finally {
        runs.delete(token)
        // The grace its agent has to exit: what it was still waiting on hears that it was cut off.
        closeSessions(way, harnessLimits.exitGraceMs)
      }
    },
    /**
     * Stops the agents still going, and their runs end with what they ended with, failed and not cancelled: what they
     * left waiting for a person can still be approved, as when a host closes and starts again.
     */
    async close() {
      for (const handle of going) handle.cancel()
      for (const way of runs.values()) closeSessions(way)
      const server = http
      http = undefined
      address = undefined
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          // Requests still open (an agent waiting on its call) end with it.
          server.closeAllConnections()
        })
      }
    },
  }
}
