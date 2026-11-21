// Where a run's commands may go, as the settings files beside this one name them for each harness on each system
// (claude.*.ts, codex.*.ts): the run's folder, with its own scratch folder inside it, the programs on its PATH, and what
// they must never read or write. Worked out once, as the run starts; the settings files only put these into each
// harness's own words.

import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export interface Places {
  /** The run's folder, its top folder: read, and written and organized at will at work. */
  folder: string
  /**
   * The run's own, inside its folder (SCRATCH): its temporary files (`tmp`), and programs' home (`home`) and caches
   * (`cache`). Made as it starts, removed after it.
   */
  scratch: { root: string; tmp: string; home: string; cache: string }
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
 * The programs on a PATH, as folders to read: each that is there, and where it is installed, the folder above a `bin`
 * (`~/.nvm/versions/node/v24/bin` is in `~/.nvm/versions/node/v24`), never the home folder or the root itself.
 */
export function toolchainOf(pathVariable: string, home: string): string[] {
  const out = new Set<string>()
  const root = path.parse(home).root
  for (const dir of pathVariable.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const resolved = path.resolve(dir)
    if (resolved === home || resolved === root) continue
    out.add(resolved)
    const above = path.dirname(resolved)
    if (/^s?bin$/i.test(path.basename(resolved)) && above !== home && above !== root) out.add(above)
  }
  return [...out]
}

/** Whether a path is a folder itself or inside it. */
export function inside(folder: string, file: string): boolean {
  const rel = path.relative(folder, file)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** Where in its folder a run's scratch folders are made, each its own: `<folder>/.celler/run-…`. */
export const SCRATCH = ".celler"

/** A run's own scratch folder, made inside its folder (SCRATCH): there is no other place it may keep anything. */
export function scratchFor(folder: string): Places["scratch"] {
  const parent = path.join(folder, SCRATCH)
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(path.join(parent, "run-"))
  const scratch = { root, tmp: path.join(root, "tmp"), home: path.join(root, "home"), cache: path.join(root, "cache") }
  for (const dir of [scratch.tmp, scratch.home, scratch.cache]) mkdirSync(dir)
  return scratch
}

/** A run's scratch folder gone after it, and the folder holding the scratch folders, once none is left in it. */
export function removeScratch(scratch: Places["scratch"]): void {
  rmSync(scratch.root, { recursive: true, force: true })
  try {
    rmdirSync(path.dirname(scratch.root))
  } catch {
    // Another run's scratch is still there, or it is gone already.
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
    toolchain: toolchainOf(o.pathVariable, home),
    readable: (o.readable ?? []).map((p) => path.resolve(p)),
    secrets: secretsIn(o.folder),
    hidden: o.hidden,
  }
}
