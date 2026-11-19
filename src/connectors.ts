import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import type { Adapter } from "./app.js"
import { fail } from "./errors.js"
import { normalizeJson } from "./json.js"
import { postLimits, readLimits, withLimits } from "./limits.js"
import type { Run, Write } from "./store.js"

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text) > maxBytes) fail("LIMIT_EXCEEDED", "Response body exceeds byte limit")
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        fail("LIMIT_EXCEEDED", "Response body exceeds byte limit")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, bytes).toString("utf8")
}

/** Reads through one upstream MCP tool. The tool's arguments reach that server unreviewed, so use it only for reads. */
export function readMcp(
  client: (run: Run, signal: AbortSignal) => Promise<Client>,
  name: string,
  options: Partial<typeof readLimits> = {},
): Adapter {
  const { maxBytes } = withLimits(readLimits, options)
  return {
    async call(run, args, signal) {
      signal.throwIfAborted()
      const upstream = await client(run, signal)
      const result = CallToolResultSchema.parse(await upstream.callTool({ name, arguments: args }, undefined, { signal }))
      if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
        fail("LIMIT_EXCEEDED", "Upstream MCP result exceeds byte limit")
      }
      return result
    },
  }
}

/** POSTs the approved JSON to one fixed HTTPS endpoint, with the approval id as its Idempotency-Key. */
export function postJson(
  account: string,
  endpoint: string,
  token: () => Promise<string>,
  options: Partial<typeof postLimits> = {},
): Adapter {
  const url = new URL(endpoint)
  if (url.protocol !== "https:") fail("INVALID_CONFIG", "Expected an HTTPS endpoint")
  if (url.username || url.password) fail("INVALID_CONFIG", "Endpoint must not embed credentials")
  const { timeoutMs, maxResponseBytes } = withLimits(postLimits, options)

  function verify(_run: Run, write: Write) {
    if (write.account !== account || write.destination !== endpoint || write.operation !== "POST" || write.files.length) {
      fail("DENIED", "Approved packet no longer matches the adapter")
    }
  }

  return {
    prepare: async (_run, args) => ({
      account, destination: endpoint, operation: "POST", content: normalizeJson(args), files: [],
    }),
    verify,
    async send(run, write, key, signal) {
      verify(run, write)
      const secret = await token()
      if (!secret || /[\r\n]/.test(secret)) fail("DELIVERY_FAILED", "Invalid authorization token")
      const timeout = AbortSignal.timeout(timeoutMs)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal: combined,
        headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(write.content),
      })
      if (!response.ok) fail("DELIVERY_FAILED", "Delivery outcome needs checking: " + response.status)
      return { content: [{ type: "text", text: await readBoundedText(response, maxResponseBytes) }] }
    },
  }
}
