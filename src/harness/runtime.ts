// One runtime for either coding agent (agents.ts): whether it can run, its own sign-in, and its runs, each through the
// agent's own SDK (claude.ts, codex.ts). What a run is given (Turn) is the same for both: its places, its environment,
// its clock, which stands still while the person is asked, and an end to what its agent leaves running.

import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { harnessLimits as L } from "../limits.js"
import type { Agent } from "./agents.js"
import { agentEnv, PROXIES, runEnv, runForOutput } from "./programs.js"
import { inside, placesFor, removeFolder, removeScratch, scratchFor, type Places } from "./sandbox/places.js"
import { errorText, failedRun, failure, type AgentLogin, type Host, type RunHandle, type RunProgress, type RunResult, type Runtime, type RuntimeHealth, type RunSpec } from "./types.js"

const isWin = process.platform === "win32"

/** What one run of an agent is given, the same whichever SDK runs it. */
export interface Turn {
  spec: RunSpec
  /** The agent's own program, as it starts. */
  program: string
  places: Places
  /** Its environment: its user's, the run's own folders, the agent's own variables. */
  env: NodeJS.ProcessEnv
  /** Aborted when the run is cancelled or out of time: the agent ends its turn, or is stopped. */
  signal: AbortSignal
  /** Puts what the agent asks to the person, the run's clock stopped meanwhile; missing when no one is asked. */
  ask?: NonNullable<RunSpec["ask"]>
  progress(p: RunProgress): void
  /** Starts one of the agent's processes: in its own process group, with no window, its error output kept. */
  spawn(command: string, args: string[], o: { cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }): ChildProcessWithoutNullStreams
  /** The end of what its processes said on their error output. */
  stderr(): string
}

/** An agent's settings file for this system, or why there is none: nothing runs where no sandbox is set up. */
export function forThisSystem<T>(files: Partial<Record<NodeJS.Platform, T>>, name: string, platform: NodeJS.Platform = process.platform): T {
  const file = files[platform]
  if (!file) throw new Error(`${name} has no sandbox settings for ${platform} here`)
  return file
}

/** The files given with a task, as links its agent can open: no words of the host's. */
export function attachmentLinks(files: RunSpec["attachments"]): string {
  return (files ?? []).map((a) => `[${a.name}](${pathToFileURL(a.path).href})`).join("\n")
}

/** A run's time as people say it: in whole minutes, else in seconds. */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds > 0 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`
}

/** Whether a version ("2.1.300") is older than another, part by part. */
function older(version: string, than: string): boolean {
  const [a, b] = [version, than].map((v) => v.split(".").map(Number))
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}

/** Stops a process and everything it started: asks, then insists. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (isWin) {
    if (child.exitCode === null) execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined)
    return
  }
  // It leads its own process group (spawned detached), which outlives it while anything it started runs.
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s)
    } catch {
      /* nothing left */
    }
  }
  signal("SIGTERM")
  setTimeout(() => signal("SIGKILL"), L.exitGraceMs).unref()
}

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

  /** Found, new enough, signed in; with `deep`, a tiny test run too. */
  async health(deep: boolean): Promise<RuntimeHealth> {
    const { agent } = this
    const checkedAt = Date.now()
    const found = agent.find()
    if (typeof found !== "string") return { ok: false, checkedAt, detail: found.missing, ...(found.fix ? { fix: found.fix } : {}) }
    agent.ready?.()
    const { program } = agent.started(found)
    const env = agentEnv(agent.env(this.host), this.host)
    const [said, answer] = await Promise.all([runForOutput(program, ["--version"], env), runForOutput(program, agent.signedIn.args, env, agent.signedIn.anyExit)])
    const version = said ? agent.version.of(said) : null
    if (!version) return { ok: false, checkedAt, program: found, detail: `Could not run ${found} --version.` }
    const named = `${agent.name} ${version}`
    if (older(version, agent.version.oldest)) return { ok: false, checkedAt, program: found, detail: `${named} is older than ${agent.version.oldest}, the oldest that runs here: update it.` }
    if (agent.signedIn.yes(answer) === false) return { ok: false, checkedAt, program: found, fix: agent.login.fix, detail: `${named} · ${agent.login.signedOut}` }
    if (!deep) return { ok: true, checkedAt, program: found, detail: `${named} (not yet test-run)` }
    // In an empty folder of its own, which no other program or person shares, gone after it.
    const folder = mkdtempSync(path.join(os.tmpdir(), "celler-test-run-"))
    try {
      const test = { cwd: folder, prompt: "Reply with exactly: OK", systemPrompt: "", model: "fast", sessionId: randomUUID(), resume: false, mcpServers: [], purpose: "inference" as const, timeoutMs: agent.testRunMs }
      const r = await this.run(test, () => undefined).done
      return { ok: r.ok, checkedAt, program: found, detail: `${named} · ${r.ok ? "test run succeeded" : (r.error ?? "test run failed")}` }
    } finally {
      await removeFolder(folder)
    }
  }

  /** Starts the agent's own sign-in, or says why it can't. */
  login(): AgentLogin | { error: string } {
    const found = this.agent.find()
    if (typeof found !== "string") return { error: found.missing }
    this.agent.ready?.()
    return startLogin(this.agent.started(found).program, this.agent.login.args, agentEnv(this.agent.env(this.host), this.host))
  }

  run(spec: RunSpec, onProgress: (p: RunProgress) => void): RunHandle {
    const { agent } = this
    const found = agent.find()
    if (typeof found !== "string") return failedRun(found.missing, true)
    if (!existsSync(spec.cwd)) return failedRun(`Workspace folder not found: ${spec.cwd}`)
    const stdio = spec.mcpServers.find((s) => s.transport === "stdio")
    if (stdio) return failedRun(`${stdio.name}: a connector's program is started by the host, never by the agent`)
    // Its own scratch folder inside its folder, removed when it ends, and where its commands may go (sandbox/places.ts).
    let places: Places
    let started: ReturnType<Agent["started"]>
    try {
      places = placesFor({ folder: spec.cwd, scratch: scratchFor(spec.cwd), readable: spec.readable, hidden: PROXIES.filter((name) => process.env[name] !== undefined) })
    } catch (err) {
      return failedRun(`${agent.name} could not be set up for this run: ${errorText(err)}`)
    }
    try {
      agent.ready?.()
      started = agent.started(found)
    } catch (err) {
      void removeScratch(places.scratch)
      return failedRun(`${agent.name} could not be set up for this run: ${errorText(err)}`)
    }
    // Its own user's environment, marked as the host's run, with the folders its program needs on PATH.
    const own = agent.env(this.host)
    const env = runEnv(started.path.length ? { ...own, PATH: [...started.path, process.env.PATH ?? ""].join(path.delimiter) } : own, this.host, places)

    // The run's clock stands still while the person is asked. A run that is over, stopped or ended, takes its asks back:
    // then its clock never starts again, and nothing stops it any more.
    const stopping = new AbortController()
    const asking = new AbortController()
    const over = () => asking.signal.aborted
    let stopped: "cancelled" | "timed out" | null = null
    let deadline = Date.now() + spec.timeoutMs
    let waiting = 0
    let pausedAt = 0
    let timer: NodeJS.Timeout | undefined
    const arm = () => {
      if (over()) return
      clearTimeout(timer)
      timer = setTimeout(() => stop("timed out"), Math.max(0, deadline - Date.now()))
    }
    const meanwhile = async <T>(asked: () => Promise<T>): Promise<T> => {
      if (waiting++ === 0) {
        pausedAt = Date.now()
        clearTimeout(timer)
      }
      try {
        return await asked()
      } finally {
        if (--waiting === 0) {
          deadline += Date.now() - pausedAt
          arm()
        }
      }
    }

    // What the agent starts, each in its own process group, so its end ends what its commands left running.
    const children: { child: ChildProcess; exited: Promise<void> }[] = []
    let stderr = ""
    const spawnAgent: Turn["spawn"] = (command, args, o) => {
      const child = spawn(command, args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: !isWin })
      child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr = (stderr + c).slice(-L.stderrChars)))
      // An answer to one that has gone finds no one there: that ends nothing else.
      child.stdin.on("error", () => undefined)
      child.on("error", () => undefined)
      children.push({ child, exited: new Promise((resolve) => child.once("exit", () => resolve())) })
      return child
    }
    // Asked to end its turn (its session stays resumable), and what it started stopped if it doesn't end in its grace.
    let ended = false
    const stop = (why: "cancelled" | "timed out") => {
      if (over()) return
      stopped = why
      asking.abort()
      stopping.abort()
      setTimeout(() => {
        if (!ended) for (const { child } of children) killTree(child)
      }, L.exitGraceMs).unref()
    }
    // A file it changed is the run's, unless it is in its scratch, which goes when it ends.
    const progress = (p: RunProgress) => {
      if (p.type !== "file") return onProgress(p)
      const file = path.resolve(spec.cwd, p.file)
      if (!inside(places.scratch.root, file)) onProgress({ type: "file", file })
    }
    const ask = spec.ask
    const turn: Turn = {
      spec,
      program: started.program,
      places,
      env,
      signal: stopping.signal,
      ...(ask ? { ask: (q, signal) => meanwhile(() => ask(q, AbortSignal.any([signal, asking.signal])).catch(() => null)) } : {}),
      progress,
      spawn: spawnAgent,
      stderr: () => stderr,
    }
    const end = (r: RunResult): RunResult => {
      if (stopped === "cancelled") return { ...r, ok: false, cancelled: true, error: "Cancelled" }
      if (stopped === "timed out") return { ...r, ok: false, error: `Timed out after ${duration(spec.timeoutMs)}` }
      return r
    }
    arm()
    const done = agent
      .run(turn)
      .then(end, (err: unknown) => end(failure(errorText(err).slice(0, L.errorChars))))
      .finally(() => {
        ended = true
        clearTimeout(timer)
        asking.abort()
        // What its commands left running ends with it, once it has exited, or after its grace if it lingers.
        for (const { child, exited } of children) {
          const lingering = setTimeout(() => killTree(child), L.exitGraceMs)
          void exited.then(() => {
            clearTimeout(lingering)
            killTree(child)
          })
        }
        void removeScratch(places.scratch)
      })
    return {
      // Its first process's, once started: Claude Code's as the run starts; Codex's SDK keeps its own to itself.
      get pid() {
        return children[0]?.child.pid
      },
      done,
      cancel: () => stop("cancelled"),
    }
  }
}

/** An agent's own sign-in: it opens the browser and prints the page's address; a code the page shows goes to its input. */
function startLogin(program: string, args: string[], env: NodeJS.ProcessEnv): AgentLogin {
  const child = spawn(program, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: !isWin })
  let output = ""
  let errors = ""
  let gotUrl: (u: string | null) => void = () => undefined
  const url = new Promise<string | null>((resolve) => (gotUrl = resolve))
  child.stdout.on("data", (c: Buffer) => {
    output = (output + c.toString("utf8")).slice(-L.stderrChars)
    // The address once its line is complete: output can arrive mid-address.
    const m = /https:\/\/\S+(?=\s)/.exec(output)
    if (m) gotUrl(m[0])
  })
  child.stderr.on("data", (c: Buffer) => (errors = (errors + c.toString("utf8")).slice(-L.stderrChars)))
  child.stdin.on("error", () => undefined)
  const timer = setTimeout(() => killTree(child), L.loginMs)
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
