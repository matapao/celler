// Where a run's commands may go, which the settings files beside this one put into each harness's own words
// (claude.*.ts, codex.*.ts): the run's folder, with its own scratch folder inside it, and none of the person's home or
// the system's temporary folders. celler keeps no list of where secrets might be: the home is closed as a whole, and
// PATH, which declares the person's programs, is what opens their folders in it again. These are facts about the run,
// worked out once as it starts.

import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, statSync } from "node:fs"
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
  /** The person's home folder, where the host keeps its data too: never read, but for the run's folder if it is in it. */
  home: string
  /** The folders on PATH inside the person's home, as PATH declares them: their programs run. */
  tools: string[]
  /** What the host adds, read only: a worktree's repository data. */
  readable: string[]
  /** Variables in the agent's environment its commands must never see: the proxies'. */
  hidden: string[]
}

/**
 * A folder's own settings for the agents celler runs, which they load from it and may start programs from outside any
 * sandbox (a Codex MCP server in `.codex/config.toml`, a Claude Code hook): never written by a run's commands, wherever
 * they are in its folder, so a run can't set up what the person's own agent starts there. Codex's sandbox takes such
 * patterns only to deny, so its commands don't read them either.
 */
export const AGENT_SETTINGS = [".codex", ".agents", ".claude", ".mcp.json"]

/** Whether a path is a folder itself or inside it. */
export function inside(folder: string, file: string): boolean {
  const rel = path.relative(folder, file)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** Whether a path is outside a folder, as named or as the folder really is (macOS's /tmp). */
export function outside(file: string, folder: string): boolean {
  const out = (dir: string) => !inside(dir, path.resolve(dir, file))
  try {
    return out(path.resolve(folder)) && out(realpathSync(folder))
  } catch {
    return true
  }
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

/** A folder by its real path, or null when there is none. */
function realFolder(dir: string): string | null {
  try {
    const real = realpathSync(dir)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/**
 * The system's temporary folders, as they really are: macOS's /tmp is a link to /private/tmp, and a link closed itself
 * would close every path through it, even to a folder opened again inside (the run's short folder).
 */
export function systemTemps(): string[] {
  const named = process.platform === "win32" ? [os.tmpdir()] : [os.tmpdir(), "/tmp", "/var/tmp"]
  const out = new Set<string>()
  for (const dir of named) {
    const real = realFolder(dir)
    if (real) out.add(real)
  }
  return [...out]
}

/** The folders on a PATH that are inside the home, by their real paths: never the home itself. */
export function homeTools(pathVariable: string, home: string): string[] {
  const out = new Set<string>()
  for (const entry of pathVariable.split(path.delimiter)) {
    const dir = path.isAbsolute(entry) ? realFolder(entry) : null
    if (dir && dir !== home && inside(home, dir)) out.add(dir)
  }
  return [...out]
}

/** A run's places, as it starts: its folder and the scratch in it, what the host adds and hides. */
export function placesFor(o: { folder: string; scratch: Places["scratch"]; readable?: string[]; hidden: string[] }): Places {
  const home = realFolder(os.homedir()) ?? path.resolve(os.homedir())
  return {
    folder: path.resolve(o.folder),
    scratch: o.scratch,
    temps: systemTemps(),
    home,
    tools: homeTools(process.env.PATH ?? "", home),
    readable: (o.readable ?? []).map((p) => path.resolve(p)),
    hidden: o.hidden,
  }
}
