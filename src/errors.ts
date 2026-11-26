import { z } from 'zod';

export type ErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_ARGS'
  | 'INVALID_OUTPUT'
  | 'INVALID_STATE'
  | 'KEY_CONFLICT'
  | 'DENIED'
  | 'REVOKED'
  | 'NOT_FOUND'
  | 'RUN_ENDED'
  | 'LIMIT_EXCEEDED'
  | 'UNAVAILABLE'
  | 'DECLINED'
  | 'DELIVERY_FAILED'
  | 'BROKER_ERROR';

/** An expected failure. Its message is safe to show the harness; any other error reaches it only as "Tool execution failed". */
export class CellerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** The id of the one node of a graph it is about, where it is about one, such as a tool whose schema is invalid. */
    readonly node?: string,
  ) {
    super(message);
    this.name = 'CellerError';
  }
}

/**
 * What an adapter's `send` throws when its request never reached the service: refused before it went out, or no
 * connection made. Its delivery is then recorded as failed, never as sent or unknown. Its message, as any host error's,
 * never reaches the agent: its run hears "Delivery failed", followed by its `reason` if it gives one.
 */
export class NotSent extends Error {
  /** Why it never left, in words its host writes for the agent, apart from its message: what its run is told. */
  readonly reason?: string;

  constructor(message = 'The request never reached the service', options?: ErrorOptions & { reason?: string }) {
    super(message, options);
    this.name = 'NotSent';
    if (options?.reason !== undefined) this.reason = options.reason;
  }
}

// Control characters, line breaks among them, and Unicode's line and paragraph separators.
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

/**
 * A NotSent's reason as its run hears it: on one line, each run of control characters and line breaks a space, trimmed
 * and cut to `maxChars`. None if it gives no text, or nothing is left of it.
 */
export function reasonOf(error: NotSent, maxChars: number): string | undefined {
  if (typeof error.reason !== 'string') return undefined;
  return error.reason.replace(BREAKS, ' ').trim().slice(0, maxChars).trimEnd() || undefined;
}

/**
 * A promise rejected with what `signal` aborted with, as it is: the reason its owner gave (an Error from `abort()` or
 * `AbortSignal.timeout`, or whatever a host passed) passes on unchanged, as the platform's own APIs pass it. Only for a
 * signal that has aborted.
 */
export function abortedWith(signal: AbortSignal): Promise<never> {
  return new Promise<never>(() => signal.throwIfAborted());
}

export function fail(code: ErrorCode, message: string, node?: string): never {
  throw new CellerError(code, message, node);
}

/** Parses with a schema. A mismatch becomes an INVALID_ARGS error whose message says what to fix. */
export function parseWith<T extends z.ZodType>(schema: T, label: string, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) fail('INVALID_ARGS', `Invalid ${label}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
