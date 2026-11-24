import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CreateTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentRuntime } from 'celler/harness';
import { harnessLimits } from '../dist/limits.js';
import { until } from './support.mjs';
import { desk, fakeClaude, host, inFolder, spec } from './support-harness.mjs';

test("a run's clock stands still while the person is asked, and a file in its scratch isn't one it changed", () =>
  inFolder(async (dir) => {
    // Asked for longer than the run may take: the time the person takes isn't the run's.
    const slowly = async () => (await delay(1_500), { option: 'allow' });
    const answered = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl') }), host).run(
      spec({ cwd: dir, timeoutMs: 1_000, ask: slowly }),
      () => undefined,
    ).done;
    assert.deepEqual([answered.ok, answered.text], [true, 'Hello. Ran them.'], answered.error);
    // A time far longer than a timer can wait in one go is still a time to wait: the run's clock is set in steps a timer
    // can take, never past them (Node would then wake it at once, and warn).
    const warned = [];
    const onWarning = (w) => warned.push(w.name);
    process.on('warning', onWarning);
    try {
      const long = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl') }), host).run(
        spec({ cwd: dir, timeoutMs: 2 ** 40, ask: async () => ({ option: 'allow' }) }),
        () => undefined,
      ).done;
      assert.equal(long.ok, true, long.error);
    } finally {
      process.off('warning', onWarning);
    }
    assert.deepEqual(
      warned.filter((name) => name === 'TimeoutOverflowWarning'),
      [],
    );
    // What it changes in its scratch goes with it; the rest is the run's, by its path in the folder.
    const files = [];
    const fake = fakeClaude();
    const writing = {
      ...fake,
      run: async (turn) => {
        turn.progress({ type: 'file', file: path.join(turn.places.scratch.tmp, 'cache.json') });
        turn.progress({ type: 'file', file: 'notes.md' });
        return { ok: true, text: '', usage: {}, costUsd: null, permissionDenials: [] };
      },
    };
    await new AgentRuntime(writing, host).run(spec({ cwd: dir }), (p) => p.type === 'file' && files.push(p.file)).done;
    assert.deepEqual(files, [path.join(dir, 'notes.md')]);
  }));

test("a run whose agent is gone while the person is asked ends there: its clock doesn't start again to stop it later", () =>
  inFolder(async (dir) => {
    const kill = process.kill;
    const grace = harnessLimits.exitGraceMs;
    const killed = [];
    process.kill = (pid, signal) => (killed.push({ pid, at: Date.now() }), kill.call(process, pid, signal));
    // The grace a stop gives before it insists, short for this test.
    harnessLimits.exitGraceMs = 50;
    try {
      const fake = fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl'), FAKE_CLAUDE_EXIT_WHILE_ASKING: '1' });
      // No one answers; the run's end takes the question back.
      const ask = (_q, signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
      const timeoutMs = 1_000;
      const handle = new AgentRuntime(fake, host).run(spec({ cwd: dir, timeoutMs, ask }), () => undefined);
      assert.equal((await handle.done).ok, false);
      const ended = Date.now();
      assert.ok(handle.pid);
      // Past its time and the grace a stop gives: what its end stopped (what its commands left running) it stopped at
      // once, and nothing stopped it later.
      await delay(timeoutMs + harnessLimits.exitGraceMs + 300);
      // oxlint-disable-next-line typescript/no-unsafe-unary-minus -- its agent started (handle.pid, asserted above): a number
      const late = killed.filter(({ pid, at }) => pid === -handle.pid && at > ended + harnessLimits.exitGraceMs + 200);
      assert.deepEqual(late, []);
    } finally {
      process.kill = kill;
      harnessLimits.exitGraceMs = grace;
    }
  }));

/** An adapter whose calls wait for the person in the inbox, and send what the person approved. */
const outbox = {
  prepare: async (_run, args) => ({
    account: 'office',
    destination: 'outbox',
    operation: 'send',
    content: { text: args.text },
    files: [],
  }),
  send: async (_run, write) => ({ content: [{ type: 'text', text: `sent: ${write.content.text}` }] }),
};
const textInput = { type: 'object', properties: { text: { type: 'string' } } };
/** A host's office: its desk sends through the outbox, or asks its clerk, who does. */
const office = [
  { kind: 'cell', id: 'desk', title: 'Desk', profile: 'desk', exports: ['send', 'ask_clerk'] },
  { kind: 'tool', id: 'send', target: { adapter: 'outbox' }, definition: { inputSchema: textInput } },
  { kind: 'tool', id: 'ask_clerk', target: { cell: 'clerk' }, definition: { inputSchema: textInput } },
  { kind: 'cell', id: 'clerk', title: 'Clerk', profile: 'clerk', exports: ['send'] },
];
/** The host's run of what it was started with, which may take `timeoutMs`. */
const within = (timeoutMs) => (run) => ({
  prompt: String(run.input),
  model: '',
  sessionId: '',
  resume: false,
  timeoutMs,
});
/** The call waiting for the person in the office's inbox, once one is. */
async function pendingIn(app) {
  await until(() => app.human.inbox('office').some((item) => item.state === 'pending'));
  return app.human.inbox('office').find((item) => item.state === 'pending');
}
/**
 * An agent that works in this process, as the runtime runs one: `work` calls the run's tools (with the MCP client's own
 * options for a call, such as its time limit), asks the person and spends time, each cut off once the run is stopped,
 * and its reply is what `work` gives back. Its connection to the run's server is `transport`.
 */
const working = (work) => ({
  ...fakeClaude(),
  run: async (turn) => {
    const [server] = turn.spec.mcpServers;
    const client = new Client({ name: 'agent', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers },
    });
    await client.connect(transport);
    const stopped = { signal: turn.signal };
    const call = async (name, options = {}) =>
      (await client.callTool({ name, arguments: { text: 'hi' } }, undefined, { ...stopped, ...options })).content[0]
        .text;
    const ask = async () =>
      (await turn.ask({ call: 't1', tool: 'Bash', title: 'Run the tests', options: [] }, turn.signal))?.option ?? null;
    const spend = (ms) => delay(ms, undefined, stopped);
    try {
      return {
        ok: true,
        text: await work({ call, ask, spend, transport, client }),
        usage: {},
        costUsd: null,
        permissionDenials: [],
      };
    } catch (err) {
      return { ok: false, text: '', usage: {}, costUsd: null, permissionDenials: [], error: err.message };
    } finally {
      await client.close();
    }
  },
});

test("a run's clock stands still while one of its calls waits for the person in the inbox: approved after longer than the run may take, it ends as its agent did", () =>
  inFolder(async (dir) => {
    const fake = fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl'), FAKE_CLAUDE_TOOL: 'send' });
    const { platform, app } = desk(
      () => new AgentRuntime(fake, host),
      { spec: within(1_000) },
      new Map([['outbox', outbox]]),
    );
    try {
      const started = app.start({
        owner: 'office',
        revision: app.publish(office),
        entry: 'desk',
        workspace: dir,
        input: 'Send it',
      });
      const { id } = await pendingIn(app);
      // The person takes longer than the whole run may.
      await delay(1_500);
      await app.human.approve('office', id);
      const result = await started;
      assert.equal(result.isError, false, result.structuredContent?.error);
      assert.match(result.content[0].text, /sent: hi$/);
    } finally {
      await platform.close();
    }
  }));

test("a run's clock goes on once the person has decided: a run that works on past the time it had left still times out then", () =>
  inFolder(async (dir) => {
    const heard = [];
    // Its call waits in the inbox for longer than the run may take; then it works on for longer than it had left.
    const agent = working(async ({ call, spend }) => {
      heard.push(await call('send'));
      await spend(600);
      return 'Done';
    });
    const { platform, app } = desk(
      () => new AgentRuntime(agent, host),
      { spec: within(300) },
      new Map([['outbox', outbox]]),
    );
    try {
      const started = app.start({
        owner: 'office',
        revision: app.publish(office),
        entry: 'desk',
        workspace: dir,
        input: 'Send it',
      });
      const { id } = await pendingIn(app);
      await delay(450);
      await app.human.approve('office', id);
      const result = await started;
      // It timed out, and only once its call had come back with what was sent.
      assert.deepEqual(
        [heard, result.isError, result.structuredContent.error],
        [['sent: hi'], true, 'Timed out after 0 s'],
      );
    } finally {
      await platform.close();
    }
  }));

test("an ask and a call in the inbox at the same time stop a run's clock once: it goes on when the last of them ends, and their time counts once", () =>
  inFolder(async (dir) => {
    const heard = [];
    // It asks before it runs a command while its call waits in the inbox, then works on for longer than it had left.
    const agent = working(async ({ call, ask, spend }) => {
      heard.push(...(await Promise.all([call('send'), ask()])));
      await spend(400);
      return 'Done';
    });
    // The ask is answered first, after twice the run's time; the call long after it, alone longer than the run may take.
    const answer = async () => (await delay(400), { option: 'allow' });
    const { platform, app } = desk(
      () => new AgentRuntime(agent, host),
      { spec: within(200), ask: answer },
      new Map([['outbox', outbox]]),
    );
    try {
      const started = app.start({
        owner: 'office',
        revision: app.publish(office),
        entry: 'desk',
        workspace: dir,
        input: 'Send it',
      });
      const { id } = await pendingIn(app);
      await delay(800);
      await app.human.approve('office', id);
      const result = await started;
      // Both came back, and then it had the time it had left as they began, not that and the ask's time again.
      assert.deepEqual(
        [heard, result.isError, result.structuredContent.error],
        [['sent: hi', 'allow'], true, 'Timed out after 0 s'],
      );
    } finally {
      await platform.close();
    }
  }));

test("a run waits for the person while a run it delegated does: its clock stands still while that run's call waits in the inbox, and while its agent asks", () =>
  inFolder(async (dir) => {
    // The desk asks its clerk, whose call waits in the inbox and who then asks the person, each longer than either run may take.
    const deskAgent = working(({ call }) => call('ask_clerk'));
    const clerk = working(async ({ call, ask }) => `${await call('send')}, ${await ask()}`);
    const answer = async () => (await delay(450), { option: 'allow' });
    const { platform, app, ended } = desk(
      (run) => new AgentRuntime(run.parent ? clerk : deskAgent, host),
      { spec: within(300), ask: answer },
      new Map([['outbox', outbox]]),
    );
    try {
      const started = app.start({
        owner: 'office',
        revision: app.publish(office),
        entry: 'desk',
        workspace: dir,
        input: 'Ask the clerk',
      });
      const { id } = await pendingIn(app);
      await delay(450);
      await app.human.approve('office', id);
      const result = await started;
      assert.deepEqual([result.isError, result.content[0].text], [false, 'sent: hi, allow']);
      assert.deepEqual(
        ended.map((r) => r.ok),
        [true, true],
      );
    } finally {
      await platform.close();
    }
  }));

test("a delegated run's ask stops its caller's clock only until the ask is taken back: once that run has ended, the caller's clock goes on, though the host never answers", () =>
  inFolder(async (dir) => {
    const heard = [];
    // The desk asks its clerk, then works on for longer than it has; the clerk asks the person, and ends before an answer.
    const deskAgent = working(async ({ call, spend }) => {
      heard.push(await call('ask_clerk'));
      await spend(600);
      return 'Done';
    });
    const clerk = working(async ({ ask, spend }) => {
      void ask();
      await spend(100);
      return 'Gone';
    });
    // A host that never answers, not even once the ask is taken back.
    const answer = () => new Promise(() => undefined);
    const { platform, app } = desk(
      (run) => new AgentRuntime(run.parent ? clerk : deskAgent, host),
      { spec: within(300), ask: answer },
      new Map([['outbox', outbox]]),
    );
    try {
      const result = await app.start({
        owner: 'office',
        revision: app.publish(office),
        entry: 'desk',
        workspace: dir,
        input: 'Ask the clerk',
      });
      assert.deepEqual(
        [heard, result.isError, result.structuredContent.error],
        [['Gone'], true, 'Timed out after 0 s'],
      );
    } finally {
      await platform.close();
    }
  }));

test("a call its agent withdraws while it waits in the inbox stays there for the person, and the run's clock goes on from then, as when the agent's own limit on a call ends it", () =>
  inFolder(async (dir) => {
    const heard = [];
    // Its own limit on the call, longer than the run may take, ends the call while it waits; then it works on for longer
    // than it had left.
    const agent = working(async ({ call, spend }) => {
      heard.push(await call('send', { timeout: 450 }).catch((err) => err.message));
      await spend(600);
      return 'Done';
    });
    const { platform, app } = desk(
      () => new AgentRuntime(agent, host),
      { spec: within(300) },
      new Map([['outbox', outbox]]),
    );
    try {
      const result = await app.start({
        owner: 'office',
        revision: app.publish(office),
        entry: 'desk',
        workspace: dir,
        input: 'Send it',
      });
      assert.deepEqual(
        [heard, result.isError, result.structuredContent.error],
        [['MCP error -32001: Request timed out'], true, 'Timed out after 0 s'],
      );
      // Left for the person, who may still decide it; the run's history has the call withdrawn.
      const [item] = app.human.inbox('office');
      assert.equal(item.state, 'pending');
      assert.deepEqual(
        app.history('office', item.run).map((e) => e.kind),
        ['started', 'call', 'cancelled', 'ended'],
      );
    } finally {
      await platform.close();
    }
  }));

test("a call whose agent goes before its answer is cut off as a withdrawn one is: its approval stays for the person, and the run's clock goes on", () =>
  inFolder(async (dir) => {
    const heard = [];
    let gone;
    const going = new Promise((resolve) => (gone = resolve));
    // Its connection goes while its call waits in the inbox, with nothing sent to withdraw the call; then it works on for
    // longer than it had left.
    const agent = working(async ({ call, spend, transport }) => {
      const calling = call('send').catch((err) => err.message);
      await going;
      await transport.close();
      heard.push(await calling);
      await spend(600);
      return 'Done';
    });
    const { platform, app } = desk(
      () => new AgentRuntime(agent, host),
      { spec: within(300) },
      new Map([['outbox', outbox]]),
    );
    try {
      const started = app.start({
        owner: 'office',
        revision: app.publish(office),
        entry: 'desk',
        workspace: dir,
        input: 'Send it',
      });
      const { run } = await pendingIn(app);
      gone();
      const result = await started;
      assert.deepEqual(
        [heard, result.isError, result.structuredContent.error],
        [['MCP error -32000: Connection closed'], true, 'Timed out after 0 s'],
      );
      assert.equal(app.human.inbox('office')[0].state, 'pending');
      assert.deepEqual(
        app.history('office', run).map((e) => e.kind),
        ['started', 'call', 'cancelled', 'ended'],
      );
    } finally {
      await platform.close();
    }
  }));

test("a call made as a task doesn't stop its run's clock while it waits in the inbox: its agent goes on meanwhile, and its time runs out", () =>
  inFolder(async (dir) => {
    const agent = working(async ({ client, spend }) => {
      await client.request(
        { method: 'tools/call', params: { name: 'send', arguments: { text: 'hi' }, task: {} } },
        CreateTaskResultSchema,
      );
      await spend(600);
      return 'Done';
    });
    const { platform, app } = desk(
      () => new AgentRuntime(agent, host),
      { spec: within(300) },
      new Map([['outbox', outbox]]),
    );
    try {
      const started = app.start({
        owner: 'office',
        revision: app.publish(office),
        entry: 'desk',
        workspace: dir,
        input: 'Send it',
      });
      await pendingIn(app);
      const result = await started;
      assert.deepEqual([result.isError, result.structuredContent.error], [true, 'Timed out after 0 s']);
    } finally {
      await platform.close();
    }
  }));

test('a run that withdraws its call to a run it delegated gets its clock back, though that run still waits in the inbox', () =>
  inFolder(async (dir) => {
    const heard = [];
    // The desk's own limit on its call to the clerk ends it, longer than the desk may take; then it works on for longer
    // than it had left. The clerk's call waits in the inbox all along.
    const deskAgent = working(async ({ call, spend }) => {
      heard.push(await call('ask_clerk', { timeout: 450 }).catch((err) => err.message));
      await spend(600);
      return 'Done';
    });
    const clerk = working(({ call }) => call('send'));
    const { platform, app } = desk(
      (run) => new AgentRuntime(run.parent ? clerk : deskAgent, host),
      { spec: within(300) },
      new Map([['outbox', outbox]]),
    );
    try {
      const result = await app.start({
        owner: 'office',
        revision: app.publish(office),
        entry: 'desk',
        workspace: dir,
        input: 'Ask the clerk',
      });
      assert.deepEqual(
        [heard, result.isError, result.structuredContent.error],
        [['MCP error -32001: Request timed out'], true, 'Timed out after 0 s'],
      );
    } finally {
      await platform.close();
    }
  }));
