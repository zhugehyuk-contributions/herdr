// Not from orca. Extracted from `../session/pane-reattach.ts`, which had been the only holder of
// this shape, at the moment a *second* caller needed it — `modules/herdr-ssh/src/dial-loop.ts`, the
// retry for a remote whose very first ssh dial failed.
//
// The extraction is the point rather than a tidy-up. `./reconnect-policy.ts`'s header states the
// rule this repo keeps paying for: one ladder, one set of constants, because "두 개의 스케줄러" is
// orca's #10119 (two code paths disagreeing about whether a redial is a fresh start). A second
// hand-written `ReconnectScheduler` wrapper with its own foreground gate would have been exactly
// that, so the wrapper is a class both callers construct instead.
//
// What this adds on top of `ReconnectScheduler`, and it is only two facts:
//
//   · **the screen may be off.** A dial costs an ssh connection or an exec channel and, on the far
//     side, a `herdr` process (03-blockers.md B8). Backgrounded that is pure cost, and the OS
//     suspends JS timers anyway and delivers the deferred wake-ups as a burst at resume. So the
//     rung still comes due and the *dial* waits — {@link ForegroundRedialLadder.due} re-arms rather
//     than parking, because a park is the #5049 state L3 exists to abolish.
//   · **some refusals cannot be dialled away.** A refused public key answers the next dial
//     identically; retrying it is an authentication attempt every 90 seconds against a verdict only
//     the user can move (and, on a box running fail2ban, a ban). {@link latch} is the terminal
//     state for those, and only a new ladder leaves it.
import { hostTimer, type TransportTimer } from '@herdr/client-ts'
import { ReconnectScheduler } from './reconnect-policy'

export type ForegroundRedialLadderOptions = {
  /**
   * Runs one dial.
   *
   * Never called re-entrantly — `ReconnectScheduler` clears its timer before firing — and never
   * called while latched or backgrounded.
   */
  dial: () => void
  /** Injected so a receipt reads a deterministic sequence rather than sleeping. */
  timer?: TransportTimer
  /** Absent means "assume the screen is on", which is right for every headless caller. */
  isForeground?: () => boolean
}

/** L3's ladder (`./reconnect-policy.ts`), gated on the app being in the foreground. */
export class ForegroundRedialLadder {
  private readonly options: ForegroundRedialLadderOptions
  private readonly scheduler: ReconnectScheduler
  private latchedOnRefusal = false
  private attempts = 0

  constructor(options: ForegroundRedialLadderOptions) {
    this.options = options
    this.scheduler = new ReconnectScheduler({
      dial: () => this.due(),
      timer: options.timer ?? hostTimer
    })
  }

  /** How many dials this ladder ran. Zero after an outage is a diagnosis, not an absence. */
  get attemptCount(): number {
    return this.attempts
  }

  /** True once {@link latch} has been called. Only a new ladder leaves it. */
  get latched(): boolean {
    return this.latchedOnRefusal
  }

  /** True while a rung is armed. Neither armed nor latched nor connected is the #5049 park. */
  get armed(): boolean {
    return this.scheduler.armed
  }

  /** L3's counter, so a caller can report which rung it is on rather than only that it is on one. */
  get attempt(): number {
    return this.scheduler.reconnectAttempt
  }

  /** The peer refused this client. Stop: the next dial reproduces the same answer. */
  latch(): void {
    this.latchedOnRefusal = true
    this.scheduler.cancel()
  }

  /** The dial failed. Arms the next rung, unless there is nothing left to try. */
  arm(): void {
    if (this.latchedOnRefusal) {
      return
    }
    this.scheduler.schedule()
  }

  /**
   * A revival signal — the app resumed, or the network came back. Dials now instead of waiting out
   * the armed rung.
   *
   * The attempt counter is reset because a revival is the one moment the *reason* for the failures
   * may have changed under the app, which is `redialNow(true)`'s "a genuinely fresh start".
   */
  reviveNow(): void {
    if (this.latchedOnRefusal) {
      return
    }
    this.scheduler.redialNow(true)
  }

  /** A dial landed. The only place the counter legitimately returns to zero. */
  noteConnected(): void {
    this.scheduler.noteConnected()
  }

  /** Nothing is watching any more. A disposed owner must not leave a rung armed. */
  cancel(): void {
    this.scheduler.cancel()
  }

  private due(): void {
    if (this.latchedOnRefusal) {
      return
    }
    if (this.options.isForeground?.() === false) {
      // Re-arm rather than park: a nudge that never arrives must not be the only way back, which is
      // the whole of L3.
      this.scheduler.schedule()
      return
    }
    this.attempts += 1
    this.options.dial()
  }
}
