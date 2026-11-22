import assert from "node:assert/strict"
import test from "node:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CallToolResultSchema, CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { createApp } from "celler"
import { AgentRuntime, claudeAgent, codexAgent, harnessPlatform, SimulatedRuntime } from "celler/harness"
import { CODEX_HOME_CONFIG } from "../dist/harness/agents.js"
import { agentVersions, harnessLimits } from "../dist/limits.js"
import { CODEX_TARGETS, codexProgram, PROXIES, runEnv } from "../dist/harness/programs.js"
import claudeOnLinux from "../dist/harness/sandbox/claude.linux.js"
import claudeOnMacos from "../dist/harness/sandbox/claude.macos.js"
import claudeOnWindows from "../dist/harness/sandbox/claude.windows.js"
import codexOnLinux from "../dist/harness/sandbox/codex.linux.js"
import codexOnMacos from "../dist/harness/sandbox/codex.macos.js"
import codexOnWindows from "../dist/harness/sandbox/codex.windows.js"
import { AGENT_SETTINGS, homeTools, removeScratch, scratchFor, systemTemps } from "../dist/harness/sandbox/places.js"
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

test("connector values reach Claude Code in its first request and Codex in variables of its own, never on a command line, and a program the agent would start is refused", () => inFolder(async dir => {
  const log = path.join(dir, "claude.jsonl")
  const claude = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host).run(spec({ cwd: dir, mcpServers: [github] }), () => undefined).done
  assert.equal(claude.ok, true, claude.error)
  const sent = sentTo(log)
  assert.deepEqual(sent.find(e => e.what === "initialize").data.mcpServers, { github: { type: "http", url: github.url, headers: github.headers } })
  assert.equal(sent.find(e => e.what === "started").data.args.some(arg => arg.includes("t0ken")), false)
  const codexLog = path.join(dir, "codex.jsonl")
  const codex = await new AgentRuntime(fakeCodex(path.join(dir, "codex-home"), { FAKE_CODEX_LOG: codexLog }), host).run(spec({ cwd: dir, mcpServers: [github] }), () => undefined).done
  assert.equal(codex.ok, true, codex.error)
  const exec = sentTo(codexLog)[0].data
  assert.ok(exec.configs.includes(`mcp_servers={ github = { url = "${github.url}", env_http_headers = { Authorization = "CELLER_VALUE_0" }, default_tools_approval_mode = "approve" } }`), exec.configs.join("\n"))
  assert.deepEqual(exec.values, { CELLER_VALUE_0: "Bearer t0ken" })
  assert.equal(exec.args.some(arg => arg.includes("t0ken")), false)
  // A connector's program is the host's to start.
  const stdio = await new AgentRuntime(fakeClaude(), host).run(spec({ cwd: dir, mcpServers: [{ ...github, transport: "stdio" }] }), () => undefined).done
  assert.match(stdio.error, /started by the host, never by the agent$/)
}))

test("Claude Code says in the host's words when its program isn't there", async () => {
  const missing = new AgentRuntime(claudeAgent({ claude: () => null, words: claudeWords }), host)
  const health = await missing.health(false)
  assert.deepEqual([health.ok, health.fix, health.detail], [false, "find-claude", claudeWords.noClaude])
  const run = await missing.run(spec(), () => undefined).done
  assert.deepEqual([run.runtimeDown, run.error], [true, claudeWords.noClaude])
  assert.deepEqual(missing.login(), { error: claudeWords.noClaude })
})

test("Codex runs in a profile of the run's own, its folder written at work and only read otherwise, in the host's Codex home, which trusts no folder", () => inFolder(async dir => {
  const home = path.join(dir, "codex-home")
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
      // Never read: the system's temporary folders, as a whole; the person's home and other users' folders are closed by
      // Claude Code's own rule. Read again: the folder, the run's short folder (its shell's temporary one), PATH's
      // folders in the home and what the host adds, and nothing else.
      assert.deepEqual(own.sandbox.filesystem.denyRead, p.temps, at)
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
      // PATH's folders and what the host adds read, and the run's scratch written, to read too.
      const { ":workspace_roots": folder, ...computer } = own.permissions.run.filesystem
      const each = (places, access) => Object.fromEntries(places.map(place => [place, access]))
      assert.deepEqual(computer, { ":root": "read", [p.home]: "deny", ...each(p.temps, "deny"), ...each([...p.tools, ...p.readable], "read"), [p.scratch.root]: "write" }, at)
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
  assert.ok(systemTemps().includes(realpathSync(os.tmpdir())))
  assert.ok(systemTemps().every(dir => realpathSync(dir) === dir))
  // PATH's folders in the home, by their real paths: never the home itself, nor what isn't there or isn't in it.
  const home = realpathSync(dir)
  mkdirSync(path.join(home, ".nvm", "bin"), { recursive: true })
  assert.deepEqual(homeTools([path.join(home, ".nvm", "bin"), home, "/usr/bin", "relative/bin", path.join(home, "gone")].join(path.delimiter), home), [path.join(home, ".nvm", "bin")])
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

test("Codex's health says, in the host's words, when it isn't found, when it is too old and when it isn't signed in for the host", () => inFolder(async dir => {
  const home = path.join(dir, "home")
  const notFound = await new AgentRuntime(codexAgent({ codex: () => null, home, words: codexWords }), host).health(false)
  assert.deepEqual([notFound.fix, notFound.detail], ["find-codex", `Codex wasn't found on this computer. ${codexWords.install}`])
  // A Codex CLI that says its version, and isn't signed in.
  const cli = version => {
    const file = path.join(dir, `codex-${version}`)
    writeFileSync(file, `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('codex-cli ${version}')\nelse process.exit(1)\n`)
    chmodSync(file, 0o755)
    return file
  }
  const signedOut = await new AgentRuntime(codexAgent({ codex: () => cli(agentVersions.codex), home, words: codexWords }), host).health(false)
  assert.deepEqual([signedOut.fix, signedOut.detail], ["login-codex", `Codex ${agentVersions.codex} · ${codexWords.signedOut}`])
  // One older than its SDK is made with, which no run would work with.
  const old = await new AgentRuntime(codexAgent({ codex: () => cli("0.160.0"), home, words: codexWords }), host).health(false)
  assert.deepEqual([old.ok, old.detail], [false, `Codex 0.160.0 is older than ${agentVersions.codex}, the oldest that runs here: update it.`])
}))

test("each agent's oldest program that runs is the one its installed SDK is made with", () => {
  const sdk = name => JSON.parse(readFileSync(fileURLToPath(new URL(`../node_modules/${name}/package.json`, import.meta.url)), "utf8"))
  assert.equal(agentVersions.claude, sdk("@anthropic-ai/claude-agent-sdk").claudeCodeVersion)
  assert.equal(agentVersions.codex, sdk("@openai/codex-sdk").dependencies["@openai/codex"])
})

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
  // Its sandbox, its own tools and its permissions are its file's for this system (checked above), with the run's places.
  assert.equal(started.settings.sandbox.enabled, true)
  assert.deepEqual(started.settings.sandbox.filesystem.allowWrite, [dir])
  assert.ok(started.args.includes(`--tools=${claudeOnMacos(placesIn(dir), "work").tools.join(",")}`), started.args.join(" "))
  // The host's own servers gate their calls: Claude Code doesn't ask about them again.
  assert.deepEqual(started.settings.permissions.allow, ["Bash", "mcp__github"])
  // The host by its name, as the Agent SDK has its requests say it.
  assert.equal(started.client, "host/1.0.0")
  // To read: nothing that writes, and nothing written but its scratch.
  const read = await runtime.run(spec({ cwd: dir, purpose: "read" }), () => undefined).done
  assert.equal(read.ok, true, read.error)
  const reading = sentTo(log).filter(e => e.what === "started").at(-1).data
  const tools = reading.args.find(arg => arg.startsWith("--tools=")).slice("--tools=".length).split(",")
  assert.deepEqual(["Write", "Edit", "NotebookEdit"].filter(tool => tools.includes(tool)), [])
  assert.equal(reading.settings.sandbox.filesystem.allowWrite.includes(dir), false)
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
  assert.deepEqual(progress.filter(p => p.type === "text").map(p => p.text).slice(-2), ["Ran th", "Ran them."])
  assert.deepEqual([result.costUsd, result.model, result.usage], [0.01, "claude-haiku-fake", { input: 10, output: 20, cacheRead: 5, cacheWrite5m: 0, cacheWrite1h: 7 }])
  const sent = sentTo(log)
  assert.deepEqual([sent[0].data.mark, sent[0].data.client], ["1", "host/1.0.0"])
  assert.equal(sent.find(e => e.what === "initialize").data.appendSystemPrompt, "Be brief.")
  assert.equal(sent.find(e => e.what === "prompt").data.text, "Test it")
}))

test("Codex's run says what it ran, edited and replied, with its usage and model, and the files it changed", () => inFolder(async dir => {
  const progress = []
  const result = await new AgentRuntime(fakeCodex(path.join(dir, "home"), { FAKE_CODEX_LOG: path.join(dir, "codex.jsonl") }), host).run(spec({ cwd: dir }), p => progress.push(p)).done
  assert.equal(result.ok, true, result.error)
  assert.deepEqual([result.text, result.model, result.costUsd], ["Ran them.", "gpt-6-luna", null])
  assert.deepEqual(result.usage, { input: 10, output: 20, cacheRead: 4, cacheWrite5m: 2, cacheWrite1h: 0 })
  // A command as it was given, not as its shell ran it.
  assert.deepEqual(progress.filter(p => p.type === "tool").map(p => [p.tool, p.summary]), [["execute", "execute: npm test"], ["edit", `edit ${path.join(dir, "notes.md")}`]])
  assert.deepEqual(progress.filter(p => p.type === "file").map(p => p.file), [path.join(dir, "notes.md")])
  assert.deepEqual(progress.find(p => p.type === "session"), { type: "session", sessionId: "fake-thread" })
}))

test("an agent that isn't signed in takes its runtime offline in the host's words, and a session that is gone says so", () => inFolder(async dir => {
  const claude = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, "claude.jsonl"), FAKE_CLAUDE_SIGNED_OUT: "1" }), host).run(spec({ cwd: dir }), () => undefined).done
  assert.deepEqual([claude.ok, claude.runtimeDown, claude.error], [false, true, claudeWords.login])
  const home = path.join(dir, "home")
  const codexLog = path.join(dir, "codex.jsonl")
  const codex = await new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: codexLog, FAKE_CODEX_SIGNED_OUT: "1" }), host).run(spec({ cwd: dir }), () => undefined).done
  assert.deepEqual([codex.ok, codex.runtimeDown, codex.error], [false, true, codexWords.login])
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
    const platform = harnessPlatform({
      runtime: run => (run.profile === profile ? new AgentRuntime(agent, host) : undefined),
      allowed: () => true,
      server: "office",
      spec: run => ({ prompt: String(run.input), model: "", sessionId: "", resume: false, timeoutMs: 20_000 }),
      progress: run => runs.add(run.id),
    })
    const app = createApp({ database: new DatabaseSync(":memory:"), platform, adapters: new Map([["echo", echo]]) })
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
  // Codex: the same, its token in a variable of its own.
  const codexLog = path.join(dir, "codex.jsonl")
  const exec = (await ran("codex", fakeCodex(path.join(dir, "home"), { FAKE_CODEX_LOG: codexLog, FAKE_CODEX_TOOL: "echo" }), codexLog)).find(e => e.what === "exec").data
  assert.match(exec.prompt, /^Be brief\.\n\n---\n\nUse echo$/)
  assert.match(exec.values.CELLER_VALUE_0, /^Bearer \S+$/)
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
  const platform = harnessPlatform({
    runtime: () => new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host),
    allowed: () => true,
    server: "office",
    spec: () => ({ prompt: "Pick one", model: "", sessionId: "", resume: false, timeoutMs: 20_000, purpose: "inference", mcpServers: [github] }),
  })
  const app = createApp({ database: new DatabaseSync(":memory:"), platform, adapters: new Map() })
  const revision = app.publish([{ kind: "cell", id: "choose", title: "Choose", profile: "any", exports: [] }])
  try {
    const result = await app.start({ owner: "office", revision, entry: "choose", workspace: dir, input: "x" })
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
}))

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

test("cancellation while the host prepares a run prevents the agent from starting", () => inFolder(async dir => {
  const controller = new AbortController()
  let started = false
  const platform = harnessPlatform({
    runtime: () => ({ run: () => {
      started = true
      throw new Error("cancelled run started")
    } }),
    allowed: () => true,
    server: "office",
    spec: () => {
      controller.abort()
      return { prompt: "x", model: "", sessionId: "", resume: false, timeoutMs: 20_000 }
    },
  })
  const app = createApp({ database: new DatabaseSync(":memory:"), platform, adapters: new Map() })
  const revision = app.publish([{ kind: "cell", id: "desk", title: "Desk", profile: "fake", exports: [] }])
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
    const heard = await Promise.race([call.then(() => "answered", error => error.message), delay(2_000).then(() => "nothing")])
    assert.match(heard, /aborted/)
  } finally {
    await platform.close()
  }
}))
