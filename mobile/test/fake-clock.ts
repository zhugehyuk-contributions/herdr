// Not from orca. orca's transport tests reach for `vi.useFakeTimers()`; that works, and it works by
// replacing globals, which is the one thing the M4 receipt must not do — `test/live/` runs the same
// state machine against a real ssh channel, a real sshd and a real herdr server, and a suite that
// monkey-patches `setTimeout` cannot be pointed at either one without changing what it proves.
//
// So the clock is a *value* here, not a global. Every timer-owning class in `src/transport/` takes
// `TransportTimer` and `now` by injection for exactly this reason (`./reconnect-policy.ts`,
// `./connection-supervisor.ts`, and orca's own `RpcSessionLivenessWatchdog`, whose constructor
// already accepted `now`/`setTimer`/`clearTimer` before the port — which is a large part of why
// 08-orca-port-map.md could grade that file a byte-identical copy).
//
// The consequence worth stating: `advance(ms)` is the only thing that moves time, so a test that
// asserts "the loop is still dialling after 40 attempts" is not waiting an hour and is not sampling
// a race. It is reading a deterministic sequence.
import type { TransportTimer, TransportTimerHandle } from '@herdr/client-ts'

type Scheduled = {
  id: number
  dueAt: number
  handler: () => void
}

/**
 * A hand-cranked clock and timer queue.
 *
 * Timers fire in due-time order and, within the same millisecond, in the order they were armed —
 * the ordering a real event loop gives, which matters because the watchdog re-arms itself from
 * inside its own callback.
 */
export class FakeClock {
  private current: number
  private nextId = 1
  private queue: Scheduled[] = []
  /** Every delay this clock was ever asked for, in order. The trickle receipt reads this. */
  readonly armedDelays: number[] = []

  constructor(startAt = 1_000_000) {
    this.current = startAt
  }

  now = (): number => this.current

  readonly timer: TransportTimer = {
    setTimeout: (handler: () => void, ms: number): TransportTimerHandle => {
      const id = this.nextId
      this.nextId += 1
      this.armedDelays.push(ms)
      this.queue.push({ id, dueAt: this.current + ms, handler })
      return id
    },
    clearTimeout: (handle: TransportTimerHandle): void => {
      this.queue = this.queue.filter((entry) => entry.id !== handle)
    }
  }

  /** Timers still armed. Zero while not connected is the #5049 park this milestone forbids. */
  get pending(): number {
    return this.queue.length
  }

  /** Moves the clock forward without firing anything — the "JS was suspended" case (L1b). */
  jump(ms: number): void {
    this.current += ms
  }

  /**
   * Advances time, firing every timer whose deadline passes.
   *
   * Bounded so a self-rearming timer with a zero delay fails the test instead of hanging it.
   */
  advance(ms: number, maxFirings = 10_000): number {
    const target = this.current + ms
    let fired = 0
    for (;;) {
      const next = this.earliest()
      if (next === null || next.dueAt > target) {
        break
      }
      this.current = Math.max(this.current, next.dueAt)
      this.queue = this.queue.filter((entry) => entry !== next)
      next.handler()
      fired += 1
      if (fired > maxFirings) {
        throw new Error(`fake clock fired ${fired} timers advancing ${ms}ms — runaway timer`)
      }
    }
    this.current = target
    return fired
  }

  /** Fires exactly the next armed timer, moving the clock to its deadline. */
  runNext(): boolean {
    const next = this.earliest()
    if (next === null) {
      return false
    }
    this.current = Math.max(this.current, next.dueAt)
    this.queue = this.queue.filter((entry) => entry !== next)
    next.handler()
    return true
  }

  private earliest(): Scheduled | null {
    let best: Scheduled | null = null
    for (const entry of this.queue) {
      if (best === null || entry.dueAt < best.dueAt || (entry.dueAt === best.dueAt && entry.id < best.id)) {
        best = entry
      }
    }
    return best
  }
}

/** Lets an `await` in the code under test settle without moving the fake clock. */
export function flushMicrotasks(rounds = 8): Promise<void> {
  let chain = Promise.resolve()
  for (let i = 0; i < rounds; i += 1) {
    chain = chain.then(() => undefined)
  }
  return chain
}
