// Where a run's commands may go, which the settings files beside this one put into each harness's own words
// (claude.*.ts, codex.*.ts): the run's folder, with its own scratch folder inside it, and none of the person's home,
// the system's temporary folders or the agent's own home. celler keeps no list of where secrets might be: the home is
// closed as a whole, and PATH, which declares the person's programs, is what opens their folders in it again. These are
// facts about the run, worked out once as it starts, each folder by its real name.

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface Places {
  /** The run's folder, its top folder: read, and written and organized at will at work. */
  folder: string;
  /**
   * The run's own, inside its folder (SCRATCH): its temporary files (`tmp`), and programs' home (`home`) and caches
   * (`cache`). And a folder of its own with a short path (`short`), for what can't have a long one: Claude Code's shell
   * keeps its temporary files and sockets there. On macOS and Linux it is in /tmp, outside the folder; Windows has no
   * such limit, and it is the run's `tmp`. Made as it starts, removed after it.
   */
  scratch: { root: string; tmp: string; home: string; cache: string; short: string };
  /** The system's temporary folders, and the person's own runtime ones, which other programs share: never read or written. */
  temps: string[];
  /** The person's home folder, where the host keeps its data too: never read, but for the run's folder if it is in it. */
  home: string;
  /**
   * The agent's own home, where it keeps its settings and sign-in, when it is told one (Codex's CODEX_HOME, Claude
   * Code's CLAUDE_CONFIG_DIR): never read or written, wherever it is.
   */
  agentHomes: string[];
  /** The folders on PATH inside the person's home, as PATH declares them: their programs run. */
  tools: string[];
  /** What the host adds, read only: a worktree's repository data. */
  readable: string[];
  /** Variables in the agent's environment its commands must never see: the proxies'. */
  hidden: string[];
}

/**
 * A folder's own settings for the agents celler runs, which they load from it and may start programs from outside any
 * sandbox (a Codex MCP server in `.codex/config.toml`, a Claude Code hook): never written by a run's commands, wherever
 * they are in its folder, so a run can't set up what the person's own agent starts there. Codex's sandbox takes such
 * patterns only to deny, so its commands don't read them either.
 */
export const AGENT_SETTINGS = ['.codex', '.agents', '.claude', '.mcp.json'];

/** Whether a path is a folder itself or inside it. */
export function inside(folder: string, file: string): boolean {
  const rel = path.relative(folder, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Whether a path is outside a folder, as named or as the folder really is (macOS's /tmp). */
export function outside(file: string, folder: string): boolean {
  const out = (dir: string) => !inside(dir, path.resolve(dir, file));
  try {
    return out(path.resolve(folder)) && out(realpathSync(folder));
  } catch {
    return true;
  }
}

/** Where in its folder a run's scratch folders are made, each its own: `<folder>/.celler/run-…`. */
const SCRATCH = '.celler';

/**
 * A run's own scratch folder, made inside its folder (SCRATCH), and its short one, in /tmp on macOS and Linux, which
 * only its owner may use: there is no other place it may keep anything. git leaves the scratch alone, by a .gitignore
 * of its own, so a commit made in the folder holds none of it, nor does a search of the folder's files.
 */
export function scratchFor(folder: string): Places['scratch'] {
  // By its full path, as the run's variables name it (TMPDIR), whatever folder each of its programs is in.
  const parent = path.resolve(folder, SCRATCH);
  mkdirSync(parent, { recursive: true });
  // Inside the folder as it really is, never through a link a run or a repository put in its place: the run's commands
  // may write in their scratch, so one made through a link would open where it leads to them. Nothing is made through a
  // link found there, and one put there as the scratch is made is found after, and what was made taken back.
  const leadsOutside = () =>
    new Error(`${parent} leads outside the run's folder: a run's scratch is made only inside it`);
  if (!lstatSync(parent).isDirectory()) throw leadsOutside();
  const root = mkdtempSync(path.join(parent, 'run-'));
  if (!inside(realpathSync(folder), realpathSync(root))) {
    rmdirSync(root);
    throw leadsOutside();
  }
  const tmp = path.join(root, 'tmp');
  let short: string | undefined;
  try {
    writeFileSync(path.join(root, '.gitignore'), '*\n');
    short = process.platform === 'win32' ? tmp : mkdtempSync(path.join(realpathSync('/tmp'), 'celler-'));
    const scratch = { root, tmp, home: path.join(root, 'home'), cache: path.join(root, 'cache'), short };
    for (const dir of [scratch.tmp, scratch.home, scratch.cache]) mkdirSync(dir);
    return scratch;
  } catch (err) {
    // One that can't be made whole goes again, and with it the folder that holds the scratch folders, if none is left.
    for (const made of [root, short]) if (made) rmSync(made, { recursive: true, force: true });
    try {
      rmdirSync(parent);
    } catch {
      // Another run's scratch is there.
    }
    throw err;
  }
}

/**
 * A run's scratch folders gone after it, and the folder holding the scratch folders, once none is left in it. Removed
 * in the background, as a run's caches can be large; it never fails: what can't be removed (a file still open on
 * Windows) stays.
 */
export async function removeScratch(scratch: Places['scratch']): Promise<void> {
  await removeFolder(scratch.root);
  await removeFolder(scratch.short);
  try {
    // At once, so it never falls between another run's scratchFor making this folder and its scratch in it.
    rmdirSync(path.dirname(scratch.root));
  } catch {
    // Another run's scratch is still there, or it is gone already.
  }
}

/** A folder and all in it gone, or as much of it as can go; it never fails. */
export async function removeFolder(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    try {
      // A tool's read-only folders, such as Go's module cache: made writable, then removed.
      await makeWritable(dir);
      await rm(dir, { recursive: true, force: true });
    } catch {
      // It stays.
    }
  }
}

/** A folder and every folder in it writable by its owner; never through a link, which is left as it is. */
async function makeWritable(dir: string): Promise<void> {
  if (!(await lstat(dir)).isDirectory()) return;
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeWritable(path.join(dir, entry.name));
  }
}

/** macOS's data volume, where the person's and the system's own folders of "/" (/Users, /private) are, by other names. */
const MACOS_DATA = '/System/Volumes/Data';

/**
 * A folder by its real path, as the system names it (macOS's in its own case), or null when there is none. On macOS, a
 * folder named from its data volume goes by its name from "/" when that is the same folder: /System/Volumes/Data/Users/x
 * is /Users/x. The data volume itself is no folder of "/", and keeps its name.
 */
export function realFolder(dir: string): string | null {
  try {
    const real = realpathSync.native(dir);
    if (!statSync(real).isDirectory()) return null;
    if (process.platform !== 'darwin' || !real.startsWith(`${MACOS_DATA}/`)) return real;
    const named = real.slice(MACOS_DATA.length);
    return sameFolder(real, named) ? named : real;
  } catch {
    return null;
  }
}

/** Whether two paths are the same folder, by its device and inode. */
function sameFolder(a: string, b: string): boolean {
  try {
    const [one, other] = [statSync(a, { bigint: true }), statSync(b, { bigint: true })];
    return one.dev === other.dev && one.ino === other.ino;
  } catch {
    return false;
  }
}

/** A path as a run's places have it: a folder by its real path (realFolder), anything else as named. */
const canonical = (place: string) => realFolder(place) ?? path.resolve(place);

/** Every name a place has: on macOS, also its data volume's (/System/Volumes/Data/Users/x for /Users/x). */
const namesOf = (place: string) => (process.platform === 'darwin' ? [place, MACOS_DATA + place] : [place]);

/** macOS's own folder for each user, which holds their temporary files (`T`) beside their caches (`C`) and more. */
const MACOS_USER_FOLDER = /^\/private\/var\/folders\/[^/]+\/[^/]+$/;

/**
 * The system's temporary folders, and the person's own runtime ones (macOS's folder of theirs that holds their
 * temporary files, Linux's /dev/shm and XDG_RUNTIME_DIR), as they really are: macOS's /tmp is a link to /private/tmp,
 * and a link closed itself would close every path through it, even to a folder opened again inside (the run's short
 * folder).
 */
export function systemTemps(): string[] {
  const own = realFolder(os.tmpdir());
  const named: Partial<Record<NodeJS.Platform, (string | null | undefined)[]>> = {
    darwin: [own && MACOS_USER_FOLDER.test(path.dirname(own)) ? path.dirname(own) : own, '/tmp', '/var/tmp'],
    linux: [own, '/tmp', '/var/tmp', '/dev/shm', process.env.XDG_RUNTIME_DIR],
    win32: [own],
  };
  const out = new Set<string>();
  for (const dir of named[process.platform] ?? [own, '/tmp', '/var/tmp']) {
    const real = dir ? realFolder(dir) : null;
    if (real) out.add(real);
  }
  return [...out];
}

/** What the agents' sandboxes take as a pattern in a path they are given, not as itself: Claude Code's, Codex's. */
const PATTERN = /[*?[\]]/;

/**
 * Why a run can't be given a folder, to work in or to read (`as`), or null: the same for its folder and for each the
 * host adds. One that is, or holds, the person's home or one of the system's temporary folders would open them all to
 * the run, and the filesystem's root holds them all; one that is, holds or is in the agent's own home (`agentHomes`)
 * would open its settings and sign-in, as one in an agent's settings wherever they are (AGENT_SETTINGS: ~/.codex, a
 * repository's .claude) would. One whose path a sandbox would take as a pattern could open other places than itself:
 * Claude Code doesn't keep its commands from the home for such a folder. Each place by every name it has.
 */
export function unfitFolder(
  folder: string,
  agentHomes: string[] = [],
  as: 'work in' | 'read' = 'work in',
): string | null {
  const real = canonical(folder);
  if (PATTERN.test(real))
    return `A run can't ${as} ${real}: its path holds * ? [ or ], which the agents' sandboxes take as a pattern`;
  const settings = real.split(path.sep).find((name) => AGENT_SETTINGS.includes(name));
  if (settings)
    return `A run can't ${as} ${real}: it is in ${settings}, the settings of an agent celler runs, which no run may change`;
  const shared = [canonical(os.homedir()), ...systemTemps(), canonical(os.tmpdir())].flatMap(namesOf);
  const held = shared.find((place) => inside(real, place));
  if (held) return `A run can't ${as} ${real}: it holds ${held}, which no run may reach`;
  for (const home of agentHomes.map(canonical).flatMap(namesOf)) {
    if (inside(real, home))
      return `A run can't ${as} ${real}: it holds ${home}, the agent's own home, which no run may reach`;
    if (inside(home, real))
      return `A run can't ${as} ${real}: it is in ${home}, the agent's own home, which no run may reach`;
  }
  return null;
}

/**
 * The folders on a PATH that are inside the home, by their real paths, never the home itself; and, for each program in
 * them that is a link to one elsewhere in the home (nvm's npm, a version manager's tools), where that program is.
 */
export function homeTools(pathVariable: string, home: string): string[] {
  const out = new Set<string>();
  for (const entry of pathVariable.split(path.delimiter)) {
    const dir = path.isAbsolute(entry) ? realFolder(entry) : null;
    if (!dir || dir === home || !inside(home, dir)) continue;
    out.add(dir);
    for (const linked of linkedTools(dir, home)) out.add(linked);
  }
  return [...out];
}

/** Whether a file is a program its owner can run. */
function isProgram(file: string): boolean {
  try {
    const stat = statSync(file);
    return stat.isFile() && (stat.mode & 0o100) !== 0;
  } catch {
    return false;
  }
}

/**
 * Where the programs in a folder that are links lead, in the home: the folder each one is in, and for one in a `bin`
 * folder, what holds that (its package, a version of a tool), whose files it runs with. Never the home, nor a folder
 * right in it (.local, .cargo), which holds more of the person's than their programs. Only a link to a program counts.
 */
function linkedTools(dir: string, home: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let real: string;
    try {
      if (!lstatSync(file).isSymbolicLink()) continue;
      real = realpathSync.native(file);
    } catch {
      continue;
    }
    const folder = realFolder(path.dirname(real));
    if (!folder || !isProgram(real) || folder === home || !inside(home, folder)) continue;
    out.push(folder);
    const holder = path.dirname(folder);
    if (path.basename(folder) === 'bin' && holder !== home && path.dirname(holder) !== home) out.push(holder);
  }
  return out;
}

/**
 * A run's places, as it starts: its folder and the scratch in it, the agent's own home, its programs' folders in the
 * home by the PATH it runs with, what the host adds and hides; each folder by its real path, as the sandboxes see it.
 */
export function placesFor(o: {
  folder: string;
  scratch: Places['scratch'];
  agentHomes: string[];
  path: string;
  readable?: string[];
  hidden: string[];
}): Places {
  const home = canonical(os.homedir());
  return {
    folder: canonical(o.folder),
    scratch: o.scratch,
    temps: systemTemps(),
    home,
    agentHomes: o.agentHomes.map(canonical),
    tools: homeTools(o.path, home),
    readable: (o.readable ?? []).map(canonical),
    hidden: o.hidden,
  };
}
