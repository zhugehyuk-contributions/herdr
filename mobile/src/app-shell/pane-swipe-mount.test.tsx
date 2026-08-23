// Not from orca — orca switches surfaces by chip only (see the header of
// `src/session/pane-swipe.ts` for the read of its code), so there is no suite to port here either.
// This is the wiring half of M6a, against the real route file:
//
//   1. a left swipe routes to the next chip's pane and a right swipe to the previous one, through
//      the *same* `router.replace(paneHref(...))` a chip tap uses — the swipe never calls
//      `retarget()` itself, so the URL and the screen cannot come apart;
//   2. at either end of the strip nothing happens at all — no routing call, no wire traffic;
//   3. a vertical gesture switches nothing (the terminal keeps that axis);
//   4. the recognizer was configured with the horizontal activation window and the vertical fail
//      window — the only part of "don't steal the terminal's gestures" that lives in native code,
//      and therefore the only part a test here can pin at all;
//   5. and the switch that follows is `RetargetTerminal` on the channel that was already open —
//      one client stream for both panes, i.e. M6a's "no reconnect" as a wire fact.
//
// What it does NOT prove: the <200ms. That is a device measurement (`.prd/10-mobile-qa.md`); what
// is provable here is the absence of the work that used to make it slow — a second channel, a
// second `Hello`/`Welcome`, a second ANSI baseline.
import { createElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HerdrChannelKind } from '@herdr/client-ts'
import {
  FakeTransport,
  type FakeChannel
} from '../../../packages/herdr-client-ts/test/fakeTransport'
import { frameHex, fromHex, toHex } from '../../../packages/herdr-client-ts/test/helpers'
import {
  TERMINAL_SMALL_DIFF,
  TERMINAL_SMALL_FULL,
  WELCOME_OK_ANSI_V21
} from '../../../packages/herdr-client-ts/test/vectors'
import { createWireAbiGate } from '../../test/wire-abi-peer'
import { PANE_SWIPE_ACTIVATE_OFFSET_X, PANE_SWIPE_FAIL_OFFSET_Y } from '../session/pane-swipe'
import type { PanGestureDouble } from '../../test/gesture-handler-double'
import type { HerdrRemoteConnection } from '../transport/herdr-connection'

const routerState = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  replaced: [] as string[]
}))

/** Every `Gesture.Pan()` the screen built, newest last — the gesture is rebuilt when chips change. */
const gestures = vi.hoisted(() => ({ pans: [] as PanGestureDouble[] }))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routerState.params,
  useRouter: () => ({
    replace: (href: string) => routerState.replaced.push(href),
    push: (href: string) => routerState.replaced.push(href)
  })
}))

vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  RefreshCw: 'RefreshCw'
}))

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  const WebView = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => ({ postMessage: () => {}, reload: () => {} }))
    return React.createElement('WebView', props)
  })
  return { WebView, default: WebView }
})

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

// The one mock this suite *reads* rather than merely satisfies: it records the pan configuration and
// hands back the `onEnd` handler, which is how a test drives a gesture whose recognizer is native.
vi.mock('react-native-gesture-handler', async () => {
  const { createGestureHandlerDouble } = await import('../../test/gesture-handler-double')
  return createGestureHandlerDouble(gestures)
})

vi.mock('react-native', () => {
  class AnimatedValue {
    setValue() {}
    interpolate() {
      return '0deg'
    }
  }
  return {
    Animated: {
      Value: AnimatedValue,
      View: 'AnimatedView',
      loop: () => ({ start() {}, stop() {} }),
      timing: () => ({ start() {}, stop() {} })
    },
    AppState: {
      currentState: 'active',
      addEventListener: () => ({ remove: () => {} })
    },
    Easing: { linear: 'linear' },
    Keyboard: { addListener: () => ({ remove: () => {} }) },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: {
      absoluteFillObject: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
      create: (styles: unknown) => styles
    },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

const { HerdrClientsProvider } = await import('../transport/herdr-clients-context')
const { createTransportConnection } = await import('../transport/herdr-connection')
const { HerdrSnapshotProvider } = await import('../api/snapshot-context')
const { loadMockSnapshot } = await import('../api/mock/mock-snapshot-loader')
const { default: PaneViewerRoute } = await import('../../app/h/[remoteId]/pane/[paneId]')

const REMOTE = { id: 'remote-1', name: 'fable-m5max', target: { type: 'local' as const } }

/**
 * The mock workspace's strip, in order (`src/api/mock/`): three panes over two tabs, which is what
 * makes "first", "middle" and "last" different cases here.
 */
const FIRST_PANE = 'ws-1-p1'
const MIDDLE_PANE = 'ws-1-p2'
const LAST_PANE = 'ws-1-p3'

type Scripted = { transport: FakeTransport; sent: string[][] }

/** The same scripted peer `./pane-viewer-mount.test.tsx` uses, trimmed to what this suite reads. */
function scriptedServer(): Scripted {
  const transport = new FakeTransport()
  const sent: string[][] = []
  transport.onOpen = (channel: FakeChannel) => {
    const index = sent.push([]) - 1
    const write = channel.write.bind(channel)
    const wireAbi = createWireAbiGate()
    channel.write = (bytes: Uint8Array) => {
      write(bytes)
      if (channel.kind === HerdrChannelKind.ClientStream) {
        const framed = wireAbi(bytes)
        if (framed === null) {
          return
        }
        const payload = framed.subarray(4)
        sent[index]!.push(toHex(payload))
        if (payload[0] === 0x00) {
          channel.emit(fromHex(frameHex(WELCOME_OK_ANSI_V21)))
        } else if (payload[0] === 0x0c || payload[0] === 0x0e) {
          channel.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)))
          channel.emit(fromHex(frameHex(TERMINAL_SMALL_DIFF)))
        }
        return
      }
      for (const line of new TextDecoder().decode(bytes).split('\n')) {
        if (line.trim().length === 0) {
          continue
        }
        const request = JSON.parse(line) as { id: string }
        channel.emitLine(
          JSON.stringify({
            id: request.id,
            result: {
              type: 'pane_layout',
              layout: {
                workspace_id: 'ws-1',
                tab_id: 'ws-1-tab-1',
                zoomed: false,
                area: { x: 0, y: 0, width: 120, height: 40 },
                focused_pane_id: FIRST_PANE,
                panes: [],
                splits: []
              }
            }
          })
        )
      }
    }
  }
  return { transport, sent }
}

function host(name: string): ElementType {
  return name as unknown as ElementType
}

let renderer: ReactTestRenderer | null = null

function tree(connections: readonly HerdrRemoteConnection[]): ReactNode {
  return createElement(
    HerdrClientsProvider,
    { connections },
    createElement(HerdrSnapshotProvider, { load: loadMockSnapshot }, createElement(PaneViewerRoute))
  )
}

async function mountAt(
  paneId: string,
  connections: readonly HerdrRemoteConnection[] = []
): Promise<ReactTestRenderer> {
  routerState.params = { remoteId: 'remote-1', paneId }
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(tree(connections))
  })
  if (!created) {
    throw new Error('did not render')
  }
  renderer = created
  return created
}

/** Re-renders at a new route segment, as expo-router would after a `replace`. */
async function routeTo(
  paneId: string,
  connections: readonly HerdrRemoteConnection[]
): Promise<void> {
  routerState.params = { remoteId: 'remote-1', paneId }
  await act(async () => {
    renderer?.update(tree(connections))
  })
}

/** The pan the screen currently holds; it is rebuilt whenever the chip list or active chip moves. */
function pan(): PanGestureDouble {
  const current = gestures.pans.at(-1)
  if (!current) {
    throw new Error('the pane viewer registered no pan gesture')
  }
  return current
}

/** Ends a pan with the translation the native recognizer would report at lift-off. */
async function swipe(translationX: number, translationY = 0): Promise<void> {
  const end = pan().end
  if (!end) {
    throw new Error('the pan gesture has no onEnd handler')
  }
  await act(async () => {
    end({ translationX, translationY })
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 30; i += 1) {
      await Promise.resolve()
    }
  })
}

beforeEach(() => {
  routerState.params = { remoteId: 'remote-1', paneId: FIRST_PANE }
  routerState.replaced = []
  gestures.pans = []
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('pane viewer swipe (M6a)', () => {
  it('routes to the next chip on a left swipe — the same href a chip tap produces', async () => {
    await mountAt(FIRST_PANE)
    await swipe(-140)
    expect(routerState.replaced).toEqual([`/h/remote-1/pane/${MIDDLE_PANE}`])
  })

  it('routes to the previous chip on a right swipe', async () => {
    await mountAt(MIDDLE_PANE)
    await swipe(140)
    expect(routerState.replaced).toEqual([`/h/remote-1/pane/${FIRST_PANE}`])
  })

  it('does nothing at either end of the strip — no wrap-around, no routing call', async () => {
    await mountAt(FIRST_PANE)
    await swipe(140)
    expect(routerState.replaced).toEqual([])

    await routeTo(LAST_PANE, [])
    await swipe(-140)
    expect(routerState.replaced).toEqual([])
  })

  it('leaves the vertical axis to the terminal — a vertical gesture switches nothing', async () => {
    await mountAt(MIDDLE_PANE)
    // A scrollback flick: long, vertical, with the sideways wobble a thumb adds. Both directions,
    // because either one would be a lost scroll.
    await swipe(-30, -400)
    await swipe(30, 400)
    // And a diagonal that clears the horizontal floor but stays mostly vertical.
    await swipe(-100, -90)
    expect(routerState.replaced).toEqual([])
  })

  it('asks the recognizer for a horizontal window and refuses the vertical one', async () => {
    await mountAt(FIRST_PANE)
    // These two lines are the whole of "don't take the terminal's gestures": until the finger
    // crosses ±32 horizontally the WebView owns the touch, and the moment it crosses ±12 vertically
    // this gesture is dead for the rest of the touch. Native code enforces them, so the assertion
    // is that they were asked for.
    expect(pan().activeOffsetX).toEqual([
      -PANE_SWIPE_ACTIVATE_OFFSET_X,
      PANE_SWIPE_ACTIVATE_OFFSET_X
    ])
    expect(pan().failOffsetY).toEqual([-PANE_SWIPE_FAIL_OFFSET_Y, PANE_SWIPE_FAIL_OFFSET_Y])
    // The handler routes and sets React state; RNGH runs callbacks as worklets unless told.
    expect(pan().runOnJS).toBe(true)
  })

  it('switches by RetargetTerminal on the channel that was already open — no reconnect', async () => {
    const server = scriptedServer()
    const connection = createTransportConnection(REMOTE, server.transport)
    await mountAt(FIRST_PANE, [connection])
    await settle()

    await swipe(-140)
    expect(routerState.replaced).toEqual([`/h/remote-1/pane/${MIDDLE_PANE}`])
    // The swipe itself put nothing on the wire: it routed, and the observer follows the route.
    expect(server.sent.flat().filter((hex) => hex.startsWith('0e'))).toEqual([])

    await routeTo(MIDDLE_PANE, [connection])
    await settle()

    const target = toHex(new TextEncoder().encode(MIDDLE_PANE))
    // One observe (the first pane), one retarget (the swipe), and the retarget stays in Observe
    // mode — `0e` <len> <target> `00`, a unit variant, so no `Control{takeover}` and no resize of
    // the desktop's pane (M3's PTY contract).
    expect(server.sent.flat().filter((hex) => hex.startsWith('0c'))).toHaveLength(1)
    expect(server.sent.flat().filter((hex) => hex.startsWith('0e'))).toEqual([`0e07${target}00`])

    const streams = server.transport.ofKind(HerdrChannelKind.ClientStream)
    expect(streams).toHaveLength(1)
    expect(streams[0]!.closed).toBe(false)
  })

  it('renders the same tree it did before the gesture — one WebView, the chips still there', async () => {
    const target = await mountAt(FIRST_PANE)
    expect(target.root.findAllByType(host('WebView'))).toHaveLength(1)
    const chips = target.root
      .findAllByType(host('Pressable'))
      .filter((node) => String(node.props.accessibilityLabel).startsWith('tab '))
    expect(chips).toHaveLength(3)
  })
})
