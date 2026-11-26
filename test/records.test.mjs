import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp, isHashed, NotSent } from 'celler';
import { hash } from '../dist/json.js';
import { cell, memoryDatabase, refused, request, text, tool, until, withClient } from './support.mjs';
import { graph, packet, pending, use } from './support-approval.mjs';

// celler keeps only what it must: a sent packet exactly as approved; of what never went, its state, when it changed and
// its hash; a delivery's answer until its run or its host has heard it, then its hash, and why one failed until its run
// has; a run's output only as its hash.

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
    assert.ok(isHashed(review));
  }
  const stored = everything(database);
  for (const message of ['declined content', 'never reached', 'maybe reached', 'other content'])
    for (const trace of [message, Buffer.from(message).toString('base64')]) assert.ok(!stored.includes(trace), trace);

  // A sent one keeps its arguments, and its packet exactly as it was approved and sent.
  const sent = calls.at(-1);
  assert.ok(!isHashed(app.human.review('alice', sent.id)));
  assert.deepEqual(app.human.review('alice', sent.id).write, packet('sent content'));
  const kept = row(database, sent.id);
  assert.deepEqual(
    [kept.args, kept.packet],
    [JSON.stringify({ message: 'sent content' }), JSON.stringify(packet('sent content'))],
  );
});

test("a host's code tells a review with its packet from one with only its hash by isHashed, through the package's own types", () => {
  const tsc = fileURLToPath(new URL('bin/tsc', import.meta.resolve('typescript/package.json')));
  const host = fileURLToPath(new URL('fixtures/review-types.ts', import.meta.url));
  const flags = [
    '--ignoreConfig',
    '--noEmit',
    '--strict',
    '--module',
    'nodenext',
    '--target',
    'es2023',
    '--skipLibCheck',
  ];
  const checked = spawnSync(process.execPath, [tsc, ...flags, host], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test("an answer the host's approve returns, once its run's call has stopped waiting, is heard: only its hash is kept, and the same call made again hears that it was delivered", async (t) => {
  const database = memoryDatabase(t);
  let runId;
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
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          runId = spec.id;
          // Its turn ends while its call waits for the person: the call stops waiting, and the run ends.
          use(client, 'k', 'report').catch(() => {});
          await pending(app);
          return text('turn over');
        }),
    },
  });
  assert.deepEqual(await app.start(request(app.publish(graph))), text('turn over'));
  await until(() => app.history('alice', runId).some((event) => event.kind === 'cancelled'));
  // The person approves later: the host's approve makes the send and hears its answer, and only its hash is kept.
  const id = await pending(app);
  assert.deepEqual(await app.human.approve('alice', id), text('the answer'));
  const kept = row(database, id);
  assert.equal(kept.result, hashOf(text('the answer')));
  assert.ok(kept.collected_at > 0);
  assert.ok(!everything(database).includes('the answer'));
  // Its run, connected again, makes the same call with its key: it hears only that it was delivered, and nothing is sent.
  await withClient(
    (channel) => app.reconnect('alice', runId, channel),
    async (client) => {
      await refused(use(client, 'k', 'report'), /^Delivered; an earlier call collected its answer$/);
    },
  );
  assert.deepEqual(app.human.review('alice', id).write, packet('report'));
});

test('the calls of its run still waiting as the host approves hear the answer the host hears, and then only its hash is kept', async (t) => {
  const database = memoryDatabase(t);
  let delivered;
  const delivering = new Promise((resolve) => {
    delivered = resolve;
  });
  const app = createApp({
    database,
    adapters: new Map([
      [
        'delivery',
        {
          prepare: async (_run, args) => packet(String(args.message)),
          send: async () => {
            await delivering;
            return text('the answer');
          },
        },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          const first = use(client, 'k', 'report');
          const id = await pending(app);
          const approved = app.human.approve('alice', id);
          // A retry made while it is being sent joins the first, and waits with it.
          await until(() => app.human.review('alice', id).state === 'started');
          const retry = use(client, 'k', 'report');
          await until(() => app.history('alice', spec.id).filter((event) => event.kind === 'call').length === 2);
          delivered();
          // The host hears the answer as its approve returns, and from then on only its hash is kept; the calls still
          // waiting are handed it, each once.
          assert.deepEqual(await approved, text('the answer'));
          assert.equal(row(database, id).result, hashOf(text('the answer')));
          assert.deepEqual(await first, text('the answer'));
          assert.deepEqual(await retry, text('the answer'));
          assert.ok(row(database, id).collected_at > 0);
          // The same call made again hears only that it was delivered: nothing is sent again.
          await refused(use(client, 'k', 'report'), /^Delivered; an earlier call collected its answer$/);
          return text('done');
        }),
    },
  });
  assert.deepEqual(await app.start(request(app.publish(graph))), text('done'));
  assert.ok(!everything(database).includes('the answer'));
});

test('why a delivery failed, as its adapter told its run, is kept until the run has heard it, then not at all; a retry before that hears the same, as does its run once it has ended', async (t) => {
  const database = memoryDatabase(t);
  const reason = 'The mail service refused the address.';
  const failed = (words) => ({ isError: true, content: [{ type: 'text', text: words }] });
  let runId;
  const app = createApp({
    database,
    adapters: new Map([
      [
        'delivery',
        {
          prepare: async (_run, args) => packet(String(args.message)),
          send: async () => {
            throw new NotSent('SMTP 550 5.1.1 user unknown', { reason });
          },
        },
      ],
    ]),
    platform: {
      allowed: () => true,
      launch: (spec, connect) =>
        withClient(connect, async (client) => {
          runId = spec.id;
          const call = (timeout) =>
            client.callTool(
              { name: 'send', arguments: { message: 'report' }, _meta: { 'celler/call-id': 'k' } },
              undefined,
              { timeout },
            );
          // Its agent's own limit ends the call while the person decides: why it failed, once it has, reaches no call.
          const first = call(300);
          const id = await pending(app);
          await assert.rejects(first, /timed out/);
          await until(() => app.history('alice', spec.id).some((event) => event.kind === 'cancelled'));
          await assert.rejects(app.human.approve('alice', id), NotSent);
          assert.equal(row(database, id).result, JSON.stringify(reason));
          // A retry collects it, as the first would have; from then on it is kept no more.
          assert.deepEqual(await call(5000), failed(`Delivery failed: ${reason}`));
          assert.equal(row(database, id).result, null);
          // The same call made again with its key hears only that it failed.
          assert.deepEqual(await call(5000), failed('Delivery failed'));
          // One left for the person as the run ends.
          use(client, 'later', 'later').catch(() => {});
          await pending(app);
          return text('done');
        }),
    },
  });
  assert.deepEqual(await app.start(request(app.publish(graph))), text('done'));
  const later = await pending(app);
  await assert.rejects(app.human.approve('alice', later), NotSent);
  // Its run, connected again once it has ended, collects why it failed, once.
  await withClient(
    (channel) => app.reconnect('alice', runId, channel),
    async (client) => {
      assert.deepEqual(await use(client, 'later', 'later'), failed(`Delivery failed: ${reason}`));
      assert.equal(row(database, later).result, null);
      assert.deepEqual(await use(client, 'later', 'later'), failed('Delivery failed'));
    },
  );
  const stored = everything(database);
  for (const trace of [reason, 'SMTP']) assert.ok(!stored.includes(trace), trace);
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

test("a database an older celler kept is brought up to date once: what never went, an answer its run or its host heard and a run's output become their hash", async (t) => {
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
  // Heard by its host alone, as its approve returned it: its call was withdrawn, or it failed before it was staged, as a
  // full inbox refuses one.
  const withdrawn = approval('withdrawn', 'sent', JSON.stringify(text('withdrawn answer')));
  event('cancelled', { id: 'send', key: 'withdrawn' }, 60);
  event('approved', { id: withdrawn, tool: 'send' }, 61);
  const early = approval('early', 'sent', JSON.stringify(text('early answer')));
  event('failed', { id: 'send', key: 'early', code: 'LIMIT_EXCEEDED' }, 70);
  event('approved', { id: early, tool: 'send' }, 71);
  // Reconciled as sent with an answer the host gave, which no call of its run has heard yet.
  const reconciled = approval('reconciled', 'sent', JSON.stringify(text('reconciled answer')));
  event('delivery_failed', { id: reconciled, tool: 'send' }, 80);
  event('reconciled', { id: reconciled, tool: 'send', outcome: 'sent' }, 81);
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
    [withdrawn, [kept('withdrawn content'), 'sent', hashOf(text('withdrawn answer')), 61, 61]],
    [early, [kept('early content'), 'sent', hashOf(text('early answer')), 71, 71]],
    [reconciled, [kept('reconciled content'), 'sent', answerOf('reconciled answer'), 81, null]],
  ])
    assert.deepEqual(columns(row(database, id)), expected, id);
  const traces = ['declined content', 'failed content', 'heard answer', 'checked answer', 'withdrawn answer'];
  for (const trace of [...traces, 'early answer', 'the run answers']) assert.ok(!once.includes(trace), trace);

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
    seq: 14,
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
      await refused(use(client, 'withdrawn', 'withdrawn content'), /^Delivered; an earlier call collected its answer$/);
      assert.deepEqual(await use(client, 'reconciled', 'reconciled content'), text('reconciled answer'));
      await refused(use(client, 'declined', 'declined content'), /declined/);
      await refused(use(client, 'declined', 'other content'), /different arguments/);
    },
  );
});

test("a database celler 0.3.0 kept is brought up to date once: an answer its host's approve returned, which no call of its run heard, becomes its hash", async (t) => {
  const database = memoryDatabase(t);
  const options = { database, adapters: new Map(), platform: { allowed: () => true } };
  // celler 0.3.0's tables are these, with no version marked, and it kept whole an answer only the host had heard.
  createApp(options);
  database.exec('PRAGMA user_version = 0');
  const run = { id: 'run-1', owner: 'alice', revision: 'r1', entry: 'root', workspace: 'folder', parent: null };
  database.prepare('INSERT INTO revisions VALUES(?,?,?)').run('r1', JSON.stringify(graph), 1);
  database.prepare("INSERT INTO runs VALUES('run-1',?,?,'ok',1)").run(JSON.stringify(run), '["root","send"]');
  const sent = (key, answer, kind) => {
    const id = createHash('sha256')
      .update(JSON.stringify(['run-1', key]))
      .digest('hex');
    const message = `${key} content`;
    database
      .prepare(
        'INSERT INTO approvals(id,owner,run,tool,args,packet,state,result,created_at,changed_at) ' +
          "VALUES(?,'alice','run-1','send',?,?,'sent',?,1,2)",
      )
      .run(id, JSON.stringify({ message }), JSON.stringify(packet(message)), JSON.stringify(text(answer)));
    database
      .prepare("INSERT INTO events(run,kind,detail,at) VALUES('run-1',?,?,2)")
      .run(kind, JSON.stringify({ id, tool: 'send', ...(kind === 'reconciled' ? { outcome: 'sent' } : {}) }));
    return id;
  };
  const approved = sent('approved', 'the answer', 'approved');
  const reconciled = sent('reconciled', 'the reconciled answer', 'reconciled');

  const app = createApp(options);
  const once = everything(database);
  createApp(options);
  assert.equal(everything(database), once, 'opened again, nothing changes');
  const answer = (id) => [row(database, id).result, row(database, id).collected_at];
  assert.deepEqual(answer(approved), [hashOf(text('the answer')), 2]);
  assert.deepEqual(answer(reconciled), [JSON.stringify(text('the reconciled answer')), null]);
  await withClient(
    (channel) => app.reconnect('alice', 'run-1', channel),
    async (client) => {
      await refused(use(client, 'approved', 'approved content'), /^Delivered; an earlier call collected its answer$/);
      assert.deepEqual(await use(client, 'reconciled', 'reconciled content'), text('the reconciled answer'));
    },
  );
});
