import assert from "node:assert/strict"
import test from "node:test"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import { createApp } from "celler"
import { AgentRuntime, claudeAgent, codexAgent, harnessPlatform, SimulatedRuntime } from "celler/harness"
import { harnessLimits } from "../dist/limits.js"
import { claudeWords, codexHome, codexWords, desk, fakeClaude, fakeClaudeProgram, fakeCodex, github, host, inFolder, sentTo } from "./support-harness.mjs"

/** A tool that says back the text it was given, and its adapter. */
const echo = { call: async (_run, args) => ({ content: [{ type: "text", text: `echo: ${args.text}` }] }) }
const echoTool = { definition: { inputSchema: { type: "object", properties: { text: { type: "string" } } } }, target: { adapter: "echo" } }

test("a run of the published graph reaches its cell's tools through the harness, on the run's own MCP server", () => inFolder(async dir => {
  const ran = async (profile, agent, log) => {
    const runs = new Set()
    const runtime = run => (run.profile === profile ? new AgentRuntime(agent, host) : undefined)
    const { platform, app } = desk(runtime, { progress: run => runs.add(run.id) }, new Map([["echo", echo]]))
    const revision = app.publish([
      { kind: "cell", id: "desk", title: "Desk", profile, context: ["Be brief."], exports: ["echo"] },
      { kind: "tool", id: "echo", ...echoTool },
    ])
    try {
      const result = await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "Use echo" })
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.match(result.content[0].text, /echo: hi$/)
      assert.equal(result.structuredContent.ok, true)
      // The call went through celler: in the run's history.
      const [run] = runs
      assert.deepEqual(app.history("office", run).filter(e => e.kind === "call").map(e => e.detail.id), ["echo"])
      return sentTo(log)
    } finally {
      await platform.close()
    }
  }
  // Claude Code: the cell's context as its instructions, the run's server under the host's name with a token of its own.
  const claudeLog = path.join(dir, "claude.jsonl")
  const initialize = (await ran("claude", fakeClaude({ FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_TOOL: "echo" }), claudeLog)).find(e => e.what === "initialize").data
  assert.equal(initialize.appendSystemPrompt, "Be brief.")
  assert.match(initialize.mcpServers.office.headers.Authorization, /^Bearer \S+$/)
  // A call to it may wait for the person as long as celler lets it, not as long as the agent would on its own.
  assert.equal(initialize.mcpServers.office.timeout, harnessLimits.mcpCallMs)
  // Codex: the same, its token in a variable of its own.
  const codexLog = path.join(dir, "codex.jsonl")
  const exec = (await ran("codex", fakeCodex(codexHome, { FAKE_CODEX_LOG: codexLog, FAKE_CODEX_TOOL: "echo" }), codexLog)).find(e => e.what === "exec").data
  assert.match(exec.prompt, /^Be brief\.\n\n---\n\nUse echo$/)
  assert.match(exec.values.CELLER_VALUE_0, /^Bearer \S+$/)
  assert.match(exec.configs.find(c => c.startsWith("mcp_servers=")), new RegExp(`^mcp_servers=\\{ office = \\{ .*, tool_timeout_sec = ${harnessLimits.mcpCallMs / 1000} \\} \\}$`))
}))

test("an agent that searches its tools itself is given them all, and any other gets celler's menu", () => inFolder(async dir => {
  const listed = async nativeDiscovery => {
    const log = path.join(dir, `agent-${nativeDiscovery}.jsonl`)
    const platform = harnessPlatform({
      runtime: () => new AgentRuntime({ ...fakeClaude({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_TOOL: "echo" }), nativeDiscovery }, host),
      allowed: () => true,
      server: "office",
      spec: () => ({ prompt: "x", model: "", sessionId: "", resume: false, timeoutMs: 20_000 }),
    })
    // No listing fits in no bytes: a run without its own search gets the menu.
    const app = createApp({ database: new DatabaseSync(":memory:"), platform, adapters: new Map([["echo", echo]]), discoveryBytes: 0 })
    const revision = app.publish([
      { kind: "cell", id: "desk", title: "Desk", profile: "fake", exports: ["echo", "notes"], pins: ["echo"] },
      { kind: "tool", id: "echo", ...echoTool },
      { kind: "tool", id: "notes", ...echoTool },
    ])
    try {
      const result = await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "x" })
      assert.equal(result.isError, false, JSON.stringify(result))
      return sentTo(log).find(e => e.what === "tools/list").data
    } finally {
      await platform.close()
    }
  }
  assert.deepEqual(await listed(true), ["echo", "notes", "discover"])
  assert.deepEqual(await listed(false), ["echo", "discover", "invoke"])
  // Claude Code and Codex each search theirs; the simulated agent calls none.
  const claude = new AgentRuntime(claudeAgent({ claude: () => null, words: claudeWords }), host)
  const codex = new AgentRuntime(codexAgent({ codex: () => null, home: dir, words: codexWords }), host)
  assert.deepEqual([claude.nativeDiscovery, codex.nativeDiscovery, new SimulatedRuntime().nativeDiscovery], [true, true, undefined])
}))

test("a model-only decision gets no MCP server, not even the run's own", () => inFolder(async dir => {
  const log = path.join(dir, "agent.jsonl")
  const decision = () => ({ prompt: "Pick one", model: "", sessionId: "", resume: false, timeoutMs: 20_000, purpose: "inference", mcpServers: [github] })
  const { platform, app, revision } = desk(() => new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host), { spec: decision })
  try {
    const result = await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "x" })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(sentTo(log).find(e => e.what === "initialize").data.mcpServers, undefined)
  } finally {
    await platform.close()
  }
}))

test("what an agent asks before it acts reaches the host with the run it asks in, and with no one to ask it doesn't go ahead", () => inFolder(async dir => {
  const asked = []
  const reply = async ask => {
    const { platform, app, revision } = desk(() => new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl") }), host), ask ? { ask } : {})
    try {
      const result = await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "Test it" })
      assert.equal(result.isError, false, JSON.stringify(result))
      return result.content[0].text
    } finally {
      await platform.close()
    }
  }
  // The host answers it, for the run it came from.
  assert.match(await reply(async (run, q) => (asked.push([run.entry, q.title, q.tool]), { option: "allow" })), /Ran them\.$/)
  assert.deepEqual(asked, [["desk", "Run the tests", "Bash"]])
  // A host that asks no one: what the agent asks about doesn't happen.
  assert.match(await reply(undefined), /Didn't run them\.$/)
}))

test("each of a host's hooks is called on the object the host gave it on, so a host made of methods that read this works", () => inFolder(async dir => {
  // What each hook was called on.
  const calledOn = new Map()
  // The host's own objects, each hook a method that reads this: what marks its runs, how it finds each agent (Codex's
  // finds none here, and a health check asks it all the same), and its hooks for the harness.
  const marker = { client: { name: "host", version: "1.0.0" }, mark(env) { calledOn.set("mark", this); return { ...env, HOST_RUN: "1" } } }
  const claudeFinder = { words: claudeWords, program: fakeClaudeProgram, claude() { calledOn.set("claude", this); return this.program } }
  const codexFinder = { words: codexWords, home: codexHome, codex() { calledOn.set("codex", this); return null } }
  const office = {
    server: "office",
    answer: { option: "allow" },
    runtime() { calledOn.set("runtime", this); return new AgentRuntime(claudeAgent(claudeFinder), marker) },
    allowed() { calledOn.set("allowed", this); return true },
    spec(run) { calledOn.set("spec", this); return { prompt: String(run.input), model: "", sessionId: "", resume: false, timeoutMs: 20_000 } },
    started() { calledOn.set("started", this) },
    progress() { calledOn.set("progress", this) },
    async ask() { calledOn.set("ask", this); return this.answer },
    ended() { calledOn.set("ended", this) },
  }
  const platform = harnessPlatform(office)
  const app = createApp({ database: new DatabaseSync(":memory:"), platform, adapters: new Map() })
  const revision = app.publish([{ kind: "cell", id: "desk", title: "Desk", profile: "any", exports: [] }])
  try {
    const result = await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "Test it" })
    // The host's answer, which its ask read from it, reached the agent.
    assert.match(result.content[0].text, /Ran them\.$/)
    await new AgentRuntime(codexAgent(codexFinder), marker).health(false)
  } finally {
    await platform.close()
  }
  const givenOn = { runtime: office, allowed: office, spec: office, started: office, progress: office, ask: office, ended: office, mark: marker, claude: claudeFinder, codex: codexFinder }
  for (const [hook, object] of Object.entries(givenOn)) assert.equal(calledOn.get(hook), object, `${hook} wasn't called on the object it was given on`)
}))

test("cancellation while the host prepares a run prevents the agent from starting", () => inFolder(async dir => {
  const controller = new AbortController()
  let started = false
  const runtime = () => ({ run: () => {
    started = true
    throw new Error("cancelled run started")
  } })
  const preparing = () => {
    controller.abort()
    return { prompt: "x", model: "", sessionId: "", resume: false, timeoutMs: 20_000 }
  }
  const { platform, app, revision } = desk(runtime, { spec: preparing })
  try {
    await assert.rejects(app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "x" }, controller.signal), { name: "AbortError" })
    assert.equal(started, false)
  } finally {
    await platform.close()
  }
}))

test("an agent that can't start ends as a failed run, which the host hears", () => inFolder(async dir => {
  const { platform, app, revision, ended } = desk(() => ({ kind: "broken", health: async () => ({ ok: false, checkedAt: 0, detail: "" }), run: () => { throw new Error("could not start") } }))
  try {
    const result = await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "Go" })
    assert.deepEqual([result.isError, result.content[0].text], [true, "could not start"])
    assert.deepEqual(ended.map(r => [r.ok, r.error]), [[false, "could not start"]])
  } finally {
    await platform.close()
  }
}))

test("closing the platform stops the agents still going: their runs end failed, not cancelled, with what they ended with", () => inFolder(async dir => {
  let id
  // Closed once its agent is going.
  const d = desk(() => new SimulatedRuntime(), { started: run => { id = run.id; void d.platform.close() } })
  const result = await d.app.start({ owner: "office", revision: d.revision, entry: "desk", workspace: dir, input: "Wait" })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.cancelled, true)
  assert.deepEqual(d.ended.map(r => r.cancelled), [true])
  assert.equal(d.app.history("office", id).find(e => e.kind === "ended")?.detail.status, "failed")
}))

test("a platform closed while its MCP server opens starts no agent, and once closed it starts none again, nor opens its server", () => inFolder(async dir => {
  const started = []
  const runtime = {
    kind: "fake",
    health: async () => ({ ok: true, checkedAt: 0, detail: "" }),
    run: s => (started.push(s), { done: Promise.resolve({ ok: true, text: "Done", usage: {}, costUsd: 0, permissionDenials: [] }), cancel: () => undefined }),
  }
  // Each server it opens, counted.
  let opened = 0
  http.Server.prototype.listen = function (...args) {
    opened++
    return net.Server.prototype.listen.apply(this, args)
  }
  const platform = harnessPlatform({ runtime: () => runtime, allowed: () => true, server: "office", spec: () => ({ prompt: "x", model: "", sessionId: "", resume: false, timeoutMs: 20_000 }) })
  const run = { id: "r1", owner: "office", workspace: dir, context: [], profile: "any", input: "x" }
  try {
    // Closed while its server opens, before the run's agent starts.
    const launching = platform.launch(run, async () => undefined, new AbortController().signal)
    await platform.close()
    await assert.rejects(Promise.race([launching, delay(2_000).then(() => "still waiting")]), /The harness platform has closed/)
    // And after: at once, with no server opened again.
    await assert.rejects(platform.launch(run, async () => undefined, new AbortController().signal), /The harness platform has closed/)
    assert.deepEqual([started.length, opened], [0, 1])
  } finally {
    delete http.Server.prototype.listen
    await platform.close()
  }
}))

test("a run stopped through celler keeps no result there, and the host still hears what its agent ended with", () => inFolder(async dir => {
  const stop = new AbortController()
  // Stopped once its agent is going.
  const { platform, app, revision, ended } = desk(() => new SimulatedRuntime(), { started: () => stop.abort() })
  try {
    await assert.rejects(app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "Wait" }, stop.signal))
    assert.deepEqual(ended.map(r => r.cancelled), [true])
  } finally {
    await platform.close()
  }
}))

test("a host whose hook throws as the agent starts doesn't leave the agent working", () => inFolder(async dir => {
  let handle
  const simulated = new SimulatedRuntime()
  const runtime = { kind: "simulated", health: () => simulated.health(), run: (s, p) => (handle = simulated.run(s, p)) }
  const { platform, app, revision } = desk(() => runtime, { started: () => { throw new Error("The window is gone") } })
  try {
    await assert.rejects(app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "Go" }), /The window is gone/)
    assert.equal((await handle.done).cancelled, true)
  } finally {
    await platform.close()
  }
}))

test("a delegated run that fails tells the agent that called it so in celler's words, never its raw error, which the host hears", () => inFolder(async dir => {
  const log = path.join(dir, "agent.jsonl")
  const broken = { kind: "broken", health: async () => ({ ok: false, checkedAt: 0, detail: "" }), run: () => { throw new Error("ENOENT: /Users/someone/host/data.db") } }
  const { platform, app, ended } = desk(run => (run.profile === "desk" ? new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_TOOL: "helper" }), host) : broken))
  const revision = app.publish([
    { kind: "cell", id: "desk", title: "Desk", profile: "desk", exports: ["helper"] },
    { kind: "tool", id: "helper", target: { cell: "child" }, definition: { name: "helper", inputSchema: { type: "object", properties: { text: { type: "string" } } } } },
    { kind: "cell", id: "child", title: "Child", profile: "child", exports: [] },
  ])
  try {
    const result = await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "Ask the helper" })
    assert.match(result.content[0].text, /The delegated run failed$/)
    assert.doesNotMatch(result.content[0].text, /ENOENT/)
    assert.ok(ended.some(r => r.error === "ENOENT: /Users/someone/host/data.db"), JSON.stringify(ended))
  } finally {
    await platform.close()
  }
}))

test("a platform whose MCP server couldn't open tries again for the next run", () => inFolder(async dir => {
  // The next server to open fails, once.
  http.Server.prototype.listen = function () {
    delete http.Server.prototype.listen
    process.nextTick(() => this.emit("error", Object.assign(new Error("listen EADDRNOTAVAIL"), { code: "EADDRNOTAVAIL" })))
    return this
  }
  const { platform, app } = desk(() => new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl"), FAKE_CLAUDE_TOOL: "echo" }), host), {}, new Map([["echo", echo]]))
  const revision = app.publish([{ kind: "cell", id: "desk", title: "Desk", profile: "fake", exports: ["echo"] }, { kind: "tool", id: "echo", ...echoTool }])
  const start = () => app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "Use echo" })
  try {
    await assert.rejects(start(), /EADDRNOTAVAIL/)
    assert.match((await start()).content[0].text, /echo: hi$/)
  } finally {
    delete http.Server.prototype.listen
    await platform.close()
  }
}))

test("a cell's context reaches its agent as text, a resource's text too, and context with no text fails the run in celler's words", () => inFolder(async dir => {
  const log = path.join(dir, "agent.jsonl")
  const { platform, app } = desk(() => new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host))
  const deskWith = context => app.publish([{ kind: "cell", id: "desk", title: "Desk", profile: "any", exports: [], context }])
  const start = revision => app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "Go" })
  try {
    await start(deskWith(["Be brief.", { type: "resource", resource: { uri: "policy://mail", text: "Never email customers." } }]))
    assert.equal(sentTo(log).find(e => e.what === "initialize").data.appendSystemPrompt, "Be brief.\n\nNever email customers.")
    const image = await start(deskWith([{ type: "image", data: "AAAA", mimeType: "image/png" }]))
    assert.deepEqual([image.isError, image.content[0].text], [true, "A cell's context can't hold image content for an agent run by the harness: only text"])
  } finally {
    await platform.close()
  }
}))
