import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '@matapao/celler';
import {
  AgentRuntime,
  claudeAgent,
  codexAgent,
  emptyUsage,
  failure,
  harnessPlatform,
  SimulatedRuntime,
} from '@matapao/celler/harness';
import {
  claudeWords,
  codexHome,
  codexWords,
  desk,
  fakeClaude,
  fakeClaudeProgram,
  host,
  inFolder,
} from './support-harness.mjs';

// The host's hooks: what an agent asks reaches it, each is called on the object it was given on, it hears an agent's
// process start and a run that failed, and one that throws leaves no agent working; and what a runtime of its own makes
// its results with.

test("what an agent asks before it acts reaches the host with the run it asks in, and with no one to ask it doesn't go ahead", () =>
  inFolder(async (dir) => {
    const asked = [];
    const reply = async (ask) => {
      const { platform, app, revision } = desk(
        () => new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl') }), host),
        ask ? { ask } : {},
      );
      try {
        const result = await app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'Test it' });
        assert.equal(result.isError, false, JSON.stringify(result));
        return result.content[0].text;
      } finally {
        await platform.close();
      }
    };
    // The host answers it, for the run it came from.
    assert.match(
      await reply(async (run, q) => (asked.push([run.entry, q.title, q.tool]), { option: 'allow' })),
      /Ran them\.$/,
    );
    assert.deepEqual(asked, [['desk', 'Run the tests', 'Bash']]);
    // A host that asks no one: what the agent asks about doesn't happen.
    assert.match(await reply(undefined), /Didn't run them\.$/);
  }));

test("each of a host's hooks is called on the object the host gave it on, so a host made of methods that read this works", () =>
  inFolder(async (dir) => {
    // What each hook was called on.
    const calledOn = new Map();
    // The host's own objects, each hook a method that reads this: what marks its runs, how it finds each agent (Codex's
    // finds none here, and a health check asks it all the same), and its hooks for the harness.
    const marker = {
      client: { name: 'host', version: '1.0.0' },
      mark(env) {
        calledOn.set('mark', this);
        return { ...env, HOST_RUN: '1' };
      },
    };
    const claudeFinder = {
      words: claudeWords,
      program: fakeClaudeProgram,
      claude() {
        calledOn.set('claude', this);
        return this.program;
      },
    };
    const codexFinder = {
      words: codexWords,
      home: codexHome,
      codex() {
        calledOn.set('codex', this);
        return null;
      },
    };
    const office = {
      server: 'office',
      answer: { option: 'allow' },
      runtime() {
        calledOn.set('runtime', this);
        return new AgentRuntime(claudeAgent(claudeFinder), marker);
      },
      allowed() {
        calledOn.set('allowed', this);
        return true;
      },
      spec(run) {
        calledOn.set('spec', this);
        return { prompt: String(run.input), model: '', sessionId: '', resume: false, timeoutMs: 20_000 };
      },
      started() {
        calledOn.set('started', this);
      },
      progress() {
        calledOn.set('progress', this);
      },
      async ask() {
        calledOn.set('ask', this);
        return this.answer;
      },
      ended() {
        calledOn.set('ended', this);
      },
    };
    const platform = harnessPlatform(office);
    const app = createApp({ database: new DatabaseSync(':memory:'), platform, adapters: new Map() });
    const revision = app.publish([{ kind: 'cell', id: 'desk', title: 'Desk', profile: 'any', exports: [] }]);
    try {
      const result = await app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'Test it' });
      // The host's answer, which its ask read from it, reached the agent.
      assert.match(result.content[0].text, /Ran them\.$/);
      await new AgentRuntime(codexAgent(codexFinder), marker).health(false);
    } finally {
      await platform.close();
    }
    const givenOn = {
      runtime: office,
      allowed: office,
      spec: office,
      started: office,
      progress: office,
      ask: office,
      ended: office,
      mark: marker,
      claude: claudeFinder,
      codex: codexFinder,
    };
    for (const [hook, object] of Object.entries(givenOn))
      assert.equal(calledOn.get(hook), object, `${hook} wasn't called on the object it was given on`);
  }));

test("an agent that can't start ends as a failed run, which the host hears", () =>
  inFolder(async (dir) => {
    const { platform, app, revision, ended } = desk(() => ({
      kind: 'broken',
      health: async () => ({ ok: false, checkedAt: 0, detail: '' }),
      run: () => {
        throw new Error('could not start');
      },
    }));
    try {
      const result = await app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'Go' });
      assert.deepEqual([result.isError, result.content[0].text], [true, 'could not start']);
      assert.deepEqual(
        ended.map((r) => [r.ok, r.error]),
        [[false, 'could not start']],
      );
    } finally {
      await platform.close();
    }
  }));

test("a host whose hook throws as the agent starts doesn't leave the agent working", () =>
  inFolder(async (dir) => {
    let handle;
    const simulated = new SimulatedRuntime();
    const runtime = {
      kind: 'simulated',
      health: () => simulated.health(),
      run: (s, p) => (handle = simulated.run(s, p)),
    };
    const { platform, app, revision } = desk(() => runtime, {
      started: () => {
        throw new Error('The window is gone');
      },
    });
    try {
      await assert.rejects(
        app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'Go' }),
        /The window is gone/,
      );
      assert.equal((await handle.done).cancelled, true);
    } finally {
      await platform.close();
    }
  }));

test(
  "the host hears an agent's process as it starts, on the first run of a program whose version isn't known yet too",
  { skip: process.platform === 'win32' },
  () =>
    inFolder(async (dir) => {
      // A program at a path of its own, which no run has asked its version yet.
      const program = path.join(dir, 'claude');
      writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${fakeClaudeProgram}" "$@"\n`, { mode: 0o755 });
      const pids = [];
      const agent = {
        ...claudeAgent({ claude: () => program, words: claudeWords }),
        env: (h) => ({
          ...claudeAgent({ claude: () => program, words: claudeWords }).env(h),
          FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl'),
        }),
      };
      const { platform, app, revision } = desk(() => new AgentRuntime(agent, host), {
        started: (_run, pid) => pids.push(pid),
        ask: async () => ({ option: 'allow' }),
      });
      try {
        const result = await app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'Go' });
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.equal(pids.length, 1);
        assert.equal(typeof pids[0], 'number');
      } finally {
        await platform.close();
      }
    }),
);

test("a host's own runtime makes its results as celler's do: a usage of nothing, and a failed run from what went wrong", () => {
  assert.deepEqual(emptyUsage(), { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  // Each one its own: one a runtime adds to is no other's.
  const used = emptyUsage();
  used.input += 10;
  assert.equal(emptyUsage().input, 0);
  assert.deepEqual(failure('The agent stopped'), {
    ok: false,
    text: '',
    usage: emptyUsage(),
    costUsd: null,
    error: 'The agent stopped',
    runtimeDown: false,
    permissionDenials: [],
  });
  // One that takes its runtime offline until it is fixed.
  assert.equal(failure('Not signed in', true).runtimeDown, true);
});
