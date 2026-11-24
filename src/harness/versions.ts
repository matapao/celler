// An agent's program's version, as it says it: whether it is new enough to run here, and known once it has said one
// that is, until its file changes.

import { statSync } from 'node:fs';
import type { Agent } from './agents.js';
import { runForOutput } from './programs.js';

/** The first version number in what a program says, "2.1.330" in "2.1.330 (Claude Code)". */
const versionIn = (said: string) => /\d+\.\d+\.\d+/.exec(said)?.[0] ?? null;

/** Whether a version ("2.1.300") is older than another, part by part. */
function older(version: string, than: string): boolean {
  const [a, b] = [version, than].map((v) => v.split('.').map(Number));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** Each program's version, by its file as it was asked (fileOf). */
const versions = new Map<string, string>();

/** A program's file as it is now: its path, when it last changed and its size; null when it isn't there. */
function fileOf(program: string): string | null {
  try {
    const { mtimeMs, size } = statSync(program);
    return JSON.stringify([program, mtimeMs, size]);
  } catch {
    return null;
  }
}

/**
 * What a program says its version is, or null: known at once once it has said one that runs (no older than `oldest`),
 * until its file changes. One too old is asked again each time: behind a shim, an update leaves the file as it was.
 */
export function versionOf(program: string, env: NodeJS.ProcessEnv, oldest: string): string | Promise<string | null> {
  const file = fileOf(program);
  const known = file ? versions.get(file) : undefined;
  if (known) return known;
  return runForOutput(program, ['--version'], env).then((said) => {
    const version = said ? versionIn(said) : null;
    if (file && version && !older(version, oldest)) versions.set(file, version);
    return version;
  });
}

/** Why a version of the agent's program doesn't run here, or null: it said none, or it is older than the oldest that runs. */
export function unfitVersion(agent: Agent, found: string, version: string | null): string | null {
  if (!version) return `Could not run ${found} --version.`;
  if (older(version, agent.oldest))
    return `${agent.name} ${version} is older than ${agent.oldest}, the oldest that runs here: update it.`;
  return null;
}
