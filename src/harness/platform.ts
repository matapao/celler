// A Platform for createApp that runs each run's agent through the harness. The agent reaches its run's MCP server at
// a local address, one request at a time; what it does and asks goes to the host; its result is the run's.

import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Platform } from "../app.js"
import { errorText, failure, type AgentAsk, type AskAnswer, type McpServerSpec, type RunHandle, type RunProgress, type RunResult, type RunSpec, type Runtime } from "./types.js"

/** A run as `launch` gets it: the run, its cell's profile and context, and the input it was started with. */
export type Launched = Parameters<Platform["launch"]>[0]

export interface HarnessPlatform {
  /** The agent that runs it: by its cell's profile, or by what the host started it with. */
  runtime(run: Launched): Runtime | undefined
  /** The live policy, as createApp asks it. */
  allowed: Platform["allowed"]
  /** The harness run for a run: its prompt, model, session and the rest, from what the host started it with. */
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
  return context.flatMap((part) => (typeof part === "string" ? [part] : part.type === "text" ? [part.text] : [])).join("\n\n")
}

export function harnessPlatform(o: HarnessPlatform): Platform & { close(): Promise<void> } {
  // Each run's way in: a token of its own, which only that run's agent is given.
  const runs = new Map<string, (transport: Transport) => Promise<void>>()
  // The agents going, which close() stops.
  const going = new Set<{ cancel(): void }>()
  let http: Server | undefined
  let address: Promise<string> | undefined

  async function serve(req: IncomingMessage, res: ServerResponse) {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1]
    const connect = token ? runs.get(token) : undefined
    if (!connect || new URL(req.url ?? "/", "http://local").pathname !== "/mcp") return void res.writeHead(404).end()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on("close", () => void transport.close())
    try {
      await connect(transport)
      await transport.handleRequest(req, res)
    } catch {
      if (!res.headersSent) res.writeHead(500).end()
    }
  }

  function listening(): Promise<string> {
    address ??= new Promise((resolve, reject) => {
      http = createServer((req, res) => void serve(req, res))
      http.once("error", reject)
      http.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(http!.address() as AddressInfo).port}/mcp`))
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
      runs.set(token, (transport) => connect(transport, native))
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
          return { isError: true, content: [{ type: "text", text: result.error ?? "" }], structuredContent: { ...result } }
        }
        going.add(handle)
        const cancel = () => handle.cancel()
        signal.addEventListener("abort", cancel, { once: true })
        if (signal.aborted) cancel()
        try {
          o.started?.(run, handle.pid)
          const result = await handle.done
          o.ended?.(run, result)
          // The whole result goes back with it: the host keeps its usage, cost, session and what was refused.
          return { isError: !result.ok, content: [{ type: "text", text: result.text || result.error || "" }], structuredContent: { ...result } }
        } finally {
          going.delete(handle)
          signal.removeEventListener("abort", cancel)
        }
      } finally {
        runs.delete(token)
      }
    },
    /**
     * Stops the agents still going, and their runs end with what they ended with, failed and not cancelled: what they
     * left waiting for a person can still be approved, as when a host closes and starts again.
     */
    async close() {
      for (const handle of going) handle.cancel()
      const server = http
      http = undefined
      address = undefined
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
