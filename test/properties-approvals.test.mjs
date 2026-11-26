// Properties of an approval's lifecycle (store.ts), over what a host does to a run's approvals in any order fast-check
// makes: each moves only along the lifecycle, a change from any other state is refused and changes nothing, and what
// never went keeps only its hash.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { CellerError, createApp, isHashed, NotSent } from 'celler';
import { memoryDatabase, request, text, until, withClient } from './support.mjs';
import { graph, packet, use } from './support-approval.mjs';

/** What each thing a host does makes of an approval in each state; one not here is refused (`INVALID_STATE`). */
const LIFECYCLE = {
  pending: { send: 'sent', 'send, never left': 'failed', 'send, lost': 'unknown', decline: 'declined' },
  unknown: { 'reconcile as sent': 'sent', 'reconcile as failed': 'failed' },
};
const ACTS = [...new Set(Object.values(LIFECYCLE).flatMap(Object.keys))];

/** An app with a run that left `count` approvals pending for alice, and how its adapter's next send goes. */
async function staged(t, count) {
  let next = 'send';
  const delivery = {
    prepare: async (_run, args) => packet(String(args.message)),
    send: async () => {
      if (next === 'send, never left') throw new NotSent('refused', { reason: 'refused' });
      if (next === 'send, lost') throw new Error('connection lost');
      return text('delivered');
    },
  };
  const app = createApp({
    database: memoryDatabase(t),
    adapters: new Map([['delivery', delivery]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          // Its turn ends while its calls wait: they stop waiting, and their approvals stay for the person.
          for (let i = 0; i < count; i++) use(client, `call-${i}`, `message ${i}`).catch(() => {});
          await until(() => app.human.inbox('alice').length === count);
          return text('turn over');
        }),
    },
  });
  await app.start(request(app.publish(graph)));
  const ids = app.human.inbox('alice').map((item) => item.id);
  return { app, ids, sendAs: (act) => (next = act) };
}

/** What the host does: its promise, or what it threw at once. */
async function act(app, id, what) {
  switch (what) {
    case 'send':
    case 'send, never left':
    case 'send, lost':
      return app.human.approve('alice', id);
    case 'decline':
      return app.human.decline('alice', id);
    case 'reconcile as sent':
      return app.human.reconcile('alice', id, 'sent');
    case 'reconcile as failed':
      return app.human.reconcile('alice', id, 'failed');
    default:
      throw new Error('Unknown act: ' + what);
  }
}

test('an approval moves only along its lifecycle, whatever a host does in whatever order, and what never went keeps its hash alone', async (t) => {
  const steps = fc.array(fc.record({ target: fc.nat(), what: fc.constantFrom(...ACTS) }), { maxLength: 10 });
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 3 }), steps, async (count, plan) => {
      const { app, ids, sendAs } = await staged(t, count);
      const states = new Map(ids.map((id) => [id, 'pending']));
      for (const { target, what } of plan) {
        const id = ids[target % ids.length];
        const before = states.get(id);
        const after = LIFECYCLE[before]?.[what];
        sendAs(what);
        const done = (async () => act(app, id, what))();
        if (after === undefined) {
          await assert.rejects(done, (error) => error instanceof CellerError && error.code === 'INVALID_STATE');
        } else if (what === 'send, never left') {
          await assert.rejects(done, NotSent);
        } else if (what === 'send, lost') {
          await assert.rejects(done, /connection lost/);
        } else {
          await done;
        }
        states.set(id, after ?? before);
        for (const [each, state] of states) {
          const review = app.human.review('alice', each);
          assert.equal(review.state, state, `${what} on ${before}`);
          // Invariant 8: of what never went, its state, when and a hash; a packet only of what went or may yet.
          assert.equal(isHashed(review), state === 'declined' || state === 'failed');
        }
      }
      // The inbox holds what still waits for the person or the host: pending, and unknown until reconciled.
      const byId = ([a], [b]) => a.localeCompare(b);
      const waiting = [...states].filter(([, state]) => state === 'pending' || state === 'unknown');
      const inbox = app.human.inbox('alice').map((item) => [item.id, item.state]);
      assert.deepEqual(inbox.sort(byId), waiting.sort(byId));
    }),
    { numRuns: 40 },
  );
});
