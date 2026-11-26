import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from 'celler';
import { cell, discover, memoryDatabase, object, refused, request, text, tool, until, withClient } from './support.mjs';

test('discovery, pinned grants and private delegation use the same published graph', async (t) => {
  const database = memoryDatabase(t);
  const denied = new Set(['later']);
  const content = [{ type: 'text', text: 'Private review instructions' }];
  const adapters = new Map([
    [
      'read',
      {
        call: async (_run, args) => ({ ...text('record'), structuredContent: { sha256: args.record_id ?? 'private' } }),
      },
    ],
  ]);
  const inspect = tool(
    'inspect',
    { adapter: 'read' },
    {
      name: 'upstream_lookup',
      description: 'Look up a record.',
      inputSchema: object({ record_id: { type: 'string', description: 'A catalogue accession' } }),
      outputSchema: object({ sha256: { type: 'string' } }),
    },
  );
  const records = [
    cell('root', ['left', 'right', 'review', 'later'], { pins: ['inspect'], context: ['Root brief'] }),
    cell('left', ['inspect']),
    cell('right', ['inspect']),
    inspect,
    tool('review', { cell: 'expert' }),
    cell('expert', ['private'], { context: content }),
    tool('private', { adapter: 'read' }),
    tool('later', { adapter: 'read' }),
  ];
  let app, childId, rootId;
  const platform = {
    allowed: (_run, id) => !denied.has(id),
    launch: (spec, connect) =>
      withClient(connect, async (client) => {
        if (spec.entry === 'expert') {
          childId = spec.id;
          assert.equal(spec.workspace, 'folder');
          assert.equal(spec.parent.run, rootId);
          assert.deepEqual(spec.context, content);
          assert.deepEqual(
            (await discover(client, {})).items.map((x) => x.id),
            ['private'],
          );
          return client.callTool({ name: 'invoke', arguments: { name: 'private' } });
        }
        rootId = spec.id;
        denied.delete('later');
        assert.deepEqual(spec.context, ['Root brief']);
        const names = (await client.listTools()).tools.map((x) => x.name);
        assert.deepEqual(names, ['inspect', 'discover', 'invoke']);
        const result = await discover(client, { query: 'sha256' });
        assert.equal(result.items.length, 1);
        assert.deepEqual(result.items[0].parents.map((x) => x.id).sort(), ['left', 'right']);
        assert.deepEqual(result.items[0].inputs, [{ name: 'record_id', type: 'string', required: true }]);
        assert.deepEqual(result.items[0].outputs, [{ name: 'sha256', type: 'string', required: true }]);
        assert.equal((await discover(client, { query: 'accession' })).items[0].id, 'inspect');
        const [full] = await discover(client, { within: 'left', refs: ['inspect'] });
        assert.equal(full.inputSchema.properties.record_id.description, 'A catalogue accession');
        assert.deepEqual(full.outputSchema, inspect.definition.outputSchema);
        assert.deepEqual((await discover(client, { query: 'later' })).items, []);
        await assert.rejects(discover(client, { refs: ['private'] }));
        await assert.rejects(client.callTool({ name: 'review', arguments: {} }));
        await refused(
          client.callTool({ name: 'inspect', arguments: { record_id: false } }),
          /record_id must be string/,
        );
        const good = await client.callTool({ name: 'inspect', arguments: { record_id: 'A7' } });
        assert.deepEqual(good.structuredContent, { sha256: 'A7' });
        denied.add('inspect');
        await refused(client.callTool({ name: 'inspect', arguments: { record_id: 'A7' } }), /outside this run/);
        return client.callTool({ name: 'invoke', arguments: { name: 'review' } });
      }),
  };
  app = createApp({ database, platform, adapters, discoveryBytes: 0 });
  const revision = app.publish(records);
  records[0].context[0] = 'Subsequent edit';
  const output = await app.start(request(revision));
  assert.deepEqual(output.structuredContent, { sha256: 'private' });
  assert.equal(app.history('alice', childId).at(-1).kind, 'ended');
  assert.throws(() => app.history('bob', rootId), /Unknown run/);
});

test('small matches carry complete definitions and the server checks declared outputs', async (t) => {
  const database = memoryDatabase(t);
  const app = createApp({
    database,
    adapters: new Map([['broken', { call: async () => text('missing output') }]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          const match = (await discover(client, { query: 'sample' })).items[0];
          assert.deepEqual(match.definition.outputSchema.required, ['key']);
          await refused(client.callTool({ name: 'sample', arguments: {} }), /structured output/);
          return text('done');
        }),
    },
  });
  const revision = app.publish([
    cell('root', ['sample']),
    tool(
      'sample',
      { adapter: 'broken' },
      {
        outputSchema: object({ key: { type: 'string' } }),
      },
    ),
  ]);
  await app.start(request(revision));
});

test("a connection given the menu keeps it when what it may use shrinks, so the model's invoke calls keep working", async (t) => {
  const database = memoryDatabase(t);
  const revoked = new Set();
  const app = createApp({
    database,
    // Both tools listed in full are more than this; the small one alone fits.
    discoveryBytes: 600,
    adapters: new Map([['ok', { call: async () => text('ok') }]]),
    platform: {
      allowed: (_run, id) => !revoked.has(id),
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          const names = async (c) => (await c.listTools()).tools.map((x) => x.name);
          assert.deepEqual(await names(client), ['discover', 'invoke']);
          revoked.add('big');
          await app.notifyToolsChanged(spec.id);
          assert.deepEqual(await names(client), ['discover', 'invoke']);
          // A new connection, with the small one only, is given it in full.
          await withClient(
            (ch, n) => app.reconnect('alice', spec.id, ch, n),
            async (fresh) => {
              assert.deepEqual(await names(fresh), ['small', 'discover']);
            },
          );
          return text('done');
        }),
    },
  });
  const revision = app.publish([
    cell('root', ['small', 'big']),
    tool('small', { adapter: 'ok' }),
    tool('big', { adapter: 'ok' }, { description: 'x'.repeat(2_000) }),
  ]);
  assert.deepEqual(await app.start(request(revision)), text('done'));
});

test('a change to what runs may use is told to the connections of the run named, or of every run', async (t) => {
  const database = memoryDatabase(t);
  const heard = { first: 0, second: 0 };
  const runs = {};
  let release;
  const going = new Promise((resolve) => {
    release = resolve;
  });
  const app = createApp({
    database,
    adapters: new Map([['ok', { call: async () => text('ok') }]]),
    platform: {
      allowed: () => true,
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            heard[spec.input]++;
          });
          await client.listTools();
          runs[spec.input] = spec.id;
          await going;
          return text(spec.input);
        }),
    },
  });
  const revision = app.publish([cell('root', ['t1']), tool('t1', { adapter: 'ok' })]);
  const first = app.start({ ...request(revision), input: 'first' });
  const second = app.start({ ...request(revision), input: 'second' });
  await until(() => runs.first && runs.second);
  await app.notifyToolsChanged(runs.first);
  await until(() => heard.first === 1);
  await delay(50);
  assert.equal(heard.second, 0);
  await app.notifyToolsChanged();
  await until(() => heard.first === 2 && heard.second === 1);
  release();
  assert.deepEqual([await first, await second], [text('first'), text('second')]);
});

test('cell-scoped policies, BFS order, pagination, nativeDiscovery, limits, and MCP error sanitization', async (t) => {
  const database = memoryDatabase(t);
  let releaseSlow;
  const slowDone = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const adapters = new Map([
    ['ok', { call: async () => text('ok') }],
    [
      'secretFail',
      {
        call: async () => {
          throw Error('postgres://user:supersecret@10.0.0.5/db');
        },
      },
    ],
    [
      'slow',
      {
        call: async () => {
          await slowDone;
          return text('done');
        },
      },
    ],
  ]);
  const nodes = [
    cell('root', ['first', 'second', 'delegate', 'leak', 'slowTool'], { pins: ['t1'] }),
    { kind: 'cell', id: 'first', title: 'First', exports: ['t1', 't2', 't3'] },
    { kind: 'cell', id: 'second', title: 'Second', exports: ['t4', 't5', 't6'] },
    tool(
      't1',
      { adapter: 'ok' },
      {
        description: 'alpha',
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: 'object',
          properties: { mode: { enum: ['a', 'b'] }, opt: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
        },
      },
    ),
    tool('t2', { adapter: 'ok' }, { description: 'alpha' }),
    tool('t3', { adapter: 'ok' }, { description: 'alpha' }),
    tool('t4', { adapter: 'ok' }, { description: 'alpha' }),
    tool('t5', { adapter: 'ok' }, { description: 'alpha' }),
    tool('t6', { adapter: 'ok' }, { description: 'alpha' }),
    tool('leak', { adapter: 'secretFail' }),
    tool('slowTool', { adapter: 'slow' }),
    tool('delegate', { cell: 'child' }),
    cell('child', ['privateTool', 'deeper', 't6']),
    tool('privateTool', { adapter: 'ok' }),
    tool('deeper', { cell: 'grandchild' }),
    cell('grandchild', ['t1']),
  ];
  let app;
  const platform = {
    allowed: (run, id) => {
      if (id === 't6' && run.entry === 'root') return false;
      if (id === 'privateTool') return run.entry === 'child';
      return true;
    },
    launch: (spec, connect) =>
      withClient(connect, async (client) => {
        if (spec.entry === 'child') {
          // Policy allows both here, but root could reach t6 and was denied it.
          assert.deepEqual(await client.callTool({ name: 'invoke', arguments: { name: 'privateTool' } }), text('ok'));
          await refused(client.callTool({ name: 'invoke', arguments: { name: 't6' } }), /outside/);
          // maxDepth = 1 rejects grandchild delegation.
          await refused(client.callTool({ name: 'invoke', arguments: { name: 'deeper' } }), /depth/);
          return text('child-ok');
        }
        // With discoveryBytes = 0, results are compact cards, five a page, in BFS order.
        const page1 = await discover(client, { query: 'alpha' });
        assert.deepEqual(
          page1.items.map((x) => x.id),
          ['t1', 't2', 't3', 't4', 't5'],
        );
        assert.equal(page1.next, null); // t6 was denied
        assert.deepEqual(page1.items[0].annotations, { readOnlyHint: true });
        assert.deepEqual(page1.items[0].inputs, [
          { name: 'mode', type: 'enum', required: false },
          { name: 'opt', type: 'string|null', required: false },
        ]);
        const deduped = await discover(client, { refs: ['t1', 't1'] });
        assert.equal(deduped.length, 1);
        await assert.rejects(discover(client, { query: 'x'.repeat(300) }));
        await assert.rejects(
          client.callTool({ name: 't1', arguments: {}, _meta: { 'celler/call-id': '' } }),
          /call-id/,
        );
        // A raw adapter error never reaches the harness.
        const leaked = await refused(
          client.callTool({ name: 'invoke', arguments: { name: 'leak' } }),
          /Tool execution failed/,
        );
        assert.ok(!/supersecret/.test(JSON.stringify(leaked)));
        // maxConcurrency = 1 refuses a second call while slowTool runs.
        const firstSlow = client.callTool({ name: 'invoke', arguments: { name: 'slowTool' } });
        await refused(client.callTool({ name: 't1', arguments: {} }), /concurrent/);
        releaseSlow();
        await firstSlow;
        // Native discovery lists every tool directly, even with discoveryBytes = 0, and nothing to search them with.
        await withClient(
          (ch, n) => app.reconnect('alice', spec.id, ch, n),
          async (nativeClient) => {
            const names = (await nativeClient.listTools()).tools.map((x) => x.name);
            assert.ok(names.includes('t5') && !names.includes('invoke') && !names.includes('discover'));
            // BFS order puts first's exports before second's exports.
            assert.ok(names.indexOf('t1') < names.indexOf('t4'));
          },
          true,
        );
        return client.callTool({ name: 'invoke', arguments: { name: 'delegate' } });
      }),
  };
  app = createApp({ database, platform, adapters, discoveryBytes: 0, maxDepth: 1, maxConcurrency: 1 });
  const revision = app.publish(nodes);
  assert.deepEqual(await app.start(request(revision)), text('child-ok'));
  // Retiring an unrelated adapter still lets historical revisions load and run other tools.
  const upgraded = createApp({
    database,
    adapters: new Map([['ok', adapters.get('ok')]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(
          connect,
          async (client) => {
            assert.deepEqual(await client.callTool({ name: 't1', arguments: {} }), text('ok'));
            await refused(client.callTool({ name: 'leak', arguments: {} }), /Adapter unavailable/);
            return text('upgraded-ok');
          },
          true,
        ),
    },
  });
  assert.deepEqual(await upgraded.start(request(revision)), text('upgraded-ok'));
});

test("a connection that fails to start is forgotten: a change to the tools isn't sent to it", async (t) => {
  let runId, finish;
  const app = createApp({
    database: memoryDatabase(t),
    adapters: new Map(),
    platform: {
      allowed: () => true,
      launch: async (spec) => {
        runId = spec.id;
        await new Promise((resolve) => {
          finish = resolve;
        });
        return text('done');
      },
    },
  });
  const running = app.start(request(app.publish([cell('root', [])])));
  await until(() => runId);
  const sent = [];
  const broken = {
    start: async () => {
      throw Error('transport failed to start');
    },
    send: async (message) => {
      sent.push(message);
    },
    close: async () => {},
  };
  await assert.rejects(app.reconnect('alice', runId, broken), /failed to start/);
  await app.notifyToolsChanged(runId);
  await app.notifyToolsChanged();
  assert.deepEqual(sent, []);
  finish();
  assert.deepEqual(await running, text('done'));
});

test("discover looks inside cells only: a tool named as within is the model's mistake to fix", async (t) => {
  const app = createApp({
    database: memoryDatabase(t),
    adapters: new Map([['ok', { call: async () => text('ok') }]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          await refused(
            client.callTool({ name: 'discover', arguments: { within: 't' } }),
            /Expected a cell in within: t/,
          );
          return text('done');
        }),
    },
  });
  assert.deepEqual(
    await app.start(request(app.publish([cell('root', ['t']), tool('t', { adapter: 'ok' })]))),
    text('done'),
  );
});

test("a run's server says what it holds before any tool, in the host's words: its cell on the first line, then what it reaches as an outline, cut at a whole line; and its version is this library's", async (t) => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const graph = [
    cell('root', ['team', 'side', 'echo', 'plain', 'hidden'], {
      title: 'Front desk',
      description: 'Answers the person.',
    }),
    // A description over lines stays on one; a cell in two places is told once, where it is found first.
    cell('team', ['notes', 'ask'], { title: 'Team', description: 'Keeps\n  the notes.' }),
    cell('side', ['team'], { title: 'Side' }),
    // One with neither title nor description is no line of its own: its tools are told at its place.
    cell('plain', ['filed'], { title: '' }),
    tool('filed', { adapter: 'ok' }),
    tool('echo', { adapter: 'ok' }, { title: 'Echo it back' }),
    tool('notes', { adapter: 'ok' }),
    tool('ask', { cell: 'expert' }, { title: 'Ask the expert' }),
    // Behind a delegation, and denied: neither is the run's to see.
    cell('expert', ['secret'], { title: 'Expert' }),
    tool('secret', { adapter: 'ok' }),
    tool('hidden', { adapter: 'ok' }),
  ];
  const told = async (limits = {}, nodes = graph) => {
    let seen;
    const app = createApp({
      database: memoryDatabase(t),
      adapters: new Map([['ok', { call: async () => text('ok') }]]),
      platform: {
        allowed: (_run, id) => id !== 'hidden',
        launch: (_spec, connect) =>
          withClient(connect, async (client) => {
            seen = [client.getInstructions(), client.getServerVersion()];
            return text('done');
          }),
      },
      ...limits,
    });
    await app.start(request(app.publish(nodes)));
    return seen;
  };
  const [instructions, server] = await told();
  assert.equal(
    instructions,
    [
      'Front desk: Answers the person.',
      '- Team: Keeps the notes.',
      '  - notes',
      '  - ask: Ask the expert',
      '- Side',
      '- echo: Echo it back',
      '- filed',
    ].join('\n'),
  );
  assert.deepEqual(server, { name: 'celler', version });
  const [cut] = await told({ instructionsChars: 40 });
  assert.equal(cut, 'Front desk: Answers the person.');
  // Nor is the run's own cell, then: its outline starts at once.
  const untitled = graph.map((node) => (node.id === 'root' ? { ...node, title: '', description: '' } : node));
  const [outline] = await told({}, untitled);
  assert.equal(outline.split('\n')[0], '- Team: Keeps the notes.');
});
