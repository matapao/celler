import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { createCalls } from "./calls.js"
import { compileGraph, createSchemas, type Cell } from "./catalog.js"
import { fail, parseWith } from "./errors.js"
import { appLimits, withLimits } from "./limits.js"
import { createRuns } from "./runs.js"
import { createServer } from "./server.js"
import { openStore, type Run, type Write } from "./store.js"

type Args = Record<string, unknown>

/**
 * A host capability behind a tool. It either `call`s at once, or `prepare`s a complete packet that a person approves
 * before `send` delivers exactly that packet. Anything that moves data to a third party takes the second form.
 * `verify`, or else `send`, must refuse a packet the adapter would not produce now, such as one for another account.
 * A refusal in `verify` keeps the approval pending; a throw from `send` leaves the delivery `unknown`.
 */
export type Adapter =
  | { call(run: Run, args: Args, signal: AbortSignal): Promise<CallToolResult> }
  | {
      prepare(run: Run, args: Args, signal?: AbortSignal): Promise<Write>
      verify?(run: Run, write: Write): void | Promise<void>
      send(run: Run, write: Write, key: string, signal?: AbortSignal): Promise<CallToolResult>
    }

export type Platform = {
  /** The live policy for node `id`, asked on every listing and call: keep it fast. */
  allowed(run: Run, id: string): boolean
  /** Starts the harness, hands its MCP transport to `connect`, and settles with the run's result. */
  launch(spec: Run & { profile: string; context: Cell["context"]; input: unknown },
    connect: (transport: Transport, nativeDiscovery?: boolean) => Promise<void>,
    signal: AbortSignal): Promise<CallToolResult>
  /**
   * One of the run's calls waits for a person's decision in the inbox, until the release it returns. A platform whose
   * runs keep a clock stops it meanwhile: the person's time isn't the run's.
   */
  waiting?(run: Run): () => void
}

export type Start = Pick<Run, "owner" | "revision" | "entry" | "workspace"> & { input: unknown }
export type AppOptions = {
  database: DatabaseSync
  platform: Platform
  /** The host's adapters by id, read live: the host may add one for tools it publishes later. */
  adapters: ReadonlyMap<string, Adapter>
} & Partial<typeof appLimits>

const startRequest = z.strictObject({
  owner: z.string().min(1), revision: z.string().min(1), entry: z.string().min(1), workspace: z.string().min(1),
  input: z.unknown(),
})

export function createApp(options: AppOptions) {
  // The host's own map, read on each publish and call: an adapter it adds later serves what it publishes after.
  const { database, platform, adapters: registry } = options
  const limits = withLimits(appLimits, options)
  const store = openStore(database, limits)
  const schemas = createSchemas(limits)
  // Its runs (runs.ts), their calls (calls.ts) and each run's MCP server (server.ts). A run's agent connects to the
  // server, whose calls may start runs of their own: so the server is made last, and a run reaches it once it is.
  const runs = createRuns(store, platform, schemas, limits, (run, channel, native) => server.connect(run, channel, native))
  const { call } = createCalls(runs, store, platform, registry, limits)
  const server = createServer(runs, call, store, limits)

  return {
    publish(config: unknown) {
      const current = compileGraph(config, schemas, { adapters: new Set(registry.keys()) })
      const revision = store.saveRevision(current.snapshot)
      runs.keepGraph(revision, current)
      return revision
    },
    async start(request: Start, signal: AbortSignal = new AbortController().signal): Promise<CallToolResult> {
      const valid = parseWith(startRequest, "start request", request)
      return runs.startRun({ ...valid, input: valid.input }, signal, null)
    },
    reconnect(owner: string, runId: string, channel: Transport, native = false) {
      const { run } = runs.loadRunCached(runId)
      if (run.owner !== owner) fail("NOT_FOUND", "Unknown run")
      return server.connect(run, channel, native)
    },
    /** Ends a run and every run it delegated, even ones left from before a restart, and stops their work here. */
    end(owner: string, runId: string) {
      const { run } = runs.loadRunCached(runId)
      if (run.owner !== owner) fail("NOT_FOUND", "Unknown run")
      const tree = [run.id]
      for (let i = 0; i < tree.length; i++) tree.push(...store.children(tree[i]))
      for (const id of tree) store.finishRun(id, "cancelled", { status: "cancelled", by: "host" })
      for (const id of tree) runs.stop(id)
    },
    notifyToolsChanged: server.notifyToolsChanged,
    history: store.history,
    human: {
      inbox: store.inbox,
      review: store.review,
      decline: store.decline,
      /**
       * Settles an `unknown` delivery after the host has checked the destination. What a run collects of one sent passes
       * the checks a delivery's own answer does, so for a tool with an outputSchema the host gives that result.
       */
      reconcile(owner: string, id: string, outcome: "sent" | "failed", result?: CallToolResult) {
        let value: CallToolResult | undefined
        if (outcome === "sent") {
          const { run, tool } = store.review(owner, id)
          const confirmed: CallToolResult = { content: [{ type: "text", text: "Delivered (confirmed by the host)" }] }
          value = runs.checkedResult(runs.graph(run.revision), tool, result ?? confirmed)
        }
        store.reconcile(owner, id, outcome, value)
      },
      async approve(owner: string, id: string, signal?: AbortSignal): Promise<CallToolResult> {
        const { value, run, tool } = await store.approve(owner, id, (run, tool) => {
          const node = runs.binding(run, tool)
          const adapter = "adapter" in node.target ? registry.get(node.target.adapter) : undefined
          if (!adapter || !("send" in adapter)) fail("UNAVAILABLE", "Outbound adapter unavailable")
          return {
            verify: adapter.verify ? write => adapter.verify!(run, write) : undefined,
            send: (write, key, sendSignal) => adapter.send(run, write, key, sendSignal),
          }
        }, signal)
        // The store saved the response as sent first, so a response that fails its checks keeps its receipt.
        return runs.checkedResult(runs.graph(run.revision), tool, value)
      },
    },
  }
}
