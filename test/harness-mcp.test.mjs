import assert from "node:assert/strict"
import test from "node:test"
import net from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CallToolResultSchema, CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { callThenClose, until } from "./support.mjs"
import { desk, inFolder } from "./support-harness.mjs"

/** The status line a server answers a raw HTTP request with, or "" when it says nothing within 2 s. */
const statusOf = (url, request) => new Promise(resolve => {
  const { hostname, port } = new URL(url)
  let said = ""
  const socket = net.connect(Number(port), hostname, () => socket.write(request))
  socket.setEncoding("utf8").on("data", chunk => (said += chunk))
  socket.setTimeout(2_000, () => socket.destroy())
  socket.on("error", () => undefined)
  socket.on("close", () => resolve(said.split("\r\n")[0]))
})

test("an agent's MCP session lasts from one request to the next: a call it makes as a task gives its result when asked for later", () => inFolder(async dir => {
  // An agent that calls a task-only tool as a task, then asks for its result in a request of its own.
  const tasked = {
    kind: "tasked",
    health: async () => ({ ok: true, checkedAt: 0, detail: "" }),
    run: s => ({
      cancel: () => undefined,
      done: (async () => {
        const [server] = s.mcpServers
        const client = new Client({ name: "agent", version: "1" })
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }))
        try {
          const { task } = await client.request({ method: "tools/call", params: { name: "slow", arguments: {}, task: { ttl: 5_000 } } }, CreateTaskResultSchema)
          const result = await client.experimental.tasks.getTaskResult(task.taskId, CallToolResultSchema)
          return { ok: true, text: result.content[0].text, usage: {}, costUsd: null, permissionDenials: [] }
        } finally {
          await client.close()
        }
      })(),
    }),
  }
  const quick = { call: async () => ({ content: [{ type: "text", text: "quick" }] }) }
  const { platform, app } = desk(() => tasked, {}, new Map([["quick", quick]]))
  const revision = app.publish([
    { kind: "cell", id: "desk", title: "Desk", profile: "tasked", exports: ["slow"] },
    { kind: "tool", id: "slow", target: { adapter: "quick" }, definition: { name: "slow", inputSchema: { type: "object" }, execution: { taskSupport: "required" } } },
  ])
  try {
    const result = await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "x" })
    assert.deepEqual([result.isError, result.content[0].text], [false, "quick"])
  } finally {
    await platform.close()
  }
}))

test("a call with arguments as large as celler takes inline reaches its tool through the run's MCP server", () => inFolder(async dir => {
  const text = "x".repeat(5 * 1024 * 1024)
  // An agent that calls its tool with them.
  const calling = {
    kind: "calling",
    health: async () => ({ ok: true, checkedAt: 0, detail: "" }),
    run: s => ({
      cancel: () => undefined,
      done: (async () => {
        const [server] = s.mcpServers
        const client = new Client({ name: "agent", version: "1" })
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }))
        try {
          const result = await client.callTool({ name: "long", arguments: { text } })
          return { ok: true, text: result.content[0].text, usage: {}, costUsd: null, permissionDenials: [] }
        } finally {
          await client.close()
        }
      })(),
    }),
  }
  const measure = { call: async (_run, args) => ({ content: [{ type: "text", text: `${args.text.length} characters` }] }) }
  const { platform, app } = desk(() => calling, {}, new Map([["measure", measure]]))
  const revision = app.publish([{ kind: "cell", id: "desk", title: "Desk", profile: "calling", exports: ["long"] }, { kind: "tool", id: "long", target: { adapter: "measure" }, definition: { name: "long", inputSchema: { type: "object", properties: { text: { type: "string" } } } } }])
  try {
    const result = await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "x" })
    assert.deepEqual([result.isError, result.content[0].text], [false, `${text.length} characters`])
  } finally {
    await platform.close()
  }
}))

test("a call still going when its run ends hears that it was cut off: the run's session closes only after", () => inFolder(async dir => {
  // An agent that ends its run while its own call still waits, and stays to hear what became of the call.
  let call
  const leaving = {
    kind: "leaving",
    health: async () => ({ ok: true, checkedAt: 0, detail: "" }),
    run: s => ({
      cancel: () => undefined,
      done: (async () => {
        const [server] = s.mcpServers
        const client = new Client({ name: "agent", version: "1" })
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }))
        call = callThenClose(client, { name: "wait", arguments: {} })
        await delay(100)
        return { ok: true, text: "Done", usage: {}, costUsd: null, permissionDenials: [] }
      })(),
    }),
  }
  // A call that lasts until the run that made it ends.
  const wait = { call: (_run, _args, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) }
  const { platform, app } = desk(() => leaving, {}, new Map([["wait", wait]]))
  const revision = app.publish([{ kind: "cell", id: "desk", title: "Desk", profile: "leaving", exports: ["wait"] }, { kind: "tool", id: "wait", target: { adapter: "wait" }, definition: { name: "wait", inputSchema: { type: "object" } } }])
  try {
    assert.equal((await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "x" })).content[0].text, "Done")
    // In celler's words, as a result it can read, never the abort its adapter rejected with.
    const heard = await Promise.race([call.then(result => result.isError && result.content[0].text, error => error.message), delay(2_000).then(() => "nothing")])
    assert.equal(heard, "Run has ended")
  } finally {
    await platform.close()
  }
}))

test("a request to the run's MCP server at an address that can't be read is answered 404, and the host stays up", () => inFolder(async dir => {
  // An agent that waits until it is told to end, with its run's server.
  let server, finish
  const waiting = {
    kind: "waiting",
    health: async () => ({ ok: true, checkedAt: 0, detail: "" }),
    run: s => ((server = s.mcpServers[0]), { cancel: () => undefined, done: new Promise(resolve => (finish = resolve)) }),
  }
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  const { platform, app, revision } = desk(() => waiting)
  try {
    const started = app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "x" })
    await until(() => server)
    // With the run's own token, at an address no URL can be read from.
    const request = ["GET //[ HTTP/1.1", "Host: 127.0.0.1", `Authorization: ${server.headers.Authorization}`, "Connection: close", "", ""].join("\r\n")
    assert.equal(await statusOf(server.url, request), "HTTP/1.1 404 Not Found")
    // Its run goes on, and ends as its agent did.
    finish({ ok: true, text: "Done", usage: {}, costUsd: null, permissionDenials: [] })
    assert.equal((await started).content[0].text, "Done")
    assert.deepEqual(unhandled, [])
  } finally {
    process.off("unhandledRejection", onUnhandled)
    await platform.close()
  }
}))
