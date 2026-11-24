import assert from "node:assert/strict"
import test from "node:test"
import { createApp, readMcp, postJson } from "celler"
import { cell, memoryDatabase, object, refused, request, text, tool, until, withClient } from "./support.mjs"

test("an MCP read preserves the upstream tool name, arguments and structured result", async t => {
  const database = memoryDatabase(t)
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
  const revision = app.publish([cell("root", ["lookup"]), tool("lookup", { adapter: "records" }, {
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
  // It arrived: an answer too large to keep is the call's error, never a failed delivery.
  const answered = await adapter.send({}, write, "k1")
  assert.equal(answered.isError, true)
  assert.match(answered.content[0].text, /^Delivered, .*byte limit/)

  // readMcp forwards AbortSignal to client resolver and enforces maxBytes.
  let gotSignal = false
  const reader = readMcp(async (_run, signal) => {
    gotSignal = signal instanceof AbortSignal
    return { callTool: async () => text("y".repeat(200)) }
  }, "big_read", { maxBytes: 64 })
  await assert.rejects(reader.call({}, {}, AbortSignal.timeout(1000)), /byte limit/)
  assert.equal(gotSignal, true)
})

test("a delivery that arrived is recorded as sent, though its answer is too large to keep", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(64), { status: 201 }))
  const hook = postJson("acct", "https://example.invalid/hook", async () => "tok", { maxResponseBytes: 16 })
  const app = createApp({ database: memoryDatabase(t), adapters: new Map([["hook", hook]]), platform: {
    allowed: () => true,
    launch: (_spec, connect) => withClient(connect, async client => {
      const call = client.callTool({ name: "post", arguments: { note: "hi" } })
      await until(() => app.human.inbox("alice").length === 1)
      const [{ id }] = app.human.inbox("alice")
      assert.equal((await app.human.approve("alice", id)).isError, true)
      assert.equal(app.human.review("alice", id).state, "sent")
      await refused(call, /^Delivered, /)
      return text("done")
    }),
  } })
  const revision = app.publish([cell("root", ["post"]), tool("post", { adapter: "hook" }, { inputSchema: object({ note: { type: "string" } }) })])
  assert.deepEqual(await app.start(request(revision)), text("done"))
})

test("a token no header can carry is refused in celler's words before anything is sent, and never echoed", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("ok"))
  for (const token of ["abc\r\nX-Injected: 1", "abc\0def", "abc€def", "abcédef", "abc def", ""]) {
    const adapter = postJson("acct", "https://example.invalid/hook", async () => token)
    await assert.rejects(adapter.send({}, await adapter.prepare({}, {}), "k"), { name: "CellerError", message: "Invalid authorization token" })
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test("a refused delivery's response body is cancelled, not left holding its connection", async t => {
  let cancelled = false
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(16)) }, cancel() { cancelled = true } })
  t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 500 }))
  const adapter = postJson("acct", "https://example.invalid/hook", async () => "tok")
  await assert.rejects(adapter.send({}, await adapter.prepare({}, {}), "k"), /needs checking: 500/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
})
