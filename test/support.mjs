import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"

/** Waits until `ok()` holds, looking every few milliseconds; fails after `ms`, so a test never hangs. */
export async function until(ok, ms = 5_000) {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw Error("timed out waiting")
    await delay(5)
  }
}

/** A database in memory for one test, closed after it. */
export function memoryDatabase(t) {
  const database = new DatabaseSync(":memory:")
  t.after(() => database.close())
  return database
}

export const text = value => ({ content: [{ type: "text", text: value }] })
export const cell = (id, exports, options = {}) => ({ kind: "cell", id, title: id, profile: id, exports, ...options })
export const object = (properties = {}) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
})
export const tool = (id, target, definition = {}) => ({
  kind: "tool", id, target, definition: { name: id, inputSchema: object(), ...definition },
})
export const request = revision => ({ owner: "alice", revision, entry: "root", workspace: "folder", input: "work" })

export async function withClient(connect, work, native = false) {
  const [local, remote] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-harness", version: "1" })
  await connect(remote, native)
  try {
    await client.connect(local)
    return await work(client)
  } finally {
    await client.close()
  }
}
/** A tool call through `client`, which is closed once the call has settled, before the call's outcome is given. */
export async function callThenClose(client, request) {
  try {
    return await client.callTool(request)
  } finally {
    await client.close()
  }
}
export async function discover(client, args) {
  const result = await client.callTool({ name: "discover", arguments: args })
  if (result.isError) throw Error(result.content[0].text)
  return JSON.parse(result.content[0].text)
}
// Tool failures arrive as isError results; only protocol errors reject.
export async function refused(call, pattern) {
  const result = await call
  assert.equal(result.isError, true, "expected an isError result, got " + JSON.stringify(result))
  assert.match(result.content[0].text, pattern)
  return result
}
