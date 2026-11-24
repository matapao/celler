import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '@matapao/celler';
import { claudeAgent, codexAgent, harnessPlatform } from '@matapao/celler/harness';

// What the harness tests share: the host and its words, the agents with their programs the stand-ins, a run as the
// runtime takes it, its places, a folder for a test, and a host's graph of one cell run by the harness platform.

export const host = { client: { name: 'host', version: '1.0.0' }, mark: (env) => ({ ...env, HOST_RUN: '1' }) };
export const claudeWords = { noClaude: "Claude Code isn't here.", login: 'Sign in to Claude in the host.' };
export const codexWords = {
  install: 'Install Codex.',
  login: 'Sign Codex in to the host.',
  signedOut: 'not signed in for the host',
};
/** Stand-ins for the agents' own programs, as their SDKs drive them (fixtures/fake-claude, fixtures/fake-codex). */
export const fakeClaudeProgram = fileURLToPath(new URL('./fixtures/fake-claude', import.meta.url));
const fakeCodexProgram = fileURLToPath(new URL('./fixtures/fake-codex', import.meta.url));
export const spec = (over = {}) => ({
  cwd: os.tmpdir(),
  prompt: 'x',
  systemPrompt: '',
  model: 'fast',
  sessionId: 's',
  resume: false,
  mcpServers: [],
  purpose: 'work',
  timeoutMs: 20_000,
  ...over,
});
/** A run's places, as sandbox/places.ts works them out: under `dir`, with one of each kind, its scratch in its folder. */
export const placesIn = (dir) => ({
  folder: path.join(dir, 'work'),
  scratch: {
    root: path.join(dir, 'work', '.celler', 'run-1'),
    tmp: path.join(dir, 'work', '.celler', 'run-1', 'tmp'),
    home: path.join(dir, 'work', '.celler', 'run-1', 'home'),
    cache: path.join(dir, 'work', '.celler', 'run-1', 'cache'),
    short: '/private/tmp/celler-run1',
  },
  temps: ['/private/var/folders/x/T', '/private/tmp'],
  home: path.join(dir, 'home'),
  agentHomes: [path.join(dir, 'agent-home')],
  tools: [path.join(dir, 'home', '.nvm', 'bin')],
  readable: [path.join(dir, 'repo', '.git')],
  hidden: ['HTTPS_PROXY'],
});
export const github = {
  name: 'github',
  transport: 'http',
  url: 'https://api.example.com/mcp/',
  headers: { Authorization: 'Bearer t0ken' },
};
export const inFolder = async (work) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'celler-harness-'));
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
/** What a stand-in was started with and sent, in order. */
export const sentTo = (log) =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
/** Claude Code as a host has it, its program the stand-in, with these variables for the stand-in. */
export const fakeClaude = (env = {}) => {
  const agent = claudeAgent({ claude: () => fakeClaudeProgram, words: claudeWords });
  return { ...agent, env: (h) => ({ ...agent.env(h), ...env }) };
};
/** Codex as a host has it, in the Codex home `home`, its program the stand-in, with these variables for the stand-in. */
export const fakeCodex = (home, env = {}) => {
  const agent = codexAgent({ codex: () => fakeCodexProgram, home, words: codexWords });
  return { ...agent, env: (h) => ({ ...agent.env(h), ...env }) };
};
/** The host's Codex home, beside the runs' folders and never in one: no run's folder is, holds or is in it. */
export const codexHome = mkdtempSync(path.join(os.tmpdir(), 'celler-codex-home-'));
after(() => rmSync(codexHome, { recursive: true, force: true }));

/**
 * A host's graph of one cell, `main`, run by `runtime`, with more of the platform's options and the host's adapters if
 * given: its platform, app and revision, and what each run ended with.
 */
export function oneCell(runtime, more = {}, adapters = new Map()) {
  const ended = [];
  const platform = harnessPlatform({
    runtime,
    allowed: () => true,
    server: 'tools',
    spec: (run) => ({ prompt: String(run.input), model: '', sessionId: '', resume: false, timeoutMs: 20_000 }),
    ended: (_run, result) => ended.push(result),
    ...more,
  });
  const app = createApp({ database: new DatabaseSync(':memory:'), platform, adapters });
  const revision = app.publish([{ kind: 'cell', id: 'main', title: 'Main', profile: 'any', exports: [] }]);
  return { platform, app, revision, ended };
}
