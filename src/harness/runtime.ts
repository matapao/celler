// One runtime for either coding agent (agents.ts): whether it can run, its own sign-in, and its runs, each through the
// agent's own SDK (claude.ts, codex.ts). What a run is given (Turn) is the same for both: its places, its environment,
// and its clock, which stands still while the person is asked. What Claude Code's commands leave running ends with its
// run; Codex's SDK starts Codex itself, and its commands' are Codex's to end.

import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { harnessLimits as L } from "../limits.js"
import type { Agent } from "./agents.js"
import { agentEnv, PROXIES, runEnv, runForOutput } from "./programs.js"
import { inside, placesFor, removeFolder, removeScratch, scratchFor, unfitFolder, type Places } from "./sandbox/places.js"
import { errorText, failedRun, failure, type AgentLogin, type Host, type McpServerSpec, type RunHandle, type RunProgress, type RunResult, type Runtime, type RuntimeHealth, type RunSpec } from "./types.js"

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
export function forThisSystem<T>(files: Partial<Record<NodeJS.Platform, T>>, name: string): T {
  const file = files[process.platform]
  if (!file) throw new Error(`${name} has no sandbox settings for ${process.platform} here`)
  return file
}

/** A line an MCP server passed on, which says nothing of the agent's own sign-in. */
const MCP_LINE_RE = /\bmcp[\s_:.-]|mcp server/i

/** Whether what an agent said tells that it isn't signed in itself (`words`), not one of its MCP servers. */
export function saysSignedOut(text: string, words: RegExp): boolean {
  return text.split("\n").some((line) => !MCP_LINE_RE.test(line) && words.test(line))
}

/** The longest a timer waits in one go (Node's): a longer run's clock is set again when it is reached. */
const LONGEST_WAIT = 2 ** 31 - 1

/** The person's words, then the files given with them as links its agent can open: no words of the host's. */
export function promptOf(spec: RunSpec): string {
  const links = (spec.attachments ?? []).map((a) => `[${a.name}](${pathToFileURL(a.path).href})`)
  return [spec.prompt, links.join("\n")].filter(Boolean).join("\n\n")
}

/** The first version number in what a program says, "2.1.330" in "2.1.330 (Claude Code)". */
const versionIn = (said: string) => /\d+\.\d+\.\d+/.exec(said)?.[0] ?? null

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

/** Each program's version, by its file as it was asked (fileOf). */
const versions = new Map<string, string>()

/** A program's file as it is now: its path, when it last changed and its size; null when it isn't there. */
function fileOf(program: string): string | null {
  try {
    const { mtimeMs, size } = statSync(program)
    return JSON.stringify([program, mtimeMs, size])
  } catch {
    return null
  }
}

/** What a program says its version is, or null: known at once once it has said it, until its file changes. */
function versionOf(program: string, env: NodeJS.ProcessEnv): string | Promise<string | null> {
  const file = fileOf(program)
  const known = file ? versions.get(file) : undefined
  if (known) return known
  return runForOutput(program, ["--version"], env).then((said) => {
    const version = said ? versionIn(said) : null
    if (file && version) versions.set(file, version)
    return version
  })
}

/** Why a version of the agent's program doesn't run here, or null: it said none, or it is older than the oldest that runs. */
function unfitVersion(agent: Agent, found: string, version: string | null): string | null {
  if (!version) return `Could not run ${found} --version.`
  if (older(version, agent.oldest)) return `${agent.name} ${version} is older than ${agent.oldest}, the oldest that runs here: update it.`
  return null
}

/** What a run's MCP server may be named: its agent names the server's tools by it, as Codex does its settings' table. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/

/** Why a run's MCP servers can't be given to its agent as they are named, or null: each needs a name of its own. */
function misnamed(servers: McpServerSpec[]): string | null {
  const seen = new Set<string>()
  for (const { name } of servers) {
    if (!SERVER_NAME.test(name)) return `${JSON.stringify(name)} can't name one of the run's MCP servers: only letters, digits, "_" and "-" can`
    if (seen.has(name)) return `Two of the run's MCP servers are named ${name}: each needs a name of its own`
    seen.add(name)
  }
  return null
}

/** The agent's own home, as a run's environment names it: by the agent's own variables, else by the person's. */
function homeOf(agent: Agent, own: Record<string, string>): string[] {
  const named = own[agent.homeVariable] ?? process.env[agent.homeVariable]
  return named ? [named] : []
}

/** The processes told to stop already: each is told once. */
const killed = new WeakSet<ChildProcess>()

/** Stops a process and everything it started, once: asks, then insists, if what it asked reached anything. */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid || killed.has(child)) return
  killed.add(child)
  if (isWin) {
    if (child.exitCode === null) execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined)
    return
  }
  // It leads its own process group (spawned detached), which outlives it while anything it started runs.
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    // Nothing of it is left, and the group's number may soon be another's: nothing to insist on.
    return
  }
  const insist = () => {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // It ended when asked.
    }
  }
  setTimeout(insist, L.exitGraceMs).unref()
}

/** Once all of these have come, or the grace a process has to exit is over, whichever is first. */
function withinGrace(events: Promise<void>[]): Promise<void> {
  return new Promise((resolve) => {
    const grace = setTimeout(resolve, L.exitGraceMs)
    grace.unref()
    void Promise.all(events).then(() => {
      clearTimeout(grace)
      resolve()
    })
  })
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

  /** Found, new enough (as each run checks too), signed in; with `deep`, a tiny test run too. */
  async health(deep: boolean): Promise<RuntimeHealth> {
    const { agent } = this
    const checkedAt = Date.now()
    const found = agent.find()
    if (typeof found !== "string") return { ok: false, checkedAt, detail: found.missing, fix: "find" }
    agent.ready?.()
    const { program } = agent.started(found)
    const env = agentEnv(agent.env(this.host), this.host)
    const [version, answer] = await Promise.all([versionOf(program, env), runForOutput(program, agent.signedIn.args, env, agent.signedIn.anyExit)])
    const unfit = unfitVersion(agent, found, version)
    if (unfit) return { ok: false, checkedAt, program: found, detail: unfit }
    const named = `${agent.name} ${version}`
    if (agent.signedIn.yes(answer) === false) return { ok: false, checkedAt, program: found, fix: "login", detail: `${named} · ${agent.login.signedOut}` }
    if (!deep) return { ok: true, checkedAt, program: found, detail: `${named} (not yet test-run)` }
    // In an empty folder of its own, which no other program or person shares, gone after it.
    const folder = mkdtempSync(path.join(os.tmpdir(), "celler-test-run-"))
    try {
      const test = { cwd: folder, prompt: "Reply with exactly: OK", systemPrompt: "", model: "fast", sessionId: randomUUID(), resume: false, mcpServers: [], purpose: "inference" as const, timeoutMs: agent.testRunMs }
      const r = await this.run(test, () => undefined).done
      // One that takes it offline (a sign-in it has that no longer works): the host can offer its sign-in again.
      const fix = r.runtimeDown ? { fix: "login" as const } : {}
      return { ok: r.ok, checkedAt, program: found, ...fix, detail: `${named} · ${r.ok ? "test run succeeded" : (r.error ?? "test run failed")}` }
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
    const unnamed = misnamed(spec.mcpServers)
    if (unnamed) return failedRun(unnamed)
    let started: ReturnType<Agent["started"]>
    let places: Places
    let env: NodeJS.ProcessEnv
    let errands: NodeJS.ProcessEnv
    let scratch: Places["scratch"] | undefined
    try {
      agent.ready?.()
      started = agent.started(found)
      const own = agent.env(this.host)
      // Where no run may be, by any of its names (sandbox/places.ts): checked for its folder, and for each the host adds.
      const agentHomes = homeOf(agent, own)
      const unfit = unfitFolder(spec.cwd, agentHomes) ?? (spec.readable ?? []).map((place) => unfitFolder(place, agentHomes, "read")).find((why) => why !== null)
      if (unfit) return failedRun(unfit)
      // Its own scratch folder inside its folder, removed when it ends, and where its commands may go (sandbox/places.ts).
      scratch = scratchFor(spec.cwd)
      places = placesFor({ folder: spec.cwd, scratch, agentHomes, readable: spec.readable, hidden: PROXIES.filter((name) => process.env[name] !== undefined) })
      // Its own user's environment, marked as the host's run, with the folders its program needs on PATH; and the one its
      // own errands start in (its version).
      env = runEnv(started.path.length ? { ...own, PATH: [...started.path, process.env.PATH ?? ""].join(path.delimiter) } : own, this.host, places)
      errands = agentEnv(own, this.host)
    } catch (err) {
      // What was made for it goes with it.
      if (scratch) void removeScratch(scratch)
      return failedRun(`${agent.name} could not be set up for this run: ${errorText(err)}`)
    }

    // The run's clock stands still while the person is asked: by its agent, or about what the run waits on, such as one
    // of its calls in the inbox (hold, as its platform says). Each wait holds it, and it goes on once the last is
    // released, so waits at the same time count once. A run that is over, stopped or ended, takes its asks back: then
    // its clock never starts again, and nothing stops it any more.
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
      const left = deadline - Date.now()
      // Past its time, or with none it could keep: stopped now. Else woken at its deadline, a long one in steps.
      if (!(left > 0)) return stop("timed out")
      timer = setTimeout(arm, Math.min(left, LONGEST_WAIT))
    }
    const hold = () => {
      if (waiting++ === 0) {
        pausedAt = Date.now()
        clearTimeout(timer)
      }
      // Released once: a release called again changes nothing.
      let released = false
      return () => {
        if (released) return
        released = true
        if (--waiting === 0) {
          deadline += Date.now() - pausedAt
          arm()
        }
      }
    }
    const meanwhile = async <T>(asked: () => Promise<T>): Promise<T> => {
      const release = hold()
      try {
        return await asked()
      } finally {
        release()
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
    // Never a program older than its SDK is made with. Each program is asked once, and again once it changes: known, as
    // after a health check, its agent starts as the run does.
    const begin = (version: string | null): Promise<RunResult> => {
      const unfit = unfitVersion(agent, found, version)
      if (unfit) return Promise.resolve(failure(unfit, true))
      // Stopped while it was asked: it doesn't start (end says why).
      if (over()) return Promise.resolve(failure(""))
      return agent.run(turn)
    }
    const version = versionOf(started.program, errands)
    const done = (typeof version === "string" ? begin(version) : version.then(begin))
      .then(end, (err: unknown) => end(failure(errorText(err).slice(0, L.errorChars))))
      .finally(() => {
        ended = true
        clearTimeout(timer)
        asking.abort()
        // What its commands left running ends with it, once it has exited, or after its grace if it lingers.
        for (const { child, exited } of children) {
          const lingering = setTimeout(() => killTree(child), L.exitGraceMs)
          lingering.unref()
          void exited.then(() => {
            clearTimeout(lingering)
            killTree(child)
          })
        }
        // Its scratch goes once its processes have exited, or their grace is over: none writes in it as it goes.
        void withinGrace(children.map(({ exited }) => exited)).then(() => removeScratch(places.scratch))
      })
    return {
      // Its first process's, once started: Claude Code's as the run starts; Codex's SDK keeps its own to itself.
      get pid() {
        return children[0]?.child.pid
      },
      done,
      cancel: () => stop("cancelled"),
      hold,
    }
  }
}

/**
 * A sign-in page's address in what its agent prints: up to the first space, control character (a terminal link's own,
 * as Claude Code wraps it: OSC 8), quote or closing bracket. Until one of those comes, the rest may still be on its way.
 */
// oxlint-disable-next-line no-control-regex -- a control character ends the address: this finds them on purpose
const LOGIN_URL =/https:\/\/[^\s\x00-\x1f\x7f"'`)\]}>]+(?=[\s\x00-\x1f\x7f"'`)\]}>])/

/** An agent's own sign-in: it opens the browser and prints the page's address; a code the page shows goes to its input. */
function startLogin(program: string, args: string[], env: NodeJS.ProcessEnv): AgentLogin {
  const child = spawn(program, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: !isWin })
  const said = { stdout: "", stderr: "" }
  let gotUrl: (u: string | null) => void = () => undefined
  const url = new Promise<string | null>((resolve) => (gotUrl = resolve))
  // Its page's address on either of its outputs: an agent may print it on its error output.
  for (const output of ["stdout", "stderr"] as const) {
    child[output].on("data", (c: Buffer) => {
      said[output] = (said[output] + c.toString("utf8")).slice(-L.stderrChars)
      const m = LOGIN_URL.exec(said[output])
      if (m) gotUrl(m[0])
    })
  }
  child.stdin.on("error", () => undefined)
  const timer = setTimeout(() => killTree(child), L.loginMs)
  const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    child.on("error", (err) => resolve({ ok: false, error: err.message }))
    child.on("close", (code) => {
      clearTimeout(timer)
      gotUrl(null)
      const last = (text: string) => text.trim().split("\n").filter(Boolean).at(-1)
      resolve(code === 0 ? { ok: true } : { ok: false, error: last(said.stderr) ?? last(said.stdout) ?? `Login ended with code ${code}` })
    })
  })
  return { url, done, sendCode: (code) => void child.stdin.write(`${code.trim()}\n`), cancel: () => killTree(child) }
}
