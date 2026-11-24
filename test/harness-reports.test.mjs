import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentRuntime, checkProgram, tierModel } from '@matapao/celler/harness';
import { harnessLimits } from '../dist/limits.js';
import {
  claudeWords,
  codexHome,
  fakeClaude,
  fakeClaudeProgram,
  fakeCodex,
  host,
  inFolder,
  sentTo,
  spec,
} from './support-harness.mjs';

// What a run reports and how it ends: its cost, the forms and helpers on its way, what it was refused, the files and
// effort it was given, and an agent that won't end, or can't start, ending it anyway.

const allow = async () => ({ option: 'allow' });

test("a run's cost is its own: a new session's, never a resumed one's, whose total holds its earlier turns, and none on a subscription", () =>
  inFolder(async (dir) => {
    const run = (env, over = {}) =>
      new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl'), ...env }), host).run(
        spec({ cwd: dir, ask: allow, ...over }),
        () => undefined,
      ).done;
    const fresh = await run({});
    assert.deepEqual([fresh.ok, fresh.costUsd], [true, 0.01], fresh.error);
    const resumed = await run({}, { resume: true, sessionId: 'fake-session' });
    assert.deepEqual([resumed.ok, resumed.costUsd], [true, null], resumed.error);
    // Its usage is the turn's own either way.
    assert.deepEqual(resumed.usage, fresh.usage);
    const subscribed = await run({ FAKE_CLAUDE_SUBSCRIPTION: '1' });
    assert.deepEqual([subscribed.ok, subscribed.costUsd], [true, null], subscribed.error);
    // A sign-in that no longer works takes the runtime offline on a resumed session too, which cost something before.
    const expired = await run({ FAKE_CLAUDE_EXPIRED: '1' }, { resume: true, sessionId: 'fake-session' });
    assert.deepEqual([expired.ok, expired.runtimeDown, expired.error], [false, true, claudeWords.login]);
  }));

test("a form one of the agent's MCP servers asks for reaches the person with its fields and choices, and what they fill in goes back", () =>
  inFolder(async (dir) => {
    const asked = [];
    const run = (answer) =>
      new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl'), FAKE_CLAUDE_FORM: '1' }), host).run(
        spec({ cwd: dir, ask: async (q) => (asked.push(q), answer) }),
        () => undefined,
      ).done;
    const filled = await run({ accept: true, content: { name: 'Ada', size: 'm' } });
    assert.equal(filled.text, 'Hello. Form: accept {"name":"Ada","size":"m"}.');
    assert.deepEqual([asked[0].call, asked[0].title, asked[0].options], ['e1', 'Who are you?', []]);
    assert.deepEqual(asked[0].form, {
      message: 'Who are you?',
      fields: [
        { name: 'name', title: 'Your name', type: 'string', required: true },
        {
          name: 'size',
          title: 'size',
          type: 'string',
          required: false,
          choices: [
            { value: 's', label: 'Small' },
            { value: 'm', label: 'Medium' },
          ],
        },
      ],
    });
    assert.equal((await run({ accept: false })).text, 'Hello. Form: decline {}.');
    // No one there to ask: the form is called off.
    assert.equal((await run(null)).text, 'Hello. Form: cancel {}.');
  }));

test('a helper the agent starts is reported with what it is to do, its own calls under it, and its end; a file refused outside the folder is a write refused', () =>
  inFolder(async (dir) => {
    const outside = path.join(path.dirname(dir), 'elsewhere.md');
    const progress = [];
    const result = await new AgentRuntime(
      fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl'), FAKE_CLAUDE_HELPER: outside }),
      host,
    ).run(spec({ cwd: dir, ask: allow }), (p) => progress.push(p)).done;
    assert.equal(result.ok, true, result.error);
    const tools = progress.filter((p) => p.type === 'tool');
    assert.deepEqual(
      tools.find((p) => p.call === 'h1'),
      { type: 'tool', tool: 'Agent', summary: 'Agent', call: 'h1', helper: 'Look around' },
    );
    assert.deepEqual(
      tools.find((p) => p.call === 'h2'),
      { type: 'tool', tool: 'Grep', summary: 'Grep "FIXME"', call: 'h2', parent: 'h1' },
    );
    assert.deepEqual(
      progress.filter((p) => p.type === 'helper-done'),
      [{ type: 'helper-done', call: 'h1', ok: true }],
    );
    assert.deepEqual(result.refusedWrites, [outside]);
    // A file it was refused isn't one it changed.
    assert.deepEqual(
      progress.filter((p) => p.type === 'file'),
      [],
    );
  }));

test("the files given with a task reach the agent as links, pictures as pictures for Codex, and the effort asked for as the agent's own", () =>
  inFolder(async (dir) => {
    const picture = path.join(dir, 'shot.png');
    const notes = path.join(dir, 'notes.txt');
    const attachments = [
      { path: picture, name: 'shot.png', type: 'image/png' },
      { path: notes, name: 'notes.txt', type: 'text/plain' },
    ];
    const links = `[shot.png](${pathToFileURL(picture).href})\n[notes.txt](${pathToFileURL(notes).href})`;
    const claudeLog = path.join(dir, 'claude.jsonl');
    const claude = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: claudeLog }), host).run(
      spec({ cwd: dir, prompt: 'Look', attachments, effort: 'high', ask: allow }),
      () => undefined,
    ).done;
    assert.equal(claude.ok, true, claude.error);
    assert.equal(sentTo(claudeLog).find((e) => e.what === 'prompt').data.text, `Look\n\n${links}`);
    const args = sentTo(claudeLog).find((e) => e.what === 'started').data.args;
    assert.ok(args.includes('--effort=high'), args.join(' '));
    const codexLog = path.join(dir, 'codex.jsonl');
    const settings = [];
    const codex = await new AgentRuntime(fakeCodex(codexHome, { FAKE_CODEX_LOG: codexLog }), host).run(
      spec({ cwd: dir, prompt: 'Look', attachments, effort: 'high' }),
      (p) => p.type === 'settings' && settings.push(p.settings),
    ).done;
    assert.equal(codex.ok, true, codex.error);
    const exec = sentTo(codexLog)[0].data;
    assert.equal(exec.prompt, `Look\n\n${links}`);
    assert.deepEqual(
      exec.args.flatMap((arg, i) => (arg === '--image' ? [exec.args[i + 1]] : [])),
      [picture],
    );
    assert.ok(exec.configs.includes('model_reasoning_effort="high"'), exec.configs.join('\n'));
    assert.deepEqual(settings.at(-1), [
      { id: 'model', name: 'Model', value: 'gpt-6-luna' },
      { id: 'effort', name: 'Reasoning effort', value: 'high' },
    ]);
    // An effort the agent doesn't offer isn't passed on.
    const none = await new AgentRuntime(fakeCodex(codexHome, { FAKE_CODEX_LOG: codexLog }), host).run(
      spec({ cwd: dir, effort: 'extreme' }),
      () => undefined,
    ).done;
    assert.equal(none.ok, true, none.error);
    assert.equal(
      sentTo(codexLog)
        .at(-1)
        .data.configs.some((c) => c.startsWith('model_reasoning_effort')),
      false,
    );
  }));

test('a Codex that takes no notice of being stopped still ends its run, a grace after its time', () =>
  inFolder(async (dir) => {
    const pidFile = path.join(dir, 'codex.pid');
    const fake = fakeCodex(codexHome, {
      FAKE_CODEX_LOG: path.join(dir, 'codex.jsonl'),
      FAKE_CODEX_IGNORE_STOP: pidFile,
    });
    const started = Date.now();
    try {
      const result = await new AgentRuntime(fake, host).run(spec({ cwd: dir, timeoutMs: 500 }), () => undefined).done;
      assert.deepEqual([result.ok, result.error], [false, 'Timed out after 1 s']);
      assert.ok(Date.now() - started < 500 + harnessLimits.exitGraceMs + 2_000, `${Date.now() - started} ms`);
    } finally {
      // Its SDK keeps its process to itself: the test ends what it left.
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
  }));

test(
  "an agent that can't start, with no file descriptor left for its pipes, fails its run, and the host stays up",
  { skip: process.platform === 'win32' },
  () =>
    inFolder(async (dir) => {
      // In a process of its own, with few file descriptors: its agent's version known first, then all but two in use.
      const script = path.join(dir, 'starved.mjs');
      writeFileSync(
        script,
        `
    import { closeSync, openSync, writeFileSync } from "node:fs"
    import { AgentRuntime } from ${JSON.stringify(pathToFileURL(path.resolve('dist/harness/index.js')).href)}
    import { fakeClaude, host, spec } from ${JSON.stringify(pathToFileURL(path.resolve('test/support-harness.mjs')).href)}
    const uncaught = []
    process.on("uncaughtException", err => uncaught.push(err.message))
    const runtime = new AgentRuntime(fakeClaude(), host)
    await runtime.health(false)
    const held = []
    try { for (;;) held.push(openSync("/dev/null", "r")) } catch {}
    for (const fd of held.splice(-2)) closeSync(fd)
    const result = await runtime.run(spec({ cwd: ${JSON.stringify(dir)} }), () => undefined).done
    for (const fd of held) closeSync(fd)
    await new Promise(resolve => setTimeout(resolve, 100))
    writeFileSync(${JSON.stringify(path.join(dir, 'said.json'))}, JSON.stringify({ ok: result.ok, uncaught }))
  `,
      );
      const ran = spawnSync('/bin/sh', ['-c', `ulimit -n 96 && exec "${process.execPath}" "${script}"`], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(ran.status, 0, ran.stderr);
      assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'said.json'), 'utf8')), { ok: false, uncaught: [] });
    }),
);

test("a program shown to the host is checked by what its version says, and each tier is a model of the agent's own", () =>
  inFolder(async (dir) => {
    assert.deepEqual(await checkProgram('claude', fakeClaudeProgram), {
      path: fakeClaudeProgram,
      version: '2.1.330 (Claude Code)',
    });
    assert.match((await checkProgram('claude', 'relative/claude')).error, /^That isn't a program/);
    assert.match((await checkProgram('claude', dir)).error, /^That isn't a program/);
    // A program, but not Claude Code: what it says of its version gives it away.
    const other = path.join(dir, 'other');
    writeFileSync(other, '#!/bin/sh\necho "1.0.0 (something else)"\n', { mode: 0o755 });
    if (process.platform !== 'win32')
      assert.match((await checkProgram('claude', other)).error, /^That isn't Claude Code/);
    assert.deepEqual(
      [tierModel('claude', 'fast'), tierModel('claude', 'strong'), tierModel('codex', 'balanced')],
      ['haiku', 'opus', 'gpt-6.1-sol'],
    );
  }));

test("an agent's sign-in takes a code pasted back from its page, and health and sign-in answer, never throw, whatever goes wrong", async () => {
  const login = new AgentRuntime(fakeClaude(), host).login();
  assert.equal('error' in login, false);
  assert.equal(await login.url, 'https://claude.ai/oauth/authorize');
  login.sendCode('  the-code \n');
  assert.deepEqual(await login.done, { ok: true });
  // An agent whose program can't even be looked for.
  const broken = {
    ...fakeClaude(),
    find: () => {
      throw new Error('disk gone');
    },
  };
  const health = await new AgentRuntime(broken, host).health(true);
  assert.deepEqual([health.ok, health.detail], [false, 'Claude Code could not be checked: disk gone']);
  assert.deepEqual(new AgentRuntime(broken, host).login(), {
    error: "Claude Code's sign-in could not start: disk gone",
  });
});
