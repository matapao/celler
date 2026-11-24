import assert from "node:assert/strict"
import test, { after } from "node:test"
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CallToolResultSchema, CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { createApp } from "celler"
import { AgentRuntime, chosenPrograms, claudeAgent, codexAgent, findProgram, harnessPlatform, SimulatedRuntime } from "celler/harness"
import { CODEX_HOME_CONFIG } from "../dist/harness/agents.js"
import { agentVersions, harnessLimits } from "../dist/limits.js"
import { agentEnv, CODEX_TARGETS, codexProgram, PROXIES, runEnv } from "../dist/harness/programs.js"
import claudeOnLinux from "../dist/harness/sandbox/claude.linux.js"
import claudeOnMacos from "../dist/harness/sandbox/claude.macos.js"
import claudeOnWindows from "../dist/harness/sandbox/claude.windows.js"
import codexOnLinux from "../dist/harness/sandbox/codex.linux.js"
import codexOnMacos from "../dist/harness/sandbox/codex.macos.js"
import codexOnWindows from "../dist/harness/sandbox/codex.windows.js"
import { AGENT_SETTINGS, homeTools, inside, removeScratch, scratchFor, systemTemps, unfitFolder } from "../dist/harness/sandbox/places.js"
import { until } from "./support.mjs"

const host = { client: { name: "host", version: "1.0.0" }, mark: env => ({ ...env, HOST_RUN: "1" }) }
const claudeWords = { noClaude: "Claude Code isn't here.", login: "Sign in to Claude in the host." }
const codexWords = { install: "Install Codex.", login: "Sign Codex in to the host.", signedOut: "not signed in for the host" }
/** Stand-ins for the agents' own programs, as their SDKs drive them (fixtures/fake-claude, fixtures/fake-codex). */
const fakeClaudeProgram = fileURLToPath(new URL("./fixtures/fake-claude", import.meta.url))
const fakeCodexProgram = fileURLToPath(new URL("./fixtures/fake-codex", import.meta.url))
const spec = (over = {}) => ({ cwd: os.tmpdir(), prompt: "x", systemPrompt: "", model: "fast", sessionId: "s", resume: false, mcpServers: [], purpose: "work", timeoutMs: 20_000, ...over })
/** A run's places, as sandbox/places.ts works them out: under `dir`, with one of each kind, its scratch in its folder. */
const placesIn = dir => ({
  folder: path.join(dir, "work"),
  scratch: { root: path.join(dir, "work", ".celler", "run-1"), tmp: path.join(dir, "work", ".celler", "run-1", "tmp"), home: path.join(dir, "work", ".celler", "run-1", "home"), cache: path.join(dir, "work", ".celler", "run-1", "cache"), short: "/private/tmp/celler-run1" },
  temps: ["/private/var/folders/x/T", "/private/tmp"],
  home: path.join(dir, "home"),
  agentHomes: [path.join(dir, "agent-home")],
  tools: [path.join(dir, "home", ".nvm", "bin")],
  readable: [path.join(dir, "repo", ".git")],
  hidden: ["HTTPS_PROXY"],
})
const github = { name: "github", transport: "http", url: "https://api.example.com/mcp/", headers: { Authorization: "Bearer t0ken" } }
const inFolder = async work => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "celler-harness-"))
  try {
    return await work(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
/** What a stand-in was started with and sent, in order. */
const sentTo = log => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))
/** Claude Code as a host has it, its program the stand-in, with these variables for the stand-in. */
const fakeClaude = (env = {}) => {
  const agent = claudeAgent({ claude: () => fakeClaudeProgram, words: claudeWords })
  return { ...agent, env: h => ({ ...agent.env(h), ...env }) }
}
/** Codex as a host has it, in the Codex home `home`, its program the stand-in, with these variables for the stand-in. */
const fakeCodex = (home, env = {}) => {
  const agent = codexAgent({ codex: () => fakeCodexProgram, home, words: codexWords })
  return { ...agent, env: h => ({ ...agent.env(h), ...env }) }
}
/** The host's Codex home, beside the runs' folders and never in one: no run's folder is, holds or is in it. */
const codexHome = mkdtempSync(path.join(os.tmpdir(), "celler-codex-home-"))
after(() => rmSync(codexHome, { recursive: true, force: true }))
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

test("connector values reach Claude Code in its first request and Codex in variables of its own, never on a command line, and a program the agent would start is refused", () => inFolder(async dir => {
  const log = path.join(dir, "claude.jsonl")
  const claude = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host).run(spec({ cwd: dir, mcpServers: [github] }), () => undefined).done
  assert.equal(claude.ok, true, claude.error)
  const sent = sentTo(log)
  assert.deepEqual(sent.find(e => e.what === "initialize").data.mcpServers, { github: { type: "http", url: github.url, headers: github.headers, timeout: harnessLimits.mcpCallMs } })
  assert.equal(sent.find(e => e.what === "started").data.args.some(arg => arg.includes("t0ken")), false)
  const codexLog = path.join(dir, "codex.jsonl")
  const codex = await new AgentRuntime(fakeCodex(codexHome, { FAKE_CODEX_LOG: codexLog }), host).run(spec({ cwd: dir, mcpServers: [github] }), () => undefined).done
  assert.equal(codex.ok, true, codex.error)
  const exec = sentTo(codexLog)[0].data
  assert.ok(exec.configs.includes(`mcp_servers={ github = { url = "${github.url}", env_http_headers = { Authorization = "CELLER_VALUE_0" }, default_tools_approval_mode = "approve", tool_timeout_sec = ${harnessLimits.mcpCallMs / 1000} } }`), exec.configs.join("\n"))
  assert.deepEqual(exec.values, { CELLER_VALUE_0: "Bearer t0ken" })
  assert.equal(exec.args.some(arg => arg.includes("t0ken")), false)
  // A connector's program is the host's to start.
  const stdio = await new AgentRuntime(fakeClaude(), host).run(spec({ cwd: dir, mcpServers: [{ ...github, transport: "stdio" }] }), () => undefined).done
  assert.match(stdio.error, /started by the host, never by the agent$/)
}))

test("each of a run's MCP servers has a name of its own, which its agent names its tools by: a host's server named like the run's fails the run", () => inFolder(async dir => {
  const log = path.join(dir, "agent.jsonl")
  const named = mcpServers => () => ({ prompt: "x", model: "", sessionId: "", resume: false, timeoutMs: 20_000, mcpServers })
  const { platform, app, revision, ended } = desk(() => new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host), { spec: named([{ ...github, name: "office" }]) })
  try {
    const result = await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "x" })
    assert.deepEqual([result.isError, ended.map(r => r.error)], [true, ["Two of the run's MCP servers are named office: each needs a name of its own"]])
  } finally {
    await platform.close()
  }
  // Nor the same name twice among the host's, nor one an agent can't name its tools by.
  const runtime = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host)
  const twice = await runtime.run(spec({ cwd: dir, mcpServers: [github, github] }), () => undefined).done
  assert.equal(twice.error, "Two of the run's MCP servers are named github: each needs a name of its own")
  for (const name of ["git hub", "github.com", ""]) {
    const odd = await runtime.run(spec({ cwd: dir, mcpServers: [{ ...github, name }] }), () => undefined).done
    assert.equal(odd.error, `${JSON.stringify(name)} can't name one of the run's MCP servers: only letters, digits, "_" and "-" can`, name)
  }
  // None of them started an agent.
  assert.equal(existsSync(log), false)
}))

test("a run's folder that is or holds the person's home, the filesystem's root or a system temporary folder is refused, before anything is made in it", () => inFolder(async dir => {
  const home = path.join(dir, "home")
  mkdirSync(path.join(home, "work"), { recursive: true })
  const was = process.env.HOME
  process.env.HOME = home
  try {
    const log = path.join(dir, "agent.jsonl")
    const runtime = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host)
    for (const cwd of [home, dir, path.parse(dir).root, realpathSync(os.tmpdir())]) {
      const refused = await runtime.run(spec({ cwd }), () => undefined).done
      assert.match(refused.error ?? "", /^A run can't work in /, cwd)
    }
    assert.deepEqual([existsSync(path.join(home, ".celler")), existsSync(log)], [false, false])
    // A folder inside the home is the run's own.
    const inside = await runtime.run(spec({ cwd: path.join(home, "work") }), () => undefined).done
    assert.equal(inside.ok, true, inside.error)
  } finally {
    process.env.HOME = was
  }
}))

test("a place no run may reach is refused by every name it has: in another case, or by its name on macOS's data volume", () => {
  if (process.platform !== "darwin") return
  const home = os.homedir()
  // The home in capitals is the home; the data volume's name for it too, and the data volume holds it.
  for (const folder of [home.toUpperCase(), `/System/Volumes/Data${home}`, "/System/Volumes/Data"]) {
    assert.match(unfitFolder(folder) ?? "", /^A run can't work in /, folder)
  }
  // A folder in the home, by any of its names, is still one a run may have.
  assert.equal(unfitFolder(path.join(home.toUpperCase(), "Library")), null)
  assert.equal(unfitFolder(`/System/Volumes/Data${home}/Library`), null)
})

test("what the host adds for a run to read is held to the same: the person's home or a temporary folder fails the run before it starts", () => inFolder(async dir => {
  const work = path.join(dir, "work")
  const repository = path.join(dir, "repo", ".git")
  mkdirSync(work)
  mkdirSync(repository, { recursive: true })
  const log = path.join(dir, "agent.jsonl")
  const runtime = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host)
  for (const readable of [[os.homedir()], ...(process.platform === "win32" ? [] : [["/tmp"]])]) {
    const refused = await runtime.run(spec({ cwd: work, readable }), () => undefined).done
    assert.match(refused.error ?? "", /^A run can't read /, readable[0])
  }
  assert.deepEqual([existsSync(path.join(work, ".celler")), existsSync(log)], [false, false])
  // A repository's data beside the folder it reads, by its real path, as its sandbox sees it; and the folder by its own.
  const reading = await runtime.run(spec({ cwd: work, readable: [repository] }), () => undefined).done
  assert.equal(reading.ok, true, reading.error)
  const { filesystem } = sentTo(log).find(e => e.what === "started").data.settings.sandbox
  assert.ok(filesystem.allowRead.includes(realpathSync.native(repository)), filesystem.allowRead.join("\n"))
  assert.deepEqual(filesystem.allowWrite, [realpathSync.native(work)])
}))

test("a run's folder that is, holds or is in the agent's own home is refused: Codex's home, and Claude Code's where the person keeps it", () => inFolder(async dir => {
  const home = path.join(dir, "work", "codex-home")
  mkdirSync(path.join(home, "sessions"), { recursive: true })
  const log = path.join(dir, "codex.jsonl")
  const codex = new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: log }), host)
  for (const cwd of [path.join(dir, "work"), home, path.join(home, "sessions")]) {
    const refused = await codex.run(spec({ cwd }), () => undefined).done
    assert.match(refused.error ?? "", /^A run can't work in .*, the agent's own home, which no run may reach$/, cwd)
  }
  assert.equal(existsSync(log), false)
  // Claude Code's own (CLAUDE_CONFIG_DIR), when the person keeps it somewhere of their choosing.
  const config = path.join(dir, "claude-config")
  mkdirSync(path.join(config, "projects"), { recursive: true })
  const was = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  try {
    const refused = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host).run(spec({ cwd: path.join(config, "projects") }), () => undefined).done
    assert.match(refused.error ?? "", /, the agent's own home, which no run may reach$/)
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = was
  }
  assert.equal(existsSync(log), false)
}))

test("the agent's own home is closed to its commands wherever it is: Codex's, made for its owner alone, and Claude Code's", () => inFolder(async dir => {
  const work = path.join(dir, "work")
  mkdirSync(work)
  // Outside the person's home, which would close it otherwise.
  const home = path.join(dir, "codex-home")
  assert.equal(inside(os.homedir(), home), false)
  const log = path.join(dir, "codex.jsonl")
  const codex = await new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: log }), host).run(spec({ cwd: work }), () => undefined).done
  assert.equal(codex.ok, true, codex.error)
  if (process.platform !== "win32") assert.equal(statSync(home).mode & 0o777, 0o700)
  const permissions = sentTo(log)[0].data.configs.find(c => c.startsWith("permissions="))
  assert.ok(permissions.includes(`${JSON.stringify(realpathSync.native(home))} = "deny"`), permissions)
  // Claude Code's own (CLAUDE_CONFIG_DIR), never read by its commands.
  const config = path.join(dir, "claude-config")
  mkdirSync(config)
  const claudeLog = path.join(dir, "claude.jsonl")
  const was = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  try {
    const claude = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: claudeLog }), host).run(spec({ cwd: work }), () => undefined).done
    assert.equal(claude.ok, true, claude.error)
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = was
  }
  const { filesystem } = sentTo(claudeLog).find(e => e.what === "started").data.settings.sandbox
  assert.ok(filesystem.denyRead.includes(realpathSync.native(config)), filesystem.denyRead.join("\n"))
}))

test("Claude Code says in the host's words when its program isn't there", async () => {
  const missing = new AgentRuntime(claudeAgent({ claude: () => null, words: claudeWords }), host)
  const health = await missing.health(false)
  assert.deepEqual([health.ok, health.fix, health.detail], [false, "find", claudeWords.noClaude])
  const run = await missing.run(spec(), () => undefined).done
  assert.deepEqual([run.runtimeDown, run.error], [true, claudeWords.noClaude])
  assert.deepEqual(missing.login(), { error: claudeWords.noClaude })
})

test("Codex runs in a profile of the run's own, its folder written at work and only read otherwise, in the host's Codex home, which trusts no folder", () => inFolder(async dir => {
  const home = codexHome
  const log = path.join(dir, "codex.jsonl")
  const runtime = new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: log }), host)
  const started = async over => {
    const result = await runtime.run(spec({ cwd: dir, systemPrompt: "Be brief.", prompt: "Test it", ...over }), () => undefined).done
    assert.equal(result.ok, true, result.error)
    return sentTo(log).at(-1).data
  }
  const work = await started({})
  // Its own home, where its sign-in is kept in a file and no folder is trusted, so it loads no folder's own settings.
  assert.equal(work.home, home)
  assert.equal(readFileSync(path.join(home, "config.toml"), "utf8"), CODEX_HOME_CONFIG)
  // A tier as Codex's own model for it; the cells' texts ahead of the person's words, set apart.
  assert.deepEqual([work.model, work.cwd, work.mark], ["gpt-6-luna", dir, "1"])
  assert.equal(work.prompt, "Be brief.\n\n---\n\nTest it")
  // Its settings file's for this system, each key a whole table, as Codex reads a table keyed by paths.
  assert.ok(work.configs.includes('default_permissions="run"'), work.configs.join("\n"))
  assert.match(work.configs.find(c => c.startsWith("permissions=")), /":workspace_roots" = \{ "\." = "write"/)
  assert.match((await started({ purpose: "read" })).configs.find(c => c.startsWith("permissions=")), /":workspace_roots" = \{ "\." = "read"/)
  // A model-only decision runs no command and gets no MCP server.
  const decided = await started({ purpose: "inference", mcpServers: [github] })
  assert.match(decided.configs.find(c => c.startsWith("features=")), /shell_tool = false/)
  assert.equal(decided.configs.some(c => c.startsWith("mcp_servers=")), false)
  // A session continued is resumed.
  assert.equal((await started({ resume: true, sessionId: "fake-thread" })).resume, "fake-thread")
}))

test("Codex gets its settings as TOML reads them: a control character in a place's name, U+007F too, escaped", () => inFolder(async dir => {
  // Windows names no folder with one.
  if (process.platform === "win32") return
  const work = path.join(dir, "work")
  const odd = path.join(dir, "repo\x7f", ".git")
  mkdirSync(work)
  mkdirSync(odd, { recursive: true })
  const log = path.join(dir, "codex.jsonl")
  const result = await new AgentRuntime(fakeCodex(codexHome, { FAKE_CODEX_LOG: log }), host).run(spec({ cwd: work, readable: [odd] }), () => undefined).done
  assert.equal(result.ok, true, result.error)
  const permissions = sentTo(log)[0].data.configs.find(c => c.startsWith("permissions="))
  assert.ok(permissions.includes(`${JSON.stringify(realpathSync.native(odd)).replace("\x7f", "\\u007f")} = "read"`), permissions)
  assert.equal(permissions.includes("\x7f"), false)
}))

test("each harness's settings for each system keep its commands to the folder and off the network, and close the person's home as a whole", () => {
  const p = placesIn("/x")
  for (const [system, claude] of Object.entries({ macos: claudeOnMacos, linux: claudeOnLinux, windows: claudeOnWindows })) {
    for (const purpose of ["work", "read"]) {
      const own = claude(p, purpose)
      const at = `Claude Code on ${system}, to ${purpose}`
      // Every command in the sandbox, none outside it, and no run where it can't start.
      assert.deepEqual([own.sandbox.enabled, own.sandbox.failIfUnavailable, own.sandbox.allowUnsandboxedCommands], [true, true, false], at)
      // No network at all: no host, no server of its own, no other program's socket.
      assert.deepEqual(own.sandbox.network, { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowUnixSockets: [], allowAllUnixSockets: false }, at)
      // Written: the folder at work, else only its own scratch in it, and nothing else of ours (its sandbox adds its
      // shell's own temporary folder itself).
      assert.deepEqual(own.sandbox.filesystem.allowWrite, purpose === "work" ? [p.folder] : [p.scratch.root], at)
      assert.ok(own.sandbox.filesystem.allowWrite.every(dir => dir === p.folder || dir.startsWith(p.folder + path.sep)), at)
      // Never read: the system's temporary folders, as a whole, and its own home wherever it is; the person's home and
      // other users' folders are closed by Claude Code's own rule. Read again: the folder, the run's short folder (its
      // shell's temporary one), PATH's folders in the home and what the host adds, and nothing else.
      assert.deepEqual(own.sandbox.filesystem.denyRead, [...p.temps, ...p.agentHomes], at)
      assert.deepEqual(own.sandbox.filesystem.allowRead, [p.folder, p.scratch.short, ...p.tools, ...p.readable], at)
      assert.deepEqual([own.settings.permissions.blockReadsOutsideWorkingDirectories, own.settings.permissions.blockWritesOutsideWorkingDirectories], [true, true], at)
      // Its temporary folder, where its sandbox gives its commands theirs: the run's short one; and git with no personal
      // settings.
      assert.deepEqual(own.env, { CLAUDE_CODE_TMPDIR: p.scratch.short, GIT_CONFIG_GLOBAL: system === "windows" ? "NUL" : "/dev/null" }, at)
      // The proxies' values never reach its commands.
      assert.deepEqual(own.sandbox.credentials.envVars, p.hidden.map(name => ({ name, mode: "deny" })), at)
      // Its commands never wait for the person: each is in the sandbox, which keeps it to the rest.
      assert.deepEqual(own.settings.permissions.allow, ["Bash"], at)
      // The folder's own settings for the agents celler runs, never written: a run can't set up what an agent starts.
      // Claude Code puts these rules into its sandbox too, for its commands: checked on macOS with a real run.
      assert.deepEqual(own.settings.permissions.deny, AGENT_SETTINGS.flatMap(name => [`Edit(**/${name})`, `Edit(**/${name}/**)`]), at)
      assert.deepEqual([own.settings.disableClaudeAiConnectors, own.settings.autoMemoryEnabled], [true, false], at)
      // Its own tools are a list: none that reach outside the computer, those a coding agent works with, and to read,
      // none that write.
      for (const tool of ["WebFetch", "WebSearch", "RemoteTrigger", "PushNotification", "DesignSync", "SendToProject"]) assert.equal(own.tools.includes(tool), false, `${at}: ${tool}`)
      for (const tool of ["Read", "Glob", "Grep", "Bash", "Agent", "ToolSearch", "AskUserQuestion"]) assert.ok(own.tools.includes(tool), `${at}: ${tool}`)
      for (const tool of ["Write", "Edit", "NotebookEdit"]) assert.equal(own.tools.includes(tool), purpose === "work", `${at}: ${tool}`)
      assert.equal(own.permissionMode, purpose === "work" ? "acceptEdits" : "default", at)
    }
  }
  for (const [system, codex] of Object.entries({ macos: codexOnMacos, linux: codexOnLinux, windows: codexOnWindows })) {
    for (const purpose of ["work", "read"]) {
      const own = codex(p, purpose)
      const at = `Codex on ${system}, to ${purpose}`
      // One profile, the run's own, with no network.
      assert.equal(own.default_permissions, "run", at)
      assert.deepEqual(Object.keys(own.permissions), ["run"], at)
      assert.deepEqual(own.permissions.run.network, { enabled: false }, at)
      // The computer read, but never the person's home or the system's temporary folders, each as a whole; in those,
      // PATH's folders and what the host adds read. Its own home never, wherever it is. To read, the run's scratch
      // written; at work the folder holds it, with no entry of its own the run's commands could put a link in place of.
      const { ":workspace_roots": folder, ...computer } = own.permissions.run.filesystem
      const each = (places, access) => Object.fromEntries(places.map(place => [place, access]))
      const scratch = purpose === "work" ? {} : { [p.scratch.root]: "write" }
      assert.deepEqual(computer, { ":root": "read", [p.home]: "deny", ...each(p.temps, "deny"), ...each([...p.tools, ...p.readable], "read"), ...each(p.agentHomes, "deny"), ...scratch }, at)
      assert.ok(p.scratch.root.startsWith(p.folder + path.sep), at)
      // The folder written at work, else read; its own settings for the agents celler runs never, wherever they are.
      assert.equal(folder["."], purpose === "work" ? "write" : "read", at)
      for (const name of AGENT_SETTINGS) {
        for (const pattern of [`**/${name}`, `**/${name}/**`]) assert.equal(folder[pattern], "deny", `${at}: ${pattern}`)
      }
      // Beyond the sandbox refused, never asked; no web search, no image read from anywhere, no plugins, hooks or memories.
      assert.deepEqual([own.approval_policy, own.web_search], ["never", "disabled"], at)
      for (const feature of ["view_image", "apps", "plugins", "hooks", "memories", "browser_use", "browser_use_external", "computer_use"]) {
        assert.equal(own.features[feature], false, `${at}: ${feature}`)
      }
      // Its commands get Codex's core variables only, nothing named like a key, secret or token, and the run's own home,
      // temporary folder and caches.
      assert.deepEqual([own.shell_environment_policy.inherit, own.shell_environment_policy.ignore_default_excludes], ["core", false], at)
      const set = own.shell_environment_policy.set
      assert.deepEqual([set.HOME, set.TMPDIR, set.XDG_CACHE_HOME, set.GIT_CONFIG_GLOBAL], [p.scratch.home, p.scratch.tmp, p.scratch.cache, system === "windows" ? "NUL" : "/dev/null"], at)
      if (system === "windows") {
        assert.deepEqual([set.USERPROFILE, set.TMP, set.TEMP], [p.scratch.home, p.scratch.tmp, p.scratch.tmp], at)
        assert.deepEqual(own.windows, { sandbox: "elevated" }, at)
      }
    }
  }
})

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

test("Codex's health says, in the host's words, when it isn't found, when it is too old and when it isn't signed in for the host", () => inFolder(async dir => {
  const home = path.join(dir, "home")
  const notFound = await new AgentRuntime(codexAgent({ codex: () => null, home, words: codexWords }), host).health(false)
  assert.deepEqual([notFound.fix, notFound.detail], ["find", `Codex wasn't found on this computer. ${codexWords.install}`])
  // A Codex CLI that says its version, and isn't signed in.
  const cli = version => {
    const file = path.join(dir, `codex-${version}`)
    writeFileSync(file, `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('codex-cli ${version}')\nelse process.exit(1)\n`)
    chmodSync(file, 0o755)
    return file
  }
  const signedOut = await new AgentRuntime(codexAgent({ codex: () => cli(agentVersions.codex), home, words: codexWords }), host).health(false)
  assert.deepEqual([signedOut.fix, signedOut.detail], ["login", `Codex ${agentVersions.codex} · ${codexWords.signedOut}`])
  // One older than its SDK is made with, which no run would work with.
  const old = await new AgentRuntime(codexAgent({ codex: () => cli("0.160.0"), home, words: codexWords }), host).health(false)
  assert.deepEqual([old.ok, old.detail], [false, `Codex 0.160.0 is older than ${agentVersions.codex}, the oldest that runs here: update it.`])
}))

test("each agent's oldest program that runs is the one its installed SDK is made with", () => {
  const sdk = name => JSON.parse(readFileSync(fileURLToPath(new URL(`../node_modules/${name}/package.json`, import.meta.url)), "utf8"))
  assert.equal(agentVersions.claude, sdk("@anthropic-ai/claude-agent-sdk").claudeCodeVersion)
  assert.equal(agentVersions.codex, sdk("@openai/codex-sdk").dependencies["@openai/codex"])
})

test("a run starts only an agent's program new enough to run, with no health check before it, and asks its version again once it changes", () => inFolder(async dir => {
  const program = path.join(dir, "claude")
  const asked = path.join(dir, "asked.log")
  const started = path.join(dir, "started.log")
  // A program that says its version, and otherwise only that it was started.
  const says = version => {
    writeFileSync(program, [
      "#!/usr/bin/env node",
      'const fs = require("node:fs")',
      `if (process.argv[2] === "--version") fs.appendFileSync(${JSON.stringify(asked)}, "${version}\\n"), console.log("${version} (Claude Code)")`,
      `else fs.appendFileSync(${JSON.stringify(started)}, "started\\n")`,
    ].join("\n"))
    chmodSync(program, 0o755)
  }
  says("2.1.30")
  const runtime = new AgentRuntime(claudeAgent({ claude: () => program, words: claudeWords }), host)
  for (let i = 0; i < 2; i++) {
    const old = await runtime.run(spec({ cwd: dir }), () => undefined).done
    assert.deepEqual([old.ok, old.runtimeDown, old.error], [false, true, `Claude Code 2.1.30 is older than ${agentVersions.claude}, the oldest that runs here: update it.`])
  }
  // Asked once, never started.
  assert.deepEqual([readFileSync(asked, "utf8"), existsSync(started)], ["2.1.30\n", false])
  // Updated, it is asked again, and started.
  says(agentVersions.claude)
  const updated = await runtime.run(spec({ cwd: dir }), () => undefined).done
  assert.equal(updated.runtimeDown, false)
  assert.deepEqual([readFileSync(asked, "utf8"), existsSync(started)], [`2.1.30\n${agentVersions.claude}\n`, true])
  // Its version known, as after a health check, its agent starts as its run does: its process is there at once.
  const known = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl") }), host)
  await known.health(false)
  const handle = known.run(spec({ cwd: dir }), () => undefined)
  assert.ok(handle.pid)
  assert.equal((await handle.done).ok, true)
}))

test("Codex installed with npm runs as its own program, found as npm's wrapper finds it, with its helpers on PATH", () => inFolder(dir => {
  const platform = `${process.platform}-${process.arch}`
  const target = CODEX_TARGETS[platform]
  if (!target || process.platform === "win32") return
  // npm's layout: the wrapper in its package, Codex's own program in the package for this system beside it.
  const pkg = path.join(dir, "lib", "node_modules", "@openai", "codex")
  mkdirSync(path.join(pkg, "bin"), { recursive: true })
  writeFileSync(path.join(pkg, "bin", "codex.js"), "")
  const own = path.join(pkg, "node_modules", "@openai", `codex-${platform}`)
  mkdirSync(path.join(own, "vendor", target, "bin"), { recursive: true })
  mkdirSync(path.join(own, "vendor", target, "codex-path"))
  writeFileSync(path.join(own, "package.json"), "{}")
  writeFileSync(path.join(own, "vendor", target, "bin", "codex"), "")
  mkdirSync(path.join(dir, "bin"))
  symlinkSync(path.join(pkg, "bin", "codex.js"), path.join(dir, "bin", "codex"))
  const real = realpathSync(own)
  assert.deepEqual(codexProgram(path.join(dir, "bin", "codex")), { program: path.join(real, "vendor", target, "bin", "codex"), path: [path.join(real, "vendor", target, "codex-path")] })
  // Its own program from another installer starts as it is.
  writeFileSync(path.join(dir, "codex-native"), "")
  assert.deepEqual(codexProgram(path.join(dir, "codex-native")), { program: realpathSync(path.join(dir, "codex-native")), path: [] })
}))

test("an agent's program is found on PATH only in the folders it names in full, never one relative to where the host is", () => inFolder(dir => {
  mkdirSync(path.join(dir, "bin"))
  writeFileSync(path.join(dir, "bin", "claude"), "#!/bin/sh\n")
  chmodSync(path.join(dir, "bin", "claude"), 0o755)
  const was = { path: process.env.PATH, cwd: process.cwd() }
  try {
    // Where its installers put it, if anywhere on this computer: null here.
    process.env.PATH = ""
    const installed = findProgram("claude")
    process.chdir(dir)
    process.env.PATH = "bin"
    assert.equal(findProgram("claude"), installed)
  } finally {
    process.env.PATH = was.path
    process.chdir(was.cwd)
  }
}))

test("Codex's own errands use its own sign-in, in its home: no key, token or endpoint from the person's shell", () => {
  const names = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL"]
  const was = names.map(name => process.env[name])
  for (const name of names) process.env[name] = "from-the-shell"
  try {
    const env = agentEnv(codexAgent({ codex: () => null, home: codexHome, words: codexWords }).env(host), host)
    assert.deepEqual([names.filter(name => env[name] !== undefined), env.CODEX_HOME], [[], codexHome])
  } finally {
    names.forEach((name, i) => (was[i] === undefined ? delete process.env[name] : (process.env[name] = was[i])))
  }
})

test("where the person showed the host each program is kept in full, in a folder made for it", () => inFolder(dir => {
  const file = path.join(dir, "settings", "programs.json")
  const chosen = chosenPrograms(file)
  assert.throws(() => chosen.set("claude", path.join("bin", "claude")), /isn't a full path/)
  const claude = path.join(dir, "bin", "claude")
  chosen.set("claude", claude)
  assert.equal(chosenPrograms(file).get("claude"), claude)
}))

test("Claude Code starts in its settings file for this system, with no settings files of a folder's own and only the host's connectors", () => inFolder(async dir => {
  const log = path.join(dir, "agent.jsonl")
  const runtime = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host)
  const settings = []
  const result = await runtime.run(spec({ cwd: dir, mcpServers: [github], ask: async () => ({ option: "allow" }) }), p => p.type === "settings" && settings.push(p.settings)).done
  assert.equal(result.ok, true, result.error)
  // The person sees the model it runs on by its own name for it, and the mode it runs in.
  assert.deepEqual(settings.at(-1), [{ id: "model", name: "Model", value: "Haiku (fake)" }, { id: "mode", name: "Mode", value: "acceptEdits" }])
  const started = sentTo(log).find(e => e.what === "started").data
  // No settings files of its own, only the host's connectors, the model of its tier, the mode of its file.
  for (const flag of ["--setting-sources=", "--strict-mcp-config", "--model=haiku", "--permission-mode=acceptEdits"]) assert.ok(started.args.includes(flag), `${flag}: ${started.args.join(" ")}`)
  // Its sandbox, its own tools and its permissions are its file's for this system (checked above), with the run's places,
  // its folder by its real path, as its sandbox sees it.
  assert.equal(started.settings.sandbox.enabled, true)
  assert.deepEqual(started.settings.sandbox.filesystem.allowWrite, [realpathSync.native(dir)])
  assert.ok(started.args.includes(`--tools=${claudeOnMacos(placesIn(dir), "work").tools.join(",")}`), started.args.join(" "))
  // The host's own servers gate their calls: Claude Code doesn't ask about them again.
  assert.deepEqual(started.settings.permissions.allow, ["Bash", "mcp__github"])
  // The host by its name, as the Agent SDK has its requests say it.
  assert.equal(started.client, "host/1.0.0")
  // Its own system prompt, which a cell with no context of its own doesn't take away: no prompt in its place.
  assert.equal(sentTo(log).find(e => e.what === "initialize").data.systemPrompt, undefined)
  // To read: nothing that writes, and nothing written but its scratch.
  const read = await runtime.run(spec({ cwd: dir, purpose: "read" }), () => undefined).done
  assert.equal(read.ok, true, read.error)
  const reading = sentTo(log).filter(e => e.what === "started").at(-1).data
  const tools = reading.args.find(arg => arg.startsWith("--tools=")).slice("--tools=".length).split(",")
  assert.deepEqual(["Write", "Edit", "NotebookEdit"].filter(tool => tools.includes(tool)), [])
  assert.equal(reading.settings.sandbox.filesystem.allowWrite.includes(realpathSync.native(dir)), false)
  // A model-only decision: no tools at all, so no sandbox, and no MCP server.
  const decided = await runtime.run(spec({ cwd: dir, purpose: "inference", mcpServers: [github] }), () => undefined).done
  assert.equal(decided.ok, true, decided.error)
  const none = sentTo(log).filter(e => e.what === "started").at(-1).data
  assert.ok(none.args.includes("--tools="), none.args.join(" "))
  assert.equal(none.settings.sandbox, undefined)
  assert.equal(sentTo(log).filter(e => e.what === "initialize").at(-1).data.mcpServers, undefined)
}))

/** A tool that says back the text it was given, and its adapter. */
const echo = { call: async (_run, args) => ({ content: [{ type: "text", text: `echo: ${args.text}` }] }) }
const echoTool = { definition: { inputSchema: { type: "object", properties: { text: { type: "string" } } } }, target: { adapter: "echo" } }

test("an agent knows the host by its name and mark, asks the person before it acts, and ends with its reply and what it spent", () => inFolder(async dir => {
  const log = path.join(dir, "agent.jsonl")
  const asked = [], progress = []
  const result = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host).run(
    spec({ cwd: dir, prompt: "Test it", systemPrompt: "Be brief.", ask: async q => (asked.push([q.title, q.options.map(o => o.kind)]), { option: "allow" }) }),
    p => progress.push(p),
  ).done
  assert.equal(result.ok, true, result.error)
  assert.equal(result.text, "Hello. Ran them.")
  assert.deepEqual(asked, [["Run the tests", ["allow_once", "reject_once"]]])
  // Its session, its call, and what it writes as it streams it.
  assert.ok(progress.some(p => p.type === "session" && p.sessionId === "fake-session"), JSON.stringify(progress))
  assert.ok(progress.some(p => p.type === "tool" && p.summary === "Bash: npm test" && p.call === "t1"), JSON.stringify(progress))
  // A search, by what it looks for rather than where.
  assert.ok(progress.some(p => p.type === "tool" && p.summary === 'Grep "TODO"'), JSON.stringify(progress))
  assert.deepEqual(progress.filter(p => p.type === "text").map(p => p.text).slice(-2), ["Ran th", "Ran them."])
  assert.deepEqual([result.costUsd, result.model, result.usage], [0.01, "claude-haiku-fake", { input: 10, output: 20, cacheRead: 5, cacheWrite5m: 0, cacheWrite1h: 7 }])
  const sent = sentTo(log)
  assert.deepEqual([sent[0].data.mark, sent[0].data.client], ["1", "host/1.0.0"])
  assert.equal(sent.find(e => e.what === "initialize").data.appendSystemPrompt, "Be brief.")
  assert.equal(sent.find(e => e.what === "prompt").data.text, "Test it")
}))

test("Codex's run says what it ran, edited and replied, with its usage and model, and the files it changed", () => inFolder(async dir => {
  const progress = []
  const result = await new AgentRuntime(fakeCodex(codexHome, { FAKE_CODEX_LOG: path.join(dir, "codex.jsonl") }), host).run(spec({ cwd: dir }), p => progress.push(p)).done
  assert.equal(result.ok, true, result.error)
  assert.deepEqual([result.text, result.model, result.costUsd], ["Ran them.", "gpt-6-luna", null])
  assert.deepEqual(result.usage, { input: 10, output: 20, cacheRead: 4, cacheWrite5m: 2, cacheWrite1h: 0 })
  // A command as it was given, not as its shell ran it.
  assert.deepEqual(progress.filter(p => p.type === "tool").map(p => [p.tool, p.summary]), [["execute", "execute: npm test"], ["edit", `edit ${path.join(dir, "notes.md")}`]])
  assert.deepEqual(progress.filter(p => p.type === "file").map(p => p.file), [path.join(dir, "notes.md")])
  assert.deepEqual(progress.find(p => p.type === "session"), { type: "session", sessionId: "fake-thread" })
}))

test("a Codex that ends before it reads a prompt longer than a pipe holds ends a failed run, and the host stays up", () => inFolder(async dir => {
  const uncaught = []
  const onUncaught = err => uncaught.push(err)
  process.on("uncaughtException", onUncaught)
  try {
    const fake = fakeCodex(codexHome, { FAKE_CODEX_LOG: path.join(dir, "codex.jsonl"), FAKE_CODEX_EXIT_AT_ONCE: "1" })
    const result = await new AgentRuntime(fake, host).run(spec({ cwd: dir, prompt: "x".repeat(1024 * 1024) }), () => undefined).done
    assert.equal(result.ok, false)
    assert.match(result.error, /a setting it refuses/)
    // What its pipe said as it closed has been heard by now.
    await delay(200)
  } finally {
    process.off("uncaughtException", onUncaught)
  }
  assert.deepEqual(uncaught.map(err => err.message), [])
}))

test("an agent that isn't signed in takes its runtime offline in the host's words, and a session that is gone says so", () => inFolder(async dir => {
  const claude = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "claude.jsonl"), FAKE_CLAUDE_SIGNED_OUT: "1" }), host).run(spec({ cwd: dir }), () => undefined).done
  assert.deepEqual([claude.ok, claude.runtimeDown, claude.error], [false, true, claudeWords.login])
  const home = codexHome
  const codexLog = path.join(dir, "codex.jsonl")
  const codex = await new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: codexLog, FAKE_CODEX_SIGNED_OUT: "1" }), host).run(spec({ cwd: dir }), () => undefined).done
  assert.deepEqual([codex.ok, codex.runtimeDown, codex.error], [false, true, codexWords.login])
  // A connector's server that says 401 is no sign-in of Codex's own: the run failed, Codex didn't.
  const connector = await new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: codexLog, FAKE_CODEX_MCP_401: "1" }), host).run(spec({ cwd: dir }), () => undefined).done
  assert.deepEqual([connector.ok, connector.runtimeDown], [false, false])
  const gone = await new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: codexLog }), host).run(spec({ cwd: dir, resume: true, sessionId: "missing" }), () => undefined).done
  assert.deepEqual([gone.ok, gone.runtimeDown, gone.error], [false, false, "Session missing could not be resumed: not found"])
}))

test("a question of the agent's own reaches the person as a form with its choices, and the one picked goes back to it", () => inFolder(async dir => {
  const asked = []
  const run = answer => new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl"), FAKE_CLAUDE_QUESTION: "1" }), host).run(spec({ cwd: dir, ask: async q => (asked.push(q.form), answer) }), () => undefined).done
  assert.equal((await run({ accept: true, content: { "Which one?": "B" } })).text, "Hello. Picked B.")
  assert.deepEqual(asked[0].fields, [{ name: "Which one?", title: "Pick", type: "string", required: true, choices: [{ value: "A", label: "A" }, { value: "B", label: "B" }] }])
  assert.equal((await run({ accept: false })).text, "Hello. No pick.")
}))

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

test("a deep health check test-runs the agent once, as a model-only run with no tools, and says how it went", () => inFolder(async dir => {
  const log = path.join(dir, "agent.jsonl")
  const prompts = () => sentTo(log).filter(e => e.what === "prompt")
  const runtime = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host)
  const healthy = await runtime.health(true)
  assert.deepEqual([healthy.ok, healthy.detail], [true, `Claude Code ${agentVersions.claude} · test run succeeded`])
  assert.equal(prompts()[0].data.text, "Reply with exactly: OK")
  const opened = sentTo(log).find(e => e.what === "started").data
  assert.equal(sentTo(log).find(e => e.what === "initialize").data.mcpServers, undefined)
  // In an empty folder of its own, never the temporary folder other programs share, and gone after it.
  assert.equal(path.dirname(opened.cwd), realpathSync(os.tmpdir()))
  assert.match(path.basename(opened.cwd), /^celler-test-run-/)
  assert.equal(existsSync(opened.cwd), false)
  // Without deep, no run at all.
  assert.deepEqual([(await runtime.health(false)).detail, prompts().length], [`Claude Code ${agentVersions.claude} (not yet test-run)`, 1])
  // A test run that doesn't finish in its time: not healthy, and why.
  const slow = await new AgentRuntime({ ...fakeClaude({ FAKE_CLAUDE_LOG: log }), testRunMs: 1 }, host).health(true)
  assert.deepEqual([slow.ok, slow.detail], [false, `Claude Code ${agentVersions.claude} · Timed out after 0 s`])
  // A sign-in it still has but that no longer works: its test run says so, and the host can offer the sign-in again.
  const expired = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_EXPIRED: "1" }), host).health(true)
  assert.deepEqual([expired.ok, expired.fix, expired.detail], [false, "login", `Claude Code ${agentVersions.claude} · ${claudeWords.login}`])
}))

test("an agent's own sign-in gives its page's address as it is, from either of its outputs, and can be called off", async () => {
  // Claude Code's, as a terminal link (OSC 8): its address, then the same as its words.
  const url = "https://claude.ai/oauth/authorize?code=true&client_id=fake-id&state=a_b-c"
  for (const env of [{ FAKE_CLAUDE_LOGIN_URL: url }, { FAKE_CLAUDE_LOGIN_URL: url, FAKE_CLAUDE_LOGIN_ON_STDERR: "1" }]) {
    const login = new AgentRuntime(fakeClaude(env), host).login()
    try {
      assert.equal(await Promise.race([login.url, delay(5_000).then(() => "no address in 5 s")]), url)
    } finally {
      login.cancel()
    }
    // Called off, it ends.
    const ended = await Promise.race([login.done, delay(5_000).then(() => "still going")])
    assert.equal(ended.ok, false)
  }
})

test("a run cancelled asks its agent to end its turn, which keeps its session, and ends cancelled", () => inFolder(async dir => {
  const log = path.join(dir, "agent.jsonl")
  const handle = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SLOW: "10000" }), host).run(spec({ cwd: dir, ask: async () => ({ option: "allow" }) }), () => undefined)
  await until(() => existsSync(log) && sentTo(log).some(e => e.what === "prompt"))
  handle.cancel()
  const result = await handle.done
  assert.deepEqual([result.ok, result.cancelled, result.error], [false, true, "Cancelled"])
  assert.ok(sentTo(log).some(e => e.what === "interrupt"))
}))

test("a run's clock stands still while the person is asked, and a file in its scratch isn't one it changed", () => inFolder(async dir => {
  // Asked for longer than the run may take: the time the person takes isn't the run's.
  const slowly = async () => (await delay(1_500), { option: "allow" })
  const answered = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl") }), host).run(spec({ cwd: dir, timeoutMs: 1_000, ask: slowly }), () => undefined).done
  assert.deepEqual([answered.ok, answered.text], [true, "Hello. Ran them."], answered.error)
  // A time far longer than a timer can wait in one go is still a time to wait: the run's clock is set in steps a timer
  // can take, never past them (Node would then wake it at once, and warn).
  const warned = []
  const onWarning = (w) => warned.push(w.name)
  process.on("warning", onWarning)
  try {
    const long = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl") }), host).run(spec({ cwd: dir, timeoutMs: 2 ** 40, ask: async () => ({ option: "allow" }) }), () => undefined).done
    assert.equal(long.ok, true, long.error)
  } finally {
    process.off("warning", onWarning)
  }
  assert.deepEqual(warned.filter((name) => name === "TimeoutOverflowWarning"), [])
  // What it changes in its scratch goes with it; the rest is the run's, by its path in the folder.
  const files = []
  const fake = fakeClaude()
  const writing = { ...fake, run: async turn => {
    turn.progress({ type: "file", file: path.join(turn.places.scratch.tmp, "cache.json") })
    turn.progress({ type: "file", file: "notes.md" })
    return { ok: true, text: "", usage: {}, costUsd: null, permissionDenials: [] }
  } }
  await new AgentRuntime(writing, host).run(spec({ cwd: dir }), p => p.type === "file" && files.push(p.file)).done
  assert.deepEqual(files, [path.join(dir, "notes.md")])
}))

test("a run whose agent is gone while the person is asked ends there: its clock doesn't start again to stop it later", () => inFolder(async dir => {
  const kill = process.kill
  const grace = harnessLimits.exitGraceMs
  const killed = []
  process.kill = (pid, signal) => (killed.push({ pid, at: Date.now() }), kill.call(process, pid, signal))
  // The grace a stop gives before it insists, short for this test.
  harnessLimits.exitGraceMs = 50
  try {
    const fake = fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl"), FAKE_CLAUDE_EXIT_WHILE_ASKING: "1" })
    // No one answers; the run's end takes the question back.
    const ask = (_q, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve(null), { once: true }))
    const timeoutMs = 1_000
    const handle = new AgentRuntime(fake, host).run(spec({ cwd: dir, timeoutMs, ask }), () => undefined)
    assert.equal((await handle.done).ok, false)
    const ended = Date.now()
    assert.ok(handle.pid)
    // Past its time and the grace a stop gives: what its end stopped (what its commands left running) it stopped at
    // once, and nothing stopped it later.
    await delay(timeoutMs + harnessLimits.exitGraceMs + 300)
    const late = killed.filter(({ pid, at }) => pid === -handle.pid && at > ended + harnessLimits.exitGraceMs + 200)
    assert.deepEqual(late, [])
  } finally {
    process.kill = kill
    harnessLimits.exitGraceMs = grace
  }
}))

/** An adapter whose calls wait for the person in the inbox, and send what the person approved. */
const outbox = {
  prepare: async (_run, args) => ({ account: "office", destination: "outbox", operation: "send", content: { text: args.text }, files: [] }),
  send: async (_run, write) => ({ content: [{ type: "text", text: `sent: ${write.content.text}` }] }),
}
const textInput = { type: "object", properties: { text: { type: "string" } } }
/** A host's office: its desk sends through the outbox, or asks its clerk, who does. */
const office = [
  { kind: "cell", id: "desk", title: "Desk", profile: "desk", exports: ["send", "ask_clerk"] },
  { kind: "tool", id: "send", target: { adapter: "outbox" }, definition: { inputSchema: textInput } },
  { kind: "tool", id: "ask_clerk", target: { cell: "clerk" }, definition: { inputSchema: textInput } },
  { kind: "cell", id: "clerk", title: "Clerk", profile: "clerk", exports: ["send"] },
]
/** The host's run of what it was started with, which may take `timeoutMs`. */
const within = timeoutMs => run => ({ prompt: String(run.input), model: "", sessionId: "", resume: false, timeoutMs })
/** The call waiting for the person in the office's inbox, once one is. */
async function pendingIn(app) {
  await until(() => app.human.inbox("office").some(item => item.state === "pending"))
  return app.human.inbox("office").find(item => item.state === "pending")
}
/**
 * An agent that works in this process, as the runtime runs one: `work` calls the run's tools (with the MCP client's own
 * options for a call, such as its time limit), asks the person and spends time, each cut off once the run is stopped,
 * and its reply is what `work` gives back. Its connection to the run's server is `transport`.
 */
const working = work => ({ ...fakeClaude(), run: async turn => {
  const [server] = turn.spec.mcpServers
  const client = new Client({ name: "agent", version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } })
  await client.connect(transport)
  const stopped = { signal: turn.signal }
  const call = async (name, options = {}) => (await client.callTool({ name, arguments: { text: "hi" } }, undefined, { ...stopped, ...options })).content[0].text
  const ask = async () => (await turn.ask({ call: "t1", tool: "Bash", title: "Run the tests", options: [] }, turn.signal))?.option ?? null
  const spend = ms => delay(ms, undefined, stopped)
  try {
    return { ok: true, text: await work({ call, ask, spend, transport }), usage: {}, costUsd: null, permissionDenials: [] }
  } catch (err) {
    return { ok: false, text: "", usage: {}, costUsd: null, permissionDenials: [], error: err.message }
  } finally {
    await client.close()
  }
} })

test("a run's clock stands still while one of its calls waits for the person in the inbox: approved after longer than the run may take, it ends as its agent did", () => inFolder(async dir => {
  const fake = fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl"), FAKE_CLAUDE_TOOL: "send" })
  const { platform, app } = desk(() => new AgentRuntime(fake, host), { spec: within(1_000) }, new Map([["outbox", outbox]]))
  try {
    const started = app.start({ owner: "office", revision: app.publish(office), entry: "desk", workspace: dir, input: "Send it" })
    const { id } = await pendingIn(app)
    // The person takes longer than the whole run may.
    await delay(1_500)
    await app.human.approve("office", id)
    const result = await started
    assert.equal(result.isError, false, result.structuredContent?.error)
    assert.match(result.content[0].text, /sent: hi$/)
  } finally {
    await platform.close()
  }
}))

test("a run's clock goes on once the person has decided: a run that works on past the time it had left still times out then", () => inFolder(async dir => {
  const heard = []
  // Its call waits in the inbox for longer than the run may take; then it works on for longer than it had left.
  const agent = working(async ({ call, spend }) => {
    heard.push(await call("send"))
    await spend(600)
    return "Done"
  })
  const { platform, app } = desk(() => new AgentRuntime(agent, host), { spec: within(300) }, new Map([["outbox", outbox]]))
  try {
    const started = app.start({ owner: "office", revision: app.publish(office), entry: "desk", workspace: dir, input: "Send it" })
    const { id } = await pendingIn(app)
    await delay(450)
    await app.human.approve("office", id)
    const result = await started
    // It timed out, and only once its call had come back with what was sent.
    assert.deepEqual([heard, result.isError, result.structuredContent.error], [["sent: hi"], true, "Timed out after 0 s"])
  } finally {
    await platform.close()
  }
}))

test("an ask and a call in the inbox at the same time stop a run's clock once: it goes on when the last of them ends, and their time counts once", () => inFolder(async dir => {
  const heard = []
  // It asks before it runs a command while its call waits in the inbox, then works on for longer than it had left.
  const agent = working(async ({ call, ask, spend }) => {
    heard.push(...(await Promise.all([call("send"), ask()])))
    await spend(400)
    return "Done"
  })
  // The ask is answered first, after twice the run's time; the call long after it, alone longer than the run may take.
  const answer = async () => (await delay(400), { option: "allow" })
  const { platform, app } = desk(() => new AgentRuntime(agent, host), { spec: within(200), ask: answer }, new Map([["outbox", outbox]]))
  try {
    const started = app.start({ owner: "office", revision: app.publish(office), entry: "desk", workspace: dir, input: "Send it" })
    const { id } = await pendingIn(app)
    await delay(800)
    await app.human.approve("office", id)
    const result = await started
    // Both came back, and then it had the time it had left as they began, not that and the ask's time again.
    assert.deepEqual([heard, result.isError, result.structuredContent.error], [["sent: hi", "allow"], true, "Timed out after 0 s"])
  } finally {
    await platform.close()
  }
}))

test("a run waits for the person while a run it delegated does: its clock stands still while that run's call waits in the inbox, and while its agent asks", () => inFolder(async dir => {
  // The desk asks its clerk, whose call waits in the inbox and who then asks the person, each longer than either run may take.
  const deskAgent = working(({ call }) => call("ask_clerk"))
  const clerk = working(async ({ call, ask }) => `${await call("send")}, ${await ask()}`)
  const answer = async () => (await delay(450), { option: "allow" })
  const { platform, app, ended } = desk(run => new AgentRuntime(run.parent ? clerk : deskAgent, host), { spec: within(300), ask: answer }, new Map([["outbox", outbox]]))
  try {
    const started = app.start({ owner: "office", revision: app.publish(office), entry: "desk", workspace: dir, input: "Ask the clerk" })
    const { id } = await pendingIn(app)
    await delay(450)
    await app.human.approve("office", id)
    const result = await started
    assert.deepEqual([result.isError, result.content[0].text], [false, "sent: hi, allow"])
    assert.deepEqual(ended.map(r => r.ok), [true, true])
  } finally {
    await platform.close()
  }
}))

test("a delegated run's ask stops its caller's clock only until the ask is taken back: once that run has ended, the caller's clock goes on, though the host never answers", () => inFolder(async dir => {
  const heard = []
  // The desk asks its clerk, then works on for longer than it has; the clerk asks the person, and ends before an answer.
  const deskAgent = working(async ({ call, spend }) => {
    heard.push(await call("ask_clerk"))
    await spend(600)
    return "Done"
  })
  const clerk = working(async ({ ask, spend }) => {
    void ask()
    await spend(100)
    return "Gone"
  })
  // A host that never answers, not even once the ask is taken back.
  const answer = () => new Promise(() => undefined)
  const { platform, app } = desk(run => new AgentRuntime(run.parent ? clerk : deskAgent, host), { spec: within(300), ask: answer }, new Map([["outbox", outbox]]))
  try {
    const result = await app.start({ owner: "office", revision: app.publish(office), entry: "desk", workspace: dir, input: "Ask the clerk" })
    assert.deepEqual([heard, result.isError, result.structuredContent.error], [["Gone"], true, "Timed out after 0 s"])
  } finally {
    await platform.close()
  }
}))

test("a call its agent withdraws while it waits in the inbox stays there for the person, and the run's clock goes on from then, as when the agent's own limit on a call ends it", () => inFolder(async dir => {
  const heard = []
  // Its own limit on the call, longer than the run may take, ends the call while it waits; then it works on for longer
  // than it had left.
  const agent = working(async ({ call, spend }) => {
    heard.push(await call("send", { timeout: 450 }).catch(err => err.message))
    await spend(600)
    return "Done"
  })
  const { platform, app } = desk(() => new AgentRuntime(agent, host), { spec: within(300) }, new Map([["outbox", outbox]]))
  try {
    const result = await app.start({ owner: "office", revision: app.publish(office), entry: "desk", workspace: dir, input: "Send it" })
    assert.deepEqual([heard, result.isError, result.structuredContent.error], [["MCP error -32001: Request timed out"], true, "Timed out after 0 s"])
    // Left for the person, who may still decide it; the run's history has the call withdrawn.
    const [item] = app.human.inbox("office")
    assert.equal(item.state, "pending")
    assert.deepEqual(app.history("office", item.run).map(e => e.kind), ["started", "call", "cancelled", "ended"])
  } finally {
    await platform.close()
  }
}))

test("a call whose agent goes before its answer is cut off as a withdrawn one is: its approval stays for the person, and the run's clock goes on", () => inFolder(async dir => {
  const heard = []
  let gone
  const going = new Promise(resolve => (gone = resolve))
  // Its connection goes while its call waits in the inbox, with nothing sent to withdraw the call; then it works on for
  // longer than it had left.
  const agent = working(async ({ call, spend, transport }) => {
    const calling = call("send").catch(err => err.message)
    await going
    await transport.close()
    heard.push(await calling)
    await spend(600)
    return "Done"
  })
  const { platform, app } = desk(() => new AgentRuntime(agent, host), { spec: within(300) }, new Map([["outbox", outbox]]))
  try {
    const started = app.start({ owner: "office", revision: app.publish(office), entry: "desk", workspace: dir, input: "Send it" })
    const { run } = await pendingIn(app)
    gone()
    const result = await started
    assert.deepEqual([heard, result.isError, result.structuredContent.error], [["MCP error -32000: Connection closed"], true, "Timed out after 0 s"])
    assert.equal(app.human.inbox("office")[0].state, "pending")
    assert.deepEqual(app.history("office", run).map(e => e.kind), ["started", "call", "cancelled", "ended"])
  } finally {
    await platform.close()
  }
}))

test("what a run's commands leave running ends with the run", () => inFolder(async dir => {
  // Windows keeps no process group to end.
  if (process.platform === "win32") return
  const left = path.join(dir, "left.pid")
  const fake = fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl"), FAKE_CLAUDE_LEAVE_RUNNING: left })
  const result = await new AgentRuntime(fake, host).run(spec({ cwd: dir, ask: async () => ({ option: "allow" }) }), () => undefined).done
  assert.equal(result.ok, true, result.error)
  const pid = Number(readFileSync(left, "utf8"))
  const running = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  await until(() => !running(), 2_000)
}))

test("an agent that ends cleanly is stopped once, and never sent SIGKILL: a group that is gone gets nothing more", () => inFolder(async dir => {
  // Windows keeps no process group to end.
  if (process.platform === "win32") return
  const kill = process.kill
  const grace = harnessLimits.exitGraceMs
  const sent = []
  process.kill = (pid, signal) => (sent.push([pid, signal]), kill.call(process, pid, signal))
  // The grace a stop gives before it insists, short for this test.
  harnessLimits.exitGraceMs = 50
  try {
    const handle = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "agent.jsonl") }), host).run(spec({ cwd: dir, ask: async () => ({ option: "allow" }) }), () => undefined)
    const result = await handle.done
    assert.equal(result.ok, true, result.error)
    await delay(harnessLimits.exitGraceMs * 6)
    assert.deepEqual(sent.filter(([pid]) => pid === -handle.pid), [[-handle.pid, "SIGTERM"]])
  } finally {
    process.kill = kill
    harnessLimits.exitGraceMs = grace
  }
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

/**
 * A host's office of one cell, `desk`, run by `runtime`, with more of the platform's options and the host's adapters if
 * given: its platform, app and revision, and what each run ended with.
 */
function desk(runtime, more = {}, adapters = new Map()) {
  const ended = []
  const platform = harnessPlatform({
    runtime,
    allowed: () => true,
    server: "office",
    spec: run => ({ prompt: String(run.input), model: "", sessionId: "", resume: false, timeoutMs: 20_000 }),
    ended: (_run, result) => ended.push(result),
    ...more,
  })
  const app = createApp({ database: new DatabaseSync(":memory:"), platform, adapters })
  const revision = app.publish([{ kind: "cell", id: "desk", title: "Desk", profile: "any", exports: [] }])
  return { platform, app, revision, ended }
}

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
        call = client.callTool({ name: "wait", arguments: {} }).finally(() => client.close())
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
