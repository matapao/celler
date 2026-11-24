// One run of Codex through the Codex SDK: its settings from the run and its settings file for this system
// (sandbox/codex.*.ts), handed to Codex on its command line; what it does as the run's progress, and how it ended.
// Codex asks no one: what would go beyond its sandbox it refuses itself.

import { Codex, type FileChangeItem, type ModelReasoningEffort, type ThreadEvent, type ThreadItem, type ThreadOptions, type Usage, type UserInput } from "@openai/codex-sdk"
import { harnessLimits as L } from "../limits.js"
import { VALUES } from "./programs.js"
import { forThisSystem, promptOf, saysSignedOut, type Turn } from "./runtime.js"
import codexOnLinux from "./sandbox/codex.linux.js"
import codexOnMacos from "./sandbox/codex.macos.js"
import codexOnWindows from "./sandbox/codex.windows.js"
import { outside } from "./sandbox/places.js"
import { emptyUsage, errorText, isTier, type ModelTier, type RunResult, type RunSpec } from "./types.js"

/** Codex's settings file for each system it runs on (sandbox/). */
const CODEX_ON: Partial<Record<NodeJS.Platform, typeof codexOnMacos>> = { darwin: codexOnMacos, linux: codexOnLinux, win32: codexOnWindows }

/** The efforts it takes. */
const EFFORTS: ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"]
/** Files it is given as pictures to see, besides their links. */
const PICTURES = /^image\/(png|jpeg|gif|webp)$/i
/** What it says when it isn't signed in itself for the host. */
const SIGN_IN_RE = /\b401\b|unauthori[sz]ed|not logged in|codex login/i
/** A command as it ran it, through its shell (`/bin/zsh -lc 'npm test'`), as it was given (`npm test`). */
const IN_SHELL = /^(?:\S*\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/

/** A string as TOML writes it: as JSON does, with U+007F escaped too, which no TOML string holds as it is. */
const tomlString = (s: string) => JSON.stringify(s).replaceAll("\x7f", "\\u007f")

/** A value as TOML writes it inline, as Codex's `--config key=value` reads it: a JSON string is a TOML string. */
function toml(value: unknown): string {
  if (typeof value === "string") return tomlString(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`
  if (typeof value === "object" && value !== null) {
    const key = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k))
    const entries = Object.entries(value).map(([k, v]) => `${key(k)} = ${toml(v)}`)
    return entries.length ? `{ ${entries.join(", ")} }` : "{}"
  }
  throw new Error(`Codex can't be given ${String(value)} as a setting`)
}

/**
 * Its settings for the run as Codex takes them on its command line, one whole table per key: a key's dots are its own
 * there, so a table keyed by paths goes inline. The connectors' values aren't among them: they are in `values`, the
 * variables Codex reads them from, which its commands never get.
 */
function settingsFor(t: Turn, values: Record<string, string>): string[] {
  const { spec } = t
  const own = forThisSystem(CODEX_ON, "Codex")(t.places, spec.purpose === "work" ? "work" : "read")
  // A model-only decision runs no command, and gets no MCP server, not even the run's own.
  if (spec.purpose === "inference") return Object.entries({ ...own, features: { ...own.features, shell_tool: false } }).map(([k, v]) => `${k}=${toml(v)}`)
  const valueOf = (value: string) => {
    const name = `${VALUES}${Object.keys(values).length}`
    values[name] = value
    return name
  }
  // The host's servers at their addresses. They gate each call themselves: Codex doesn't ask about them again. A call to
  // them may wait for the person as long as celler lets it (limits.ts).
  const servers = Object.fromEntries(
    spec.mcpServers.map((s) => [s.name, { url: s.url, env_http_headers: Object.fromEntries(Object.entries(s.headers).map(([name, value]) => [name, valueOf(value)])), default_tools_approval_mode: "approve", tool_timeout_sec: L.mcpCallMs / 1000 }]),
  )
  return Object.entries({ ...own, mcp_servers: servers }).map(([k, v]) => `${k}=${toml(v)}`)
}

/** The cells' texts, then the person's words, set apart by a rule, and the files given with them; pictures to see too. */
function inputOf(spec: RunSpec): UserInput[] {
  const text = [spec.systemPrompt.trim(), promptOf(spec)].filter(Boolean).join("\n\n---\n\n")
  const pictures = (spec.attachments ?? []).filter((a) => PICTURES.test(a.type)).map((a): UserInput => ({ type: "local_image", path: a.path }))
  return [{ type: "text", text }, ...pictures]
}

/** One run of Codex, to its end. */
export async function runCodex(t: Turn, o: { models: Record<ModelTier, string>; signedOut: string }): Promise<RunResult> {
  const { spec } = t
  const model = isTier(spec.model) ? o.models[spec.model] : spec.model
  const effort = EFFORTS.find((e) => e === spec.effort)
  const values: Record<string, string> = {}
  const configOverrides = settingsFor(t, values)
  // Its environment as given, nothing of this process's besides: the SDK passes on no other.
  const env = Object.fromEntries(Object.entries({ ...t.env, ...values }).filter((e): e is [string, string] => e[1] !== undefined))
  const codex = new Codex({ codexPathOverride: t.program, env, configOverrides })
  const options: ThreadOptions = { workingDirectory: spec.cwd, skipGitRepoCheck: true, ...(model ? { model } : {}), ...(effort ? { modelReasoningEffort: effort } : {}) }
  const thread = spec.resume ? codex.resumeThread(spec.sessionId, options) : codex.startThread(options)
  const report = new Report(t, model, effort)
  try {
    const { events } = await thread.runStreamed(inputOf(spec), { signal: t.signal })
    for await (const e of events) report.event(e)
  } catch (err) {
    report.broke(err)
  }
  return report.ending(o.signedOut)
}

/** One run as Codex reports it: its reply, its commands, edits and tool calls, its usage, what it couldn't write. */
class Report {
  private text = ""
  private reported = new Set<string>()
  private usage?: Usage
  /** Why its turn failed, else the last error it said on the way, which it may have got past. */
  private failed?: string
  private said?: string
  private refused = new Set<string>()

  constructor(
    private t: Turn,
    private model: string,
    private effort: string | undefined,
  ) {}

  event(e: ThreadEvent): void {
    switch (e.type) {
      case "thread.started":
        this.t.progress({ type: "session", sessionId: e.thread_id })
        this.t.progress({ type: "settings", settings: [{ id: "model", name: "Model", value: this.model }, ...(this.effort ? [{ id: "effort", name: "Reasoning effort", value: this.effort }] : [])] })
        return
      case "item.started":
      case "item.updated":
        return this.item(e.item, false)
      case "item.completed":
        return this.item(e.item, true)
      case "turn.completed":
        this.usage = e.usage
        return
      case "turn.failed":
        this.failed = e.error.message
        return
      case "error":
        this.said = e.message
        return
    }
  }

  /** Its program's end, which says less than the turn it failed, when it did. */
  broke(err: unknown): void {
    this.failed ??= errorText(err)
  }

  private item(item: ThreadItem, completed: boolean): void {
    switch (item.type) {
      case "agent_message":
        this.text = item.text
        return this.t.progress({ type: "text", text: item.text })
      case "command_execution": {
        const command = IN_SHELL.exec(item.command)?.[2] ?? item.command
        return this.tool(item.id, "execute", `execute: ${command.slice(0, L.commandChars)}`)
      }
      case "mcp_tool_call":
        return this.tool(item.id, `${item.server}.${item.tool}`, `${item.server}.${item.tool}`)
      case "web_search":
        return this.tool(item.id, "websearch", `websearch "${item.query.slice(0, L.searchChars)}"`)
      case "file_change":
        if (completed) this.changed(item)
        return
    }
  }

  /** A call, once. */
  private tool(id: string, tool: string, summary: string): void {
    if (this.reported.has(id)) return
    this.reported.add(id)
    this.t.progress({ type: "tool", tool, summary, call: id })
  }

  /** The files an edit of its changed, or couldn't: one outside its folder is a write refused. */
  private changed(item: FileChangeItem): void {
    for (const change of item.changes) {
      this.tool(`${item.id}:${change.path}`, "edit", `edit ${change.path}`)
      if (item.status === "completed") this.t.progress({ type: "file", file: change.path })
      else if (outside(change.path, this.t.spec.cwd)) this.refused.add(change.path)
    }
  }

  /** How the run ended: its reply, or why its turn didn't end; what it spent either way. */
  ending(signedOut: string): RunResult {
    const { spec } = this.t
    const u = this.usage
    const result = {
      text: this.text,
      usage: u ? { ...emptyUsage(), input: u.input_tokens, output: u.output_tokens, cacheRead: u.cached_input_tokens, cacheWrite5m: u.cache_write_input_tokens } : emptyUsage(),
      costUsd: null,
      ...(this.model ? { model: this.model } : {}),
      permissionDenials: [],
      refusedWrites: [...this.refused],
    }
    if (u && !this.failed) return { ...result, ok: true }
    const why = this.failed ?? this.said ?? "Codex ended before its turn did"
    const failed = (error: string, runtimeDown = false) => ({ ...result, ok: false, error: error.slice(-L.errorChars), runtimeDown })
    if (spec.resume && /no rollout found/i.test(why)) return failed(`Session ${spec.sessionId} could not be resumed: not found`)
    // Only a sign-in problem before anything was spent takes the whole runtime offline.
    if (saysSignedOut(why, SIGN_IN_RE) && !u) return failed(signedOut, true)
    return failed(why)
  }
}
