// Not from orca. `./supervised-remote.test.ts` already proves this link's *happy* path in hex —
// `Hello`, a checked `Welcome`, `ObserveTerminal` + `RequestFullFrame`, `Ping`. This file proves the
// path nothing else covered: the one where the channel dies **before `Welcome`**, which is where
// every startup failure ssh can produce actually arrives.
//
// Why that path needs its own receipt. The evidence a bridge death carries is a struct —
// `{exitCode, signal, stderr, error}` — and `./channel-failure.ts` grades two of its fields `fatal`:
// `stderr` containing `Permission denied (publickey)`, and `exitCode === 127`. `fatal` is what stops
// L3's forever-backoff. So any hop on the way to `classifyChannelFailure` that renders the close
// into a *string* silently converts a refused key into "the network is flaky", and the app then
// trickles against a credential only the user can change while showing "Reconnecting…". That is
// what the code did: a local `closeSummary` returned `close.error.message` and nothing else, and the
// raw close was gated on a token assigned only *after* the handshake.
//
// Hence the shape of the assertions below: they read `snapshot().failure.kind` / `.fatal`, never the
// rendered line. A test that matched on the message would go green again the day the fields are
// dropped one layer further down.
import { describe, expect, it } from 'vitest'
import { HerdrChannelKind, type HerdrChannelClose } from '@herdr/client-ts'
import {
  FakeTransport,
  type FakeChannel
} from '../../../packages/herdr-client-ts/test/fakeTransport'
import { FakeClock, flushMicrotasks } from '../../test/fake-clock'
import { SupervisedRemote } from './supervised-remote'
import { createObserveStreamLink } from './observe-stream-link'
import { createTransportConnection } from './herdr-connection'
import { AUTH_HINT, MISSING_BINARY_HINT, WIRE_ABI_HINT } from './channel-failure'
import type { RemoteDefinition } from '../api/herdr-api-types'

const REMOTE: RemoteDefinition = { id: 'scratch', name: 'scratch', target: { type: 'local' } }

/**
 * A bridge that accepts the exec channel and then says nothing at all.
 *
 * Deliberately *not* the scripted `Welcome` peer of `./supervised-remote.test.ts`: `sshd` writing
 * `Permission denied (publickey)` and exiting is exactly a channel that opens (from the client's
 * point of view the write went out) and never answers, so silence is the peer under test here.
 */
function mutePeer() {
  const transport = new FakeTransport()
  const streams: FakeChannel[] = []
  transport.onOpen = (channel: FakeChannel) => {
    if (channel.kind === HerdrChannelKind.ClientStream) {
      streams.push(channel)
    }
  }
  return { transport, streams }
}

function harness() {
  const peer = mutePeer()
  const clock = new FakeClock()
  const connection = createTransportConnection(REMOTE, peer.transport)
  const remote = new SupervisedRemote({
    remoteId: REMOTE.id,
    link: createObserveStreamLink({ connection }),
    timer: clock.timer,
    now: clock.now
  })
  return { ...peer, clock, remote }
}

/** Starts a dial and stops on the first channel, i.e. mid-handshake — the state under test. */
async function dialUntilHandshaking(h: ReturnType<typeof harness>): Promise<void> {
  h.remote.start()
  await flushMicrotasks()
  expect(h.remote.getSnapshot().state).toBe('handshaking')
}

describe('a channel that dies before Welcome', () => {
  it('reaches the classifier as auth, not as generic transport — a refused key latches', async () => {
    const h = harness()
    await dialUntilHandshaking(h)

    // What ssh2 delivers for a rejected public key: the useful half is on `stderr`, and the `error`
    // is the generic one. Rendering this close to `close.error.message` yields "channel closed".
    h.streams[0]!.die({
      error: new Error('channel closed'),
      stderr: 'Permission denied (publickey).'
    })
    await flushMicrotasks()

    const snapshot = h.remote.getSnapshot()
    expect(snapshot.failure).toMatchObject({ kind: 'auth', fatal: true, hint: AUTH_HINT })
    // The verdict the loop actually acts on: latched, with no timer armed. `reconnecting` with
    // `armed: true` here would be the forever-retry this whole file exists to forbid.
    expect(snapshot.state).toBe('auth-failed')
    expect(snapshot.armed).toBe(false)
    expect(h.clock.pending).toBe(0)
    // And the evidence survived rendering, rather than being replaced by it.
    expect(snapshot.failure?.detail).toBe(
      'closed (error=channel closed stderr="Permission denied (publickey).")'
    )
  })

  it('reaches the classifier as missing-binary — 127 is a field, not a word', async () => {
    const h = harness()
    await dialUntilHandshaking(h)

    // No stderr at all: `exitCode` is the entire evidence, so this case cannot be rescued by any
    // amount of message text. It is the reason the *struct* has to travel.
    h.streams[0]!.die({ error: new Error('channel closed'), exitCode: 127 })
    await flushMicrotasks()

    const snapshot = h.remote.getSnapshot()
    expect(snapshot.failure).toMatchObject({
      kind: 'missing-binary',
      fatal: true,
      hint: MISSING_BINARY_HINT
    })
    expect(snapshot.state).toBe('auth-failed')
    expect(snapshot.armed).toBe(false)
  })

  it('is still retryable when it carries no fatal evidence (L3 must not be latched by this)', async () => {
    const h = harness()
    await dialUntilHandshaking(h)

    // Airplane mode: the channel simply ends. Grading this `fatal` would be the opposite bug, and a
    // worse one — the user's only exit would be the app switcher.
    h.streams[0]!.die({ error: new Error('channel closed') })
    await flushMicrotasks()

    const snapshot = h.remote.getSnapshot()
    expect(snapshot.failure).toMatchObject({ kind: 'transport', fatal: false })
    expect(snapshot.state).toBe('reconnecting')
    expect(snapshot.armed).toBe(true)
  })

  it('cannot latch the generation that replaced it — L5 abandons a dial, the corpse arrives late', async () => {
    const h = harness()
    await dialUntilHandshaking(h)

    // L5: the phone was suspended mid-dial. `notifyForeground` abandons a dial older than
    // `STALE_DIAL_AGE_MS` (`./rpc-stale-dial.ts`) and redials immediately. Nothing closed the first
    // channel — that is the point of the rule, the path under it is gone — so it is still alive and
    // can still die.
    h.clock.jump(3_000)
    h.remote.notifyForeground('app-resume')
    await flushMicrotasks()
    expect(h.streams).toHaveLength(2)
    expect(h.remote.getSnapshot().state).toBe('handshaking')

    // The abandoned dial's bridge now reports a *fatal* death. Booking it would latch a generation
    // it says nothing about, and would double-count the attempt L3's cap and L6's ladder key off.
    h.streams[0]!.die({ exitCode: 127, stderr: 'sh: 1: herdr: not found' })
    await flushMicrotasks()

    const snapshot = h.remote.getSnapshot()
    expect(snapshot.state).toBe('handshaking')
    expect(snapshot.failure?.kind).toBe('transport')
    expect(snapshot.failure?.detail).toContain('stale foreground dial abandoned')

    // …and the live generation still reports normally, so the guard narrowed nothing but staleness.
    h.streams[1]!.die({ stderr: 'Permission denied (publickey).' })
    await flushMicrotasks()
    expect(h.remote.getSnapshot()).toMatchObject({ state: 'auth-failed' })
  })
})

describe('a peer whose wire ABI this client cannot decode', () => {
  it('latches instead of retrying — nothing about that peer changes on the next dial', async () => {
    const h = harness()
    await dialUntilHandshaking(h)

    // A pre-prelude herdr (protocol <= 20) or a foreign fork: it answers, in bytes that carry no
    // herdr-mx wire-ABI magic. `ServerMessageChannel` refuses it before decoding anything and
    // reports on `onError` (`packages/herdr-client-ts/src/transport.ts:970-990`) — the channel
    // never closes, so this arrives *only* as a dial rejection. That is the whole reason the
    // classifier has to read `handshakeError` and not just the close.
    h.streams[0]!.emitRaw(new Uint8Array(32))
    await flushMicrotasks()

    const snapshot = h.remote.getSnapshot()
    expect(snapshot.failure).toMatchObject({ kind: 'protocol', fatal: true, hint: WIRE_ABI_HINT })
    expect(snapshot.state).toBe('auth-failed')
    expect(snapshot.armed).toBe(false)
    expect(h.clock.pending).toBe(0)
    // A second dial would produce the identical bytes, so the loop must not arm one. Reconnecting
    // here is the `WIRE_ABI_EPOCH` bump's self-inflicted version of L3's forever-backoff.
    expect(h.streams).toHaveLength(1)
    h.clock.advance(600_000)
    await flushMicrotasks()
    expect(h.streams).toHaveLength(1)
    expect(h.remote.getSnapshot().state).toBe('auth-failed')
  })
})

describe('the dial’s rejection', () => {
  /** Drives the factory directly: `SupervisedRemote` swallows the rejection, and it is the subject. */
  async function rejectionFor(close: HerdrChannelClose) {
    const peer = mutePeer()
    const connection = createTransportConnection(REMOTE, peer.transport)
    const reported: HerdrChannelClose[] = []
    const { dial } = createObserveStreamLink({ connection })({
      noteInbound: () => {},
      reportClosed: (value) => reported.push(value)
    })
    const settled = dial(() => {}).then(
      () => {
        throw new Error('the dial resolved on a dead channel')
      },
      (error: unknown) => error
    )
    await flushMicrotasks()
    peer.streams[0]!.die(close)
    return { reported, error: await settled }
  }

  it('carries the close itself, so exit, signal and stderr survive as fields', async () => {
    const close: HerdrChannelClose = {
      exitCode: 3,
      signal: 'SIGTERM',
      stderr: '  Permission denied (publickey).\n',
      error: new Error('channel closed')
    }
    const { reported, error } = await rejectionFor(close)

    // Route 1: the struct, by reference — nothing was rebuilt, so nothing could be dropped.
    expect(reported).toEqual([close])
    // Route 2: the rejection. `ChannelCloseError` exists so the supervisor's rejection path has the
    // same fields available, rather than re-deriving them from the message.
    expect(error).toBeInstanceOf(Error)
    expect((error as { close?: HerdrChannelClose }).close).toBe(close)
    expect((error as Error).message).toBe(
      'the stream closed before Welcome ' +
        '(exit=3 signal=SIGTERM error=channel closed stderr="Permission denied (publickey).")'
    )
  })

  it('keeps its bare wording when the close carries nothing', async () => {
    const { error } = await rejectionFor({})
    expect((error as Error).message).toBe('the stream closed before Welcome')
  })
})
