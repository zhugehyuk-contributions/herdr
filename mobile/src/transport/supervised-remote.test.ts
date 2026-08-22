// Not from orca. `./connection-supervisor.test.ts` proves the state machine; this proves the two
// things the React layer adds on top of it and that a state-machine test cannot see:
//
//   1. the **fan-out** — one `onChange` reaching N readers, with the snapshot identity stable
//      between changes, which is `useSyncExternalStore`'s contract and an infinite render loop if
//      it is broken;
//   2. the **link factory** (`./observe-stream-link.ts`) — that a dial really is `openTerminalStream`
//      + `Hello` + a checked `Welcome`, that a replay really is `ObserveTerminal` +
//      `RequestFullFrame`, and that a probe really is `ClientMessage::Ping` on the wire.
//
// (2) is asserted in **hex against the scripted channel**, not through a spy, because the whole
// point of the seam is that the bytes are the contract: `test/live/paneViewerOutage.live.test.tsx`
// swaps this link for one that redials a real ssh connection, and only identical bytes make the two
// receipts talk about the same machine.
import { describe, expect, it } from 'vitest'
import { HerdrChannelKind } from '@herdr/client-ts'
import {
  FakeTransport,
  type FakeChannel
} from '../../../packages/herdr-client-ts/test/fakeTransport'
import { frameHex, fromHex, toHex } from '../../../packages/herdr-client-ts/test/helpers'
import { WELCOME_OK_ANSI_V21 } from '../../../packages/herdr-client-ts/test/vectors'
import { FakeClock, flushMicrotasks } from '../../test/fake-clock'
import { createWireAbiGate } from '../../test/wire-abi-peer'
import { SupervisedRemote } from './supervised-remote'
import { createObserveStreamLink, HEALTH_LINK_COLS, HEALTH_LINK_ROWS } from './observe-stream-link'
import { createTransportConnection } from './herdr-connection'
import { CLIENT_MESSAGE_PING_TAG, encodePing } from './client-ping'
import type { RemoteDefinition } from '../api/herdr-api-types'

const REMOTE: RemoteDefinition = { id: 'scratch', name: 'scratch', target: { type: 'local' } }

/** `ClientMessage` payloads per client-stream channel, in the order the channels were opened. */
type Scripted = {
  transport: FakeTransport
  streams: FakeChannel[]
  sent: string[][]
  /** Answers `Hello` with the accepted `Welcome`. Off = a bridge that never speaks (L5's case). */
  welcome: boolean
}

function scriptedTransport(): Scripted {
  const transport = new FakeTransport()
  const streams: FakeChannel[] = []
  const sent: string[][] = []
  const state: Scripted = { transport, streams, sent, welcome: true }
  transport.onOpen = (channel: FakeChannel) => {
    if (channel.kind !== HerdrChannelKind.ClientStream) {
      return
    }
    const index = streams.push(channel) - 1
    sent.push([])
    const write = channel.write.bind(channel)
    // The dial opens with the 28-byte wire-ABI prelude, which the server reads and validates before
    // any bincode. Consuming it here keeps `sent` a list of `ClientMessage`s — the hex the live
    // receipt compares against — instead of a list of writes.
    const wireAbi = createWireAbiGate()
    channel.write = (bytes: Uint8Array) => {
      write(bytes)
      const framed = wireAbi(bytes)
      if (framed === null) {
        return
      }
      const payload = framed.subarray(4)
      sent[index]!.push(toHex(payload))
      // 0x00 is `ClientMessage::Hello` (`packages/herdr-client-ts/src/messages.ts`).
      if (payload[0] === 0x00 && state.welcome) {
        channel.emit(fromHex(frameHex(WELCOME_OK_ANSI_V21)))
      }
    }
  }
  return state
}

function harness(script = scriptedTransport()) {
  const clock = new FakeClock()
  const connection = createTransportConnection(REMOTE, script.transport)
  const log: string[] = []
  const remote = new SupervisedRemote({
    remoteId: REMOTE.id,
    link: createObserveStreamLink({ connection, onLog: (line) => log.push(line) }),
    timer: clock.timer,
    now: clock.now,
    onLog: (line) => log.push(line)
  })
  return { clock, script, remote, log }
}

describe('SupervisedRemote', () => {
  it('fans one supervisor change out to every reader, and hands out no link', async () => {
    const { remote, clock } = harness()
    const seen: number[] = []
    const unsubscribeA = remote.subscribe(() => seen.push(1))
    remote.subscribe(() => seen.push(2))

    expect(remote.getSnapshot().state).toBe('disconnected')
    remote.start()
    await flushMicrotasks()
    clock.advance(0)
    await flushMicrotasks()

    expect(remote.getSnapshot().state).toBe('connected')
    // Both readers were told, repeatedly and in registration order.
    expect(seen.length).toBeGreaterThan(1)
    expect(new Set(seen)).toEqual(new Set([1, 2]))

    unsubscribeA()
    const before = seen.length
    remote.close()
    expect(seen.slice(before)).not.toContain(1)
    // X4: the store exposes a *snapshot*, never the `SupervisedLink` a screen could hold past a
    // reconnect. `probe`/`terminate` exist only on the object the supervisor keeps.
    expect(Object.keys(remote.getSnapshot()).sort()).toEqual([
      'armed',
      'failure',
      'generation',
      'lastConnectedAt',
      'reconnectAttempt',
      'state',
      'verdict'
    ])
  })

  it('keeps the snapshot referentially stable between changes (useSyncExternalStore’s contract)', async () => {
    const { remote, clock } = harness()
    remote.start()
    await flushMicrotasks()
    clock.advance(0)
    await flushMicrotasks()

    const first = remote.getSnapshot()
    expect(remote.getSnapshot()).toBe(first)
    expect(remote.getSnapshot()).toBe(first)
    // …and a *new* object once something actually changed. Returning the same one here would be the
    // opposite bug: a screen that never repaints a failure.
    remote.close()
    expect(remote.getSnapshot()).not.toBe(first)
    expect(remote.getSnapshot().state).toBe('disconnected')
  })

  it('dials the client-stream bridge with Hello and checks the Welcome', async () => {
    const { remote, clock, script, log } = harness()
    remote.start()
    await flushMicrotasks()
    clock.advance(0)
    await flushMicrotasks()

    expect(script.streams).toHaveLength(1)
    // One `Hello`, and nothing else — the health link has no observe target of its own.
    expect(script.sent[0]).toHaveLength(1)
    expect(script.sent[0]![0]!.startsWith('00')).toBe(true)
    expect(log).toContain(`health link up (${HEALTH_LINK_COLS}x${HEALTH_LINK_ROWS})`)
    expect(remote.getSnapshot()).toMatchObject({ state: 'connected', reconnectAttempt: 0 })
  })

  it('probes with ClientMessage::Ping on the resident stream (L1, on the wire)', async () => {
    const { remote, clock, script } = harness()
    remote.start()
    await flushMicrotasks()
    clock.advance(0)
    await flushMicrotasks()

    // The watchdog's idle timer, whatever the production constant is: advancing far past it must
    // produce a probe, and the probe must be the encoding the live suite sends.
    clock.advance(21_000)
    await flushMicrotasks()
    const frames = script.sent[0] as string[]
    expect(frames.length).toBeGreaterThan(1)
    expect(frames[1]).toBe(toHex(encodePing(1)))
    expect(Number.parseInt(frames[1]!.slice(0, 2), 16)).toBe(CLIENT_MESSAGE_PING_TAG)
  })

  it('replays a stored subscription as ObserveTerminal + RequestFullFrame (X1/X1b)', async () => {
    const { remote, clock, script } = harness()
    remote.observe({ paneId: 'w1:p1', cols: 120, rows: 40 })
    remote.start()
    await flushMicrotasks()
    clock.advance(0)
    await flushMicrotasks()

    const frames = script.sent[0] as string[]
    // Hello, then the two replay frames — `0c` is `ObserveTerminal`, `0b` `RequestFullFrame`.
    expect(frames[0]!.startsWith('00')).toBe(true)
    expect(frames[1]!.startsWith('0c')).toBe(true)
    expect(frames[2]).toBe('0b')
    expect(remote.supervisor.subscriptions.pendingReplay()).toHaveLength(0)

    // X1b: the phone rotated. The registry, not a captured variable, is what the next generation
    // reads — proved by the replay that follows the reconnect below.
    remote.updateObserveViewport('w1:p1', { cols: 80, rows: 24 })
    script.streams[0]!.die({ error: new Error('bridge died') })
    await flushMicrotasks()
    expect(remote.getSnapshot()).toMatchObject({ state: 'reconnecting', armed: true })
    expect(remote.supervisor.subscriptions.pendingReplay()).toHaveLength(1)

    clock.advance(60_000)
    await flushMicrotasks()
    clock.advance(0)
    await flushMicrotasks()
    expect(remote.getSnapshot().state).toBe('connected')
    expect(script.streams).toHaveLength(2)
    const replayed = script.sent[1] as string[]
    expect(replayed[1]!.startsWith('0c')).toBe(true)
    expect(replayed[2]).toBe('0b')
  })

  it('L7: retry() leaves a latched failure by replacing the link, not by resending', async () => {
    const script = scriptedTransport()
    const { remote, clock } = harness(script)
    remote.start()
    await flushMicrotasks()
    clock.advance(0)
    await flushMicrotasks()

    // `herdr: command not found` — fatal, so the loop latches instead of trickling forever.
    script.streams[0]!.die({ exitCode: 127, stderr: 'sh: 1: herdr: not found' })
    await flushMicrotasks()
    const latched = remote.getSnapshot()
    expect(latched.state).toBe('auth-failed')
    expect(latched.armed).toBe(false)
    expect(latched.verdict.kind).toBe('auth-failed')
    expect(latched.verdict.label).toContain('no herdr on the remote')

    const dialsBefore = script.streams.length
    remote.retry()
    await flushMicrotasks()
    clock.advance(0)
    await flushMicrotasks()
    // The latch is gone and a *new channel* was opened — the transport was revived, and nothing was
    // resent on the dead one.
    expect(script.streams.length).toBe(dialsBefore + 1)
    expect(remote.getSnapshot().state).toBe('connected')
  })

  it('L6: the ladder escalates on the snapshot the screen reads', async () => {
    const script = scriptedTransport()
    script.welcome = false
    const { remote, clock } = harness(script)
    remote.start()
    await flushMicrotasks()

    const seen: string[] = []
    const parked: string[] = []
    for (let attempt = 0; attempt < 14; attempt += 1) {
      // Each generation's bridge accepts the channel and never answers `Hello`; killing it is the
      // "the path died with no notification" case the loop is built for.
      script.streams[script.streams.length - 1]?.die({ error: new Error('no route to host') })
      await flushMicrotasks()
      const down = remote.getSnapshot()
      seen.push(down.verdict.kind)
      // L3, at every rung: from the state a *screen* can read, the loop is never parked. Either a
      // reconnect timer is armed or a dial is in flight — orca #5049 is the third possibility, a
      // `reconnecting` with neither, and it is what this list exists to be empty of.
      if (!down.armed && down.state !== 'connecting' && down.state !== 'handshaking') {
        parked.push(`${attempt}:${down.state}`)
      }
      clock.advance(90_000)
      await flushMicrotasks()
      clock.advance(0)
      await flushMicrotasks()
      const dialing = remote.getSnapshot()
      if (!dialing.armed && dialing.state !== 'connecting' && dialing.state !== 'handshaking') {
        parked.push(`${attempt}+:${dialing.state}`)
      }
    }
    // normal → warning → unreachable, in that order and without going back.
    expect(seen[0]).toBe('normal')
    expect(seen).toContain('warning')
    expect(seen[seen.length - 1]).toBe('unreachable')
    expect(seen.lastIndexOf('normal')).toBeLessThan(seen.indexOf('warning'))
    expect(seen.lastIndexOf('warning')).toBeLessThan(seen.indexOf('unreachable'))
    expect(parked).toEqual([])
  })

  it('L4: a nudge reaches the supervisor through the Nudgeable face', async () => {
    const { remote, clock, script } = harness()
    remote.start()
    await flushMicrotasks()
    clock.advance(0)
    await flushMicrotasks()

    const before = (script.sent[0] as string[]).length
    // `bindConnectionRevival` calls exactly this on `AppState 'active'`. On a live link the branch
    // taken is "probe now rather than assume".
    remote.notifyForeground('network-change')
    await flushMicrotasks()
    const frames = script.sent[0] as string[]
    expect(frames.length).toBe(before + 1)
    expect(frames[before]).toBe(toHex(encodePing(1)))
  })
})
