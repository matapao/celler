// What a run of a coding agent takes and gives, the same for every agent, and what the host lends the runtimes.

/** The host: its name and version, which the agent's requests carry, and the mark its runs' environments carry. */
export interface Host {
  client: { name: string; version: string }
  mark(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
}

/** What the runtimes say in the host's words, where those name the host's own settings. */
export interface ClaudeWords {
  noClaude: string
  login: string
}
export interface CodexWords {
  install: string
  login: string
  signedOut: string
}

export type ModelTier = "fast" | "balanced" | "strong"
export const isTier = (v: string): v is ModelTier => v === "fast" || v === "balanced" || v === "strong"

export const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
export type TokenUsage = ReturnType<typeof emptyUsage>

/** A connector for one run, its values filled in. */
export interface McpServerSpec {
  name: string
  /** A program to start ("stdio") is the host's to start: a run is refused one. */
  transport: "stdio" | "http" | "sse"
  /** Never a secret in it: Codex is given it on its command line, which anyone on the computer can read. */
  url: string
  /** Where its secrets go: they reach Claude Code in its first request and Codex in variables of its own. */
  headers: Record<string, string>
}

export interface RunSpec {
  cwd: string
  prompt: string
  /** The cells' texts: Claude Code's system prompt, or ahead of Codex's prompt. */
  systemPrompt: string
  /** A tier or a model id. */
  model: string
  /** A reasoning effort offered by the agent. */
  effort?: string
  /** The session to continue with `resume`; a new session's id comes as a `session` event. */
  sessionId: string
  resume: boolean
  mcpServers: McpServerSpec[]
  /** Puts what the agent asks to the person and waits; null when no one answered. Without it, no ask is answered. */
  ask?: (q: AgentAsk, signal: AbortSignal) => Promise<AskAnswer | null>
  /** Files given with the task, linked from the prompt. */
  attachments?: { path: string; name: string; type: string }[]
  /**
   * What the agent may do. At `work`, its own tools in its folder, its commands in its sandbox (sandbox/*.ts): it reads,
   * writes and organizes anything under the folder, and reaches no network, so everything outside goes through the
   * run's MCP tools. To `read`, the same but writing nothing in the folder: a question answered in another's folder. For
   * `inference`, no tools at all, not even the run's MCP server: a model-only decision.
   */
  purpose: "work" | "read" | "inference"
  /** Places outside the folder its commands may read, as the host gives them: a worktree's repository data. */
  readable?: string[]
  timeoutMs: number
}

export type RunProgress =
  | { type: "session"; sessionId: string }
  /** A tool call once its summary is known; `parent`: the helper's call it came from; `helper`: what a helper it starts is to do. */
  | { type: "tool"; tool: string; summary: string; call?: string; parent?: string; helper?: string }
  | { type: "helper-done"; call: string; ok: boolean }
  /** A file a completed tool call changed. */
  | { type: "file"; file: string }
  /** The agent's own settings as the run started them. */
  | { type: "settings"; settings: AgentSetting[] }
  /** The message the agent is writing, as far as it has come. */
  | { type: "text"; text: string }

export interface RunResult {
  ok: boolean
  text: string
  usage: TokenUsage
  costUsd: number | null
  model?: string
  error?: string
  /** Not there, too old or not signed in: no run of this agent works until that is fixed. */
  runtimeDown?: boolean
  /** What was refused, as the agent described it ("Bash: npm test"). */
  permissionDenials: string[]
  /** Files it was refused writing outside its folder. */
  refusedWrites?: string[]
  cancelled?: boolean
}

export interface RunHandle {
  pid?: number
  done: Promise<RunResult>
  cancel(): void
  /**
   * Stops the run's clock until the release it returns: while the person decides what the run waits on, such as one of
   * its calls in the inbox. Its agent's own asks stop it too. A runtime that keeps no clock has none.
   */
  hold?(): () => void
}

export interface Runtime {
  /** "claude-code", "codex" or "simulated". */
  readonly kind: string
  /** Its agent searches the run's tools itself, so the run lists them all to it, not celler's menu. */
  readonly nativeDiscovery?: boolean
  run(spec: RunSpec, onProgress: (p: RunProgress) => void): RunHandle
  /** `deep` also test-runs a tiny prompt, as a model-only run (purpose `inference`): no tools, nothing of the person's. */
  health(deep: boolean): Promise<RuntimeHealth>
}

export interface RuntimeHealth {
  ok: boolean
  checkedAt: number
  detail: string
  /** Where its program was found. */
  program?: string
  /** What the host can offer: showing where the agent's program is, or the agent's own sign-in. */
  fix?: "find" | "login"
}

/** An agent's own sign-in in progress: its page once printed, its end, and a code pasted back for a page that shows one. */
export interface AgentLogin {
  url: Promise<string | null>
  done: Promise<{ ok: boolean; error?: string }>
  sendCode(code: string): void
  /** Called off: its program ends, and `done` with it. */
  cancel(): void
}

/** One of an agent's own settings, by its own name, on the value it is on. */
export interface AgentSetting {
  id: string
  name: string
  value: string
}

/** What an agent asks before it acts, with the options to pick from; or a form or page it asks for instead. */
export interface AgentAsk {
  call: string
  tool: string
  title: string
  input?: unknown
  options: { optionId: string; name: string; kind: "allow_once" | "reject_once" }[]
  form?: { message: string; fields?: AgentFormField[]; url?: string }
}

export interface AgentFormField {
  name: string
  title: string
  description?: string
  type: "string" | "number" | "integer" | "boolean" | "array"
  required: boolean
  choices?: { value: string; label: string }[]
}

/** The option the person picked, or the form or page answered. */
export type AskAnswer = { option: string } | { accept: boolean; content?: Record<string, unknown> }

export function failure(error: string, runtimeDown = false): RunResult {
  return { ok: false, text: "", usage: emptyUsage(), costUsd: null, error, runtimeDown, permissionDenials: [] }
}

export function failedRun(error: string, runtimeDown = false): RunHandle {
  return { done: Promise.resolve(failure(error, runtimeDown)), cancel: () => undefined }
}

export function errorText(err: unknown): string {
  return typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string" ? (err as { message: string }).message : String(err)
}
