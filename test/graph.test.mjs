import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '@matapao/celler';
import { cell, discover, memoryDatabase, object, refused, request, text, tool, withClient } from './support.mjs';

test('publication validates every edge including delegation targets', (t) => {
  const database = memoryDatabase(t);
  const app = createApp({ database, adapters: new Map([['ok', { call: async () => text('ok') }]]), platform: {} });
  assert.throws(() => app.publish([cell('a', ['missing'])]), /Unknown node/);
  assert.throws(() => app.publish([cell('a', ['b']), cell('b', ['a'])]), /Cycle/);
  assert.throws(() => app.publish([cell('a', ['go']), tool('go', { cell: 'a' })]), /Cycle/);
  assert.throws(() => app.publish([cell('a', [], { pins: ['bogus'] })]), /Invalid pin/);
  assert.throws(
    () => app.publish([cell('a', ['t'], { pins: ['t', 't'] }), tool('t', { adapter: 'ok' })]),
    /Duplicate pin/,
  );
  assert.throws(() => app.publish([tool('t', { adapter: 'absent' })]), /Unknown adapter/);
  // A schema it can't compile is refused by the tool's ID, so a host can leave that one out.
  const unresolved = { inputSchema: { type: 'object', properties: { x: { $ref: '#/nowhere' } } } };
  assert.throws(
    () => app.publish([cell('a', ['t']), tool('t', { adapter: 'ok' }, unresolved)]),
    /Invalid JSON Schema in t:/,
  );
  assert.throws(() => app.publish([cell('discover', [])]), /Reserved node ID/);
  assert.ok(app.publish([cell('a', ['t']), tool('t', { adapter: 'ok' }, { execution: { taskSupport: 'required' } })]));
  // A cell without a profile can be exported but not delegated to.
  const group = { kind: 'cell', id: 'grp', title: 'Group', exports: ['t'] };
  assert.ok(app.publish([cell('a', ['grp']), group, tool('t', { adapter: 'ok' })]));
  assert.throws(
    () => app.publish([cell('a', ['go']), tool('go', { cell: 'grp' }), group, tool('t', { adapter: 'ok' })]),
    /launch profile/,
  );
  // Optional undefined fields are accepted; non-JSON values are rejected.
  assert.ok(app.publish([cell('a', [], { description: undefined })]));
  assert.throws(() => app.publish([cell('a', [], { title: NaN })]), /valid JSON/);
});

test("a publish error about one node carries its id, so a host needn't read the message; one about the whole graph, none", (t) => {
  const app = createApp({
    database: memoryDatabase(t),
    adapters: new Map([['ok', { call: async () => text('ok') }]]),
    platform: {},
  });
  const unresolved = { inputSchema: { type: 'object', properties: { x: { $ref: '#/nowhere' } } } };
  const group = { kind: 'cell', id: 'grp', title: 'Group', exports: [] };
  const answers = { type: 'object', properties: { a: { type: 'string' } } };
  const failing = [
    ['t', [cell('a', ['t']), tool('t', { adapter: 'ok' }, unresolved)]],
    ['t', [cell('a', ['t']), tool('t', { adapter: 'ok' }, { outputSchema: unresolved.inputSchema })]],
    ['t', [tool('t', { adapter: 'absent' })]],
    ['go', [cell('a', ['go']), tool('go', { cell: 'b' }, { outputSchema: answers }), cell('b', [])]],
    ['grp', [cell('a', ['go']), tool('go', { cell: 'grp' }), group]],
    ['t', [cell('a', ['go']), tool('go', { cell: 't' }), tool('t', { adapter: 'ok' })]],
    ['missing', [cell('a', ['missing'])]],
    ['a', [cell('a', ['t', 't']), tool('t', { adapter: 'ok' })]],
    ['a', [cell('a', ['t'], { pins: ['t', 't'] }), tool('t', { adapter: 'ok' })]],
    ['b', [cell('a', [], { pins: ['b'] }), cell('b', [])]],
    ['discover', [cell('discover', [])]],
    [undefined, [cell('a', ['b']), cell('b', ['a'])]],
    [undefined, [cell('a', []), cell('a', [])]],
  ];
  for (const [node, graph] of failing)
    assert.throws(
      () => app.publish(graph),
      { name: 'CellerError', code: 'INVALID_CONFIG', node },
      JSON.stringify(graph),
    );
});

test("adapters are the host's own map, read live: one added after createApp serves what is published after", async (t) => {
  const database = memoryDatabase(t);
  const adapters = new Map();
  const platform = {
    allowed: () => true,
    launch: (_spec, connect) => withClient(connect, (client) => client.callTool({ name: 'late', arguments: {} })),
  };
  const app = createApp({ database, adapters, platform });
  const graph = [cell('main', ['late']), tool('late', { adapter: 'later' })];
  assert.throws(() => app.publish(graph), /Unknown adapter/);
  adapters.set('later', { call: async () => text('here now') });
  const revision = app.publish(graph);
  assert.deepEqual(
    await app.start({ owner: 'o', revision, entry: 'main', workspace: '/w', input: null }),
    text('here now'),
  );
});

test('draft-07 schemas publish, the url format stays linear, and a call asks the policy only about its chain', async (t) => {
  const database = memoryDatabase(t);
  const groups = Array.from({ length: 20 }, (_, g) =>
    cell(
      'g' + g,
      Array.from({ length: 20 }, (_, i) => `t${g}_${i}`),
    ),
  );
  let asked = 0;
  const app = createApp({
    database,
    discoveryBytes: 0,
    adapters: new Map([['ok', { call: async () => text('ok') }]]),
    platform: {
      allowed: () => (asked++, true),
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          await client.listTools();
          asked = 0;
          assert.deepEqual(await client.callTool({ name: 'invoke', arguments: { name: 't7_3' } }), text('ok'));
          assert.ok(asked <= 3, 'the policy was asked ' + asked + ' times');
          const legacy = (args) => client.callTool({ name: 'invoke', arguments: { name: 'legacy', arguments: args } });
          await refused(legacy({}), /must have required property 'q'/);
          assert.deepEqual(await legacy({ q: 'x', link: 'https://example.com/a' }), text('ok'));
          const started = performance.now();
          await refused(legacy({ q: 'x', link: 'https://' + 'a'.repeat(256 * 1024) }), /format/);
          assert.ok(performance.now() - started < 500);
          return text('done');
        }),
    },
  });
  const legacy = tool(
    'legacy',
    { adapter: 'ok' },
    {
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['q'],
        properties: { q: { type: 'string' }, link: { type: 'string', format: 'url' } },
      },
    },
  );
  const tools = groups.flatMap((group) => group.exports.map((id) => tool(id, { adapter: 'ok' })));
  const revision = app.publish([
    cell('root', ['legacy', ...groups.map((group) => group.id)]),
    legacy,
    ...groups,
    ...tools,
  ]);
  assert.deepEqual(await app.start(request(revision)), text('done'));
});

test("a graph that doesn't parse, or a tool bound to a cell that declares its output, is refused in celler's words", (t) => {
  const app = createApp({ database: memoryDatabase(t), adapters: new Map(), platform: {} });
  assert.throws(
    () => app.publish([{ kind: 'cell', id: 'a' }]),
    (error) => error.name === 'CellerError' && error.code === 'INVALID_CONFIG' && /title/.test(error.message),
  );
  // A delegated run answers in text, so no structured output could ever pass.
  assert.throws(
    () =>
      app.publish([
        cell('a', ['go']),
        tool('go', { cell: 'b' }, { outputSchema: object({ id: { type: 'string' } }) }),
        cell('b', []),
      ]),
    (error) => error.code === 'INVALID_CONFIG' && /outputSchema/.test(error.message),
  );
});

test('a result or a start input over the inline limit is refused, and JSON nested past its bound is invalid, never a stack overflow', async (t) => {
  const big = 'x'.repeat(10_000);
  const app = createApp({
    database: memoryDatabase(t),
    inlineLimit: 1024,
    adapters: new Map([['big', { call: async () => text(big) }]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          await refused(client.callTool({ name: 'look', arguments: {} }), /inline limit/);
          return text('done');
        }),
    },
  });
  const revision = app.publish([cell('root', ['look']), tool('look', { adapter: 'big' })]);
  assert.deepEqual(await app.start(request(revision)), text('done'));
  await assert.rejects(app.start({ ...request(revision), input: big }), {
    name: 'CellerError',
    code: 'LIMIT_EXCEEDED',
  });
  let deep = {};
  for (let i = 0; i < 20_000; i++) deep = { a: deep };
  await assert.rejects(app.start({ ...request(revision), input: deep }), { name: 'CellerError', code: 'INVALID_ARGS' });
});

test('a call asks the policy about each node on its chain once, where the chain splits and joins again too', async (t) => {
  let denying = false;
  const asked = [];
  const app = createApp({
    database: memoryDatabase(t),
    adapters: new Map([['ok', { call: async () => text('ok') }]]),
    platform: {
      allowed: (_run, id) => {
        if (denying) asked.push(id);
        return !(denying && id === 'd');
      },
      launch: (_spec, connect) =>
        withClient(
          connect,
          async (client) => {
            await client.listTools();
            denying = true;
            await refused(client.callTool({ name: 't', arguments: {} }), /outside this run/);
            return text('done');
          },
          true,
        ),
    },
  });
  const group = (id, exports) => ({ kind: 'cell', id, title: id, exports });
  const revision = app.publish([
    cell('root', ['d']),
    group('d', ['a', 'b', 'c']),
    group('a', ['t']),
    group('b', ['t']),
    group('c', ['t']),
    tool('t', { adapter: 'ok' }),
  ]);
  assert.deepEqual(await app.start(request(revision)), text('done'));
  assert.deepEqual(asked, ['t', 'a', 'd', 'b', 'c']);
});

test("the app's limits are the host's to set by name, the discover tool's own bounds and the database's wait too", async (t) => {
  const database = memoryDatabase(t);
  const graph = [
    cell('root', ['t1', 't2', 't3']),
    ...['t1', 't2', 't3'].map((id) => tool(id, { adapter: 'ok' }, { inputSchema: object({ n: { type: 'number' } }) })),
  ];
  const app = createApp({
    database,
    discoveryBytes: 0,
    discoveryPageSize: 2,
    discoveryQueryChars: 8,
    callIdChars: 4,
    argsErrorChars: 12,
    busyTimeoutMs: 250,
    adapters: new Map([['ok', { call: async () => text('ok') }]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          const page = await discover(client, {});
          assert.deepEqual([page.items.length, page.next], [2, 2]);
          await assert.rejects(discover(client, { query: 'x'.repeat(9) }), /discover arguments/);
          await assert.rejects(
            client.callTool({ name: 'invoke', arguments: { name: 't1' }, _meta: { 'celler/call-id': '12345' } }),
            /call-id/,
          );
          const heard = await refused(
            client.callTool({ name: 'invoke', arguments: { name: 't1', arguments: { n: 'x' } } }),
            /^Invalid arguments for t1: /,
          );
          assert.equal(heard.content[0].text.length, 'Invalid arguments for t1: '.length + 12);
          return text('done');
        }),
    },
  });
  assert.deepEqual(await app.start(request(app.publish(graph))), text('done'));
  assert.equal(database.prepare('PRAGMA busy_timeout').get().timeout, 250);
  assert.throws(() => createApp({ database, platform: {}, adapters: new Map(), maxTasks: 0 }), /Invalid maxTasks/);
});

test("a limit in milliseconds is a timer's, no longer than one waits: a longer one is refused, not cut to a millisecond", (t) => {
  const options = {
    database: memoryDatabase(t),
    adapters: new Map(),
    platform: { allowed: () => true, launch: async () => text('') },
  };
  for (const name of ['taskTtlMs', 'progressIntervalMs', 'busyTimeoutMs']) {
    assert.throws(
      () => createApp({ ...options, [name]: 2 ** 31 }),
      (error) => error.code === 'INVALID_CONFIG' && error.message === `Invalid ${name}: longer than a timer waits`,
      name,
    );
  }
  assert.ok(createApp({ ...options, taskTtlMs: 2 ** 31 - 1 }));
});
