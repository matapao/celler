import { createHash, randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { fail } from "./errors.js"
import { canonicalJson, hash, normalizeJson } from "./json.js"

export type Run = Readonly<{
  id: string
  owner: string
  revision: string
  entry: string
  workspace: string
  parent: Readonly<{ run: string; tool: string; key: string }> | null
}>

export type RunStatus = "running" | "ok" | "failed" | "cancelled"
export type ApprovalState = "pending" | "started" | "sent" | "declined" | "unknown" | "failed"
export type EventKind =
  | "started" | "ended" | "call" | "returned" | "failed" | "cancelled" | "denied"
  | "approved" | "declined" | "delivery_failed" | "reconciled"

// The approval lifecycle. Every change is a compare-and-set from the state on the left. A crash while `started`
// also leads to `unknown`, as the send may have arrived, and only the host's reconciliation leaves `unknown`.
const lifecycle: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ["started", "declined"],
  started: ["sent", "unknown"],
  unknown: ["sent", "failed"],
  sent: [],
  declined: [],
  failed: [],
}

const packet = z.strictObject({
  account: z.string(),
  destination: z.string(),
  operation: z.string(),
  content: z.json(),
  files: z.array(z.strictObject({ name: z.string(), mediaType: z.string(), base64: z.base64() })),
})

export type Write = z.output<typeof packet>
export type ApprovalSummary = {
  id: string; run: string; tool: string; state: ApprovalState; runStatus: RunStatus; createdAt: number
}
export type ApprovalReview = {
  id: string; run: Run; runStatus: RunStatus; tool: string; state: ApprovalState; createdAt: number; write: Write
}
export type HistoryEvent = { seq: number; at: number; kind: EventKind; detail: unknown }
type Delivery = (write: Write, key: string, signal?: AbortSignal) => Promise<CallToolResult>
type ResolvedDelivery = { verify?: (write: Write) => void | Promise<void>; send: Delivery }
type StoreLimits = { inlineLimit: number; maxPendingApprovals: number; maxPendingBytes: number; busyTimeoutMs: number }

export function freezeRun(run: Run): Run {
  return Object.freeze(run.parent ? { ...run, parent: Object.freeze({ ...run.parent }) } : { ...run })
}

/** Settles like `promise`, or rejects as soon as `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value) },
      err => { signal.removeEventListener("abort", onAbort); reject(err) },
    )
  })
}

export function openStore(db: DatabaseSync, limits: StoreLimits) {
  // synchronous=FULL makes every commit survive power loss. The pending→started commit must be durable before an
  // external send, or a reboot could offer the same approval again.
  db.exec(`
    PRAGMA busy_timeout = ${limits.busyTimeoutMs};
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
      result TEXT, created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS inbox ON approvals(owner, state);
    CREATE INDEX IF NOT EXISTS run_approvals ON approvals(run, state);
  `)
  // A `started` delivery was cut off by a crash and may have arrived. Safe only because one service owns the database.
  db.prepare("UPDATE approvals SET state='unknown' WHERE state='started'").run()

  const insertRevision = db.prepare("INSERT INTO revisions(id,body,created_at) VALUES(?,?,?)")
  const selectRevision = db.prepare("SELECT body FROM revisions WHERE id=?")
  const insertRun = db.prepare("INSERT INTO runs(id,body,grants,status,created_at) VALUES(?,?,?,'running',?)")
  const selectRun = db.prepare("SELECT body,grants FROM runs WHERE id=?")
  const selectRunStatus = db.prepare("SELECT status FROM runs WHERE id=?")
  const selectChildren = db.prepare("SELECT id FROM runs WHERE json_extract(body, '$.parent.run')=?")
  const updateRunStatus = db.prepare("UPDATE runs SET status=? WHERE id=? AND status='running'")
  const insertEvent = db.prepare("INSERT INTO events(run,kind,detail,at) VALUES(?,?,?,?)")
  const selectEvents = db.prepare("SELECT seq,at,kind,detail FROM events WHERE run=? ORDER BY seq")
  const selectReview = db.prepare(
    "SELECT a.run,a.tool,a.packet,a.state,a.created_at,r.status AS run_status " +
    "FROM approvals a JOIN runs r ON r.id=a.run WHERE a.owner=? AND a.id=?",
  )
  const selectInbox = db.prepare(
    "SELECT a.id,a.run,a.tool,a.state,a.created_at,r.status AS run_status " +
    "FROM approvals a JOIN runs r ON r.id=a.run " +
    "WHERE a.owner=? AND a.state IN ('pending','started','unknown') ORDER BY a.rowid",
  )
  const selectReceipt = db.prepare("SELECT tool,args FROM approvals WHERE owner=? AND id=?")
  // What waits in an owner's inbox: not a cancelled run's, which can only be declined and is never sent.
  const selectPendingUsage = db.prepare(
    "SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(a.packet AS BLOB))), 0) AS bytes " +
    "FROM approvals a JOIN runs r ON r.id=a.run WHERE a.owner=? AND a.state='pending' AND r.status<>'cancelled'",
  )
  const insertApproval = db.prepare(
    "INSERT INTO approvals(id,owner,run,tool,args,packet,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  )
  const selectProgress = db.prepare("SELECT state,result FROM approvals WHERE owner=? AND id=?")
  const selectApprovalMeta = db.prepare("SELECT run,tool FROM approvals WHERE owner=? AND id=?")
  const updateState = db.prepare("UPDATE approvals SET state=?,result=coalesce(?,result) WHERE owner=? AND id=? AND state=?")

  // In-process wake-ups for calls waiting on an approval.
  const waiters = new Map<string, Set<() => void>>()
  function notify(id: string) {
    const set = waiters.get(id)
    if (!set) return
    waiters.delete(id)
    for (const wake of set) wake()
  }

  function record(run: string, kind: EventKind, detail: unknown) {
    insertEvent.run(run, kind, JSON.stringify(detail), Date.now())
  }
  /** A state change and its audit event are one: written together, or not at all. */
  function atomically(change: () => void) {
    db.exec("BEGIN IMMEDIATE")
    try {
      change()
      db.exec("COMMIT")
    } catch (error) {
      // SQLite may have rolled back already, as it does after some failures.
      if (db.isTransaction) db.exec("ROLLBACK")
      throw error
    }
  }
  function loadRun(id: string) {
    const row = selectRun.get(id)
    if (!row) fail("NOT_FOUND", "Unknown run")
    return {
      run: freezeRun(JSON.parse(String(row.body)) as Run),
      grants: JSON.parse(String(row.grants)) as string[],
    }
  }
  function runStatus(id: string): RunStatus | undefined {
    const row = selectRunStatus.get(id)
    return row ? (String(row.status) as RunStatus) : undefined
  }
  function ended(id: string): boolean {
    const status = runStatus(id)
    return status !== undefined && status !== "running"
  }
  /** Ends a running run once; a later end of the same run changes nothing. */
  function finishRun(id: string, status: Exclude<RunStatus, "running">, detail: unknown) {
    atomically(() => {
      if (updateRunStatus.run(status, id).changes === 1) record(id, "ended", detail)
    })
  }
  function review(owner: string, id: string): ApprovalReview {
    const row = selectReview.get(owner, id)
    if (!row) fail("NOT_FOUND", "Unknown approval")
    return {
      id,
      run: loadRun(String(row.run)).run,
      runStatus: String(row.run_status) as RunStatus,
      tool: String(row.tool),
      state: String(row.state) as ApprovalState,
      createdAt: Number(row.created_at),
      write: packet.parse(JSON.parse(String(row.packet))),
    }
  }
  function transition(owner: string, id: string, from: ApprovalState, to: ApprovalState, result?: string | null) {
    if (!lifecycle[from].includes(to)) fail("INVALID_STATE", `Approval cannot move from ${from} to ${to}`)
    if (updateState.run(to, result ?? null, owner, id, from).changes !== 1) fail("INVALID_STATE", "Approval is not " + from)
    notify(id)
  }
  /** A delivery's answer as it is kept. One that isn't JSON keeps none: the delivery stands, its answer fails its check. */
  function receipt(value: CallToolResult): string | null {
    try {
      return JSON.stringify(value) ?? null
    } catch {
      return null
    }
  }
  function approvalId(run: Run, key: string) {
    return createHash("sha256").update(JSON.stringify([run.id, key])).digest("hex")
  }
  /**
   * The key of a call its client gave no key of its own (`celler/call-id`), from its tool and arguments (`base`): that
   * of the approval it joins while that one is still open, as a blind retry does; once it is settled, the next of the
   * same call's, so the same call made again is made again, and a retry of that one joins it. A run that has ended
   * collects what the last one it staged came to.
   */
  function callKey(run: Run, base: string): string {
    const settled = (key: string) => {
      const state = selectProgress.get(run.owner, approvalId(run, key))?.state
      return state === "sent" || state === "declined" || state === "failed"
    }
    const over = ended(run.id)
    let key = base
    for (let n = 1; settled(key); n++) {
      const next = hash([base, n])
      if (over && !selectProgress.get(run.owner, approvalId(run, next))) return key
      key = next
    }
    return key
  }
  function existingApproval(run: Run, key: string, tool: string, args: unknown) {
    const id = approvalId(run, key)
    const row = selectReceipt.get(run.owner, id)
    if (!row) return undefined
    if (row.tool !== tool || canonicalJson(JSON.parse(String(row.args))) !== canonicalJson(normalizeJson(args))) {
      fail("KEY_CONFLICT", "Call key reused with different arguments")
    }
    return id
  }

  // Concurrent calls that share (run, call key) share one prepare().
  const staging = new Map<string, {
    tool: string; args: string; waiters: number; controller: AbortController; promise: Promise<string>
  }>()

  // Budgets are per owner, because the inbox they protect is one person's.
  function checkPendingQuota(owner: string, extraBytes: number) {
    const usage = selectPendingUsage.get(owner)
    const count = Number(usage?.count ?? 0)
    const bytes = Number(usage?.bytes ?? 0)
    if (count >= limits.maxPendingApprovals) fail("LIMIT_EXCEEDED", "Pending approval limit reached for this inbox")
    if (bytes + extraBytes > limits.maxPendingBytes) fail("LIMIT_EXCEEDED", "Pending approval byte budget exceeded")
  }

  async function stage(
    run: Run, key: string, tool: string, args: object,
    prepare: (signal: AbortSignal) => Promise<Write>, signal: AbortSignal,
  ) {
    signal.throwIfAborted()
    const normalized = normalizeJson(args)
    const argsText = canonicalJson(normalized)
    const previous = existingApproval(run, key, tool, normalized)
    if (previous) return previous

    const id = approvalId(run, key)
    let entry = staging.get(id)
    if (entry) {
      if (entry.tool !== tool || entry.args !== argsText) fail("KEY_CONFLICT", "Call key reused with different arguments")
      entry.waiters++
    } else {
      checkPendingQuota(run.owner, 0)
      const controller = new AbortController()
      const created = {
        tool, args: argsText, waiters: 1, controller,
        promise: Promise.resolve().then(async () => {
          const frozen = JSON.stringify(packet.parse(await prepare(controller.signal)))
          const bytes = Buffer.byteLength(frozen)
          if (bytes > limits.inlineLimit) fail("LIMIT_EXCEEDED", "Approval exceeds inline limit")
          if (controller.signal.aborted) fail("RUN_ENDED", "Approval staging aborted")
          checkPendingQuota(run.owner, bytes)
          insertApproval.run(id, run.owner, run.id, tool, JSON.stringify(normalized), frozen, Date.now())
          return existingApproval(run, key, tool, normalized)!
        }),
      }
      const forget = () => { if (staging.get(id) === created) staging.delete(id) }
      created.promise.then(forget, forget) // also keeps an abandoned rejection from going unhandled
      staging.set(id, created)
      entry = created
    }

    try {
      return await raceAbort(entry.promise, signal)
    } finally {
      // The last caller to leave aborts prepare() and frees the key, so an immediate retry starts afresh.
      if (--entry.waiters === 0) {
        entry.controller.abort()
        if (staging.get(id) === entry) staging.delete(id)
      }
    }
  }

  async function result(owner: string, id: string, signal: AbortSignal): Promise<CallToolResult> {
    for (;;) {
      signal.throwIfAborted()
      const row = selectProgress.get(owner, id)
      if (!row) fail("NOT_FOUND", "Unknown approval")
      if (row.state === "sent") return JSON.parse(String(row.result))
      if (row.state === "declined") fail("DECLINED", "The person declined this action")
      if (row.state === "unknown") fail("DELIVERY_FAILED", "Delivery outcome unknown until the host reconciles it")
      if (row.state === "failed") fail("DELIVERY_FAILED", "Delivery failed")

      await new Promise<void>((resolve, reject) => {
        let set = waiters.get(id)
        if (!set) {
          set = new Set()
          waiters.set(id, set)
        }
        const wake = () => {
          signal.removeEventListener("abort", onAbort)
          resolve()
        }
        const onAbort = () => {
          set.delete(wake)
          if (set.size === 0) waiters.delete(id)
          reject(signal.reason)
        }
        set.add(wake)
        signal.addEventListener("abort", onAbort, { once: true })
      })
    }
  }

  /** Sends an approved packet once, and gives what it answered with the run and tool it was made for. */
  async function approve(
    owner: string, id: string,
    resolve: (run: Run, tool: string) => ResolvedDelivery,
    signal?: AbortSignal,
  ): Promise<{ value: CallToolResult; run: Run; tool: string }> {
    const item = review(owner, id)
    if (item.state !== "pending") fail("INVALID_STATE", "Approval is not pending")
    if (item.runStatus === "cancelled") fail("RUN_ENDED", "Run was cancelled")
    const { verify } = resolve(item.run, item.tool)
    if (verify) await verify(item.write)
    // What changed while verify ran counts: the run, the policy and the caller are asked again, and nothing waits
    // from here to the compare-and-set.
    if (runStatus(item.run.id) === "cancelled") fail("RUN_ENDED", "Run was cancelled")
    const { send } = resolve(item.run, item.tool)
    signal?.throwIfAborted()
    transition(owner, id, "pending", "started")
    let value: CallToolResult
    try {
      // Send the snapshot the person saw, including the original attachment bytes.
      value = await send(item.write, id, signal)
    } catch (error) {
      atomically(() => {
        transition(owner, id, "started", "unknown")
        record(item.run.id, "delivery_failed", { id, tool: item.tool })
      })
      throw error
    }
    // Saved before anything checks the response, so a real delivery always keeps its receipt.
    atomically(() => {
      transition(owner, id, "started", "sent", receipt(value))
      record(item.run.id, "approved", { id, tool: item.tool })
    })
    return { value, run: item.run, tool: item.tool }
  }

  function decline(owner: string, id: string) {
    atomically(() => {
      const meta = selectApprovalMeta.get(owner, id)
      transition(owner, id, "pending", "declined")
      if (meta) record(String(meta.run), "declined", { id, tool: String(meta.tool) })
    })
  }

  function reconcile(owner: string, id: string, outcome: "sent" | "failed", value?: CallToolResult) {
    atomically(() => {
      const meta = selectApprovalMeta.get(owner, id)
      transition(owner, id, "unknown", outcome, value && JSON.stringify(value))
      if (meta) record(String(meta.run), "reconciled", { id, tool: String(meta.tool), outcome })
    })
  }

  function history(owner: string, id: string): HistoryEvent[] {
    if (loadRun(id).run.owner !== owner) fail("NOT_FOUND", "Unknown run")
    return selectEvents.all(id).map(row => ({
      seq: Number(row.seq),
      at: Number(row.at),
      kind: String(row.kind) as EventKind,
      detail: JSON.parse(String(row.detail)) as unknown,
    }))
  }

  function inbox(owner: string): ApprovalSummary[] {
    return selectInbox.all(owner).map(row => ({
      id: String(row.id),
      run: String(row.run),
      tool: String(row.tool),
      state: String(row.state) as ApprovalState,
      runStatus: String(row.run_status) as RunStatus,
      createdAt: Number(row.created_at),
    }))
  }

  return {
    saveRevision(config: unknown) {
      const id = randomUUID()
      insertRevision.run(id, JSON.stringify(config), Date.now())
      return id
    },
    revision(id: string): unknown {
      const row = selectRevision.get(id)
      if (!row) fail("NOT_FOUND", "Unknown revision")
      return JSON.parse(String(row.body))
    },
    /** Saves a run with its grants and its `started` event. */
    saveRun(run: Run, grants: string[], detail: unknown) {
      atomically(() => {
        insertRun.run(run.id, JSON.stringify(run), JSON.stringify(grants), Date.now())
        record(run.id, "started", detail)
      })
    },
    history,
    inbox,
    /** The runs a run delegated, whatever process started them. */
    children: (id: string) => selectChildren.all(id).map(row => String(row.id)),
    decline, reconcile, ended, finishRun, loadRun, record, callKey, existingApproval, stage, result, review, approve,
  }
}

export type Store = ReturnType<typeof openStore>
