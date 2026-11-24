import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createApp, NotSent } from '@matapao/celler';
import { hash } from '../dist/json.js';
import { cell, memoryDatabase, refused, request, text, tool, withClient } from './support.mjs';
import { graph, packet, pending, use } from './support-approval.mjs';

// celler keeps only what it must: a sent packet exactly as approved; of what never went, its state, when it changed and
// its hash; a delivery's answer until its run has collected it, then its hash; a run's output only as its hash.

/** Everything the database holds, as text, to look for what it should no longer keep. */
const everything = (database) =>
  JSON.stringify(
    ['revisions', 'runs', 'events', 'approvals'].map((table) =>
      database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ),
  );
const hashOf = (value) => JSON.stringify({ sha256: hash(value) });
const row = (database, id) => ({ ...database.prepare('SELECT * FROM approvals WHERE id=?').get(id) });

test('a call that never went keeps no arguments or packet, only their hash, its state and when it changed; a sent one keeps its packet exactly', async (t) => {
  const database = memoryDatabase(t);
  const app = createApp({
    database,
    adapters: new Map([
      [
        'delivery',
        {
          prepare: async (_run, args) => packet(String(args.message)),
          send: async (_run, write) => {
            if (write.content.message === 'never reached') throw new NotSent();
            if (write.content.message === 'maybe reached') throw Error('connection reset');
            return text('sent');
          },
        },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          for (const call of calls) {
            const made = use(client, call.key, call.message);
            call.id = await pending(app);
            await call.decide(call.id);
            await made;
          }
          // A retry of the declined call still joins it by its arguments' hash, and other arguments still conflict.
          await refused(use(client, 'k-declined', 'declined content'), /declined/);
          await refused(use(client, 'k-declined', 'other content'), /different arguments/);
          return text('done');
        }),
    },
  });
  // Declined, failed as it never left, failed as the host found it never arrived, and sent.
  const calls = [
    {
      key: 'k-declined',
      message: 'declined content',
      state: 'declined',
      decide: async (id) => app.human.decline('alice', id),
    },
    {
      key: 'k-never',
      message: 'never reached',
      state: 'failed',
      decide: (id) => assert.rejects(app.human.approve('alice', id), NotSent),
    },
    {
      key: 'k-maybe',
      message: 'maybe reached',
      state: 'failed',
      decide: async (id) => {
        await assert.rejects(app.human.approve('alice', id), /connection reset/);
        app.human.reconcile('alice', id, 'failed');
      },
    },
    { key: 'k-sent', message: 'sent content', state: 'sent', decide: (id) => app.human.approve('alice', id) },
  ];
  assert.deepEqual(await app.start(request(app.publish(graph))), text('done'));

  for (const { id, message, state } of calls.filter((call) => call.state !== 'sent')) {
    const kept = row(database, id);
    assert.deepEqual([kept.args, kept.packet, kept.state], [hashOf({ message }), hashOf(packet(message)), state]);
    assert.ok(kept.created_at > 0 && kept.changed_at >= kept.created_at);
    const review = app.human.review('alice', id);
    assert.deepEqual(review, {
      id,
      run: review.run,
      runStatus: 'ok',
      tool: 'send',
      createdAt: kept.created_at,
      state,
      changedAt: kept.changed_at,
      write: { sha256: hash(packet(message)) },
    });
  }
  const stored = everything(database);
  for (const message of ['declined content', 'never reached', 'maybe reached', 'other content'])
    for (const trace of [message, Buffer.from(message).toString('base64')]) assert.ok(!stored.includes(trace), trace);

  // A sent one keeps its arguments, and its packet exactly as it was approved and sent.
  const sent = calls.at(-1);
  assert.deepEqual(app.human.review('alice', sent.id).write, packet('sent content'));
  const kept = row(database, sent.id);
  assert.deepEqual(
    [kept.args, kept.packet],
    [JSON.stringify({ message: 'sent content' }), JSON.stringify(packet('sent content'))],
  );
});

test("a delivery's answer is kept until its run has collected it, then only its id and hash; a retry before that still collects it", async (t) => {
  const database = memoryDatabase(t);
  const answer = (id) => {
    const { result, collected_at } = row(database, id);
    return { result, collected_at };
  };
  const app = createApp({
    database,
    adapters: new Map([
      [
        'delivery',
        { prepare: async (_run, args) => packet(String(args.message)), send: async () => text('the answer') },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          const call = (timeout) =>
            client.callTool(
              { name: 'send', arguments: { message: 'report' }, _meta: { 'celler/call-id': 'k' } },
              undefined,
              { timeout },
            );
          // Its agent's own limit ends the call while the person decides: the answer, once there, reaches no call.
          const first = call(300);
          const id = await pending(app);
          await assert.rejects(first, /timed out/);
          assert.deepEqual(await app.human.approve('alice', id), text('the answer'));
          assert.deepEqual(answer(id), { result: JSON.stringify(text('the answer')), collected_at: null });
          // A retry collects it, and from then on only its hash is kept, with when it was collected.
          assert.deepEqual(await call(5000), text('the answer'));
          const collected = answer(id);
          assert.equal(collected.result, hashOf(text('the answer')));
          assert.ok(collected.collected_at > 0);
          // The same call made again with its key hears only that it was delivered: nothing is sent again.
          await refused(call(5000), /^Delivered; an earlier call collected its answer$/);
          assert.deepEqual(app.human.review('alice', id).write, packet('report'));
          return text('done');
        }),
    },
  });
  assert.deepEqual(await app.start(request(app.publish(graph))), text('done'));
  assert.ok(!everything(database).includes('the answer'));
});

test("a run's `ended` event keeps its status and its output's hash, not the output, and a delegated run's answer still reaches its caller", async (t) => {
  const database = memoryDatabase(t);
  const runs = {};
  const app = createApp({
    database,
    adapters: new Map(),
    platform: {
      allowed: () => true,
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          runs[spec.entry] = spec.id;
          if (spec.entry === 'assistant') return text('the assistant answers');
          const heard = await client.callTool({ name: 'ask', arguments: {} });
          return { isError: true, content: [{ type: 'text', text: `main heard: ${heard.content[0].text}` }] };
        }),
    },
  });
  const revision = app.publish([cell('main', ['ask']), tool('ask', { cell: 'assistant' }), cell('assistant', [])]);
  const answered = { isError: true, content: [{ type: 'text', text: 'main heard: the assistant answers' }] };
  assert.deepEqual(await app.start({ ...request(revision), entry: 'main' }), answered);
  const ended = (id) => app.history('alice', id).find((event) => event.kind === 'ended').detail;
  assert.deepEqual(ended(runs.assistant), { status: 'ok', output: { sha256: hash(text('the assistant answers')) } });
  assert.deepEqual(ended(runs.main), { status: 'failed', output: { sha256: hash(answered) } });
  assert.ok(!everything(database).includes('assistant answers'));
});

test("a database an older celler kept is brought up to date once: what never went, a collected answer and a run's output become their hash", async (t) => {
  const database = memoryDatabase(t);
  // The tables as an older celler made them, before an approval knew when it changed or was collected.
  database.exec(`
    CREATE TABLE revisions(id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE runs(
      id TEXT PRIMARY KEY, body TEXT NOT NULL, grants TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running', created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE events(
      seq INTEGER PRIMARY KEY, run TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE approvals(
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, run TEXT NOT NULL, tool TEXT NOT NULL,
      args TEXT NOT NULL, packet TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      result TEXT, created_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  const run = (id) => ({ id, owner: 'alice', revision: 'r1', entry: 'root', workspace: 'folder', parent: null });
  database.prepare('INSERT INTO revisions VALUES(?,?,?)').run('r1', JSON.stringify(graph), 1);
  for (const id of ['run-1', 'run-2'])
    database
      .prepare("INSERT INTO runs VALUES(?,?,?,'ok',1)")
      .run(id, JSON.stringify(run(id)), JSON.stringify(['root', 'send']));
  const event = (kind, detail, at, runId = 'run-1') =>
    database
      .prepare('INSERT INTO events(run,kind,detail,at) VALUES(?,?,?,?)')
      .run(runId, kind, JSON.stringify(detail), at);
  const approval = (key, state, answer) => {
    const id = createHash('sha256')
      .update(JSON.stringify(['run-1', key]))
      .digest('hex');
    const message = `${key} content`;
    database
      .prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,100)')
      .run(id, 'alice', 'run-1', 'send', JSON.stringify({ message }), JSON.stringify(packet(message)), state, answer);
    return id;
  };
  const open = approval('open', 'pending', null);
  const declined = approval('declined', 'declined', null);
  event('declined', { id: declined, tool: 'send' }, 20);
  event('failed', { id: 'send', key: 'declined', code: 'DECLINED' }, 21);
  const failed = approval('failed', 'failed', null);
  event('delivery_failed', { id: failed, tool: 'send', outcome: 'failed' }, 30);
  // Sent and heard: it returned, or failed the checks an answer passes.
  const heard = approval('heard', 'sent', JSON.stringify(text('heard answer')));
  event('approved', { id: heard, tool: 'send' }, 40);
  event('returned', { id: 'send', key: 'heard', error: false }, 41);
  const checked = approval('checked', 'sent', JSON.stringify({ content: 'checked answer' }));
  event('approved', { id: checked, tool: 'send' }, 50);
  event('failed', { id: 'send', key: 'checked', code: 'INVALID_OUTPUT' }, 51);
  // Sent, but not heard: its call was withdrawn, or it failed before it was staged, as a full inbox refuses one.
  const withdrawn = approval('withdrawn', 'sent', JSON.stringify(text('withdrawn answer')));
  event('cancelled', { id: 'send', key: 'withdrawn' }, 60);
  event('approved', { id: withdrawn, tool: 'send' }, 61);
  const early = approval('early', 'sent', JSON.stringify(text('early answer')));
  event('failed', { id: 'send', key: 'early', code: 'LIMIT_EXCEEDED' }, 70);
  event('approved', { id: early, tool: 'send' }, 71);
  event('ended', { status: 'ok', output: text('the run answers') }, 90);
  event('ended', { status: 'cancelled', by: 'host' }, 91, 'run-2');

  const options = { database, adapters: new Map(), platform: { allowed: () => true } };
  const before = everything(database);
  const app = createApp(options);
  const once = everything(database);
  createApp(options);
  assert.notEqual(once, before);
  assert.equal(everything(database), once, 'opened again, nothing changes');

  const kept = (message) => [JSON.stringify({ message }), JSON.stringify(packet(message))];
  const cleared = (message) => [hashOf({ message }), hashOf(packet(message))];
  const columns = (stored) => [
    [stored.args, stored.packet],
    stored.state,
    stored.result,
    stored.changed_at,
    stored.collected_at,
  ];
  const answerOf = (answer) => JSON.stringify(text(answer));
  for (const [id, expected] of [
    [open, [kept('open content'), 'pending', null, 100, null]],
    [declined, [cleared('declined content'), 'declined', null, 20, null]],
    [failed, [cleared('failed content'), 'failed', null, 30, null]],
    [heard, [kept('heard content'), 'sent', hashOf(text('heard answer')), 40, 41]],
    [checked, [kept('checked content'), 'sent', hashOf({ content: 'checked answer' }), 50, 51]],
    [withdrawn, [kept('withdrawn content'), 'sent', answerOf('withdrawn answer'), 61, null]],
    [early, [kept('early content'), 'sent', answerOf('early answer'), 71, null]],
  ])
    assert.deepEqual(columns(row(database, id)), expected, id);
  for (const trace of ['declined content', 'failed content', 'heard answer', 'checked answer', 'the run answers'])
    assert.ok(!once.includes(trace), trace);

  // What a host reads gives what its types say.
  const review = app.human.review('alice', declined);
  assert.deepEqual(
    [review.state, review.changedAt, review.write],
    ['declined', 20, { sha256: hash(packet('declined content')) }],
  );
  assert.deepEqual(app.human.review('alice', heard).write, packet('heard content'));
  assert.deepEqual(
    app.human.inbox('alice').map((item) => item.id),
    [open],
  );
  assert.deepEqual(app.history('alice', 'run-1').at(-1), {
    seq: 12,
    at: 90,
    kind: 'ended',
    detail: { status: 'ok', output: { sha256: hash(text('the run answers')) } },
  });
  assert.deepEqual(app.history('alice', 'run-2')[0].detail, { status: 'cancelled', by: 'host' });

  // And a call made again collects what it may still collect, and nothing more.
  await withClient(
    (channel) => app.reconnect('alice', 'run-1', channel),
    async (client) => {
      await refused(use(client, 'heard', 'heard content'), /^Delivered; an earlier call collected its answer$/);
      assert.deepEqual(await use(client, 'withdrawn', 'withdrawn content'), text('withdrawn answer'));
      await refused(use(client, 'declined', 'declined content'), /declined/);
      await refused(use(client, 'declined', 'other content'), /different arguments/);
    },
  );
});
