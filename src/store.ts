import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { abortedWith, fail, NotSent, reasonOf } from './errors.js';
import { canonicalJson, hash, normalizeJson } from './json.js';
import type { appLimits } from './limits.js';
import {
  approvalId,
  cleared,
  hashOnly,
  openTables,
  packet,
  receipt,
  reviewOf,
  unsent,
  type ApprovalReview,
  type ApprovalSummary,
  type HistoryEvent,
  type RunEnd,
  type Write,
} from './tables.js';

export type Run = Readonly<{
  id: string;
  owner: string;
  revision: string;
  entry: string;
  workspace: string;
  parent: Readonly<{ run: string; tool: string; key: string }> | null;
}>;

export type RunStatus = 'running' | 'ok' | 'failed' | 'cancelled';
export type ApprovalState = 'pending' | 'started' | 'sent' | 'declined' | 'unknown' | 'failed';
export type EventKind =
  | 'started'
  | 'ended'
  | 'call'
  | 'returned'
  | 'failed'
  | 'cancelled'
  | 'denied'
  | 'approved'
  | 'declined'
  | 'delivery_failed'
  | 'reconciled';

// The approval lifecycle. Every change is a compare-and-set from the state on the left. A send that throws leaves it
// `unknown`, as it may have arrived, and so does a crash while `started`; one that never left (`NotSent`), `failed`.
// Only the host's reconciliation leaves `unknown`.
const lifecycle: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ['started', 'declined'],
  started: ['sent', 'unknown', 'failed'],
  unknown: ['sent', 'failed'],
  sent: [],
  declined: [],
  failed: [],
};

type Delivery = (write: Write, key: string, signal?: AbortSignal) => Promise<CallToolResult>;
type ResolvedDelivery = { verify?: (write: Write) => void | Promise<void>; send: Delivery };

export function freezeRun(run: Run): Run {
  return Object.freeze(run.parent ? { ...run, parent: Object.freeze({ ...run.parent }) } : { ...run });
}

/** Settles like `promise`, or rejects as soon as `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return abortedWith(signal);
  return new Promise<T>((resolve) => {
    const onAbort = () => resolve(abortedWith(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    const settled = (outcome: T | Promise<T>) => {
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    // Its value as it is, and its rejection as its own: the promise itself, rejected.
    promise.then(settled, () => settled(promise));
  });
}

export function openStore(db: DatabaseSync, limits: typeof appLimits) {
  openTables(db, limits.busyTimeoutMs);
  // A `started` delivery was cut off by a crash and may have arrived. Safe only because one service owns the database.
  db.prepare("UPDATE approvals SET state='unknown',changed_at=? WHERE state='started'").run(Date.now());

  const insertRevision = db.prepare('INSERT INTO revisions(id,body,created_at) VALUES(?,?,?)');
  const selectRevision = db.prepare('SELECT body FROM revisions WHERE id=?');
  const insertRun = db.prepare("INSERT INTO runs(id,body,grants,status,created_at) VALUES(?,?,?,'running',?)");
  const selectRun = db.prepare('SELECT body,grants FROM runs WHERE id=?');
  const selectRunStatus = db.prepare('SELECT status FROM runs WHERE id=?');
  const selectChildren = db.prepare("SELECT id FROM runs WHERE json_extract(body, '$.parent.run')=?");
  const updateRunStatus = db.prepare("UPDATE runs SET status=? WHERE id=? AND status='running'");
  const insertEvent = db.prepare('INSERT INTO events(run,kind,detail,at) VALUES(?,?,?,?)');
  const selectEvents = db.prepare('SELECT seq,at,kind,detail FROM events WHERE run=? ORDER BY seq');
  const selectReview = db.prepare(
    'SELECT a.id,a.run,a.tool,a.packet,a.state,a.created_at,a.changed_at,r.status AS run_status ' +
      'FROM approvals a JOIN runs r ON r.id=a.run WHERE a.owner=? AND a.id=?',
  );
  const selectInbox = db.prepare(
    'SELECT a.id,a.run,a.tool,a.state,a.created_at,r.status AS run_status ' +
      'FROM approvals a JOIN runs r ON r.id=a.run ' +
      "WHERE a.owner=? AND a.state IN ('pending','started','unknown') ORDER BY a.rowid",
  );
  const selectCall = db.prepare('SELECT tool,args,state FROM approvals WHERE owner=? AND id=?');
  // What waits in an owner's inbox: not a cancelled run's, which can only be declined and is never sent.
  const selectPendingUsage = db.prepare(
    'SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(a.packet AS BLOB))), 0) AS bytes ' +
      "FROM approvals a JOIN runs r ON r.id=a.run WHERE a.owner=? AND a.state='pending' AND r.status<>'cancelled'",
  );
  const insertApproval = db.prepare(
    'INSERT INTO approvals(id,owner,run,tool,args,packet,created_at,changed_at) VALUES(?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO NOTHING',
  );
  const selectProgress = db.prepare('SELECT state,result,collected_at FROM approvals WHERE owner=? AND id=?');
  // Whether a call of the run heard what a call key came to: it returned, or failed with it, rather than being withdrawn.
  const selectHeard = db.prepare(
    "SELECT 1 FROM events WHERE run=? AND kind IN ('returned','failed') AND json_extract(detail, '$.key')=? LIMIT 1",
  );
  const selectApprovalMeta = db.prepare('SELECT run,tool FROM approvals WHERE owner=? AND id=?');
  const selectContent = db.prepare('SELECT args,packet FROM approvals WHERE owner=? AND id=?');
  const updateState = db.prepare(
    'UPDATE approvals SET state=?,changed_at=?,args=coalesce(?,args),packet=coalesce(?,packet),' +
      'result=coalesce(?,result) WHERE owner=? AND id=? AND state=?',
  );
  const selectAnswer = db.prepare(
    "SELECT result FROM approvals WHERE owner=? AND id=? AND state='sent' AND collected_at IS NULL",
  );
  const updateCollected = db.prepare('UPDATE approvals SET result=?,collected_at=? WHERE owner=? AND id=?');
  const clearReason = db.prepare("UPDATE approvals SET result=NULL WHERE owner=? AND id=? AND state='failed'");

  // The calls of this process on each approval, each from before it stages or joins it until it ends: woken once a
  // change is saved, and handed its answer as it was kept if its host heard that first, as only its hash is kept then.
  type Listener = { wake?: (() => void) | undefined; handed?: { receipt: string | null } };
  const listeners = new Map<string, Set<Listener>>();
  function notify(id: string, handed?: Listener['handed']) {
    for (const listener of listeners.get(id) ?? []) {
      if (handed) listener.handed = handed;
      listener.wake?.();
    }
  }

  function record(run: string, kind: EventKind, detail: unknown) {
    insertEvent.run(run, kind, JSON.stringify(detail), Date.now());
  }
  /** A state change and its audit event are one: written together, or not at all. */
  function atomically(change: () => void) {
    db.exec('BEGIN IMMEDIATE');
    try {
      change();
      db.exec('COMMIT');
    } catch (error) {
      // SQLite may have rolled back already, as it does after some failures.
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  function loadRun(id: string) {
    const row = selectRun.get(id);
    if (!row) fail('NOT_FOUND', 'Unknown run');
    return {
      run: freezeRun(JSON.parse(String(row.body)) as Run),
      grants: JSON.parse(String(row.grants)) as string[],
    };
  }
  function runStatus(id: string): RunStatus | undefined {
    const row = selectRunStatus.get(id);
    return row ? (String(row.status) as RunStatus) : undefined;
  }
  function ended(id: string): boolean {
    const status = runStatus(id);
    return status !== undefined && status !== 'running';
  }
  /** Ends a running run once, with what its `ended` event keeps; a later end of the same run changes nothing. */
  function finishRun(id: string, end: RunEnd) {
    atomically(() => {
      if (updateRunStatus.run(end.status, id).changes === 1) record(id, 'ended', end);
    });
  }
  function review(owner: string, id: string): ApprovalReview {
    const row = selectReview.get(owner, id);
    if (!row) fail('NOT_FOUND', 'Unknown approval');
    return reviewOf(row, loadRun(String(row.run)).run);
  }
  /** A compare-and-set along the lifecycle. Its caller wakes the calls waiting on it (`notify`) once it is saved. */
  function transition(owner: string, id: string, from: ApprovalState, to: ApprovalState, result?: string | null) {
    if (!lifecycle[from].includes(to)) fail('INVALID_STATE', `Approval cannot move from ${from} to ${to}`);
    // What never went keeps no content: its arguments and its packet become their hash, in the same transaction.
    const content = unsent(to) ? selectContent.get(owner, id) : undefined;
    const args = content ? cleared(String(content.args)) : null;
    const write = content ? cleared(String(content.packet)) : null;
    if (updateState.run(to, Date.now(), args, write, result ?? null, owner, id, from).changes !== 1)
      fail('INVALID_STATE', 'Approval is not ' + from);
  }
  /** What a delivery came to, once its run or host heard it: its answer's hash and when; of why it failed, nothing. */
  function clearAnswer(owner: string, id: string) {
    const row = selectAnswer.get(owner, id);
    if (row) updateCollected.run(row.result === null ? null : cleared(String(row.result)), Date.now(), owner, id);
    clearReason.run(owner, id);
  }
  /** What a call of the run heard, with its event. What the approval it read came to, if it read one, is collected. */
  function heard(run: Run, kind: 'returned' | 'failed', detail: unknown, answer?: string) {
    atomically(() => {
      record(run.id, kind, detail);
      if (answer) clearAnswer(run.owner, answer);
    });
  }
  /**
   * The key of a call its client gave no key of its own (`celler/call-id`), from its tool and arguments (`base`): that
   * of the approval it joins, as a blind retry does, while that one is still open, or settled with no call of the run
   * having heard what it came to (the one made withdrew, its connection lost); once one has, the next of the same
   * call's, so the same call made again is made again, and a retry of that one joins it. A run that has ended collects
   * what the last one it staged came to.
   */
  function callKey(run: Run, base: string): string {
    const isHeard = (key: string) => {
      const state = selectProgress.get(run.owner, approvalId(run.id, key))?.state;
      const settled = state === 'sent' || state === 'declined' || state === 'failed';
      return settled && selectHeard.get(run.id, key) !== undefined;
    };
    const over = ended(run.id);
    let key = base;
    for (let n = 1; isHeard(key); n++) {
      const next = hash([base, n]);
      if (over && !selectProgress.get(run.owner, approvalId(run.id, next))) return key;
      key = next;
    }
    return key;
  }
  function existingApproval(run: Run, key: string, tool: string, args: unknown) {
    const id = approvalId(run.id, key);
    const row = selectCall.get(run.owner, id);
    if (!row) return undefined;
    // What never went keeps its arguments' hash alone, and a retry's arguments must still match it.
    const kept: unknown = JSON.parse(String(row.args));
    const keptHash = unsent(String(row.state) as ApprovalState) ? hashOnly.parse(kept).sha256 : hash(kept);
    if (row.tool !== tool || keptHash !== hash(normalizeJson(args))) {
      fail('KEY_CONFLICT', 'Call key reused with different arguments');
    }
    return id;
  }

  // Concurrent calls that share (run, call key) share one prepare().
  const staging = new Map<
    string,
    {
      tool: string;
      args: string;
      waiters: number;
      controller: AbortController;
      promise: Promise<string>;
    }
  >();

  // Budgets are per owner, because the inbox they protect is one person's.
  function checkPendingQuota(owner: string, extraBytes: number) {
    const usage = selectPendingUsage.get(owner);
    const count = Number(usage?.count ?? 0);
    const bytes = Number(usage?.bytes ?? 0);
    if (count >= limits.maxPendingApprovals) fail('LIMIT_EXCEEDED', 'Pending approval limit reached for this inbox');
    if (bytes + extraBytes > limits.maxPendingBytes) fail('LIMIT_EXCEEDED', 'Pending approval byte budget exceeded');
  }

  async function stage(
    run: Run,
    key: string,
    tool: string,
    args: object,
    prepare: (signal: AbortSignal) => Promise<Write>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const normalized = normalizeJson(args);
    const argsText = canonicalJson(normalized);
    const previous = existingApproval(run, key, tool, normalized);
    if (previous) return previous;

    const id = approvalId(run.id, key);
    let entry = staging.get(id);
    if (entry) {
      if (entry.tool !== tool || entry.args !== argsText)
        fail('KEY_CONFLICT', 'Call key reused with different arguments');
      entry.waiters++;
    } else {
      checkPendingQuota(run.owner, 0);
      const controller = new AbortController();
      const created = {
        tool,
        args: argsText,
        waiters: 1,
        controller,
        promise: Promise.resolve().then(async () => {
          const frozen = JSON.stringify(packet.parse(await prepare(controller.signal)));
          const bytes = Buffer.byteLength(frozen);
          if (bytes > limits.inlineLimit) fail('LIMIT_EXCEEDED', 'Approval exceeds inline limit');
          if (controller.signal.aborted) fail('RUN_ENDED', 'Approval staging aborted');
          checkPendingQuota(run.owner, bytes);
          const now = Date.now();
          insertApproval.run(id, run.owner, run.id, tool, JSON.stringify(normalized), frozen, now, now);
          return existingApproval(run, key, tool, normalized)!;
        }),
      };
      const forget = () => {
        if (staging.get(id) === created) staging.delete(id);
      };
      created.promise.then(forget, forget); // also keeps an abandoned rejection from going unhandled
      staging.set(id, created);
      entry = created;
    }

    try {
      return await raceAbort(entry.promise, signal);
    } finally {
      // The last caller to leave aborts prepare() and frees the key, so an immediate retry starts afresh.
      if (--entry.waiters === 0) {
        entry.controller.abort();
        if (staging.get(id) === entry) staging.delete(id);
      }
    }
  }

  async function result(owner: string, id: string, signal: AbortSignal, listener: Listener): Promise<CallToolResult> {
    for (;;) {
      signal.throwIfAborted();
      const row = selectProgress.get(owner, id);
      if (!row) fail('NOT_FOUND', 'Unknown approval');
      if (row.state === 'sent') {
        if (listener.handed) return JSON.parse(String(listener.handed.receipt));
        if (row.collected_at !== null) fail('INVALID_STATE', 'Delivered; an earlier call collected its answer');
        return JSON.parse(String(row.result));
      }
      if (row.state === 'declined') fail('DECLINED', 'The person declined this action');
      if (row.state === 'unknown') fail('DELIVERY_FAILED', 'Delivery outcome unknown until the host reconciles it');
      // A failed one's result is the reason its adapter gave its run, if it gave one, until a call of the run heard it.
      if (row.state === 'failed') {
        const reason = row.result === null ? '' : ': ' + (JSON.parse(String(row.result)) as string);
        fail('DELIVERY_FAILED', 'Delivery failed' + reason);
      }

      await new Promise<void>((resolve) => {
        const onAbort = () => {
          listener.wake = undefined;
          resolve(abortedWith(signal));
        };
        listener.wake = () => {
          listener.wake = undefined;
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
  /** A call's hearing of the approval its key names: from before it stages or joins it, until it ends. */
  function hearing(run: Run, key: string) {
    const id = approvalId(run.id, key);
    const listener: Listener = {};
    let set = listeners.get(id);
    if (!set) listeners.set(id, (set = new Set()));
    set.add(listener);
    return {
      result: (signal: AbortSignal) => result(run.owner, id, signal, listener),
      end() {
        set.delete(listener);
        if (set.size === 0) listeners.delete(id);
      },
    };
  }

  /** Sends an approved packet once, and gives what it answered with the run and tool it was made for. */
  async function approve(
    owner: string,
    id: string,
    resolve: (run: Run, tool: string) => ResolvedDelivery,
    signal?: AbortSignal,
  ): Promise<{ value: CallToolResult; run: Run; tool: string }> {
    const item = review(owner, id);
    if (item.state !== 'pending') fail('INVALID_STATE', 'Approval is not pending');
    if (item.runStatus === 'cancelled') fail('RUN_ENDED', 'Run was cancelled');
    const { verify } = resolve(item.run, item.tool);
    if (verify) await verify(item.write);
    // What changed while verify ran counts: the run, the policy and the caller are asked again, and nothing waits
    // from here to the compare-and-set.
    if (runStatus(item.run.id) === 'cancelled') fail('RUN_ENDED', 'Run was cancelled');
    const { send } = resolve(item.run, item.tool);
    signal?.throwIfAborted();
    transition(owner, id, 'pending', 'started');
    let value: CallToolResult;
    try {
      // Send the snapshot the person saw, including the original attachment bytes.
      value = await send(item.write, id, signal);
    } catch (error) {
      // One its adapter says never left has failed; any other may have arrived, and waits for the host's word.
      const never = error instanceof NotSent;
      const reason = never ? reasonOf(error, limits.reasonChars) : undefined;
      atomically(() => {
        transition(owner, id, 'started', never ? 'failed' : 'unknown', reason && JSON.stringify(reason));
        record(item.run.id, 'delivery_failed', { id, tool: item.tool, ...(never ? { outcome: 'failed' } : {}) });
      });
      notify(id);
      throw error;
    }
    // Saved as sent before anything checks the response. Its host hears the answer as this returns, checked or not, as
    // a call of its run would: only its hash is kept from then on, and the calls on it in this process are handed it.
    const handed = { receipt: receipt(value) };
    atomically(() => {
      transition(owner, id, 'started', 'sent', handed.receipt);
      record(item.run.id, 'approved', { id, tool: item.tool });
      clearAnswer(owner, id);
    });
    notify(id, handed);
    return { value, run: item.run, tool: item.tool };
  }

  function decline(owner: string, id: string) {
    atomically(() => {
      const meta = selectApprovalMeta.get(owner, id);
      transition(owner, id, 'pending', 'declined');
      if (meta) record(String(meta.run), 'declined', { id, tool: String(meta.tool) });
    });
    notify(id);
  }

  function reconcile(owner: string, id: string, outcome: 'sent' | 'failed', value?: CallToolResult) {
    atomically(() => {
      const meta = selectApprovalMeta.get(owner, id);
      transition(owner, id, 'unknown', outcome, value && JSON.stringify(value));
      if (meta) record(String(meta.run), 'reconciled', { id, tool: String(meta.tool), outcome });
    });
    notify(id);
  }

  function history(owner: string, id: string): HistoryEvent[] {
    if (loadRun(id).run.owner !== owner) fail('NOT_FOUND', 'Unknown run');
    return selectEvents.all(id).map(
      (row) =>
        ({
          seq: Number(row.seq),
          at: Number(row.at),
          kind: String(row.kind) as EventKind,
          detail: JSON.parse(String(row.detail)) as unknown,
        }) as HistoryEvent,
    );
  }

  function inbox(owner: string): ApprovalSummary[] {
    return selectInbox.all(owner).map((row) => ({
      id: String(row.id),
      run: String(row.run),
      tool: String(row.tool),
      state: String(row.state) as ApprovalSummary['state'],
      runStatus: String(row.run_status) as RunStatus,
      createdAt: Number(row.created_at),
    }));
  }

  return {
    saveRevision(config: unknown) {
      const id = randomUUID();
      insertRevision.run(id, JSON.stringify(config), Date.now());
      return id;
    },
    revision(id: string): unknown {
      const row = selectRevision.get(id);
      if (!row) fail('NOT_FOUND', 'Unknown revision');
      return JSON.parse(String(row.body));
    },
    /** Saves a run with its grants and its `started` event. */
    saveRun(run: Run, grants: string[], detail: unknown) {
      atomically(() => {
        insertRun.run(run.id, JSON.stringify(run), JSON.stringify(grants), Date.now());
        record(run.id, 'started', detail);
      });
    },
    history,
    inbox,
    /** The runs a run delegated, whatever process started them. */
    children: (id: string) => selectChildren.all(id).map((row) => String(row.id)),
    decline,
    reconcile,
    ended,
    finishRun,
    loadRun,
    record,
    heard,
    /** What a delivery came to, collected by a call that records no event: one of a run that has ended. */
    collect: (owner: string, id: string) => atomically(() => clearAnswer(owner, id)),
    callKey,
    existingApproval,
    stage,
    hearing,
    review,
    approve,
  };
}

export type Store = ReturnType<typeof openStore>;
