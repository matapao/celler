// A Platform for createApp that runs each run's agent through the harness. The agent reaches its run's MCP server at
// a local address, in MCP sessions of its own; what it does and asks goes to the host; its result is the run's. While
// the person decides something for a run, its clock stands still, and so do the clocks of the runs still waiting on it.

import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes, randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { isJSONRPCRequest, type CallToolResult, type RequestId } from "@modelcontextprotocol/sdk/types.js"
import type { Platform } from "../app.js"
import { CellerError } from "../errors.js"
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
  /** The agent's process, once it started: its pid where its runtime knows it. */
  started?(run: Launched, pid: number | undefined): void
  /** What the agent does, as it happens. */
  progress?(run: Launched, p: RunProgress): void
  /** What the agent asks before it acts: put to a person, who answers; null when no one does. Without it, no ask is answered. */
  ask?(run: Launched, q: AgentAsk, signal: AbortSignal): Promise<AskAnswer | null>
  /** What the agent ended with, also when the run was stopped, when createApp keeps no result: what it used was spent. */
  ended?(run: Launched, result: RunResult): void
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
 * The requests that came in each HTTP request to a run's MCP server, as its session hands them on. That request's
 * response is the only way their answers reach the agent: no stream is kept for a client to resume, as MCP lets a
 * server, so an answer whose stream its agent dropped could never arrive (serve).
 */
const carried = new AsyncLocalStorage<Set<RequestId>>()

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
  // The agents going, by their runs' ids, which close() stops; and what the runs left that is still being removed,
  // which close() waits for.
  const going = new Map<string, RunHandle>()
  const cleaning = new Set<Promise<void>>()
  let http: Server | undefined
  let address: Promise<string> | undefined
  // Once closed, it starts no agent and opens no server again; a server still opening as it closes opens for no run.
  let closed = false
  let opening: ((err: Error) => void) | undefined
  const closedError = () => new CellerError("UNAVAILABLE", "The harness platform has closed: it starts no more runs")
  const throwIfClosed = () => {
    if (closed) throw closedError()
  }

  // Whatever a request is, it is answered here: none ends the host.
  async function serve(req: IncomingMessage, res: ServerResponse) {
    try {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1]
      const way = token ? runs.get(token) : undefined
      // Only a run's own token, at its server's one address: an address that can't be read is none.
      if (!way || URL.parse(req.url ?? "/", "http://local")?.pathname !== "/mcp") return void res.writeHead(404).end()
      const transport = await sessionFor(way, req.headers["mcp-session-id"])
      if (!transport) return void res.writeHead(404).end()
      // Its agent gone before its answer, which can then never reach it: what it asked is cut off, as when it cancels,
      // so what that waits on, such as the person, no longer holds its run.
      const requests = new Set<RequestId>()
      res.once("close", () => {
        if (res.writableFinished) return
        for (const requestId of requests) {
          transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "Its agent went before its answer" } })
        }
      })
      await carried.run(requests, () => transport.handleRequest(req, res))
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
      // A call as large as celler takes inline gets to celler, which says if it is too large.
      maxRequestBodySize: harnessLimits.mcpRequestBytes,
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
    // Each request it hands on is one the HTTP request it came in carried (serve).
    const deliver = transport.onmessage
    transport.onmessage = (message, extra) => {
      if (isJSONRPCRequest(message)) carried.getStore()?.add(message.id)
      deliver?.(message, extra)
    }
    return transport
  }

  /**
   * What each run waits on that may be the person: their decisions it waits for itself (what its agent asks, its calls
   * in the inbox), and the runs it delegated that its agent waits on, by their ids. A run waits for the person while one
   * of its own decisions is open, or a run it waits on waits for the person: its clock stands still meanwhile, and goes
   * on once it doesn't (`stopped`), as when its agent stops waiting on a run it delegated. A run whose agent isn't going
   * here has no clock to stop.
   */
  const waits = new Map<string, { decisions: number; on: Map<string, number> }>()
  // The run that waits on each run, by its id: the one that delegated it, while its agent waits on it.
  const waitedOnBy = new Map<string, string>()
  const stopped = new Map<string, () => void>()

  function waitsForPerson(id: string): boolean {
    const own = waits.get(id)
    if (!own) return false
    return own.decisions > 0 || [...own.on.keys()].some(waitsForPerson)
  }

  /** Each run from `id` up the runs that wait on it, its clock stopped while it waits for the person, else going. */
  function settle(id: string): void {
    for (let next: string | undefined = id; next !== undefined; next = waitedOnBy.get(next)) {
      const waiting = waitsForPerson(next)
      const release = stopped.get(next)
      const handle = going.get(next)
      if (waiting && !release && handle?.hold) stopped.set(next, handle.hold())
      if (!waiting && release) {
        stopped.delete(next)
        release()
      }
    }
  }

  /** One more thing the run `id` waits on, until the release it returns: a decision of the person's, or the run `on`. */
  function wait(id: string, on?: string): () => void {
    let own = waits.get(id)
    if (!own) waits.set(id, (own = { decisions: 0, on: new Map() }))
    const entry = own
    if (on === undefined) entry.decisions++
    else {
      entry.on.set(on, (entry.on.get(on) ?? 0) + 1)
      waitedOnBy.set(on, id)
    }
    settle(id)
    let released = false
    return () => {
      if (released) return
      released = true
      if (on === undefined) entry.decisions--
      else {
        const left = (entry.on.get(on) ?? 1) - 1
        if (left > 0) entry.on.set(on, left)
        else {
          entry.on.delete(on)
          waitedOnBy.delete(on)
        }
      }
      if (entry.decisions === 0 && entry.on.size === 0 && waits.get(id) === entry) waits.delete(id)
      settle(id)
    }
  }

  /**
   * Waits for the answer to what a run's agent asks the person (`asked`): the run waits for the person, and so do the
   * runs that wait on it, until it comes or the ask is taken back (`signal`), never past the run's end.
   */
  async function answered<T>(run: Launched, signal: AbortSignal, asked: () => Promise<T>): Promise<T> {
    const release = wait(run.id)
    // Taken back, it is released even while the host's ask goes on.
    if (signal.aborted) release()
    else signal.addEventListener("abort", release, { once: true })
    try {
      return await asked()
    } finally {
      signal.removeEventListener("abort", release)
      release()
    }
  }

  function listening(): Promise<string> {
    address ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => void serve(req, res))
      // One that couldn't open isn't kept: the next run tries again.
      const failed = (err: Error) => {
        address = undefined
        http = undefined
        opening = undefined
        reject(err)
      }
      opening = failed
      server.once("error", failed)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", failed)
        // Open, an error it meets later (no file descriptor left for a connection) ends no run and not the host.
        server.on("error", () => undefined)
        opening = undefined
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
      })
      http = server
    })
    return address
  }

  return {
    // Asked on the host's own object, as each of its hooks is, though createApp asks it of this platform.
    allowed: o.allowed.bind(o),
    waiting: (run, on) => wait(run.id, on),
    async launch(run, connect, signal): Promise<CallToolResult> {
      signal.throwIfAborted()
      throwIfClosed()
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
        // The run may have been cancelled, or the platform closed, while its MCP server was opening.
        signal.throwIfAborted()
        throwIfClosed()
        // Asked on the host's own object, as each of its hooks is: an ask that is a method of its own works too.
        const ask = o.ask?.bind(o)
        let handle: RunHandle
        try {
          handle = runtime.run(
            {
              ...own,
              cwd: run.workspace,
              // The cell's context as the agent's instructions: its texts, in order.
              systemPrompt: run.context.map(textOf).join("\n\n"),
              mcpServers,
              ...(ask ? { ask: (q: AgentAsk, s: AbortSignal) => answered(run, s, () => ask(run, q, s)) } : {}),
            },
            (p) => o.progress?.(run, p),
          )
        } catch (err) {
          // An agent that can't start ends as a failed run, which the host hears as it would any end.
          const result = failure(errorText(err))
          o.ended?.(run, result)
          return resultFor(run, result)
        }
        going.set(run.id, handle)
        const { cleaned } = handle
        if (cleaned) {
          cleaning.add(cleaned)
          void cleaned.finally(() => cleaning.delete(cleaned))
        }
        const cancel = () => handle.cancel()
        signal.addEventListener("abort", cancel, { once: true })
        if (signal.aborted) cancel()
        let result: RunResult | undefined
        try {
          // Once its agent has started, and its process with it, where its runtime knows it.
          await handle.started
          o.started?.(run, handle.pid)
          result = await handle.done
          o.ended?.(run, result)
          return resultFor(run, result)
        } finally {
          // A host's hook that threw before the run ended: its agent is stopped too, not left working.
          if (!result) handle.cancel()
          going.delete(run.id)
          // Its clock is over: nothing it waited on stops it any more.
          stopped.get(run.id)?.()
          stopped.delete(run.id)
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
     * left waiting for a person can still be approved, as when a host closes and starts again. It settles once what
     * every run left is gone (RunHandle.cleaned), so a host can exit then.
     */
    async close() {
      closed = true
      for (const handle of going.values()) handle.cancel()
      for (const way of runs.values()) closeSessions(way)
      const server = http
      http = undefined
      address = undefined
      // A run waiting for the server to open hears that it won't, and starts no agent.
      opening?.(closedError())
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          // Requests still open (an agent waiting on its call) end with it.
          server.closeAllConnections()
        })
      }
      await Promise.allSettled(cleaning)
    },
  }
}
