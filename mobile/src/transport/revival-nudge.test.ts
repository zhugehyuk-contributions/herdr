// Not from orca. Covers L4's fan-out and, with it, L5's join: a network handoff nudge that reaches
// a supervisor mid-dial is exactly the sequence `rpc-stale-dial.ts` exists for, and the two are only
// correct together.
import { describe, expect, it } from 'vitest'
import { FakeClock, flushMicrotasks } from '../../test/fake-clock'
import { bindConnectionRevival, type RevivalReason } from './revival-nudge'
import { ConnectionSupervisor } from './connection-supervisor'
import { STALE_DIAL_AGE_MS, isStaleForegroundDial } from './rpc-stale-dial'

function triggerSource() {
  let fire: ((reason: RevivalReason) => void) | null = null
  let unsubscribed = 0
  const subscribe = (nudge: (reason: RevivalReason) => void): (() => void) => {
    fire = nudge
    return () => {
      unsubscribed += 1
      fire = null
    }
  }
  return {
    subscribe,
    emit(reason: RevivalReason) {
      fire?.(reason)
    },
    get unsubscribed() {
      return unsubscribed
    }
  }
}

describe('L4 — one signal, every connection', () => {
  it('fans out to all targets and unsubscribes cleanly', () => {
    const source = triggerSource()
    const seen: string[] = []
    const targets = [
      { notifyForeground: (reason: RevivalReason) => seen.push(`a:${reason}`) },
      { notifyForeground: (reason: RevivalReason) => seen.push(`b:${reason}`) }
    ]
    const stop = bindConnectionRevival(() => targets, source.subscribe)
    source.emit('app-resume')
    source.emit('network-change')
    expect(seen).toEqual(['a:app-resume', 'b:app-resume', 'a:network-change', 'b:network-change'])
    stop()
    expect(source.unsubscribed).toBe(1)
    source.emit('app-resume')
    expect(seen).toHaveLength(4)
  })

  it('reads the target set at nudge time, not at subscribe time (X4 in the trigger layer)', () => {
    const source = triggerSource()
    const seen: string[] = []
    let targets = [{ notifyForeground: () => seen.push('first') }]
    bindConnectionRevival(() => targets, source.subscribe)
    targets = [{ notifyForeground: () => seen.push('second') }]
    source.emit('app-resume')
    expect(seen).toEqual(['second'])
  })

  it('one broken connection does not block recovery for the others', () => {
    const source = triggerSource()
    const seen: string[] = []
    const targets = [
      {
        notifyForeground: () => {
          throw new Error('this supervisor is wedged')
        }
      },
      { notifyForeground: () => seen.push('healthy') }
    ]
    bindConnectionRevival(() => targets, source.subscribe)
    expect(() => source.emit('network-change')).not.toThrow()
    expect(seen).toEqual(['healthy'])
  })
})

describe('L5 — the pure rule the nudge lands on', () => {
  it('only dials are stale, and only past 2s', () => {
    expect(STALE_DIAL_AGE_MS).toBe(2_000)
    expect(isStaleForegroundDial('connecting', STALE_DIAL_AGE_MS)).toBe(true)
    expect(isStaleForegroundDial('handshaking', STALE_DIAL_AGE_MS)).toBe(true)
    expect(isStaleForegroundDial('connecting', STALE_DIAL_AGE_MS - 1)).toBe(false)
    // A connection is not a dial; neither is a backoff wait. Abandoning either would be churn.
    expect(isStaleForegroundDial('connected', 60_000)).toBe(false)
    expect(isStaleForegroundDial('reconnecting', 60_000)).toBe(false)
    expect(isStaleForegroundDial('disconnected', 60_000)).toBe(false)
    expect(isStaleForegroundDial('auth-failed', 60_000)).toBe(false)
  })

  it('L4 + L5 together: a handoff during a wedged dial produces a fresh dial', async () => {
    const clock = new FakeClock()
    let dials = 0
    let live = false
    const supervisor = new ConnectionSupervisor({
      dial: (signalHandshaking) => {
        dials += 1
        signalHandshaking()
        if (!live) {
          // The dial the phone was suspended in the middle of. No event will ever settle it.
          return new Promise(() => {})
        }
        return Promise.resolve({ probe: () => true, terminate: () => {} })
      },
      replay: () => Promise.resolve(true),
      timer: clock.timer,
      now: clock.now
    })
    const source = triggerSource()
    bindConnectionRevival(() => [supervisor], source.subscribe)

    supervisor.start()
    await flushMicrotasks()
    expect(dials).toBe(1)
    expect(supervisor.snapshot().state).toBe('handshaking')

    clock.jump(STALE_DIAL_AGE_MS + 1)
    live = true
    source.emit('network-change')
    await flushMicrotasks()

    process.stdout.write(
      `[L4+L5] wedged dial -> ${supervisor.snapshot().state} after ${dials} dials\n`
    )
    expect(dials).toBe(2)
    expect(supervisor.snapshot().state).toBe('connected')
  })
})
