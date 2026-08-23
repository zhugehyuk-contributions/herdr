// Not from orca. §Q's **when**, split out of `./pane-observer.ts` so that file keeps answering only
// its own question (what a stream is and how one is opened).
//
// The defect this exists for is `.prd/09-review-followups.md` §Q, measured on a device: the pane's
// exec channel died at 20:14:43Z, M4's supervisor redialled the *health* link at 20:15:11Z, and the
// picture stayed frozen until 20:17:27Z — when the user left the screen and came back. Two streams,
// one supervisor: the transport healed and nothing re-sent `ObserveTerminal` on the pane's channel.
//
// Every number here is borrowed, and that is the design. The mechanism — L3's tiered backoff, its
// attempt cap, its 90s trickle that **never parks**, plus the foreground gate and the refusal latch
// — is `../transport/foreground-redial-ladder.ts`, which this class was the sole holder of until
// `modules/herdr-ssh/src/dial-loop.ts` needed the identical shape for a remote whose *first* ssh
// dial failed. A second hand-written copy of it is precisely orca's #10119 (two code paths
// disagreeing about whether a redial is a fresh start), so the shape moved and this kept the
// vocabulary: for a pane, a dial is an `attach` and a connect is `noteAttached`.
import { ForegroundRedialLadder } from '../transport/foreground-redial-ladder'
import type { TransportTimer } from '@herdr/client-ts'

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
  /**
   * Absent means "assume the screen is on", which is right for every headless caller.
   *
   * For a pane the cost the gate saves is concrete: a dial is an ssh exec channel and a remote
   * `herdr` process (blocker B8) whose output is a picture nobody is looking at.
   */
  isForeground?: () => boolean
}

/** L3's ladder, pointed at one pane's observe stream. */
export class PaneReattachLadder extends ForegroundRedialLadder {
  constructor(options: PaneReattachOptions) {
    super({
      // Wrapped rather than passed by reference so `attach` keeps whatever `this` its owner gave it.
      dial: () => options.attach(),
      ...(options.timer === undefined ? {} : { timer: options.timer }),
      ...(options.isForeground === undefined ? {} : { isForeground: options.isForeground })
    })
  }

  /** A handshake landed. The only place the counter legitimately returns to zero. */
  noteAttached(): void {
    this.noteConnected()
  }
}
