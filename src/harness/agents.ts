// The two coding agents, Claude Code and Codex, as data: what each needs found, how it says its version and whether it
// is signed in, how it signs in, how a run of it goes, through its own SDK (claude.ts, codex.ts), and what it keeps of
// each session, where, and how it deletes one itself (sessions.ts). One runtime runs either (runtime.ts). Each works
// with its own tools in the run's folder, its commands in its own sandbox at its strictest, as the settings files for
// each system say (sandbox/claude.*.ts, sandbox/codex.*.ts); everything outside the folder goes through the run's MCP
// tools.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentVersions, harnessLimits } from '../limits.js';
import { runClaude } from './claude.js';
import { codexFeatures, runCodex } from './codex.js';
import { codexProgram, findProgram, realProgram, type AgentProgram } from './programs.js';
import type { Turn } from './runtime.js';
import type { ClaudeWords, CodexWords, Host, ModelTier, RunResult } from './types.js';

export interface Agent {
  kind: string;
  name: string;
  /** Its own program, as found, or what the host says when it isn't there. */
  find(): string | { missing: string };
  /** The program that runs for the one found, and the folders it needs on PATH. */
  started(found: string): { program: string; path: string[] };
  /** Made ready before each start: a run, its sign-in, its health check. */
  ready?(): void;
  /** Added to its environment whenever it starts ('' removes a variable). */
  env(host: Host): Record<string, string>;
  /**
   * The variable naming its own home, where it keeps its settings and sign-in, when its environment has it: no run's
   * folder is, holds or is in that home, and its commands never reach it (sandbox/places.ts).
   */
  homeVariable: string;
  /** The oldest version of it that runs, as its `--version` says it (limits.ts agentVersions). */
  oldest: string;
  /**
   * Its features, as its program lists them under the settings a run gives it (`args`), and why they don't run here
   * (`unfit`), or null: asked before its first run and in its health, as its version is (versions.ts).
   */
  features?: { args: string[]; unfit(listed: string | null): string | null };
  /** Asked of its program; `yes` reads the answer: signed in, not, or null when it can't tell. */
  signedIn: { args: string[]; anyExit?: boolean; yes(answer: string | null): boolean | null };
  /**
   * Its own sign-in, and what its health says when it isn't signed in. `elsewhere`: its sign-in for a person whose
   * browser is on another device, where its own waits for its page on this computer, and how it shows its one-time code
   * (`userCode`, the code its first group matches once the output's terminal escapes are gone).
   */
  login: { args: string[]; signedOut: string; elsewhere?: { args: string[]; userCode: RegExp } };
  testRunMs: number;
  /** It searches its MCP tools itself, loading only those it needs: a run lists them all to it, not celler's menu. */
  nativeDiscovery: boolean;
  /** One run, through its own SDK. */
  run(turn: Turn): Promise<RunResult>;
  /** What it keeps of each session, and how it deletes one itself (sessions.ts). */
  sessions: Sessions;
}

/**
 * What an agent keeps of each session, its transcript with every prompt and tool result among it, which it resumes the
 * session from: in folders of its own home (`homeVariable`'s, else `home` in the person's), some found by the session's
 * working folder, by its real path. Nothing else there is one session's. Where it deletes a session itself (`deletes`,
 * its program's arguments), its deletion removes the session's own in the folders marked `deleted`, and its lines and
 * rows in the files and databases its sessions share; it refuses a session it doesn't have.
 */
interface Sessions {
  home: string;
  folders(cwd: string): SessionFolder[];
  deletes?(sessionId: string): string[];
}

/**
 * One of an agent's folders, by its path in its home: in it, and in the folders `depth` down in it, the names that are
 * a session's own, by its id exactly.
 */
export interface SessionFolder {
  path: string[];
  depth: number;
  named(name: string, sessionId: string): boolean;
  deleted?: boolean;
}

/** A name that is a session's own: its id, or its id and then a dot (`<id>.jsonl`, `<id>.txt`, `<id>.<n>.sh`). */
function byId(name: string, sessionId: string): boolean {
  return name === sessionId || name.startsWith(`${sessionId}.`);
}

/** One of an agent's folders, by its path in its home, where a session's own are named by its id (`byId`). */
function folderById(...names: string[]): SessionFolder {
  return { path: names, depth: 0, named: byId };
}

/** The models a tier runs on, as each agent names them. */
const MODELS: Record<AgentProgram, Record<ModelTier, string>> = {
  claude: { fast: 'haiku', balanced: 'sonnet', strong: 'opus' },
  codex: { fast: 'gpt-6-luna', balanced: 'gpt-6.1-sol', strong: 'gpt-6-astra' },
};

/** The model a tier runs on, as each agent names it. */
export const tierModel = (agent: AgentProgram, tier: ModelTier): string => MODELS[agent][tier];

// ---------------------------------------------------------------- Claude Code

/** Its own sign-in only: a key or token from the shell would win over it, and an endpoint from the shell would get it. */
const OWN_SIGN_IN = {
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
  ANTHROPIC_BASE_URL: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CODE_USE_BEDROCK: '',
  CLAUDE_CODE_USE_VERTEX: '',
  CLAUDE_CODE_USE_FOUNDRY: '',
};

/** How much of a working folder's path Claude Code's name for its sessions' folder holds as it is, at most. */
const PROJECT_NAME_CHARS = 200;

/** A string's hash as Claude Code makes it, Java's: a 32-bit integer. */
function stringHash(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return hash;
}

/**
 * Claude Code's name for a working folder's sessions' folder in its home's `projects`: the folder's real path (in NFC
 * on macOS) with every character but an ASCII letter or digit a "-"; a longer one than PROJECT_NAME_CHARS cut there,
 * then a "-" and the whole path's hash.
 */
function projectName(cwd: string): string {
  const real = process.platform === 'darwin' ? cwd.normalize('NFC') : cwd;
  const name = real.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= PROJECT_NAME_CHARS) return name;
  return `${name.slice(0, PROJECT_NAME_CHARS)}-${Math.abs(stringHash(real)).toString(36)}`;
}

/**
 * Claude Code's, wherever its own code names them by a session's id in its config folder. It deletes none of one
 * session's itself: its SDK's deleteSession removes its transcript and its folder only, and `claude purge` all of a
 * working folder's sessions. Its prompt history, `history.jsonl`, is its own terminal's: a session through its SDK
 * writes none there.
 */
const CLAUDE_SESSIONS: Sessions = {
  home: '.claude',
  folders: (cwd) => [
    // Its transcript, `<id>.jsonl`, in its working folder's sessions' folder, and beside it what is that session's too:
    // its folder `<id>` (its helpers' transcripts, its large tool results) and `<id>.…` (one set aside, its records of
    // a compaction or a cloud session).
    folderById('projects', projectName(cwd)),
    // The files it changed, as they were before, to rewind them (`<id>/`).
    folderById('file-history'),
    // What its hooks set for its commands' shell (`<id>/`).
    folderById('session-env'),
    // Its task list (`<id>/`).
    folderById('tasks'),
    // The files and the pictures it was given (`<id>/`).
    folderById('uploads'),
    folderById('image-cache'),
    // Its debug log (`<id>.txt`).
    folderById('debug'),
    // What /insights made of it (`<id>.json`).
    folderById('usage-data', 'session-meta'),
    folderById('usage-data', 'facets'),
    // Where they are asked for, its start's timings (`<id>.txt`, `<id>.json`) and its requests as sent (`<id>.jsonl`).
    folderById('startup-perf'),
    folderById('dump-prompts'),
    // Its usage events not yet sent (`1p_failed_events.<id>.<batch>.json`).
    { path: ['telemetry'], depth: 0, named: (name, sessionId) => name.startsWith(`1p_failed_events.${sessionId}.`) },
    // Its to-do lists, as versions before its task lists kept them (`<id>-agent-<agent>.json`).
    { path: ['todos'], depth: 0, named: (name, sessionId) => name.startsWith(`${sessionId}-agent-`) },
  ],
};

/** Claude Code, the person's own, through the Claude Agent SDK. */
export function claudeAgent(o: { claude?: () => string | null; words: ClaudeWords }): Agent {
  const program = () => (o.claude ? o.claude() : findProgram('claude'));
  return {
    kind: 'claude-code',
    name: 'Claude Code',
    find: () => program() ?? { missing: o.words.noClaude },
    started: (found) => ({ program: realProgram(found), path: [] }),
    // The host by its name, in the agent's requests, as the Agent SDK has it said.
    env: (host) => ({ ...OWN_SIGN_IN, CLAUDE_AGENT_SDK_CLIENT_APP: `${host.client.name}/${host.client.version}` }),
    // Where the person keeps its settings and sign-in, when not in their home (programs.ts keeps it for its runs).
    homeVariable: 'CLAUDE_CONFIG_DIR',
    oldest: agentVersions.claude,
    signedIn: { args: ['auth', 'status', '--json'], anyExit: true, yes: loggedIn },
    login: { args: ['auth', 'login', '--claudeai'], signedOut: 'not logged in to Claude' },
    testRunMs: harnessLimits.claudeTestRunMs,
    // Its ToolSearch.
    nativeDiscovery: true,
    run: (turn) => runClaude(turn, { models: MODELS.claude, signedOut: o.words.login }),
    sessions: CLAUDE_SESSIONS,
  };
}

function loggedIn(answer: string | null): boolean | null {
  try {
    const status = JSON.parse(answer ?? '');
    return typeof status?.loggedIn === 'boolean' ? status.loggedIn : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Codex

/** A file's text, or null when it isn't there: read at once, never checked for first, which it could change between. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The `config.toml` of the host's Codex home: its sign-in kept in a file there, not the person's own. */
export const CODEX_HOME_CONFIG = 'cli_auth_credentials_store = "file"\n';

/** Its own sign-in only, in its home: a key or token from the shell would win over it, and an endpoint from the shell would get it. */
const CODEX_OWN_SIGN_IN = { OPENAI_API_KEY: '', CODEX_API_KEY: '', CODEX_ACCESS_TOKEN: '', OPENAI_BASE_URL: '' };
/** Its device code's one-time code, as `codex login --device-auth` shows it: alone on the line after it says so. */
const CODEX_USER_CODE = /one-time code\b[^\n]*\n[ \t]*([A-Z0-9]+(?:-[A-Z0-9]+)*)[ \t]*\n/i;

/** A rollout's name: when its thread started, then the thread's id; `.zst` after it once Codex has compressed it. */
const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([^.]+)\.jsonl(?:\.zst)?$/;

/** A thread's rollout, by its name. */
const isRollout = (name: string, sessionId: string) => ROLLOUT.exec(name)?.[1] === sessionId;

/**
 * Codex's, for a thread. Its own deletion (`codex delete --force <id>`) removes its rollouts, its rows in Codex's
 * databases (its messages among them), its name in `session_index.jsonl`, and the threads it started; not its shell's
 * snapshots or the pictures it made. Its prompt history, `history.jsonl`, is its own terminal's: a thread through its
 * SDK writes none there.
 */
const CODEX_SESSIONS: Sessions = {
  home: '.codex',
  folders: () => [
    // Its rollouts, whatever folder it worked in: `sessions/<year>/<month>/<day>/rollout-…-<id>.jsonl`, by the day it
    // started, and once it is archived, in `archived_sessions`.
    { path: ['sessions'], depth: 3, named: isRollout, deleted: true },
    { path: ['archived_sessions'], depth: 3, named: isRollout, deleted: true },
    // Its shell's snapshots (`<id>.<n>.sh`, `<id>.tmp-<n>`), which its end removes, unless it ends otherwise.
    folderById('shell_snapshots'),
    // The pictures it made (`<id>/`).
    folderById('generated_images'),
  ],
  deletes: (sessionId) => ['delete', '--force', sessionId],
};

/**
 * Codex, the person's own CLI, through the Codex SDK, in the host's Codex home (`home`): its sign-in and its sessions
 * are kept there, and as no folder is trusted there, Codex loads no folder's own settings.
 */
export function codexAgent(o: { codex?: () => string | null; home: string; words: CodexWords }): Agent {
  const program = () => (o.codex ? o.codex() : findProgram('codex'));
  return {
    kind: 'codex',
    name: 'Codex',
    find: () => program() ?? { missing: `Codex wasn't found on this computer. ${o.words.install}` },
    started: codexProgram,
    ready: () => {
      // Its sign-in is kept there: made for its owner alone.
      mkdirSync(o.home, { recursive: true, mode: 0o700 });
      const file = path.join(o.home, 'config.toml');
      if (readText(file) !== CODEX_HOME_CONFIG) writeFileSync(file, CODEX_HOME_CONFIG);
    },
    env: () => ({ ...CODEX_OWN_SIGN_IN, CODEX_HOME: o.home }),
    homeVariable: 'CODEX_HOME',
    oldest: agentVersions.codex,
    features: codexFeatures,
    signedIn: { args: ['login', 'status'], yes: (answer) => answer !== null },
    // Its own waits for its page at this computer's localhost; from another device, its device code's page, and the
    // one-time code alone on the line after it says so.
    login: {
      args: ['login'],
      signedOut: o.words.signedOut,
      elsewhere: { args: ['login', '--device-auth'], userCode: CODEX_USER_CODE },
    },
    testRunMs: harnessLimits.codexTestRunMs,
    // Its tool_search, over MCP tools it always defers.
    nativeDiscovery: true,
    run: (turn) => runCodex(turn, { models: MODELS.codex, signedOut: o.words.login }),
    sessions: CODEX_SESSIONS,
  };
}
