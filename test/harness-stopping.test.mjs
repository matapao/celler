import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime, harnessPlatform, SimulatedRuntime } from 'celler/harness';
import { desk, fakeClaude, host, inFolder, sentTo } from './support-harness.mjs';

// Runs stopped, and the platform closed: a run cancelled before its agent starts, or stopped through celler, and the
// platform closing on runs still going, on its MCP server as it opens, and settling once what its runs left is gone.

test('cancellation while the host prepares a run prevents the agent from starting', () =>
  inFolder(async (dir) => {
    const controller = new AbortController();
    let started = false;
    const runtime = () => ({
      run: () => {
        started = true;
        throw new Error('cancelled run started');
      },
    });
    const preparing = () => {
      controller.abort();
      return { prompt: 'x', model: '', sessionId: '', resume: false, timeoutMs: 20_000 };
    };
    const { platform, app, revision } = desk(runtime, { spec: preparing });
    try {
      await assert.rejects(
        app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'x' }, controller.signal),
        { name: 'AbortError' },
      );
      assert.equal(started, false);
    } finally {
      await platform.close();
    }
  }));

test('closing the platform stops the agents still going: their runs end failed, not cancelled, with what they ended with', () =>
  inFolder(async (dir) => {
    let id;
    // Closed once its agent is going.
    const d = desk(() => new SimulatedRuntime(), {
      started: (run) => {
        id = run.id;
        void d.platform.close();
      },
    });
    const result = await d.app.start({
      owner: 'office',
      revision: d.revision,
      entry: 'desk',
      workspace: dir,
      input: 'Wait',
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.cancelled, true);
    assert.deepEqual(
      d.ended.map((r) => r.cancelled),
      [true],
    );
    assert.equal(d.app.history('office', id).find((e) => e.kind === 'ended')?.detail.status, 'failed');
  }));

test('a platform closed while its MCP server opens starts no agent, and once closed it starts none again, nor opens its server', () =>
  inFolder(async (dir) => {
    const started = [];
    const runtime = {
      kind: 'fake',
      health: async () => ({ ok: true, checkedAt: 0, detail: '' }),
      run: (s) => (
        started.push(s),
        {
          done: Promise.resolve({ ok: true, text: 'Done', usage: {}, costUsd: 0, permissionDenials: [] }),
          cancel: () => undefined,
        }
      ),
    };
    // Each server it opens, counted.
    let opened = 0;
    http.Server.prototype.listen = function (...args) {
      opened++;
      return net.Server.prototype.listen.apply(this, args);
    };
    const platform = harnessPlatform({
      runtime: () => runtime,
      allowed: () => true,
      server: 'office',
      spec: () => ({ prompt: 'x', model: '', sessionId: '', resume: false, timeoutMs: 20_000 }),
    });
    const run = { id: 'r1', owner: 'office', workspace: dir, context: [], profile: 'any', input: 'x' };
    try {
      // Closed while its server opens, before the run's agent starts.
      const launching = platform.launch(run, async () => undefined, new AbortController().signal);
      await platform.close();
      await assert.rejects(
        Promise.race([launching, delay(2_000).then(() => 'still waiting')]),
        /The harness platform has closed/,
      );
      // And after: at once, with no server opened again.
      await assert.rejects(
        platform.launch(run, async () => undefined, new AbortController().signal),
        /The harness platform has closed/,
      );
      assert.deepEqual([started.length, opened], [0, 1]);
    } finally {
      delete http.Server.prototype.listen;
      await platform.close();
    }
  }));

test('a run stopped through celler keeps no result there, and the host still hears what its agent ended with', () =>
  inFolder(async (dir) => {
    const stop = new AbortController();
    // Stopped once its agent is going.
    const { platform, app, revision, ended } = desk(() => new SimulatedRuntime(), { started: () => stop.abort() });
    try {
      await assert.rejects(
        app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'Wait' }, stop.signal),
      );
      assert.deepEqual(
        ended.map((r) => r.cancelled),
        [true],
      );
    } finally {
      await platform.close();
    }
  }));

test('closing the platform settles once what its runs left is gone: their scratch and short folders', () =>
  inFolder(async (dir) => {
    const log = path.join(dir, 'agent.jsonl');
    // A run whose agent waits for the person, who never answers, when the platform closes.
    let asked;
    const asking = new Promise((resolve) => (asked = resolve));
    const { platform, app, revision } = desk(() => new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host), {
      ask: () => (asked(), new Promise(() => undefined)),
    });
    const started = app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'Go' });
    await asking;
    const { allowRead } = sentTo(log).find((e) => e.what === 'started').data.settings.sandbox.filesystem;
    const short = allowRead[1];
    assert.deepEqual([existsSync(path.join(dir, '.celler')), existsSync(short)], [true, true]);
    await platform.close();
    assert.deepEqual([existsSync(path.join(dir, '.celler')), existsSync(short)], [false, false]);
    assert.equal((await started).isError, true);
  }));
