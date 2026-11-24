import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { CallToolResultSchema, CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { createApp } from "celler"
import { appLimits } from "../dist/limits.js"
import { cell, memoryDatabase, object, refused, request, text, tool, withClient } from "./support.mjs"
import { packet, pending } from "./support-approval.mjs"

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

test("a task is kept no longer than the app keeps one, whatever ttl its client asks, and a connection holds only so many", async t => {
  const warnings = []
  const warned = warning => { if (warning.name === "TimeoutOverflowWarning") warnings.push(warning.message) }
  process.on("warning", warned)
  t.after(() => process.off("warning", warned))
  let release
  const gate = new Promise(resolve => { release = resolve })
  const app = createApp({ database: memoryDatabase(t), maxTasks: 2, adapters: new Map([["slow", { call: async () => { await gate; return text("ok") } }]]), platform: {
    allowed: () => true,
    launch: (_spec, connect) => withClient(connect, async client => {
      const asTask = task => client.request({ method: "tools/call", params: { name: "slow", arguments: {}, task } }, CreateTaskResultSchema)
      assert.equal((await asTask({})).task.ttl, appLimits.taskTtlMs)
      // Longer than a timer takes: the app's own ttl, so it is still there a moment later.
      const long = (await asTask({ ttl: 2 ** 31 })).task
      assert.equal(long.ttl, appLimits.taskTtlMs)
      await delay(20)
      assert.equal((await client.experimental.tasks.getTask(long.taskId)).status, "working")
      await assert.rejects(asTask({ ttl: 1000 }), /Too many tasks/)
      release()
      assert.deepEqual((await client.experimental.tasks.getTaskResult(long.taskId, CallToolResultSchema)).content, text("ok").content)
      return text("done")
    }),
  } })
  assert.deepEqual(await app.start(request(app.publish([cell("root", ["slow"]), tool("slow", { adapter: "slow" })]))), text("done"))
  await delay(10)
  assert.deepEqual(warnings, [])
})
