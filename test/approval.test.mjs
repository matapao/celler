import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { CallToolResultSchema, CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { createApp } from "celler"
import { cell, memoryDatabase, object, refused, request, text, tool, until, withClient } from "./support.mjs"

const packet = value => ({
  account: "test", destination: "outbox", operation: "deliver", content: { message: value },
  files: [{ name: "data.txt", mediaType: "text/plain", base64: Buffer.from(value).toString("base64") }],
})
const graph = [cell("root", ["send"]), tool("send", { adapter: "delivery" }, { inputSchema: object({ message: { type: "string" } }) })]
const use = (client, key, message = "review me") => client.callTool({
  name: "send", arguments: { message }, _meta: { "celler/call-id": key },
})

async function pending(app) {
  const timeout = AbortSignal.timeout(4000)
  for (;;) {
    const item = app.human.inbox("alice").find(row => row.state === "pending")
    if (item) return item.id
    await delay(5, undefined, { signal: timeout })
  }
}

test("approval binds destination and bytes, survives a reconnect, and delivers once", async t => {
  const database = memoryDatabase(t)
  let allowed = true, runId, attachment = "original"
  const sent = []
  const delivery = {
    prepare: async () => packet(attachment),
    send: async (_run, write, key) => {
      sent.push({ write, key })
      return text("delivered")
    },
  }
  const app = createApp({ database, adapters: new Map([["delivery", delivery]]), platform: {
    allowed: (_run, id) => id !== "send" || allowed,
    launch: (spec, connect) => withClient(connect, async client => {
      runId = spec.id
      const first = use(client, "logical-call")
      const retry = use(client, "logical-call")
      const id = await pending(app)
      attachment = "edited"
      const preview = app.human.review("alice", id)
      assert.deepEqual(preview.write, packet("original"))
      assert.deepEqual(app.human.inbox("bob"), [])
      await assert.rejects(app.human.approve("bob", id), /Unknown approval/)
      await refused(use(client, "logical-call", "changed"), /different arguments/)
      allowed = false
      await assert.rejects(app.human.approve("alice", id), /outside/)
      allowed = true
      assert.equal(sent.length, 0)
      const sending = app.human.approve("alice", id)
      await assert.rejects(app.human.approve("alice", id), /not pending/)
      await sending
      assert.deepEqual(await first, await retry)
      assert.deepEqual(sent, [{ write: preview.write, key: id }])
      const deniedCall = use(client, "second-call")
      const denyResult = refused(deniedCall, /declined/)
      app.human.decline("alice", await pending(app))
      await denyResult
      return text("completed")
    }),
  } })
  await app.start(request(app.publish(graph)))
  await withClient(channel => app.reconnect("alice", runId, channel), async client => {
    assert.deepEqual(await use(client, "logical-call"), text("delivered"))
    await refused(use(client, "new-call"), /Run has ended/)
  })
  assert.throws(() => app.reconnect("bob", runId, {}), /Unknown run/)
  assert.equal(sent.length, 1)
})

test("a service restart preserves pending packets and never replays an interrupted delivery", async t => {
  const dir = mkdtempSync(join(tmpdir(), "celler-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, "state.sqlite")
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/interrupt.mjs", import.meta.url)), file],
    { timeout: 10000, encoding: "utf8" })
  assert.equal(child.status, 49, child.stderr)
  const database = new DatabaseSync(file)
  t.after(() => database.close())
  const sent = []
  const app = createApp({ database, platform: { allowed: () => true }, adapters: new Map([["delivery", {
    prepare: async () => { throw Error("A restart must use the stored packet") },
    send: async (_run, write) => { sent.push(write); return text("sent") },
  }]]) })
  const inbox = app.human.inbox("alice")
  const interrupted = inbox.find(row => row.state === "unknown")
  const pending = inbox.find(row => row.state === "pending")
  await assert.rejects(app.human.approve("alice", interrupted.id), /not pending/)
  await app.human.approve("alice", pending.id)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].content.message, "second")
  // The host settles the interrupted delivery once it has checked the destination.
  assert.throws(() => app.human.reconcile("alice", pending.id, "sent"), /not unknown/)
  app.human.reconcile("alice", interrupted.id, "sent")
  assert.equal(app.human.review("alice", interrupted.id).state, "sent")
  assert.deepEqual(app.human.inbox("alice"), [])
})

test("deduplicates concurrent prepare, protects pre-send verify, blocks cancelled runs, enforces quotas and emits progress", async t => {
  const database = memoryDatabase(t)
  let prepares = 0, verifyPass = false, progressTicks = 0
  let releasePrepare
  const prepareGate = new Promise(resolve => { releasePrepare = resolve })
  const delivery = {
    async prepare(_run, args) {
      prepares++
      if (args.message === "slow") await prepareGate
      return packet(String(args.message))
    },
    verify() {
      if (!verifyPass) throw Error("packet rejected before send")
    },
    async send() { return text("ok") },
  }
  const app = createApp({
    database,
    maxPendingApprovals: 2,
    progressIntervalMs: 15,
    adapters: new Map([["delivery", delivery]]),
    platform: {
      allowed: () => true,
      launch: (spec, connect, signal) => withClient(connect, async client => {
        if (spec.input === "cancel-me") {
          const call = use(client, "c1", "before-cancel")
          call.catch(() => {})
          await pending(app)
          await delay(500, undefined, { signal })
          return text("never")
        }
        // Concurrent retries with the same call-id invoke prepare() only once.
        const p1 = use(client, "dup", "slow")
        const p2 = use(client, "dup", "slow")
        await delay(10)
        releasePrepare()
        const id = await pending(app)
        assert.equal(prepares, 1)

        // A verify() refusal leaves the approval pending, not unknown.
        await assert.rejects(app.human.approve("alice", id), /rejected before send/)
        assert.equal(app.human.review("alice", id).state, "pending")
        verifyPass = true

        // A call with a progressToken gets heartbeats while it waits.
        const waited = client.callTool(
          { name: "send", arguments: { message: "hb" }, _meta: { "celler/call-id": "hb-key" } },
          undefined,
          { onprogress: () => { progressTicks++ } },
        )
        // A third pending approval is over maxPendingApprovals = 2.
        await delay(40)
        await refused(use(client, "over-quota", "third"), /limit reached/)
        assert.ok(progressTicks >= 1)

        await app.human.approve("alice", id)
        assert.deepEqual(await p1, text("ok"))
        assert.deepEqual(await p2, text("ok"))
        const hbItem = app.human.inbox("alice").find(row => row.state === "pending")
        await app.human.approve("alice", hbItem.id)
        assert.deepEqual(await waited, text("ok"))
        return text("done")
      }),
    },
  })
  const rev = app.publish(graph)
  assert.deepEqual(await app.start(request(rev)), text("done"))

  // Cancelled runs cannot have their staged approvals approved.
  const controller = new AbortController()
  const running = app.start({ ...request(rev), input: "cancel-me" }, controller.signal)
  const cancelledId = await pending(app)
  controller.abort()
  await assert.rejects(running)
  const item = app.human.inbox("alice").find(row => row.id === cancelledId)
  assert.equal(item.runStatus, "cancelled")
  assert.ok(item.createdAt > 0)
  await assert.rejects(app.human.approve("alice", cancelledId), /cancelled/)
  app.human.decline("alice", cancelledId)

  // Aborting a call while prepare() is still running leaves no orphan approval in SQLite.
  let releaseOrphan, prepareAborted = false
  const orphanGate = new Promise(resolve => { releaseOrphan = resolve })
  const app2 = createApp({
    database,
    adapters: new Map([["delivery", {
      async prepare(_run, _args, sig) {
        sig?.addEventListener("abort", () => { prepareAborted = true }, { once: true })
        await orphanGate
        return packet("orphan")
      },
      async send() { return text("ok") },
    }]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) => withClient(connect, async client => {
        const ac = new AbortController()
        const call = client.callTool(
          { name: "send", arguments: { message: "abort-me" }, _meta: { "celler/call-id": "orphan-key" } },
          undefined, { signal: ac.signal },
        )
        await delay(10)
        ac.abort()
        await assert.rejects(call)
        releaseOrphan()
        await delay(10)
        return text("clean")
      }),
    },
  })
  assert.deepEqual(await app2.start(request(rev)), text("clean"))
  assert.equal(prepareAborted, true)
  assert.equal(app2.human.inbox("alice").length, 0)
})

test("blind retries join their approval, a retry right after a timeout works, and a delivery keeps its receipt", async t => {
  const database = memoryDatabase(t)
  const sent = []
  const app = createApp({ database, adapters: new Map([["delivery", {
    async prepare(_run, args, signal) {
      if (args.message === "slow") await delay(300, undefined, { signal })
      return packet(String(args.message))
    },
    send: async (_run, write) => { sent.push(write); return text("delivered without structured content") },
  }]]), platform: {
    allowed: () => true,
    launch: (_spec, connect) => withClient(connect, async client => {
      // An ordinary client: no celler/call-id, a timeout shorter than the person, and a retry. -0 must not break it.
      const blind = () => client.callTool({ name: "send", arguments: { message: "once", n: -0 } }, undefined, { timeout: 100 })
      await assert.rejects(blind(), /timed out/)
      await assert.rejects(blind(), /timed out/)
      assert.equal(app.human.inbox("alice").length, 1)
      // The documented retry contract, right after a timeout that hit while prepare() was still running.
      const keyed = timeout => client.callTool(
        { name: "send", arguments: { message: "slow" }, _meta: { "celler/call-id": "k1" } }, undefined, { timeout })
      await assert.rejects(keyed(50), /timed out/)
      const retried = keyed(5000)
      await until(() => app.human.inbox("alice").length >= 2)
      // A response that fails the output schema still leaves the delivery recorded as sent.
      for (const item of app.human.inbox("alice")) {
        await assert.rejects(app.human.approve("alice", item.id), /structured output/)
        assert.equal(app.human.review("alice", item.id).state, "sent")
      }
      await refused(retried, /structured output/)
      assert.equal(sent.length, 2)
      return text("done")
    }),
  } })
  const revision = app.publish([cell("root", ["send"]), tool("send", { adapter: "delivery" }, {
    inputSchema: { type: "object", required: ["message"], additionalProperties: false,
      properties: { message: { type: "string" }, n: { type: "number" } } },
    outputSchema: object({ id: { type: "string" } }),
  })])
  assert.deepEqual(await app.start(request(revision)), text("done"))
})

test("a send that throws leaves its delivery unknown: the agent hears celler's words, it is never offered again, and the host settles it", async t => {
  const database = memoryDatabase(t)
  let sends = 0
  const app = createApp({ database, adapters: new Map([
    ["delivery", { prepare: async (_run, args) => packet(String(args.message)), send: async () => { sends++; throw Error("socket hang up at 10.0.0.5") } }],
  ]), platform: {
    allowed: () => true,
    launch: (_spec, connect) => withClient(connect, async client => {
      const call = use(client, "k-throws")
      const id = await pending(app)
      // The host's own adapter failed: the host hears why.
      await assert.rejects(app.human.approve("alice", id), /socket hang up/)
      // The agent hears only that it may or may not have arrived.
      const heard = await call
      assert.equal(heard.isError, true)
      assert.match(heard.content[0].text, /Delivery outcome unknown until the host reconciles it/)
      assert.doesNotMatch(heard.content[0].text, /socket|10\.0\.0\.5/)
      // Never offered again, so never sent twice; the host settles it from what it found at the destination.
      assert.equal(app.human.inbox("alice").find(row => row.id === id).state, "unknown")
      await assert.rejects(app.human.approve("alice", id), /not pending/)
      app.human.reconcile("alice", id, "failed")
      assert.equal(app.human.inbox("alice").some(row => row.id === id), false)
      assert.equal(sends, 1)
      return text("done")
    }),
  } })
  const revision = app.publish(graph)
  assert.deepEqual(await app.start(request(revision)), text("done"))
})

test("a task-capable client gets a task handle, collects the approved result, and can cancel the task", async t => {
  const database = memoryDatabase(t)
  const app = createApp({ database, adapters: new Map([
    ["delivery", { prepare: async (_run, args) => packet(String(args.message)), send: async () => text("sent") }],
    ["quick", { call: async () => text("quick") }],
  ]), platform: {
    allowed: () => true,
    launch: (_spec, connect) => withClient(connect, async client => {
      const tasks = client.experimental.tasks
      // A task is kept this long after it is made, and its timer holds the test's process until then: long enough for
      // the test, no longer.
      const asTask = (name, args) => client.request(
        { method: "tools/call", params: { name, arguments: args, task: { ttl: 5_000 } } }, CreateTaskResultSchema)
      const { task } = await asTask("send", { message: "as a task" })
      assert.equal(task.status, "working")
      await app.human.approve("alice", await pending(app))
      assert.deepEqual((await tasks.getTaskResult(task.taskId, CallToolResultSchema)).content, text("sent").content)
      // Cancelling a task stops its work. The approval it staged stays for the person to decline.
      const cancelled = (await asTask("send", { message: "cancel me" })).task
      const staged = await pending(app)
      await tasks.cancelTask(cancelled.taskId)
      assert.equal((await tasks.getTask(cancelled.taskId)).status, "cancelled")
      app.human.decline("alice", staged)
      // A task-only tool refuses a plain call and runs as a task.
      await refused(client.callTool({ name: "slow", arguments: {} }), /as a task/)
      const slow = (await asTask("slow", {})).task
      assert.deepEqual((await tasks.getTaskResult(slow.taskId, CallToolResultSchema)).content, text("quick").content)
      return text("done")
    }),
  } })
  const revision = app.publish([cell("root", ["send", "slow"]),
    tool("send", { adapter: "delivery" }, { inputSchema: object({ message: { type: "string" } }) }),
    tool("slow", { adapter: "quick" }, { execution: { taskSupport: "required" } })])
  assert.deepEqual(await app.start(request(revision)), text("done"))
})
