// One runtime for either coding agent (agents.ts): whether it can run, its own sign-in, its runs, each through the
// agent's own SDK (claude.ts, codex.ts), and all it keeps of their sessions, removed once their work is done
// (sessions.ts).
// What a run is given (Turn) is the same for both: its places, its environment, and its clock, which stands still while
// the person is asked (clock.ts). What Claude Code's commands leave running ends with its run (processes.ts); Codex's
// SDK starts Codex itself, and its commands' are Codex's to end.

import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { harnessLimits as L } from '../limits.js';
import type { Agent } from './agents.js';
import { RunClock } from './clock.js';
import { RunProcesses, startLogin } from './processes.js';
import { agentEnv, runForOutput } from './programs.js';
import { inside, removeFolder, removeScratch, type Places } from './sandbox/places.js';
import { removeSession } from './sessions.js';
import { setUp } from './setup.js';
import {
  errorText,
  failedRun,
  failure,
  type AgentLogin,
  type Host,
  type RunHandle,
  type RunProgress,
  type RunResult,
  type Runtime,
  type RuntimeHealth,
  type RunSpec,
} from './types.js';
import { unfitFeatures, unfitVersion, versionOf } from './versions.js';

/** What one run of an agent is given, the same whichever SDK runs it. */
export interface Turn {
  spec: RunSpec;
  /** The agent's own program, as it starts. */
  program: string;
  places: Places;
  /** Its environment: its user's, the run's own folders, the agent's own variables. */
  env: NodeJS.ProcessEnv;
  /** Aborted when the run is cancelled or out of time: the agent ends its turn, or is stopped. */
  signal: AbortSignal;
  /** Puts what the agent asks to the person, the run's clock stopped meanwhile; missing when no one is asked. */
  ask?: NonNullable<RunSpec['ask']>;
  progress(p: RunProgress): void;
  /** Starts one of the agent's processes: in its own process group, with no window, its error output kept. */
  spawn(
    command: string,
    args: string[],
    o: { cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  ): ChildProcessWithoutNullStreams;
  /** The end of what its processes said on their error output. */
  stderr(): string;
}

/** An agent's settings file for this system, or why there is none: nothing runs where no sandbox is set up. */
export function forThisSystem<T>(files: Partial<Record<NodeJS.Platform, T>>, name: string): T {
  const file = files[process.platform];
  if (!file) throw new Error(`${name} has no sandbox settings for ${process.platform} here`);
  return file;
}

/** A line an MCP server passed on, which says nothing of the agent's own sign-in. */
const MCP_LINE_RE = /\bmcp[\s_:.-]|mcp server/i;

/** Whether what an agent said tells that it isn't signed in itself (`words`), not one of its MCP servers. */
export function saysSignedOut(text: string, words: RegExp): boolean {
  return text.split('\n').some((line) => !MCP_LINE_RE.test(line) && words.test(line));
}

/** The person's words, then the files given with them as links its agent can open: no words of the host's. */
export function promptOf(spec: RunSpec): string {
  const links = (spec.attachments ?? []).map((a) => `[${a.name}](${pathToFileURL(a.path).href})`);
  return [spec.prompt, links.join('\n')].filter(Boolean).join('\n\n');
}

/** A run's time as people say it: in whole minutes, else in seconds. */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds > 0 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

export class AgentRuntime implements Runtime {
  readonly kind: string;
  readonly nativeDiscovery: boolean;

  constructor(
    readonly agent: Agent,
    private host: Host,
  ) {
    this.kind = agent.kind;
    this.nativeDiscovery = agent.nativeDiscovery;
  }

  /** Found, new enough (as each run checks too), signed in; with `deep`, a tiny test run too. It never throws. */
  async health(deep: boolean): Promise<RuntimeHealth> {
    const checkedAt = Date.now();
    try {
      return await this.check(deep, checkedAt);
    } catch (err) {
      return {
        ok: false,
        checkedAt,
        detail: `${this.agent.name} could not be checked: ${errorText(err).slice(0, L.errorChars)}`,
      };
    }
  }

  private async check(deep: boolean, checkedAt: number): Promise<RuntimeHealth> {
    const { agent } = this;
    const found = agent.find();
    if (typeof found !== 'string') return { ok: false, checkedAt, detail: found.missing, fix: 'find' };
    agent.ready?.();
    const { program } = agent.started(found);
    const env = agentEnv(agent.env(this.host), this.host);
    const [version, answer, features] = await Promise.all([
      versionOf(program, env, agent.oldest),
      runForOutput(program, agent.signedIn.args, env, agent.signedIn.anyExit),
      unfitFeatures(agent, program, env),
    ]);
    const unfit = unfitVersion(agent, found, version);
    if (unfit) return { ok: false, checkedAt, program: found, detail: unfit };
    const named = `${agent.name} ${version}`;
    if (agent.signedIn.yes(answer) === false)
      return { ok: false, checkedAt, program: found, fix: 'login', detail: `${named} · ${agent.login.signedOut}` };
    if (features) return { ok: false, checkedAt, program: found, detail: `${named} ${features}.` };
    if (!deep) return { ok: true, checkedAt, program: found, detail: `${named} (not yet test-run)` };
    // In an empty folder of its own, which no other program or person shares, gone after it.
    const folder = mkdtempSync(path.join(os.tmpdir(), 'celler-test-run-'));
    try {
      const test = {
        cwd: folder,
        prompt: 'Reply with exactly: OK',
        systemPrompt: '',
        model: 'fast',
        sessionId: randomUUID(),
        resume: false,
        mcpServers: [],
        purpose: 'inference' as const,
        timeoutMs: agent.testRunMs,
      };
      const r = await this.run(test, () => undefined).done;
      // One that takes it offline (a sign-in it has that no longer works): the host can offer its sign-in again.
      const fix = r.runtimeDown ? { fix: 'login' as const } : {};
      return {
        ok: r.ok,
        checkedAt,
        program: found,
        ...fix,
        detail: `${named} · ${r.ok ? 'test run succeeded' : (r.error ?? 'test run failed')}`,
      };
    } finally {
      await removeFolder(folder);
    }
  }

  /**
   * Starts the agent's own sign-in, or says why it can't. It never throws. `elsewhere`: the person signs in from a
   * browser on another device, as for a computer with no screen. An agent whose own sign-in waits for its page on this
   * computer (Codex's) then shows a link and a one-time code to enter there (`userCode`); Claude Code's works from
   * anywhere as it is.
   */
  login(o: { elsewhere?: boolean } = {}): AgentLogin | { error: string } {
    try {
      const found = this.agent.find();
      if (typeof found !== 'string') return { error: found.missing };
      this.agent.ready?.();
      const { args, elsewhere } = this.agent.login;
      const from = o.elsewhere ? elsewhere : undefined;
      return startLogin(
        this.agent.started(found).program,
        from?.args ?? args,
        agentEnv(this.agent.env(this.host), this.host),
        from?.userCode,
      );
    } catch (err) {
      return { error: `${this.agent.name}'s sign-in could not start: ${errorText(err).slice(0, L.errorChars)}` };
    }
  }

  /** All the agent keeps of a session removed, in the environment the agent's runs have (sessions.ts). */
  removeSession(session: Pick<RunSpec, 'cwd' | 'sessionId'>): Promise<string[]> {
    return removeSession(this.agent, session, agentEnv(this.agent.env(this.host), this.host));
  }

  run(spec: RunSpec, onProgress: (p: RunProgress) => void): RunHandle {
    const { agent } = this;
    const found = agent.find();
    if (typeof found !== 'string') return failedRun(found.missing, true);
    const setup = setUp(agent, found, spec, this.host);
    if (typeof setup === 'string') return failedRun(setup);
    const { started, places, env, errands } = setup;

    // The run's clock stands still while the person is asked (clock.ts). A run that is over, stopped or ended, takes its
    // asks back: then its clock never starts again, and nothing stops it any more.
    const stopping = new AbortController();
    const asking = new AbortController();
    const over = () => asking.signal.aborted;
    let stopped: 'cancelled' | 'timed out' | null = null;
    const clock = new RunClock(spec.timeoutMs, over, () => stop('timed out'));
    // What the agent starts, each in its own process group, so its end ends what its commands left running.
    const processes = new RunProcesses();
    // Asked to end its turn (its session stays resumable), and what it started stopped if it doesn't end in its grace.
    let ended = false;
    const stop = (why: 'cancelled' | 'timed out') => {
      if (over()) return;
      stopped = why;
      asking.abort();
      stopping.abort();
      setTimeout(() => {
        if (!ended) processes.stopAll();
      }, L.exitGraceMs).unref();
    };
    // A file it changed is the run's, unless it is in its scratch, which goes when it ends.
    const progress = (p: RunProgress) => {
      if (p.type !== 'file') return onProgress(p);
      const file = path.resolve(spec.cwd, p.file);
      if (!inside(places.scratch.root, file)) onProgress({ type: 'file', file });
    };
    const ask = spec.ask;
    const turn: Turn = {
      spec,
      program: started.program,
      places,
      env,
      signal: stopping.signal,
      ...(ask
        ? {
            ask: (q, signal) =>
              clock.meanwhile(() => ask(q, AbortSignal.any([signal, asking.signal])).catch(() => null)),
          }
        : {}),
      progress,
      spawn: processes.spawn,
      stderr: processes.stderr,
    };
    const end = (r: RunResult): RunResult => {
      if (stopped === 'cancelled') return { ...r, ok: false, cancelled: true, error: 'Cancelled' };
      if (stopped === 'timed out')
        return { ...r, ok: false, ended: 'timed-out', error: `Timed out after ${duration(spec.timeoutMs)}` };
      return r;
    };
    clock.arm();
    // Once its agent has started, its first process with it (its SDK starts it as it is called), or once it won't.
    let markStarted: () => void = () => undefined;
    const agentStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markCleaned: () => void = () => undefined;
    const cleaned = new Promise<void>((resolve) => {
      markCleaned = resolve;
    });
    // Never a program older than its SDK is made with, nor one whose features aren't as they must be. Each program is
    // asked once, and again once it changes: known, as after a health check, its agent starts as the run does.
    const begin = (version: string | null, features: string | null): Promise<RunResult> => {
      const unfit = unfitVersion(agent, found, version) ?? (features && `${agent.name} ${version} ${features}.`);
      if (unfit) return Promise.resolve(failure(unfit, true));
      // Stopped while it was asked: it doesn't start (end says why).
      if (over()) return Promise.resolve(failure(''));
      try {
        return agent.run(turn);
      } finally {
        markStarted();
      }
    };
    const version = versionOf(started.program, errands, agent.oldest);
    const features = unfitFeatures(agent, started.program, errands);
    const known = typeof version === 'string' && !(features instanceof Promise);
    const begun = known ? begin(version, features) : Promise.all([version, features]).then(([v, f]) => begin(v, f));
    const done = begun
      .then(end, (err: unknown) => end(failure(errorText(err).slice(0, L.errorChars))))
      .finally(() => {
        markStarted();
        ended = true;
        clock.stop();
        asking.abort();
        // What its commands left running ends with it, and its scratch goes once its processes have exited, or their
        // grace is over: none writes in it as it goes.
        void processes
          .end()
          .then(() => removeScratch(places.scratch))
          .finally(markCleaned);
      });
    return {
      // Its first process's, once started: Claude Code's as its agent starts; Codex's SDK keeps its own to itself.
      get pid() {
        return processes.pid;
      },
      started: agentStarted,
      done,
      cleaned,
      cancel: () => stop('cancelled'),
      hold: clock.hold,
    };
  }
}
