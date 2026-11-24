import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { hashed, type Hashed } from './json.js';
import type { ApprovalState, EventKind, Run, RunStatus } from './store.js';

// celler's tables in SQLite, what it keeps in them, and its records as a host reads them. It keeps only what it must, to
// do its job and to answer for what left: a packet that was sent stays exactly as it was approved, and of what never
// went, of a delivery's answer once its run has collected it and of a run's output, only a hash: `{"sha256":"…"}`.

/** A packet as its adapter prepares it, the person approves it and its `send` delivers it. */
export const packet = z.strictObject({
  account: z.string(),
  destination: z.string(),
  operation: z.string(),
  content: z.json(),
  files: z.array(z.strictObject({ name: z.string(), mediaType: z.string(), base64: z.base64() })),
});
export type Write = z.output<typeof packet>;
/** What celler keeps of a value it doesn't keep: the hash of its canonical JSON. */
export const hashOnly = z.strictObject({ sha256: z.string() });

/** The states of an approval that never went: it keeps its state, when it changed, and its content's hash alone. */
const unsentStates = ['declined', 'failed'] as const satisfies readonly ApprovalState[];
type UnsentState = (typeof unsentStates)[number];

export function unsent(state: ApprovalState): state is UnsentState {
  return (unsentStates as readonly ApprovalState[]).includes(state);
}

/** An approval that waits for the person, or for the host's word: one the inbox lists. */
export type ApprovalSummary = {
  id: string;
  run: string;
  tool: string;
  state: 'pending' | 'started' | 'unknown';
  runStatus: RunStatus;
  createdAt: number;
};
type Reviewed = { id: string; run: Run; runStatus: RunStatus; tool: string };
/**
 * An approval as the person reviews it: while it may go, has gone or may have, with its packet exactly as it was
 * frozen; once it never went, declined or failed, with when that was and its packet's hash alone.
 */
export type ApprovalReview =
  | (Reviewed & { state: Exclude<ApprovalState, UnsentState>; createdAt: number; write: Write })
  | (Reviewed & { state: UnsentState; createdAt: number; changedAt: number; write: Hashed });
/** How a run ended, as its `ended` event keeps it: its status, and its output's hash, or that the host ended it. */
export type RunEnd =
  | { status: 'ok' | 'failed'; output: Hashed }
  | { status: 'failed' | 'cancelled' }
  | { status: 'cancelled'; by: 'host' };
export type HistoryEvent = { seq: number; at: number } & (
  { kind: 'ended'; detail: RunEnd } | { kind: Exclude<EventKind, 'ended'>; detail: unknown }
);

/** JSON text as celler keeps what it doesn't keep: its value's hash. */
export function cleared(text: string): string {
  return JSON.stringify(hashed(JSON.parse(text)));
}

/** An approval's id: one for each call key of a run. */
export function approvalId(runId: string, key: string): string {
  return createHash('sha256')
    .update(JSON.stringify([runId, key]))
    .digest('hex');
}

/** Makes celler's tables in a new database, and brings an older celler's up to date. */
export function openTables(db: DatabaseSync, busyTimeoutMs: number) {
  // synchronous=FULL makes every commit survive power loss. The pending→started commit must be durable before an
  // external send, or a reboot could offer the same approval again.
  db.exec(`
    PRAGMA busy_timeout = ${busyTimeoutMs};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS revisions(
      id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS runs(
      id TEXT PRIMARY KEY, body TEXT NOT NULL, grants TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running', created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS events(
      seq INTEGER PRIMARY KEY, run TEXT NOT NULL, kind TEXT NOT NULL,
      detail TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS run_parents ON runs(json_extract(body, '$.parent.run'));
    CREATE INDEX IF NOT EXISTS run_events ON events(run, seq);
    CREATE TABLE IF NOT EXISTS approvals(
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, run TEXT NOT NULL, tool TEXT NOT NULL,
      args TEXT NOT NULL, packet TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      result TEXT, created_at INTEGER NOT NULL DEFAULT 0,
      changed_at INTEGER NOT NULL DEFAULT 0, collected_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS inbox ON approvals(owner, state);
    CREATE INDEX IF NOT EXISTS run_approvals ON approvals(run, state);
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('approvals') WHERE name='changed_at'").get()) migrate(db);
}

/**
 * Brings a database an older celler kept up to date, once and all in one transaction: each approval gains when its
 * state last changed and when its run collected its answer, and what celler no longer keeps becomes its hash. The
 * columns it adds mark it done, so opened again, nothing changes.
 */
function migrate(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE approvals ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE approvals ADD COLUMN collected_at INTEGER;
    `);
    // Its state last changed at its last event, or, with none, as it was made.
    db.prepare(
      'UPDATE approvals SET changed_at=coalesce((SELECT max(e.at) FROM events e WHERE e.run=approvals.run ' +
        "AND e.kind IN ('approved','declined','delivery_failed','reconciled') AND json_extract(e.detail,'$.id')=approvals.id), " +
        'created_at)',
    ).run();
    clearUnsent(db);
    clearCollected(db);
    clearOutputs(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** What never went: its arguments and its packet become their hash. */
function clearUnsent(db: DatabaseSync) {
  const ids = db.prepare('SELECT id FROM approvals WHERE state IN (SELECT value FROM json_each(?))');
  const content = db.prepare('SELECT args,packet FROM approvals WHERE id=?');
  const clear = db.prepare('UPDATE approvals SET args=?,packet=? WHERE id=?');
  for (const { id } of ids.all(JSON.stringify(unsentStates))) {
    const row = content.get(id)!;
    clear.run(cleared(String(row.args)), cleared(String(row.packet)), id);
  }
}

/**
 * A delivery's answer its run has collected: after it was sent, a call of the run with its tool and key heard it, as
 * it returned or as it failed the checks an answer passes. Its answer becomes its hash.
 */
function clearCollected(db: DatabaseSync) {
  const sent = db.prepare("SELECT id,run,tool FROM approvals WHERE state='sent'");
  const sentAt = db.prepare(
    "SELECT coalesce(max(seq),0) AS seq FROM events WHERE run=? AND kind IN ('approved','reconciled') " +
      "AND json_extract(detail,'$.id')=?",
  );
  const hearings = db.prepare(
    "SELECT at,json_extract(detail,'$.key') AS key FROM events WHERE run=? AND seq>? AND json_extract(detail,'$.id')=? " +
      "AND (kind='returned' OR (kind='failed' AND json_extract(detail,'$.code') IN ('INVALID_OUTPUT','LIMIT_EXCEEDED'))) " +
      'ORDER BY seq',
  );
  const answer = db.prepare('SELECT result FROM approvals WHERE id=?');
  const collect = db.prepare('UPDATE approvals SET result=?,collected_at=? WHERE id=?');
  for (const row of sent.all()) {
    const id = String(row.id);
    const run = String(row.run);
    const after = sentAt.get(run, id)!.seq;
    const heard = hearings.all(run, after, row.tool).find((event) => approvalId(run, String(event.key)) === id);
    if (!heard) continue;
    const { result } = answer.get(id)!;
    collect.run(result === null ? null : cleared(String(result)), heard.at, id);
  }
}

/** A run's output, in its `ended` event, becomes its hash. */
function clearOutputs(db: DatabaseSync) {
  const ended = db.prepare("SELECT seq FROM events WHERE kind='ended' AND json_type(detail,'$.output') IS NOT NULL");
  const detail = db.prepare('SELECT detail FROM events WHERE seq=?');
  const clear = db.prepare('UPDATE events SET detail=? WHERE seq=?');
  for (const { seq } of ended.all()) {
    const { output, ...end } = JSON.parse(String(detail.get(seq)!.detail)) as { output: unknown };
    clear.run(JSON.stringify({ ...end, output: hashed(output) }), seq);
  }
}
