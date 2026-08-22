// Not from orca. orca's transport is a WebSocket, so "the connection died" and "the stream died"
// are the same sentence there and its `dial` is `new WebSocket(url)` — a redial is free and
// unconditional. herdr's is an ssh exec channel on a connection somebody else opened, so the two
// deaths are *different* and only one of them is cheap to undo.
//
// This file is the receipt for that distinction, and it exists because the code confessed it did
// not hold: `./observe-stream-link.ts`'s header said in prose that it "cannot recover a dead ssh
// connection, which needs a dialer one level down". Everything below is what the supervisor does
// when that dialer is supplied.
//
// The two deaths, and why the answer differs:
//
//   · **the bridge died** — the exec channel ended, or the remote `herdr` exited. The ssh
//     connection demonstrably worked milliseconds ago (it carried the exec request), so re-opening
//     one channel is the whole repair: one round trip, no key exchange.
//   · **the ssh connection died** — Wi-Fi↔LTE, a remote reboot, a TCP reset. Every exec on it now
//     fails identically forever, and L3's ladder reproduces that failure 0.25 times a second.
//     Repairing it costs a TCP handshake, a key exchange, a signature and a *new remote `herdr`
//     process* (03-blockers.md B8), on a radio the user pays for.
//
// So the assertions below are as much about the re-dials that must **not** happen as the ones that
// must. A link that re-dialled ssh on every failure would pass the headline test and burn the
// remote.
//
// ⚠️ The redialable transport under test here is **local to this file** on purpose. What the link
// is required to use is a *contract* — `HerdrRemoteConnection.redialTransport` — and a receipt that
// imported the one production implementation could not tell the two apart. That implementation has
// its own receipt in `./redialable-transport.test.ts`.
import { describe, expect, it } from 'vitest'
import {
  HerdrChannelKind,
  type HerdrChannel,
  type HerdrChannelHandlers,
  type HerdrTransport
} from '@herdr/client-ts'
import {
  FakeTransport,
  type FakeChannel
} from '../../../packages/herdr-client-ts/test/fakeTransport'
import { frameHex, fromHex } from '../../../packages/herdr-client-ts/test/helpers'
import { WELCOME_OK_ANSI_V21 } from '../../../packages/herdr-client-ts/test/vectors'
import { FakeClock, flushMicrotasks } from '../../test/fake-clock'
import { SupervisedRemote } from './supervised-remote'
import { ConnectionSupervisor, type SupervisedLink } from './connection-supervisor'
import { createObserveStreamLink } from './observe-stream-link'
import { createTransportConnection, type HerdrRemoteConnection } from './herdr-connection'
import type { RemoteDefinition } from '../api/herdr-api-types'

const REMOTE: RemoteDefinition = { id: 'scratch', name: 'scratch', target: { type: 'local' } }

/** How the bridge on a freshly dialled ssh connection behaves. */
type BridgeMode =
  /** Answers `Hello` with an accepted `Welcome` — a healthy remote. */
  | 'welcome'
  /** Accepts the exec channel and dies at once — the remote `herdr` exited, ssh is fine. */
  | 'die'
  /** Accepts the exec channel and never says anything — a dial that hangs mid-handshake. */
  | 'mute'

/**
 * One ssh connection's worth of fake bridge.
 *
 * `onOpen` answering `Hello` is `./supervised-remote.test.ts`'s scripted peer, narrowed: this file
 * asserts on *how many ssh connections were opened*, never on the bytes, so the peer only has to be
 * realistic enough to complete or refuse a handshake.
 */
function bridge(mode: BridgeMode, execs: FakeChannel[] = []): FakeTransport {
  const transport = new FakeTransport()
  transport.onOpen = (channel: FakeChannel) => {
    if (channel.kind !== HerdrChannelKind.ClientStream) {
      return
    }
    execs.push(channel)
    if (mode === 'die') {
      channel.die({ error: new Error('bridge exited') })
      return
    }
    if (mode === 'mute') {
      return
    }
    const write = channel.write.bind(channel)
    channel.write = (bytes: Uint8Array) => {
      write(bytes)
      // 0x00 after the 4-byte length prefix is `ClientMessage::Hello`; the 28-byte wire-ABI prelude
      // that precedes it is not framed, so its first byte is 'H' (0x48).
      if (bytes.length > 4 && bytes[4] === 0x00) {
        channel.emit(fromHex(frameHex(WELCOME_OK_ANSI_V21)))
      }
    }
  }
  return transport
}

/**
 * A transport whose ssh connection can be replaced — the one thing `HerdrRemoteConnection` cannot
 * express today, because its transport is a value fixed at `createTransportConnection` time.
 *
 * `close` before `open` is deliberate and is the contract the production implementation also has to
 * keep: one host is one ssh connection (`packages/herdr-client-ts/src/transport.ts`, obligation 5),
 * and a phone that dials a second one before dropping the first holds two sshd sessions and two
 * remote `herdr` processes for as long as the dial takes.
 */
class SwappableTransport implements HerdrTransport {
  /** ssh connections opened, including the first. The number this file is really about. */
  dials = 1
  /** Signals this transport was asked to redial under, in order. */
  readonly signals: AbortSignal[] = []
  private current: FakeTransport
  private readonly open: () => FakeTransport

  constructor(first: FakeTransport, open: () => FakeTransport) {
    this.current = first
    this.open = open
  }

  openChannel(kind: HerdrChannelKind, handlers: HerdrChannelHandlers): Promise<HerdrChannel> {
    return this.current.openChannel(kind, handlers)
  }

  close(): void {
    this.current.close()
  }

  readonly redial = (signal: AbortSignal): Promise<void> => {
    this.signals.push(signal)
    this.current.close()
    this.current = this.open()
    this.dials += 1
    return Promise.resolve()
  }
}

function harness(mode: BridgeMode = 'welcome') {
  let next: BridgeMode = mode
  /** Every exec channel the link opened, across every ssh connection. B8's unit of cost. */
  const execs: FakeChannel[] = []
  const transport = new SwappableTransport(bridge(next, execs), () => bridge(next, execs))
  const clock = new FakeClock()
  const log: string[] = []
  const connection: HerdrRemoteConnection = {
    ...createTransportConnection(REMOTE, transport),
    redialTransport: transport.redial
  }
  const remote = new SupervisedRemote({
    remoteId: REMOTE.id,
    link: createObserveStreamLink({ connection, onLog: (line) => log.push(line) }),
    timer: clock.timer,
    now: clock.now,
    onLog: (line) => log.push(line)
  })
  return {
    clock,
    log,
    remote,
    transport,
    execs,
    /** ssh connections opened, including the first. */
    get dials(): number {
      return transport.dials
    },
    /** What the *next* ssh connection's bridge does. The current one is already dialled. */
    setBridge(value: BridgeMode) {
      next = value
    },
    /** Wi-Fi↔LTE: the ssh connection is gone, and every channel on it with it. */
    killSsh() {
      transport.close()
    },
    async settle() {
      await flushMicrotasks()
    },
    /**
     * Fires `count` armed dials, one at a time.
     *
     * Not `clock.advance(ms)`: a dial is asynchronous, so the timer for the *next* rung is armed
     * only after this one's promises settle, and one bulk advance therefore steps the ladder
     * exactly once no matter how far it moves the clock.
     */
    async attempts(count: number) {
      for (let fired = 0; fired < count; fired += 1) {
        await flushMicrotasks()
        if (!clock.runNext()) {
          throw new Error(`no dial was armed for attempt ${fired + 1} — the loop parked (#5049)`)
        }
        await flushMicrotasks()
      }
    }
  }
}

describe('an ssh connection that dies under a live link', () => {
  it('is re-dialled, instead of being re-execed on forever', async () => {
    const h = harness()
    h.remote.start()
    await h.settle()
    expect(h.remote.getSnapshot().state).toBe('connected')
    expect(h.dials).toBe(1)

    // The phone moved from Wi-Fi to LTE. Nothing about this is exceptional on a phone, and it is
    // the exact shape `./observe-stream-link.ts`'s header said it could not recover from.
    h.killSsh()
    await h.settle()
    expect(h.remote.getSnapshot().state).toBe('reconnecting')

    // Two rungs of L3's ladder. The first re-exec is allowed to fail: refusing to open an exec
    // channel is *how* the link learns the ssh connection is gone rather than the bridge, and
    // guessing before that evidence exists is what makes a redial storm.
    await h.attempts(2)

    expect(h.dials).toBe(2)
    expect(h.remote.getSnapshot().state).toBe('connected')
    // …and the recovery cost exactly one ssh connection, not one per attempt.
    expect(h.transport.signals).toHaveLength(1)
  })

  it('does not re-dial ssh for a bridge that died on a connection that is fine', async () => {
    const h = harness('die')

    // Three dials — `start()`'s, then two rungs. Each opens an exec channel that the remote
    // `herdr` refuses; the ssh connection carried every one of those exec requests, so it is the
    // last thing that should be suspected.
    h.remote.start()
    await h.attempts(2)
    expect(h.remote.getSnapshot().reconnectAttempt).toBe(3)
    expect(h.execs).toHaveLength(3)
    expect(h.dials).toBe(1)

    // Past three consecutive dials that never reached `Welcome`, the connection stops being
    // credible evidence of anything and is replaced — once, not once per attempt.
    await h.attempts(1)
    expect(h.dials).toBe(2)

    // …and the next two rungs are re-execs again: the count restarts on the new connection.
    await h.attempts(2)
    expect(h.dials).toBe(2)
  })

  it('re-dials at a bounded rate while the host stays unreachable', async () => {
    const h = harness('die')
    h.remote.start()

    // Twenty rungs, which runs past L3's cap of 12 into the 90s trickle. The trickle is exactly
    // where an unbounded redial would hurt most: it never stops.
    await h.attempts(20)

    expect(h.remote.getSnapshot().reconnectAttempt).toBe(12)
    expect(h.execs).toHaveLength(21)
    // The bound is the point. A link that redialled on every failure would sit at 21 here — 21 TCP
    // handshakes, 21 key exchanges and 21 remote `herdr` processes for one host that is off.
    expect(h.dials).toBeLessThanOrEqual(Math.ceil(h.execs.length / 3) + 1)
    expect(h.dials).toBeGreaterThan(1)
  })
})

describe('the dial cancellation contract', () => {
  /** Drives the supervisor directly: what is under test is the signal it hands out. */
  function supervised() {
    const clock = new FakeClock()
    const signals: AbortSignal[] = []
    const supervisor = new ConnectionSupervisor({
      dial: (signalHandshaking: () => void, signal: AbortSignal) => {
        signals.push(signal)
        signalHandshaking()
        return new Promise<SupervisedLink>(() => {})
      },
      replay: () => Promise.resolve(true),
      timer: clock.timer,
      now: clock.now
    })
    return { clock, signals, supervisor }
  }

  it('aborts a dial the supervisor has walked away from', async () => {
    const { clock, signals, supervisor } = supervised()
    supervisor.start()
    await flushMicrotasks()
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(false)

    // L5. The phone was suspended mid-dial and came back; the supervisor abandons the stale dial
    // and redials. Before this contract existed the abandoned dial's *promise* was the only thing
    // that could be walked away from — whatever it had opened underneath stayed open, and every
    // factory had to reinvent its own supersession bookkeeping to notice
    // (`test/live/paneViewerOutage.live.test.tsx` did, differently).
    clock.jump(3_000)
    supervisor.notifyForeground('app-resume')
    await flushMicrotasks()

    expect(signals).toHaveLength(2)
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)

    // And a deliberate close is a cancellation too, or a dial in flight outlives the screen.
    supervisor.close()
    expect(signals[1]!.aborted).toBe(true)
  })

  it('retires the generation it names, with no newer dial there to supersede it', async () => {
    // No supervisor and no second dial: the *only* thing that can end this generation is the
    // signal. That is what makes the contract worth having — `./observe-stream-link.ts` also keeps
    // its own `latest` pointer, so a receipt that produced a supersession could not tell which of
    // the two did the work.
    const transport = bridge('mute')
    const connection = createTransportConnection(REMOTE, transport)
    const { dial } = createObserveStreamLink({ connection })({
      noteInbound: () => {},
      reportClosed: () => {}
    })

    const abort = new AbortController()
    const settled = dial(() => {}, abort.signal).then(
      () => 'the dial resolved on a cancelled generation',
      (error: unknown) => (error as Error).message
    )
    await flushMicrotasks()
    expect(transport.channels).toHaveLength(1)
    expect(transport.channels[0]!.closed).toBe(false)

    abort.abort()
    await flushMicrotasks()

    // B8: the abandoned exec channel is a remote `herdr` process, and this factory is its only
    // owner — no `SupervisedLink` exists for a dial that never answered, so nothing above can
    // close it.
    expect(transport.channels[0]!.closed).toBe(true)
    // And the promise settles rather than parking forever, which is the other half: a dial nobody
    // will ever settle is the one shape that cannot release the closure holding that channel.
    expect(await settled).toContain('cancelled')
  })
})
