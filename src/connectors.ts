import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Adapter } from './app.js';
import { fail } from './errors.js';
import { normalizeJson } from './json.js';
import { postLimits, readLimits, withLimits } from './limits.js';
import type { Run } from './store.js';
import type { Write } from './tables.js';

/** The body as text, or undefined once it is over `maxBytes`: the rest is never read. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string | undefined> {
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text) > maxBytes ? undefined : text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

/** Reads through one upstream MCP tool. The tool's arguments reach that server unreviewed, so use it only for reads. */
export function readMcp(
  client: (run: Run, signal: AbortSignal) => Promise<Client>,
  name: string,
  options: Partial<typeof readLimits> = {},
): Adapter {
  const { maxBytes } = withLimits(readLimits, options);
  return {
    async call(run, args, signal) {
      signal.throwIfAborted();
      const upstream = await client(run, signal);
      const result = CallToolResultSchema.parse(
        await upstream.callTool({ name, arguments: args }, undefined, { signal }),
      );
      if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
        fail('LIMIT_EXCEEDED', 'Upstream MCP result exceeds byte limit');
      }
      return result;
    },
  };
}

/** POSTs the approved JSON to one fixed HTTPS endpoint, with the approval id as its Idempotency-Key. */
export function postJson(
  account: string,
  endpoint: string,
  token: () => Promise<string>,
  options: Partial<typeof postLimits> = {},
): Adapter {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') fail('INVALID_CONFIG', 'Expected an HTTPS endpoint');
  if (url.username || url.password) fail('INVALID_CONFIG', 'Endpoint must not embed credentials');
  const { timeoutMs, maxResponseBytes } = withLimits(postLimits, options);

  function matches(write: Write) {
    if (
      write.account !== account ||
      write.destination !== endpoint ||
      write.operation !== 'POST' ||
      write.files.length
    ) {
      fail('DENIED', 'Approved packet no longer matches the adapter');
    }
  }

  /** The token to send with, or a refusal: printable ASCII only, which every header carries as it is. */
  async function bearer(): Promise<string> {
    const secret = await token();
    if (typeof secret !== 'string' || !/^[\x21-\x7e]+$/.test(secret))
      fail('DELIVERY_FAILED', 'Invalid authorization token');
    return secret;
  }

  // The token each approved packet is sent with, had as it is verified: one that can't be had keeps the approval
  // pending, as nothing was sent.
  const tokens = new WeakMap<Write, string>();

  return {
    prepare: async (_run, args) => ({
      account,
      destination: endpoint,
      operation: 'POST',
      content: normalizeJson(args),
      files: [],
    }),
    async verify(_run, write) {
      matches(write);
      tokens.set(write, await bearer());
    },
    async send(_run, write, key, signal) {
      matches(write);
      const secret = tokens.get(write) ?? (await bearer());
      tokens.delete(write);
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error', // a redirect would deliver somewhere the person did not approve
        signal: combined,
        headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(write.content),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {}); // unread, it would hold its connection
        fail('DELIVERY_FAILED', 'Delivery outcome needs checking: ' + response.status);
      }
      // It arrived: an answer too large to keep, or cut off as it is read, fails the call, never the delivery, which is
      // recorded as sent.
      let body: string | undefined;
      try {
        body = await readBoundedText(response, maxResponseBytes);
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'Delivered, but its response could not be read' }] };
      }
      if (body === undefined) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Delivered, but its response exceeds the byte limit' }],
        };
      }
      return { content: [{ type: 'text', text: body }] };
    },
  };
}
