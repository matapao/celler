// A session's transcript removed: the record its agent keeps of its run, with every prompt and tool result, which it
// resumes the session from, so a host removes it once the work the session belonged to is done. Only that session's
// own files go, as its agent names them (agents.ts), in its agent's own transcript folders: each folder on the way to
// them is one, by lstat, never a link, and a link where one of them would be is left as it is, with what it leads to.

import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from './agents.js';
import { errorText } from './types.js';

/** A session's id as both agents make it, a UUID: it names no path, and no other session's id holds it. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an error says a path isn't there, or that what leads to it isn't a folder. */
function isMissing(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** What a path is, by lstat, or null when it isn't there. */
async function lstatOf(file: string) {
  try {
    return await lstat(file);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** A folder by its real path, as its agent had it working there; once it is gone, by its nearest folder still there. */
async function realPath(folder: string): Promise<string> {
  const resolved = path.resolve(folder);
  try {
    return await realpath(resolved);
  } catch (err) {
    const parent = path.dirname(resolved);
    if (!isMissing(err) || parent === resolved) return resolved;
    return path.join(await realPath(parent), path.basename(resolved));
  }
}

/** The agent's own home by its real path, as its runs' environment names it, else in the person's; null when none. */
async function homeOf(agent: Agent, env: NodeJS.ProcessEnv): Promise<string | null> {
  const person = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  const named = env[agent.homeVariable] || path.join(person, agent.transcripts.home);
  try {
    const home = await realpath(named);
    return (await lstat(home)).isDirectory() ? home : null;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** A folder in the home, by its path there, when each on the way is a folder, never a link; else null. */
async function folderIn(home: string, names: string[]): Promise<string | null> {
  let folder = home;
  for (const name of names) {
    folder = path.join(folder, name);
    const stat = await lstatOf(folder);
    if (!stat?.isDirectory()) return null;
  }
  return folder;
}

/** A folder's entries, as lstat has them; none when it isn't there. */
async function entriesOf(folder: string): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/**
 * The session's own in a folder, and in the folders `depth` down in it, removed: what was. A folder that isn't the
 * session's is gone into only as a folder, never through a link.
 */
async function removeIn(folder: string, depth: number, own: (name: string) => boolean): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await entriesOf(folder)) {
    const file = path.join(folder, entry.name);
    if (own(entry.name)) {
      if (await removeOne(file)) removed.push(file);
    } else if (depth > 0 && entry.isDirectory()) {
      removed.push(...(await removeIn(file, depth - 1, own)));
    }
  }
  return removed;
}

/**
 * One of the session's files or folders removed, and whether it was: only where it was found, which still is no link
 * and in none, and only a file or a folder, never a link, which stays as it is, with what it leads to.
 */
async function removeOne(file: string): Promise<boolean> {
  const folder = path.dirname(file);
  try {
    if ((await realpath(folder)) !== folder) return false;
    const stat = await lstat(file);
    if (stat.isFile()) await unlink(file);
    else if (stat.isDirectory()) await rm(file, { recursive: true });
    else return false;
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw new Error(`${file} could not be removed: ${errorText(err)}`);
  }
}

/**
 * A session's transcript removed, by its working folder and its id, in the environment its agent's runs have (`env`):
 * what its agent keeps of that session in its own transcript folders, and nothing else. The paths it removed, none when
 * there was nothing; an id that isn't a session's is refused.
 */
export async function removeTranscript(
  agent: Agent,
  session: { cwd: string; sessionId: string },
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const { sessionId } = session;
  if (!SESSION_ID.test(sessionId))
    throw new Error(`${JSON.stringify(sessionId)} isn't the id of one of ${agent.name}'s sessions: those are UUIDs`);
  const home = await homeOf(agent, env);
  if (!home) return [];
  const { transcripts } = agent;
  const own = (name: string) => transcripts.named(name, sessionId);
  const removed: string[] = [];
  for (const { path: names, depth } of transcripts.folders(await realPath(session.cwd))) {
    const folder = await folderIn(home, names);
    if (folder) removed.push(...(await removeIn(folder, depth, own)));
  }
  return removed;
}
