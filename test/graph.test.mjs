import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ErrorCode, McpError, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
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

test("a change to what runs may use is told to the connections of the run named, or of every run", async t => {
  const database = memoryDatabase(t)
  const heard = { first: 0, second: 0 }
  const runs = {}
  let release
  const going = new Promise(resolve => { release = resolve })
  const app = createApp({
    database,
    adapters: new Map([["ok", { call: async () => text("ok") }]]),
    platform: {
      allowed: () => true,
      launch: (spec, connect) => withClient(connect, async client => {
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => { heard[spec.input]++ })
        await client.listTools()
        runs[spec.input] = spec.id
        await going
        return text(spec.input)
      }),
    },
  })
  const revision = app.publish([cell("root", ["t1"]), tool("t1", { adapter: "ok" })])
  const first = app.start({ ...request(revision), input: "first" })
  const second = app.start({ ...request(revision), input: "second" })
  await until(() => runs.first && runs.second)
  await app.notifyToolsChanged(runs.first)
  await until(() => heard.first === 1)
  await delay(50)
  assert.equal(heard.second, 0)
  await app.notifyToolsChanged()
  await until(() => heard.first === 2 && heard.second === 1)
  release()
  assert.deepEqual([await first, await second], [text("first"), text("second")])
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

test("a policy that throws reaches the agent only in celler's words, while listing or calling, listed first or not", async t => {
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
      launch: (spec, connect) => withClient(connect, async client => {
        assert.ok((await client.listTools()).tools.some(x => x.name === "look"))
        broken = true
        const heard = await client.callTool({ name: "look", arguments: {} })
        assert.deepEqual(heard, { isError: true, content: [{ type: "text", text: "Tool execution failed" }] })
        const inCellerWords = error => /Tool listing failed/.test(error.message) && !/supersecret|10\.0\.0\.5/.test(error.message)
        await assert.rejects(client.listTools(), inCellerWords)
        // A new connection that calls a tool it knows without listing first, as one does after it starts a new session.
        await withClient((ch, n) => app.reconnect("alice", spec.id, ch, n), async fresh => {
          await assert.rejects(fresh.callTool({ name: "look", arguments: {} }), inCellerWords)
        }, true)
        return text("done")
      }, true),
    },
  })
  const revision = app.publish([cell("root", ["look"]), tool("look", { adapter: "ok" })])
  assert.deepEqual(await app.start(request(revision)), text("done"))
})

test("an adapter's own MCP error reaches the agent only in celler's words, as a result it can read", async t => {
  const database = memoryDatabase(t)
  const upstream = new McpError(ErrorCode.InternalError, "upstream db postgres://svc:hunter2@10.0.0.7/prod", { stack: "at secret.js:1" })
  const app = createApp({
    database,
    adapters: new Map([["upstream", { call: async () => { throw upstream } }]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) => withClient(connect, async client => {
        const heard = await client.callTool({ name: "look", arguments: {} })
        assert.deepEqual(heard, { isError: true, content: [{ type: "text", text: "Tool execution failed" }] })
        return text("done")
      }, true),
    },
  })
  const revision = app.publish([cell("root", ["look"]), tool("look", { adapter: "upstream" })])
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

test("a call its run's end cuts off hears that the run ended, never what its adapter threw as it stopped", async t => {
  const secret = "postgres://svc:hunter2@10.0.0.7/prod"
  let started = 0
  // As a database driver does: aborted, it rejects with its own words.
  const adapters = new Map([["db", { call: (_run, _args, signal) => new Promise((_resolve, reject) => {
    started++
    signal.addEventListener("abort", () => reject(Error(secret)), { once: true })
  }) }]])
  const graph = [cell("root", ["look"]), tool("look", { adapter: "db" })]
  const heardEnded = heard => {
    assert.equal(heard.isError, true, JSON.stringify(heard))
    assert.equal(heard.content[0].text, "Run has ended")
    assert.doesNotMatch(JSON.stringify(heard), /hunter2/)
  }

  // Ended by the host while the call waits.
  let app, heard
  app = createApp({ database: memoryDatabase(t), adapters, platform: {
    allowed: () => true,
    launch: (spec, connect) => withClient(connect, async client => {
      const call = client.callTool({ name: "look", arguments: {} })
      await until(() => started === 1)
      app.end("alice", spec.id)
      heard = await call
      return text("ended")
    }),
  } })
  await assert.rejects(app.start(request(app.publish(graph))))
  heardEnded(heard)

  // A run that finishes with the call still going, its connection kept a moment, as harnessPlatform keeps it.
  let late
  const finished = createApp({ database: memoryDatabase(t), adapters, platform: {
    allowed: () => true,
    launch: async (_spec, connect) => {
      const [local, remote] = InMemoryTransport.createLinkedPair()
      await connect(remote)
      const client = new Client({ name: "test-harness", version: "1" })
      await client.connect(local)
      late = client.callTool({ name: "look", arguments: {} }).finally(() => client.close())
      await until(() => started === 2)
      return text("finished")
    },
  } })
  assert.deepEqual(await finished.start(request(finished.publish(graph))), text("finished"))
  heardEnded(await late)

  // The database failing as a call begins, before any of its own work.
  const database = memoryDatabase(t)
  const broken = createApp({ database, adapters: new Map([["ok", { call: async () => text("ok") }]]), platform: {
    allowed: () => true,
    launch: (_spec, connect) => withClient(connect, async client => {
      await client.listTools()
      database.exec("ALTER TABLE runs RENAME TO runs_gone")
      const heard = await client.callTool({ name: "look", arguments: {} }).then(result => JSON.stringify(result), error => error.message)
      database.exec("ALTER TABLE runs_gone RENAME TO runs")
      assert.match(heard, /Tool execution failed/)
      assert.doesNotMatch(heard, /no such table|runs/)
      return text("done")
    }),
  } })
  assert.deepEqual(await broken.start(request(broken.publish([cell("root", ["look"]), tool("look", { adapter: "ok" })]))), text("done"))
})

test("a run's grants stop at a denied grouping cell, and a child gets nothing its caller was denied or lost before it delegated", async t => {
  const database = memoryDatabase(t)
  const called = []
  let revoked = false
  const app = createApp({ database, discoveryBytes: 0,
    adapters: new Map([["ok", { call: async run => { called.push(run.entry); return text("ok") } }]]),
    platform: {
      // The person turned off the whole group; later, "shared" for the root's own run alone.
      allowed: (run, id) => id !== "grp" && !(revoked && id === "shared" && run.parent === null),
      launch: (spec, connect) => withClient(connect, async client => {
        const invoke = name => client.callTool({ name: "invoke", arguments: { name } })
        if (spec.entry === "root") {
          await refused(invoke("grouped"), /outside this run/)
          assert.deepEqual(await invoke("shared"), text("ok"))
          revoked = true
          await refused(invoke("shared"), /outside this run/)
          return invoke("helper")
        }
        // The child exports both itself, and policy alone would let it use them.
        await refused(invoke("grouped"), /outside this run/)
        await refused(invoke("shared"), /outside this run/)
        return text("child done")
      }),
    } })
  const revision = app.publish([
    cell("root", ["grp", "shared", "helper"]), { kind: "cell", id: "grp", title: "Group", exports: ["grouped"] },
    tool("grouped", { adapter: "ok" }), tool("shared", { adapter: "ok" }),
    tool("helper", { cell: "child" }), cell("child", ["grouped", "shared"]),
  ])
  assert.deepEqual(await app.start(request(revision)), text("child done"))
  const grants = entry => JSON.parse(database.prepare("SELECT grants FROM runs WHERE json_extract(body, '$.entry')=?").get(entry).grants)
  assert.deepEqual(grants("root"), ["root", "shared", "helper"])
  assert.deepEqual(grants("child"), ["child"])
  assert.deepEqual(called, ["root"])
})

test("a delegation's call key reused with other arguments while its child runs is refused, not a second child", async t => {
  const children = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const app = createApp({ database: memoryDatabase(t), adapters: new Map(), platform: {
    allowed: () => true,
    launch: (spec, connect) => withClient(connect, async client => {
      if (spec.entry === "worker") {
        children.push(spec.input.task)
        await gate
        return text("did " + spec.input.task)
      }
      const work = task => client.callTool({ name: "work", arguments: { task }, _meta: { "celler/call-id": "same-key" } })
      const first = work("one")
      await until(() => children.length === 1)
      setTimeout(release, 100) // a second child, were there one, would finish too
      await refused(work("two"), /different arguments/)
      assert.deepEqual(await first, text("did one"))
      return text("root done")
    }),
  } })
  const revision = app.publish([cell("root", ["work"]),
    tool("work", { cell: "worker" }, { inputSchema: object({ task: { type: "string" } }) }), cell("worker", [])])
  assert.deepEqual(await app.start(request(revision)), text("root done"))
  assert.deepEqual(children, ["one"])
})

test("a connection that fails to start is forgotten: a change to the tools isn't sent to it", async t => {
  let runId, finish
  const app = createApp({ database: memoryDatabase(t), adapters: new Map(), platform: {
    allowed: () => true,
    launch: async spec => {
      runId = spec.id
      await new Promise(resolve => { finish = resolve })
      return text("done")
    },
  } })
  const running = app.start(request(app.publish([cell("root", [])])))
  await until(() => runId)
  const sent = []
  const broken = { start: async () => { throw Error("transport failed to start") }, send: async message => { sent.push(message) }, close: async () => {} }
  await assert.rejects(app.reconnect("alice", runId, broken), /failed to start/)
  await app.notifyToolsChanged(runId)
  await app.notifyToolsChanged()
  assert.deepEqual(sent, [])
  finish()
  assert.deepEqual(await running, text("done"))
})

test("a graph that doesn't parse, or a tool bound to a cell that declares its output, is refused in celler's words", t => {
  const app = createApp({ database: memoryDatabase(t), adapters: new Map(), platform: {} })
  assert.throws(() => app.publish([{ kind: "cell", id: "a" }]),
    error => error.name === "CellerError" && error.code === "INVALID_CONFIG" && /title/.test(error.message))
  // A delegated run answers in text, so no structured output could ever pass.
  assert.throws(() => app.publish([cell("a", ["go"]), tool("go", { cell: "b" }, { outputSchema: object({ id: { type: "string" } }) }), cell("b", [])]),
    error => error.code === "INVALID_CONFIG" && /outputSchema/.test(error.message))
})

test("discover looks inside cells only: a tool named as within is the model's mistake to fix", async t => {
  const app = createApp({ database: memoryDatabase(t), adapters: new Map([["ok", { call: async () => text("ok") }]]), platform: {
    allowed: () => true,
    launch: (_spec, connect) => withClient(connect, async client => {
      await refused(client.callTool({ name: "discover", arguments: { within: "t" } }), /Expected a cell in within: t/)
      return text("done")
    }),
  } })
  assert.deepEqual(await app.start(request(app.publish([cell("root", ["t"]), tool("t", { adapter: "ok" })]))), text("done"))
})

test("a result or a start input over the inline limit is refused, and JSON nested past its bound is invalid, never a stack overflow", async t => {
  const big = "x".repeat(10_000)
  const app = createApp({ database: memoryDatabase(t), inlineLimit: 1024, adapters: new Map([["big", { call: async () => text(big) }]]), platform: {
    allowed: () => true,
    launch: (_spec, connect) => withClient(connect, async client => {
      await refused(client.callTool({ name: "look", arguments: {} }), /inline limit/)
      return text("done")
    }),
  } })
  const revision = app.publish([cell("root", ["look"]), tool("look", { adapter: "big" })])
  assert.deepEqual(await app.start(request(revision)), text("done"))
  await assert.rejects(app.start({ ...request(revision), input: big }), { name: "CellerError", code: "LIMIT_EXCEEDED" })
  let deep = {}
  for (let i = 0; i < 20_000; i++) deep = { a: deep }
  await assert.rejects(app.start({ ...request(revision), input: deep }), { name: "CellerError", code: "INVALID_ARGS" })
})

test("a call asks the policy about each node on its chain once, where the chain splits and joins again too", async t => {
  let denying = false
  const asked = []
  const app = createApp({ database: memoryDatabase(t), adapters: new Map([["ok", { call: async () => text("ok") }]]), platform: {
    allowed: (_run, id) => {
      if (denying) asked.push(id)
      return !(denying && id === "d")
    },
    launch: (_spec, connect) => withClient(connect, async client => {
      await client.listTools()
      denying = true
      await refused(client.callTool({ name: "t", arguments: {} }), /outside this run/)
      return text("done")
    }, true),
  } })
  const group = (id, exports) => ({ kind: "cell", id, title: id, exports })
  const revision = app.publish([cell("root", ["d"]), group("d", ["a", "b", "c"]),
    group("a", ["t"]), group("b", ["t"]), group("c", ["t"]), tool("t", { adapter: "ok" })])
  assert.deepEqual(await app.start(request(revision)), text("done"))
  assert.deepEqual(asked, ["t", "a", "d", "b", "c"])
})

test("the app's limits are the host's to set by name, the discover tool's own bounds and the database's wait too", async t => {
  const database = memoryDatabase(t)
  const graph = [cell("root", ["t1", "t2", "t3"]), ...["t1", "t2", "t3"].map(id => tool(id, { adapter: "ok" }, { inputSchema: object({ n: { type: "number" } }) }))]
  const app = createApp({
    database, discoveryBytes: 0, discoveryPageSize: 2, discoveryQueryChars: 8, callIdChars: 4, argsErrorChars: 12, busyTimeoutMs: 250,
    adapters: new Map([["ok", { call: async () => text("ok") }]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) => withClient(connect, async client => {
        const page = await discover(client, {})
        assert.deepEqual([page.items.length, page.next], [2, 2])
        await assert.rejects(discover(client, { query: "x".repeat(9) }), /discover arguments/)
        await assert.rejects(client.callTool({ name: "invoke", arguments: { name: "t1" }, _meta: { "celler/call-id": "12345" } }), /call-id/)
        const heard = await refused(client.callTool({ name: "invoke", arguments: { name: "t1", arguments: { n: "x" } } }), /^Invalid arguments for t1: /)
        assert.equal(heard.content[0].text.length, "Invalid arguments for t1: ".length + 12)
        return text("done")
      }),
    },
  })
  assert.deepEqual(await app.start(request(app.publish(graph))), text("done"))
  assert.equal(database.prepare("PRAGMA busy_timeout").get().timeout, 250)
  assert.throws(() => createApp({ database, platform: {}, adapters: new Map(), maxTasks: 0 }), /Invalid maxTasks/)
})
