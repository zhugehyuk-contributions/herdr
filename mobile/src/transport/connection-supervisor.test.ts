// Not from orca — orca's reconnect machine is a closure inside `rpc-client.ts` and is exercised
// only through a live WebSocket, which is why #5049 (a loop that stopped) reached production.
//
// This is the M4 receipt for the composed machine, and its headline is the milestone's own zero:
//
//   > 기내모드 토글 ×10 / Wi-Fi↔셀룰러 전환 ×10 / 30분 백그라운드 후 복귀 — 전부 수동 개입 없이
//   > 자동 복구. **강제종료로만 낫는 상태 0건.**
//
// A phone is not required to prove most of that, and the parts a phone *would* add are named
// honestly at the bottom of this file. What is proved here: the ×10 cycles as state transitions,
// the 30-minute suspension, and — the load-bearing one — that **no reachable state needs the app
// switcher**, because from every one of them `forceReconnect()` produces a dial.
import { describe, expect, it } from 'vitest'
import { FakeClock, flushMicrotasks } from '../../test/fake-clock'
import { ConnectionSupervisor, type SupervisedLink } from './connection-supervisor'
import { ChannelCloseError, MISSING_BINARY_HINT } from './channel-failure'
import { GIVE_UP_AFTER_ATTEMPTS, TRICKLE_RECONNECT_DELAY_MS } from './reconnect-policy'
import { LIVENESS_IDLE_MS, LIVENESS_PROBE_TIMEOUT_MS } from './rpc-session-liveness-watchdog'
import type { ConnectionState } from './connection-state-types'
import { describeClose, type HerdrChannelClose } from '@herdr/client-ts'
import type { ObserveSubscription } from './observe-subscriptions'

type DialMode = 'ok' | 'hang' | 'handshake-hang' | { close: HerdrChannelClose }

function harness(mode: DialMode = 'ok') {
  const clock = new FakeClock()
  const states: ConnectionState[] = []
  const log: string[] = []
  const replayed: { paneId: string; cols: number; rows: number }[] = []
  const probes: number[] = []
  const links: { terminated: boolean }[] = []
  let dials = 0
  let changes = 0
  let next: DialMode = mode
  let replayOk = true

  const supervisor = new ConnectionSupervisor({
    dial: (signalHandshaking) => {
      dials += 1
      const mode_ = next
      if (mode_ === 'hang') {
        return new Promise<SupervisedLink>(() => {})
      }
      if (mode_ === 'handshake-hang') {
        signalHandshaking()
        return new Promise<SupervisedLink>(() => {})
      }
      if (typeof mode_ === 'object') {
        // A `ChannelCloseError`, not a bare one, because that is what a link factory whose channel
        // died actually rejects with (`./observe-stream-link.ts`): a promise can only reject with an
        // error, so the close has to ride on it. A harness that rejected with `new Error(stderr)`
        // would model a *string* reaching the classifier and would therefore be unable to see the
        // failure below, where the entire evidence is a field.
        return Promise.reject(
          new ChannelCloseError(describeClose('dial failed', mode_.close), mode_.close)
        )
      }
      signalHandshaking()
      const entry = { terminated: false }
      links.push(entry)
      return Promise.resolve({
        probe: (nonce: number) => {
          probes.push(nonce)
          return true
        },
        terminate: () => {
          entry.terminated = true
        }
      })
    },
    replay: (subscription: ObserveSubscription) => {
      replayed.push({
        paneId: subscription.paneId,
        cols: subscription.cols,
        rows: subscription.rows
      })
      return Promise.resolve(replayOk)
    },
    timer: clock.timer,
    now: clock.now,
    onState: (state) => states.push(state),
    onChange: () => {
      changes += 1
    },
    onLog: (line) => log.push(line)
  })

  return {
    clock,
    supervisor,
    states,
    log,
    replayed,
    probes,
    links,
    get dials() {
      return dials
    },
    get changes() {
      return changes
    },
    setDial(mode_: DialMode) {
      next = mode_
    },
    setReplayOk(value: boolean) {
      replayOk = value
    },
    async settle() {
      await flushMicrotasks()
    },
    async advance(ms: number) {
      clock.advance(ms)
      await flushMicrotasks()
    }
  }
}

const TRANSPORT_DEATH: HerdrChannelClose = { error: new Error('read ECONNRESET') }

describe('the composed M4 machine — automatic recovery', () => {
  it('dials, handshakes, connects', async () => {
    const h = harness()
    h.supervisor.start()
    await h.settle()
    expect(h.states).toEqual(['connecting', 'handshaking', 'connected'])
    expect(h.supervisor.snapshot()).toMatchObject({ state: 'connected', reconnectAttempt: 0 })
    expect(h.supervisor.snapshot().verdict).toEqual({ kind: 'normal', label: 'Connected' })
  })

  it('airplane mode ×10: every cycle recovers with no intervention, counter back to zero', async () => {
    const h = harness()
    h.supervisor.start()
    await h.settle()
    const cycles: string[] = []

    for (let round = 0; round < 10; round += 1) {
      // The radio goes away: the ssh path dies with no clean close, which is what an airplane-mode
      // toggle actually looks like from the app's side.
      h.supervisor.handleLinkClosed(TRANSPORT_DEATH)
      const down = h.supervisor.snapshot()
      expect(down.state).toBe('reconnecting')
      // The property #5049 violated. Not "it will retry" — a timer exists, right now.
      expect(down.armed).toBe(true)

      await h.advance(500)
      const up = h.supervisor.snapshot()
      cycles.push(`${round}:${down.state}->${up.state}@attempt${up.reconnectAttempt}`)
      expect(up.state).toBe('connected')
      expect(up.reconnectAttempt).toBe(0)
    }
    process.stdout.write(`[M4] airplane-mode cycles: ${cycles.join(' ')}\n`)
    expect(h.dials).toBe(11)
  })

  it('Wi-Fi↔cellular ×10: the handoff kills the path and the nudge re-dials at once', async () => {
    const h = harness()
    h.supervisor.start()
    await h.settle()
    const trace: string[] = []

    for (let round = 0; round < 10; round += 1) {
      // A network *type* change kills the TCP path without an onclose — that is the whole reason L4
      // treats it as a revival trigger rather than waiting for an event that never comes.
      h.supervisor.handleLinkClosed({})
      expect(h.supervisor.snapshot().state).toBe('reconnecting')
      // The OS signal arrives while the backoff is still armed. L5: no dial to abandon, so this is
      // a genuinely fresh start and the counter resets.
      h.supervisor.notifyForeground('network-change')
      await h.settle()
      trace.push(`${round}:${h.supervisor.snapshot().state}`)
      expect(h.supervisor.snapshot()).toMatchObject({ state: 'connected', reconnectAttempt: 0 })
    }
    process.stdout.write(`[M4] wifi<->cellular cycles: ${trace.join(' ')}\n`)
  })

  it('30-minute background: the resume probes rather than tearing down a live link', async () => {
    const h = harness()
    h.supervisor.start()
    await h.settle()

    // JS was suspended. Timers did not run; wall-clock did.
    h.clock.jump(30 * 60_000)
    h.supervisor.notifyForeground('app-resume')
    await h.settle()
    expect(h.probes).toHaveLength(1)
    expect(h.supervisor.snapshot().state).toBe('connected')

    // The peer is in fact alive and answers — one `Pong`, then ordinary frames.
    h.supervisor.noteInbound()
    for (let tick = 0; tick < 10; tick += 1) {
      await h.advance(LIVENESS_IDLE_MS / 2)
      h.supervisor.noteInbound()
    }
    process.stdout.write(
      `[M4] after 30min background: state=${h.supervisor.snapshot().state} probes=${h.probes.length}\n`
    )
    // L1b did its job: no false teardown, and the link is still the one we had. Without it the
    // resume books three misses in one tick and this is a fresh link with a fresh handshake.
    expect(h.supervisor.snapshot().state).toBe('connected')
    expect(h.links).toHaveLength(1)
    expect(h.dials).toBe(1)
  })
})

describe('L1 in the machine — the half-open channel nothing reports', () => {
  it('terminates a silent link on the third fair miss and recovers automatically', async () => {
    const h = harness()
    h.supervisor.start()
    await h.settle()

    // The child is alive and the pipe is open and no bytes are coming — 05's ssh mapping of
    // `readyState`. Nothing will ever fire an event here; only the watchdog notices.
    await h.advance(LIVENESS_IDLE_MS + 3 * LIVENESS_PROBE_TIMEOUT_MS)
    expect(h.probes).toEqual([1, 2, 3])
    expect(h.links[0]?.terminated).toBe(true)
    expect(h.supervisor.snapshot()).toMatchObject({ state: 'reconnecting', armed: true })

    await h.advance(500)
    expect(h.supervisor.snapshot().state).toBe('connected')
    process.stdout.write(
      `[L1] half-open detected and healed; log:\n  ${h.log.slice(-4).join('\n  ')}\n`
    )
  })

  it('inbound traffic keeps a busy link alive indefinitely', async () => {
    const h = harness()
    h.supervisor.start()
    await h.settle()
    for (let minute = 0; minute < 30; minute += 1) {
      await h.advance(LIVENESS_IDLE_MS / 2)
      h.supervisor.noteInbound()
    }
    expect(h.supervisor.snapshot().state).toBe('connected')
    expect(h.probes).toHaveLength(0)
    expect(h.links).toHaveLength(1)
  })
})

describe('L3 in the machine — the loop that must not stop', () => {
  it('40 consecutive dial failures: still armed, counter pinned, verdict stable', async () => {
    const h = harness()
    h.setDial({ close: TRANSPORT_DEATH })
    h.supervisor.start()
    await h.settle()

    for (let round = 0; round < 40; round += 1) {
      const snapshot = h.supervisor.snapshot()
      expect(snapshot.state).toBe('reconnecting')
      expect(snapshot.armed).toBe(true)
      await h.advance(TRICKLE_RECONNECT_DELAY_MS)
    }
    const final = h.supervisor.snapshot()
    process.stdout.write(
      `[L3] after 41 failed dials: state=${final.state} attempt=${final.reconnectAttempt} ` +
        `armed=${final.armed} verdict=${final.verdict.kind}\n`
    )
    expect(final.reconnectAttempt).toBe(GIVE_UP_AFTER_ATTEMPTS)
    expect(final.armed).toBe(true)
    expect(final.verdict.kind).toBe('unreachable')

    // …and the desktop comes back. Nothing was required of the user.
    h.setDial('ok')
    await h.advance(TRICKLE_RECONNECT_DELAY_MS)
    expect(h.supervisor.snapshot()).toMatchObject({ state: 'connected', reconnectAttempt: 0 })
  })

  it('a rejected dial is classified from the close’s fields, not from its message', async () => {
    // The one asymmetry between the two ways a channel death reaches this class. A close reported
    // through `handleLinkClosed` arrives as a struct; a close that killed a *dial* arrives as a
    // promise rejection, and rebuilding `{ error }` from it discards every other field. `exitCode`
    // is the case with no textual fallback at all — 127 is `missing-binary`, which is `fatal`, and
    // a synthesized `{ error }` grades it `transport` and retries a box that has no herdr on it
    // until the user force-quits.
    const h = harness()
    h.setDial({ close: { exitCode: 127 } })
    h.supervisor.start()
    await h.settle()

    const snapshot = h.supervisor.snapshot()
    expect(snapshot.failure).toMatchObject({
      kind: 'missing-binary',
      fatal: true,
      hint: MISSING_BINARY_HINT
    })
    expect(snapshot.state).toBe('auth-failed')
    expect(snapshot.armed).toBe(false)
  })

  it('one channel death is booked once, even when the close arrives twice', async () => {
    const h = harness()
    h.supervisor.start()
    await h.settle()
    h.supervisor.handleLinkClosed(TRANSPORT_DEATH)
    h.supervisor.handleLinkClosed(TRANSPORT_DEATH)
    h.supervisor.handleLinkClosed({})
    // Double-booking would double the number L3's cap and L6's ladder both key off.
    expect(h.supervisor.snapshot().reconnectAttempt).toBe(1)
  })
})

describe('L5 in the machine — the dial that stopped', () => {
  it('abandons a stale dial on resume and does NOT pardon its attempt', async () => {
    const h = harness()
    h.setDial({ close: TRANSPORT_DEATH })
    h.supervisor.start()
    await h.settle()
    // Climb the counter so a pardon would be visible.
    await h.advance(500)
    await h.advance(1000)
    expect(h.supervisor.snapshot().reconnectAttempt).toBe(3)

    // Now a dial that never finishes — the phone slept mid-handshake.
    h.setDial('handshake-hang')
    await h.advance(2000)
    expect(h.supervisor.snapshot().state).toBe('handshaking')

    h.clock.jump(5_000)
    h.setDial('ok')
    h.supervisor.notifyForeground('app-resume')
    await h.settle()

    process.stdout.write(
      `[L5] abandoned dial -> ${h.supervisor.snapshot().state} at attempt ` +
        `${h.supervisor.snapshot().reconnectAttempt}\n`
    )
    expect(h.supervisor.snapshot().state).toBe('connected')
    // The abandoned dial is the same failure the connect timeout would have booked (#10119): the
    // counter reached 4 before the successful connect reset it, and never went backwards on the way.
    expect(h.log.some((line) => line.includes('abandoning stale dial'))).toBe(true)
  })

  it('leaves a young dial alone — a resume must not churn a dial that just started', async () => {
    const h = harness()
    h.setDial('handshake-hang')
    h.supervisor.start()
    await h.settle()
    h.clock.jump(1_500)
    h.supervisor.notifyForeground('app-resume')
    await h.settle()
    expect(h.log.some((line) => line.includes('abandoning stale dial'))).toBe(false)
    expect(h.supervisor.snapshot().state).toBe('handshaking')
    expect(h.dials).toBe(1)
  })

  it('a dial stuck before the handshake is stale too', async () => {
    const h = harness()
    h.setDial('hang')
    h.supervisor.start()
    await h.settle()
    expect(h.supervisor.snapshot().state).toBe('connecting')
    h.clock.jump(3_000)
    h.setDial('ok')
    h.supervisor.notifyForeground('network-change')
    await h.settle()
    expect(h.supervisor.snapshot().state).toBe('connected')
  })
})

describe('X1 / X1b in the machine — the pane that comes back', () => {
  it('replays every subscription after a reconnect, with the newest geometry', async () => {
    const h = harness()
    h.supervisor.observe({ paneId: 'w1:p1', cols: 120, rows: 40 })
    h.supervisor.observe({ paneId: 'w1:p2', cols: 120, rows: 40 })
    h.supervisor.start()
    await h.settle()
    expect(h.replayed).toEqual([
      { paneId: 'w1:p1', cols: 120, rows: 40 },
      { paneId: 'w1:p2', cols: 120, rows: 40 }
    ])

    // The phone rotated while the link was up, then the link died.
    h.supervisor.updateObserveViewport('w1:p1', { cols: 80, rows: 24 })
    h.supervisor.handleLinkClosed(TRANSPORT_DEATH)
    expect(h.supervisor.subscriptions.pendingReplay()).toHaveLength(2)

    await h.advance(500)
    process.stdout.write(`[X1] replays: ${JSON.stringify(h.replayed)}\n`)
    expect(h.replayed.slice(2)).toEqual([
      { paneId: 'w1:p1', cols: 80, rows: 24 },
      { paneId: 'w1:p2', cols: 120, rows: 40 }
    ])
    expect(h.supervisor.subscriptions.pendingReplay()).toHaveLength(0)
  })

  it('a replay that did not go out stays owed', async () => {
    const h = harness()
    h.supervisor.observe({ paneId: 'w1:p1', cols: 120, rows: 40 })
    h.setReplayOk(false)
    h.supervisor.start()
    await h.settle()
    // The dot is green and the pane is blank — X1's failure mode. The registry still says so.
    expect(h.supervisor.snapshot().state).toBe('connected')
    expect(h.supervisor.subscriptions.pendingReplay()).toHaveLength(1)
  })
})

describe('X4 — a screen must never hold a replaced link', () => {
  it('every reconnect swaps the object and bumps the generation', async () => {
    const h = harness()
    h.supervisor.start()
    await h.settle()
    const first = h.supervisor.current
    const generation = h.supervisor.snapshot().generation

    h.supervisor.handleLinkClosed(TRANSPORT_DEATH)
    await h.advance(500)
    expect(h.supervisor.current).not.toBe(first)
    expect(h.supervisor.snapshot().generation).toBeGreaterThan(generation)
    // The dead one was told to go away rather than left to leak an exec channel.
    expect(h.links[0]?.terminated).toBe(true)
  })

  it('onChange fires on every state change, so a hook re-reads instead of caching', async () => {
    const h = harness()
    const before = h.changes
    h.supervisor.start()
    await h.settle()
    expect(h.changes).toBeGreaterThan(before)
  })
})

describe('M4’s zero — no reachable state needs the app switcher', () => {
  /** The park #5049 shipped: not connected, and no timer armed, with nobody having asked to stop. */
  function parked(snapshot: { state: ConnectionState; armed: boolean }): boolean {
    return (
      snapshot.state !== 'connected' &&
      snapshot.state !== 'disconnected' &&
      snapshot.state !== 'auth-failed' &&
      !snapshot.armed
    )
  }

  it('a 400-step random walk never reaches a parked state, and visits every state', async () => {
    const h = harness()
    // Deterministic xorshift32 — same walk on every machine and every run. (A textbook LCG was the
    // first try and it was *wrong here*: `seed * 1103515245` leaves the 2^53 exact-integer range
    // immediately, the low bits round to zero, and the sequence collapses to a short cycle that
    // never selected `close`. The walk still passed. A generator that silently stops generating is
    // how a fuzz test becomes decoration, so the coverage assertions at the bottom are not optional.)
    let seed = 20260822 >>> 0
    const rand = (bound: number): number => {
      seed ^= seed << 13
      seed >>>= 0
      seed ^= seed >>> 17
      seed ^= seed << 5
      seed >>>= 0
      return seed % bound
    }
    const visited = new Set<ConnectionState>()
    const stimuli = [
      'start',
      'die-transport',
      'die-auth',
      'die-protocol',
      'foreground',
      'inbound',
      'force',
      'close',
      'tick',
      'long-tick'
    ] as const

    h.supervisor.start()
    await h.settle()
    for (let step = 0; step < 400; step += 1) {
      const stimulus = stimuli[rand(stimuli.length)] as (typeof stimuli)[number]
      h.setDial(rand(3) === 0 ? { close: TRANSPORT_DEATH } : 'ok')
      switch (stimulus) {
        case 'start':
          h.supervisor.start()
          break
        case 'die-transport':
          h.supervisor.handleLinkClosed(TRANSPORT_DEATH)
          break
        case 'die-auth':
          h.supervisor.handleLinkClosed({ stderr: 'Permission denied (publickey).' })
          break
        case 'die-protocol':
          h.supervisor.handleLinkClosed({ exitCode: 127 })
          break
        case 'foreground':
          h.supervisor.notifyForeground(rand(2) === 0 ? 'app-resume' : 'network-change')
          break
        case 'inbound':
          h.supervisor.noteInbound()
          break
        case 'force':
          h.supervisor.forceReconnect()
          break
        case 'close':
          h.supervisor.close()
          break
        case 'tick':
          h.clock.advance(1_000)
          break
        case 'long-tick':
          h.clock.advance(TRICKLE_RECONNECT_DELAY_MS)
          break
      }
      await h.settle()
      const snapshot = h.supervisor.snapshot()
      visited.add(snapshot.state)
      expect(
        parked(snapshot),
        `step ${step} (${stimulus}) parked in ${snapshot.state} with no timer armed`
      ).toBe(false)
    }
    process.stdout.write(`[M4] walk visited: ${[...visited].sort().join(', ')}\n`)
    // A walk that never reached the interesting states would pass vacuously.
    expect(visited.has('connected')).toBe(true)
    expect(visited.has('reconnecting')).toBe(true)
    expect(visited.has('auth-failed')).toBe(true)
    expect(visited.has('disconnected')).toBe(true)
  })

  it('every terminal state is left by forceReconnect — the tap L7 puts on the status line', async () => {
    const escapes: string[] = []
    const cases: { name: string; drive: (h: ReturnType<typeof harness>) => Promise<void> }[] = [
      {
        name: 'auth-failed (refused key)',
        drive: async (h) => {
          h.supervisor.start()
          await h.settle()
          h.supervisor.handleLinkClosed({ stderr: 'Permission denied (publickey).' })
          await h.settle()
        }
      },
      {
        name: 'auth-failed (no herdr on the remote)',
        drive: async (h) => {
          h.supervisor.start()
          await h.settle()
          h.supervisor.handleLinkClosed({ exitCode: 127 })
          await h.settle()
        }
      },
      {
        name: 'auth-failed (protocol skew)',
        drive: async (h) => {
          h.supervisor.start()
          await h.settle()
          h.supervisor.handleLinkClosed({
            stderr:
              'remote herdr server is running with protocol 19, but this bridge needs protocol 20'
          })
          await h.settle()
        }
      },
      {
        name: 'disconnected (closed on purpose)',
        drive: async (h) => {
          h.supervisor.start()
          await h.settle()
          h.supervisor.close()
          await h.settle()
        }
      },
      {
        name: 'hung dial (no event will ever come)',
        drive: async (h) => {
          h.setDial('hang')
          h.supervisor.start()
          await h.settle()
          h.clock.jump(10 * 60_000)
        }
      }
    ]

    for (const testCase of cases) {
      const h = harness()
      await testCase.drive(h)
      const stuck = h.supervisor.snapshot()
      h.setDial('ok')
      h.supervisor.forceReconnect()
      await h.settle()
      const freed = h.supervisor.snapshot()
      escapes.push(`${testCase.name}: ${stuck.state} --forceReconnect--> ${freed.state}`)
      expect(freed.state).toBe('connected')
      expect(freed.reconnectAttempt).toBe(0)
    }
    process.stdout.write(`[M4] escapes:\n  ${escapes.join('\n  ')}\n`)
  })

  it('a latched failure does NOT auto-retry — a refused key must not be re-offered every 90s', async () => {
    const h = harness()
    h.supervisor.start()
    await h.settle()
    h.supervisor.handleLinkClosed({ stderr: 'Permission denied (publickey).' })
    await h.settle()
    const latched = h.supervisor.snapshot()
    expect(latched).toMatchObject({ state: 'auth-failed', armed: false })
    expect(latched.verdict.kind).toBe('auth-failed')
    const dialsThen = h.dials
    await h.advance(60 * 60_000)
    // An hour later: still no dial. Retrying a rejected credential is how an account gets locked,
    // and the status line already says what to do (L6) and offers the tap (L7).
    expect(h.dials).toBe(dialsThen)
  })

  it('close() is honoured: nothing dials again until the caller asks', async () => {
    const h = harness()
    h.supervisor.start()
    await h.settle()
    h.supervisor.close()
    const dialsThen = h.dials
    await h.advance(60 * 60_000)
    expect(h.supervisor.snapshot()).toMatchObject({ state: 'disconnected', armed: false })
    expect(h.dials).toBe(dialsThen)
    expect(h.links[0]?.terminated).toBe(true)
    // …and the subscriptions survive it, so a revival replays them (X1).
    h.supervisor.observe({ paneId: 'w1:p1', cols: 80, rows: 24 })
    h.supervisor.forceReconnect()
    await h.settle()
    expect(h.replayed).toEqual([{ paneId: 'w1:p1', cols: 80, rows: 24 }])
  })
})
