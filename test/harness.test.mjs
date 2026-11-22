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
import { AgentRuntime, claudeAgent, codexAgent, codexHomeConfig, harnessPlatform, SimulatedRuntime } from "celler/harness"
import { acpMcpServers } from "../dist/harness/acp.js"
import { harnessLimits } from "../dist/limits.js"
import { PROXIES, runEnv } from "../dist/harness/programs.js"
import claudeOnLinux from "../dist/harness/sandbox/claude.linux.js"
import claudeOnMacos from "../dist/harness/sandbox/claude.macos.js"
import claudeOnWindows from "../dist/harness/sandbox/claude.windows.js"
import * as codexOnLinux from "../dist/harness/sandbox/codex.linux.js"
import * as codexOnMacos from "../dist/harness/sandbox/codex.macos.js"
import * as codexOnWindows from "../dist/harness/sandbox/codex.windows.js"
import { AGENT_SETTINGS, removeScratch, scratchFor, SECRET_NAMES, secretsIn, systemTemps, toolchainOf } from "../dist/harness/sandbox/places.js"
import { until } from "./support.mjs"

const host = { client: { name: "host", title: "Host", version: "1.0.0" }, mark: env => ({ ...env, HOST_RUN: "1" }) }
const claudeWords = { noAdapter: "No adapter in this host.", noClaude: "Claude Code isn't here.", login: "Sign in to Claude in the host." }
const codexWords = { install: "Install Codex.", login: "Sign Codex in to the host.", signedOut: "not signed in for the host", untrusted: "Trust this folder with Codex first." }
const agentScript = fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url))
const spec = (over = {}) => ({ cwd: os.tmpdir(), prompt: "x", systemPrompt: "", model: "fast", sessionId: "s", resume: false, mcpServers: [], purpose: "work", timeoutMs: 20_000, ...over })
/** A run's places, as sandbox/places.ts works them out: under `dir`, with one of each kind, its scratch in its folder. */
const placesIn = dir => ({
  folder: path.join(dir, "work"),
  scratch: { root: path.join(dir, "work", ".celler", "run-1"), tmp: path.join(dir, "work", ".celler", "run-1", "tmp"), home: path.join(dir, "work", ".celler", "run-1", "home"), cache: path.join(dir, "work", ".celler", "run-1", "cache"), short: "/private/tmp/celler-run1" },
  temps: ["/tmp", "/private/tmp"],
  home: os.homedir(),
  data: path.join(dir, "data"),
  toolchain: ["/opt/tools/bin", "/opt/tools"],
  readable: [path.join(dir, "repo", ".git")],
  secrets: [path.join(dir, "work", ".env")],
  hidden: ["CELLER_VALUE_0", "HTTPS_PROXY"],
})
const github = { name: "github", transport: "http", command: "", args: [], env: {}, url: "https://api.example.com/mcp/", headers: { Authorization: "Bearer t0ken" } }
const inFolder = async work => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "celler-harness-"))
  try {
    return await work(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
/** What the fake agent was sent, in order. */
const sentTo = log => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))
/** The fake agent as an agent entry: in its first mode, its instructions ahead of the prompt, with these variables. */
const fakeAgent = env => ({
  kind: "fake", name: "Fake", label: "fake-acp-agent",
  find: () => ({ adapter: agentScript, program: agentScript }),
  program: () => agentScript,
  env: () => ({}),
  version: async () => "Fake 9.9.9",
  signedIn: { args: ["--version"], yes: () => true },
  login: { args: [], fix: "login", signedOut: "", hint: "" },
  testRunMs: 20_000,
  placeholders: false,
  nativeDiscovery: false,
  start: s => ({ env, mode: "default", preamble: s.systemPrompt }),
})

test("connector values reach Claude Code as placeholders it expands from its environment, and a program the agent would start is refused", () => {
  assert.deepEqual(acpMcpServers([github], false), {
    mcpServers: [{ type: "http", name: "github", url: "https://api.example.com/mcp/", headers: [{ name: "Authorization", value: "${CELLER_VALUE_0}" }] }],
    env: { CELLER_VALUE_0: "Bearer t0ken" },
  })
  assert.deepEqual(acpMcpServers([github], true).mcpServers[0].headers, [{ name: "Authorization", value: "Bearer t0ken" }])
  assert.throws(() => acpMcpServers([{ ...github, transport: "stdio" }], false), /started by the host/)
})

test("Claude Code says in the host's words when its adapter or the program isn't there", async () => {
  const missing = new AgentRuntime(claudeAgent({ adapter: null, claude: () => null, words: claudeWords }), host)
  assert.equal((await missing.health(false)).detail, claudeWords.noAdapter)
  const run = await missing.run(spec(), () => undefined).done
  assert.deepEqual([run.runtimeDown, run.error], [true, claudeWords.noAdapter])
  const noClaude = new AgentRuntime(claudeAgent({ adapter: agentScript, claude: () => null, words: claudeWords }), host)
  const health = await noClaude.health(false)
  assert.deepEqual([health.fix, health.detail, health.path], ["find-claude", claudeWords.noClaude, agentScript])
  assert.deepEqual(noClaude.login(), { error: claudeWords.noClaude })
})

test("Codex works in the host's profile, its folder written at work and only read otherwise, and only in a folder the person trusts", () => inFolder(home => {
  const codex = codexAgent({ adapter: agentScript, codex: () => null, home, profile: "host", words: codexWords })
  const places = placesIn(home)
  const start = over => codex.start(spec(over), { adapter: agentScript, program: "codex" }, places)
  assert.throws(() => start({ trusted: false }), { message: codexWords.untrusted })
  assert.equal(start({ trusted: true }).mode, "permission-profile:host")
  // To read, a model-only decision, and a run that names no purpose: the profile that writes nothing.
  for (const purpose of ["read", "inference", undefined]) assert.equal(start({ trusted: true, purpose }).mode, "permission-profile:host-read")
  // A tier as Codex's own model for it, and the run's own places in its session's settings, as its file puts them.
  const config = JSON.parse(start({ trusted: true }).env.CODEX_CONFIG)
  assert.deepEqual(config, { model: "gpt-6-luna", ...codexOnMacos.run(places, "work", "host"), ...(process.platform === "win32" ? codexOnWindows.run(places, "work", "host") : {}) })
  // A model-only decision runs no command.
  assert.deepEqual(JSON.parse(start({ purpose: "inference" }).env.CODEX_CONFIG), { model: "gpt-6-luna", features: { shell_tool: false } })
  // It names some files from the run's folder; its own, in its home, aren't the run's.
  assert.equal(start({ trusted: true }).file(path.join(home, "sessions", "x.jsonl")), null)
  assert.equal(start({ trusted: true, cwd: "/work" }).file("notes.md"), path.join("/work", "notes.md"))
  codex.ready()
  assert.equal(readFileSync(path.join(home, "config.toml"), "utf8"), codexHomeConfig("host"))
  // Each system's own file: Windows' differs from the others, so the choice shows.
  assert.equal(codexHomeConfig("host", "win32"), codexOnWindows.home("host"))
  assert.notEqual(codexHomeConfig("host", "win32"), codexHomeConfig("host", "linux"))
  assert.throws(() => codexHomeConfig("host", "freebsd"), /no sandbox settings for freebsd/)
  assert.deepEqual(codex.env("/bin/codex"), { CODEX_HOME: home, CODEX_PATH: "/bin/codex" })
}))

test("each harness's settings for each system keep its commands to the folder, off the network and away from secrets", () => {
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
      // Never read: the person's home, the host's data, the system's temporary folders and secret files; read again: the
      // folder, the run's short folder (its shell's temporary one, never the one all of the person's Claude Code shares),
      // its toolchain and what the host adds, and nothing else.
      assert.deepEqual(own.sandbox.filesystem.denyRead, [p.home, p.data, ...p.temps, ...p.secrets], at)
      assert.deepEqual(own.sandbox.filesystem.allowRead, [p.folder, p.scratch.short, ...p.toolchain, ...p.readable], at)
      // Its temporary folder, where its sandbox gives its commands theirs: the run's short one; and git with no personal
      // settings, which its commands can't read.
      assert.deepEqual(own.env, { CLAUDE_CODE_TMPDIR: p.scratch.short, GIT_CONFIG_GLOBAL: system === "windows" ? "NUL" : "/dev/null" }, at)
      // The connectors' values and the proxies' never reach its commands.
      assert.deepEqual(own.sandbox.credentials.envVars, p.hidden.map(name => ({ name, mode: "deny" })), at)
      // Its commands never wait for the person: each is in the sandbox, which keeps it to the rest.
      assert.deepEqual(own.settings.permissions.allow, ["Bash"], at)
      // Its own file tools: in the folder only, and never a secret file there.
      assert.deepEqual([own.settings.permissions.blockReadsOutsideWorkingDirectories, own.settings.permissions.blockWritesOutsideWorkingDirectories], [true, true], at)
      // Claude Code puts these into its sandbox too, for its commands: checked on macOS with a real run.
      for (const name of SECRET_NAMES) {
        assert.ok(own.settings.permissions.deny.includes(`Read(**/${name})`), `${at}: ${name}`)
        assert.ok(own.settings.permissions.deny.includes(`Edit(**/${name})`), `${at}: ${name}`)
      }
      // The folder's own settings for the agents celler runs, never written: one run can't set up what another starts.
      for (const name of AGENT_SETTINGS) {
        assert.ok(own.settings.permissions.deny.includes(`Edit(**/${name})`), `${at}: ${name}`)
        assert.ok(own.settings.permissions.deny.includes(`Edit(**/${name}/**)`), `${at}: ${name}`)
      }
      assert.deepEqual([own.settings.disableClaudeAiConnectors, own.settings.autoMemoryEnabled], [true, false], at)
      // Nothing of its own that reaches outside; to read, nothing that writes.
      const off = ["WebFetch", "WebSearch", ...(purpose === "read" ? ["Edit", "Write", "MultiEdit", "NotebookEdit"] : [])]
      assert.ok(off.every(tool => own.disallowedTools.includes(tool)), at)
      assert.equal(own.mode, purpose === "work" ? "acceptEdits" : "default", at)
    }
  }
  for (const [system, codex] of Object.entries({ macos: codexOnMacos, linux: codexOnLinux, windows: codexOnWindows })) {
    const config = codex.home("host")
    const at = `Codex on ${system}`
    // Two profiles: at work its folder written, to read only read; both with the system's essentials, and no network.
    assert.match(config, /^default_permissions = "host"\n/, at)
    assert.match(config, /\[permissions\.host\.filesystem\.":workspace_roots"\]\n"\." = "write"\n/, at)
    assert.match(config, /\[permissions\.host-read\.filesystem\.":workspace_roots"\]\n"\." = "read"\n/, at)
    assert.equal(config.match(/\[permissions\.host(-read)?\.network\]\nenabled = false\n/g).length, 2, at)
    // Every place either profile grants, reads too: the system's essentials, and the run's folder.
    assert.deepEqual(config.match(/^"[^"\n]*" = "(read|write)"$/gm).sort(), ['":minimal" = "read"', '":minimal" = "read"', '"." = "read"', '"." = "write"'].sort(), at)
    // In the folder, in either profile, wherever they are and whenever they were made: files named for secrets never,
    // nor its own settings for the agents celler runs, so one run can't set up what another starts.
    for (const table of ["host", "host-read"]) {
      const folder = config.split(`[permissions.${table}.filesystem.":workspace_roots"]\n`)[1].split("\n\n")[0]
      for (const name of SECRET_NAMES) assert.ok(folder.includes(`"**/${name}" = "deny"`), `${at}, ${table}: ${name}`)
      for (const name of AGENT_SETTINGS) {
        for (const row of [`"**/${name}" = "deny"`, `"**/${name}/**" = "deny"`]) assert.ok(folder.includes(row), `${at}, ${table}: ${row}`)
      }
    }
    // Beyond the sandbox refused, never asked; no web search, no image read from anywhere, no plugins, hooks or memories.
    assert.match(config, /sandbox_approval = false/, at)
    assert.match(config, /\nweb_search = "disabled"\n/, at)
    for (const feature of ["view_image", "apps", "plugins", "hooks", "memories", "browser_use", "browser_use_external", "computer_use"]) {
      assert.match(config, new RegExp(`\\n${feature} = false\\n`), `${at}: ${feature}`)
    }
    // Its commands get Codex's core variables only, and nothing named like a key, secret or token.
    assert.match(config, /\[shell_environment_policy\]\ninherit = "core"\nignore_default_excludes = false\n/, at)
    if (system === "windows") assert.match(config, /\[windows\]\nsandbox = "elevated"\n/, at)
    for (const purpose of ["work", "read"]) {
      const own = codex.run(p, purpose, "host")
      // Its places, in the profile it runs in, as Codex's config.toml takes them (`"<path>" = "read" | "write" | "deny"`):
      // its scratch written; its toolchain and what the host adds read; the temporary folders and secret files, never.
      const profile = own.permissions[purpose === "work" ? "host" : "host-read"].filesystem
      assert.deepEqual(profile, Object.fromEntries([[p.scratch.root, "write"], ...p.toolchain.map(dir => [dir, "read"]), ...p.readable.map(dir => [dir, "read"]), ...[...p.temps, ...p.secrets].map(place => [place, "deny"])]), `${at}, to ${purpose}`)
      // Nothing but the two profiles: a table beside them would be a profile of its own, which no run is in.
      assert.deepEqual(Object.keys(own.permissions), [purpose === "work" ? "host" : "host-read"], `${at}, to ${purpose}`)
      assert.ok(p.scratch.root.startsWith(p.folder + path.sep), at)
      // Its commands' home, temporary folder and caches are its own.
      assert.equal(own.shell_environment_policy.set.HOME, p.scratch.home, at)
      assert.equal(own.shell_environment_policy.set.TMPDIR, p.scratch.tmp, at)
      assert.equal(own.shell_environment_policy.set.XDG_CACHE_HOME, p.scratch.cache, at)
      if (system === "windows") {
        assert.equal(own.shell_environment_policy.set.USERPROFILE, p.scratch.home, at)
        assert.deepEqual([own.shell_environment_policy.set.TMP, own.shell_environment_policy.set.TEMP], [p.scratch.tmp, p.scratch.tmp], at)
      }
    }
    // With no secret file in the folder, the system's temporary folders are still closed.
    const closed = Object.entries(codex.run({ ...p, secrets: [] }, "work", "host").permissions.host.filesystem).filter(([, access]) => access === "deny")
    assert.deepEqual(closed.map(([place]) => place), p.temps, at)
  }
})

test("a run's places are its own: secret files found, its toolchain read, nothing of the person's environment, its scratch gone after it", () => inFolder(async dir => {
  // Secret files anywhere in the folder, but not in what tools fetch or the repository's own data.
  const folder = path.join(dir, "work")
  for (const file of [".env", "app/.env.production", "keys/id_ed25519", "certs/site.pem", "node_modules/x/.env", ".git/.env", "notes.md"]) {
    mkdirSync(path.dirname(path.join(folder, file)), { recursive: true })
    writeFileSync(path.join(folder, file), "x")
  }
  assert.deepEqual(secretsIn(folder).map(f => path.relative(folder, f)).sort(), [".env", path.join("app", ".env.production"), path.join("certs", "site.pem"), path.join("keys", "id_ed25519")].sort())
  // The programs on its PATH, and where each is installed, by their real paths: never the home folder or the root.
  const prefix = path.join(dir, "tools")
  mkdirSync(path.join(prefix, "bin"), { recursive: true })
  assert.deepEqual(toolchainOf([path.join(prefix, "bin"), os.homedir(), "relative/bin", path.join(dir, "gone")].join(path.delimiter), os.homedir()), [path.join(prefix, "bin"), prefix].map(dir => realpathSync(dir)))
  // In the person's home: a folder on its PATH, and where its programs are installed, also where one links to; never
  // a folder right inside the home folder, which holds more than programs (`~/.local`, `~/.cargo`), nor the host's data.
  const home = path.join(dir, "home")
  const ruff = path.join(home, ".local", "share", "uv", "tools", "ruff")
  const nvm = path.join(home, ".nvm", "versions", "node", "v24")
  const data = path.join(dir, "data")
  for (const bin of [path.join(home, ".local", "bin"), path.join(ruff, "bin"), path.join(nvm, "bin"), path.join(home, ".cargo", "bin"), path.join(data, "bin")]) mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(ruff, "bin", "ruff"), "")
  symlinkSync(path.join(ruff, "bin", "ruff"), path.join(home, ".local", "bin", "ruff"))
  // Links left behind by what was uninstalled, before and after it: passed over, the others still read.
  for (const gone of ["a-gone", "q-gone", "z-gone"]) symlinkSync(path.join(home, "nowhere", gone), path.join(home, ".local", "bin", gone))
  const onPath = [path.join(home, ".local", "bin"), path.join(nvm, "bin"), path.join(home, ".cargo", "bin"), path.join(data, "bin"), home, dir]
  assert.deepEqual(toolchainOf(onPath.join(path.delimiter), home, data), [path.join(home, ".local", "bin"), ruff, path.join(nvm, "bin"), nvm, path.join(home, ".cargo", "bin"), path.join(data, "bin")].map(dir => realpathSync(dir)))
  // Its environment: what programs need, its own temporary folder and caches; a token in the person's shell, never.
  process.env.CELLER_TEST_TOKEN = "s3cret"
  try {
    const places = placesIn(dir)
    const env = runEnv({ cmd: "x", args: [], node: false }, { OWN: "1" }, host, places)
    assert.equal(env.CELLER_TEST_TOKEN, undefined)
    assert.deepEqual([env.TMPDIR, env.XDG_CACHE_HOME, env.HOST_RUN, env.OWN, env.PATH], [places.scratch.tmp, places.scratch.cache, "1", "1", process.env.PATH])
    assert.ok(PROXIES.includes("HTTPS_PROXY"))
  } finally {
    delete process.env.CELLER_TEST_TOKEN
  }
  // The system's temporary folders, as they really are, to close: never a link to one, which would close paths through it.
  assert.ok(systemTemps().includes(realpathSync(os.tmpdir())))
  assert.ok(systemTemps().every(dir => realpathSync(dir) === dir))
  // Its scratch folder is made inside its folder for the run, and gone once it ends, with the folder that held it.
  const seen = []
  const scratching = { ...fakeAgent({ FAKE_ACP_LOG: path.join(dir, "agent.jsonl") }), start: (s, _found, places) => (seen.push(places.scratch), { mode: "default", preamble: s.systemPrompt }) }
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

test("Codex's health says, in the host's words, when it isn't found and when it isn't signed in for the host", () => inFolder(async dir => {
  const adapter = path.join(dir, "codex-acp.mjs")
  writeFileSync(adapter, "")
  const home = path.join(dir, "home")
  const notFound = await new AgentRuntime(codexAgent({ adapter, codex: () => null, home, profile: "host", words: codexWords }), host).health(false)
  assert.deepEqual([notFound.fix, notFound.detail], ["find-codex", `Codex wasn't found on this computer. ${codexWords.install}`])
  // A Codex CLI that knows its version, and isn't signed in.
  const cli = path.join(dir, "codex")
  writeFileSync(cli, "#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('codex-cli 0.166.0')\nelse process.exit(1)\n")
  chmodSync(cli, 0o755)
  const signedOut = await new AgentRuntime(codexAgent({ adapter, codex: () => cli, home, profile: "host", words: codexWords }), host).health(false)
  assert.deepEqual([signedOut.fix, signedOut.detail], ["login-codex", `Codex 0.166.0 · ${codexWords.signedOut}`])
}))

test("Claude Code starts in its settings file for this system, with no settings files of a folder's own and only the host's connectors", () => inFolder(async dir => {
  // The stand-in says what it was sent in its own folder: a run's environment carries nothing else of the test's.
  const log = path.join(dir, "agent.jsonl")
  const data = path.join(dir, "data")
  const runtime = new AgentRuntime(claudeAgent({ adapter: agentScript, claude: () => agentScript, words: claudeWords }), { ...host, data })
  const settings = []
  const result = await runtime.run(spec({ cwd: dir, mcpServers: [github], ask: async () => ({ option: "yes" }) }), p => p.type === "settings" && settings.push(p.settings)).done
  assert.equal(result.ok, true, result.error)
  // The person sees the mode it was switched to, even from an agent whose own list of options still says the old one.
  assert.deepEqual(settings.at(-1), [{ id: "mode", name: "Mode", value: "Accept edits" }])
  const sent = sentTo(log)
  const { options } = sent.find(e => e.what === "session/new").data.meta.claudeCode
  assert.deepEqual([options.settingSources, options.strictMcpConfig, options.allowDangerouslySkipPermissions, options.model], [[], true, false, "haiku"])
  // Its sandbox, its own tools and its permissions are its file's for this system (checked above), with the run's places.
  assert.equal(options.sandbox.enabled, true)
  assert.deepEqual(options.sandbox.filesystem.allowWrite.slice(0, 1), [dir])
  assert.ok(options.sandbox.filesystem.denyRead.includes(data))
  assert.deepEqual(options.sandbox.credentials.envVars, [{ name: "CELLER_VALUE_0", mode: "deny" }])
  assert.ok(options.disallowedTools.includes("WebFetch"))
  // The host's own servers gate their calls: Claude Code doesn't ask about them again.
  assert.deepEqual(options.allowedTools, ["mcp__github"])
  assert.deepEqual(sent.find(e => e.what === "session/set_mode").data, { mode: "acceptEdits" })
  // To read, and for a host that names no purpose: nothing that writes, and nothing to switch to.
  for (const purpose of ["read", undefined]) {
    const run = await runtime.run({ ...spec({ cwd: dir }), purpose }, () => undefined).done
    assert.equal(run.ok, true, run.error)
    const read = sentTo(log).filter(e => e.what === "session/new").at(-1).data.meta.claudeCode.options
    assert.ok(read.disallowedTools.includes("Write"))
    assert.equal(read.sandbox.filesystem.allowWrite.includes(dir), false)
  }
  // A model-only decision: no tools at all, so no sandbox.
  const decided = await runtime.run(spec({ cwd: dir, purpose: "inference" }), () => undefined).done
  assert.equal(decided.ok, true, decided.error)
  const none = sentTo(log).filter(e => e.what === "session/new").at(-1).data.meta.claudeCode.options
  assert.deepEqual([none.tools, none.sandbox], [[], undefined])
}))

/** A tool that says back the text it was given, and its adapter. */
const echo = { call: async (_run, args) => ({ content: [{ type: "text", text: `echo: ${args.text}` }] }) }
const echoTool = { definition: { inputSchema: { type: "object", properties: { text: { type: "string" } } } }, target: { adapter: "echo" } }

test("an agent over ACP knows the host by its name and mark, asks the person before it acts, and ends with its reply", () => inFolder(async dir => {
  const log = path.join(dir, "agent.jsonl")
  const fake = fakeAgent({ FAKE_ACP_LOG: log })
  const asked = [], progress = []
  const result = await new AgentRuntime(fake, host).run(
    spec({ cwd: dir, prompt: "Test it", systemPrompt: "Be brief.", ask: async q => (asked.push(q.title), { option: "yes" }) }),
    p => progress.push(p),
  ).done
  assert.equal(result.ok, true, result.error)
  assert.match(result.text, /Ran them\.$/)
  assert.deepEqual(asked, ["Run the tests"])
  assert.ok(progress.some(p => p.type === "text"), JSON.stringify(progress))
  assert.ok(progress.some(p => p.type === "session" && p.sessionId === "fake-session"), JSON.stringify(progress))
  assert.ok(progress.some(p => p.type === "update" && p.update.sessionUpdate === "agent_message_chunk"), JSON.stringify(progress))
  // Its modes as it says them, in the mode it runs in.
  assert.ok(progress.some(p => p.type === "options" && p.modes?.currentModeId === "default"), JSON.stringify(progress))
  const sent = sentTo(log)
  assert.deepEqual(sent.find(e => e.what === "initialize").data, { clientInfo: host.client, mark: "1" })
  assert.match(sent.find(e => e.what === "session/prompt").data.text, /^Be brief\.[\s\S]*Test it$/)
  // Already in the mode it starts in: not switched.
  assert.equal(sent.some(e => e.what === "session/set_mode"), false)
}))

test("a run of the published graph reaches its cell's tools through the harness, on the run's own MCP server", () => inFolder(async dir => {
  const log = path.join(dir, "agent.jsonl")
  const runs = new Set()
  const platform = harnessPlatform({
    runtime: run => (run.profile === "fake" ? new AgentRuntime(fakeAgent({ FAKE_ACP_LOG: log, FAKE_ACP_TOOL: "echo" }), host) : undefined),
    allowed: () => true,
    server: "office",
    spec: run => ({ prompt: String(run.input), model: "", sessionId: "", resume: false, timeoutMs: 20_000 }),
    progress: run => runs.add(run.id),
  })
  const app = createApp({ database: new DatabaseSync(":memory:"), platform, adapters: new Map([["echo", echo]]) })
  const revision = app.publish([
    { kind: "cell", id: "desk", title: "Desk", profile: "fake", context: ["Be brief."], exports: ["echo"] },
    { kind: "tool", id: "echo", ...echoTool },
  ])
  try {
    const result = await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "Use echo" })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.match(result.content[0].text, /echo: hi$/)
    assert.equal(result.structuredContent.ok, true)
    const sent = sentTo(log)
    // The cell's context as its instructions, and the run's server under the host's name, with a token of its own.
    assert.match(sent.find(e => e.what === "session/prompt").data.text, /^Be brief\.[\s\S]*Use echo$/)
    const [server] = sent.find(e => e.what === "session/new").data.servers
    assert.equal(server.name, "office")
    assert.match(server.headers[0].value, /^Bearer \S+$/)
    // The call went through celler: in the run's history.
    const [run] = runs
    assert.deepEqual(app.history("office", run).filter(e => e.kind === "call").map(e => e.detail.id), ["echo"])
  } finally {
    await platform.close()
  }
}))

test("an agent that searches its tools itself is given them all, and any other gets celler's menu", () => inFolder(async dir => {
  const listed = async nativeDiscovery => {
    const log = path.join(dir, `agent-${nativeDiscovery}.jsonl`)
    const platform = harnessPlatform({
      runtime: () => new AgentRuntime({ ...fakeAgent({ FAKE_ACP_LOG: log, FAKE_ACP_TOOL: "echo" }), nativeDiscovery }, host),
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
  const claude = new AgentRuntime(claudeAgent({ adapter: null, claude: () => null, words: claudeWords }), host)
  const codex = new AgentRuntime(codexAgent({ adapter: null, codex: () => null, home: dir, profile: "host", words: codexWords }), host)
  assert.deepEqual([claude.nativeDiscovery, codex.nativeDiscovery, new SimulatedRuntime().nativeDiscovery], [true, true, undefined])
}))

test("a model-only decision gets no MCP server, not even the run's own", () => inFolder(async dir => {
  const log = path.join(dir, "agent.jsonl")
  const platform = harnessPlatform({
    runtime: () => new AgentRuntime(fakeAgent({ FAKE_ACP_LOG: log }), host),
    allowed: () => true,
    server: "office",
    spec: () => ({ prompt: "Pick one", model: "", sessionId: "", resume: false, timeoutMs: 20_000, purpose: "inference", mcpServers: [github] }),
  })
  const app = createApp({ database: new DatabaseSync(":memory:"), platform, adapters: new Map() })
  const revision = app.publish([{ kind: "cell", id: "choose", title: "Choose", profile: "any", exports: [] }])
  try {
    const result = await app.start({ owner: "office", revision, entry: "choose", workspace: dir, input: "x" })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.deepEqual(sentTo(log).find(e => e.what === "session/new").data.servers, [])
  } finally {
    await platform.close()
  }
}))

test("what an agent asks before it acts reaches the host with the run it asks in, and with no one to ask it doesn't go ahead", () => inFolder(async dir => {
  const asked = []
  const reply = async ask => {
    const { platform, app, revision } = desk(() => new AgentRuntime(fakeAgent({ FAKE_ACP_LOG: path.join(dir, "agent.jsonl") }), host), ask ? { ask } : {})
    try {
      const result = await app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "Test it" })
      assert.equal(result.isError, false, JSON.stringify(result))
      return result.content[0].text
    } finally {
      await platform.close()
    }
  }
  // The host answers it, for the run it came from.
  assert.match(await reply(async (run, q) => (asked.push([run.entry, q.title, q.kind]), { option: "yes" })), /Ran them\.$/)
  assert.deepEqual(asked, [["desk", "Run the tests", "execute"]])
  // A host that asks no one: what the agent asks about doesn't happen.
  assert.match(await reply(undefined), /Didn't run them\.$/)
}))

test("a deep health check test-runs the agent once, as a model-only run with no tools, and says how it went", () => inFolder(async dir => {
  const log = path.join(dir, "agent.jsonl")
  const prompts = () => sentTo(log).filter(e => e.what === "session/prompt")
  const runtime = new AgentRuntime(fakeAgent({ FAKE_ACP_LOG: log }), host)
  const healthy = await runtime.health(true)
  assert.deepEqual([healthy.ok, healthy.detail], [true, "Fake 9.9.9 · test run succeeded"])
  assert.match(prompts()[0].data.text, /Reply with exactly: OK$/)
  const opened = sentTo(log).find(e => e.what === "session/new").data
  assert.deepEqual(opened.servers, [])
  // In an empty folder of its own, never the temporary folder other programs share, and gone after it.
  assert.equal(path.dirname(opened.cwd), os.tmpdir())
  assert.match(path.basename(opened.cwd), /^celler-test-run-/)
  assert.equal(existsSync(opened.cwd), false)
  // Without deep, no run at all.
  assert.deepEqual([(await runtime.health(false)).detail, prompts().length], ["Fake 9.9.9 (not yet test-run)", 1])
  // A test run that doesn't finish in its time: not healthy, and why.
  const slow = await new AgentRuntime({ ...fakeAgent({ FAKE_ACP_LOG: log }), testRunMs: 1 }, host).health(true)
  assert.deepEqual([slow.ok, slow.detail], [false, "Fake 9.9.9 · Timed out after 0 s"])
}))

test("a run whose agent is gone while the person is asked ends there: its clock doesn't start again to stop it later", () => inFolder(async dir => {
  const kill = process.kill
  const grace = harnessLimits.exitGraceMs
  const killed = []
  process.kill = (pid, signal) => (killed.push({ pid, at: Date.now() }), kill.call(process, pid, signal))
  // The grace a stop gives before it insists, short for this test.
  harnessLimits.exitGraceMs = 50
  try {
    const fake = fakeAgent({ FAKE_ACP_LOG: path.join(dir, "agent.jsonl"), FAKE_ACP_EXIT_WHILE_ASKING: "1" })
    // No one answers; the run's end takes the question back.
    const ask = (_q, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve(null), { once: true }))
    const timeoutMs = 1_000
    const handle = new AgentRuntime(fake, host).run(spec({ cwd: dir, timeoutMs, ask }), () => undefined)
    assert.equal((await handle.done).ok, false)
    const ended = Date.now()
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
  const fake = fakeAgent({ FAKE_ACP_LOG: path.join(dir, "agent.jsonl"), FAKE_ACP_LEAVE_RUNNING: left })
  const result = await new AgentRuntime(fake, host).run(spec({ cwd: dir, ask: async () => ({ option: "yes" }) }), () => undefined).done
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
  const { platform, app, ended } = desk(run => (run.profile === "desk" ? new AgentRuntime(fakeAgent({ FAKE_ACP_LOG: log, FAKE_ACP_TOOL: "helper" }), host) : broken))
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
  const { platform, app } = desk(() => new AgentRuntime(fakeAgent({ FAKE_ACP_LOG: path.join(dir, "agent.jsonl"), FAKE_ACP_TOOL: "echo" }), host), {}, new Map([["echo", echo]]))
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
  const { platform, app } = desk(() => new AgentRuntime(fakeAgent({ FAKE_ACP_LOG: log }), host))
  const deskWith = context => app.publish([{ kind: "cell", id: "desk", title: "Desk", profile: "any", exports: [], context }])
  const start = revision => app.start({ owner: "office", revision, entry: "desk", workspace: dir, input: "Go" })
  try {
    await start(deskWith(["Be brief.", { type: "resource", resource: { uri: "policy://mail", text: "Never email customers." } }]))
    assert.match(sentTo(log).find(e => e.what === "session/prompt").data.text, /^Be brief\.\n\nNever email customers\.[\s\S]*Go$/)
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
