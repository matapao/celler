import { createHash } from "node:crypto"
import { fail } from "./errors.js"
import { jsonDepth } from "./limits.js"

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Deep-clones and validates JSON-safe data; strips omitted (`undefined`) object properties. */
export function normalizeJson(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_ARGS", "Non-finite number is not valid JSON")
    return value
  }
  if (typeof value !== "object") fail("INVALID_ARGS", "Value is not valid JSON")
  if (seen.has(value)) fail("INVALID_ARGS", "Circular structure is not valid JSON")
  // `seen` holds what this value is inside, so its size is how deep the value nests.
  if (seen.size >= jsonDepth) fail("INVALID_ARGS", `JSON nests deeper than ${jsonDepth} levels`)
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => normalizeJson(item, seen))
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) fail("INVALID_ARGS", "Non-plain object is not valid JSON")
    const out: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      // Not `out[key] = …`: that would turn a `__proto__` key into the prototype.
      Object.defineProperty(out, key, {
        value: normalizeJson(item, seen), enumerable: true, writable: true, configurable: true,
      })
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/** Two of an object's entries in the order of their keys, compared as `<` compares strings. */
function byKey([a]: [string, unknown], [b]: [string, unknown]): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** JSON text with object keys sorted, so equal values always give equal text (`-0` and `0` included). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(byKey))
    : item)
}

/** The SHA-256 of a value's canonical JSON, in hex: equal values hash alike. */
export function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}
