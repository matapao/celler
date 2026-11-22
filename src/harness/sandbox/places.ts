// Where a run's commands may go, as the settings files beside this one name them for each harness on each system
// (claude.*.ts, codex.*.ts): the run's folder, with its own scratch folder inside it, the programs on its PATH, and what
// they must never read or write. Worked out once, as the run starts; the settings files only put these into each
// harness's own words.

import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, statSync } from "node:fs"
import { chmod, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export interface Places {
  /** The run's folder, its top folder: read, and written and organized at will at work. */
  folder: string
  /**
   * The run's own, inside its folder (SCRATCH): its temporary files (`tmp`), and programs' home (`home`) and caches
   * (`cache`). And a folder of its own with a short path (`short`), for what can't have a long one: Claude Code's shell
   * keeps its temporary files and sockets there. On macOS and Linux it is in /tmp, outside the folder; Windows has no
   * such limit, and it is the run's `tmp`. Made as it starts, removed after it.
   */
  scratch: { root: string; tmp: string; home: string; cache: string; short: string }
  /** The system's temporary folders, which other programs share: never read or written. */
  temps: string[]
  /** The person's home folder: never read. */
  home: string
  /** The host's own data: never read. */
  data: string | null
  /** The programs on its PATH, and where they are installed (never the home folder or the root itself): read only. */
  toolchain: string[]
  /** What the host adds, read only: a worktree's repository data. */
  readable: string[]
  /** Files in the folder named for secrets: never read, by its commands or its own file tools. */
  secrets: string[]
  /** Variables in the agent's environment its commands must never see: the connectors' values. */
  hidden: string[]
}

/**
 * Names kept for secrets: closed to a run's commands and to its agent's file tools wherever they are in its folder, as
 * patterns its agents' settings take (`*` within a name).
 */
export const SECRET_NAMES = [
  ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa", "id_rsa.*", "id_ecdsa", "id_ecdsa.*", "id_ed25519",
  "id_ed25519.*", ".npmrc", ".netrc", ".pypirc", ".git-credentials",
]

/**
 * A folder's own settings for the agents celler runs, which they load from it and may start programs from outside any
 * sandbox (a Codex MCP server in `.codex/config.toml`, a Claude Code hook): never written by a run's commands, wherever
 * they are in its folder, so one run can't set up what the next, or the person's own agent, starts. Codex's sandbox
 * takes such patterns only to deny, so its commands don't read them either.
 */
export const AGENT_SETTINGS = [".codex", ".agents", ".claude", ".mcp.json"]

/** Folders a search for secret files doesn't go into: what tools fetch and make, and the repository's own data. */
const NOT_SEARCHED = new Set(["node_modules", ".git", ".desks", ".celler", "vendor", "dist", "build", ".venv", "venv", "__pycache__"])
/** How much of a folder is looked through for secret files at most, and how deep. */
const MAX_LOOKED_AT = 20_000
const MAX_DEPTH = 8

const asPattern = (name: string) => new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
const SECRET_PATTERNS = SECRET_NAMES.map(asPattern)
export const isSecretName = (name: string) => SECRET_PATTERNS.some((p) => p.test(name))

/** The files in a folder named for secrets, as they are when the run starts. */
export function secretsIn(folder: string): string[] {
  const found: string[] = []
  let looked = 0
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || looked > MAX_LOOKED_AT) return
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (++looked > MAX_LOOKED_AT) return
      const at = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!NOT_SEARCHED.has(entry.name)) walk(at, depth + 1)
      } else if (isSecretName(entry.name)) found.push(at)
    }
  }
  walk(folder, 0)
  return found
}

/**
 * The programs on a PATH, as folders to read, by their real paths: each folder on it that is there, and where its
 * programs are installed. That is the folder above a `bin` (`~/.nvm/versions/node/v24` for its `bin`), and for a folder
 * in the person's home, the folders its programs link to (`~/.local/bin/ruff` to `~/.local/share/uv/tools/ruff/bin/ruff`
 * is `~/.local/share/uv/tools/ruff`). Never the root or a folder that is or holds the person's home or the host's data,
 * and never a folder right inside the home folder (`~/.local`, `~/.cargo`): those hold more than programs.
 */
export function toolchainOf(pathVariable: string, home: string, data: string | null = null): string[] {
  const homeFolder = realOr(home)
  const dataFolder = data ? realOr(data) : null
  const root = path.parse(homeFolder).root
  const closed = (dir: string) => dir === root || inside(dir, homeFolder) || (dataFolder !== null && inside(dir, dataFolder))
  const isInstall = (dir: string) => !closed(dir) && path.dirname(dir) !== homeFolder
  const out = new Set<string>()
  for (const entry of pathVariable.split(path.delimiter)) {
    const dir = path.isAbsolute(entry) ? realFolder(entry) : null
    if (!dir || closed(dir) || out.has(dir)) continue
    out.add(dir)
    const linked = inside(homeFolder, dir) ? linkedFrom(dir).map((program) => path.dirname(program)) : []
    for (const folder of [dir, ...linked]) {
      const installed = installFolder(folder)
      if (isInstall(installed)) out.add(installed)
    }
  }
  return [...out]
}

const realOr = (place: string) => realFolder(place) ?? path.resolve(place)

/** A folder by its real path, or null when there is none. */
function realFolder(dir: string): string | null {
  try {
    const real = realpathSync(dir)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** Where the programs that are links in a folder really are; a broken link is passed over. */
function linkedFrom(dir: string): string[] {
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const programs: string[] = []
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue
    try {
      programs.push(realpathSync(path.join(dir, entry.name)))
    } catch {
      // A broken link.
    }
  }
  return programs
}

/** The folder its programs are installed in: the one above a `bin`, else the folder itself. */
function installFolder(folder: string): string {
  return /^s?bin$/i.test(path.basename(folder)) ? path.dirname(folder) : folder
}

/** Whether a path is a folder itself or inside it. */
export function inside(folder: string, file: string): boolean {
  const rel = path.relative(folder, file)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** Where in its folder a run's scratch folders are made, each its own: `<folder>/.celler/run-…`. */
export const SCRATCH = ".celler"

/**
 * A run's own scratch folder, made inside its folder (SCRATCH), and its short one, in /tmp on macOS and Linux, which
 * only its owner may use: there is no other place it may keep anything.
 */
export function scratchFor(folder: string): Places["scratch"] {
  const parent = path.join(folder, SCRATCH)
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(path.join(parent, "run-"))
  const tmp = path.join(root, "tmp")
  const short = process.platform === "win32" ? tmp : mkdtempSync(path.join(realpathSync("/tmp"), "celler-"))
  const scratch = { root, tmp, home: path.join(root, "home"), cache: path.join(root, "cache"), short }
  for (const dir of [scratch.tmp, scratch.home, scratch.cache]) mkdirSync(dir)
  return scratch
}

/**
 * A run's scratch folders gone after it, and the folder holding the scratch folders, once none is left in it. Removed
 * in the background, as a run's caches can be large; it never fails: what can't be removed (a file still open on
 * Windows) stays.
 */
export async function removeScratch(scratch: Places["scratch"]): Promise<void> {
  await removeFolder(scratch.root)
  await removeFolder(scratch.short)
  try {
    // At once, so it never falls between another run's scratchFor making this folder and its scratch in it.
    rmdirSync(path.dirname(scratch.root))
  } catch {
    // Another run's scratch is still there, or it is gone already.
  }
}

/** A folder and all in it gone, or as much of it as can go; it never fails. */
export async function removeFolder(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    try {
      // A tool's read-only folders, such as Go's module cache: made writable, then removed.
      await makeWritable(dir)
      await rm(dir, { recursive: true, force: true })
    } catch {
      // It stays.
    }
  }
}

/** A folder and every folder in it writable by its owner; links are not followed. */
async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o700)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeWritable(path.join(dir, entry.name))
  }
}

/**
 * The system's temporary folders, as they really are: macOS's /tmp is a link to /private/tmp, and a link closed itself
 * would close every path through it, even to a folder opened again inside (a harness's own temporary folder).
 */
export function systemTemps(): string[] {
  const named = process.platform === "win32" ? [os.tmpdir()] : [os.tmpdir(), "/tmp", "/var/tmp"]
  const out = new Set<string>()
  for (const dir of named) {
    try {
      out.add(realpathSync(dir))
    } catch {
      // Not on this computer.
    }
  }
  return [...out]
}

/** A run's places, as it starts: its folder and the scratch in it, the person's PATH, what the host adds and hides. */
export function placesFor(o: { folder: string; scratch: Places["scratch"]; data?: string; pathVariable: string; readable?: string[]; hidden: string[] }): Places {
  const home = os.homedir()
  return {
    folder: path.resolve(o.folder),
    scratch: o.scratch,
    temps: systemTemps(),
    home,
    data: o.data ? path.resolve(o.data) : null,
    toolchain: toolchainOf(o.pathVariable, home, o.data ?? null),
    readable: (o.readable ?? []).map((p) => path.resolve(p)),
    secrets: secretsIn(o.folder),
    hidden: o.hidden,
  }
}
