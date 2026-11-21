// One run of an agent over the Agent Client Protocol: its adapter's process, its session and its prompt turn. What the
// agent does becomes the run's progress (Turn); what it asks goes to the person, while the run's clock stands still.

import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ElicitationContentValue,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionUpdate,
  type ToolCall,
  type ToolCallUpdate,
  type Usage,
} from "@agentclientprotocol/sdk/unstable"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { realpathSync } from "node:fs"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { setTimeout as sleep } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { harnessLimits as L } from "../limits.js"
import type { Start } from "./agents.js"
import type { Launch } from "./programs.js"
import { emptyUsage, errorText, failedRun, type AgentAsk, type AgentFormField, type AgentSetting, type Host, type McpServerSpec, type RunHandle, type RunProgress, type RunResult, type RunSpec } from "./types.js"
import { inside } from "./sandbox/places.js"

const isWin = process.platform === "win32"
/** Claude Code's tools that write a file, and ACP's kinds of call that change one. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])
const CHANGING_KINDS = new Set(["edit", "delete", "move"])
/** Claude Code's tools that start a helper (a subagent). */
const HELPER_TOOLS = new Set(["Task", "Agent"])
/** Where a call's input names its file, and how a call reads by the first of the other keys its input has. */
const FILE_KEYS = ["file_path", "notebook_path", "filePath", "path"]
const SUMMARIES: [string, (name: string, v: string) => string][] = [
  ["command", (n, v) => `${n}: ${v.slice(0, L.commandChars)}`],
  ["cmd", (n, v) => `${n}: ${v.slice(0, L.commandChars)}`],
  ["pattern", (n, v) => `${n} "${v.slice(0, L.searchChars)}"`],
  ["url", (n, v) => `${n} ${v}`],
  ["query", (n, v) => `${n} "${v.slice(0, L.searchChars)}"`],
]
/** How a turn ended, when not as the agent meant. */
const STOPS: Record<string, string | null> = { end_turn: null, max_tokens: null, max_turn_requests: "Stopped at the turn or budget limit", refusal: "The model declined the request" }
const AUTH_REQUIRED = -32000
const RESOURCE_NOT_FOUND = -32002
/** An error that says the agent itself isn't signed in, not one its MCP servers passed on. */
const AUTH_RE = /api key|\/login|authenticat|oauth|not logged in|credit balance|git-bash/i
const MCP_LINE_RE = /\brmcp\b|\bmcp[\s_:.-]|mcp server/i
export const authProblem = (msg: string) => msg.split("\n").some((line) => !MCP_LINE_RE.test(line) && AUTH_RE.test(line))

const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v)
/** What Claude Code says of a call beyond ACP's fields: its tool's name, and the helper's call it came from. */
const claudeMeta = (u: { _meta?: Record<string, unknown> | null }): Record<string, unknown> => (isRecord(u._meta?.claudeCode) ? u._meta.claudeCode : {})
const toolName = (u: { _meta?: Record<string, unknown> | null }) => (u as { name?: string }).name || (typeof claudeMeta(u).toolName === "string" ? (claudeMeta(u).toolName as string) : "")
const fileOf = (input: unknown) => (isRecord(input) ? FILE_KEYS.map((k) => input[k]).find((v): v is string => typeof v === "string" && !!v) : undefined)

/** A tool call as the person reads it, and the file it writes when it is a writing tool. */
function summarize(name: string, input: any): { summary: string; file?: string } {
  const file = fileOf(input)
  if (file) return { summary: `${name} ${file}`, file: WRITE_TOOLS.has(name) ? file : undefined }
  const values = { ...input, command: Array.isArray(input?.command) ? input.command.join(" ") : input?.command }
  for (const [key, summary] of SUMMARIES) if (typeof values[key] === "string") return { summary: summary(name, values[key]) }
  return { summary: name }
}

/** Whether a path is outside a folder, as named or as the folder really is (macOS's /tmp). */
function outside(file: string, folder: string): boolean {
  const out = (dir: string) => !inside(dir, path.resolve(dir, file))
  try {
    return out(path.resolve(folder)) && out(realpathSync(folder))
  } catch {
    return true
  }
}

/** Stops a process and everything it started: asks, then insists. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (isWin) {
    if (child.exitCode === null) execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined)
    return
  }
  // It leads its own process group (spawned detached), which outlives it while anything it started runs.
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s)
    } catch {
      /* nothing left */
    }
  }
  signal("SIGTERM")
  setTimeout(() => signal("SIGKILL"), L.exitGraceMs).unref()
}

/** The value variables' prefix: what the agent's environment carries for its connectors. */
export const VALUES = "CELLER_VALUE_"

/**
 * Connectors as ACP's MCP servers, at the host's addresses (a program for the agent to start is refused). Their values
 * go as they are with `literal`; else as `${CELLER_VALUE_n}` placeholders the agent expands from `env`, never on its
 * command line.
 */
export function acpMcpServers(servers: McpServerSpec[], literal: boolean): { mcpServers: McpServer[]; env: Record<string, string> } {
  const env: Record<string, string> = {}
  const value = (v: string) => {
    if (literal) return v
    const key = `${VALUES}${Object.keys(env).length}`
    env[key] = v
    return `\${${key}}`
  }
  const mcpServers = servers.map((m): McpServer => {
    if (m.transport === "stdio") throw new Error(`${m.name}: a connector's program is started by the host, never by the agent`)
    return { type: m.transport, name: m.name, url: m.url, headers: Object.entries(m.headers).map(([name, v]) => ({ name, value: value(v) })) }
  })
  return { mcpServers, env }
}

const selectOptions = (o: SessionConfigOption & { type: "select" }) => o.options.flatMap((x) => ("group" in x ? x.options : [x]))

/** An agent's own settings as it publishes them, each on its value in its own words; its mode too where it keeps that apart. */
function settingsOf(modes: SessionModeState | null, options: SessionConfigOption[]): AgentSetting[] {
  const out = options.map((o) => ({ id: o.id, name: o.name, value: o.type === "select" ? (selectOptions(o).find((x) => x.value === o.currentValue)?.name ?? o.currentValue) : String(o.currentValue) }))
  if (modes && !options.some((o) => o.category === "mode")) out.unshift({ id: "mode", name: "Mode", value: modes.availableModes.find((m) => m.id === modes.currentModeId)?.name ?? modes.currentModeId })
  return out
}

/** ACP's usage; cache writes count as 5-minute ones, Claude Code's default. */
function acpUsage(u: Usage | null | undefined) {
  return { ...emptyUsage(), input: u?.inputTokens ?? 0, output: u?.outputTokens ?? 0, cacheRead: u?.cachedReadTokens ?? 0, cacheWrite5m: u?.cachedWriteTokens ?? 0 }
}

type Call = { name: string; title?: string; kind?: string; paths?: string[]; input?: unknown; parent?: string; reported?: boolean; filed?: boolean; refused?: boolean; ended?: boolean }

/** One prompt turn as the agent reports it: its reply, its tool calls, its cost and model, and what was refused. */
export class Turn {
  private texts: string[] = []
  private textKey: string | null = null
  private segment = 0
  private calls = new Map<string, Call>()
  private modes: SessionModeState | null = null
  private options: SessionConfigOption[] = []
  /** Forms and pages waiting on the person, each of which the agent can take back. */
  private forms = new Map<string, AbortController>()
  private formCount = 0
  costUsd: number | null = null
  model?: string
  denials: string[] = []
  refusedWrites: string[] = []

  constructor(
    private onProgress: (p: RunProgress) => void,
    private modelKey: string | undefined,
    private ask: RunSpec["ask"],
    /** The run's folder: a write elsewhere that failed was the sandbox's no. */
    private folder: string,
  ) {}

  /** The last message, as the agent's own result has it. */
  get text(): string {
    return this.texts.findLast((t) => t.trim()) ?? ""
  }

  started(sessionId: string): void {
    this.onProgress({ type: "session", sessionId })
  }

  published(modes: SessionModeState | null, options: SessionConfigOption[]): void {
    this.modes = modes
    this.options = options
    this.onProgress({ type: "settings", settings: settingsOf(modes, options) })
    this.onProgress({ type: "options", modes, options })
  }

  private refused(tool: string, input: unknown, files: string[]): void {
    this.denials.push(summarize(tool, input).summary)
    this.refusedWrites.push(...files.filter((f) => outside(f, this.folder)))
  }

  update(u: SessionUpdate): void {
    this.onProgress({ type: "update", update: u })
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        if (u.content.type !== "text") return
        // A message's chunks share its id; without ids, a tool call ends a message.
        const key = u.messageId ?? `segment-${this.segment}`
        if (key !== this.textKey) {
          this.textKey = key
          this.texts.push("")
        }
        this.texts[this.texts.length - 1] += u.content.text
        return this.onProgress({ type: "text", text: this.texts[this.texts.length - 1] })
      }
      case "tool_call":
      case "tool_call_update":
        this.segment += 1
        return this.toolCall(u)
      case "current_mode_update":
        return this.modes ? this.published({ ...this.modes, currentModeId: u.currentModeId }, this.options) : undefined
      case "config_option_update":
        return this.published(this.modes, u.configOptions)
      case "usage_update": {
        if (u.cost && (!u.cost.currency || u.cost.currency === "USD")) this.costUsd = u.cost.amount
        const model = this.modelKey ? u._meta?.[this.modelKey] : undefined
        if (typeof model === "string") this.model = model
      }
    }
  }

  /** A call arrives in pieces (its input often later): reported once its summary is known, its file once it completed. */
  private toolCall(u: ToolCall | ToolCallUpdate): void {
    const call = this.calls.get(u.toolCallId) ?? { name: "" }
    this.calls.set(u.toolCallId, call)
    call.name = toolName(u) || call.name
    call.title = u.title ?? call.title
    call.kind = u.kind ?? call.kind
    if (u.locations?.length) call.paths = u.locations.map((l) => l.path)
    if (u.rawInput != null) call.input = u.rawInput
    const parent = claudeMeta(u).parentToolUseId
    call.parent ??= typeof parent === "string" ? parent : undefined
    const written = summarize(call.name, call.input).file ?? (call.kind && CHANGING_KINDS.has(call.kind) ? (fileOf(call.input) ?? call.paths?.[0]) : undefined)
    if (u.status === "completed" && written && !call.filed) {
      call.filed = true
      this.onProgress({ type: "file", file: written })
    }
    if (u.status === "failed" && written && !call.refused && outside(written, this.folder)) {
      call.refused = true
      this.refused(call.name || call.kind || "Write", call.input, [written])
    }
    const finished = u.status === "completed" || u.status === "failed"
    const helperDone = () => {
      call.ended = true
      this.onProgress({ type: "helper-done", call: u.toolCallId, ok: u.status === "completed" })
    }
    if (finished && call.reported && HELPER_TOOLS.has(call.name) && !call.ended) helperDone()
    const input = call.input
    // A helper is reported as soon as it is known what it is to do, before the calls it makes.
    const known = isRecord(input) && ([...FILE_KEYS, ...SUMMARIES.map(([k]) => k)].some((k) => typeof input[k] === "string") || (HELPER_TOOLS.has(call.name) && typeof input.description === "string"))
    if (call.reported || !(finished || known)) return
    call.reported = true
    const tool = call.name || (call.kind && call.kind !== "other" ? call.kind : "") || u.title || "tool"
    const helper = HELPER_TOOLS.has(tool) && isRecord(input) ? String(input.description ?? input.prompt ?? "").trim().slice(0, L.helperChars) : ""
    this.onProgress({ type: "tool", tool, summary: summarize(tool, input).summary, call: u.toolCallId, ...(call.parent ? { parent: call.parent } : {}), ...(helper ? { helper } : {}) })
    if (finished && helper && !call.ended) helperDone()
  }

  /** What the agent asks before it acts, with its own options; nothing is answered in the person's place. */
  async permission(req: RequestPermissionRequest, stopping: boolean, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const cancelled = { outcome: { outcome: "cancelled" as const } }
    if (stopping || !this.ask) return cancelled
    const t = req.toolCall
    const call = this.calls.get(t.toolCallId)
    const tool = toolName(t) || call?.name || t.title || t.kind || "tool"
    const input = t.rawInput ?? call?.input
    const options = req.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
    const answer = await this.ask({ call: t.toolCallId, tool, title: t.title || call?.title || summarize(tool, input).summary, ...(t.kind ? { kind: t.kind } : {}), ...(input !== undefined ? { input } : {}), options }, signal).catch(() => null)
    const option = answer && "option" in answer ? req.options.find((o) => o.optionId === answer.option) : undefined
    if (!option || signal.aborted) return cancelled
    if (option.kind.startsWith("reject")) {
      // A no to writing a file is a write refused, which the host may offer the task that folder for.
      const writes = WRITE_TOOLS.has(tool) || t.kind === "edit" || call?.kind === "edit"
      const file = fileOf(input)
      this.refused(tool, input, !writes ? [] : file ? [file] : (t.locations?.map((l) => l.path) ?? call?.paths ?? []))
    }
    return { outcome: { outcome: "selected", optionId: option.optionId } }
  }

  /** A form or page the agent asks the person for (ACP's elicitation), which it can take back when done elsewhere. */
  async elicit(req: CreateElicitationRequest, stopping: boolean, signal: AbortSignal): Promise<CreateElicitationResponse> {
    const form = formOf(req)
    if (stopping || !this.ask || !form) return { action: "cancel" }
    const own = (req as { elicitationId?: unknown }).elicitationId
    const id = typeof own === "string" ? own : `form-${++this.formCount}`
    const gone = new AbortController()
    this.forms.set(id, gone)
    const both = AbortSignal.any([signal, gone.signal])
    try {
      const answer = await this.ask({ call: id, tool: "", title: form.message, options: [], form }, both).catch(() => null)
      if (!answer || !("accept" in answer) || both.aborted) return { action: "cancel" }
      if (!answer.accept) return { action: "decline" }
      return form.url ? { action: "accept" } : { action: "accept", content: (answer.content ?? {}) as Record<string, ElicitationContentValue> }
    } finally {
      this.forms.delete(id)
    }
  }

  completed(id: string): void {
    this.forms.get(id)?.abort()
  }
}

/** A form or page as the card shows it: its fields from the agent's schema, or its address. */
function formOf(req: CreateElicitationRequest): AgentAsk["form"] | null {
  const message = typeof req.message === "string" ? req.message : ""
  if (req.mode === "url") return typeof req.url === "string" && /^https?:\/\//i.test(req.url) ? { message, url: req.url } : null
  if (req.mode !== "form") return null
  const schema = (req as { requestedSchema?: { properties?: Record<string, any>; required?: unknown } }).requestedSchema
  const required = new Set(Array.isArray(schema?.required) ? schema.required : [])
  const text = (v: unknown) => (typeof v === "string" ? v : undefined)
  const labelled = (list: unknown) => (Array.isArray(list) ? list.flatMap((o) => (typeof o?.const === "string" ? [{ value: o.const, label: text(o.title) ?? o.const }] : [])) : [])
  const listed = (list: unknown, names?: unknown) => (Array.isArray(list) ? list.flatMap((v, i) => (typeof v === "string" ? [{ value: v, label: (Array.isArray(names) ? text(names[i]) : undefined) ?? v }] : [])) : [])
  const fields: AgentFormField[] = []
  for (const [name, p] of Object.entries(schema?.properties ?? {})) {
    if (!["string", "number", "integer", "boolean", "array"].includes(p?.type)) continue
    const choices = p.type === "array" ? [...listed(p.items?.enum), ...labelled(p.items?.anyOf)] : [...listed(p.enum, p.enumNames), ...labelled(p.oneOf)]
    fields.push({ name, title: text(p.title) ?? name, ...(text(p.description) ? { description: p.description } : {}), type: p.type, required: required.has(name), ...(choices.length ? { choices } : {}) })
  }
  return { message, fields }
}

class AgentExited extends Error {}
class NoSuchMode extends Error {}

export interface AcpRun {
  spec: RunSpec
  host: Host
  launch: Launch
  env: NodeJS.ProcessEnv
  mcpServers: McpServer[]
  start: Start
  label: string
  /** What the run says when the agent needs its own sign-in. */
  loginHint: string
  turn: Turn
}

export function runAcp({ spec, host, launch, env, mcpServers, start, label, loginHint, turn }: AcpRun): RunHandle {
  let child: ChildProcess
  try {
    // Its own process group on macOS and Linux, so stopping the run stops what the agent started.
    child = spawn(launch.cmd, launch.args, { cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: !isWin })
  } catch (err) {
    return failedRun(`Could not start ${label}: ${String(err)}`, true)
  }
  let stderr = ""
  child.stderr!.setEncoding("utf8").on("data", (c: string) => (stderr = (stderr + c).slice(-L.stderrChars)))
  child.stdin!.on("error", () => undefined)
  let spawnError: Error | undefined
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      spawnError = err
      resolve(null)
    })
    child.on("close", resolve)
  })

  let sessionId: string | null = null
  let stopped: "cancelled" | "timed out" | null = null
  // The run's clock stands still while the person is asked; a run that stops takes its asks back.
  const asking = new AbortController()
  let deadline = Date.now() + spec.timeoutMs
  let waiting = 0
  let pausedAt = 0
  let timer: NodeJS.Timeout | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => stop("timed out"), Math.max(0, deadline - Date.now()))
  }
  const meanwhile = async <T>(asked: () => Promise<T>): Promise<T> => {
    if (waiting++ === 0) {
      pausedAt = Date.now()
      clearTimeout(timer)
    }
    try {
      return await asked()
    } finally {
      if (--waiting === 0 && !stopped) {
        deadline += Date.now() - pausedAt
        arm()
      }
    }
  }
  const conn = client({ name: host.client.name })
    .onNotification("session/update", ({ params }) => turn.update(params.update))
    .onRequest("session/request_permission", ({ params }) => meanwhile(() => turn.permission(params, !!stopped, asking.signal)))
    .onRequest("elicitation/create", ({ params }) => meanwhile(() => turn.elicit(params, !!stopped, asking.signal)))
    .onNotification("elicitation/complete", ({ params }) => turn.completed(params.elicitationId))
    .connect(ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>))
  // Asks the agent to end its turn (the session stays resumable), and stops it if it doesn't exit.
  const stop = (why: "cancelled" | "timed out") => {
    stopped ??= why
    asking.abort()
    if (sessionId) void conn.agent.notify("session/cancel", { sessionId }).catch(() => undefined)
    setTimeout(() => killTree(child), L.exitGraceMs)
  }
  arm()

  const converse = async () => {
    // No file system or terminal of the host's: the agent reads, edits and runs commands itself.
    await conn.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { elicitation: { form: {}, url: {} } }, clientInfo: host.client })
    const opened = { cwd: spec.cwd, mcpServers, _meta: start.meta }
    const session: { sessionId?: string; modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null } = spec.resume
      ? await conn.agent.request("session/resume", { sessionId: spec.sessionId, ...opened })
      : await conn.agent.request("session/new", opened)
    const id = (sessionId = spec.resume ? spec.sessionId : session.sessionId!)
    turn.started(id)
    let modes = session.modes ?? null
    // What the session opened with, its mode option set to the mode switched to below: an agent may announce the
    // switch before it answers, and this list must not undo that.
    let options = (session.configOptions ?? []).map((o) => (o.category === "mode" && o.type === "select" ? { ...o, currentValue: start.mode } : o))
    if (modes?.currentModeId !== start.mode) {
      if (!modes?.availableModes.some((m) => m.id === start.mode)) throw new NoSuchMode(`${label} doesn't offer ${start.mode}, the mode this run starts in, so the run stopped before it began`)
      await conn.agent.request("session/set_mode", { sessionId: id, modeId: start.mode })
      modes = { ...modes, currentModeId: start.mode }
    }
    // The model through its option too: a resumed session otherwise goes back to the agent's default.
    const model = options.find((o) => o.category === "model")
    if (start.model && model?.type === "select" && model.currentValue !== start.model && selectOptions(model).some((x) => x.value === start.model)) {
      options = (await conn.agent.request("session/set_config_option", { sessionId: id, configId: model.id, value: start.model })).configOptions ?? options
    }
    const effort = options.find((o) => o.category === "thought_level")
    if (spec.effort && effort?.type === "select" && effort.currentValue !== spec.effort && selectOptions(effort).some((option) => option.value === spec.effort)) {
      options = (await conn.agent.request("session/set_config_option", { sessionId: id, configId: effort.id, value: spec.effort })).configOptions ?? options
    }
    turn.published(modes, options)
    if (stopped) return null
    // The cells' texts, then the person's words, set apart by a rule, and the files given with them: no words of the host's.
    const prompt: ContentBlock[] = [
      { type: "text", text: start.preamble ? `${start.preamble}\n\n---\n\n${spec.prompt}` : spec.prompt },
      ...(spec.attachments ?? []).map((a): ContentBlock => ({ type: "resource_link", uri: pathToFileURL(a.path).href, name: a.name, size: a.size, mimeType: a.type || null })),
    ]
    return conn.agent.request("session/prompt", { sessionId: id, prompt })
  }

  const done = (async (): Promise<RunResult> => {
    // What the turn reported stays on failures too: its tokens were spent either way.
    const result = (r: Partial<RunResult> & { ok: boolean }): RunResult => ({ text: turn.text, usage: emptyUsage(), costUsd: turn.costUsd, model: turn.model, permissionDenials: turn.denials, refusedWrites: turn.refusedWrites, ...r })
    const failure = (error: string, runtimeDown = false) => result({ ok: false, error, runtimeDown })
    // Only a sign-in problem before anything was spent takes the whole runtime offline.
    const signIn = (msg: string) => authProblem(msg) && turn.costUsd === null
    const ended = (usage = emptyUsage()) => (stopped === "cancelled" ? result({ ok: false, cancelled: true, error: "Cancelled", usage }) : result({ ok: false, error: `Timed out after ${Math.round(spec.timeoutMs / 60000)} min`, usage }))
    try {
      const res = await Promise.race([converse(), exited.then(() => Promise.reject(new AgentExited()))])
      const usage = acpUsage(res?.usage)
      if (stopped || !res) return ended(usage)
      const why = Object.hasOwn(STOPS, res.stopReason) ? STOPS[res.stopReason] : `The agent ended the turn: ${res.stopReason}`
      return why ? result({ ok: false, usage, error: why }) : result({ ok: true, usage })
    } catch (err) {
      if (stopped) return ended()
      if (err instanceof NoSuchMode) return failure(err.message, true)
      const code = isRecord(err) && typeof err.code === "number" ? err.code : undefined
      if (code === AUTH_REQUIRED) return failure(loginHint, true)
      if (code === RESOURCE_NOT_FOUND && spec.resume) return failure(`Session ${spec.sessionId} could not be resumed: not found`)
      if (code === undefined) {
        // Not an answer from the agent: the connection broke, most likely as the agent exited.
        const exitCode = await Promise.race([exited, sleep(1000).then(() => undefined)])
        if (spawnError) return failure(`Could not start ${label}: ${spawnError.message}`, true)
        if (exitCode !== undefined || err instanceof AgentExited) {
          const msg = stderr.trim() || `${label} exited with code ${exitCode} before the turn ended`
          return failure(msg.slice(-L.errorChars), signIn(msg.slice(-300)))
        }
      }
      const msg = errorText(err)
      return failure(msg.slice(0, L.errorChars), signIn(msg))
    } finally {
      clearTimeout(timer)
      // Asks still open have no one left to hear them; closing stdin ends the agent, stopped if it lingers.
      asking.abort()
      conn.close()
      child.stdin!.end()
      const lingering = setTimeout(() => killTree(child), L.exitGraceMs)
      void exited.then(() => clearTimeout(lingering))
    }
  })()

  return { pid: child.pid, done, cancel: () => void (stopped || stop("cancelled")) }
}
