import { fail } from "./errors.js"

/** The largest packet, payload or result held in memory at once. */
const INLINE_LIMIT = 16 * 1024 * 1024

// Every tunable bound and its default, by component. Hosts override a bound by naming it in that component's options.
export const appLimits = {
  /** Most tool-definition bytes put in front of the model at once. 0 always uses discover and invoke. */
  discoveryBytes: 4096,
  /** What discover takes: a query's characters and the words it looks for, and how many refs at once. */
  discoveryQueryChars: 256,
  discoveryTerms: 16,
  discoveryRefs: 20,
  /** What discover gives: the results on a page, and the furthest a page starts. */
  discoveryPageSize: 5,
  discoveryOffset: 10_000,
  inlineLimit: INLINE_LIMIT,
  /** Delegation depth below a root run. 0 forbids delegation. */
  maxDepth: 16,
  /** Runs active at once in one delegation tree, the root included. */
  maxRuns: 16,
  /** Tool calls in flight at once in one run. */
  maxConcurrency: 32,
  /** Tasks one MCP connection works on at once. An ended one is kept for its ttl besides. */
  maxTasks: 64,
  /** The longest a task is kept once it has ended, whatever its client asks. */
  taskTtlMs: 60 * 60_000,
  /** Pending approvals in one owner's inbox. */
  maxPendingApprovals: 32,
  /** Bytes of pending packets in one owner's inbox. */
  maxPendingBytes: 32 * 1024 * 1024,
  /** Compiled revisions, and runs with their grants, kept in memory. */
  graphCacheSize: 64,
  runCacheSize: 256,
  /** Compiled JSON Schemas kept in memory, shared by their text. */
  schemaCacheSize: 4096,
  /** The longest value the `url` format takes. */
  urlChars: 2048,
  /** How much of what is wrong with its arguments a call is told. */
  argsErrorChars: 500,
  /** The longest `celler/call-id` a client may give. */
  callIdChars: 128,
  /** Progress heartbeat while a call waits for a person or a delegated run. 0 sends none. */
  progressIntervalMs: 15_000,
  /** How long a statement waits for another connection's lock on the database. */
  busyTimeoutMs: 5000,
}
export const brokerLimits = {
  inlineLimit: INLINE_LIMIT,
  /** Workspace operations running at once; each one starts the broker. Launches don't count. */
  maxConcurrency: 16,
  /** Time between SIGTERM and SIGKILL when a broker outlives its request. */
  killTimeoutMs: 2000,
  /** The longest path, and the longest text a search looks for, that a workspace tool takes. */
  pathChars: 4096,
  queryChars: 4096,
}
export const readLimits = { maxBytes: INLINE_LIMIT }
export const postLimits = { timeoutMs: 30_000, maxResponseBytes: 1024 * 1024 }

// Module constants: no options name them.

/** How deep objects and arrays may nest in the JSON celler copies: a graph, a run's input, an approval's arguments. */
export const jsonDepth = 256
/** MCP's tasks: how many a listing gives at once, and how often a client is told to look again. */
export const taskListing = { pageSize: 10, pollMs: 1000 }
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
  /**
   * The largest request a run's MCP server reads: a call's arguments as large as celler takes inline (INLINE_LIMIT),
   * and the JSON-RPC message around them, its tool's name and its _meta.
   */
  mcpRequestBytes: INLINE_LIMIT + 64 * 1024,
  /**
   * The longest an agent lets one call to a run's MCP servers take: Claude Code's per-server `timeout` (which also lifts
   * its 5 minutes for a call it hears nothing from) and Codex's `tool_timeout_sec`, in seconds, in place of its own 300.
   * Celler bounds no call's wait for the person while its run goes on, and the run's clock stands still meanwhile, so
   * the agent's bound is the only one: Claude Code's own default (MCP_TOOL_TIMEOUT, 1e8 ms, about 28 hours), for both.
   */
  mcpCallMs: 100_000_000,
}

/**
 * The oldest of each agent's own programs a run starts: the version its SDK is made with (the Claude Agent SDK's
 * `claudeCodeVersion`, the Codex SDK's `@openai/codex`), which test/harness-programs.test.mjs holds against the
 * installed SDKs.
 */
export const agentVersions = { claude: "2.1.330", codex: "0.171.0" }

const ZERO_ALLOWED = new Set(["discoveryBytes", "maxDepth", "progressIntervalMs"])
/** The longest wait a timer takes in one go: a bound in milliseconds (its name ends in Ms) is one, and stays under it. */
const LONGEST_TIMER_MS = 2 ** 31 - 1

/**
 * Each default unless the options name it. Every bound is a positive safe integer, or zero where allowed; one in
 * milliseconds no longer than a timer waits, which would wait 1 ms for a longer one.
 */
export function withLimits<T extends Record<string, number>>(defaults: T, options: { [K in keyof T]?: number }): T {
  const limits: Record<string, number> = {}
  for (const [name, fallback] of Object.entries(defaults)) {
    const value = options[name as keyof T] ?? fallback
    if (!Number.isSafeInteger(value) || value < (ZERO_ALLOWED.has(name) ? 0 : 1)) fail("INVALID_CONFIG", "Invalid " + name)
    if (name.endsWith("Ms") && value > LONGEST_TIMER_MS) fail("INVALID_CONFIG", `Invalid ${name}: longer than a timer waits`)
    limits[name] = value
  }
  return limits as T
}
