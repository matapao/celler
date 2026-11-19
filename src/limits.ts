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
