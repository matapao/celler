import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Adapter, Platform } from './app.js';
import type { Binding } from './catalog.js';
import { fail, CellerError } from './errors.js';
import type { appLimits } from './limits.js';
import { admit, type Runs } from './runs.js';
import type { Run, Store } from './store.js';

type Args = Record<string, unknown>;

const codeOf = (error: unknown) => (error instanceof CellerError ? error.code : undefined);

/**
 * A run's calls to its tools, each checked against the run and kept in its history: through its adapter at once, or
 * as a packet the person approves in the inbox, or as a run it delegates.
 */
export function createCalls(
  runs: Runs,
  store: Store,
  platform: Platform,
  registry: ReadonlyMap<string, Adapter>,
  limits: typeof appLimits,
) {
  const activeCalls = new Map<string, number>(); // run id → tool calls in flight

  /** What a call came to. The approval it stages or joins, if it does, is put in `staged` before it waits on it. */
  async function execute(
    run: Run,
    node: Binding,
    args: Args,
    key: string,
    signal: AbortSignal,
    o: { heartbeat?: () => void; asTask: boolean; staged: { approval?: string } },
  ): Promise<unknown> {
    const { heartbeat, asTask } = o;
    if ('cell' in node.target) return runs.delegate(run, node.id, node.target.cell, args, key, signal, o);
    const adapter = registry.get(node.target.adapter);
    if (!adapter) fail('UNAVAILABLE', 'Adapter unavailable: ' + node.target.adapter);
    if ('call' in adapter) return adapter.call(run, args, signal);
    // The call hears its approval from before it stages or joins it: an answer its host hears first is handed to it.
    const hearing = store.hearing(run, key);
    try {
      o.staged.approval = await store.stage(
        run,
        key,
        node.id,
        args,
        async (prepareSignal) => {
          const write = await adapter.prepare(run, args, prepareSignal);
          // The run, or a caller up its chain, may have ended while the packet was made: then it is left for no one.
          runs.checkAncestors(run, true);
          if (store.ended(run.id)) fail('RUN_ENDED', 'Run has ended');
          return write;
        },
        signal,
      );
      // The run waits for the person until they decide, or the call is withdrawn or cut off: that time isn't the run's.
      // Made as a task, the call waits, but its agent doesn't: it goes on with its work meanwhile.
      const release = asTask ? undefined : platform.waiting?.(run);
      try {
        return await runs.waitFor(hearing.result(signal), signal, heartbeat);
      } finally {
        release?.();
      }
    } finally {
      hearing.end();
    }
  }

  async function call(
    run: Run,
    id: string,
    args: Args,
    key: string,
    signal: AbortSignal,
    { heartbeat, asTask = false }: { heartbeat?: () => void; asTask?: boolean } = {},
  ): Promise<CallToolResult> {
    signal.throwIfAborted();
    const release = admit(activeCalls, run.id, limits.maxConcurrency, 'Too many concurrent calls in this run');
    try {
      const ended = store.ended(run.id);
      let node: Binding;
      try {
        node = runs.binding(run, id, !ended);
      } catch (error) {
        if (!ended) store.record(run.id, 'denied', { id, key, code: codeOf(error) });
        throw error;
      }
      if (node.definition.execution?.taskSupport === 'required' && !asTask)
        fail('INVALID_ARGS', `Call ${id} as a task`);
      if (Buffer.byteLength(JSON.stringify(args)) > limits.inlineLimit)
        fail('LIMIT_EXCEEDED', 'Arguments exceed the inline limit');
      const current = runs.graph(run.revision);
      current.validateInput(id, args);

      if (ended) {
        // An ended run can only collect the outcome of an approval it already staged. Its clock is over, and no run it
        // was delegated by waits on it any more: nothing is held for the person.
        const approval = store.existingApproval(run, key, id, args);
        if (!approval) fail('RUN_ENDED', 'Run has ended');
        const hearing = store.hearing(run, key);
        try {
          const value = await runs.waitFor(hearing.result(signal), signal, heartbeat);
          return runs.checkedResult(current, id, value);
        } finally {
          hearing.end();
          // Heard, whether or not it passes its checks, or why it failed: its run has collected it.
          if (!signal.aborted) store.collect(run.owner, approval);
        }
      }

      store.record(run.id, 'call', { id, key });
      // What a delivery came to is kept until a call of its run has heard it: its answer, as it returned or failed its
      // checks, or why it failed; not while it was only withdrawn or cut off, so a retry still collects it, unless its
      // host has heard the answer as its approve returned it.
      const staged: { approval?: string } = {};
      try {
        const value = await execute(run, node, args, key, signal, { heartbeat, asTask, staged });
        const result = runs.checkedResult(current, id, value);
        store.heard(run, 'returned', { id, key, error: result.isError ?? false }, staged.approval);
        return result;
      } catch (error) {
        if (signal.aborted) store.record(run.id, 'cancelled', { id, key, code: codeOf(error) });
        else store.heard(run, 'failed', { id, key, code: codeOf(error) }, staged.approval);
        throw error;
      }
    } finally {
      release();
    }
  }

  return { call };
}

export type Calls = ReturnType<typeof createCalls>;
