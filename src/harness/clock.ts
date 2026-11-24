// A run's clock, which stops the run once its time is up and stands still while the person is asked: by its agent, or
// about what the run waits on, such as one of its calls in the inbox (RunHandle.hold, as its platform says). Each wait
// holds it, and it goes on once the last is released, so waits at the same time count once. Once its run is over, it
// never starts again.

/** The longest a timer waits in one go (Node's): a longer run's clock is set again when it is reached. */
const LONGEST_WAIT = 2 ** 31 - 1

export class RunClock {
  /** When its run's time is up, later by each while it stood still. */
  private deadline: number
  /** How many waits hold it, and since when it has stood still. */
  private waiting = 0
  private pausedAt = 0
  private timer: NodeJS.Timeout | undefined

  constructor(
    timeoutMs: number,
    /** Whether its run is over: stopped or ended. */
    private over: () => boolean,
    /** Stops its run once its time is up. */
    private timedOut: () => void,
  ) {
    this.deadline = Date.now() + timeoutMs
  }

  /** Set to its deadline, or its run stopped. */
  readonly arm = (): void => {
    if (this.over()) return
    clearTimeout(this.timer)
    const left = this.deadline - Date.now()
    // Past its time, or with none it could keep: stopped now. Else woken at its deadline, a long one in steps.
    if (!(left > 0)) return this.timedOut()
    this.timer = setTimeout(this.arm, Math.min(left, LONGEST_WAIT))
  }

  /** Held still until the release it gives is called. */
  readonly hold = (): (() => void) => {
    if (this.waiting++ === 0) {
      this.pausedAt = Date.now()
      clearTimeout(this.timer)
    }
    // Released once: a release called again changes nothing.
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.waiting === 0) {
        this.deadline += Date.now() - this.pausedAt
        this.arm()
      }
    }
  }

  /** What is asked, the clock held meanwhile. */
  async meanwhile<T>(asked: () => Promise<T>): Promise<T> {
    const release = this.hold()
    try {
      return await asked()
    } finally {
      release()
    }
  }

  /** Stopped for good, as its run ends. */
  stop(): void {
    clearTimeout(this.timer)
  }
}
