import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

export const text = value => ({ content: [{ type: "text", text: value }] })
export const unit = (id, exports, options = {}) => ({ kind: "unit", id, title: id, profile: id, exports, ...options })
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
export async function discover(client, args) {
  const result = await client.callTool({ name: "discover", arguments: args })
  if (result.isError) throw Error(result.content[0].text)
  return JSON.parse(result.content[0].text)
}
// A tool failure comes back as an isError result the model can read. This checks the result and its message.
export async function refused(call, pattern) {
  const result = await call
  assert.equal(result.isError, true, "expected an isError result, got " + JSON.stringify(result))
  assert.match(result.content[0].text, pattern)
  return result
}
