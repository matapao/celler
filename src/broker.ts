import { spawn, type ChildProcess } from "node:child_process"
import { Readable, addAbortSignal, type Duplex } from "node:stream"
import { pipeline } from "node:stream/promises"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolResultSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js"
import type { Adapter, Platform } from "./app.js"
import type { NodeConfig } from "./catalog.js"
import { fail, CellerError } from "./errors.js"
import { brokerLimits, withLimits } from "./limits.js"

export type BrokerCommand = {
  executable: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  /** Whether the harness a profile launches has its own tool search; it then gets every definition directly. */
  nativeDiscovery?: boolean | ((profile: string) => boolean)
  onStderr?: (chunk: Buffer) => void
} & Partial<typeof brokerLimits>

type Connect = Parameters<Platform["launch"]>[1]
type Operation = {
  description: string
  annotations: Tool["annotations"]
  inputSchema: Tool["inputSchema"]
  /** Rewrites the arguments the broker receives. */
  wire?: (args: Record<string, unknown>) => Record<string, unknown>
}

const NO_NULL = "^[^\\u0000]+$"
const BASE64_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
const READ_ONLY: Tool["annotations"] = { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
const DESTRUCTIVE: Tool["annotations"] = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
const IDEMPOTENT_WRITE: Tool["annotations"] = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const fields = (properties: Record<string, object>, required = Object.keys(properties)) =>
  ({ type: "object" as const, additionalProperties: false, required, properties })

// The workspace tools. Each runs the broker in `workspace` mode with its operation name and arguments.
function operations({ inlineLimit, pathChars, queryChars }: typeof brokerLimits): Record<string, Operation> {
  const path = { type: "string", minLength: 1, maxLength: pathChars, pattern: NO_NULL, description: "A path inside the workspace" }
  return {
    list: { description: "List a directory in the workspace", annotations: READ_ONLY, inputSchema: fields({ path }) },
    read: { description: "Read a file in the workspace", annotations: READ_ONLY, inputSchema: fields({ path }) },
    mkdir: { description: "Create a directory in the workspace", annotations: IDEMPOTENT_WRITE, inputSchema: fields({ path }) },
    move: {
      description: "Move or rename a path in the workspace", annotations: DESTRUCTIVE,
      inputSchema: fields({ path, to: { ...path, description: "The new path inside the workspace" } }),
    },
    remove: { description: "Remove a path from the workspace", annotations: DESTRUCTIVE, inputSchema: fields({ path }) },
    stat: { description: "Get information about a path in the workspace", annotations: READ_ONLY, inputSchema: fields({ path }) },
    search: {
      description: "Search the workspace below a path", annotations: READ_ONLY,
      inputSchema: fields({ path, query: { type: "string", maxLength: queryChars, description: "What to search for" } }),
    },
    write: {
      description: "Write a file in the workspace from UTF-8 text or base64 bytes", annotations: DESTRUCTIVE,
      inputSchema: {
        ...fields({
          path,
          text: { type: "string", maxLength: inlineLimit, description: "The file content as UTF-8 text" },
          base64: { type: "string", maxLength: inlineLimit, pattern: BASE64_PATTERN, description: "The file content as base64" },
        }, ["path"]),
        oneOf: [{ required: ["text"] }, { required: ["base64"] }],
      },
      // The broker always receives the bytes as base64.
      wire: args => ({
        path: args.path,
        base64: typeof args.text === "string" ? Buffer.from(args.text, "utf8").toString("base64") : args.base64,
      }),
    },
  }
}

/** What a broker printed, as a tool result: anything else is the broker's failure, in celler's words. */
function brokerResult(output: string): CallToolResult {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    fail("BROKER_ERROR", "Broker result is not JSON")
  }
  const parsed = CallToolResultSchema.safeParse(value)
  if (!parsed.success) fail("BROKER_ERROR", "Broker result is not a tool result")
  return parsed.data
}

function createSemaphore(limit: number) {
  let active = 0
  const queue: Array<() => void> = []
  return {
    async acquire(signal: AbortSignal) {
      signal.throwIfAborted()
      if (active < limit) {
        active++
        return
      }
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          signal.removeEventListener("abort", onAbort)
          active++
          resolve()
        }
        const onAbort = () => {
          const index = queue.indexOf(grant)
          if (index >= 0) queue.splice(index, 1)
          reject(signal.reason)
        }
        queue.push(grant)
        signal.addEventListener("abort", onAbort, { once: true })
      })
    },
    release() {
      active--
      queue.shift()?.()
    },
  }
}

export function createBroker(command: BrokerCommand, allowed: Platform["allowed"]) {
  const limits = withLimits(brokerLimits, command)
  const slots = createSemaphore(limits.maxConcurrency)

  async function request(
    mode: "launch" | "workspace", payload: unknown, signal: AbortSignal,
    connect?: Connect, nativeDiscovery = false,
  ) {
    signal.throwIfAborted()
    const body = JSON.stringify(payload)
    if (Buffer.byteLength(body) > limits.inlineLimit) fail("LIMIT_EXCEEDED", "Broker payload exceeds inline limit")
    // Only workspace operations take a slot. A launch lasts its whole run and must never hold a slot its own calls need.
    const slotted = mode === "workspace"
    if (slotted) await slots.acquire(signal)
    let child: ChildProcess | undefined
    let transport: StdioServerTransport | undefined
    try {
      const running = (child = spawn(command.executable, [...command.args ?? [], mode], {
        stdio: connect ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
        env: command.env ?? {}, // never inherits the host's environment
        signal,
        shell: false,
      }))
      // Untrusted stderr never reaches the host's own streams; draining it keeps the child from blocking.
      if (command.onStderr) running.stderr.on("data", command.onStderr)
      else running.stderr.resume()

      const channel = connect ? (running.stdio[3] as Duplex) : undefined
      transport = channel ? new StdioServerTransport(channel, channel, { maxBufferSize: limits.inlineLimit }) : undefined
      const exit = new Promise<void>((resolve, reject) => {
        running.once("error", reject)
        running.once("close", (code, sig) => {
          if (code === 0) resolve()
          else reject(new CellerError("BROKER_ERROR", `Broker exited with ${sig ? "signal " + sig : "code " + code}`))
        })
      })
      exit.catch(() => {}) // a throw before `await exit` must not leave it unhandled

      if (connect && transport) await connect(transport, nativeDiscovery)
      const writeStdin = pipeline(Readable.from([body]), running.stdin).catch(async (error: NodeJS.ErrnoException) => {
        await exit // a failed exit explains a broken pipe better than the pipe error does
        if (error.code !== "EPIPE") throw error // a broker may answer without reading all of its input
      })
      writeStdin.catch(() => {})
      const chunks: Buffer[] = []
      let bytes = 0
      // An abort ends the read too, so a broker that outlives SIGTERM with its output open is still stopped below.
      for await (const chunk of addAbortSignal(signal, running.stdout)) {
        bytes += chunk.length
        if (bytes > limits.inlineLimit) fail("LIMIT_EXCEEDED", "Broker result exceeds inline limit")
        chunks.push(chunk)
      }
      await exit
      await writeStdin
      return brokerResult(Buffer.concat(chunks).toString())
    } finally {
      await transport?.close().catch(() => {})
      if (child) {
        for (const stream of child.stdio) stream?.destroy()
        if (child.exitCode === null && child.signalCode === null) {
          const running = child
          running.kill("SIGTERM")
          const force = setTimeout(() => {
            if (running.exitCode === null && running.signalCode === null) running.kill("SIGKILL")
          }, limits.killTimeoutMs)
          force.unref()
          running.once("close", () => clearTimeout(force))
        }
      }
      if (slotted) slots.release()
    }
  }

  const platform: Platform = {
    allowed,
    launch: (spec, connect, signal) => {
      const native = typeof command.nativeDiscovery === "function"
        ? command.nativeDiscovery(spec.profile)
        : Boolean(command.nativeDiscovery)
      return request("launch", spec, signal, connect, native)
    },
  }

  const adapters = new Map<string, Adapter>()
  const bindings: NodeConfig[] = []
  for (const [op, { description, annotations, inputSchema, wire }] of Object.entries(operations(limits))) {
    const id = "fs." + op
    adapters.set(id, {
      call: (run, args, signal) =>
        request("workspace", { owner: run.owner, workspace: run.workspace, op, args: wire ? wire(args) : args }, signal),
    })
    bindings.push({ kind: "tool", id, target: { adapter: id }, definition: { description, annotations, inputSchema } })
  }

  // No profile: it only groups the tools.
  const workspaceNodes: NodeConfig[] = [
    { kind: "cell", id: "files", title: "Workspace files", exports: bindings.map(node => node.id) },
    ...bindings,
  ]
  return { platform, adapters, workspaceNodes }
}
