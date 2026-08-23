// Not from orca. .prd/09-review-followups.md §BB as a test: on the iOS simulator the pane viewer's
// `Send input` (↵) measured `{{352, 796}, {38, 38}}` in an 874pt window and reported
// `isHittable = false` once the keyboard was up. M3 still passed, because the keyboard's own Return
// submits the same draft — so this is a defect no acceptance criterion was watching, and the thing
// that has to be watched is the *geometry*, not the send.
//
// Why a mount and not a style-object assertion, same reason as `./safe-area-mount.test.tsx`: the
// bug is a distance from the window's bottom edge, which is a fact about the rendered tree. And why
// this file also asserts about the *terminal*: the cheap way to lift a bar in a flex column is to
// shrink the column above it, which on a device is a re-fit and a `resize` — and M3's contract is
// PTY-invariance (`.prd/09` §BB requirement 4, QA's 1468-file wire grep found zero `resize`). A
// test that only checked the bar would pass on the version of this fix that breaks that.
import { createElement, type ElementType } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HerdrChannelKind } from '@herdr/client-ts'
import {
  FakeTransport,
  type FakeChannel
} from '../../../packages/herdr-client-ts/test/fakeTransport'
import { frameHex, fromHex } from '../../../packages/herdr-client-ts/test/helpers'
import {
  TERMINAL_SMALL_DIFF,
  TERMINAL_SMALL_FULL,
  WELCOME_OK_ANSI_V21
} from '../../../packages/herdr-client-ts/test/vectors'
import { createWireAbiGate } from '../../test/wire-abi-peer'

/** iPhone 17 Pro portrait — the device §BB was measured on. */
const IPHONE_PORTRAIT = { top: 59, bottom: 34, left: 0, right: 0 }
/** A phone under edge-to-edge (`android/gradle.properties:47`) with three-button navigation. */
const ANDROID = { top: 24, bottom: 48, left: 0, right: 0 }
/**
 * What iOS reports for a letters+QuickType keyboard on this class of phone. The number is not the
 * subject — every assertion below is a relation between it and the bar — but it has to be taller
 * than the inset for the case to be the real one.
 */
const KEYBOARD_HEIGHT = 336

const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }))

/** A stand-in for RN's `Keyboard` module that lets a test raise and drop the keyboard. */
const keyboard = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  return {
    addListener(event: string, handler: (payload: unknown) => void) {
      const set = handlers.get(event) ?? new Set<(payload: unknown) => void>()
      set.add(handler)
      handlers.set(event, set)
      return {
        remove: () => {
          set.delete(handler)
        }
      }
    },
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload)
      }
    },
    subscriptions() {
      return [...handlers.values()].reduce((total, set) => total + set.size, 0)
    },
    reset() {
      handlers.clear()
    }
  }
})

const safeArea = vi.hoisted(() => ({ insets: { top: 0, bottom: 0, left: 0, right: 0 } }))

const routerState = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  replaced: [] as string[]
}))

const nativeWebView = vi.hoisted(() => ({
  postMessage: vi.fn<(message: string) => void>(),
  reload: vi.fn<() => void>()
}))

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
    React.useImperativeHandle(ref, () => nativeWebView)
    return React.createElement('WebView', props)
  })
  return { WebView, default: WebView }
})

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => safeArea.insets
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
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    Easing: { linear: 'linear' },
    Keyboard: { addListener: keyboard.addListener },
    // A getter, not a constant: the whole point of the Android case is that the same code reads a
    // different platform, and the hook reads `Platform.OS` when its effect runs.
    Platform: {
      get OS() {
        return platform.os
      }
    },
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
const { PaneViewerScreen } = await import('../../app/h/[remoteId]/pane/[paneId]')
const { PaneInputBar } = await import('../session/PaneInputBar')
const { TerminalPaneView } = await import('../session/TerminalPaneView')

const REMOTE = { id: 'remote-1', name: 'fable-m5max', target: { type: 'local' as const } }

/** The same scripted server `./pane-viewer-mount.test.tsx` drives, cut down to a live stream. */
function scriptedServer(): FakeTransport {
  const transport = new FakeTransport()
  transport.onOpen = (channel: FakeChannel) => {
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
                focused_pane_id: 'ws-1-p1',
                panes: [],
                splits: []
              }
            }
          })
        )
      }
    }
  }
  return transport
}

function host(name: string): ElementType {
  return name as unknown as ElementType
}

/** A `style` prop as rendered — object, array, or nested arrays — collapsed into one object. */
function flatten(style: unknown): Record<string, unknown> {
  const layers = ([style].flat(4) as unknown[]).filter(
    (layer): layer is Record<string, unknown> => typeof layer === 'object' && layer !== null
  )
  return Object.assign({}, ...layers) as Record<string, unknown>
}

let renderer: ReactTestRenderer | null = null

async function mount(withTransport: boolean): Promise<ReactTestRenderer> {
  const connections = withTransport ? [createTransportConnection(REMOTE, scriptedServer())] : []
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(
      <HerdrClientsProvider connections={connections}>
        <HerdrSnapshotProvider load={loadMockSnapshot}>
          {createElement(PaneViewerScreen, { remoteId: 'remote-1', paneId: 'ws-1-p1' })}
        </HerdrSnapshotProvider>
      </HerdrClientsProvider>
    )
  })
  if (!created) {
    throw new Error('did not render')
  }
  renderer = created
  return created
}

/** The input bar's own outermost `View` — the thing that has to clear the keyboard. */
function bar(target: ReactTestRenderer): ReactTestInstance {
  return target.root.findByType(PaneInputBar).findAllByType(host('View'))[0]!
}

/** How far the bar's `↵` edge is held off the window's bottom, in points. */
function barClearance(target: ReactTestRenderer): number {
  const style = flatten(bar(target).props['style'])
  const padding = typeof style['paddingBottom'] === 'number' ? style['paddingBottom'] : 0
  return padding + shift(target)
}

/** The bar's upward `translateY`, positive, or 0 when it is not transformed at all. */
function shift(target: ReactTestRenderer): number {
  const transform = flatten(bar(target).props['style'])['transform']
  if (!Array.isArray(transform)) {
    return 0
  }
  const entry = (transform as Record<string, unknown>[]).find((each) => 'translateY' in each)
  const value = entry?.['translateY']
  return typeof value === 'number' ? -value : 0
}

function raiseKeyboard(height = KEYBOARD_HEIGHT): void {
  act(() => {
    keyboard.emit('keyboardWillShow', { endCoordinates: { height } })
  })
}

function dropKeyboard(): void {
  act(() => {
    keyboard.emit('keyboardWillHide', { endCoordinates: { height: 0 } })
  })
}

/** Every command the RN side posted into the WebView document, parsed. */
function postedCommands(): Record<string, unknown>[] {
  return nativeWebView.postMessage.mock.calls.map(
    ([message]) => JSON.parse(message) as Record<string, unknown>
  )
}

function webReady(target: ReactTestRenderer): void {
  const webView = target.root.findByType(host('WebView'))
  act(() => {
    webView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'web-ready' }) } })
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
  platform.os = 'ios'
  safeArea.insets = IPHONE_PORTRAIT
  routerState.params = { remoteId: 'remote-1', paneId: 'ws-1-p1' }
  routerState.replaced = []
  keyboard.reset()
  nativeWebView.postMessage.mockClear()
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('the input bar clears the soft keyboard', () => {
  it('sits on the safe-area inset while the keyboard is down', async () => {
    const target = await mount(false)
    expect(shift(target)).toBe(0)
    expect(barClearance(target)).toBe(IPHONE_PORTRAIT.bottom)
  })

  it('rises by the whole keyboard when iOS reports one', async () => {
    const target = await mount(false)
    raiseKeyboard()
    // The measured defect in one number: the ↵ was 78pt off the bottom edge under a 336pt
    // keyboard. Now the bar's bottom edge is exactly on the keyboard's top edge.
    expect(barClearance(target)).toBe(KEYBOARD_HEIGHT)
    // And the inset is spent, not added — §D1's `max` at the other edge.
    expect(shift(target)).toBe(KEYBOARD_HEIGHT - IPHONE_PORTRAIT.bottom)
  })

  it('lifts the accessory row and the quick-command row with it, being one view', async () => {
    const target = await mount(false)
    raiseKeyboard()
    const lifted = bar(target)
    for (const label of ['Send input', 'Answer yes', 'Enter']) {
      const control = target.root.findAll((node) => node.props['accessibilityLabel'] === label)[0]
      expect(control, label).toBeDefined()
      // Every control of the bar is inside the one view that moved, so none of them can be left
      // behind under the keyboard.
      expect(ancestors(control!)).toContain(lifted)
    }
  })

  it('returns to the inset when the keyboard goes away — no permanent offset', async () => {
    const target = await mount(false)
    raiseKeyboard()
    dropKeyboard()
    expect(shift(target)).toBe(0)
    expect(barClearance(target)).toBe(IPHONE_PORTRAIT.bottom)
  })

  it('ignores a keyboard shorter than the inset instead of pushing the bar off-screen', async () => {
    const target = await mount(false)
    raiseKeyboard(20)
    expect(shift(target)).toBe(0)
    expect(barClearance(target)).toBe(IPHONE_PORTRAIT.bottom)
  })

  it('does not move on Android, whose window resizes for the IME itself', async () => {
    // `android/app/src/main/AndroidManifest.xml:18` is `windowSoftInputMode="adjustResize"`, so RN's
    // own layout has already lifted the bar; shifting it again would move it a second
    // keyboard-height up. This is the milestone that passed 4/4 on Android — the fix has to be a
    // no-op there, to the point of never subscribing.
    platform.os = 'android'
    safeArea.insets = ANDROID
    const target = await mount(false)
    expect(keyboard.subscriptions()).toBe(0)
    raiseKeyboard()
    expect(shift(target)).toBe(0)
    expect(barClearance(target)).toBe(ANDROID.bottom)
  })

  it('unsubscribes when the screen goes away', async () => {
    await mount(false)
    expect(keyboard.subscriptions()).toBe(2)
    act(() => renderer?.unmount())
    renderer = null
    expect(keyboard.subscriptions()).toBe(0)
  })
})

describe('lifting the bar leaves the terminal — and the PTY — alone', () => {
  it('sends the renderer no resize, reflow or measure when the keyboard moves', async () => {
    const target = await mount(true)
    webReady(target)
    await settle()
    // The stream is live: the renderer has been initialised and written to. Anything posted from
    // here on is the keyboard's doing.
    expect(postedCommands().some((command) => command['type'] === 'init')).toBe(true)
    nativeWebView.postMessage.mockClear()

    raiseKeyboard()
    dropKeyboard()
    raiseKeyboard()
    await settle()

    // M3's contract: the phone never resizes a shared PTY (`.prd/09` §BB requirement 4). A grid
    // change reaches the wire through one of these three and nothing else.
    expect(
      postedCommands().filter((command) =>
        ['resize', 'reflow', 'measure'].includes(String(command['type']))
      )
    ).toEqual([])
  })

  it('leaves the pane geometry byte-identical across the keyboard', async () => {
    const target = await mount(false)
    // Every style from the terminal pane up to the screen's root, not just the frame's own: the
    // cheap fix for a covered bar is `paddingBottom` on some ancestor of both, which shortens the
    // column the terminal is `flex: 1` in — invisible in a style assertion on the frame alone, and
    // on a device a re-fit and a `resize`. This is the chain that has to be unchanged.
    const paneChain = () => {
      const pane = target.root.findByType(TerminalPaneView)
      return [pane, ...ancestors(pane)].map((node) => flatten(node.props['style']))
    }
    const barStyle = () => flatten(bar(target).props['style'])
    const before = paneChain()
    const beforeBar = barStyle()
    raiseKeyboard()
    expect(paneChain()).toEqual(before)
    // The bar is the terminal frame's sibling in a column where the frame is `flex: 1`, so paying
    // for the lift with the bar's own box — `marginBottom`, `height`, `paddingBottom` — takes the
    // height straight out of the terminal. `transform` is the only key allowed to move.
    const afterBar = barStyle()
    expect(Object.keys(afterBar).filter((key) => afterBar[key] !== beforeBar[key])).toEqual([
      'transform'
    ])
    // And the terminal's own lift is still orca's caret lift, still unported and still 0.
    expect(target.root.findByType(TerminalPaneView).props.keyboardLift).toBe(0)
  })
})

/** Every ancestor of `node`, nearest first. */
function ancestors(node: ReactTestInstance): ReactTestInstance[] {
  const chain: ReactTestInstance[] = []
  let cursor: ReactTestInstance | null = node.parent
  while (cursor) {
    chain.push(cursor)
    cursor = cursor.parent
  }
  return chain
}
