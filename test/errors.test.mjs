import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from 'celler';
import { callThenClose, cell, memoryDatabase, request, text, tool, until, withClient } from './support.mjs';

test("a policy that throws reaches the agent only in celler's words, while listing or calling, listed first or not", async (t) => {
  const database = memoryDatabase(t);
  let broken = false;
  const app = createApp({
    database,
    adapters: new Map([['ok', { call: async () => text('ok') }]]),
    platform: {
      allowed: () => {
        if (broken) throw Error('postgres://user:supersecret@10.0.0.5/db');
        return true;
      },
      launch: (spec, connect) =>
        withClient(
          connect,
          async (client) => {
            assert.ok((await client.listTools()).tools.some((x) => x.name === 'look'));
            broken = true;
            const heard = await client.callTool({ name: 'look', arguments: {} });
            assert.deepEqual(heard, { isError: true, content: [{ type: 'text', text: 'Tool execution failed' }] });
            const inCellerWords = (error) =>
              /Tool listing failed/.test(error.message) && !/supersecret|10\.0\.0\.5/.test(error.message);
            await assert.rejects(client.listTools(), inCellerWords);
            // A new connection that calls a tool it knows without listing first, as one does after it starts a new session.
            await withClient(
              (ch, n) => app.reconnect('alice', spec.id, ch, n),
              async (fresh) => {
                await assert.rejects(fresh.callTool({ name: 'look', arguments: {} }), inCellerWords);
              },
              true,
            );
            return text('done');
          },
          true,
        ),
    },
  });
  const revision = app.publish([cell('root', ['look']), tool('look', { adapter: 'ok' })]);
  assert.deepEqual(await app.start(request(revision)), text('done'));
});

test("an adapter's own MCP error reaches the agent only in celler's words, as a result it can read", async (t) => {
  const database = memoryDatabase(t);
  const upstream = new McpError(ErrorCode.InternalError, 'upstream db postgres://svc:hunter2@10.0.0.7/prod', {
    stack: 'at secret.js:1',
  });
  const app = createApp({
    database,
    adapters: new Map([
      [
        'upstream',
        {
          call: async () => {
            throw upstream;
          },
        },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(
          connect,
          async (client) => {
            const heard = await client.callTool({ name: 'look', arguments: {} });
            assert.deepEqual(heard, { isError: true, content: [{ type: 'text', text: 'Tool execution failed' }] });
            return text('done');
          },
          true,
        ),
    },
  });
  const revision = app.publish([cell('root', ['look']), tool('look', { adapter: 'upstream' })]);
  assert.deepEqual(await app.start(request(revision)), text('done'));
});

test("a call its run's end cuts off hears that the run ended, never what its adapter threw as it stopped", async (t) => {
  const secret = 'postgres://svc:hunter2@10.0.0.7/prod';
  let started = 0;
  // As a database driver does: aborted, it rejects with its own words.
  const adapters = new Map([
    [
      'db',
      {
        call: (_run, _args, signal) =>
          new Promise((_resolve, reject) => {
            started++;
            signal.addEventListener('abort', () => reject(Error(secret)), { once: true });
          }),
      },
    ],
  ]);
  const graph = [cell('root', ['look']), tool('look', { adapter: 'db' })];
  const heardEnded = (heard) => {
    assert.equal(heard.isError, true, JSON.stringify(heard));
    assert.equal(heard.content[0].text, 'Run has ended');
    assert.doesNotMatch(JSON.stringify(heard), /hunter2/);
  };

  // Ended by the host while the call waits.
  let app, heard;
  app = createApp({
    database: memoryDatabase(t),
    adapters,
    platform: {
      allowed: () => true,
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          const call = client.callTool({ name: 'look', arguments: {} });
          await until(() => started === 1);
          app.end('alice', spec.id);
          heard = await call;
          return text('ended');
        }),
    },
  });
  await assert.rejects(app.start(request(app.publish(graph))));
  heardEnded(heard);

  // A run that finishes with the call still going, its connection kept a moment, as harnessPlatform keeps it.
  /** @type {Promise<unknown>} */
  let late;
  const finished = createApp({
    database: memoryDatabase(t),
    adapters,
    platform: {
      allowed: () => true,
      launch: async (_spec, connect) => {
        const [local, remote] = InMemoryTransport.createLinkedPair();
        await connect(remote);
        const client = new Client({ name: 'test-harness', version: '1' });
        await client.connect(local);
        late = callThenClose(client, { name: 'look', arguments: {} });
        await until(() => started === 2);
        return text('finished');
      },
    },
  });
  assert.deepEqual(await finished.start(request(finished.publish(graph))), text('finished'));
  heardEnded(await late);

  // The database failing as a call begins, before any of its own work.
  const database = memoryDatabase(t);
  const broken = createApp({
    database,
    adapters: new Map([['ok', { call: async () => text('ok') }]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          await client.listTools();
          database.exec('ALTER TABLE runs RENAME TO runs_gone');
          const heard = await client.callTool({ name: 'look', arguments: {} }).then(
            (result) => JSON.stringify(result),
            (error) => error.message,
          );
          database.exec('ALTER TABLE runs_gone RENAME TO runs');
          assert.match(heard, /Tool execution failed/);
          assert.doesNotMatch(heard, /no such table|runs/);
          return text('done');
        }),
    },
  });
  assert.deepEqual(
    await broken.start(request(broken.publish([cell('root', ['look']), tool('look', { adapter: 'ok' })]))),
    text('done'),
  );
});
