import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime } from '@matapao/celler/harness';
import { CODEX_HOME_CONFIG } from '../dist/harness/agents.js';
import { harnessLimits } from '../dist/limits.js';
import { claudeOnMacos } from '../dist/harness/sandbox/claude.macos.js';
import { until } from './support.mjs';
import {
  codexHome,
  oneCell,
  fakeClaude,
  fakeCodex,
  github,
  host,
  inFolder,
  placesIn,
  sentTo,
  spec,
} from './support-harness.mjs';

test("an ask carries Claude Code's reason as plain text up to its length, and none where it gives none", () =>
  inFolder(async (dir) => {
    const reasonOf = async (reason) => {
      let asked;
      const run = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_REASON: reason }), host).run(
        spec({ cwd: dir, ask: async (q) => ((asked = q), { option: 'allow' }) }),
        () => undefined,
      );
      assert.equal((await run.done).ok, true);
      return asked;
    };
    const long = await reasonOf(
      `\u202e\x1b]8;;https://example.com\x07Why\x1b]8;;\x07\r\n\t${'x'.repeat(2 * harnessLimits.reasonChars)}`,
    );
    assert.equal(long.reason, `Why\n\t${'x'.repeat(harnessLimits.reasonChars - 5)}`);
    for (const none of ['none', ' \x1b[0m\x07\u200b ']) {
      const asked = await reasonOf(none);
      assert.equal(asked.title, 'Run the tests');
      assert.equal('reason' in asked, false, JSON.stringify(asked));
    }
  }));

test('connector values reach Claude Code in its first request and Codex in variables of its own, never on a command line, and a program the agent would start is refused', () =>
  inFolder(async (dir) => {
    const log = path.join(dir, 'claude.jsonl');
    const claude = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host).run(
      spec({ cwd: dir, mcpServers: [github] }),
      () => undefined,
    ).done;
    assert.equal(claude.ok, true, claude.error);
    const sent = sentTo(log);
    assert.deepEqual(sent.find((e) => e.what === 'initialize').data.mcpServers, {
      github: { type: 'http', url: github.url, headers: github.headers, timeout: harnessLimits.mcpCallMs },
    });
    assert.equal(
      sent.find((e) => e.what === 'started').data.args.some((arg) => arg.includes('t0ken')),
      false,
    );
    const codexLog = path.join(dir, 'codex.jsonl');
    const codex = await new AgentRuntime(fakeCodex(codexHome, { FAKE_CODEX_LOG: codexLog }), host).run(
      spec({ cwd: dir, mcpServers: [github] }),
      () => undefined,
    ).done;
    assert.equal(codex.ok, true, codex.error);
    const exec = sentTo(codexLog)[0].data;
    assert.ok(
      exec.configs.includes(
        `mcp_servers={ github = { url = "${github.url}", env_http_headers = { Authorization = "CELLER_VALUE_0" }, default_tools_approval_mode = "approve", tool_timeout_sec = ${harnessLimits.mcpCallMs / 1000} } }`,
      ),
      exec.configs.join('\n'),
    );
    assert.deepEqual(exec.values, { CELLER_VALUE_0: 'Bearer t0ken' });
    assert.equal(
      exec.args.some((arg) => arg.includes('t0ken')),
      false,
    );
    // A connector's program is the host's to start.
    const stdio = await new AgentRuntime(fakeClaude(), host).run(
      spec({ cwd: dir, mcpServers: [{ ...github, transport: 'stdio' }] }),
      () => undefined,
    ).done;
    assert.match(stdio.error, /started by the host, never by the agent$/);
  }));

test("each of a run's MCP servers has a name of its own, which its agent names its tools by: a host's server named like the run's fails the run", () =>
  inFolder(async (dir) => {
    const log = path.join(dir, 'agent.jsonl');
    const named = (mcpServers) => () => ({
      prompt: 'x',
      model: '',
      sessionId: '',
      resume: false,
      timeoutMs: 20_000,
      mcpServers,
    });
    const { platform, app, revision, ended } = oneCell(
      () => new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host),
      { spec: named([{ ...github, name: 'tools' }]) },
    );
    try {
      const result = await app.start({ owner: 'alice', revision, entry: 'main', workspace: dir, input: 'x' });
      assert.deepEqual(
        [result.isError, ended.map((r) => r.error)],
        [true, ["Two of the run's MCP servers are named tools: each needs a name of its own"]],
      );
    } finally {
      await platform.close();
    }
    // Nor the same name twice among the host's, nor one an agent can't name its tools by.
    const runtime = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host);
    const twice = await runtime.run(spec({ cwd: dir, mcpServers: [github, github] }), () => undefined).done;
    assert.equal(twice.error, "Two of the run's MCP servers are named github: each needs a name of its own");
    for (const name of ['git hub', 'github.com', '']) {
      const odd = await runtime.run(spec({ cwd: dir, mcpServers: [{ ...github, name }] }), () => undefined).done;
      assert.equal(
        odd.error,
        `${JSON.stringify(name)} can't name one of the run's MCP servers: only letters, digits, "_" and "-" can`,
        name,
      );
    }
    // None of them started an agent.
    assert.equal(existsSync(log), false);
  }));

test("Codex runs in a profile of the run's own, its folder written at work and only read otherwise, in the host's Codex home, which trusts no folder", () =>
  inFolder(async (dir) => {
    const home = codexHome;
    const log = path.join(dir, 'codex.jsonl');
    const runtime = new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: log }), host);
    const started = async (over) => {
      const result = await runtime.run(
        spec({ cwd: dir, systemPrompt: 'Be brief.', prompt: 'Test it', ...over }),
        () => undefined,
      ).done;
      assert.equal(result.ok, true, result.error);
      return sentTo(log).at(-1).data;
    };
    const work = await started({});
    // Its own home, where its sign-in is kept in a file and no folder is trusted, so it loads no folder's own settings.
    assert.equal(work.home, home);
    assert.equal(readFileSync(path.join(home, 'config.toml'), 'utf8'), CODEX_HOME_CONFIG);
    // A tier as Codex's own model for it; the cells' texts ahead of the person's words, set apart.
    assert.deepEqual([work.model, work.cwd, work.mark], ['gpt-6-luna', dir, '1']);
    assert.equal(work.prompt, 'Be brief.\n\n---\n\nTest it');
    // Its settings file's for this system, each key a whole table, as Codex reads a table keyed by paths.
    assert.ok(work.configs.includes('default_permissions="run"'), work.configs.join('\n'));
    assert.match(
      work.configs.find((c) => c.startsWith('permissions=')),
      /":workspace_roots" = \{ "\." = "write"/,
    );
    assert.match(
      (await started({ purpose: 'read' })).configs.find((c) => c.startsWith('permissions=')),
      /":workspace_roots" = \{ "\." = "read"/,
    );
    // A model-only decision runs no command and gets no MCP server.
    const decided = await started({ purpose: 'inference', mcpServers: [github] });
    assert.match(
      decided.configs.find((c) => c.startsWith('features=')),
      /shell_tool = false/,
    );
    assert.equal(
      decided.configs.some((c) => c.startsWith('mcp_servers=')),
      false,
    );
    // A session continued is resumed.
    assert.equal((await started({ resume: true, sessionId: 'fake-thread' })).resume, 'fake-thread');
  }));

test("Codex gets its settings as TOML reads them: a control character in a place's name, U+007F too, escaped", () =>
  inFolder(async (dir) => {
    // Windows names no folder with one.
    if (process.platform === 'win32') return;
    const work = path.join(dir, 'work');
    const odd = path.join(dir, 'repo\x7f', '.git');
    mkdirSync(work);
    mkdirSync(odd, { recursive: true });
    const log = path.join(dir, 'codex.jsonl');
    const result = await new AgentRuntime(fakeCodex(codexHome, { FAKE_CODEX_LOG: log }), host).run(
      spec({ cwd: work, readable: [odd] }),
      () => undefined,
    ).done;
    assert.equal(result.ok, true, result.error);
    const permissions = sentTo(log)[0].data.configs.find((c) => c.startsWith('permissions='));
    assert.ok(
      permissions.includes(`${JSON.stringify(realpathSync.native(odd)).replace('\x7f', '\\u007f')} = "read"`),
      permissions,
    );
    assert.equal(permissions.includes('\x7f'), false);
  }));

test("Claude Code starts in its settings file for this system, with no settings files of a folder's own and only the host's connectors", () =>
  inFolder(async (dir) => {
    const log = path.join(dir, 'agent.jsonl');
    const runtime = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host);
    const settings = [];
    const result = await runtime.run(
      spec({ cwd: dir, mcpServers: [github], ask: async () => ({ option: 'allow' }) }),
      (p) => p.type === 'settings' && settings.push(p.settings),
    ).done;
    assert.equal(result.ok, true, result.error);
    // The person sees the model it runs on by its own name for it, and the mode it runs in.
    assert.deepEqual(settings.at(-1), [
      { id: 'model', name: 'Model', value: 'Haiku (fake)' },
      { id: 'mode', name: 'Mode', value: 'acceptEdits' },
    ]);
    const started = sentTo(log).find((e) => e.what === 'started').data;
    // No settings files of its own, only the host's connectors, the model of its tier, the mode of its file.
    for (const flag of ['--setting-sources=', '--strict-mcp-config', '--model=haiku', '--permission-mode=acceptEdits'])
      assert.ok(started.args.includes(flag), `${flag}: ${started.args.join(' ')}`);
    // Its sandbox, its own tools and its permissions are its file's for this system (checked above), with the run's places,
    // its folder by its real path, as its sandbox sees it.
    assert.equal(started.settings.sandbox.enabled, true);
    assert.deepEqual(started.settings.sandbox.filesystem.allowWrite, [realpathSync.native(dir)]);
    assert.ok(
      started.args.includes(`--tools=${claudeOnMacos(placesIn(dir), 'work').tools.join(',')}`),
      started.args.join(' '),
    );
    // The host's own servers gate their calls: Claude Code doesn't ask about them again.
    assert.deepEqual(started.settings.permissions.allow, ['Bash', 'mcp__github']);
    // The host by its name, as the Agent SDK has its requests say it.
    assert.equal(started.client, 'host/1.0.0');
    // Its own system prompt, which a cell with no context of its own doesn't take away: no prompt in its place.
    assert.equal(sentTo(log).find((e) => e.what === 'initialize').data.systemPrompt, undefined);
    // To read: nothing that writes, no commands either, and nothing written but its scratch.
    const read = await runtime.run(spec({ cwd: dir, purpose: 'read' }), () => undefined).done;
    assert.equal(read.ok, true, read.error);
    const reading = sentTo(log)
      .filter((e) => e.what === 'started')
      .at(-1).data;
    const tools = reading.args
      .find((arg) => arg.startsWith('--tools='))
      .slice('--tools='.length)
      .split(',');
    assert.deepEqual(
      ['Write', 'Edit', 'NotebookEdit', 'Bash', 'TaskStop'].filter((tool) => tools.includes(tool)),
      [],
    );
    assert.equal(reading.settings.sandbox.filesystem.allowWrite.includes(realpathSync.native(dir)), false);
    // A model-only decision: no tools at all, so no sandbox, and no MCP server.
    const decided = await runtime.run(spec({ cwd: dir, purpose: 'inference', mcpServers: [github] }), () => undefined)
      .done;
    assert.equal(decided.ok, true, decided.error);
    const none = sentTo(log)
      .filter((e) => e.what === 'started')
      .at(-1).data;
    assert.ok(none.args.includes('--tools='), none.args.join(' '));
    assert.equal(none.settings.sandbox, undefined);
    assert.equal(
      sentTo(log)
        .filter((e) => e.what === 'initialize')
        .at(-1).data.mcpServers,
      undefined,
    );
  }));

test('an agent knows the host by its name and mark, asks the person before it acts, and ends with its reply and what it spent', () =>
  inFolder(async (dir) => {
    const log = path.join(dir, 'agent.jsonl');
    const asked = [],
      progress = [];
    const result = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host).run(
      spec({
        cwd: dir,
        prompt: 'Test it',
        systemPrompt: 'Be brief.',
        ask: async (q) => (asked.push([q.title, q.reason, q.options.map((o) => o.kind)]), { option: 'allow' }),
      }),
      (p) => progress.push(p),
    ).done;
    assert.equal(result.ok, true, result.error);
    assert.equal(result.text, 'Hello. Ran them.');
    // Its heading and its reason as Claude Code gave them, the reason's terminal escapes gone.
    assert.deepEqual(asked, [['Run the tests', 'npm test is not on the allowlist.', ['allow_once', 'reject_once']]]);
    // Its session, its call, and what it writes as it streams it.
    assert.ok(
      progress.some((p) => p.type === 'session' && p.sessionId === 'fake-session'),
      JSON.stringify(progress),
    );
    assert.ok(
      progress.some((p) => p.type === 'tool' && p.summary === 'Bash: npm test' && p.call === 't1'),
      JSON.stringify(progress),
    );
    // A search, by what it looks for rather than where.
    assert.ok(
      progress.some((p) => p.type === 'tool' && p.summary === 'Grep "TODO"'),
      JSON.stringify(progress),
    );
    assert.deepEqual(
      progress
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .slice(-2),
      ['Ran th', 'Ran them.'],
    );
    assert.deepEqual(
      [result.costUsd, result.model, result.usage],
      [0.01, 'claude-haiku-fake', { input: 10, output: 20, cacheRead: 5, cacheWrite5m: 0, cacheWrite1h: 7 }],
    );
    const sent = sentTo(log);
    assert.deepEqual([sent[0].data.mark, sent[0].data.client], ['1', 'host/1.0.0']);
    assert.equal(sent.find((e) => e.what === 'initialize').data.appendSystemPrompt, 'Be brief.');
    assert.equal(sent.find((e) => e.what === 'prompt').data.text, 'Test it');
  }));

test("Codex's run says what it ran, edited and replied, with its usage and model, and the files it changed", () =>
  inFolder(async (dir) => {
    const progress = [];
    const result = await new AgentRuntime(
      fakeCodex(codexHome, { FAKE_CODEX_LOG: path.join(dir, 'codex.jsonl') }),
      host,
    ).run(spec({ cwd: dir }), (p) => progress.push(p)).done;
    assert.equal(result.ok, true, result.error);
    assert.deepEqual([result.text, result.model, result.costUsd], ['Ran them.', 'gpt-6-luna', null]);
    // Its input without what it read from its cache, which is counted on its own: 10 tokens in all.
    assert.deepEqual(result.usage, { input: 6, output: 20, cacheRead: 4, cacheWrite5m: 2, cacheWrite1h: 0 });
    // A command as it was given, not as its shell ran it.
    assert.deepEqual(
      progress.filter((p) => p.type === 'tool').map((p) => [p.tool, p.summary]),
      [
        ['execute', 'execute: npm test'],
        ['edit', `edit ${path.join(dir, 'notes.md')}`],
      ],
    );
    assert.deepEqual(
      progress.filter((p) => p.type === 'file').map((p) => p.file),
      [path.join(dir, 'notes.md')],
    );
    assert.deepEqual(
      progress.find((p) => p.type === 'session'),
      { type: 'session', sessionId: 'fake-thread' },
    );
  }));

test('a Codex that ends before it reads a prompt longer than a pipe holds ends a failed run, and the host stays up', () =>
  inFolder(async (dir) => {
    const uncaught = [];
    const onUncaught = (err) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      const fake = fakeCodex(codexHome, {
        FAKE_CODEX_LOG: path.join(dir, 'codex.jsonl'),
        FAKE_CODEX_EXIT_AT_ONCE: '1',
      });
      const result = await new AgentRuntime(fake, host).run(
        spec({ cwd: dir, prompt: 'x'.repeat(1024 * 1024) }),
        () => undefined,
      ).done;
      assert.equal(result.ok, false);
      assert.match(result.error, /a setting it refuses/);
      // What its pipe said as it closed has been heard by now.
      await delay(200);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    assert.deepEqual(
      uncaught.map((err) => err.message),
      [],
    );
  }));

test("a question of the agent's own reaches the person as a form with its choices, and the one picked goes back to it", () =>
  inFolder(async (dir) => {
    const asked = [];
    const run = (answer) =>
      new AgentRuntime(
        fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl'), FAKE_CLAUDE_QUESTION: '1' }),
        host,
      ).run(spec({ cwd: dir, ask: async (q) => (asked.push(q.form), answer) }), () => undefined).done;
    assert.equal((await run({ accept: true, content: { 'Which one?': 'B' } })).text, 'Hello. Picked B.');
    assert.deepEqual(asked[0].fields, [
      {
        name: 'Which one?',
        title: 'Pick',
        type: 'string',
        required: true,
        choices: [
          { value: 'A', label: 'A' },
          { value: 'B', label: 'B' },
        ],
      },
    ]);
    assert.equal((await run({ accept: false })).text, 'Hello. No pick.');
  }));

test('a run cancelled asks its agent to end its turn, which keeps its session, and ends cancelled', () =>
  inFolder(async (dir) => {
    const log = path.join(dir, 'agent.jsonl');
    const handle = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SLOW: '10000' }), host).run(
      spec({ cwd: dir, ask: async () => ({ option: 'allow' }) }),
      () => undefined,
    );
    await until(() => existsSync(log) && sentTo(log).some((e) => e.what === 'prompt'));
    handle.cancel();
    const result = await handle.done;
    assert.deepEqual([result.ok, result.cancelled, result.error], [false, true, 'Cancelled']);
    assert.ok(sentTo(log).some((e) => e.what === 'interrupt'));
  }));

test("what a run's commands leave running ends with the run", () =>
  inFolder(async (dir) => {
    // Windows keeps no process group to end.
    if (process.platform === 'win32') return;
    const left = path.join(dir, 'left.pid');
    const fake = fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl'), FAKE_CLAUDE_LEAVE_RUNNING: left });
    const result = await new AgentRuntime(fake, host).run(
      spec({ cwd: dir, ask: async () => ({ option: 'allow' }) }),
      () => undefined,
    ).done;
    assert.equal(result.ok, true, result.error);
    const pid = Number(readFileSync(left, 'utf8'));
    const running = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await until(() => !running(), 2_000);
  }));

test('an agent that ends cleanly is stopped once, and never sent SIGKILL: a group that is gone gets nothing more', () =>
  inFolder(async (dir) => {
    // Windows keeps no process group to end.
    if (process.platform === 'win32') return;
    const kill = process.kill;
    const grace = harnessLimits.exitGraceMs;
    const sent = [];
    process.kill = (pid, signal) => (sent.push([pid, signal]), kill.call(process, pid, signal));
    // The grace a stop gives before it insists, short for this test.
    harnessLimits.exitGraceMs = 50;
    try {
      const handle = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl') }), host).run(
        spec({ cwd: dir, ask: async () => ({ option: 'allow' }) }),
        () => undefined,
      );
      const result = await handle.done;
      assert.equal(result.ok, true, result.error);
      await delay(harnessLimits.exitGraceMs * 6);
      // oxlint-disable-next-line typescript/no-unsafe-unary-minus -- its agent ran (its result is ok), so handle.pid is a number
      const group = -handle.pid;
      assert.deepEqual(
        sent.filter(([pid]) => pid === group),
        [[group, 'SIGTERM']],
      );
    } finally {
      process.kill = kill;
      harnessLimits.exitGraceMs = grace;
    }
  }));
