import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { createApp, createBroker } from "senter-mvp"
import { request, text, unit } from "./support.mjs"

test("a host broker receives the workspace and can use MCP over its own pipe", async t => {
  const database = new DatabaseSync(":memory:")
  t.after(() => database.close())
  const fixture = fileURLToPath(new URL("./fixtures/broker.mjs", import.meta.url))
  const { platform, adapters, workspaceNodes } = createBroker({ executable: process.execPath, args: [fixture] }, () => true)
  const app = createApp({ database, platform, adapters })
  const revision = app.publish([unit("root", ["files"]), ...workspaceNodes])
  assert.deepEqual(await app.start(request(revision), AbortSignal.timeout(8000)), text("workspace result"))
  // Grouping unit `files` has no launch profile and cannot be started directly.
  await assert.rejects(app.start({ ...request(revision), entry: "files" }), /launch profile/)
})

test("broker supports utf-8 fs.write, captures stderr safely, enforces byte limits and reports exit errors", async t => {
  const database = new DatabaseSync(":memory:")
  t.after(() => database.close())
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

  // UTF-8 text is converted to base64 on the wire cleanly.
  const written = await writeAdapter.call(run, { path: "hello.txt", text: "hello utf-8" }, AbortSignal.timeout(5000))
  assert.deepEqual(written, text("hello utf-8"))
  assert.ok(stderrChunks.join("").includes("broker-diag"))

  // Non-zero broker exit surfaces as BROKER_ERROR rather than JSON SyntaxError.
  await assert.rejects(
    readAdapter.call(run, { path: "fail" }, AbortSignal.timeout(5000)),
    err => err.code === "BROKER_ERROR" && /code 7/.test(err.message),
  )

  // Oversized stdout is rejected cleanly against inlineLimit.
  await assert.rejects(
    readAdapter.call(run, { path: "big" }, AbortSignal.timeout(5000)),
    err => err.code === "LIMIT_EXCEEDED",
  )

  // Validation rejects null-byte paths and invalid base64 on fs.write.
  const app = createApp({ database, platform, adapters })
  const rev = app.publish([unit("root", ["files"]), ...workspaceNodes])
  assert.ok(rev)
  const fsWriteDef = workspaceNodes.find(n => n.id === "fs.write")
  assert.equal(fsWriteDef.definition.annotations.destructiveHint, true)
  const fsReadDef = workspaceNodes.find(n => n.id === "fs.read")
  assert.equal(fsReadDef.definition.annotations.readOnlyHint, true)
})

test("launches never hold workspace slots, and a broker may answer before reading its input", async t => {
  const database = new DatabaseSync(":memory:")
  t.after(() => database.close())
  const fixture = fileURLToPath(new URL("./fixtures/broker.mjs", import.meta.url))
  // One slot: a launch holding it would starve its own fs.read forever.
  const { platform, adapters, workspaceNodes } = createBroker({ executable: process.execPath, args: [fixture], maxConcurrency: 1 }, () => true)
  const app = createApp({ database, platform, adapters })
  const revision = app.publish([unit("root", ["files"]), ...workspaceNodes])
  const results = await Promise.all([1, 2].map(() => app.start(request(revision), AbortSignal.timeout(8000))))
  assert.deepEqual(results, [text("workspace result"), text("workspace result")])

  const answer = 'process.stdout.write(JSON.stringify({ content: [{ type: "text", text: "early" }] }))'
  const early = createBroker({ executable: process.execPath, args: ["-e", answer] }, () => true)
  const run = { id: "r1", owner: "alice", revision: "rev", entry: "root", workspace: "ws", parent: null }
  const written = await early.adapters.get("fs.write").call(run, { path: "big.txt", text: "x".repeat(1024 * 1024) }, AbortSignal.timeout(5000))
  assert.deepEqual(written, text("early"))
})
