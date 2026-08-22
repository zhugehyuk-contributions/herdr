// Ported from orca mobile/src/transport/rpc-client.ts:125-131 and :754-780 (`scheduleReconnect`)
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// **L3 — the one line of mobile/.prd/05-orca-transport.md that the table calls the most important,
// and it really is twelve lines of code.** orca's #5049 root cause was not "reconnect failed"; it
// was *reconnect stopped*. A client that exhausts its attempt budget and parks is waiting for an
// event — an `AppState` change, a network transition — that a wedged VPN, a suspended radio or a
// half-open tunnel never produces. The user's only cure is force-quitting the app, which is
// milestone M4's explicit zero ("강제종료로만 낫는 상태 0건").
//
// The fix has two halves and **both** are load-bearing:
//   1. past the cap, keep dialling on a long interval instead of parking;
//   2. **do not increment the attempt counter while trickling.** orca's comment nails the reason
//      (`rpc-client.ts:758-759`): `connection-health`'s "Can't reach desktop" verdict keys off
//      `attempts >= UNREACHABLE_ATTEMPTS`, so a counter that kept climbing would still read
//      unreachable — but one that *reset* on each trickle dial would flip the banner back to
//      "Connecting…" every 90 seconds and hide a permanent outage behind a reassuring label. The
//      counter is pinned, so the verdict is stable and the loop is alive at the same time.
//
// Why this is a file of its own rather than a method on the supervisor, unlike in orca: orca's
// `scheduleReconnect` closes over the socket, the timer and the log emitter, so its policy can only
// be tested by standing up a client. Here the decision is a pure function of one integer and the
// scheduler around it takes its clock by injection, so `./reconnect-policy.test.ts` proves the
// trickle without a transport of any kind. That separation is the port map's `port` grade applied
// literally (02-architecture.md §2.5): the *judgement* crosses over, the I/O does not.
import type { TransportTimer } from '@herdr/client-ts'

// Why: tiered backoff — fast early entries recover blips; the slow tail avoids burning a SYN every 4s on an unreachable desktop.
export const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000]
// Why: ≈6 min of failure before the re-pair banner; MUST stay aligned with connection-health.ts UNREACHABLE_ATTEMPTS.
export const GIVE_UP_AFTER_ATTEMPTS = 12
// Why: never park past the cap — a wedged VPN fires no AppState/network nudge to revive it, so trickle-dial every 90s to self-heal.
export const TRICKLE_RECONNECT_DELAY_MS = 90_000

/** What {@link decideReconnect} concluded. `attempt` is the counter's value *after* the decision. */
export type ReconnectDecision = {
  delayMs: number
  attempt: number
  /** True once the budget is spent: the loop slows down and the counter stops moving. */
  trickle: boolean
}

/**
 * orca `rpc-client.ts:754-770`, as a pure function.
 *
 * Given the attempt counter's current value, says how long to wait and what the counter becomes.
 * The two branches are the whole of L3 and they differ in exactly one way beyond the delay: the
 * trickle branch returns `attempt` unchanged.
 */
export function decideReconnect(reconnectAttempt: number): ReconnectDecision {
  // Why: past the cap, trickle (never park) — a parked loop only revives on a network transition a wedged VPN never produces.
  const pastGiveUpCap = reconnectAttempt >= GIVE_UP_AFTER_ATTEMPTS
  if (pastGiveUpCap) {
    // Why: hold the counter at the cap — connection-health's "Can't reach desktop" verdict keys off attempts >= 12.
    return { delayMs: TRICKLE_RECONNECT_DELAY_MS, attempt: reconnectAttempt, trickle: true }
  }
  const delayMs = RECONNECT_DELAYS[
    Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)
  ] as number
  return { delayMs, attempt: reconnectAttempt + 1, trickle: false }
}

export type ReconnectSchedulerOptions = {
  /** Runs one dial. Never called re-entrantly: the timer is cleared before it fires. */
  dial: () => void
  /** Injected so the receipt can drive a fake clock; defaults to the host's timers. */
  timer: TransportTimer
  /** Observability hook — the M4 receipt records the decision sequence through this. */
  onSchedule?: (decision: ReconnectDecision) => void
}

/**
 * The attempt counter and the timer that L3 governs.
 *
 * One per supervised connection. It owns `reconnectAttempt` because every rule that reads it —
 * L3's cap, L5's "do not pardon an abandoned dial", L6's escalation thresholds — has to agree on
 * one number; orca learned that the hard way in issue #10119, where two code paths disagreed about
 * whether a redial was a fresh start.
 */
export class ReconnectScheduler {
  private readonly options: ReconnectSchedulerOptions
  private attempt = 0
  private handle: unknown = null
  private lastDecision: ReconnectDecision | null = null

  constructor(options: ReconnectSchedulerOptions) {
    this.options = options
  }

  /** The value L6 classifies. Pinned at {@link GIVE_UP_AFTER_ATTEMPTS} once the budget is spent. */
  get reconnectAttempt(): number {
    return this.attempt
  }

  /** True while a dial is armed. A supervisor that is neither connected nor armed is parked — a bug. */
  get armed(): boolean {
    return this.handle !== null
  }

  get lastScheduled(): ReconnectDecision | null {
    return this.lastDecision
  }

  /** Arms the next dial. Re-arming replaces the pending one rather than stacking a second timer. */
  schedule(): ReconnectDecision {
    this.cancel()
    const decision = decideReconnect(this.attempt)
    this.attempt = decision.attempt
    this.lastDecision = decision
    this.options.onSchedule?.(decision)
    this.handle = this.options.timer.setTimeout(() => {
      this.handle = null
      this.options.dial()
    }, decision.delayMs)
    return decision
  }

  /**
   * orca `rpc-client.ts:829-840`. A revival signal dials at once rather than waiting out the armed
   * backoff; only the caller knows whether the attempt that led here should be forgiven.
   *
   * `resetAttempts` is L5's other half. `notifyForeground` passes `!abandoned`: a dial that was
   * abandoned as stale keeps the failure it already represents (it never authenticated, so it is
   * the same failure the connect timeout would have booked), while a redial with no dial to abandon
   * is a genuinely fresh start. Zeroing in the first case would let a flapping network reset the
   * counter faster than it climbs and pin the UI at "Connecting…" through a real outage.
   */
  redialNow(resetAttempts: boolean): void {
    this.cancel()
    if (resetAttempts) {
      this.attempt = 0
    }
    this.options.dial()
  }

  /** A successful handshake. The only place the counter legitimately returns to zero. */
  noteConnected(): void {
    this.cancel()
    this.attempt = 0
  }

  cancel(): void {
    if (this.handle !== null) {
      this.options.timer.clearTimeout(this.handle)
      this.handle = null
    }
  }
}
