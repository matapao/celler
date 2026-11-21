// The agents' own programs on this computer, and how a program starts. A program is looked for where its installers
// put it, then on PATH; when it isn't there, the person shows the host where it is (chosenPrograms).

import { execFile } from "node:child_process"
import { closeSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { harnessLimits } from "../limits.js"
import type { Places } from "./sandbox/places.js"
import type { Host } from "./types.js"
import { bootstrapFile } from "./windowless.js"

const isWin = process.platform === "win32"
const home = os.homedir()

export type AgentProgram = "claude" | "codex"
export const AGENT_PROGRAMS: AgentProgram[] = ["claude", "codex"]

const unixPlaces = (p: string) => [path.join(home, ".local", "bin", p), `/opt/homebrew/bin/${p}`, `/usr/local/bin/${p}`, `/home/linuxbrew/.linuxbrew/bin/${p}`]
const npmShim = (p: string) => path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm", `${p}.cmd`)
const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")

/**
 * Each program: its maker's name for it, what its `--version` says, and where its installers put it. An app started
 * from the desktop doesn't get the shell's PATH, so those folders come before PATH.
 */
const PROGRAMS: Record<AgentProgram, { name: string; version: RegExp; places: string[] }> = {
  claude: { name: "Claude Code", version: /\(Claude Code\)/i, places: isWin ? [path.join(home, ".local", "bin", "claude.exe"), npmShim("claude")] : unixPlaces("claude") },
  codex: { name: "Codex", version: /^codex(-cli)?\s+\d/im, places: isWin ? [path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"), npmShim("codex")] : unixPlaces("codex") },
}

function onPath(name: string): string[] {
  const exts = isWin ? [".exe", ".cmd", ""] : [""]
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).flatMap((dir) => exts.map((e) => path.join(dir, name + e)))
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** An agent's own program: where the person showed the host (`chosen`), else where its installers put it, else on PATH. */
export function findProgram(program: AgentProgram, chosen?: string | null): string | null {
  return [chosen, ...PROGRAMS[program].places, ...onPath(program)].find((f): f is string => !!f && isFile(f)) ?? null
}

/** Where the person showed the host each program, kept in `file`. */
export function chosenPrograms(file: string): { get(program: AgentProgram): string | null; set(program: AgentProgram, at: string | null): void } {
  let chosen: Partial<Record<AgentProgram, string>> = {}
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"))
    for (const p of AGENT_PROGRAMS) if (typeof raw?.[p] === "string" && path.isAbsolute(raw[p])) chosen[p] = raw[p]
  } catch {
    /* nothing shown yet */
  }
  return {
    get: (program) => chosen[program] ?? null,
    set(program, at) {
      chosen = { ...chosen, [program]: at ?? undefined }
      writeFileSync(`${file}.tmp`, JSON.stringify(chosen))
      renameSync(`${file}.tmp`, file)
    },
  }
}

/** Whether `file` is the agent's program, by what its `--version` says: its path and version, or why not. */
export async function checkProgram(program: AgentProgram, file: string): Promise<{ path: string; version: string } | { error: string }> {
  const { name, version: says } = PROGRAMS[program]
  if (!path.isAbsolute(file) || !isFile(file)) return { error: `That isn't a program: pick ${name} itself (${program}${isWin ? ".exe" : ""}).` }
  const launch = launchFor(file)
  const version = await runForOutput(launch, ["--version"], agentEnv(launch, {}, { mark: (env) => env }))
  if (!version || !says.test(version)) return { error: `That isn't ${name}: it didn't say so when asked its version.` }
  return { path: file, version: version.split("\n")[0] }
}

/** The real program behind an npm bin link, or behind a Windows .cmd shim (its last "%dp0%\..." that isn't node). */
export function realProgram(file: string): string {
  try {
    if (!isWin || !/\.(cmd|bat)$/i.test(file)) return realpathSync(file)
    const targets = [...readFileSync(file, "utf8").matchAll(/"%~?dp0%?\\([^"]+)"/gi)].map((m) => m[1]).filter((t) => !/(^|\\)node(\.exe)?$/i.test(t))
    return targets.length ? path.win32.join(path.win32.dirname(file), targets.at(-1)!) : file
  } catch {
    return file
  }
}

/** A Node script, by the runtime its first line names, else by its name. */
function isNodeScript(file: string): boolean {
  let first = ""
  try {
    const fd = openSync(file, "r")
    const head = Buffer.alloc(128)
    first = head.toString("utf8", 0, readSync(fd, head, 0, head.length, 0)).split("\n")[0]
    closeSync(fd)
  } catch {
    /* unreadable: decided by its name */
  }
  return first.startsWith("#!") ? /\bnode\b/.test(first) : /\.[cm]?js$/i.test(file)
}

export interface Launch {
  cmd: string
  args: string[]
  /** Runs on this process's Node runtime (Electron's, in an Electron host). */
  node: boolean
}

/**
 * How to start a program: a Node script on this process's own runtime, so no Node install is needed, and on Windows
 * through the bootstrap that keeps what it starts from opening console windows (windowless.ts); anything else directly.
 */
export function launchFor(file: string): Launch {
  const target = realProgram(file)
  if (!isNodeScript(target)) return { cmd: target, args: [], node: false }
  return { cmd: process.execPath, args: isWin ? [bootstrapFile(), target] : [target], node: true }
}

/** An agent's environment: this process's, marked as the host's run, without a parent agent's identity; then `add` ('' removes). */
export function agentEnv(launch: Launch, add: Record<string, string>, host: Pick<Host, "mark">): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = host.mark({ ...process.env })
  for (const k of ["ELECTRON_RUN_AS_NODE", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete env[k]
  // Connector values a run of its own host carried (a host started inside a run) are no run's here.
  for (const k of Object.keys(env)) if (k.startsWith("CELLER_VALUE_")) delete env[k]
  return finished(env, launch, add)
}

/** An environment as every program here starts with it: a Node script as Node, then `add` ('' removes). */
function finished(env: NodeJS.ProcessEnv, launch: Launch, add: Record<string, string>): NodeJS.ProcessEnv {
  // A Node script runs on this process's binary, Electron's in an Electron host, as Node.
  // nosemgrep: semgrep.binary-as-node
  if (launch.node) env.ELECTRON_RUN_AS_NODE = "1"
  for (const [name, value] of Object.entries(add)) {
    if (value) env[name] = value
    else delete env[name]
  }
  return env
}

/**
 * What a run's agent keeps of this process's environment: what programs need to start and reach their own service,
 * nothing else of the person's. A token, key or password in the person's shell never reaches it.
 */
const KEPT = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ",
  // How this computer reaches the internet, for the agent's own service only (its commands never see these: PROXIES).
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "no_proxy", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // Where the person keeps Claude Code's own settings and sign-in, and its Git Bash on Windows.
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH",
]
const KEPT_ON_WINDOWS = [
  "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "SystemDrive", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles",
  "CommonProgramFiles(x86)", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "USERNAME", "USERDOMAIN", "COMPUTERNAME",
]
/** Variables naming how to reach the internet, which may carry a password: the agent's own, never its commands'. */
export const PROXIES = KEPT.filter((name) => /proxy/i.test(name))

/**
 * A run's environment, as its own user's: what it keeps of this process's (KEPT), its own temporary folder and caches in
 * its scratch (sandbox/places.ts), marked as the host's run, then `add` ('' removes).
 */
export function runEnv(launch: Launch, add: Record<string, string>, host: Pick<Host, "mark">, places: Places): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  for (const name of [...KEPT, ...(isWin ? KEPT_ON_WINDOWS : [])]) if (process.env[name] !== undefined) kept[name] = process.env[name]
  for (const [name, value] of Object.entries(process.env)) if (name.startsWith("LC_") && value !== undefined) kept[name] = value
  const own = { TMPDIR: places.scratch.tmp, TMP: places.scratch.tmp, TEMP: places.scratch.tmp, XDG_CACHE_HOME: places.scratch.cache, npm_config_cache: path.join(places.scratch.cache, "npm") }
  return finished(host.mark({ ...kept, ...own }), launch, add)
}

/** A program's output, or null when it fails; `anyExit` keeps the output of a non-zero exit. */
export function runForOutput(launch: Launch, args: string[], env: NodeJS.ProcessEnv, anyExit = false): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(launch.cmd, [...launch.args, ...args], { env, timeout: harnessLimits.askMs, windowsHide: true }, (err, out) =>
      resolve(err && !(anyExit && typeof (err as { code?: unknown }).code === "number") ? null : String(out).trim()),
    )
  })
}
