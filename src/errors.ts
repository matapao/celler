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

export function fail(code: ErrorCode, message: string, node?: string): never {
  throw new CellerError(code, message, node);
}

/** Parses with a schema. A mismatch becomes an INVALID_ARGS error whose message says what to fix. */
export function parseWith<T extends z.ZodType>(schema: T, label: string, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) fail('INVALID_ARGS', `Invalid ${label}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
