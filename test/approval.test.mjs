import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { createApp } from "celler"
import { cell, memoryDatabase, object, refused, request, text, tool, until, withClient } from "./support.mjs"
import { graph, packet, pending, use } from "./support-approval.mjs"

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

test("a packet made once its run's caller has ended is never left for a person", async t => {
  let preparing = false, release
  const gate = new Promise(resolve => { release = resolve })
  const app = createApp({ database: memoryDatabase(t), adapters: new Map([["delivery", {
    prepare: async (_run, args) => { preparing = true; await gate; return packet(String(args.message)) },
    send: async () => text("sent"),
  }]]), platform: {
    allowed: () => true,
    launch: (spec, connect, signal) => withClient(connect, async client => {
      if (spec.entry === "root") {
        client.callTool({ name: "helper", arguments: {} }).catch(() => {})
        await until(() => preparing)
        return text("finished while its child prepares")
      }
      use(client, "k").catch(() => {})
      await delay(60_000, undefined, { signal }).catch(() => {})
      await delay(30) // an agent that takes a moment to stop
      return text("child stopped")
    }),
  } })
  const revision = app.publish([cell("root", ["helper"]), tool("helper", { cell: "child" }), cell("child", ["send"]),
    tool("send", { adapter: "delivery" }, { inputSchema: object({ message: { type: "string" } }) })])
  assert.deepEqual(await app.start(request(revision)), text("finished while its child prepares"))
  release()
  await delay(100)
  assert.deepEqual(app.human.inbox("alice"), [])
})
