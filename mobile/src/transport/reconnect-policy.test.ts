// Not from orca — orca has no unit test for `scheduleReconnect`, because in orca it is a closure
// inside a 1,224-line client that owns a WebSocket. That absence is the reason #5049 shipped: the
// most important line in mobile/.prd/05-orca-transport.md was, in its home repo, only reachable
// through a live socket. Extracting it (`./reconnect-policy.ts`) makes it a receipt.
//
// What this proves, in the words of the milestone:
//   L3  the loop does not park past the cap, and the attempt counter does not move while it trickles
//   L5  a redial after an abandoned dial does not pardon the attempt it represents
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../test/fake-clock'
import {
  GIVE_UP_AFTER_ATTEMPTS,
  RECONNECT_DELAYS,
  ReconnectScheduler,
  TRICKLE_RECONNECT_DELAY_MS,
  decideReconnect
} from './reconnect-policy'

describe('L3 — decideReconnect', () => {
  it('walks the tiered backoff and increments the attempt below the cap', () => {
    const walk = [...Array.from({ length: 12 }).keys()].map((attempt) => decideReconnect(attempt))
    expect(walk.map((d) => d.delayMs)).toEqual([
      500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000
    ])
    expect(walk.map((d) => d.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(walk.every((d) => !d.trickle)).toBe(true)
    // The tail reuses the last tier rather than running off the end of the table.
    expect(RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1]).toBe(60_000)
  })

  it('past the cap: trickles forever and pins the counter — the #5049 fix, both halves', () => {
    // 500 decisions past the cap. If either half regressed this would show it: a parked loop would
    // have to return no delay (it cannot — the type forbids it), and a counter that kept climbing
    // or reset would show up in the set below.
    const past = Array.from({ length: 500 }, () => decideReconnect(GIVE_UP_AFTER_ATTEMPTS))
    expect(new Set(past.map((d) => d.delayMs))).toEqual(new Set([TRICKLE_RECONNECT_DELAY_MS]))
    expect(new Set(past.map((d) => d.attempt))).toEqual(new Set([GIVE_UP_AFTER_ATTEMPTS]))
    expect(new Set(past.map((d) => d.trickle))).toEqual(new Set([true]))
  })

  it('the trickle threshold is exactly the cap, not one either side of it', () => {
    expect(decideReconnect(GIVE_UP_AFTER_ATTEMPTS - 1).trickle).toBe(false)
    expect(decideReconnect(GIVE_UP_AFTER_ATTEMPTS - 1).attempt).toBe(GIVE_UP_AFTER_ATTEMPTS)
    expect(decideReconnect(GIVE_UP_AFTER_ATTEMPTS).trickle).toBe(true)
  })
})

describe('L3 — ReconnectScheduler', () => {
  function scheduler(clock = new FakeClock()) {
    const dials: number[] = []
    const decisions: { delayMs: number; attempt: number; trickle: boolean }[] = []
    const it = new ReconnectScheduler({
      dial: () => dials.push(clock.now()),
      timer: clock.timer,
      onSchedule: (decision) => decisions.push({ ...decision })
    })
    return { clock, dials, decisions, scheduler: it }
  }

  it('is never parked: 40 consecutive failures leave a timer armed every single time', () => {
    const { clock, dials, decisions, scheduler: sched } = scheduler()
    // Each dial fails, so each fired timer re-schedules — the shape of a real outage.
    for (let round = 0; round < 40; round += 1) {
      sched.schedule()
      expect(sched.armed).toBe(true)
      clock.advance(TRICKLE_RECONNECT_DELAY_MS)
    }
    expect(dials).toHaveLength(40)
    expect(sched.reconnectAttempt).toBe(GIVE_UP_AFTER_ATTEMPTS)

    const trace = decisions.map((d) => `${d.attempt}@${d.delayMs}${d.trickle ? '~' : ''}`)
    process.stdout.write(`[L3] schedule trace: ${trace.join(' ')}\n`)
    // The first twelve climb, the remaining twenty-eight hold at 12 with the 90s trickle.
    expect(trace.slice(0, 13)).toEqual([
      '1@500',
      '2@1000',
      '3@2000',
      '4@4000',
      '5@8000',
      '6@15000',
      '7@30000',
      '8@60000',
      '9@60000',
      '10@60000',
      '11@60000',
      '12@60000',
      '12@90000~'
    ])
    expect(new Set(trace.slice(12))).toEqual(new Set(['12@90000~']))
  })

  it('re-scheduling replaces the armed timer instead of stacking a second one', () => {
    const { clock, dials, scheduler: sched } = scheduler()
    sched.schedule()
    sched.schedule()
    sched.schedule()
    expect(clock.pending).toBe(1)
    clock.advance(60_000)
    expect(dials).toHaveLength(1)
  })

  it('L5 — redialNow(false) keeps the failure the abandoned dial represents', () => {
    const { dials, scheduler: sched } = scheduler()
    sched.schedule()
    sched.schedule()
    sched.schedule()
    expect(sched.reconnectAttempt).toBe(3)

    sched.redialNow(false)
    expect(dials).toHaveLength(1)
    // Not pardoned. This is issue #10119: zeroing here lets a flapping network reset the counter
    // faster than it climbs, pinning the card at "Connecting…" through a real outage.
    expect(sched.reconnectAttempt).toBe(3)

    sched.redialNow(true)
    expect(sched.reconnectAttempt).toBe(0)
  })

  it('redialNow cancels the armed backoff — no double dial', () => {
    const { clock, dials, scheduler: sched } = scheduler()
    sched.schedule()
    sched.redialNow(false)
    expect(dials).toHaveLength(1)
    clock.advance(120_000)
    expect(dials).toHaveLength(1)
  })

  it('only a real connection resets the counter, and it disarms the loop', () => {
    const { clock, dials, scheduler: sched } = scheduler()
    sched.schedule()
    sched.schedule()
    sched.noteConnected()
    expect(sched.reconnectAttempt).toBe(0)
    expect(sched.armed).toBe(false)
    clock.advance(120_000)
    expect(dials).toHaveLength(0)
  })
})
