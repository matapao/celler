import assert from "node:assert/strict"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { createApp, readMcp, postJson } from "senter-mvp"
import { object, request, text, tool, unit, withClient } from "./support.mjs"

test("an MCP read preserves the upstream tool name, arguments and structured result", async t => {
  const database = new DatabaseSync(":memory:")
  t.after(() => database.close())
  const upstream = {
    async callTool(call, _schema, { signal }) {
      assert.deepEqual(call, { name: "lookup_original", arguments: { id: "A" } })
      assert.ok(signal instanceof AbortSignal)
      return { ...text("record"), structuredContent: { ref: "B" } }
    },
  }
  const app = createApp({ database, adapters: new Map([["records", readMcp(async () => upstream, "lookup_original")]]),
    platform: {
      allowed: () => true,
      launch: (_run, connect) => withClient(connect, client => client.callTool({ name: "lookup", arguments: { id: "A" } })),
    },
  })
  const revision = app.publish([unit("root", ["lookup"]), tool("lookup", { adapter: "records" }, {
    inputSchema: object({ id: { type: "string" } }), outputSchema: object({ ref: { type: "string" } }),
  })])
  assert.deepEqual((await app.start(request(revision))).structuredContent, { ref: "B" })
})

test("the JSON connector dispatches the reviewed bytes to the configured endpoint", async t => {
  const endpoint = "https://example.invalid/receive"
  const adapter = postJson("account", endpoint, async () => "fixture-token")
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, endpoint)
    assert.equal(options.headers["Idempotency-Key"], "receipt")
    assert.equal(options.body, '{"body":"before"}')
    assert.equal(options.redirect, "error")
    return new Response("accepted")
  })
  const args = { body: "before" }
  const write = await adapter.prepare({}, args)
  args.body = "after"
  assert.equal(fetch.mock.callCount(), 0)
  await assert.rejects(adapter.send({}, { ...write, destination: "https://example.invalid/other" }, "receipt"))
  assert.deepEqual(await adapter.send({}, write, "receipt"), text("accepted"))
  assert.equal(fetch.mock.callCount(), 1)
})

test("connectors enforce URL credential rules, response/result byte limits, and signal forwarding", async t => {
  assert.throws(() => postJson("acc", "https://user:pass@example.invalid/hook", async () => "t"), /credentials/)
  assert.throws(() => postJson("acc", "http://example.invalid/hook", async () => "t"), /HTTPS/)

  const endpoint = "https://example.invalid/receive"
  const adapter = postJson("acc", endpoint, async () => "tok", { maxResponseBytes: 16, timeoutMs: 500 })
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal)
    return new Response("x".repeat(64))
  })
  const write = await adapter.prepare({}, { ok: true })
  await assert.rejects(adapter.send({}, write, "k1"), /byte limit/)

  // readMcp forwards AbortSignal to client resolver and enforces maxBytes.
  let gotSignal = false
  const reader = readMcp(async (_run, signal) => {
    gotSignal = signal instanceof AbortSignal
    return { callTool: async () => text("y".repeat(200)) }
  }, "big_read", { maxBytes: 64 })
  await assert.rejects(reader.call({}, {}, AbortSignal.timeout(1000)), /byte limit/)
  assert.equal(gotSignal, true)
})
