// Not from orca. The phone-less half of the M4 defect `../src/dial-loop.ts` exists for: a remote
// whose *first* ssh dial failed was never dialled again, so the app was dead until it was
// force-quit. Measured on Android twice — 380s and 221s of reachable host, zero TCP dials.
//
// It runs the real loop against a fake `round` and `../../../test/fake-clock.ts`, which is the
// discipline the whole transport layer is built on: time is a value, never a patched global, so
// "the ladder is still dialling after twelve failures" is a deterministic sequence rather than a
// wait. Nothing here touches React, expo or a socket; `../../../src/app-shell/
// failed-dial-redial-mount.test.tsx` is the same defect one layer up, where the screen is.
import { describe, expect, it } from 'vitest'
import { FakeClock, flushMicrotasks } from '../../../test/fake-clock'
import { startSshDialLoop } from '../src/dial-loop'
import { RECONNECT_DELAYS } from '../../../src/transport/reconnect-policy'
import type { DialedRemotes, SshDialState } from '../src/app-connections'
import type { HerdrRemoteConnection } from '../../../src/transport/herdr-connection'

/** A connection object with just the field anything downstream reads by name. */
function connectionFor(id: string): HerdrRemoteConnection {
  return {
    remote: { id, name: id, target: { type: 'ssh', target: `z@${id}` } }
  } as unknown as HerdrRemoteConnection
}

type Outcome = { ok?: readonly string[]; failed?: readonly string[]; fatal?: readonly string[] }

/**
 * The result one dial pass would have produced, in the shape `openConfiguredSshConnections` returns.
 *
 * `fatal` is separated from `failed` because that is the only distinction the loop reads from a
 * round: `retryableIds` is `../../../src/transport/channel-failure.ts`'s verdict, computed one level
 * up in `../src/app-connections.ts`.
 */
function outcome(result: Outcome, closed: string[]): DialedRemotes {
  const ok = result.ok ?? []
  const failed = result.failed ?? []
  const fatal = result.fatal ?? []
  return {
    connections: ok.map(connectionFor),
    transports: ok.map((id) => ({ close: () => void closed.push(id) })),
    failures: [
      ...failed.map((id) => `${id}: Connection refused`),
      ...fatal.map((id) => `${id}: Permission denied (publickey)`)
    ],
    retryableIds: [...failed],
    nativeModuleMissing: false,
    source: 'keystore',
    pushTokenRegistrars: []
  } as unknown as DialedRemotes
}

/** Drives the loop with a scripted sequence of rounds and records every `only` it was asked for. */
function harness(script: readonly Outcome[], options: { foreground?: boolean } = {}) {
  const clock = new FakeClock()
  const asked: (readonly string[] | undefined)[] = []
  const states: SshDialState[] = []
  const closed: string[] = []
  const foreground = { on: options.foreground ?? true }
  let nudge: (() => void) | null = null
  let round = 0
  const loop = startSshDialLoop({
    round: (only) => {
      asked.push(only)
      const step = script[Math.min(round, script.length - 1)] as Outcome
      round += 1
      return Promise.resolve(outcome(step, closed))
    },
    onState: (state) => states.push(state),
    timer: clock.timer,
    isForeground: () => foreground.on,
    subscribeRevival: (fire) => {
      nudge = fire
      return () => {
        nudge = null
      }
    }
  })
  return {
    clock,
    asked,
    states,
    closed,
    foreground,
    loop,
    /** The OS saying "the link probably just came back" — an app resume, or a network change. */
    resume: () => nudge?.(),
    settle: () => flushMicrotasks()
  }
}

describe('the dial loop', () => {
  it('re-dials a remote whose first dial failed — the M4 zero, at the mount layer', async () => {
    const h = harness([{ failed: ['lab'] }])
    await h.settle()
    expect(h.asked.length).toBe(1)
    expect(h.states.at(-1)?.settled).toBe(true)
    expect(h.states.at(-1)?.retrying).toBe(true)

    // Twelve rungs of L3, walked. Before this file, the count after any amount of time was 1.
    for (let i = 0; i < 12; i += 1) {
      h.clock.runNext()
      await h.settle()
    }
    expect(h.asked.length).toBe(13)
    // Every retry pass names the remote that still owes an answer, never the whole list.
    expect(h.asked.slice(1)).toEqual(Array.from({ length: 12 }, () => ['lab']))
    // The delays are L3's, not this file's — nothing here restates a number.
    expect(h.clock.armedDelays.slice(0, RECONNECT_DELAYS.length)).toEqual(RECONNECT_DELAYS)
    h.loop.stop()
  })

  it('spends no dial while the app is backgrounded, and dials on the first rung after it returns', async () => {
    const h = harness([{ failed: ['lab'] }], { foreground: false })
    await h.settle()
    expect(h.asked.length).toBe(1)

    h.clock.advance(30 * 60_000)
    await h.settle()
    // 30 minutes of rungs coming due against a dark screen. This is the number M4's QA measured
    // as a PASS on a device, and the repair must not spend it.
    expect(h.asked.length).toBe(1)

    h.foreground.on = true
    h.clock.runNext()
    await h.settle()
    expect(h.asked.length).toBe(2)
    h.loop.stop()
  })

  it('a foreground resume dials now instead of waiting out the armed rung', async () => {
    const h = harness([{ failed: ['lab'] }])
    await h.settle()
    // Walk far enough up the ladder that the armed rung is a wait a user would notice.
    for (let i = 0; i < 8; i += 1) {
      h.clock.runNext()
      await h.settle()
    }
    expect(h.clock.armedDelays.at(-1)).toBe(60_000)
    const dialsBefore = h.asked.length

    h.resume()
    await h.settle()
    // Immediately — no clock movement at all between the nudge and the dial. QA's escape hatch ①
    // produced zero dials here, which is why the only cure left was the app switcher.
    expect(h.asked.length).toBe(dialsBefore + 1)
    expect(h.asked.at(-1)).toEqual(['lab'])
    h.loop.stop()
  })

  it('keeps the connected remote and re-dials only the one that is down', async () => {
    const h = harness([{ ok: ['iq-64'], failed: ['lab'] }, { ok: ['lab'] }])
    await h.settle()
    const first = h.states.at(-1) as SshDialState
    expect(first.connections.map((c) => c.remote.id)).toEqual(['iq-64'])
    expect(first.retrying).toBe(true)

    h.clock.runNext()
    await h.settle()
    expect(h.asked.at(-1)).toEqual(['lab'])
    const second = h.states.at(-1) as SshDialState
    expect(second.connections.map((c) => c.remote.id)).toEqual(['iq-64', 'lab'])
    expect(second.failures).toEqual([])
    expect(second.retrying).toBe(false)
    // B8: the host that was up all along never had its ssh connection torn down for a neighbour.
    expect(h.closed).toEqual([])

    // ...and with nothing left owing an answer, the ladder is idle rather than trickling.
    h.clock.advance(10 * 60_000)
    await h.settle()
    expect(h.asked.length).toBe(2)
    h.loop.stop()
    expect(h.closed.sort()).toEqual(['iq-64', 'lab'])
  })

  it('latches on a failure a dial cannot change, and says so by not promising a retry', async () => {
    const h = harness([{ fatal: ['lab'] }])
    await h.settle()
    const state = h.states.at(-1) as SshDialState
    expect(state.settled).toBe(true)
    expect(state.failures).toEqual(['lab: Permission denied (publickey)'])
    // A refused key answers the next dial identically; trickling against it is an ssh
    // authentication attempt every 90 seconds, which is a battery cost and a fail2ban ban.
    expect(state.retrying).toBe(false)

    h.clock.advance(60 * 60_000)
    h.resume()
    await h.settle()
    expect(h.asked.length).toBe(1)
    h.loop.stop()
  })

  it('publishes once per observable change, so a repeated failure does not churn the tree', async () => {
    const h = harness([{ failed: ['lab'] }])
    await h.settle()
    const afterFirst = h.states.length
    const connections = h.states.at(-1)?.connections
    for (let i = 0; i < 6; i += 1) {
      h.clock.runNext()
      await h.settle()
    }
    // Six identical failures, no re-render: `src/transport/use-supervised-remotes.ts` reads a new
    // `connections` identity as "these are different transports" and answers by rebuilding every
    // supervisor in the tree.
    expect(h.states.length).toBe(afterFirst)
    expect(h.states.at(-1)?.connections).toBe(connections)
    h.loop.stop()
  })

  it('reports a round that failed before it could name a remote, rather than spinning forever', async () => {
    const clock = new FakeClock()
    const states: SshDialState[] = []
    let asked = 0
    const loop = startSshDialLoop({
      round: () => {
        asked += 1
        return asked === 1
          ? Promise.reject(new Error('keystore unavailable'))
          : Promise.resolve(outcome({ ok: ['lab'] }, []))
      },
      onState: (state) => states.push(state),
      timer: clock.timer,
      isForeground: () => true,
      subscribeRevival: () => () => {}
    })
    await flushMicrotasks()
    // The old code had no catch at all here: the promise rejected, `settled` stayed false, and
    // `src/api/herdr-data-provider.tsx` renders that as a spinner with no end.
    expect(states.at(-1)?.settled).toBe(true)
    expect(states.at(-1)?.failures).toEqual(['configured remotes: keystore unavailable'])
    expect(states.at(-1)?.retrying).toBe(true)

    clock.runNext()
    await flushMicrotasks()
    // Nothing was named, so the retry is the whole list again.
    expect(states.at(-1)?.connections.map((c) => c.remote.id)).toEqual(['lab'])
    loop.stop()
  })

  it('closes a connection that landed after the caller stopped listening', async () => {
    const clock = new FakeClock()
    const closed: string[] = []
    // A box rather than a bare `let`: TypeScript narrows a local assigned only inside a callback to
    // `never` at the call below, and the box is the idiom that keeps the declared type.
    const gate: { release: ((value: DialedRemotes) => void) | null } = { release: null }
    const loop = startSshDialLoop({
      round: () =>
        new Promise<DialedRemotes>((resolve) => {
          gate.release = resolve
        }),
      onState: () => {},
      timer: clock.timer,
      isForeground: () => true,
      subscribeRevival: () => () => {}
    })
    loop.stop()
    gate.release?.(outcome({ ok: ['lab'] }, closed))
    await flushMicrotasks()
    // An ssh connection nobody holds is an sshd session and a remote `herdr` process (B8) that
    // outlive the app's interest in them.
    expect(closed).toEqual(['lab'])
  })
})
