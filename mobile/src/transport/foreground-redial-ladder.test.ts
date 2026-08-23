// Not from orca. The receipt for the shape `../session/pane-reattach.ts` and
// `../../modules/herdr-ssh/src/dial-loop.ts` both build on, proved once here instead of twice there.
//
// What it holds:
//   L3   the ladder walks `./reconnect-policy.ts`'s tiers and never parks — including while the
//        gate is closed, which is the failure mode that would otherwise hide behind "no dials".
//   §Q   a backgrounded app spends no dial, and the rung it skipped is re-armed rather than dropped.
//   L4   a revival dials now instead of waiting out the armed rung, and resets the counter.
//   L6/7 a latch is terminal for this ladder: nothing arms it and nothing revives it.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../test/fake-clock'
import { ForegroundRedialLadder } from './foreground-redial-ladder'
import { RECONNECT_DELAYS, TRICKLE_RECONNECT_DELAY_MS } from './reconnect-policy'

function ladder(foreground: { on: boolean } = { on: true }) {
  const clock = new FakeClock()
  const dials: number[] = []
  const it = new ForegroundRedialLadder({
    dial: () => dials.push(clock.now()),
    timer: clock.timer,
    isForeground: () => foreground.on
  })
  return { clock, dials, foreground, ladder: it }
}

describe('ForegroundRedialLadder', () => {
  it('walks L3 tiers on repeated failure and is armed after every one of them', () => {
    const { clock, dials, ladder: it } = ladder()
    for (let i = 0; i < 12; i += 1) {
      it.arm()
      expect(it.armed).toBe(true)
      clock.runNext()
    }
    expect(dials.length).toBe(12)
    expect(clock.armedDelays).toEqual(RECONNECT_DELAYS.concat([60_000, 60_000, 60_000, 60_000]))
    // Past the cap it trickles rather than parking — #5049's whole fix, inherited not restated.
    it.arm()
    expect(clock.armedDelays.at(-1)).toBe(TRICKLE_RECONNECT_DELAY_MS)
    expect(it.armed).toBe(true)
  })

  it('spends no dial while the app is backgrounded, and stays armed the whole time', () => {
    const { clock, dials, foreground, ladder: it } = ladder({ on: false })
    it.arm()
    // Half an hour of rungs coming due against a dark screen. M4's QA measured exactly this window
    // on a device and recorded zero dials as a PASS.
    clock.advance(30 * 60_000)
    expect(dials).toEqual([])
    expect(it.attemptCount).toBe(0)
    expect(it.armed).toBe(true)

    // ...and the loop was never parked: the first rung after the screen comes back dials.
    foreground.on = true
    clock.runNext()
    expect(dials.length).toBe(1)
  })

  it('a revival dials now rather than waiting out the armed rung, and resets the counter', () => {
    const { clock, dials, ladder: it } = ladder()
    for (let i = 0; i < 5; i += 1) {
      it.arm()
      clock.runNext()
    }
    expect(it.attempt).toBe(5)
    const armedBefore = clock.armedDelays.length

    it.arm()
    // The rung it is now waiting on is 15s away; the revival must not cost the user that.
    expect(clock.armedDelays.at(-1)).toBe(15_000)
    const at = clock.now()
    it.reviveNow()
    expect(dials.at(-1)).toBe(at)
    expect(dials.length).toBe(6)
    expect(it.attempt).toBe(0)
    // The abandoned rung was cancelled, not left to fire a second dial later.
    clock.advance(60_000)
    expect(dials.length).toBe(6)
    expect(clock.armedDelays.length).toBe(armedBefore + 1)
  })

  it('a revival while backgrounded re-arms instead of dialling', () => {
    const { dials, ladder: it } = ladder({ on: false })
    it.arm()
    it.reviveNow()
    expect(dials).toEqual([])
    // A network-change nudge can arrive with the screen off; the gate holds and the loop lives.
    expect(it.armed).toBe(true)
  })

  it('a latch is terminal — nothing arms it, nothing revives it', () => {
    const { clock, dials, ladder: it } = ladder()
    it.arm()
    it.latch()
    expect(it.armed).toBe(false)
    it.arm()
    it.reviveNow()
    clock.advance(10 * 60_000)
    expect(dials).toEqual([])
    expect(it.latched).toBe(true)
  })

  it('assumes the screen is on when no gate is supplied — the headless caller', () => {
    const clock = new FakeClock()
    const dials: number[] = []
    const it = new ForegroundRedialLadder({
      dial: () => dials.push(clock.now()),
      timer: clock.timer
    })
    it.arm()
    clock.runNext()
    expect(dials.length).toBe(1)
    it.noteConnected()
    expect(it.armed).toBe(false)
    expect(it.attempt).toBe(0)
  })
})
