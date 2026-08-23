// Not from orca. The receipt for the second half of §Q, and — like the first half — for something
// a QA agent watched on an Android device rather than inferred from the code:
//
//   · an airplane-mode cycle ended, the link came back, and the pane header went on printing
//     `transport is closed` for about **20 minutes**;
//   · after 30 minutes backgrounded the header read `IllegalStateException: Not connected` while
//     live frames were painting on the same screen (the lab's `BANNER-CHECK-LIVE` was rendering in
//     the very screenshot that carried the banner).
//
// The stream healed and the *header* did not, because `use-pane-observer.ts` had exactly one writer
// of `error` and no eraser, and `streamSummary` (`app/h/[remoteId]/pane/[paneId].tsx`) shows that
// string in preference to every status once it is non-null. A header that lies about a live screen
// is the surface that makes a user force-quit — the same "강제종료로만 낫는 상태" M4 was failed on.
//
// So these assertions are about one field: when it clears, and — the half that is just as easy to
// get wrong — when it must not. Clearing on the *attempt* would lie in the other direction, and a
// dead generation must not be able to clear it at all (`pane-observer.ts` gates every callback on
// `generation === this.attachSeq`; the revival signal has to ride inside that gate, not beside it).
//
// The fakes are the neighbours' — `packages/herdr-client-ts/test/fakeTransport.ts` and its golden
// wire vectors, plus `test/wire-abi-peer.ts` — with one addition this file needs and
// `./pane-observer-reattach.test.ts` does not: a transport whose *dial* can be made to fail or to
// hang, because that is where the strings the device showed come from. `openChannel` is what
// throws `the transport is closed` (`src/transport/redialable-transport.ts`) and
// `IllegalStateException: Not connected` (the Android ssh module), and `PaneObserver.attach`'s
// `catch` is what turns them into the header's error.
import { createElement, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HerdrChannelKind,
  PROTOCOL_VERSION,
  RenderEncoding,
  decodeServerMessage,
  type HerdrChannel,
  type HerdrChannelHandlers,
  type HerdrTransport,
  type JsonApiClient,
  type ServerMessage,
  type ServerMessageChannel,
  type ServerMessageChannelHandlers
} from '@herdr/client-ts'
import {
  FakeTransport,
  type FakeChannel
} from '../../../packages/herdr-client-ts/test/fakeTransport'
import { frameHex, fromHex, toHex } from '../../../packages/herdr-client-ts/test/helpers'
import {
  TERMINAL_SMALL_FULL,
  WELCOME_OK_ANSI_V21
} from '../../../packages/herdr-client-ts/test/vectors'
import { createWireAbiGate } from '../../test/wire-abi-peer'
import { FakeClock } from '../../test/fake-clock'
import { PaneObserver, type PaneObserverStatus } from './pane-observer'
import { createTransportConnection } from '../transport/herdr-connection'
import type { HerdrRemoteConnection } from '../transport/herdr-connection'
import type { PaneObserverView } from './use-pane-observer'
import type { RemoteDefinition } from '../api/herdr-api-types'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'

// The hook reads `AppState` for the foreground half of §Q, and the resume event is how a test
// delivers the nudge — same mock shape as `../api/use-foreground-refresh.test.tsx`.
const appState = vi.hoisted(() => ({
  current: 'active' as string,
  listeners: new Set<(next: string) => void>()
}))

// M6a: the pane viewer now imports react-native-gesture-handler, which reaches into RN internals
// this environment does not have. `test/gesture-handler-double.ts` stands in and renders the same
// tree (its `GestureDetector` passes the child through, its root view is the host `View`), so every
// assertion below still sees what it saw. Driving the gesture is
// `src/app-shell/pane-swipe-mount.test.tsx`'s job, not this suite's.
vi.mock('react-native-gesture-handler', async () => {
  const { createGestureHandlerDouble, createGestureHandlerRegistry } =
    await import('../../test/gesture-handler-double')
  return createGestureHandlerDouble(createGestureHandlerRegistry())
})

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.current
    },
    addEventListener: (_type: string, handler: (next: string) => void) => {
      appState.listeners.add(handler)
      return {
        remove: () => {
          appState.listeners.delete(handler)
        }
      }
    }
  },
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

const { usePaneObserver } = await import('./use-pane-observer')

const REMOTE: RemoteDefinition = {
  id: 'remote-1',
  name: 'fable-m5max',
  target: { type: 'local' }
}

const LAYOUT = {
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  zoomed: false,
  area: { x: 26, y: 1, width: 54, height: 23 },
  focused_pane_id: 'w1:p1',
  panes: [{ pane_id: 'w1:p1', focused: true, rect: { x: 26, y: 1, width: 54, height: 23 } }],
  splits: []
}

/** What the Android module throws once the ssh session is gone — the string the device showed. */
const DIAL_FAILURE = 'IllegalStateException: Not connected'

/**
 * How the peer answers a dial.
 *
 * `hang` is not padding: "the ladder armed a rung and it is *trying*" is only observable as a dial
 * that has neither landed nor failed, and that is the state requirement 2 is about.
 */
type PeerMode = 'online' | 'offline' | 'hang'

type Peer = {
  transport: HerdrTransport
  /** Client-bridge channels in open order. A test kills one and, later, speaks on the corpse. */
  streams: FakeChannel[]
  mode: PeerMode
  /** Hex of the `Welcome` this peer answers `Hello` with. Null plays a box that stays silent. */
  welcome: string | null
}

function herdrPeer(): Peer {
  const fake = new FakeTransport()
  const peer = {
    streams: [] as FakeChannel[],
    mode: 'online' as PeerMode,
    welcome: WELCOME_OK_ANSI_V21 as string | null
  }
  fake.onOpen = (channel: FakeChannel) => {
    const write = channel.write.bind(channel)
    if (channel.kind === HerdrChannelKind.ClientStream) {
      peer.streams.push(channel)
      const wireAbi = createWireAbiGate()
      channel.write = (bytes: Uint8Array) => {
        write(bytes)
        const framed = wireAbi(bytes)
        if (framed === null) {
          return
        }
        const payload = framed.subarray(4)
        if (payload[0] === 0x00) {
          if (peer.welcome !== null) {
            channel.emit(fromHex(frameHex(peer.welcome)))
          }
          return
        }
        if (payload[0] === 0x0c || payload[0] === 0x0e) {
          channel.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)))
        }
      }
      return
    }
    channel.write = (bytes: Uint8Array) => {
      write(bytes)
      for (const line of new TextDecoder().decode(bytes).split('\n')) {
        if (line.trim().length === 0) {
          continue
        }
        const request = JSON.parse(line) as { id: string }
        channel.emitLine(
          JSON.stringify({ id: request.id, result: { type: 'pane_layout', layout: LAYOUT } })
        )
      }
    }
  }
  const transport: HerdrTransport = {
    openChannel: (kind: HerdrChannelKind, handlers: HerdrChannelHandlers) => {
      if (peer.mode === 'offline') {
        // The shape of a phone whose radio went away: the ssh session is gone, so the exec channel
        // is refused at the dial rather than dying mid-stream. This is what reaches the header.
        return Promise.reject(new Error(DIAL_FAILURE))
      }
      if (peer.mode === 'hang') {
        return new Promise<HerdrChannel>(() => {})
      }
      return fake.openChannel(kind, handlers)
    },
    close: () => fake.close()
  }
  return {
    transport,
    get streams() {
      return peer.streams
    },
    get mode() {
      return peer.mode
    },
    set mode(next: PeerMode) {
      peer.mode = next
    },
    get welcome() {
      return peer.welcome
    },
    set welcome(next: string | null) {
      peer.welcome = next
    }
  }
}

/** The golden `Welcome`, decoded once — the same bytes the wire tests hand the codec. */
const WELCOME: ServerMessage = decodeServerMessage(fromHex(WELCOME_OK_ANSI_V21))

type HeldStream = {
  handlers: ServerMessageChannelHandlers
  /** Frames `PaneObserver` sent on this generation, framed exactly as the codec would write them. */
  sent: Uint8Array[]
  closed: boolean
}

/**
 * A connection whose stream handlers the test keeps, for the one property the wire cannot reach
 * (see the last case). No codec is faked: what is dropped is the socket under it.
 */
function heldConnection() {
  const streams: HeldStream[] = []
  const state = { mode: 'online' as PeerMode }
  const connection: HerdrRemoteConnection = {
    remote: REMOTE,
    api: {
      request: () => Promise.resolve({ type: 'pane_layout', layout: LAYOUT })
    } as unknown as JsonApiClient,
    openTerminalStream: (handlers: ServerMessageChannelHandlers) => {
      if (state.mode === 'offline') {
        return Promise.reject(new Error(DIAL_FAILURE))
      }
      const stream: HeldStream = { handlers, sent: [], closed: false }
      streams.push(stream)
      return Promise.resolve({
        send: (bytes: Uint8Array) => {
          stream.sent.push(bytes)
        },
        close: () => {
          stream.closed = true
        }
      } as unknown as ServerMessageChannel)
    }
  }
  return {
    connection,
    streams,
    get mode() {
      return state.mode
    },
    set mode(next: PeerMode) {
      state.mode = next
    }
  }
}

function welcomePayloadHex(encoding: RenderEncoding): string {
  const varint = (value: number) => value.toString(16).padStart(2, '0')
  return `00${varint(PROTOCOL_VERSION)}${varint(encoding)}00`
}

/** Every view the hook has returned, in order, so "it was never null in between" is checkable. */
const views: PaneObserverView[] = []

function Probe({ connection }: { connection: HerdrRemoteConnection }) {
  const handleRef = useRef<TerminalWebViewHandle | null>(null)
  views.push(usePaneObserver({ connection, paneId: 'w1:p1', handleRef }))
  return null
}

function current(): PaneObserverView {
  const view = views[views.length - 1]
  if (view === undefined) {
    throw new Error('the hook never rendered')
  }
  return view
}

let renderer: ReactTestRenderer | null = null

async function flush(): Promise<void> {
  for (let i = 0; i < 24; i += 1) {
    await Promise.resolve()
  }
}

async function mount(connection: HerdrRemoteConnection): Promise<void> {
  await act(async () => {
    renderer = create(createElement(Probe, { connection }))
    await flush()
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await flush()
  })
}

/** The screen came back. `usePaneObserver`'s `AppState` listener turns this into a re-attach now. */
async function resume(): Promise<void> {
  await act(async () => {
    for (const listener of appState.listeners) {
      listener('active')
    }
    await flush()
  })
}

afterEach(async () => {
  const mounted = renderer
  renderer = null
  if (mounted !== null) {
    await act(async () => {
      mounted.unmount()
      await flush()
    })
  }
  views.length = 0
  appState.listeners.clear()
  appState.current = 'active'
})

describe('pane header error, once the stream is back (§Q)', () => {
  it('clears the error when the observe stream re-attaches', async () => {
    const peer = herdrPeer()
    await mount(createTransportConnection(REMOTE, peer.transport))
    expect(current().status).toBe('observing')
    expect(current().error).toBeNull()

    // Airplane mode: the exec channel dies and the next dial is refused outright.
    peer.mode = 'offline'
    await act(async () => {
      peer.streams[0]?.die({})
      await flush()
    })
    await resume()
    expect(current().status).toBe('failed')
    expect(current().error).toBe(DIAL_FAILURE)

    // The radio is back. One `Hello`/`Welcome` later the screen is live again — and the header must
    // say so. Before the fix this stayed `IllegalStateException: Not connected` for as long as the
    // observer lived (the device measured ~20 minutes, ending only at a force-quit).
    peer.mode = 'online'
    await resume()
    await settle()
    expect(current().status).toBe('observing')
    expect(current().error).toBeNull()
    expect(peer.streams).toHaveLength(2)
  })

  it('keeps the error while a rung is only trying — an attempt is not a recovery', async () => {
    const peer = herdrPeer()
    await mount(createTransportConnection(REMOTE, peer.transport))
    peer.mode = 'offline'
    await act(async () => {
      peer.streams[0]?.die({})
      await flush()
    })
    await resume()
    expect(current().error).toBe(DIAL_FAILURE)

    // A dial that has neither landed nor failed: `connecting`, indefinitely. Clearing here would be
    // the same lie pointed the other way — a pane that is failing every 90 seconds looking healthy.
    peer.mode = 'hang'
    await resume()
    expect(current().status).toBe('connecting')
    expect(current().error).toBe(DIAL_FAILURE)
    // …and not for one render only: nothing between the failure and now blanked it.
    const sinceFailure = views.slice(views.findIndex((view) => view.error === DIAL_FAILURE))
    expect(sinceFailure.every((view) => view.error === DIAL_FAILURE)).toBe(true)
  })

  it('keeps a failed stream’s diagnosis: a refused handshake is the header’s only content', async () => {
    const peer = herdrPeer()
    // A `Welcome` that chose another encoding. `assertWelcomeAccepted` refuses it, the ladder
    // latches (dialling again produces the identical answer), and the stream is genuinely dead —
    // erasing the reason would leave the header saying nothing at all about a black screen.
    peer.welcome = welcomePayloadHex(RenderEncoding.SemanticFrame)
    await mount(createTransportConnection(REMOTE, peer.transport))
    expect(current().status).toBe('failed')
    const diagnosis = current().error
    expect(diagnosis).not.toBeNull()

    await resume()
    await resume()
    await settle()
    expect(current().status).toBe('failed')
    expect(current().error).toBe(diagnosis)
    // Latched: the resumes cost no exec channel, so nothing could have healed anything.
    expect(peer.streams).toHaveLength(1)
  })

  // The one requirement that cannot be driven over the wire, and the reason is worth writing down
  // because it changes what this test is: **a superseded generation's bytes never reach the codec's
  // callbacks.** `PaneObserver.streamDown` closes the channel it is retiring, `ServerMessageChannel`
  // sets `closed` inside its own `close()` (`packages/herdr-client-ts/src/transport.ts:1223-1227`),
  // and `ingest` drops every later chunk on that flag (`:1007`). So the wire path holds the property
  // already, and `generation === this.attachSeq` (`./pane-observer.ts:266-285`) is the second lock —
  // the one that has to hold when a callback arrives from somewhere the flag cannot see.
  //
  // A lock is only testable at the door it guards, so this one drops the transport and hands the
  // observer a connection whose stream handlers the test keeps. Everything else stays real: the
  // `Welcome` is the same golden vector the wire tests use, decoded rather than hand-written.
  it('does not let a dead generation’s late Welcome publish an `observing` that would clear it', async () => {
    const clock = new FakeClock()
    const held = heldConnection()
    const statuses: PaneObserverStatus[] = []
    const errors: string[] = []
    const observer = new PaneObserver({
      connection: held.connection,
      paneId: 'w1:p1',
      target: { init: () => {}, resize: () => {}, write: () => {} },
      timer: clock.timer,
      events: {
        onStatus: (status) => statuses.push(status),
        onError: (error) => errors.push(error.message)
      }
    })
    await observer.start()
    await flush()
    const dead = held.streams[0]
    dead?.handlers.onMessage?.(WELCOME)
    expect(observer.status).toBe('observing')

    // Generation 1 dies; generation 2 is refused at the dial and is what puts the string in the
    // header (`onError` is the hook's only writer of it).
    held.mode = 'offline'
    dead?.handlers.onClose({})
    clock.advance(500)
    await flush()
    expect(errors).toEqual([DIAL_FAILURE])
    expect(observer.status).toBe('failed')

    // Generation 3 takes the channel and waits for a `Welcome` that never comes — the observer now
    // holds an open channel with `observing` still false, which is exactly the window in which an
    // ungated `onWelcome` would run all the way to `setStatus('observing')`.
    held.mode = 'online'
    clock.advance(1000)
    await flush()
    expect(observer.status).toBe('connecting')
    const published = statuses.length

    // The corpse speaks. Gated, this is nothing at all.
    dead?.handlers.onMessage?.(WELCOME)
    expect(statuses).toHaveLength(published)
    expect(statuses.slice(statuses.indexOf('failed'))).not.toContain('observing')
    expect(observer.status).toBe('connecting')
    // In bytes, the same fact: `onWelcome` would have sent `ObserveTerminal` on `this.channel`,
    // which is generation 3's. That channel has carried one `Hello` and nothing since.
    expect(held.streams[1]?.sent.map((bytes) => toHex(bytes).slice(8, 10))).toEqual(['00'])
    observer.close()
  })
})
