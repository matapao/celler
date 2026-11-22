import { fail } from "./errors.js"

/** The largest packet, payload or result held in memory at once. */
export const INLINE_LIMIT = 16 * 1024 * 1024

// Every tunable bound and its default, by component. Hosts override a bound by naming it in that component's options.
export const appLimits = {
  /** Most tool-definition bytes put in front of the model at once. 0 always uses discover and invoke. */
  discoveryBytes: 4096,
  inlineLimit: INLINE_LIMIT,
  /** Delegation depth below a root run. 0 forbids delegation. */
  maxDepth: 16,
  /** Runs active at once in one delegation tree, the root included. */
  maxRuns: 16,
  /** Tool calls in flight at once in one run. */
  maxConcurrency: 32,
  /** Pending approvals in one owner's inbox. */
  maxPendingApprovals: 32,
  /** Bytes of pending packets in one owner's inbox. */
  maxPendingBytes: 32 * 1024 * 1024,
  /** Compiled revisions kept in memory. */
  graphCacheSize: 64,
  /** Progress heartbeat while a call waits for a person or a delegated run. 0 sends none. */
  progressIntervalMs: 15_000,
}
export const brokerLimits = {
  inlineLimit: INLINE_LIMIT,
  /** Workspace operations running at once; each one starts the broker. Launches don't count. */
  maxConcurrency: 16,
  /** Time between SIGTERM and SIGKILL when a broker outlives its request. */
  killTimeoutMs: 2000,
}
export const readLimits = { maxBytes: INLINE_LIMIT }
export const postLimits = { timeoutMs: 30_000, maxResponseBytes: 1024 * 1024 }
/** The coding agents' harnesses: how long a program is waited for, and how much of what it says is kept. */
export const harnessLimits = {
  /** A program asked its version or whether it is signed in. */
  askMs: 20_000,
  /** A health check's test run. */
  claudeTestRunMs: 90_000,
  codexTestRunMs: 180_000,
  /** A cancelled or finished agent's time to exit before it is stopped, with what it started. */
  exitGraceMs: 3000,
  /** A sign-in left open this long is stopped. */
  loginMs: 15 * 60_000,
  /** The end of an agent's error output that is kept, and how much of it a run's error carries. */
  stderrChars: 4000,
  errorChars: 800,
  /** A tool call as the person sees it: a command, a search, what a helper is to do. */
  commandChars: 160,
  searchChars: 80,
  helperChars: 200,
}

/**
 * The oldest of each agent's own programs a run starts: the version its SDK is made with (the Claude Agent SDK's
 * `claudeCodeVersion`, the Codex SDK's `@openai/codex`), which test/harness.test.mjs holds against the installed SDKs.
 */
export const agentVersions = { claude: "2.1.330", codex: "0.171.0" }

const ZERO_ALLOWED = new Set(["discoveryBytes", "maxDepth", "progressIntervalMs"])

/** Each default unless the options name it. Every bound is a positive safe integer, or zero where allowed. */
export function withLimits<T extends Record<string, number>>(defaults: T, options: { [K in keyof T]?: number }): T {
  const limits: Record<string, number> = {}
  for (const [name, fallback] of Object.entries(defaults)) {
    const value = options[name as keyof T] ?? fallback
    if (!Number.isSafeInteger(value) || value < (ZERO_ALLOWED.has(name) ? 0 : 1)) fail("INVALID_CONFIG", "Invalid " + name)
    limits[name] = value
  }
  return limits as T
}
