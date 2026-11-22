// The agents' own programs on this computer, and the environments they start in. A program is looked for where its
// installers put it, then on PATH; when it isn't there, the person shows the host where it is (chosenPrograms). Each is
// a native program, started as it is.

import { execFile } from "node:child_process"
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { harnessLimits } from "../limits.js"
import type { Places } from "./sandbox/places.js"
import type { Host } from "./types.js"

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
  const started = program === "codex" ? codexProgram(file).program : realProgram(file)
  const version = await runForOutput(started, ["--version"], agentEnv({}, { mark: (env) => env }))
  if (!version || !says.test(version)) return { error: `That isn't ${name}: it didn't say so when asked its version.` }
  return { path: file, version: version.split("\n")[0] }
}

/** The real program behind a link, or behind a Windows .cmd shim of npm's (its last "%dp0%\..." that isn't node). */
export function realProgram(file: string): string {
  try {
    if (!isWin || !/\.(cmd|bat)$/i.test(file)) return realpathSync(file)
    const targets = [...readFileSync(file, "utf8").matchAll(/"%~?dp0%?\\([^"]+)"/gi)].map((m) => m[1]).filter((t) => !/(^|\\)node(\.exe)?$/i.test(t))
    return targets.length ? path.win32.join(path.win32.dirname(file), targets.at(-1)!) : file
  } catch {
    return file
  }
}

/** Codex's own program in npm's package for each system, by the target it is built for. */
export const CODEX_TARGETS: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
}

/**
 * The program to start for a Codex found: itself when it is Codex's own program, or the one npm's wrapper of it
 * (`codex.js`, which needs Node) starts, found as the wrapper finds it; with the folder that wrapper's package keeps
 * Codex's own helpers in (its ripgrep), to go on PATH.
 */
export function codexProgram(file: string): { program: string; path: string[] } {
  const real = realProgram(file)
  const platform = `${process.platform}-${process.arch}`
  const target = CODEX_TARGETS[platform]
  if (!/\.[cm]?js$/i.test(real) || !target) return { program: real, path: [] }
  const root = path.join(vendorOf(real, platform), target)
  const exe = isWin ? "codex.exe" : "codex"
  // Its package's layout, then the one before it.
  for (const [program, helpers] of [[path.join(root, "bin", exe), path.join(root, "codex-path")], [path.join(root, "codex", exe), path.join(root, "path")]]) {
    if (isFile(program)) return { program, path: isFolder(helpers) ? [helpers] : [] }
  }
  return { program: real, path: [] }
}

/** Where npm's wrapper of Codex keeps the programs it starts: in the package for this system, else in its own. */
function vendorOf(wrapper: string, platform: string): string {
  try {
    return path.join(path.dirname(createRequire(wrapper).resolve(`@openai/codex-${platform}/package.json`)), "vendor")
  } catch {
    return path.join(path.dirname(wrapper), "..", "vendor")
  }
}

function isFolder(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** The prefix of the variables that carry a run's connector values to its agent, never on its command line. */
export const VALUES = "CELLER_VALUE_"

/**
 * An agent's environment for its own errands (its version, its sign-in): this process's, marked as the host's run,
 * without a parent agent's identity or the connector values of a run this host was started in; then `add` ('' removes).
 */
export function agentEnv(add: Record<string, string>, host: Pick<Host, "mark">): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = host.mark({ ...process.env })
  for (const k of ["ELECTRON_RUN_AS_NODE", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete env[k]
  for (const k of Object.keys(env)) if (k.startsWith(VALUES)) delete env[k]
  return withAdded(env, add)
}

/** `env` with `add`'s variables, an empty value taking one out. */
function withAdded(env: NodeJS.ProcessEnv, add: Record<string, string>): NodeJS.ProcessEnv {
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
export function runEnv(add: Record<string, string>, host: Pick<Host, "mark">, places: Places): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  for (const name of [...KEPT, ...(isWin ? KEPT_ON_WINDOWS : [])]) if (process.env[name] !== undefined) kept[name] = process.env[name]
  for (const [name, value] of Object.entries(process.env)) if (name.startsWith("LC_") && value !== undefined) kept[name] = value
  const own = { TMPDIR: places.scratch.tmp, TMP: places.scratch.tmp, TEMP: places.scratch.tmp, XDG_CACHE_HOME: places.scratch.cache, npm_config_cache: path.join(places.scratch.cache, "npm") }
  return withAdded(host.mark({ ...kept, ...own }), add)
}

/** A program's output, or null when it fails; `anyExit` keeps the output of a non-zero exit. */
export function runForOutput(file: string, args: string[], env: NodeJS.ProcessEnv, anyExit = false): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: harnessLimits.askMs, windowsHide: true }, (err, out) =>
      resolve(err && !(anyExit && typeof (err as { code?: unknown }).code === "number") ? null : String(out).trim()),
    )
  })
}
