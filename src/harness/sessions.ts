// All an agent keeps of a session removed, once the work the session belonged to is done: its transcript, the record
// of its run with every prompt and tool result, which it resumes the session from, and everything else it keeps by the
// session's id, where its agent keeps it (agents.ts). Where the agent deletes a session itself, as Codex does, its own
// deletion goes first: it alone edits what its sessions share, its files and databases. Then what is still there of
// the session's own in its folders goes. Only the session's own: each folder on the way to it is one, by lstat, never
// a link, and a link where one of them would be is left as it is, with what it leads to.

import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { harnessLimits as L } from '../limits.js';
import type { Agent, SessionFolder } from './agents.js';
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
  const named = env[agent.homeVariable] || path.join(person, agent.sessions.home);
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
 * The session's own in a folder, and in the folders `depth` down in it: the files and folders named as its own, never a
 * link. A folder that isn't the session's is gone into only as a folder, never through a link.
 */
async function ownIn(folder: string, depth: number, own: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await entriesOf(folder)) {
    const file = path.join(folder, entry.name);
    if (own(entry.name)) {
      if (entry.isFile() || entry.isDirectory()) found.push(file);
    } else if (depth > 0 && entry.isDirectory()) {
      found.push(...(await ownIn(file, depth - 1, own)));
    }
  }
  return found;
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

/** The last line a program said, where it says why it failed. */
function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return lines[lines.length - 1]?.trim() ?? '';
}

/**
 * The agent's own deletion of a session, by its own program, in its home and the environment its runs have: null once
 * it deleted it, else why not (its program not there, or what it said when it refused).
 */
function deleteByAgent(agent: Agent, args: string[], home: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const found = agent.find();
  if (typeof found !== 'string') return Promise.resolve(found.missing);
  const { program } = agent.started(found);
  // In its own home, so that no folder of the host's is the one it reads settings from.
  const options = { cwd: home, env, timeout: L.sessionDeleteMs, windowsHide: true };
  return new Promise((resolve) => {
    execFile(program, args, options, (err, _out, stderr) => {
      if (!err) return resolve(null);
      resolve((lastLine(String(stderr)) || errorText(err)).slice(0, L.errorChars));
    });
  });
}

/**
 * All an agent keeps of a session removed, by its working folder and its id, in the environment its agent's runs have
 * (`env`): the paths of the files and folders that went, none when there was nothing. Where the agent deletes a session
 * itself, it does so first, and its refusal is an error, unless none of what its deletion removes was there: it
 * refuses a session it doesn't have. An id that isn't a session's is refused.
 */
export async function removeSession(
  agent: Agent,
  session: { cwd: string; sessionId: string },
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const { sessionId } = session;
  if (!SESSION_ID.test(sessionId))
    throw new Error(`${JSON.stringify(sessionId)} isn't the id of one of ${agent.name}'s sessions: those are UUIDs`);
  const home = await homeOf(agent, env);
  if (!home) return [];
  const { sessions } = agent;
  const found: { file: string; folder: SessionFolder }[] = [];
  for (const folder of sessions.folders(await realPath(session.cwd))) {
    const at = await folderIn(home, folder.path);
    if (!at) continue;
    const named = (name: string) => folder.named(name, sessionId);
    for (const file of await ownIn(at, folder.depth, named)) found.push({ file, folder });
  }
  let deleted = false;
  if (sessions.deletes) {
    const refused = await deleteByAgent(agent, sessions.deletes(sessionId), home, env);
    if (refused !== null && found.some(({ folder }) => folder.deleted))
      throw new Error(`${agent.name} could not delete its session ${sessionId}: ${refused}`);
    deleted = refused === null;
  }
  const removed: string[] = [];
  for (const { file, folder } of found) {
    // Gone with its agent's own deletion, or removed here.
    const goneWithIt = deleted && folder.deleted === true && (await lstatOf(file)) === null;
    if (goneWithIt || (await removeOne(file))) removed.push(file);
  }
  return removed;
}
