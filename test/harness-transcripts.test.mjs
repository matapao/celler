import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AgentRuntime } from '@matapao/celler/harness';
import { fakeClaude, fakeCodex, host, inFolder } from './support-harness.mjs';

// A session's transcript removed once its work is done, in agents' homes of the test's own, never the person's: Claude
// Code's config folder (CLAUDE_CONFIG_DIR, else .claude in HOME) and the host's Codex home (CODEX_HOME).

/**
 * The installed Claude Agent SDK, which looks for a session's transcript where Claude Code keeps it: loaded by where it
 * is, as its types would change the tests' own when they are checked.
 */
const { getSessionInfo } = await import(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));

/** Claude Code's name for a working folder's sessions' folder, as its own code makes it: the Agent SDK looks there. */
function projectName(cwd) {
  const real = process.platform === 'darwin' ? cwd.normalize('NFC') : cwd;
  const name = real.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < real.length; i++) hash = ((hash << 5) - hash + real.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** A file, with its folders made. */
function put(file, text = '{}\n') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A transcript's first line as Claude Code writes it, but of another folder: the SDK finds it only by its folder. */
const firstLine = (sessionId) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'Hi' },
    sessionId,
    cwd: '/elsewhere',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }) + '\n';

test("Claude Code's transcript of a session in a folder goes, with what it keeps beside it for that session, even once the folder is gone; the next session's there stays", () =>
  inFolder(async (tmp) => {
    const dir = realpathSync(tmp);
    const config = path.join(dir, 'claude-config');
    const runtime = new AgentRuntime(fakeClaude({ CLAUDE_CONFIG_DIR: config }), host);
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      // A folder with a short path, and one whose path is long, with a letter that is two in NFD.
      for (const names of [['work'], ['Cafe\u0301 notes', 'x'.repeat(200)]]) {
        const cwd = path.join(dir, ...names);
        mkdirSync(cwd, { recursive: true });
        const project = path.join(config, 'projects', projectName(realpathSync(cwd)));
        const [first, next] = [randomUUID(), randomUUID()];
        const own = [
          path.join(project, `${first}.jsonl`),
          path.join(project, first),
          path.join(project, `${first}.orphaned-1795558510057-0a1b2c3d.jsonl`),
        ];
        put(own[0], firstLine(first));
        put(path.join(own[1], 'subagents', 'agent-a1.jsonl'));
        put(own[2]);
        put(path.join(project, `${next}.jsonl`), firstLine(next));
        put(path.join(project, next, 'tool-results', 'r1.txt'));
        put(path.join(project, 'memory', 'MEMORY.md'));
        // Where the Agent SDK looks for the session too.
        assert.equal((await getSessionInfo(first, { dir: cwd }))?.sessionId, first);
        // The host removes the session's folder first, as its work is done.
        rmSync(path.join(dir, names[0]), { recursive: true });
        assert.deepEqual(new Set(await runtime.removeTranscript({ cwd, sessionId: first })), new Set(own));
        assert.deepEqual(own.filter(existsSync), []);
        const kept = [`${next}.jsonl`, path.join(next, 'tool-results', 'r1.txt'), path.join('memory', 'MEMORY.md')];
        for (const file of kept) assert.ok(existsSync(path.join(project, file)), file);
        assert.deepEqual(await runtime.removeTranscript({ cwd, sessionId: first }), []);
      }
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    // Without CLAUDE_CONFIG_DIR, in .claude in the run's HOME.
    const home = path.join(dir, 'home');
    const cwd = path.join(dir, 'other');
    const sessionId = randomUUID();
    const transcript = path.join(home, '.claude', 'projects', projectName(cwd), `${sessionId}.jsonl`);
    put(transcript);
    const inHome = new AgentRuntime(fakeClaude({ CLAUDE_CONFIG_DIR: '', HOME: home }), host);
    assert.deepEqual(await inHome.removeTranscript({ cwd, sessionId }), [transcript]);
  }));

test("Codex's rollout of a thread goes, compressed or not, archived or not; another thread's of the same day stays", () =>
  inFolder(async (tmp) => {
    const dir = realpathSync(tmp);
    const home = path.join(dir, 'codex-home');
    const runtime = new AgentRuntime(fakeCodex(home), host);
    const cwd = path.join(dir, 'work');
    const [one, other, archived] = [randomUUID(), randomUUID(), randomUUID()];
    const day = path.join(home, 'sessions', '2026', '11', '24');
    const rollout = path.join(day, `rollout-2026-11-24T09-15-02-${one}.jsonl`);
    const compressed = path.join(day, `rollout-2026-11-24T10-40-51-${other}.jsonl.zst`);
    const old = path.join(home, 'archived_sessions', `rollout-2026-10-02T08-00-00-${archived}.jsonl.zst`);
    for (const file of [rollout, compressed, old, path.join(home, 'session_index.jsonl')]) put(file);
    assert.deepEqual(await runtime.removeTranscript({ cwd, sessionId: one }), [rollout]);
    assert.equal(existsSync(rollout), false);
    assert.equal(existsSync(compressed), true);
    assert.deepEqual(await runtime.removeTranscript({ cwd, sessionId: other }), [compressed]);
    assert.deepEqual(await runtime.removeTranscript({ cwd, sessionId: archived }), [old]);
    assert.ok(existsSync(path.join(home, 'session_index.jsonl')));
  }));

test('a link where a transcript, or a folder on the way to one, would be is not followed: it stays, and what it leads to', () =>
  inFolder(async (tmp) => {
    const dir = realpathSync(tmp);
    const outside = path.join(dir, 'outside');
    const config = path.join(dir, 'claude-config');
    const claude = new AgentRuntime(fakeClaude({ CLAUDE_CONFIG_DIR: config }), host);
    const sessionId = randomUUID();
    // Links named as the session's transcript and its folder, in its working folder's sessions' folder.
    const cwd = path.join(dir, 'work');
    const project = path.join(config, 'projects', projectName(cwd));
    put(path.join(outside, 'notes.txt'));
    put(path.join(outside, 'folder', 'kept.txt'));
    mkdirSync(project, { recursive: true });
    symlinkSync(path.join(outside, 'notes.txt'), path.join(project, `${sessionId}.jsonl`));
    symlinkSync(path.join(outside, 'folder'), path.join(project, sessionId));
    assert.deepEqual(await claude.removeTranscript({ cwd, sessionId }), []);
    assert.ok(lstatSync(path.join(project, `${sessionId}.jsonl`)).isSymbolicLink());
    assert.ok(lstatSync(path.join(project, sessionId)).isSymbolicLink());
    assert.ok(existsSync(path.join(outside, 'notes.txt')));
    assert.ok(existsSync(path.join(outside, 'folder', 'kept.txt')));
    // A working folder's sessions' folder that is a link: what it leads to, named as the session's, stays.
    const linked = path.join(dir, 'linked');
    put(path.join(outside, 'project', `${sessionId}.jsonl`));
    symlinkSync(path.join(outside, 'project'), path.join(config, 'projects', projectName(linked)));
    assert.deepEqual(await claude.removeTranscript({ cwd: linked, sessionId }), []);
    assert.ok(existsSync(path.join(outside, 'project', `${sessionId}.jsonl`)));
    // A year of Codex's sessions that is a link.
    const home = path.join(dir, 'codex-home');
    const rollout = path.join(outside, 'year', '11', '24', `rollout-2026-11-24T09-15-02-${sessionId}.jsonl`);
    put(rollout);
    mkdirSync(path.join(home, 'sessions'), { recursive: true });
    symlinkSync(path.join(outside, 'year'), path.join(home, 'sessions', '2026'));
    assert.deepEqual(await new AgentRuntime(fakeCodex(home), host).removeTranscript({ cwd, sessionId }), []);
    assert.ok(existsSync(rollout));
  }));

test("a session with no transcript, or an agent with no home yet, gives nothing; an id that isn't a session's is refused", () =>
  inFolder(async (tmp) => {
    const dir = realpathSync(tmp);
    const cwd = path.join(dir, 'work');
    const sessionId = randomUUID();
    const config = path.join(dir, 'claude-config');
    const claude = new AgentRuntime(fakeClaude({ CLAUDE_CONFIG_DIR: config }), host);
    const codex = new AgentRuntime(fakeCodex(path.join(dir, 'codex-home')), host);
    for (const runtime of [claude, codex]) assert.deepEqual(await runtime.removeTranscript({ cwd, sessionId }), []);
    const another = path.join(config, 'projects', projectName(cwd), `${randomUUID()}.jsonl`);
    put(another);
    assert.deepEqual(await claude.removeTranscript({ cwd, sessionId }), []);
    assert.ok(existsSync(another));
    for (const id of ['', '..', `${sessionId}/..`, `../${sessionId}`, '*'])
      await assert.rejects(
        claude.removeTranscript({ cwd, sessionId: id }),
        /isn't the id of one of Claude Code's sessions/,
      );
    assert.ok(existsSync(another));
  }));
