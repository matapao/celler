// A stand-in for every runtime: clearly labelled fake results, for trying a host without calling a model.

import { emptyUsage, failure, type RunHandle, type RunProgress, type RunResult, type Runtime, type RuntimeHealth, type RunSpec } from "./types.js"

export class SimulatedRuntime implements Runtime {
  readonly kind = "simulated" as const
  constructor(private speed = 1) {}

  async health(): Promise<RuntimeHealth> {
    return { ok: true, checkedAt: Date.now(), detail: "No model is called; results are placeholders." }
  }

  /** Reads for a moment, then says it called no model, with the prompt it was given. */
  run(spec: RunSpec, onProgress: (p: RunProgress) => void): RunHandle {
    const total = (1500 + Math.random() * 3000) * this.speed
    let settle: (r: RunResult) => void = () => undefined
    const done = new Promise<RunResult>((resolve) => (settle = resolve))
    const reading = setTimeout(() => onProgress({ type: "tool", tool: "Read", summary: "Read (simulated)" }), total * 0.3)
    const text = `[Simulated: no model was called] ${spec.prompt}`
    const ending = setTimeout(() => settle({ ok: true, text, usage: emptyUsage(), costUsd: 0, model: "simulated", permissionDenials: [] }), total)
    return {
      done,
      cancel: () => {
        clearTimeout(reading)
        clearTimeout(ending)
        settle({ ...failure("Cancelled"), cancelled: true })
      },
    }
  }
}
