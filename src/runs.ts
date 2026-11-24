import { randomUUID } from "node:crypto"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Platform, Start } from "./app.js"
import { compileGraph, type Binding, type Graph, type Schemas } from "./catalog.js"
import { fail } from "./errors.js"
import { hash, normalizeJson } from "./json.js"
import type { appLimits } from "./limits.js"
import { freezeRun, raceAbort, type Run, type Store } from "./store.js"

type Args = Record<string, unknown>
/** A run delegated by a call: its id, its arguments' hash, and its result once it ends. */
type Delegated = { id: string; args: string; result: Promise<CallToolResult> }

function createLru<V>(limit: number) {
  const map = new Map<string, V>()
  return {
    get(key: string): V | undefined {
      const value = map.get(key)
      if (value !== undefined) {
        map.delete(key)
        map.set(key, value)
      }
      return value
    },
    set(key: string, value: V) {
      map.delete(key)
      map.set(key, value)
      if (map.size > limit) map.delete(map.keys().next().value!)
    },
  }
}

/** Counts work in flight under a key, refuses more than `limit`, and returns the release. */
export function admit(counts: Map<string, number>, key: string, limit: number, message: string) {
  const count = counts.get(key) ?? 0
  if (count >= limit) fail("LIMIT_EXCEEDED", message)
  counts.set(key, count + 1)
  return () => {
    const left = (counts.get(key) ?? 1) - 1
    if (left > 0) counts.set(key, left)
    else counts.delete(key)
  }
}

/**
 * An app's runs in this process: the graphs and runs it keeps in memory, what a run may use (its grants and the live
 * policy, up its whole delegation chain), what each run owns until it ends, and starting a run, delegated or not. A
 * run's agent reaches its MCP server through `connect` (server.ts).
 */
export function createRuns(
  store: Store, platform: Platform, schemas: Schemas, limits: typeof appLimits,
  connect: (run: Run, channel: Transport, native?: boolean) => Promise<void>,
) {
  const graphs = createLru<Graph>(limits.graphCacheSize)
  const runCache = createLru<{ run: Run; grants: ReadonlySet<string> }>(limits.runCacheSize)
  const activeRuns = new Map<string, number>() // root run id → runs in flight in its delegation tree
  const lifetimes = new Map<string, AbortController>() // run id → ends everything the run owns
  // run id → its uncollected children, by tool and call key, each with its run's id and its arguments' hash
  const delegations = new Map<string, Map<string, Delegated>>()

  function graph(revision: string) {
    let current = graphs.get(revision)
    if (!current) {
      current = compileGraph(store.revision(revision), schemas)
      graphs.set(revision, current)
    }
    return current
  }
  /** A graph just published, kept as its revision's. */
  function keepGraph(revision: string, current: Graph) {
    graphs.set(revision, current)
  }

  /** A tool's answer, as the harness gets it: a tool result, within the inline limit, with the output it declares. */
  function checkedResult(current: Graph, id: string, value: unknown): CallToolResult {
    const parsed = CallToolResultSchema.safeParse(value)
    if (!parsed.success) fail("INVALID_OUTPUT", "Invalid tool result for " + id)
    if (Buffer.byteLength(JSON.stringify(parsed.data)) > limits.inlineLimit) {
      fail("LIMIT_EXCEEDED", "Result exceeds the inline limit: " + id)
    }
    if (!parsed.data.isError) current.validateOutput(id, parsed.data.structuredContent)
    return parsed.data
  }

  function loadRunCached(id: string) {
    let cached = runCache.get(id)
    if (!cached) {
      const loaded = store.loadRun(id)
      cached = { run: loaded.run, grants: new Set(loaded.grants) }
      runCache.set(id, cached)
    }
    return cached
  }

  function access(run: Run) {
    const { grants } = loadRunCached(run.id)
    return (id: string) => grants.has(id) && platform.allowed(run, id)
  }

  /** The signal that ends what a run owns in this process: its calls, its waits and its delegated runs. */
  function lifetime(runId: string) {
    let controller = lifetimes.get(runId)
    if (!controller) lifetimes.set(runId, (controller = new AbortController()))
    return controller.signal
  }
  function stop(runId: string) {
    lifetimes.get(runId)?.abort()
    lifetimes.delete(runId)
    delegations.delete(runId)
  }
  function rootOf(runId: string) {
    let run = loadRunCached(runId).run
    while (run.parent) run = loadRunCached(run.parent.run).run
    return run.id
  }
  /** Waits for work that outlives the request: aborting detaches this caller only. Heartbeats keep clients waiting. */
  async function waitFor<T>(work: Promise<T>, signal: AbortSignal, heartbeat?: () => void): Promise<T> {
    const timer = heartbeat && limits.progressIntervalMs ? setInterval(heartbeat, limits.progressIntervalMs) : undefined
    timer?.unref()
    try {
      return await raceAbort(work, signal)
    } finally {
      clearInterval(timer)
    }
  }

  // `requireActive` refuses new calls under an ended ancestor; listings and staged approvals still work there.
  function checkAncestors(run: Run, requireActive = false) {
    let parent = run.parent
    while (parent) {
      const caller = loadRunCached(parent.run).run
      if (requireActive && store.ended(caller.id)) fail("RUN_ENDED", "Parent run has ended")
      if (!graph(caller.revision).reaches(caller.entry, parent.tool, access(caller))) fail("REVOKED", "Delegation revoked")
      parent = caller.parent
    }
  }

  function binding(run: Run, id: string, requireActive = false): Binding {
    checkAncestors(run, requireActive)
    const current = graph(run.revision)
    if (!current.reaches(run.entry, id, access(run))) fail("DENIED", "Tool outside this run: " + id)
    const node = current.get(id)
    if (node.kind !== "tool") fail("INVALID_ARGS", "Expected a tool: " + id)
    return node
  }

  async function startRun(request: Start, signal: AbortSignal, parent: Run["parent"], id = randomUUID()): Promise<CallToolResult> {
    signal.throwIfAborted()
    const input = normalizeJson(request.input)
    if (Buffer.byteLength(JSON.stringify(input)) > limits.inlineLimit) fail("LIMIT_EXCEEDED", "Input exceeds the inline limit")
    const { input: _raw, ...settings } = request
    const run = freezeRun({ ...settings, id, parent })
    const current = graph(run.revision)
    const entry = current.runnableCell(run.entry)

    // Cap the depth, and keep denied whatever an ancestor could reach but may not use now: what its live view, its
    // grants and the policy's word as it stands, leaves out.
    const deniedByAncestors = new Set<string>()
    let depth = 0
    for (let ancestor = parent; ancestor;) {
      if (++depth > limits.maxDepth) fail("LIMIT_EXCEEDED", "Maximum delegation depth exceeded")
      const caller = loadRunCached(ancestor.run).run
      const callerGraph = graph(caller.revision)
      const usable = callerGraph.view(caller.entry, access(caller))
      for (const id of callerGraph.staticReachable(caller.entry)) {
        if (!usable.has(id)) deniedByAncestors.add(id)
      }
      ancestor = caller.parent
    }

    // Policy is asked only about what this cell can reach, so rules can be scoped to cells. A denied cell stops what
    // it exports, as it does in every listing.
    const reachable = current.view(entry.id, id => !deniedByAncestors.has(id) && platform.allowed(run, id))
    const grants = [...reachable.keys()]

    const release = admit(activeRuns, parent ? rootOf(parent.run) : run.id, limits.maxRuns,
      "Too many active runs in this delegation tree")
    const launchSignal = AbortSignal.any([signal, lifetime(run.id)])
    try {
      store.saveRun(run, grants, { entry: entry.id, parent })
      runCache.set(run.id, { run, grants: new Set(grants) })
      const raw = await platform.launch(
        { ...run, profile: entry.profile, context: structuredClone(entry.context), input },
        (channel, native) => connect(run, channel, native), launchSignal)
      launchSignal.throwIfAborted()
      const parsed = CallToolResultSchema.safeParse(raw)
      if (!parsed.success) fail("INVALID_OUTPUT", "Invalid run result from the platform")
      const status = parsed.data.isError ? "failed" : "ok"
      store.finishRun(run.id, status, { status, output: parsed.data })
      return parsed.data
    } catch (error) {
      const status = launchSignal.aborted ? "cancelled" : "failed"
      store.finishRun(run.id, status, { status })
      throw error
    } finally {
      stop(run.id)
      release()
    }
  }

  // A delegated run belongs to the calling run, not to the request: a caller that stops waiting only detaches, and a
  // retry with the same key and arguments joins the child or collects its result. The same key with other arguments
  // is the caller's mistake, as it is for an approval.
  async function delegate(
    run: Run, tool: string, cell: string, args: Args, key: string, signal: AbortSignal,
    { heartbeat, asTask = false }: { heartbeat?: () => void; asTask?: boolean } = {},
  ): Promise<CallToolResult> {
    const calls = delegations.get(run.id) ?? new Map<string, Delegated>()
    delegations.set(run.id, calls)
    const slot = hash([tool, key])
    const argsHash = hash(args)
    let child = calls.get(slot)
    if (child && child.args !== argsHash) fail("KEY_CONFLICT", "Call key reused with different arguments")
    if (!child) {
      const id = randomUUID()
      const started = startRun({ owner: run.owner, revision: run.revision, workspace: run.workspace, entry: cell, input: args },
        lifetime(run.id), { run: run.id, tool, key }, id)
      const entry = { id, args: argsHash, result: started }
      started.catch(() => { if (calls.get(slot) === entry) calls.delete(slot) }) // a failed child can be retried
      calls.set(slot, (child = entry))
    }
    // Its agent waits on the child while this call waits for it, and not once it is withdrawn; nor for a task's call.
    const release = asTask ? undefined : platform.waiting?.(run, child.id)
    try {
      const value = await waitFor(child.result, signal, heartbeat)
      if (calls.get(slot) === child) calls.delete(slot) // collected: an identical later call is new work
      return value
    } finally {
      release?.()
    }
  }

  return { graph, keepGraph, checkedResult, loadRunCached, access, lifetime, stop, waitFor, checkAncestors, binding, startRun, delegate }
}

export type Runs = ReturnType<typeof createRuns>
