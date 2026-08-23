// Not from orca — orca collects nothing under `app/` (its vitest `include` is `src/**`, copied
// verbatim), so the sibling of this file, `route-shell-mount.test.tsx`, already exists to keep that
// gap from being inherited. This is the same thing for the stage-7 route: it mounts the real
// `app/h/[remoteId]/pane/[paneId].tsx` and drives it from a scripted transport, so "M2 완성" is a
// test result rather than a screenshot.
//
// What it proves, through the real files:
//   1. the viewer mounts on mock data with no transport at all, and says so instead of pretending;
//   2. with a connection, the handshake reaches the ported `TerminalWebView` as `init` + `write`
//      commands — i.e. the wire really is joined to the renderer;
//   3. a chip tap re-targets: `RetargetTerminal` on the SAME channel, naming the other pane
//      (M6/B6 — it used to be a second channel and a second `ObserveTerminal`).
//
// What it does NOT prove: that any of this composes on a device, or that the bytes make a picture.
// The WebView is a mock here and no build has been run; `test/live/paneViewer.live.test.tsx` runs
// the same route against a real server and reads the resulting xterm buffer.
import { Children, createElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HerdrChannelKind, PROTOCOL_VERSION } from '@herdr/client-ts'
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
import type { HerdrRemoteConnection } from '../transport/herdr-connection'

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

// The screens read the real safe-area inset since §D1. Its provider comes from the navigator on a
// device, and the navigator is mocked away here — so is the library, which does not load under
// this environment's transform at all. Zero insets = the geometry every assertion below was
// written against; `./safe-area-mount.test.tsx` is where a real inset is the subject.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

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
    // `usePaneObserver` subscribes for the §Q foreground nudge, so the mock owes a subscription
    // rather than only a current value.
    AppState: {
      currentState: 'active',
      addEventListener: () => ({ remove: () => {} })
    },
    Easing: { linear: 'linear' },
    // M3+§BB: the bar subscribes to the soft keyboard so its `↵` can climb above it
    // (`src/layout/use-soft-keyboard-height.ts`). A mock that owes only values, not subscriptions,
    // makes the bar throw on mount; `./keyboard-lift-mount.test.tsx` is where the events are the
    // subject.
    Keyboard: { addListener: () => ({ remove: () => {} }) },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: {
      absoluteFillObject: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
      create: (styles: unknown) => styles
    },
    Text: 'Text',
    // M3: the route now mounts `src/session/PaneInputBar.tsx`, which is a real `TextInput`.
    TextInput: 'TextInput',
    View: 'View'
  }
})

const { HerdrClientsProvider } = await import('../transport/herdr-clients-context')
const { createTransportConnection } = await import('../transport/herdr-connection')
const { HerdrSnapshotProvider } = await import('../api/snapshot-context')
const { loadMockSnapshot } = await import('../api/mock/mock-snapshot-loader')
const { PaneViewerScreen } = await import('../../app/h/[remoteId]/pane/[paneId]')
const { default: PaneViewerRoute } = await import('../../app/h/[remoteId]/pane/[paneId]')

const REMOTE = { id: 'remote-1', name: 'fable-m5max', target: { type: 'local' as const } }

/** `ClientMessage` payload hex per client-bridge channel, in the order the channels were opened. */
type Scripted = { transport: FakeTransport; sent: string[][] }

function scriptedServer(): Scripted {
  const transport = new FakeTransport()
  const sent: string[][] = []
  transport.onOpen = (channel: FakeChannel) => {
    const index = sent.push([]) - 1
    const write = channel.write.bind(channel)
    // The server reads and validates the client's wire-ABI prelude before any bincode; this gate is
    // that step, and it keeps `sent` a list of `ClientMessage`s rather than of writes.
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
          // 0x0c ObserveTerminal, 0x0e RetargetTerminal (M6/B6). A real server answers both the
          // same way: it resets this client's render baseline, so the next frame is a full one.
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
  return { transport, sent }
}

function host(name: string): ElementType {
  return name as unknown as ElementType
}

let renderer: ReactTestRenderer | null = null

async function mount(
  node: ReactNode,
  connections: readonly HerdrRemoteConnection[] = []
): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(
      <HerdrClientsProvider connections={connections}>
        <HerdrSnapshotProvider load={loadMockSnapshot}>{node}</HerdrSnapshotProvider>
      </HerdrClientsProvider>
    )
  })
  if (!created) {
    throw new Error('did not render')
  }
  renderer = created
  return created
}

function textNodes(target: ReactTestRenderer): string[] {
  return target.root
    .findAllByType(host('Text'))
    .map((node) =>
      Children.toArray(node.props.children as ReactNode)
        .map((child) =>
          typeof child === 'string' || typeof child === 'number' ? String(child) : ''
        )
        .join('')
    )
    .filter((text) => text.length > 0)
}

/** Every command the RN side posted into the WebView document, parsed. */
function postedCommands(): Record<string, unknown>[] {
  return nativeWebView.postMessage.mock.calls.map(
    ([message]) => JSON.parse(message) as Record<string, unknown>
  )
}

/**
 * Tells the ported `TerminalWebView` that its document loaded.
 *
 * Not ceremony: until this message arrives every command is *queued* rather than posted
 * (`src/terminal/terminal-webview-pending-messages.ts`), which is orca's fix for writing terminal
 * chunks into a document that is not there yet. A test that skipped it would see zero commands and
 * read that as "the wire is not joined to the renderer".
 */
function webReady(target: ReactTestRenderer): void {
  const webView = target.root.findByType(host('WebView'))
  act(() => {
    webView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'web-ready' }) } })
  })
}

/** Lets the observer's promise chain (`pane.layout`, channel open, handshake) run to completion. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 30; i += 1) {
      await Promise.resolve()
    }
  })
}

beforeEach(() => {
  routerState.params = { remoteId: 'remote-1', paneId: 'ws-1-p1' }
  routerState.replaced = []
  nativeWebView.postMessage.mockClear()
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('pane viewer route', () => {
  it('renders the workspace chips across tabs, with the routed pane active', async () => {
    const target = await mount(
      createElement(PaneViewerScreen, { remoteId: 'remote-1', paneId: 'ws-1-p1' })
    )
    const texts = textNodes(target)
    // Every pane of ws-1, flattened out of its two tabs — the tab survives as the chip's label.
    expect(texts).toContain('1-1')
    expect(texts).toContain('1-2')
    expect(texts).toContain('2-1')
    expect(texts.filter((entry) => entry.startsWith('tab '))).toEqual([
      'tab 1 · herdr 1',
      'tab 1 · herdr 1',
      'tab 2 · herdr 2'
    ])
    // Exactly one WebView: this viewer mounts the pane it is showing and no others (unlike orca,
    // which keeps every terminal alive — see the route file's header for why).
    expect(target.root.findAllByType(host('WebView'))).toHaveLength(1)
  })

  it('says there is no transport instead of pretending the mock is a server', async () => {
    const target = await mount(
      createElement(PaneViewerScreen, { remoteId: 'remote-1', paneId: 'ws-1-p1' })
    )
    expect(textNodes(target)).toContain('no transport')
    expect(postedCommands().filter((command) => command['type'] === 'init')).toEqual([])
  })

  it('joins the wire to the renderer: real frames arrive as init + write', async () => {
    const server = scriptedServer()
    const connection = createTransportConnection(REMOTE, server.transport)
    const target = await mount(
      createElement(PaneViewerScreen, { remoteId: 'remote-1', paneId: 'ws-1-p1' }),
      [connection]
    )
    webReady(target)
    await settle()

    // Hello then ObserveTerminal, naming the routed pane.
    expect(server.sent.flat().map((hex) => hex.slice(0, 2))).toEqual(['00', '0c'])
    // `ObserveTerminal` = tag 0c, byte length 07, then the ASCII of `ws-1-p1`.
    expect(server.sent.flat()[1]).toBe('0c0777732d312d7031')
    // The geometry came from the pane, not from any device metric: cols 0x78 = 120 is
    // `pane.layout`'s area width, rows 0x2c = 44 is the fixture's own `scroll.viewport_rows`,
    // which is exact and therefore beats the area's 40 (`src/session/observer-geometry.ts`).
    //
    // The version varint is spliced from `PROTOCOL_VERSION` rather than written out: the claim
    // under test is the geometry, and a literal version turns every protocol bump into a failure
    // of a geometry assertion that never changed.
    const versionVarint = PROTOCOL_VERSION.toString(16).padStart(2, '0')
    expect(server.sent.flat()[0]).toBe(`00${versionVarint}782c000001000001`)

    const commands = postedCommands()
    const init = commands.find((command) => command['type'] === 'init')
    expect(init).toMatchObject({ cols: 100, rows: 30 })
    expect(commands.some((command) => command['type'] === 'write')).toBe(true)
  })

  it('re-targets on a chip tap — RetargetTerminal on the SAME channel, naming the other pane', async () => {
    const server = scriptedServer()
    const connection = createTransportConnection(REMOTE, server.transport)
    routerState.params = { remoteId: 'remote-1', paneId: 'ws-1-p1' }
    const target = await mount(createElement(PaneViewerRoute), [connection])
    await settle()

    // `tab ` prefix, not "every labelled Pressable": since M3 the screen also carries the input
    // bar's quick-command and accessory keys, which are Pressables with labels of their own.
    const chips = target.root
      .findAllByType(host('Pressable'))
      .filter((node) => String(node.props.accessibilityLabel).startsWith('tab '))
    expect(chips.map((node) => node.props.accessibilityLabel)).toEqual([
      'tab 1 · herdr 1 1-1',
      'tab 1 · herdr 1 1-2',
      'tab 2 · herdr 2 2-1'
    ])
    await act(async () => {
      chips[2]!.props.onPress()
    })
    // The route form navigates laterally rather than stacking panes.
    expect(routerState.replaced).toEqual(['/h/remote-1/pane/ws-1-p3'])

    // Now drive the screen at the new segment, as expo-router would.
    routerState.params = { remoteId: 'remote-1', paneId: 'ws-1-p3' }
    await act(async () => {
      renderer?.update(
        <HerdrClientsProvider connections={[connection]}>
          <HerdrSnapshotProvider load={loadMockSnapshot}>
            <PaneViewerRoute />
          </HerdrSnapshotProvider>
        </HerdrClientsProvider>
      )
    })
    await settle()

    // M6/B6. Before `RetargetTerminal` this was two `ObserveTerminal`s on two channels; now it is
    // one handshake, one observe, one retarget, all on the channel that was already open.
    const observes = server.sent.flat().filter((hex) => hex.startsWith('0c'))
    expect(observes).toHaveLength(1)
    expect(observes[0]).toContain(toHex(new TextEncoder().encode('ws-1-p1')))

    const retargets = server.sent.flat().filter((hex) => hex.startsWith('0e'))
    expect(retargets).toHaveLength(1)
    expect(retargets[0]).toContain(toHex(new TextEncoder().encode('ws-1-p3')))
    // `0e` <len> <target> then the nested TerminalSessionMode tag — `00` = Observe, a UNIT variant,
    // so the frame ENDS there. A trailing `00` would be a `Control{takeover:false}` promotion that
    // resizes a desktop pane to this phone's grid.
    expect(retargets[0]).toBe(`0e07${toHex(new TextEncoder().encode('ws-1-p3'))}00`)

    // One resident client channel for both panes, still open. This is the assertion the milestone
    // is measured on: on the ssh bridge each of these is an exec channel plus a handshake plus a
    // full ANSI baseline.
    const streams = server.transport.ofKind(HerdrChannelKind.ClientStream)
    expect(streams).toHaveLength(1)
    expect(streams[0]!.closed).toBe(false)
  })
})
