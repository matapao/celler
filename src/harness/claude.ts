// One run of Claude Code through the Claude Agent SDK: its options from the run and its settings file for this system
// (sandbox/claude.*.ts), what it does as the run's progress, what it asks put to the person, and how it ended.

import {
  query,
  type CanUseTool,
  type EffortLevel,
  type ElicitationRequest,
  type ElicitationResult,
  type ModelInfo,
  type OnElicitation,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { harnessLimits as L } from "../limits.js"
import { forThisSystem, promptOf, saysSignedOut, type Turn } from "./runtime.js"
import { claudeOnLinux } from "./sandbox/claude.linux.js"
import { claudeOnMacos } from "./sandbox/claude.macos.js"
import { claudeOnWindows } from "./sandbox/claude.windows.js"
import { outside } from "./sandbox/places.js"
import { emptyUsage, errorText, isTier, type AgentAsk, type AgentFormField, type AgentSetting, type ModelTier, type RunResult, type RunSpec, type TokenUsage } from "./types.js"

/** Claude Code's settings file for each system it runs on (sandbox/). */
const CLAUDE_ON: Partial<Record<NodeJS.Platform, typeof claudeOnMacos>> = { darwin: claudeOnMacos, linux: claudeOnLinux, win32: claudeOnWindows }

/** Its tools that write a file, and those that start a helper (a subagent). */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"])
const HELPER_TOOLS = new Set(["Task", "Agent"])
/** Where a call's input names its file, and how a call reads by the first of the other keys its input has. */
const FILE_KEYS = ["file_path", "notebook_path"]
const SUMMARIES: [string, (name: string, v: string) => string][] = [
  ["command", (n, v) => `${n}: ${v.slice(0, L.commandChars)}`],
  ["pattern", (n, v) => `${n} "${v.slice(0, L.searchChars)}"`],
  ["url", (n, v) => `${n} ${v}`],
  ["query", (n, v) => `${n} "${v.slice(0, L.searchChars)}"`],
]
/** The efforts it takes, and the run's when it is one of them. */
const EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"]
const effortOf = (spec: RunSpec) => EFFORTS.find((effort) => effort === spec.effort)
/** Its account can't run: no run works until the person signs in again, or sees to the account. */
const SIGNED_OUT = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error", "cloud_credential_error"])
/** What it says when it isn't signed in itself. */
const SIGN_IN_RE = /api key|\/login|authenticat|oauth|not logged in|credit balance/i
/** What the person may answer to a call it asks about: once, or not. "Always" would be written into the folder's settings. */
const OPTIONS: AgentAsk["options"] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
]
/** What it is told of a call the person didn't allow. */
const DECLINED = "The person declined this."
const UNANSWERED = "No one answered this."

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const fileOf = (input: unknown) => (isRecord(input) ? FILE_KEYS.map((k) => input[k]).find((v): v is string => typeof v === "string" && !!v) : undefined)

/** A tool call as the person reads it: by its file, else by the first of its other keys, else by its name. */
function summarize(name: string, input: unknown): string {
  const file = fileOf(input)
  if (file) return `${name} ${file}`
  if (!isRecord(input)) return name
  for (const [key, summary] of SUMMARIES) {
    const value = input[key]
    if (typeof value === "string") return summary(name, value)
  }
  return name
}

/** Its usage; cache writes without their lifetime count as 5-minute ones, its default. */
function usageOf(u: SDKResultMessage["usage"]): TokenUsage {
  const split = u.cache_creation
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite5m: split ? split.ephemeral_5m_input_tokens : u.cache_creation_input_tokens,
    cacheWrite1h: split ? split.ephemeral_1h_input_tokens : 0,
  }
}

/** The kinds of field a form asks for, and a schema's `type` when it is one of them. */
const FIELD_TYPES: AgentFormField["type"][] = ["string", "number", "integer", "boolean", "array"]
const fieldType = (v: unknown) => FIELD_TYPES.find((type) => type === v)
const asText = (v: unknown) => (typeof v === "string" ? v : undefined)

type Choice = { value: string; label: string }

/** A field's choices given as values (`enum`), each with its name beside it (`enumNames`) where it has one. */
function listedChoices(values: unknown, names?: unknown): Choice[] {
  if (!Array.isArray(values)) return []
  const choices: Choice[] = []
  values.forEach((value: unknown, i) => {
    if (typeof value !== "string") return
    const name = Array.isArray(names) ? asText(names[i]) : undefined
    choices.push({ value, label: name ?? value })
  })
  return choices
}

/** A field's choices given as schemas (`oneOf`, `anyOf`), each a constant with its title. */
function labelledChoices(options: unknown): Choice[] {
  if (!Array.isArray(options)) return []
  const list: unknown[] = options
  const choices: Choice[] = []
  for (const option of list) {
    if (isRecord(option) && typeof option.const === "string") choices.push({ value: option.const, label: asText(option.title) ?? option.const })
  }
  return choices
}

/** A form or page as the card shows it: its fields from the MCP server's schema, or its address. */
function formOf(req: ElicitationRequest): AgentAsk["form"] | null {
  if (req.mode === "url") {
    if (typeof req.url !== "string" || !/^https?:\/\//i.test(req.url)) return null
    return { message: req.message, url: req.url }
  }
  const schema = req.requestedSchema
  const properties: unknown = schema?.properties
  const required = new Set<unknown>(Array.isArray(schema?.required) ? schema.required : [])
  const fields: AgentFormField[] = []
  for (const [name, property] of Object.entries(typeof properties === "object" && properties !== null ? properties : {})) {
    if (!isRecord(property)) continue
    const type = fieldType(property.type)
    if (!type) continue
    const items: Record<string, unknown> = isRecord(property.items) ? property.items : {}
    const listed = type === "array" ? listedChoices(items.enum) : listedChoices(property.enum, property.enumNames)
    const labelled = type === "array" ? labelledChoices(items.anyOf) : labelledChoices(property.oneOf)
    const choices = [...listed, ...labelled]
    const description = asText(property.description)
    fields.push({
      name,
      title: asText(property.title) ?? name,
      ...(description ? { description } : {}),
      type,
      required: required.has(name),
      ...(choices.length ? { choices } : {}),
    })
  }
  return { message: req.message, fields }
}

/** Its questions to the person (AskUserQuestion's input) as a form's fields, each by its question, with its choices. */
function questionFields(input: unknown): AgentFormField[] {
  const questions = isRecord(input) && Array.isArray(input.questions) ? input.questions : []
  return questions.flatMap((q): AgentFormField[] => {
    if (!isRecord(q) || typeof q.question !== "string" || !Array.isArray(q.options)) return []
    const choices = q.options.flatMap((o) => (isRecord(o) && typeof o.label === "string" ? [{ value: o.label, label: o.label }] : []))
    const title = typeof q.header === "string" && q.header ? q.header : q.question
    return [{ name: q.question, title, type: q.multiSelect === true ? "array" : "string", required: true, choices }]
  })
}

/** Its options for the run: the run's own, then its settings file's for this system, in its own words. */
function optionsFor(t: Turn, model: string): Options {
  const { spec } = t
  const effort = effortOf(spec)
  const base: Options = {
    cwd: spec.cwd,
    pathToClaudeCodeExecutable: t.program,
    // Started as the runtime starts an agent's processes: in a process group of its own, which its end ends.
    spawnClaudeCodeProcess: (s) => t.spawn(s.command, s.args, s),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    // Its own system prompt, and the cells' texts after it: without it, it would start with an empty one.
    systemPrompt: { type: "preset", preset: "claude_code", ...(spec.systemPrompt ? { append: spec.systemPrompt } : {}) },
    // No settings files: a folder's own would run hooks and helpers outside what the host set. Only the host's connectors.
    settingSources: [],
    strictMcpConfig: true,
    ...(spec.resume ? { resume: spec.sessionId } : {}),
    includePartialMessages: true,
  }
  // A model-only decision: no tools at all, not even the run's MCP server, so nothing to keep in a sandbox.
  if (spec.purpose === "inference") {
    return { ...base, env: t.env, tools: [], settings: { disableClaudeAiConnectors: true, autoMemoryEnabled: false }, permissionMode: "default", persistSession: false }
  }
  const own = forThisSystem(CLAUDE_ON, "Claude Code")(t.places, spec.purpose)
  // The host's servers gate each call themselves: Claude Code doesn't ask about their tools again.
  const allow = [...own.settings.permissions.allow, ...spec.mcpServers.map((s) => `mcp__${s.name}`)]
  return {
    ...base,
    env: { ...t.env, ...own.env },
    tools: own.tools,
    sandbox: own.sandbox,
    settings: { ...own.settings, permissions: { ...own.settings.permissions, allow } },
    permissionMode: own.permissionMode,
    // The host's servers, sent in its first request rather than on its command line, where anyone on the computer could
    // read their values; a call to them may wait for the person as long as celler lets it (limits.ts).
    mcpServers: Object.fromEntries(spec.mcpServers.map((s) => [s.name, { type: s.transport === "sse" ? ("sse" as const) : ("http" as const), url: s.url, headers: s.headers, timeout: L.mcpCallMs }])),
    mcpServersDelivery: "initialize",
  }
}

/** One run of Claude Code, to its end. */
export async function runClaude(t: Turn, o: { models: Record<ModelTier, string>; signedOut: string }): Promise<RunResult> {
  const { spec } = t
  const model = isTier(spec.model) ? o.models[spec.model] : spec.model
  const report = new Report(t)
  const abort = new AbortController()
  const q = query({ prompt: promptOf(spec), options: { ...optionsFor(t, model), canUseTool: report.permission, onElicitation: report.elicit, abortController: abort } })
  // Asked to end its turn, its session kept to resume; stopped if it hasn't ended in its grace.
  const stop = () => {
    q.interrupt().catch(() => undefined)
    setTimeout(() => abort.abort(), L.exitGraceMs).unref()
  }
  t.signal.addEventListener("abort", stop, { once: true })
  if (t.signal.aborted) stop()
  q.initializationResult().then((init) => report.named(init.models), () => undefined)
  try {
    for await (const m of q) report.message(m)
  } catch (err) {
    report.broke(err)
  } finally {
    t.signal.removeEventListener("abort", stop)
    q.close()
  }
  return report.ending(o.signedOut)
}

/** One run as Claude Code reports it: its reply, its tool calls, what it asks, its cost and model, what was refused. */
class Report {
  /** Its calls, by their ids: each tool's name, and the file it writes, for one that writes. */
  private calls = new Map<string, { name: string; file?: string }>()
  /** The message it is writing, by the id of the message it streams in. */
  private writing = ""
  private writingIn: string | null = null
  private streamed = new Set<string>()
  private ended?: SDKResultMessage
  private error?: string
  private signedOut = false
  private model?: string
  /** Its models' names in its own words, by the model each is. */
  private names = new Map<string, string>()
  /** Forms and pages waiting on the person, each of which it can take back. */
  private forms = new Map<string, AbortController>()
  private formCount = 0
  private refused = new Set<string>()

  constructor(private t: Turn) {}

  named(models: ModelInfo[]): void {
    for (const m of models) this.names.set(m.resolvedModel ?? m.value, m.displayName)
  }

  message(m: SDKMessage): void {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") return this.started(m.session_id, m.model, m.permissionMode)
        if (m.subtype === "elicitation_complete") this.forms.get(m.elicitation_id)?.abort()
        return
      case "stream_event":
        return this.streaming(m.event, m.parent_tool_use_id)
      case "assistant":
        if (m.error && SIGNED_OUT.has(m.error)) this.signedOut = true
        for (const block of m.message.content) {
          if (block.type === "tool_use") this.tool(block.id, block.name, block.input, m.parent_tool_use_id)
          // A message of its own it didn't stream, whole.
          if (block.type === "text" && m.parent_tool_use_id === null && !this.streamed.has(m.message.id)) {
            if (this.writingIn !== m.message.id) this.begin(m.message.id)
            this.add(block.text)
          }
        }
        return
      case "user":
        if (typeof m.message.content === "string") return
        for (const block of m.message.content) if (block.type === "tool_result") this.finished(block.tool_use_id, block.is_error !== true)
        return
      case "result":
        this.ended = m
        return
    }
  }

  broke(err: unknown): void {
    this.error = errorText(err)
  }

  private started(sessionId: string, model: string, mode: string): void {
    this.model = model
    this.t.progress({ type: "session", sessionId })
    const effort = effortOf(this.t.spec)
    const settings: AgentSetting[] = [
      { id: "model", name: "Model", value: this.names.get(model) ?? model },
      { id: "mode", name: "Mode", value: mode },
      ...(effort ? [{ id: "effort", name: "Effort", value: effort }] : []),
    ]
    this.t.progress({ type: "settings", settings })
  }

  /** Its reply as it streams it; a helper's own words aren't the run's. */
  private streaming(event: SDKPartialAssistantMessage["event"], parent: string | null): void {
    if (parent !== null) return
    if (event.type === "message_start") {
      this.streamed.add(event.message.id)
      this.begin(event.message.id)
    }
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") this.add(event.delta.text)
  }

  /** A new message of its own: what it writes starts again. */
  private begin(id: string): void {
    this.writingIn = id
    this.writing = ""
  }

  /** More of the message it is writing. */
  private add(text: string): void {
    this.writing += text
    this.t.progress({ type: "text", text: this.writing })
  }

  /** A call once it is made, with what it is to do; a helper's with what it is for. */
  private tool(id: string, name: string, input: unknown, parent: string | null): void {
    if (this.calls.has(id)) return
    this.calls.set(id, { name, file: WRITE_TOOLS.has(name) ? fileOf(input) : undefined })
    // oxlint-disable-next-line typescript/no-base-to-string -- Claude Code gives these as text: String() only guards the rest
    const helper =HELPER_TOOLS.has(name) && isRecord(input) ? String(input.description ?? input.prompt ?? "").trim().slice(0, L.helperChars) : ""
    this.t.progress({ type: "tool", tool: name, summary: summarize(name, input), call: id, ...(parent ? { parent } : {}), ...(helper ? { helper } : {}) })
  }

  /** A call's end: the file it wrote, or refused writing outside the folder; a helper done. */
  private finished(id: string, ok: boolean): void {
    const call = this.calls.get(id)
    if (!call) return
    const { file } = call
    if (file && ok) this.t.progress({ type: "file", file })
    if (file && !ok && outside(file, this.t.spec.cwd)) this.refused.add(file)
    if (HELPER_TOOLS.has(call.name)) this.t.progress({ type: "helper-done", call: id, ok })
  }

  /** What it asks before it acts, put to the person; nothing is answered in the person's place. */
  readonly permission: CanUseTool = async (tool, input, o): Promise<PermissionResult> => {
    if (tool === "AskUserQuestion") return this.question(input, o.toolUseID, o.signal)
    const ask = this.t.ask
    const answer = ask ? await ask({ call: o.toolUseID, tool, title: o.title ?? summarize(tool, input), input, options: OPTIONS }, o.signal) : null
    if (answer && "option" in answer && answer.option === "allow") return { behavior: "allow", updatedInput: input }
    // A no to writing a file outside its folder is a write refused, which the host may offer the task that folder for.
    const file = WRITE_TOOLS.has(tool) ? fileOf(input) : undefined
    if (file && outside(file, this.t.spec.cwd)) this.refused.add(file)
    return { behavior: "deny", message: answer ? DECLINED : UNANSWERED }
  }

  /** Its questions to the person (AskUserQuestion) as a form, each answered with one of its choices, or several. */
  private async question(input: Record<string, unknown>, call: string, signal: AbortSignal): Promise<PermissionResult> {
    const fields = questionFields(input)
    const ask = this.t.ask
    if (!ask || !fields.length) return { behavior: "deny", message: UNANSWERED }
    const form = { message: fields.map((f) => f.name).join("\n"), fields }
    const answer = await ask({ call, tool: "AskUserQuestion", title: fields[0].name, input, options: [], form }, signal)
    if (!answer || !("accept" in answer) || !answer.accept) return { behavior: "deny", message: answer ? DECLINED : UNANSWERED }
    // oxlint-disable-next-line typescript/no-base-to-string -- MCP's answers are strings, numbers, booleans or lists: never another object
    const said =(v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : String(v ?? ""))
    const answers = Object.fromEntries(fields.map((f) => [f.name, said(answer.content?.[f.name])]))
    return { behavior: "allow", updatedInput: { ...input, answers } }
  }

  /** A form or page one of its MCP servers asks the person for, which it can take back when done elsewhere. */
  readonly elicit: OnElicitation = async (req, o): Promise<ElicitationResult> => {
    const form = formOf(req)
    const ask = this.t.ask
    if (!ask || !form) return { action: "cancel" }
    const id = req.elicitationId ?? `form-${++this.formCount}`
    const gone = new AbortController()
    this.forms.set(id, gone)
    const both = AbortSignal.any([o.signal, gone.signal])
    try {
      const answer = await ask({ call: id, tool: "", title: form.message, options: [], form }, both)
      if (!answer || !("accept" in answer) || both.aborted) return { action: "cancel" }
      if (!answer.accept) return { action: "decline" }
      return form.url ? { action: "accept" } : { action: "accept", content: (answer.content ?? {}) as ElicitationResult["content"] }
    } finally {
      this.forms.delete(id)
    }
  }

  /** How the run ended: its reply, or why it didn't end as the agent meant; what it spent either way. */
  ending(signedOut: string): RunResult {
    const { spec } = this.t
    const r = this.ended
    const permissionDenials = (r?.permission_denials ?? []).map((d) => {
      const file = WRITE_TOOLS.has(d.tool_name) ? fileOf(d.tool_input) : undefined
      if (file && outside(file, spec.cwd)) this.refused.add(file)
      return summarize(d.tool_name, d.tool_input)
    })
    const result = {
      text: r?.subtype === "success" ? r.result : this.writing,
      usage: r ? usageOf(r.usage) : emptyUsage(),
      costUsd: r ? r.total_cost_usd : null,
      ...(this.model ? { model: this.model } : {}),
      permissionDenials,
      refusedWrites: [...this.refused],
    }
    const failed = (error: string, runtimeDown = false) => ({ ...result, ok: false, error: error.slice(0, L.errorChars), runtimeDown })
    // Only a sign-in problem before anything was spent takes the whole runtime offline.
    const spent = (r?.total_cost_usd ?? 0) > 0
    if (this.signedOut && !spent) return failed(signedOut, true)
    if (!r) {
      const said = [this.t.stderr().trim(), this.error ?? ""].filter(Boolean).join("\n")
      if (spec.resume && /no conversation found/i.test(said)) return failed(`Session ${spec.sessionId} could not be resumed: not found`)
      if (saysSignedOut(said, SIGN_IN_RE)) return failed(signedOut, true)
      return { ...failed(""), error: (said || "Claude Code ended before its turn did").slice(-L.errorChars) }
    }
    if (r.subtype !== "success") return failed(r.errors.join("\n") || r.subtype)
    if (r.is_error) return saysSignedOut(r.result, SIGN_IN_RE) && !spent ? failed(signedOut, true) : failed(r.result || "Claude Code ended its turn with an error")
    if (r.stop_reason === "refusal") return failed("The model declined the request")
    return { ...result, ok: true }
  }
}
