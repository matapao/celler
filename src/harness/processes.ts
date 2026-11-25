// The processes the runtime starts, and how they end: an agent's for a run, each in a process group of its own, which
// the run's end ends with everything they started; and the agent's own sign-in.

import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { harnessLimits as L } from '../limits.js';
import type { Turn } from './runtime.js';
import type { AgentLogin } from './types.js';

const isWin = process.platform === 'win32';

/** The processes told to stop already: each is told once. */
const killed = new WeakSet<ChildProcess>();

/** Stops a process and everything it started, once: asks, then insists, if what it asked reached anything. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || killed.has(child)) return;
  killed.add(child);
  if (isWin) {
    if (child.exitCode === null)
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  // It leads its own process group (spawned detached), which outlives it while anything it started runs.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Nothing of it is left, and the group's number may soon be another's: nothing to insist on.
    return;
  }
  const insist = () => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // It ended when asked.
    }
  };
  setTimeout(insist, L.exitGraceMs).unref();
}

/** Once all of these have come, or the grace a process has to exit is over, whichever is first. */
function withinGrace(events: Promise<void>[]): Promise<void> {
  return new Promise((resolve) => {
    const grace = setTimeout(resolve, L.exitGraceMs);
    grace.unref();
    void Promise.all(events).then(() => {
      clearTimeout(grace);
      resolve();
    });
  });
}

/** What a run's agent starts, each in its own process group, so its end ends what its commands left running. */
export class RunProcesses {
  private children: { child: ChildProcess; exited: Promise<void> }[] = [];
  /** The end of what they said on their error output. */
  private said = '';

  /** Starts one of them, as a run's agent starts its processes (Turn). */
  readonly spawn: Turn['spawn'] = (command, args, o) => {
    // Its streams, however its type has them: one that couldn't start (no file descriptor left) comes without them.
    const child: ChildProcess = spawn(command, args, {
      cwd: o.cwd,
      env: o.env,
      signal: o.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWin,
    });
    // First, as nothing else may be: that one says why only here. Its SDK then fails the run; the host goes on.
    child.on('error', () => undefined);
    child.stderr?.setEncoding('utf8').on('data', (c: string) => (this.said = (this.said + c).slice(-L.stderrChars)));
    // An answer to one that has gone finds no one there: that ends nothing else.
    child.stdin?.on('error', () => undefined);
    this.children.push({ child, exited: new Promise((resolve) => child.once('exit', () => resolve())) });
    return child as ChildProcessWithoutNullStreams;
  };

  readonly stderr: Turn['stderr'] = () => this.said;

  /** The first one's, once started. */
  get pid(): number | undefined {
    return this.children[0]?.child.pid;
  }

  /** Stops each of them now, and everything it started. */
  stopAll(): void {
    for (const { child } of this.children) killTree(child);
  }

  /**
   * What they left running ends with them, once each has exited, or after its grace if it lingers. Settles once all of
   * them have exited, or their grace is over.
   */
  end(): Promise<void> {
    for (const { child, exited } of this.children) {
      const lingering = setTimeout(() => killTree(child), L.exitGraceMs);
      lingering.unref();
      void exited.then(() => {
        clearTimeout(lingering);
        killTree(child);
      });
    }
    return withinGrace(this.children.map(({ exited }) => exited));
  }
}

/**
 * A sign-in page's address in what its agent prints: up to the first space, control character (a terminal link's own,
 * as Claude Code wraps it: OSC 8), quote or closing bracket. Until one of those comes, the rest may still be on its way.
 */
// oxlint-disable-next-line no-control-regex -- a control character ends the address: this finds them on purpose
const LOGIN_URL = /https:\/\/[^\s\x00-\x1f\x7f"'`)\]}>]+(?=[\s\x00-\x1f\x7f"'`)\]}>])/;

/** An agent's own sign-in: it opens the browser and prints the page's address; a code the page shows goes to its input. */
export function startLogin(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  /** Where it shows its one-time code, as the agent's `login.elsewhere.userCode`: there is none without it. */
  shown?: RegExp,
): AgentLogin {
  const child: ChildProcess = spawn(program, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWin,
  });
  // First, as nothing else may be: one that couldn't start comes without its streams, and says why only here.
  let failed: (err: Error) => void = () => undefined;
  child.on('error', (err) => failed(err));
  const said = { stdout: '', stderr: '' };
  let gotUrl: (u: string | null) => void = () => undefined;
  const url = new Promise<string | null>((resolve) => (gotUrl = resolve));
  let gotCode: (c: string | null) => void = () => undefined;
  const userCode = shown && new Promise<string | null>((resolve) => (gotCode = resolve));
  // Its page's address on either of its outputs, and its code: an agent may print them on its error output.
  for (const output of ['stdout', 'stderr'] as const) {
    child[output]?.on('data', (c: Buffer) => {
      said[output] = (said[output] + c.toString('utf8')).slice(-L.stderrChars);
      const m = LOGIN_URL.exec(said[output]);
      if (m) gotUrl(m[0]);
      const code = shown?.exec(stripVTControlCharacters(said[output]))?.[1];
      if (code) gotCode(code);
    });
  }
  child.stdin?.on('error', () => undefined);
  // Ended here, it says so, not what it said last: Codex's last line from another device is its warning.
  let endedHere: string | undefined;
  const end = (why: string) => {
    endedHere ??= why;
    killTree(child);
  };
  const timer = setTimeout(() => end(`Sign-in left open for ${L.loginMs / 60_000} min`), L.loginMs);
  const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    failed = (err) => {
      clearTimeout(timer);
      gotUrl(null);
      gotCode(null);
      resolve({ ok: false, error: err.message });
    };
    child.on('close', (code) => {
      clearTimeout(timer);
      gotUrl(null);
      gotCode(null);
      const last = (text: string) => stripVTControlCharacters(text).trim().split('\n').filter(Boolean).at(-1);
      resolve(
        code === 0
          ? { ok: true }
          : {
              ok: false,
              error: endedHere ?? last(said.stderr) ?? last(said.stdout) ?? `Login ended with code ${code}`,
            },
      );
    });
  });
  return {
    url,
    ...(userCode ? { userCode } : {}),
    done,
    sendCode: (code) => void child.stdin?.write(`${code.trim()}\n`),
    cancel: () => end('Sign-in called off'),
  };
}
