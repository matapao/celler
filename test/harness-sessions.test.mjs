import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { AgentRuntime, codexAgent } from 'celler/harness';
import { codexWords, fakeClaude, fakeCodex, host, inFolder, sentTo } from './support-harness.mjs';

// All an agent keeps of a session removed once its work is done, in agents' homes of the test's own, never the
// person's: Claude Code's config folder (CLAUDE_CONFIG_DIR, else .claude in HOME) and the host's Codex home
// (CODEX_HOME), where a stand-in for Codex deletes a thread as Codex's own deletion does.

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

/**
 * What Claude Code keeps of a session, wherever its own code names it by the session's id: its transcript and beside it
 * in its working folder's sessions' folder (`project`), and in its config folder. One named as the id is a folder.
 */
const claudeKeeps = (config, project, id) => [
  path.join(project, `${id}.jsonl`),
  path.join(project, id),
  path.join(project, `${id}.orphaned-1795558510057-0a1b2c3d.jsonl`),
  path.join(project, `${id}.precompact.json`),
  path.join(config, 'file-history', id),
  path.join(config, 'session-env', id),
  path.join(config, 'tasks', id),
  path.join(config, 'uploads', id),
  path.join(config, 'image-cache', id),
  path.join(config, 'debug', `${id}.txt`),
  path.join(config, 'usage-data', 'session-meta', `${id}.json`),
  path.join(config, 'usage-data', 'facets', `${id}.json`),
  path.join(config, 'startup-perf', `${id}.txt`),
  path.join(config, 'startup-perf', `${id}.json`),
  path.join(config, 'dump-prompts', `${id}.jsonl`),
  path.join(config, 'telemetry', `1p_failed_events.${id}.${randomUUID()}.json`),
  path.join(config, 'todos', `${id}-agent-${id}.json`),
];

/** Each of a session's, a folder with a file in it where it is named as the session, else a file. */
function putEach(places, id) {
  for (const place of places) {
    if (path.basename(place) === id) put(path.join(place, 'subagents', 'agent-a1.jsonl'));
    else put(place, place.endsWith(`${id}.jsonl`) ? firstLine(id) : '{}\n');
  }
}

test("all Claude Code keeps of a session goes, its transcript and everything else it names by the session's id, even once its folder is gone; the next session's, and what sessions share, stay", () =>
  inFolder(async (tmp) => {
    const dir = realpathSync(tmp);
    const config = path.join(dir, 'claude-config');
    const runtime = new AgentRuntime(fakeClaude({ CLAUDE_CONFIG_DIR: config }), host);
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      // A folder with a short path, and one whose path is long, with a letter that is two in NFD.
      for (const names of [['work'], ['Café notes', 'x'.repeat(200)]]) {
        const cwd = path.join(dir, ...names);
        mkdirSync(cwd, { recursive: true });
        const project = path.join(config, 'projects', projectName(realpathSync(cwd)));
        const [first, next] = [randomUUID(), randomUUID()];
        const own = claudeKeeps(config, project, first);
        const nexts = claudeKeeps(config, project, next);
        putEach(own, first);
        putEach(nexts, next);
        // What sessions share: the folder's memory, the shell's snapshots, the prompt history, its settings, a link to
        // the latest debug log.
        const history = `${JSON.stringify({ display: 'hi', sessionId: first, project: cwd })}\n`;
        const shared = [
          path.join(project, 'memory', 'MEMORY.md'),
          path.join(config, 'shell-snapshots', 'snapshot-zsh-1795558510057-0a1b2c.sh'),
          path.join(config, 'history.jsonl'),
          path.join(config, '.claude.json'),
          path.join(config, 'usage-data', 'report.html'),
        ];
        for (const file of shared) put(file, history);
        const latest = path.join(config, 'debug', 'latest');
        rmSync(latest, { force: true });
        symlinkSync(path.join(config, 'debug', `${first}.txt`), latest);
        // Where the Agent SDK looks for the session too.
        assert.equal((await getSessionInfo(first, { dir: cwd }))?.sessionId, first);
        // The host removes the session's folder first, as its work is done.
        rmSync(path.join(dir, names[0]), { recursive: true });
        assert.deepEqual(new Set(await runtime.removeSession({ cwd, sessionId: first })), new Set(own));
        assert.deepEqual(own.filter(existsSync), []);
        for (const file of nexts) assert.ok(existsSync(file), file);
        for (const file of shared) assert.equal(readFileSync(file, 'utf8'), history, file);
        assert.ok(lstatSync(latest).isSymbolicLink());
        assert.deepEqual(await runtime.removeSession({ cwd, sessionId: first }), []);
      }
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    // Without CLAUDE_CONFIG_DIR, in .claude in the run's HOME.
    const home = path.join(dir, 'home');
    const cwd = path.join(dir, 'other');
    const sessionId = randomUUID();
    const transcript = path.join(home, '.claude', 'projects', projectName(cwd), `${sessionId}.jsonl`);
    const envs = path.join(home, '.claude', 'session-env', sessionId);
    put(transcript);
    mkdirSync(envs, { recursive: true });
    const inHome = new AgentRuntime(fakeClaude({ CLAUDE_CONFIG_DIR: '', HOME: home }), host);
    assert.deepEqual(new Set(await inHome.removeSession({ cwd, sessionId })), new Set([transcript, envs]));
  }));

/** A Codex home with three threads: two of the same day, one compressed, and one archived; each with its name. */
function codexHome(home) {
  const [one, other, archived] = [randomUUID(), randomUUID(), randomUUID()];
  const day = path.join(home, 'sessions', '2026', '11', '24');
  const rollouts = {
    one: path.join(day, `rollout-2026-11-24T09-15-02-${one}.jsonl`),
    other: path.join(day, `rollout-2026-11-24T10-40-51-${other}.jsonl.zst`),
    archived: path.join(home, 'archived_sessions', `rollout-2026-10-02T08-00-00-${archived}.jsonl.zst`),
  };
  for (const file of Object.values(rollouts)) put(file);
  const named = (id) => `${JSON.stringify({ id, thread_name: 'a', updated_at: '2026-11-24T09:15:02Z' })}\n`;
  put(path.join(home, 'session_index.jsonl'), [one, other, archived].map(named).join(''));
  // Its prompt history, which Codex's own terminal keeps, and its settings: shared, and kept byte for byte.
  put(path.join(home, 'history.jsonl'), `${JSON.stringify({ session_id: one, ts: 1, text: 'hi' })}\n`);
  put(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
  return { one, other, archived, rollouts, named };
}

test("Codex deletes a thread itself, as asked in its home with the thread's id: its rollout, compressed or not, archived or not, and its name; then its shell's snapshots and its pictures go; another thread's all stay", () =>
  inFolder(async (tmp) => {
    const dir = realpathSync(tmp);
    const home = path.join(dir, 'codex-home');
    const log = path.join(dir, 'codex.jsonl');
    const runtime = new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: log }), host);
    const cwd = path.join(dir, 'work');
    const { one, other, archived, rollouts, named } = codexHome(home);
    const snapshots = path.join(home, 'shell_snapshots');
    const pictures = path.join(home, 'generated_images');
    const own = [
      path.join(snapshots, `${one}.1795558510057123456.sh`),
      path.join(snapshots, `${one}.tmp-1795558510057654321`),
      path.join(pictures, one, 'ig_1.png'),
    ];
    const others = [path.join(snapshots, `${other}.1795558510057123456.sh`), path.join(pictures, other, 'ig_2.png')];
    for (const file of [...own, ...others]) put(file);
    const before = {
      history: readFileSync(path.join(home, 'history.jsonl')),
      config: readFileSync(path.join(home, 'config.toml')),
    };
    const removed = await runtime.removeSession({ cwd, sessionId: one });
    assert.deepEqual(new Set(removed), new Set([rollouts.one, own[0], own[1], path.join(pictures, one)]));
    assert.deepEqual(sentTo(log), [{ what: 'delete', data: { args: ['delete', '--force', one], home } }]);
    assert.deepEqual([rollouts.one, ...own].filter(existsSync), []);
    for (const file of [rollouts.other, rollouts.archived, ...others]) assert.ok(existsSync(file), file);
    assert.equal(readFileSync(path.join(home, 'session_index.jsonl'), 'utf8'), named(other) + named(archived));
    assert.deepEqual(readFileSync(path.join(home, 'history.jsonl')), before.history);
    assert.deepEqual(readFileSync(path.join(home, 'config.toml')), before.config);
    assert.deepEqual(
      new Set(await runtime.removeSession({ cwd, sessionId: other })),
      new Set([rollouts.other, others[0], path.join(pictures, other)]),
    );
    assert.deepEqual(await runtime.removeSession({ cwd, sessionId: archived }), [rollouts.archived]);
    assert.equal(readFileSync(path.join(home, 'session_index.jsonl'), 'utf8'), '');
  }));

test("Codex refusing to delete a thread it has removes nothing of it, and says why; one it doesn't have is one of which only what Codex leaves goes", () =>
  inFolder(async (tmp) => {
    const dir = realpathSync(tmp);
    const home = path.join(dir, 'codex-home');
    const cwd = path.join(dir, 'work');
    const { one, rollouts } = codexHome(home);
    const snapshot = path.join(home, 'shell_snapshots', `${one}.1795558510057123456.sh`);
    put(snapshot);
    const refusing = new AgentRuntime(fakeCodex(home, { FAKE_CODEX_DELETE_REFUSED: '1' }), host);
    await assert.rejects(
      refusing.removeSession({ cwd, sessionId: one }),
      new RegExp(`^Error: Codex could not delete its session ${one}: Error: failed to delete session$`),
    );
    // Nor without its own program, which alone deletes it.
    const missing = new AgentRuntime(codexAgent({ codex: () => null, home, words: codexWords }), host);
    await assert.rejects(missing.removeSession({ cwd, sessionId: one }), /Codex wasn't found on this computer/);
    assert.ok(existsSync(rollouts.one));
    assert.ok(existsSync(snapshot));
    // A thread Codex has nothing of but the snapshot its shell left: Codex refuses it, and the snapshot goes.
    const gone = randomUUID();
    const left = path.join(home, 'shell_snapshots', `${gone}.1795558510057123456.sh`);
    put(left);
    const log = path.join(dir, 'codex.jsonl');
    const runtime = new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: log }), host);
    assert.deepEqual(await runtime.removeSession({ cwd, sessionId: gone }), [left]);
    assert.deepEqual(sentTo(log), [{ what: 'delete', data: { args: ['delete', '--force', gone], home } }]);
    assert.ok(existsSync(rollouts.one));
  }));

test('a link where something of a session, or a folder on the way to it, would be is not followed: it stays, and what it leads to', () =>
  inFolder(async (tmp) => {
    const dir = realpathSync(tmp);
    const outside = path.join(dir, 'outside');
    const config = path.join(dir, 'claude-config');
    const claude = new AgentRuntime(fakeClaude({ CLAUDE_CONFIG_DIR: config }), host);
    const sessionId = randomUUID();
    // Links named as the session's transcript and its folders, in its working folder's sessions' folder and beside it.
    const cwd = path.join(dir, 'work');
    const project = path.join(config, 'projects', projectName(cwd));
    put(path.join(outside, 'notes.txt'));
    put(path.join(outside, 'folder', 'kept.txt'));
    const links = [path.join(project, `${sessionId}.jsonl`), path.join(project, sessionId)];
    links.push(path.join(config, 'session-env', sessionId));
    mkdirSync(project, { recursive: true });
    mkdirSync(path.join(config, 'session-env'), { recursive: true });
    symlinkSync(path.join(outside, 'notes.txt'), links[0]);
    symlinkSync(path.join(outside, 'folder'), links[1]);
    symlinkSync(path.join(outside, 'folder'), links[2]);
    // A folder that is a link, with the session's in what it leads to.
    put(path.join(outside, 'history', sessionId, 'a@v1'));
    symlinkSync(path.join(outside, 'history'), path.join(config, 'file-history'));
    assert.deepEqual(await claude.removeSession({ cwd, sessionId }), []);
    for (const link of links) assert.ok(lstatSync(link).isSymbolicLink(), link);
    assert.ok(existsSync(path.join(outside, 'notes.txt')));
    assert.ok(existsSync(path.join(outside, 'folder', 'kept.txt')));
    assert.ok(existsSync(path.join(outside, 'history', sessionId, 'a@v1')));
    // A working folder's sessions' folder that is a link: what it leads to, named as the session's, stays.
    const linked = path.join(dir, 'linked');
    put(path.join(outside, 'project', `${sessionId}.jsonl`));
    symlinkSync(path.join(outside, 'project'), path.join(config, 'projects', projectName(linked)));
    assert.deepEqual(await claude.removeSession({ cwd: linked, sessionId }), []);
    assert.ok(existsSync(path.join(outside, 'project', `${sessionId}.jsonl`)));
    // A year of Codex's sessions that is a link, and links named as its shell's snapshot and its pictures.
    const home = path.join(dir, 'codex-home');
    const rollout = path.join(outside, 'year', '11', '24', `rollout-2026-11-24T09-15-02-${sessionId}.jsonl`);
    put(rollout);
    mkdirSync(path.join(home, 'sessions'), { recursive: true });
    symlinkSync(path.join(outside, 'year'), path.join(home, 'sessions', '2026'));
    const codexLinks = [
      path.join(home, 'shell_snapshots', `${sessionId}.1795558510057123456.sh`),
      path.join(home, 'generated_images', sessionId),
    ];
    for (const link of codexLinks) mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(outside, 'notes.txt'), codexLinks[0]);
    symlinkSync(path.join(outside, 'folder'), codexLinks[1]);
    assert.deepEqual(await new AgentRuntime(fakeCodex(home), host).removeSession({ cwd, sessionId }), []);
    assert.ok(existsSync(rollout));
    for (const link of codexLinks) assert.ok(lstatSync(link).isSymbolicLink(), link);
    assert.ok(existsSync(path.join(outside, 'folder', 'kept.txt')));
  }));

test("a session with nothing kept, or an agent with no home yet, gives nothing; an id that isn't a session's is refused", () =>
  inFolder(async (tmp) => {
    const dir = realpathSync(tmp);
    const cwd = path.join(dir, 'work');
    const sessionId = randomUUID();
    const config = path.join(dir, 'claude-config');
    const log = path.join(dir, 'codex.jsonl');
    const claude = new AgentRuntime(fakeClaude({ CLAUDE_CONFIG_DIR: config }), host);
    const codex = new AgentRuntime(fakeCodex(path.join(dir, 'codex-home'), { FAKE_CODEX_LOG: log }), host);
    for (const runtime of [claude, codex]) assert.deepEqual(await runtime.removeSession({ cwd, sessionId }), []);
    // No home: Codex isn't asked, as it would make one.
    assert.equal(existsSync(log), false);
    assert.equal(existsSync(path.join(dir, 'codex-home')), false);
    const another = path.join(config, 'projects', projectName(cwd), `${randomUUID()}.jsonl`);
    put(another);
    assert.deepEqual(await claude.removeSession({ cwd, sessionId }), []);
    assert.ok(existsSync(another));
    // A home with none of the thread's: Codex refuses it, and there is nothing to remove.
    mkdirSync(path.join(dir, 'codex-home'));
    assert.deepEqual(await codex.removeSession({ cwd, sessionId }), []);
    assert.equal(sentTo(log).length, 1);
    for (const id of ['', '..', `${sessionId}/..`, `../${sessionId}`, '*'])
      for (const runtime of [claude, codex])
        await assert.rejects(runtime.removeSession({ cwd, sessionId: id }), /isn't the id of one of .*'s sessions/);
    assert.ok(existsSync(another));
    assert.equal(sentTo(log).length, 1);
  }));
