import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, NotSent } from 'celler';
import { cell, memoryDatabase, object, refused, request, text, tool, until, withClient } from './support.mjs';
import { graph, packet, pending, use } from './support-approval.mjs';

test("a send that throws leaves its delivery unknown: the agent hears celler's words, it is never offered again, and the host settles it", async (t) => {
  const database = memoryDatabase(t);
  let sends = 0;
  const app = createApp({
    database,
    adapters: new Map([
      [
        'delivery',
        {
          prepare: async (_run, args) => packet(String(args.message)),
          send: async () => {
            sends++;
            throw Error('socket hang up at 10.0.0.5');
          },
        },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          const call = use(client, 'k-throws');
          const id = await pending(app);
          // The host's own adapter failed: the host hears why.
          await assert.rejects(app.human.approve('alice', id), /socket hang up/);
          // The agent hears only that it may or may not have arrived.
          const heard = await call;
          assert.equal(heard.isError, true);
          assert.match(heard.content[0].text, /Delivery outcome unknown until the host reconciles it/);
          assert.doesNotMatch(heard.content[0].text, /socket|10\.0\.0\.5/);
          // Never offered again, so never sent twice; the host settles it from what it found at the destination.
          assert.equal(app.human.inbox('alice').find((row) => row.id === id).state, 'unknown');
          await assert.rejects(app.human.approve('alice', id), /not pending/);
          app.human.reconcile('alice', id, 'failed');
          assert.equal(
            app.human.inbox('alice').some((row) => row.id === id),
            false,
          );
          assert.equal(sends, 1);
          return text('done');
        }),
    },
  });
  const revision = app.publish(graph);
  assert.deepEqual(await app.start(request(revision)), text('done'));
});

test("a send that throws NotSent never left: its delivery failed, with its event, and the agent hears celler's words; any other throw is unknown, as before", async (t) => {
  let thrown;
  const app = createApp({
    database: memoryDatabase(t),
    adapters: new Map([
      [
        'delivery',
        {
          prepare: async (_run, args) => packet(String(args.message)),
          send: async () => {
            throw thrown;
          },
        },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          const outcome = async (key, error) => {
            thrown = error;
            const call = use(client, key);
            const id = await pending(app);
            // The host's own error comes back to it, whichever it threw.
            await assert.rejects(app.human.approve('alice', id), (err) => err === error);
            const heard = await call;
            const event = app.history('alice', spec.id).findLast((e) => e.kind === 'delivery_failed');
            const waiting = app.human.inbox('alice').some((row) => row.id === id);
            return { id, state: app.human.review('alice', id).state, waiting, heard, event: event.detail };
          };
          const never = await outcome('k-never', new NotSent('Connection refused by 10.0.0.5'));
          assert.deepEqual(never, {
            id: never.id,
            state: 'failed',
            waiting: false,
            heard: { isError: true, content: [{ type: 'text', text: 'Delivery failed' }] },
            event: { id: never.id, tool: 'send', outcome: 'failed' },
          });
          // Failed for good: nothing is left for the host to reconcile.
          assert.throws(() => app.human.reconcile('alice', never.id, 'sent'), /not unknown/);
          const maybe = await outcome('k-maybe', new Error('socket hang up'));
          assert.deepEqual(maybe, {
            id: maybe.id,
            state: 'unknown',
            waiting: true,
            heard: {
              isError: true,
              content: [{ type: 'text', text: 'Delivery outcome unknown until the host reconciles it' }],
            },
            event: { id: maybe.id, tool: 'send' },
          });
          return text('done');
        }),
    },
  });
  assert.deepEqual(await app.start(request(app.publish(graph))), text('done'));
});

/** An approval its run staged, with verify held open until `open()`: a run that stays until it is ended, or leaves. */
async function heldInVerify(t, { stays }) {
  const held = { allowed: true, sent: [], verifying: false };
  const opened = new Promise((resolve) => {
    held.open = resolve;
  });
  const app = createApp({
    database: memoryDatabase(t),
    adapters: new Map([
      [
        'delivery',
        {
          prepare: async (_run, args) => packet(String(args.message)),
          verify: async () => {
            held.verifying = true;
            await opened;
          },
          send: async (_run, write) => {
            held.sent.push(write);
            return text('sent');
          },
        },
      ],
    ]),
    platform: {
      allowed: (_run, id) => id !== 'send' || held.allowed,
      launch: (spec, connect, signal) =>
        withClient(connect, async (client) => {
          held.run = spec.id;
          use(client, 'k').catch(() => {});
          await pending(app);
          if (stays) await delay(60_000, undefined, { signal }).catch(() => {});
          return text('left for a person');
        }),
    },
  });
  held.running = app.start(request(app.publish(graph))).catch((error) => error);
  held.id = await pending(app);
  if (!stays) await held.running;
  return { app, held };
}

test("what changes while verify runs stops the send: the run ended, the policy now denying it, or the caller's signal", async (t) => {
  {
    const { app, held } = await heldInVerify(t, { stays: true });
    const approving = app.human.approve('alice', held.id);
    await until(() => held.verifying);
    app.end('alice', held.run);
    held.open();
    await assert.rejects(approving, /cancelled/);
    assert.equal(app.human.review('alice', held.id).state, 'pending');
    assert.deepEqual(held.sent, []);
    await held.running;
  }
  {
    const { app, held } = await heldInVerify(t, { stays: false });
    const approving = app.human.approve('alice', held.id);
    await until(() => held.verifying);
    held.allowed = false;
    held.open();
    await assert.rejects(approving, /outside this run/);
    assert.equal(app.human.review('alice', held.id).state, 'pending');
    assert.deepEqual(held.sent, []);
  }
  {
    const { app, held } = await heldInVerify(t, { stays: false });
    held.open();
    await assert.rejects(app.human.approve('alice', held.id, AbortSignal.abort()), { name: 'AbortError' });
    assert.equal(app.human.review('alice', held.id).state, 'pending');
    assert.deepEqual(held.sent, []);
    // Approved again, it goes out once.
    assert.deepEqual(await app.human.approve('alice', held.id), text('sent'));
    assert.equal(held.sent.length, 1);
  }
});

test("a delivery whose answer isn't JSON, or is over the inline limit, is still recorded as sent with its event", async (t) => {
  const big = 'x'.repeat(10_000);
  let runId;
  const app = createApp({
    database: memoryDatabase(t),
    inlineLimit: 1024,
    adapters: new Map([
      [
        'delivery',
        {
          prepare: async (_run, args) => packet(String(args.message)),
          send: async (_run, write) =>
            write.content.message === 'big' ? text(big) : { content: [], structuredContent: { n: 1n } },
        },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          runId = spec.id;
          for (const [message, answer] of [
            ['odd', /Invalid tool result/],
            ['big', /inline limit/],
          ]) {
            const call = use(client, message, message);
            const id = await pending(app);
            await assert.rejects(app.human.approve('alice', id));
            assert.equal(app.human.review('alice', id).state, 'sent');
            await refused(call, answer);
          }
          return text('done');
        }),
    },
  });
  assert.deepEqual(await app.start(request(app.publish(graph))), text('done'));
  assert.equal(app.history('alice', runId).filter((event) => event.kind === 'approved').length, 2);
});

test("a state change and its event are one: an event that can't be written leaves the state as it was", async (t) => {
  const database = memoryDatabase(t);
  const failing = (kind) =>
    database.exec(
      `CREATE TRIGGER fail_${kind} BEFORE INSERT ON events WHEN NEW.kind='${kind}' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`,
    );
  const writable = (kind) => database.exec(`DROP TRIGGER fail_${kind}`);
  let runId;
  const app = createApp({
    database,
    adapters: new Map([
      [
        'delivery',
        {
          prepare: async (_run, args) => packet(String(args.message)),
          send: async (_run, write) => {
            if (write.content.message === 'lost') throw Error('connection reset');
            return text('sent');
          },
        },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (spec, connect, signal) =>
        withClient(connect, async (client) => {
          runId = spec.id;
          for (const message of ['declined', 'sent', 'lost']) use(client, message, message).catch(() => {});
          await delay(60_000, undefined, { signal }).catch(() => {});
          return text('ended');
        }),
    },
  });
  const revision = app.publish(graph);
  const runs = () => database.prepare('SELECT COUNT(*) AS count FROM runs').get().count;
  failing('started');
  await assert.rejects(app.start(request(revision)), /disk is full/);
  assert.equal(runs(), 0);
  writable('started');

  const running = app.start(request(revision)).catch((error) => error);
  await until(() => app.human.inbox('alice').length === 3);
  const staged = (message) =>
    app.human.inbox('alice').find((row) => app.human.review('alice', row.id).write.content.message === message).id;
  const state = (id) => app.human.review('alice', id).state;

  failing('declined');
  assert.throws(() => app.human.decline('alice', staged('declined')), /disk is full/);
  assert.equal(state(staged('declined')), 'pending');
  writable('declined');

  // Delivered, but not recorded as sent without its event: still started, which a restart makes unknown for the host.
  const sent = staged('sent');
  failing('approved');
  await assert.rejects(app.human.approve('alice', sent), /disk is full/);
  assert.equal(state(sent), 'started');
  writable('approved');

  const lost = staged('lost');
  failing('delivery_failed');
  await assert.rejects(app.human.approve('alice', lost), /disk is full/);
  assert.equal(state(lost), 'started');
  writable('delivery_failed');

  failing('ended');
  assert.throws(() => app.end('alice', runId), /disk is full/);
  assert.equal(app.human.inbox('alice').find((row) => row.id === staged('declined')).runStatus, 'running');
  assert.equal(
    app.history('alice', runId).some((event) => event.kind === 'ended'),
    false,
  );
  writable('ended');
  app.end('alice', runId);
  await running;
});

test('a delivery the host settles as unknown, then as sent, answers the way its tool says it does, or that it was delivered', async (t) => {
  const database = memoryDatabase(t);
  let runId;
  const app = createApp({
    database,
    adapters: new Map([
      [
        'delivery',
        {
          prepare: async (_run, args) => packet(String(args.message)),
          send: async () => {
            throw Error('connection reset after the request was written');
          },
        },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          runId = spec.id;
          use(client, 'k1', 'first').catch(() => {});
          use(client, 'k2', 'second').catch(() => {});
          while (app.human.inbox('alice').filter((row) => row.state === 'pending').length < 2) await pending(app);
          return text('left for a person');
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
        outputSchema: object({ id: { type: 'string' } }),
      },
    ),
  ]);
  await app.start(request(revision));
  const [first, second] = app.human.inbox('alice').map((row) => row.id);
  for (const id of [first, second]) await assert.rejects(app.human.approve('alice', id), /connection reset/);
  // A result that isn't what the tool says it answers is refused, and nothing changes.
  assert.throws(() => app.human.reconcile('alice', first, 'sent', text('delivered')), /structured output/);
  assert.equal(app.human.review('alice', first).state, 'unknown');
  app.human.reconcile('alice', first, 'sent', { ...text('delivered'), structuredContent: { id: '42' } });
  // Confirmed without its answer: the run hears that it was delivered, and that what it answered isn't known.
  app.human.reconcile('alice', second, 'sent');
  assert.equal(app.human.review('alice', second).state, 'sent');
  await withClient(
    (channel) => app.reconnect('alice', runId, channel),
    async (client) => {
      assert.deepEqual((await use(client, 'k1', 'first')).structuredContent, { id: '42' });
      const confirmed = await use(client, 'k2', 'second');
      assert.deepEqual(
        [confirmed.isError, confirmed.content[0].text],
        [true, "Delivered (confirmed by the host), but what it answered isn't known"],
      );
    },
  );
});
