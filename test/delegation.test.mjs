import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from 'celler';
import { cell, memoryDatabase, object, refused, request, text, tool, until, withClient } from './support.mjs';

test('a delegation retry joins its running child, the tree has a run cap, and ending a run stops the tree', async (t) => {
  const database = memoryDatabase(t);
  let launches = 0,
    rootId,
    childId,
    releaseChild;
  const childGate = new Promise((resolve) => {
    releaseChild = resolve;
  });
  const untilAborted = (signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const work = (client, task, timeout = 5000) =>
    client.callTool({ name: 'invoke', arguments: { name: 'work', arguments: { task } } }, undefined, { timeout });
  const platform = {
    allowed: () => true,
    launch: (spec, connect, signal) =>
      withClient(connect, async (client) => {
        if (spec.entry === 'worker') {
          launches++;
          childId = spec.id;
          if (spec.input.task === 'forever') await untilAborted(signal);
          await childGate;
          return text('work done');
        }
        rootId = spec.id;
        if (spec.input === 'end-me') {
          work(client, 'forever').catch(() => {});
          await untilAborted(signal);
        }
        // An ordinary client times out while the child works, then retries the same call: one child, one result.
        await assert.rejects(work(client, 'report', 50), /timed out/);
        const retry = work(client, 'report');
        // maxRuns = 2: the root and its running child fill this tree.
        await refused(work(client, 'other'), /active runs/);
        releaseChild();
        assert.deepEqual(await retry, text('work done'));
        assert.equal(launches, 1);
        return text('root done');
      }),
  };
  const app = createApp({ database, platform, adapters: new Map(), discoveryBytes: 0, maxRuns: 2 });
  const revision = app.publish([
    cell('root', ['work']),
    tool('work', { cell: 'worker' }, { inputSchema: object({ task: { type: 'string' } }) }),
    cell('worker', []),
  ]);
  assert.deepEqual(await app.start(request(revision)), text('root done'));

  childId = undefined;
  const ending = app.start({ ...request(revision), input: 'end-me' });
  await until(() => childId);
  assert.throws(() => app.end('bob', rootId), /Unknown run/);
  // A process that knows the tree only from the database, as after a restart, still ends all of it.
  const ended = (id) => app.history('alice', id).find((event) => event.kind === 'ended');
  createApp({ database, platform, adapters: new Map() }).end('alice', rootId);
  assert.deepEqual(ended(childId).detail, { status: 'cancelled', by: 'host' });
  // The process that runs the tree also stops its work.
  app.end('alice', rootId);
  await assert.rejects(ending);
  assert.deepEqual(ended(rootId).detail, { status: 'cancelled', by: 'host' });
});

test("a delegated run is checked up its chain at each call: the parent's way to it revoked, the child's next call is refused", async (t) => {
  const database = memoryDatabase(t);
  let revoked = false;
  const app = createApp({
    database,
    adapters: new Map([['ok', { call: async () => text('ok') }]]),
    platform: {
      // The root's delegation to the child, revoked while the child is at work.
      allowed: (run, id) => !(revoked && run.entry === 'root' && id === 'ask'),
      launch: (spec, connect) =>
        withClient(
          connect,
          async (client) => {
            if (spec.entry === 'root') return client.callTool({ name: 'ask', arguments: {} });
            assert.deepEqual(await client.callTool({ name: 'look', arguments: {} }), text('ok'));
            revoked = true;
            await refused(client.callTool({ name: 'look', arguments: {} }), /Delegation revoked/);
            return text('child done');
          },
          true,
        ),
    },
  });
  const revision = app.publish([
    cell('root', ['ask']),
    tool('ask', { cell: 'child' }),
    cell('child', ['look']),
    tool('look', { adapter: 'ok' }),
  ]);
  assert.deepEqual(await app.start(request(revision)), text('child done'));
});

test("a run's grants stop at a denied grouping cell, and a child gets nothing its caller was denied or lost before it delegated", async (t) => {
  const database = memoryDatabase(t);
  const called = [];
  let revoked = false;
  const app = createApp({
    database,
    discoveryBytes: 0,
    adapters: new Map([
      [
        'ok',
        {
          call: async (run) => {
            called.push(run.entry);
            return text('ok');
          },
        },
      ],
    ]),
    platform: {
      // The person turned off the whole group; later, "shared" for the root's own run alone.
      allowed: (run, id) => id !== 'grp' && !(revoked && id === 'shared' && run.parent === null),
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          const invoke = (name) => client.callTool({ name: 'invoke', arguments: { name } });
          if (spec.entry === 'root') {
            await refused(invoke('grouped'), /outside this run/);
            assert.deepEqual(await invoke('shared'), text('ok'));
            revoked = true;
            await refused(invoke('shared'), /outside this run/);
            return invoke('helper');
          }
          // The child exports both itself, and policy alone would let it use them.
          await refused(invoke('grouped'), /outside this run/);
          await refused(invoke('shared'), /outside this run/);
          return text('child done');
        }),
    },
  });
  const revision = app.publish([
    cell('root', ['grp', 'shared', 'helper']),
    { kind: 'cell', id: 'grp', title: 'Group', exports: ['grouped'] },
    tool('grouped', { adapter: 'ok' }),
    tool('shared', { adapter: 'ok' }),
    tool('helper', { cell: 'child' }),
    cell('child', ['grouped', 'shared']),
  ]);
  assert.deepEqual(await app.start(request(revision)), text('child done'));
  const grants = (entry) =>
    JSON.parse(database.prepare("SELECT grants FROM runs WHERE json_extract(body, '$.entry')=?").get(entry).grants);
  assert.deepEqual(grants('root'), ['root', 'shared', 'helper']);
  assert.deepEqual(grants('child'), ['child']);
  assert.deepEqual(called, ['root']);
});

test("a host reads a run's grants as its calls are checked, live: a denied node is absent, a child has nothing its caller lacks, and none once its way is revoked or its cell denied", async (t) => {
  // The person turned off a whole group and one tool; later, the root's way to its helper, then the child's own cell.
  const off = new Set(['grp', 'secret']);
  let rootId;
  const read = {};
  const app = createApp({
    database: memoryDatabase(t),
    adapters: new Map([['ok', { call: async () => text('ok') }]]),
    platform: {
      allowed: (_run, id) => !off.has(id),
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          if (spec.entry === 'root') {
            rootId = spec.id;
            read.root = app.grants('alice', spec.id);
            return client.callTool({ name: 'helper', arguments: {} });
          }
          read.child = app.grants('alice', spec.id);
          off.add('helper');
          read.revoked = [app.grants('alice', rootId), app.grants('alice', spec.id)];
          off.delete('helper');
          off.add('child');
          read.denied = [app.grants('alice', rootId), app.grants('alice', spec.id)];
          // Only its owner reads it, as any other read of a run.
          assert.throws(() => app.grants('bob', spec.id), /Unknown run/);
          return text('child done');
        }),
    },
  });
  const revision = app.publish([
    cell('root', ['grp', 'shared', 'secret', 'helper']),
    { kind: 'cell', id: 'grp', title: 'Group', exports: ['grouped'] },
    tool('grouped', { adapter: 'ok' }),
    tool('shared', { adapter: 'ok' }),
    tool('secret', { adapter: 'ok' }),
    tool('helper', { cell: 'child' }),
    cell('child', ['grouped', 'shared']),
  ]);
  assert.deepEqual(await app.start(request(revision)), text('child done'));
  assert.deepEqual(read, {
    root: ['root', 'shared', 'helper'],
    child: ['child', 'shared'],
    revoked: [['root', 'shared'], []],
    denied: [['root', 'shared', 'helper'], []],
  });
});

test("a delegation's call key reused with other arguments while its child runs is refused, not a second child", async (t) => {
  const children = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const app = createApp({
    database: memoryDatabase(t),
    adapters: new Map(),
    platform: {
      allowed: () => true,
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          if (spec.entry === 'worker') {
            children.push(spec.input.task);
            await gate;
            return text('did ' + spec.input.task);
          }
          const work = (task) =>
            client.callTool({ name: 'work', arguments: { task }, _meta: { 'celler/call-id': 'same-key' } });
          const first = work('one');
          await until(() => children.length === 1);
          setTimeout(() => release(), 100); // a second child, were there one, would finish too
          await refused(work('two'), /different arguments/);
          assert.deepEqual(await first, text('did one'));
          return text('root done');
        }),
    },
  });
  const revision = app.publish([
    cell('root', ['work']),
    tool('work', { cell: 'worker' }, { inputSchema: object({ task: { type: 'string' } }) }),
    cell('worker', []),
  ]);
  assert.deepEqual(await app.start(request(revision)), text('root done'));
  assert.deepEqual(children, ['one']);
});
