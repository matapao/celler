// One runtime for either coding agent (agents.ts): whether it can run, its own sign-in, and its runs over ACP (acp.ts).

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { harnessLimits } from "../limits.js"
import { acpMcpServers, killTree, runAcp, Turn } from "./acp.js"
import type { Agent, Start } from "./agents.js"
import { agentEnv, launchFor, PROXIES, runEnv, runForOutput } from "./programs.js"
import { inside, placesFor, removeFolder, removeScratch, scratchFor, type Places } from "./sandbox/places.js"
import { errorText, failedRun, type AgentLogin, type Host, type RunHandle, type RunProgress, type Runtime, type RuntimeHealth, type RunSpec } from "./types.js"

export class AgentRuntime implements Runtime {
  readonly kind: string
  readonly nativeDiscovery: boolean

  constructor(
    readonly agent: Agent,
    private host: Host,
  ) {
    this.kind = agent.kind
    this.nativeDiscovery = agent.nativeDiscovery
  }

  /** Found, its version, signed in; with `deep`, a tiny test run too. */
  async health(deep: boolean): Promise<RuntimeHealth> {
    const { agent } = this
    const checkedAt = Date.now()
    const found = agent.find()
    if ("missing" in found) return { ok: false, checkedAt, detail: found.missing, ...(found.fix ? { fix: found.fix } : {}), ...(found.path ? { path: found.path } : {}) }
    const at = { path: found.adapter, program: found.program }
    agent.ready?.()
    const ask = (file: string, args: string[], anyExit = false) => {
      const launch = launchFor(file)
      return runForOutput(launch, args, agentEnv(launch, agent.env(found.program), this.host), anyExit)
    }
    const [version, answer] = await Promise.all([agent.version(found, ask), ask(found.program, agent.signedIn.args, agent.signedIn.anyExit)])
    if (typeof version !== "string") return { ok: false, checkedAt, ...at, detail: version.error }
    if (agent.signedIn.yes(answer) === false) return { ok: false, checkedAt, ...at, fix: agent.login.fix, detail: `${version} · ${agent.login.signedOut}` }
    if (!deep) return { ok: true, checkedAt, ...at, detail: `${version} (not yet test-run)` }
    // In an empty folder of its own, which no other program or person shares, gone after it.
    const folder = mkdtempSync(path.join(os.tmpdir(), "celler-test-run-"))
    try {
      const test = { cwd: folder, prompt: "Reply with exactly: OK", systemPrompt: "", model: "fast", sessionId: randomUUID(), resume: false, mcpServers: [], purpose: "inference" as const, timeoutMs: agent.testRunMs }
      const r = await this.run(test, () => undefined).done
      return { ok: r.ok, checkedAt, ...at, detail: `${version} · ${r.ok ? "test run succeeded" : (r.error ?? "test run failed")}` }
    } finally {
      await removeFolder(folder)
    }
  }

  /** Starts the agent's own sign-in, or says why it can't. */
  login(): AgentLogin | { error: string } {
    const program = this.agent.program()
    if (typeof program !== "string") return program
    this.agent.ready?.()
    return startLogin(program, this.agent.login.args, this.agent.env(program), this.host)
  }

  run(spec: RunSpec, onProgress: (p: RunProgress) => void): RunHandle {
    const { agent } = this
    const found = agent.find()
    if ("missing" in found) return failedRun(found.missing, true)
    if (!existsSync(spec.cwd)) return failedRun(`Workspace folder not found: ${spec.cwd}`)
    let mcp: ReturnType<typeof acpMcpServers>
    let start: Start
    try {
      mcp = acpMcpServers(spec.mcpServers, !agent.placeholders)
    } catch (err) {
      return failedRun(errorText(err))
    }
    // Its own scratch folder inside its folder, removed when it ends, and where its commands may go (sandbox/places.ts).
    let places: Places
    try {
      const hidden = [...Object.keys(mcp.env), ...PROXIES.filter((name) => process.env[name] !== undefined)]
      places = placesFor({ folder: spec.cwd, scratch: scratchFor(spec.cwd), data: this.host.data, pathVariable: process.env.PATH ?? "", readable: spec.readable, hidden })
    } catch (err) {
      return failedRun(`${agent.name} could not be set up for this run: ${errorText(err)}`)
    }
    const removed = () => removeScratch(places.scratch)
    try {
      agent.ready?.()
      start = agent.start(spec, found, places)
    } catch (err) {
      void removed()
      return failedRun(`${agent.name} could not be set up for this run: ${errorText(err)}`)
    }
    const launch = launchFor(found.adapter)
    // Its own user's environment, marked as the host's run, before the connectors' values go in, as they are.
    const env = { ...runEnv(launch, { ...agent.env(found.program), ...start.env }, this.host, places), ...mcp.env }
    // A file it changed is the run's, unless it is in its scratch, which goes when it ends.
    const inScratch = (file: string) => inside(places.scratch.root, path.resolve(spec.cwd, file))
    const progress = (p: RunProgress) => {
      if (p.type !== "file") return onProgress(p)
      const file = start.file ? start.file(p.file) : p.file
      if (file && !inScratch(file)) onProgress({ ...p, file })
    }
    const turn = new Turn(progress, start.modelKey, spec.ask, spec.cwd)
    const handle = runAcp({ spec, host: this.host, launch, env, mcpServers: mcp.mcpServers, start, label: agent.label, loginHint: agent.login.hint, turn })
    void handle.done.then(removed, removed)
    return handle
  }
}

/** An agent's own sign-in: it opens the browser and prints the page's address; a code the page shows goes to its input. */
function startLogin(program: string, args: string[], add: Record<string, string>, host: Host): AgentLogin {
  const launch = launchFor(program)
  const child = spawn(launch.cmd, [...launch.args, ...args], { env: agentEnv(launch, add, host), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" })
  let output = ""
  let errors = ""
  let gotUrl: (u: string | null) => void = () => undefined
  const url = new Promise<string | null>((resolve) => (gotUrl = resolve))
  child.stdout.on("data", (c: Buffer) => {
    output = (output + c.toString("utf8")).slice(-harnessLimits.stderrChars)
    // The address once its line is complete: output can arrive mid-address.
    const m = /https:\/\/\S+(?=\s)/.exec(output)
    if (m) gotUrl(m[0])
  })
  child.stderr.on("data", (c: Buffer) => (errors = (errors + c.toString("utf8")).slice(-harnessLimits.stderrChars)))
  child.stdin.on("error", () => undefined)
  const timer = setTimeout(() => killTree(child), harnessLimits.loginMs)
  const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    child.on("error", (err) => resolve({ ok: false, error: err.message }))
    child.on("close", (code) => {
      clearTimeout(timer)
      gotUrl(null)
      const last = (text: string) => text.trim().split("\n").filter(Boolean).at(-1)
      resolve(code === 0 ? { ok: true } : { ok: false, error: last(errors) ?? last(output) ?? `Login ended with code ${code}` })
    })
  })
  return { url, done, sendCode: (code) => void child.stdin.write(`${code.trim()}\n`) }
}
