import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { createApp, createBroker } from "celler"
import { cell, memoryDatabase, request, text } from "./support.mjs"

test("a host broker receives the workspace and can use MCP over its own pipe", async t => {
  const database = memoryDatabase(t)
  const fixture = fileURLToPath(new URL("./fixtures/broker.mjs", import.meta.url))
  const { platform, adapters, workspaceNodes } = createBroker({ executable: process.execPath, args: [fixture] }, () => true)
  const app = createApp({ database, platform, adapters })
  const revision = app.publish([cell("root", ["files"]), ...workspaceNodes])
  assert.deepEqual(await app.start(request(revision), AbortSignal.timeout(8000)), text("workspace result"))
  await assert.rejects(app.start({ ...request(revision), entry: "files" }), /launch profile/)
})

test("broker supports utf-8 fs.write, captures stderr safely, enforces byte limits and reports exit errors", async t => {
  const database = memoryDatabase(t)
  const stderrChunks = []
  const script = `
    import { readFileSync } from "node:fs";
    const input = JSON.parse(readFileSync(0, "utf8"));
    process.stderr.write("broker-diag");
    if (input.op === "write") {
      process.stdout.write(JSON.stringify({ content: [{ type: "text", text: Buffer.from(input.args.base64, "base64").toString("utf8") }] }));
    } else if (input.op === "read" && input.args.path === "fail") {
      process.exit(7);
    } else if (input.op === "read" && input.args.path === "big") {
      process.stdout.write("x".repeat(2048));
    }
  `
  const { platform, adapters, workspaceNodes } = createBroker({
    executable: process.execPath,
    args: ["-e", script],
    inlineLimit: 1024,
    nativeDiscovery: true,
    onStderr: chunk => stderrChunks.push(chunk.toString()),
  }, () => true)
  const writeAdapter = adapters.get("fs.write")
  const readAdapter = adapters.get("fs.read")
  const run = { id: "r1", owner: "alice", revision: "rev", entry: "root", workspace: "ws", parent: null }

  // fs.write sends text to the broker as base64.
  const written = await writeAdapter.call(run, { path: "hello.txt", text: "hello utf-8" }, AbortSignal.timeout(5000))
  assert.deepEqual(written, text("hello utf-8"))
  assert.ok(stderrChunks.join("").includes("broker-diag"))

  // A failed exit is a BROKER_ERROR, not a SyntaxError from parsing empty output.
  await assert.rejects(
    readAdapter.call(run, { path: "fail" }, AbortSignal.timeout(5000)),
    err => err.code === "BROKER_ERROR" && /code 7/.test(err.message),
  )

  // 2048 bytes of stdout are over inlineLimit = 1024.
  await assert.rejects(
    readAdapter.call(run, { path: "big" }, AbortSignal.timeout(5000)),
    err => err.code === "LIMIT_EXCEEDED",
  )

  // The workspace tool schemas compile, and their annotations match what they do.
  const app = createApp({ database, platform, adapters })
  const rev = app.publish([cell("root", ["files"]), ...workspaceNodes])
  assert.ok(rev)
  const fsWriteDef = workspaceNodes.find(n => n.id === "fs.write")
  assert.equal(fsWriteDef.definition.annotations.destructiveHint, true)
  const fsReadDef = workspaceNodes.find(n => n.id === "fs.read")
  assert.equal(fsReadDef.definition.annotations.readOnlyHint, true)
})

test("launches never hold workspace slots, and a broker may answer before reading its input", async t => {
  const database = memoryDatabase(t)
  const fixture = fileURLToPath(new URL("./fixtures/broker.mjs", import.meta.url))
  // One slot: a launch holding it would starve its own fs.read forever.
  const { platform, adapters, workspaceNodes } = createBroker({ executable: process.execPath, args: [fixture], maxConcurrency: 1 }, () => true)
  const app = createApp({ database, platform, adapters })
  const revision = app.publish([cell("root", ["files"]), ...workspaceNodes])
  const results = await Promise.all([1, 2].map(() => app.start(request(revision), AbortSignal.timeout(8000))))
  assert.deepEqual(results, [text("workspace result"), text("workspace result")])

  const answer = 'process.stdout.write(JSON.stringify({ content: [{ type: "text", text: "early" }] }))'
  const early = createBroker({ executable: process.execPath, args: ["-e", answer] }, () => true)
  const run = { id: "r1", owner: "alice", revision: "rev", entry: "root", workspace: "ws", parent: null }
  const written = await early.adapters.get("fs.write").call(run, { path: "big.txt", text: "x".repeat(1024 * 1024) }, AbortSignal.timeout(5000))
  assert.deepEqual(written, text("early"))
})

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("an aborted call stops a broker that ignores SIGTERM, and frees its slot", { timeout: 4000 }, async t => {
  // It ignores SIGTERM and never answers, except for the path "quick".
  const script = `
    process.on("SIGTERM", () => {})
    process.stderr.write(process.pid + "\\n")
    let input = ""
    process.stdin.on("data", data => { input += data }).on("end", () => {
      if (JSON.parse(input).args.path === "quick") process.stdout.write(JSON.stringify({ content: [] }))
      else setInterval(() => {}, 1000)
    })
  `
  const pids = []
  const { adapters } = createBroker({
    executable: process.execPath, args: ["-e", script], killTimeoutMs: 100, maxConcurrency: 1,
    onStderr: chunk => pids.push(...String(chunk).split("\n").filter(Boolean).map(Number)),
  }, () => true)
  t.after(() => { for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL") })
  const run = { id: "r1", owner: "alice", revision: "rev", entry: "root", workspace: "ws", parent: null }

  const controller = new AbortController()
  const stuck = adapters.get("fs.read").call(run, { path: "stuck" }, controller.signal)
  while (pids.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort()
  await assert.rejects(stuck, { name: "AbortError" })
  // Its one slot is free at once, and the broker is killed once killTimeoutMs has passed.
  assert.deepEqual(await adapters.get("fs.read").call(run, { path: "quick" }, AbortSignal.timeout(2000)), { content: [] })
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(alive(pids[0]), false)
})

test("a broker that answers with something other than a tool result fails in celler's words", async () => {
  const run = { id: "r1", owner: "alice", revision: "rev", entry: "root", workspace: "ws", parent: null }
  for (const output of ["not json", JSON.stringify({ content: 1 })]) {
    const { adapters } = createBroker({ executable: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(output)})`] }, () => true)
    await assert.rejects(adapters.get("fs.read").call(run, { path: "x" }, AbortSignal.timeout(5000)),
      error => error.name === "CellerError" && error.code === "BROKER_ERROR" && /^Broker result/.test(error.message))
  }
})
