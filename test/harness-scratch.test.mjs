import assert from "node:assert/strict"
import test from "node:test"
import fs, { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { AgentRuntime, claudeAgent } from "celler/harness"
import { agentEnv, PROXIES, runEnv } from "../dist/harness/programs.js"
import { homeTools, inside, removeScratch, scratchFor, systemTemps } from "../dist/harness/sandbox/places.js"
import { until } from "./support.mjs"
import { claudeWords, fakeClaude, host, inFolder, placesIn, spec } from "./support-harness.mjs"

test("a run's places are its own: nothing of the person's environment, its scratch in its folder and gone after it", () => inFolder(async dir => {
  const folder = path.join(dir, "work")
  mkdirSync(folder)
  // Its environment: what programs need, its own temporary folder and caches; a token in the person's shell, never.
  process.env.CELLER_TEST_TOKEN = "s3cret"
  try {
    const places = placesIn(dir)
    const env = runEnv({ OWN: "1" }, host, places)
    assert.equal(env.CELLER_TEST_TOKEN, undefined)
    assert.deepEqual([env.TMPDIR, env.XDG_CACHE_HOME, env.HOST_RUN, env.OWN, env.PATH], [places.scratch.tmp, places.scratch.cache, "1", "1", process.env.PATH])
    assert.ok(PROXIES.includes("HTTPS_PROXY"))
  } finally {
    delete process.env.CELLER_TEST_TOKEN
  }
  // The system's temporary folders, as they really are, to close: never a link to one, which would close paths through it.
  assert.ok(systemTemps().some(dir => inside(dir, realpathSync(os.tmpdir()))))
  assert.ok(systemTemps().every(dir => realpathSync(dir) === dir))
  // PATH's folders in the home, by their real paths: never the home itself, nor what isn't there or isn't in it.
  const home = realpathSync(dir)
  mkdirSync(path.join(home, ".nvm", "bin"), { recursive: true })
  assert.deepEqual(homeTools([path.join(home, ".nvm", "bin"), home, "/usr/bin", "relative/bin", path.join(home, "gone")].join(path.delimiter), home), [path.join(home, ".nvm", "bin")])
  // macOS's own folder for the person, which holds their temporary files and caches, closed as a whole.
  if (process.platform === "darwin") assert.ok(systemTemps().includes(path.dirname(realpathSync(os.tmpdir()))))
  // Its scratch, which git leaves alone: a commit in the folder holds none of it.
  execFileSync("git", ["init", "-q", folder])
  const hidden = scratchFor(folder)
  writeFileSync(path.join(hidden.tmp, "cache.json"), "{}")
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: folder, encoding: "utf8" }), "")
  await removeScratch(hidden)
  rmSync(path.join(folder, ".git"), { recursive: true, force: true })
  // Claude Code's own sign-in for its errands too, as for its runs: none from the person's shell.
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "t0ken"
  try {
    assert.equal(agentEnv(claudeAgent({ claude: () => null, words: claudeWords }).env(host), host).CLAUDE_CODE_OAUTH_TOKEN, undefined)
  } finally {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  }
  // Its scratch folder is made inside its folder for the run, and gone once it ends, with the folder that held it.
  const seen = []
  const fake = fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl") })
  const scratching = { ...fake, run: turn => (seen.push(turn.places.scratch), fake.run(turn)) }
  const result = await new AgentRuntime(scratching, host).run(spec({ cwd: folder }), () => undefined).done
  assert.equal(result.ok, true, result.error)
  assert.equal(path.dirname(seen[0].root), path.join(folder, ".celler"))
  // Removed in the background, as soon as it can be.
  await until(() => !readdirSync(folder).includes(".celler"))
}))

test("a run's short folder is its own, short enough for Claude Code's sockets, and gone with its scratch", () => inFolder(async dir => {
  const folder = path.join(dir, "work")
  mkdirSync(folder)
  const scratch = scratchFor(folder)
  // Windows has no such limit: there it is its scratch's own temporary folder.
  if (process.platform === "win32") return assert.equal(scratch.short, scratch.tmp)
  // In the system's /tmp, by its real path, which only its owner may use; Claude Code's shell's folder in it fits the 44
  // bytes it allows for its sockets' folder, past which it would use the one all of the person's Claude Code shares.
  assert.equal(path.dirname(scratch.short), realpathSync("/tmp"))
  assert.equal(statSync(scratch.short).mode & 0o777, 0o700)
  assert.ok(Buffer.byteLength(path.join(scratch.short, `claude-${process.getuid()}`)) <= 44, scratch.short)
  await removeScratch(scratch)
  assert.equal(existsSync(scratch.short), false)
}))

test("a run's scratch goes after it even when a tool left read-only folders in it, and removing it never throws", () => inFolder(async dir => {
  const folder = path.join(dir, "work")
  mkdirSync(folder)
  const scratch = scratchFor(folder)
  // Go's module cache, as `go test` leaves it in the home it was given: folders no one may write in.
  const module = path.join(scratch.home, "go", "pkg", "mod", "example.com", "x@v1.0.0")
  mkdirSync(module, { recursive: true })
  writeFileSync(path.join(module, "x.go"), "package x")
  for (const dir of [module, path.dirname(module)]) chmodSync(dir, 0o555)
  await removeScratch(scratch)
  assert.equal(existsSync(path.join(folder, ".celler")), false)
}))

test("a run's scratch goes once what its agent started has exited, so nothing it writes there on its way out is left", () => inFolder(async dir => {
  const folder = path.join(dir, "work")
  mkdirSync(folder)
  // An agent whose process outlives its run for a moment, and writes in the run's scratch meanwhile.
  const fake = fakeClaude()
  const lingering = { ...fake, run: async turn => {
    const late = path.join(turn.places.scratch.tmp, "late", "notes.txt")
    const script = `setTimeout(() => { const fs = require("node:fs"); fs.mkdirSync(${JSON.stringify(path.dirname(late))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(late)}, "late") }, 300)`
    turn.spawn(process.execPath, ["-e", script], { env: turn.env })
    return { ok: true, text: "", usage: {}, costUsd: null, permissionDenials: [] }
  } }
  const result = await new AgentRuntime(lingering, host).run(spec({ cwd: folder }), () => undefined).done
  assert.equal(result.ok, true, result.error)
  await until(() => !existsSync(path.join(folder, ".celler")))
  // Gone, and nothing has come back.
  await delay(500)
  assert.equal(existsSync(path.join(folder, ".celler")), false)
}))

test("a run that can't be set up leaves no scratch behind: when its environment can't be made, nor when its scratch can't be whole", () => inFolder(async dir => {
  const folder = path.join(dir, "work")
  mkdirSync(folder)
  // A host whose mark fails.
  const failing = { ...host, mark: () => { throw new Error("The host's mark failed") } }
  const result = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl") }), failing).run(spec({ cwd: folder }), () => undefined).done
  assert.equal(result.error, "Claude Code could not be set up for this run: The host's mark failed")
  await until(() => !existsSync(path.join(folder, ".celler")))
  // A computer with no room for its short folder (Windows makes none): what was made of its scratch goes again.
  if (process.platform === "win32") return
  const mkdtemp = fs.mkdtempSync
  fs.mkdtempSync = (prefix, ...rest) => {
    if (path.basename(prefix) === "celler-") throw Object.assign(new Error("ENOSPC: no space left on device, mkdtemp"), { code: "ENOSPC" })
    return mkdtemp(prefix, ...rest)
  }
  syncBuiltinESMExports()
  try {
    assert.throws(() => scratchFor(folder), /ENOSPC/)
  } finally {
    fs.mkdtempSync = mkdtemp
    syncBuiltinESMExports()
  }
  assert.equal(existsSync(path.join(folder, ".celler")), false)
}))

test("a run's scratch is made only inside its folder, never through a link a run or a repository put in its place", () => inFolder(async dir => {
  // Windows makes no such link without the person's leave.
  if (process.platform === "win32") return
  const folder = path.join(dir, "work")
  const elsewhere = path.join(dir, "elsewhere")
  mkdirSync(folder)
  mkdirSync(elsewhere)
  symlinkSync(elsewhere, path.join(folder, ".celler"))
  assert.throws(() => scratchFor(folder), /leads outside the run's folder/)
  // A run there doesn't start, and nothing is made where the link leads.
  const result = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl") }), host).run(spec({ cwd: folder }), () => undefined).done
  assert.match(result.error, /^Claude Code could not be set up for this run: .* leads outside the run's folder/)
  assert.deepEqual(readdirSync(elsewhere), [])
}))

test("a link planted in a run's scratch is never followed: nothing is made where it leads, nor made writable there", () => inFolder(async dir => {
  // Windows makes no such link without the person's leave.
  if (process.platform === "win32") return
  const folder = path.join(dir, "work")
  const elsewhere = path.join(dir, "elsewhere")
  mkdirSync(folder)
  mkdirSync(elsewhere)
  symlinkSync(elsewhere, path.join(folder, ".celler"))
  // Its time set back: anything made there, even for a moment, would set it again.
  const past = new Date("2001-01-01T00:00:00Z")
  utimesSync(elsewhere, past, past)
  assert.throws(() => scratchFor(folder), /leads outside the run's folder/)
  assert.equal(statSync(elsewhere).mtimeMs, past.getTime())
  // A scratch whose commands put a link in its place, in a folder they made read-only so the link can't go: removing
  // it leaves where the link leads as it was.
  rmSync(path.join(folder, ".celler"))
  const scratch = scratchFor(folder)
  const kept = path.join(dir, "kept")
  mkdirSync(path.join(kept, "inner"), { recursive: true })
  for (const place of [path.join(kept, "inner"), kept]) chmodSync(place, 0o500)
  rmSync(scratch.root, { recursive: true })
  symlinkSync(kept, scratch.root)
  chmodSync(path.dirname(scratch.root), 0o500)
  try {
    await removeScratch(scratch)
    assert.deepEqual([kept, path.join(kept, "inner")].map(place => statSync(place).mode & 0o777), [0o500, 0o500])
  } finally {
    for (const place of [path.dirname(scratch.root), kept, path.join(kept, "inner")]) chmodSync(place, 0o700)
  }
}))
