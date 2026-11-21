import assert from "node:assert/strict"
import test from "node:test"
import { createApp } from "celler"
import { cell, discover, memoryDatabase, object, refused, request, text, tool, until, withClient } from "./support.mjs"

test("publication validates every edge including delegation targets", t => {
  const database = memoryDatabase(t)
  const app = createApp({ database, adapters: new Map([["ok", { call: async () => text("ok") }]]), platform: {} })
  assert.throws(() => app.publish([cell("a", ["missing"])]), /Unknown node/)
  assert.throws(() => app.publish([cell("a", ["b"]), cell("b", ["a"])]), /Cycle/)
  assert.throws(() => app.publish([cell("a", ["go"]), tool("go", { cell: "a" })]), /Cycle/)
  assert.throws(() => app.publish([cell("a", [], { pins: ["bogus"] })]), /Invalid pin/)
  assert.throws(() => app.publish([cell("a", ["t"], { pins: ["t", "t"] }), tool("t", { adapter: "ok" })]), /Duplicate pin/)
  assert.throws(() => app.publish([tool("t", { adapter: "absent" })]), /Unknown adapter/)
  // A schema it can't compile is refused by the tool's ID, so a host can leave that one out.
  const unresolved = { inputSchema: { type: "object", properties: { x: { $ref: "#/nowhere" } } } }
  assert.throws(() => app.publish([cell("a", ["t"]), tool("t", { adapter: "ok" }, unresolved)]), /Invalid JSON Schema in t:/)
  assert.throws(() => app.publish([cell("discover", [])]), /Reserved node ID/)
  assert.ok(app.publish([cell("a", ["t"]), tool("t", { adapter: "ok" }, { execution: { taskSupport: "required" } })]))
  // A cell without a profile can be exported but not delegated to.
  const group = { kind: "cell", id: "grp", title: "Group", exports: ["t"] }
  assert.ok(app.publish([cell("a", ["grp"]), group, tool("t", { adapter: "ok" })]))
  assert.throws(() => app.publish([cell("a", ["go"]), tool("go", { cell: "grp" }), group, tool("t", { adapter: "ok" })]), /launch profile/)
  // Optional undefined fields are accepted; non-JSON values are rejected.
  assert.ok(app.publish([cell("a", [], { description: undefined })]))
  assert.throws(() => app.publish([cell("a", [], { title: NaN })]), /valid JSON/)
})

test("adapters are the host's own map, read live: one added after createApp serves what is published after", async t => {
  const database = memoryDatabase(t)
  const adapters = new Map()
  const platform = {
    allowed: () => true,
    launch: (_spec, connect) => withClient(connect, client => client.callTool({ name: "late", arguments: {} })),
  }
  const app = createApp({ database, adapters, platform })
  const graph = [cell("desk", ["late"]), tool("late", { adapter: "later" })]
  assert.throws(() => app.publish(graph), /Unknown adapter/)
  adapters.set("later", { call: async () => text("here now") })
  const revision = app.publish(graph)
  assert.deepEqual(await app.start({ owner: "o", revision, entry: "desk", workspace: "/w", input: null }), text("here now"))
})

test("discovery, pinned grants and private delegation use the same published graph", async t => {
  const database = memoryDatabase(t)
  const denied = new Set(["later"])
  const content = [{ type: "text", text: "Private review instructions" }]
  const adapters = new Map([["read", {
    call: async (_run, args) => ({ ...text("record"), structuredContent: { sha256: args.record_id ?? "private" } }),
  }]])
  const inspect = tool("inspect", { adapter: "read" }, {
    name: "upstream_lookup", description: "Look up a record.",
    inputSchema: object({ record_id: { type: "string", description: "A catalogue accession" } }),
    outputSchema: object({ sha256: { type: "string" } }),
  })
  const records = [
    cell("root", ["left", "right", "review", "later"], { pins: ["inspect"], context: ["Root brief"] }),
    cell("left", ["inspect"]), cell("right", ["inspect"]), inspect,
    tool("review", { cell: "expert" }), cell("expert", ["private"], { context: content }),
    tool("private", { adapter: "read" }), tool("later", { adapter: "read" }),
  ]
  let app, childId, rootId
  const platform = {
    allowed: (_run, id) => !denied.has(id),
    launch: (spec, connect) => withClient(connect, async client => {
      if (spec.entry === "expert") {
        childId = spec.id
        assert.equal(spec.workspace, "folder")
        assert.equal(spec.parent.run, rootId)
        assert.deepEqual(spec.context, content)
        assert.deepEqual((await discover(client, {})).items.map(x => x.id), ["private"])
        return client.callTool({ name: "invoke", arguments: { name: "private" } })
      }
      rootId = spec.id
      denied.delete("later")
      assert.deepEqual(spec.context, ["Root brief"])
      const names = (await client.listTools()).tools.map(x => x.name)
      assert.deepEqual(names, ["inspect", "discover", "invoke"])
      const result = await discover(client, { query: "sha256" })
      assert.equal(result.items.length, 1)
      assert.deepEqual(result.items[0].parents.map(x => x.id).sort(), ["left", "right"])
      assert.deepEqual(result.items[0].inputs, [{ name: "record_id", type: "string", required: true }])
      assert.deepEqual(result.items[0].outputs, [{ name: "sha256", type: "string", required: true }])
      assert.equal((await discover(client, { query: "accession" })).items[0].id, "inspect")
      const [full] = await discover(client, { within: "left", refs: ["inspect"] })
      assert.equal(full.inputSchema.properties.record_id.description, "A catalogue accession")
      assert.deepEqual(full.outputSchema, inspect.definition.outputSchema)
      assert.deepEqual((await discover(client, { query: "later" })).items, [])
      await assert.rejects(discover(client, { refs: ["private"] }))
      await assert.rejects(client.callTool({ name: "review", arguments: {} }))
      await refused(client.callTool({ name: "inspect", arguments: { record_id: false } }), /record_id must be string/)
      const good = await client.callTool({ name: "inspect", arguments: { record_id: "A7" } })
      assert.deepEqual(good.structuredContent, { sha256: "A7" })
      denied.add("inspect")
      await refused(client.callTool({ name: "inspect", arguments: { record_id: "A7" } }), /outside this run/)
      return client.callTool({ name: "invoke", arguments: { name: "review" } })
    }),
  }
  app = createApp({ database, platform, adapters, discoveryBytes: 0 })
  const revision = app.publish(records)
  records[0].context[0] = "Subsequent edit"
  const output = await app.start(request(revision))
  assert.deepEqual(output.structuredContent, { sha256: "private" })
  assert.equal(app.history("alice", childId).at(-1).kind, "ended")
  assert.throws(() => app.history("bob", rootId), /Unknown run/)
})

test("small matches carry complete definitions and the server checks declared outputs", async t => {
  const database = memoryDatabase(t)
  const app = createApp({
    database,
    adapters: new Map([["broken", { call: async () => text("missing output") }]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) => withClient(connect, async client => {
        const match = (await discover(client, { query: "sample" })).items[0]
        assert.deepEqual(match.definition.outputSchema.required, ["key"])
        await refused(client.callTool({ name: "sample", arguments: {} }), /structured output/)
        return text("done")
      }),
    },
  })
  const revision = app.publish([cell("root", ["sample"]), tool("sample", { adapter: "broken" }, {
    outputSchema: object({ key: { type: "string" } }),
  })])
  await app.start(request(revision))
})

test("a connection given the menu keeps it when what it may use shrinks, so the model's invoke calls keep working", async t => {
  const database = memoryDatabase(t)
  const revoked = new Set()
  const app = createApp({
    database,
    // Both tools listed in full are more than this; the small one alone fits.
    discoveryBytes: 600,
    adapters: new Map([["ok", { call: async () => text("ok") }]]),
    platform: {
      allowed: (_run, id) => !revoked.has(id),
      launch: (spec, connect) => withClient(connect, async client => {
        const names = async c => (await c.listTools()).tools.map(x => x.name)
        assert.deepEqual(await names(client), ["discover", "invoke"])
        revoked.add("big")
        await app.notifyToolsChanged(spec.id)
        assert.deepEqual(await names(client), ["discover", "invoke"])
        // A new connection, with the small one only, is given it in full.
        await withClient((ch, n) => app.reconnect("alice", spec.id, ch, n), async fresh => {
          assert.deepEqual(await names(fresh), ["small", "discover"])
        })
        return text("done")
      }),
    },
  })
  const revision = app.publish([cell("root", ["small", "big"]),
    tool("small", { adapter: "ok" }),
    tool("big", { adapter: "ok" }, { description: "x".repeat(2_000) })])
  assert.deepEqual(await app.start(request(revision)), text("done"))
})

test("cell-scoped policies, BFS order, pagination, nativeDiscovery, limits, and MCP error sanitization", async t => {
  const database = memoryDatabase(t)
  let releaseSlow
  const slowDone = new Promise(resolve => { releaseSlow = resolve })
  const adapters = new Map([
    ["ok", { call: async () => text("ok") }],
    ["secretFail", { call: async () => { throw Error("postgres://user:supersecret@10.0.0.5/db") } }],
    ["slow", { call: async () => { await slowDone; return text("done") } }],
  ])
  const nodes = [
    cell("root", ["first", "second", "delegate", "leak", "slowTool"], { pins: ["t1"] }),
    { kind: "cell", id: "first", title: "First", exports: ["t1", "t2", "t3"] },
    { kind: "cell", id: "second", title: "Second", exports: ["t4", "t5", "t6"] },
    tool("t1", { adapter: "ok" }, {
      description: "alpha", annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { mode: { enum: ["a", "b"] }, opt: { anyOf: [{ type: "string" }, { type: "null" }] } } },
    }),
    tool("t2", { adapter: "ok" }, { description: "alpha" }),
    tool("t3", { adapter: "ok" }, { description: "alpha" }),
    tool("t4", { adapter: "ok" }, { description: "alpha" }),
    tool("t5", { adapter: "ok" }, { description: "alpha" }),
    tool("t6", { adapter: "ok" }, { description: "alpha" }),
    tool("leak", { adapter: "secretFail" }),
    tool("slowTool", { adapter: "slow" }),
    tool("delegate", { cell: "child" }),
    cell("child", ["privateTool", "deeper", "t6"]),
    tool("privateTool", { adapter: "ok" }),
    tool("deeper", { cell: "grandchild" }),
    cell("grandchild", ["t1"]),
  ]
  let app
  const platform = {
    allowed: (run, id) => {
      if (id === "t6" && run.entry === "root") return false
      if (id === "privateTool") return run.entry === "child"
      return true
    },
    launch: (spec, connect) => withClient(connect, async client => {
      if (spec.entry === "child") {
        // Policy allows both here, but root could reach t6 and was denied it.
        assert.deepEqual(await client.callTool({ name: "invoke", arguments: { name: "privateTool" } }), text("ok"))
        await refused(client.callTool({ name: "invoke", arguments: { name: "t6" } }), /outside/)
        // maxDepth = 1 rejects grandchild delegation.
        await refused(client.callTool({ name: "invoke", arguments: { name: "deeper" } }), /depth/)
        return text("child-ok")
      }
      // With discoveryBytes = 0, results are compact cards, five a page, in BFS order.
      const page1 = await discover(client, { query: "alpha" })
      assert.deepEqual(page1.items.map(x => x.id), ["t1", "t2", "t3", "t4", "t5"])
      assert.equal(page1.next, null) // t6 was denied
      assert.deepEqual(page1.items[0].annotations, { readOnlyHint: true })
      assert.deepEqual(page1.items[0].inputs, [
        { name: "mode", type: "enum", required: false },
        { name: "opt", type: "string|null", required: false },
      ])
      const deduped = await discover(client, { refs: ["t1", "t1"] })
      assert.equal(deduped.length, 1)
      await assert.rejects(discover(client, { query: "x".repeat(300) }))
      await assert.rejects(client.callTool({ name: "t1", arguments: {}, _meta: { "celler/call-id": "" } }), /call-id/)
      // A raw adapter error never reaches the harness.
      const leaked = await refused(client.callTool({ name: "invoke", arguments: { name: "leak" } }), /Tool execution failed/)
      assert.ok(!/supersecret/.test(JSON.stringify(leaked)))
      // maxConcurrency = 1 refuses a second call while slowTool runs.
      const firstSlow = client.callTool({ name: "invoke", arguments: { name: "slowTool" } })
      await refused(client.callTool({ name: "t1", arguments: {} }), /concurrent/)
      releaseSlow()
      await firstSlow
      // Native discovery lists every tool directly, even with discoveryBytes = 0.
      await withClient((ch, n) => app.reconnect("alice", spec.id, ch, n), async nativeClient => {
        const names = (await nativeClient.listTools()).tools.map(x => x.name)
        assert.ok(names.includes("t5") && !names.includes("invoke"))
        // BFS order puts first's exports before second's exports.
        assert.ok(names.indexOf("t1") < names.indexOf("t4"))
      }, true)
      return client.callTool({ name: "invoke", arguments: { name: "delegate" } })
    }),
  }
  app = createApp({ database, platform, adapters, discoveryBytes: 0, maxDepth: 1, maxConcurrency: 1 })
  const revision = app.publish(nodes)
  assert.deepEqual(await app.start(request(revision)), text("child-ok"))
  // Retiring an unrelated adapter still lets historical revisions load and run other tools.
  const upgraded = createApp({
    database,
    adapters: new Map([["ok", adapters.get("ok")]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) => withClient(connect, async client => {
        assert.deepEqual(await client.callTool({ name: "t1", arguments: {} }), text("ok"))
        await refused(client.callTool({ name: "leak", arguments: {} }), /Adapter unavailable/)
        return text("upgraded-ok")
      }, true),
    },
  })
  assert.deepEqual(await upgraded.start(request(revision)), text("upgraded-ok"))
})

test("a delegation retry joins its running child, the tree has a run cap, and ending a run stops the tree", async t => {
  const database = memoryDatabase(t)
  let launches = 0, rootId, childId, releaseChild
  const childGate = new Promise(resolve => { releaseChild = resolve })
  const untilAborted = signal => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
  const work = (client, task, timeout = 5000) =>
    client.callTool({ name: "invoke", arguments: { name: "work", arguments: { task } } }, undefined, { timeout })
  const platform = {
    allowed: () => true,
    launch: (spec, connect, signal) => withClient(connect, async client => {
      if (spec.entry === "worker") {
        launches++
        childId = spec.id
        if (spec.input.task === "forever") await untilAborted(signal)
        await childGate
        return text("work done")
      }
      rootId = spec.id
      if (spec.input === "end-me") {
        work(client, "forever").catch(() => {})
        await untilAborted(signal)
      }
      // An ordinary client times out while the child works, then retries the same call: one child, one result.
      await assert.rejects(work(client, "report", 50), /timed out/)
      const retry = work(client, "report")
      // maxRuns = 2: the root and its running child fill this tree.
      await refused(work(client, "other"), /active runs/)
      releaseChild()
      assert.deepEqual(await retry, text("work done"))
      assert.equal(launches, 1)
      return text("root done")
    }),
  }
  const app = createApp({ database, platform, adapters: new Map(), discoveryBytes: 0, maxRuns: 2 })
  const revision = app.publish([
    cell("root", ["work"]), tool("work", { cell: "worker" }, { inputSchema: object({ task: { type: "string" } }) }), cell("worker", []),
  ])
  assert.deepEqual(await app.start(request(revision)), text("root done"))

  childId = undefined
  const ending = app.start({ ...request(revision), input: "end-me" })
  await until(() => childId)
  assert.throws(() => app.end("bob", rootId), /Unknown run/)
  // A process that knows the tree only from the database, as after a restart, still ends all of it.
  const ended = id => app.history("alice", id).find(event => event.kind === "ended")
  createApp({ database, platform, adapters: new Map() }).end("alice", rootId)
  assert.deepEqual(ended(childId).detail, { status: "cancelled", by: "host" })
  // The process that runs the tree also stops its work.
  app.end("alice", rootId)
  await assert.rejects(ending)
  assert.deepEqual(ended(rootId).detail, { status: "cancelled", by: "host" })
})

test("a delegated run is checked up its chain at each call: the parent's way to it revoked, the child's next call is refused", async t => {
  const database = memoryDatabase(t)
  let revoked = false
  const app = createApp({
    database,
    adapters: new Map([["ok", { call: async () => text("ok") }]]),
    platform: {
      // The root's delegation to the child, revoked while the child is at work.
      allowed: (run, id) => !(revoked && run.entry === "root" && id === "ask"),
      launch: (spec, connect) => withClient(connect, async client => {
        if (spec.entry === "root") return client.callTool({ name: "ask", arguments: {} })
        assert.deepEqual(await client.callTool({ name: "look", arguments: {} }), text("ok"))
        revoked = true
        await refused(client.callTool({ name: "look", arguments: {} }), /Delegation revoked/)
        return text("child done")
      }, true),
    },
  })
  const revision = app.publish([cell("root", ["ask"]), tool("ask", { cell: "child" }), cell("child", ["look"]), tool("look", { adapter: "ok" })])
  assert.deepEqual(await app.start(request(revision)), text("child done"))
})

test("a policy that throws reaches the agent only in celler's words, while listing or calling", async t => {
  const database = memoryDatabase(t)
  let broken = false
  const app = createApp({
    database,
    adapters: new Map([["ok", { call: async () => text("ok") }]]),
    platform: {
      allowed: () => {
        if (broken) throw Error("postgres://user:supersecret@10.0.0.5/db")
        return true
      },
      launch: (_spec, connect) => withClient(connect, async client => {
        assert.ok((await client.listTools()).tools.some(x => x.name === "look"))
        broken = true
        const heard = await client.callTool({ name: "look", arguments: {} })
        assert.deepEqual(heard, { isError: true, content: [{ type: "text", text: "Tool execution failed" }] })
        await assert.rejects(client.listTools(), error => /Tool listing failed/.test(error.message) && !/supersecret|10\.0\.0\.5/.test(error.message))
        return text("done")
      }, true),
    },
  })
  const revision = app.publish([cell("root", ["look"]), tool("look", { adapter: "ok" })])
  assert.deepEqual(await app.start(request(revision)), text("done"))
})

test("draft-07 schemas publish, the url format stays linear, and a call asks the policy only about its chain", async t => {
  const database = memoryDatabase(t)
  const groups = Array.from({ length: 20 }, (_, g) => cell("g" + g, Array.from({ length: 20 }, (_, i) => `t${g}_${i}`)))
  let asked = 0
  const app = createApp({ database, discoveryBytes: 0, adapters: new Map([["ok", { call: async () => text("ok") }]]),
    platform: {
      allowed: () => (asked++, true),
      launch: (_spec, connect) => withClient(connect, async client => {
        await client.listTools()
        asked = 0
        assert.deepEqual(await client.callTool({ name: "invoke", arguments: { name: "t7_3" } }), text("ok"))
        assert.ok(asked <= 3, "the policy was asked " + asked + " times")
        const legacy = args => client.callTool({ name: "invoke", arguments: { name: "legacy", arguments: args } })
        await refused(legacy({}), /must have required property 'q'/)
        assert.deepEqual(await legacy({ q: "x", link: "https://example.com/a" }), text("ok"))
        const started = performance.now()
        await refused(legacy({ q: "x", link: "https://" + "a".repeat(256 * 1024) }), /format/)
        assert.ok(performance.now() - started < 500)
        return text("done")
      }),
    } })
  const legacy = tool("legacy", { adapter: "ok" }, { inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#", type: "object", required: ["q"],
    properties: { q: { type: "string" }, link: { type: "string", format: "url" } },
  } })
  const tools = groups.flatMap(group => group.exports.map(id => tool(id, { adapter: "ok" })))
  const revision = app.publish([cell("root", ["legacy", ...groups.map(group => group.id)]), legacy, ...groups, ...tools])
  assert.deepEqual(await app.start(request(revision)), text("done"))
})
