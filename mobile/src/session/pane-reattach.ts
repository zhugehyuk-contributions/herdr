// Not from orca. §Q's **when**, split out of `./pane-observer.ts` so that file keeps answering only
// its own question (what a stream is and how one is opened).
//
// The defect this exists for is `.prd/09-review-followups.md` §Q, measured on a device: the pane's
// exec channel died at 20:14:43Z, M4's supervisor redialled the *health* link at 20:15:11Z, and the
// picture stayed frozen until 20:17:27Z — when the user left the screen and came back. Two streams,
// one supervisor: the transport healed and nothing re-sent `ObserveTerminal` on the pane's channel.
//
// Every number here is borrowed, and that is the design. `ReconnectScheduler`
// (`../transport/reconnect-policy.ts`) is L3 — the tiered backoff, the attempt cap, and the 90s
// trickle that **never parks**, which is orca #5049's root cause stated as a rule. A second ladder
// with its own constants is precisely orca's #10119 (two code paths disagreeing about whether a
// redial is a fresh start), so this class owns no delay of its own. What it adds is the two facts
// L3 cannot know about a *pane*:
//
//   · **the screen may be off.** A dial is an ssh exec channel and a remote `herdr` process
//     (blocker B8) whose output is a picture. Backgrounded, that is pure cost — and the OS suspends
//     JS timers anyway, delivering the deferred wake-ups as a burst at resume
//     (`../api/use-foreground-refresh.ts` stops its poll for the same reason). So the rung still
//     comes due, and the *dial* waits.
//   · **some refusals cannot be dialled away.** A `Welcome` this build will not accept answers the
//     next `Hello` identically, so retrying it is an exec channel every 90 seconds against a verdict
//     that cannot move. That is `ConnectionSupervisor`'s fatal latch, one layer up.
import { hostTimer, type TransportTimer } from '@herdr/client-ts'
import { ReconnectScheduler } from '../transport/reconnect-policy'

export type PaneReattachOptions = {
  /**
   * Opens a fresh stream for the pane this ladder serves.
   *
   * Never called re-entrantly — `ReconnectScheduler` clears its timer before firing — and never
   * called while latched or backgrounded.
   */
  attach: () => void
  /** Injected so a receipt reads a deterministic sequence rather than sleeping. */
  timer?: TransportTimer
  /** Absent means "assume the screen is on", which is right for every headless caller. */
  isForeground?: () => boolean
}

/** L3's ladder, pointed at one pane's observe stream. */
export class PaneReattachLadder {
  private readonly options: PaneReattachOptions
  private readonly scheduler: ReconnectScheduler
  private latchedOnRefusal = false
  private attempts = 0

  constructor(options: PaneReattachOptions) {
    this.options = options
    this.scheduler = new ReconnectScheduler({
      dial: () => this.due(),
      timer: options.timer ?? hostTimer
    })
  }

  /** How many streams this ladder opened. Zero after an outage is a diagnosis, not an absence. */
  get attemptCount(): number {
    return this.attempts
  }

  /** True once {@link latch} has been called. Only a new observer leaves it. */
  get latched(): boolean {
    return this.latchedOnRefusal
  }

  /** The peer refused this client. Stop: the next dial reproduces the same answer. */
  latch(): void {
    this.latchedOnRefusal = true
    this.scheduler.cancel()
  }

  /** The stream is down. Arms the next rung, unless there is nothing left to try. */
  arm(): void {
    if (this.latchedOnRefusal) {
      return
    }
    this.scheduler.schedule()
  }

  /**
   * A revival signal — the app resumed, or the connection underneath completed a handshake. Dials
   * now instead of waiting out the armed rung.
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

  /** A handshake landed. The only place the counter legitimately returns to zero. */
  noteAttached(): void {
    this.scheduler.noteConnected()
  }

  /** The screen is gone. An unmounted pane must not leave a rung armed. */
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
    this.options.attach()
  }
}
