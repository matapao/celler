import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '@matapao/celler';
import { cell, memoryDatabase, object, refused, request, text, tool, until, withClient } from './support.mjs';
import { packet } from './support-approval.mjs';

// A call's key, which a retry joins: the client's own (celler/call-id), else its tool and arguments, which join an
// approval while it is open, or until a call has heard what it came to.

test('blind retries join their approval, a retry right after a timeout works, and a delivery keeps its receipt', async (t) => {
  const database = memoryDatabase(t);
  const sent = [];
  const app = createApp({
    database,
    adapters: new Map([
      [
        'delivery',
        {
          async prepare(_run, args, signal) {
            if (args.message === 'slow') await delay(300, undefined, { signal });
            return packet(String(args.message));
          },
          send: async (_run, write) => {
            sent.push(write);
            return text('delivered without structured content');
          },
        },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          // An ordinary client: no celler/call-id, a timeout shorter than the person, and a retry. -0 must not break it.
          const blind = () =>
            client.callTool({ name: 'send', arguments: { message: 'once', n: -0 } }, undefined, { timeout: 100 });
          await assert.rejects(blind(), /timed out/);
          await assert.rejects(blind(), /timed out/);
          assert.equal(app.human.inbox('alice').length, 1);
          // The documented retry contract, right after a timeout that hit while prepare() was still running.
          const keyed = (timeout) =>
            client.callTool(
              { name: 'send', arguments: { message: 'slow' }, _meta: { 'celler/call-id': 'k1' } },
              undefined,
              { timeout },
            );
          await assert.rejects(keyed(50), /timed out/);
          const retried = keyed(5000);
          await until(() => app.human.inbox('alice').length >= 2);
          // A response that fails the output schema still leaves the delivery recorded as sent.
          for (const item of app.human.inbox('alice')) {
            await assert.rejects(app.human.approve('alice', item.id), /structured output/);
            assert.equal(app.human.review('alice', item.id).state, 'sent');
          }
          await refused(retried, /structured output/);
          assert.equal(sent.length, 2);
          return text('done');
        }),
    },
  });
  const revision = app.publish([
    cell('root', ['send']),
    tool(
      'send',
      { adapter: 'delivery' },
      {
        inputSchema: {
          type: 'object',
          required: ['message'],
          additionalProperties: false,
          properties: { message: { type: 'string' }, n: { type: 'number' } },
        },
        outputSchema: object({ id: { type: 'string' } }),
      },
    ),
  ]);
  assert.deepEqual(await app.start(request(revision)), text('done'));
});

test('the same call made again once its approval is settled is made again, and a blind retry of it joins it', async (t) => {
  const sent = [];
  let runId;
  const app = createApp({
    database: memoryDatabase(t),
    adapters: new Map([
      [
        'delivery',
        {
          prepare: async (_run, args) => packet(String(args.message)),
          // The service refuses the first, as it answers: an answer like any, kept as sent.
          send: async (_run, write) => {
            sent.push(write);
            return sent.length === 1 ? { isError: true, content: [{ type: 'text', text: 'no lines' }] } : text('sent');
          },
        },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          runId = spec.id;
          // As Claude Code and Codex call: no celler/call-id, the same arguments each time.
          const call = () => client.callTool({ name: 'send', arguments: { message: 'invoice 7' } });
          const pending = () => app.human.inbox('alice').filter((item) => item.state === 'pending');
          const approve = async () => {
            await until(() => pending().length === 1);
            await app.human.approve('alice', pending()[0].id);
          };
          const first = call();
          await approve();
          assert.deepEqual(await first, { isError: true, content: [{ type: 'text', text: 'no lines' }] });
          // Made again: a card of its own, and a retry of it while it waits joins that one.
          const second = call();
          await until(() => pending().length === 1);
          const retry = call();
          await delay(50);
          assert.equal(pending().length, 1);
          await approve();
          assert.deepEqual(await second, text('sent'));
          assert.deepEqual(await retry, text('sent'));
          assert.equal(sent.length, 2);
          return text('done');
        }),
    },
  });
  const revision = app.publish([
    cell('root', ['send']),
    tool(
      'send',
      { adapter: 'delivery' },
      {
        inputSchema: object({ message: { type: 'string' } }),
      },
    ),
  ]);
  assert.deepEqual(await app.start(request(revision)), text('done'));
  // Its run ended, the same call collects what the last one it staged came to, and stages nothing more.
  await withClient(
    (channel) => app.reconnect('alice', runId, channel),
    async (client) => {
      assert.deepEqual(await client.callTool({ name: 'send', arguments: { message: 'invoice 7' } }), text('sent'));
    },
  );
  assert.deepEqual([sent.length, app.human.inbox('alice').filter((item) => item.state === 'pending')], [2, []]);
});

test('a retry of a call whose answer reached no call collects it once it is settled; once heard, the same call is made again', async (t) => {
  const sent = [];
  const app = createApp({
    database: memoryDatabase(t),
    adapters: new Map([
      [
        'delivery',
        {
          prepare: async (_run, args) => packet(String(args.message)),
          send: async (_run, write) => (sent.push(write), text('sent')),
        },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          // As Claude Code and Codex call: no celler/call-id, the same arguments each time.
          const call = (options) =>
            client.callTool({ name: 'send', arguments: { message: 'invoice 8' } }, undefined, options);
          const pending = () => app.human.inbox('alice').filter((item) => item.state === 'pending');
          // Its agent's own limit on the call ends it while it waits: the answer, once there, reaches no call.
          const first = call({ timeout: 300 });
          await until(() => pending().length === 1);
          await assert.rejects(first, /timed out/);
          await app.human.approve('alice', pending()[0].id);
          // Made again, it is the retry that collects what the first came to: no card, nothing sent again.
          assert.deepEqual(await call(), text('sent'));
          assert.deepEqual([sent.length, pending()], [1, []]);
          // Once that was heard, the same call is a new one, with a card of its own.
          const again = call();
          await until(() => pending().length === 1);
          await app.human.approve('alice', pending()[0].id);
          assert.deepEqual(await again, text('sent'));
          assert.equal(sent.length, 2);
          return text('done');
        }),
    },
  });
  const revision = app.publish([
    cell('root', ['send']),
    tool('send', { adapter: 'delivery' }, { inputSchema: object({ message: { type: 'string' } }) }),
  ]);
  assert.deepEqual(await app.start(request(revision)), text('done'));
});
