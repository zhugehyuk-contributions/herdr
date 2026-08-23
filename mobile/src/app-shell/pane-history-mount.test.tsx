// Not from orca — there is no orca suite to port, for the same reason `src/session/pane-history.ts`
// has no orca counterpart: orca's history is its xterm scrollback and needs no screen. This is the
// wiring half of M6c, against the real route file.
//
// What it proves, through the real files:
//   1. the history affordance asks the server the right question — `pane.read` with `pane_id`,
//      `source: recent_unwrapped` and `lines`, on the JSON bridge, for the pane the screen is on;
//   2. the answer is on screen — the server's text is rendered, on a surface that is *not* the
//      terminal WebView (the renderer's absolute cursor positioning makes the xterm buffer
//      unusable as history; `.prd/09` §CC);
//   3. **it costs one exec** — re-opening the surface opens no new `ApiRequest` channel (B8), and
//      only an explicit Refresh does;
//   4. **the live pane is untouched** — the observe stream's channel is the same one, still open,
//      no second `ObserveTerminal`, no `RetargetTerminal`, and no `Resize` (M3's PTY contract).
//
// What it does NOT prove: that the overlay is readable, that the button is reachable under a thumb,
// or that a real pane's scrollback is non-empty. Those are `.prd/10-mobile-qa.md`'s.
import { Children, createElement, type ElementType, type ReactNode } from 'react'
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
import { PANE_HISTORY_LINES } from '../session/pane-history'
import type { HerdrRemoteConnection } from '../transport/herdr-connection'

const routerState = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  replaced: [] as string[]
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
    React.useImperativeHandle(ref, () => ({ postMessage: () => {}, reload: () => {} }))
    return React.createElement('WebView', props)
  })
  return { WebView, default: WebView }
})

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

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
const FIRST_PANE = 'ws-1-p1'
const SECOND_PANE = 'ws-1-p2'

/** What the scripted server answers `pane.read` with, per pane, and what it recorded being asked. */
type Scripted = {
  transport: FakeTransport
  /** `ClientMessage` payload hex per client-bridge channel, in the order the channels opened. */
  sent: string[][]
  /** Every JSON API request the server saw, in order. */
  requests: { method: string; params: Record<string, unknown> }[]
  /** Bumped per `pane.read` so a refresh is distinguishable from a cache hit on screen. */
  generation: number
}

/**
 * The same scripted peer the sibling suites use, plus a `pane.read` handler.
 *
 * The JSON half now dispatches by method instead of answering everything with a layout: this suite's
 * whole subject is a *second* method on that bridge, and a peer that answered `pane_layout` to
 * `pane.read` would let a wrong request pass.
 */
function scriptedServer(): Scripted {
  const transport = new FakeTransport()
  const state: Scripted = { transport, sent: [], requests: [], generation: 0 }
  transport.onOpen = (channel: FakeChannel) => {
    const index = state.sent.push([]) - 1
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
        state.sent[index]!.push(toHex(payload))
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
        const request = JSON.parse(line) as {
          id: string
          method: string
          params?: Record<string, unknown>
        }
        state.requests.push({ method: request.method, params: request.params ?? {} })
        channel.emitLine(JSON.stringify({ id: request.id, result: resultFor(request, state) }))
      }
    }
  }
  return state
}

function resultFor(
  request: { method: string; params?: Record<string, unknown> },
  state: Scripted
): Record<string, unknown> {
  if (request.method === 'pane.read') {
    state.generation += 1
    const paneId = String(request.params?.['pane_id'] ?? '')
    return {
      type: 'pane_read',
      read: {
        pane_id: paneId,
        workspace_id: 'ws-1',
        tab_id: 'ws-1-tab-1',
        source: request.params?.['source'],
        format: request.params?.['format'],
        // The marker carries both the pane and the read number, so "rendered", "cached" and
        // "refreshed" are three distinguishable strings on screen rather than three assertions
        // about call counts.
        text: `scrolled-off ${paneId} read#${state.generation}\nsecond line\n`,
        revision: 0,
        truncated: true
      }
    }
  }
  return {
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

async function routeTo(
  paneId: string,
  connections: readonly HerdrRemoteConnection[]
): Promise<void> {
  routerState.params = { remoteId: 'remote-1', paneId }
  await act(async () => {
    renderer?.update(tree(connections))
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 30; i += 1) {
      await Promise.resolve()
    }
  })
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

function pressableWithLabel(target: ReactTestRenderer, label: string) {
  const found = target.root
    .findAllByType(host('Pressable'))
    .find((node) => node.props.accessibilityLabel === label)
  if (!found) {
    throw new Error(`no pressable labelled ${JSON.stringify(label)}`)
  }
  return found
}

async function press(target: ReactTestRenderer, label: string): Promise<void> {
  const button = pressableWithLabel(target, label)
  await act(async () => {
    ;(button.props.onPress as () => void)()
  })
  await settle()
}

/** How many ssh execs the JSON bridge has cost so far — one channel per request is the API's shape. */
function execCount(server: Scripted): number {
  return server.transport.ofKind(HerdrChannelKind.ApiRequest).length
}

function paneReads(server: Scripted): { method: string; params: Record<string, unknown> }[] {
  return server.requests.filter((request) => request.method === 'pane.read')
}

beforeEach(() => {
  routerState.params = { remoteId: 'remote-1', paneId: FIRST_PANE }
  routerState.replaced = []
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('pane history (M6c)', () => {
  it('asks pane.read for this pane, on the JSON bridge, when the history button is pressed', async () => {
    const server = scriptedServer()
    const connection = createTransportConnection(REMOTE, server.transport)
    const target = await mountAt(FIRST_PANE, [connection])
    await settle()

    expect(paneReads(server)).toEqual([])
    await press(target, 'Open pane history')

    expect(paneReads(server)).toEqual([
      {
        method: 'pane.read',
        params: {
          pane_id: FIRST_PANE,
          source: 'recent_unwrapped',
          lines: PANE_HISTORY_LINES,
          format: 'text'
        }
      }
    ])
  })

  it('renders the server text on its own surface — not into the terminal WebView', async () => {
    const server = scriptedServer()
    const connection = createTransportConnection(REMOTE, server.transport)
    const target = await mountAt(FIRST_PANE, [connection])
    await settle()
    await press(target, 'Open pane history')

    const texts = textNodes(target)
    expect(texts).toContain(`scrolled-off ${FIRST_PANE} read#1\nsecond line\n`)
    // The read is a snapshot and the surface says so: how much came back, that older lines were
    // left behind (`truncated`), and when it was read.
    expect(texts.some((text) => text.startsWith('2 lines (older lines omitted) · read '))).toBe(
      true
    )

    // The whole point of a separate surface: the history text went to React Native, never to the
    // document whose buffer the next frame overwrites (`src/protocol/render_ansi.rs:613`).
    const webView = target.root.findByType(host('WebView'))
    expect(webView.props.nestedScrollEnabled).toBeFalsy()
    expect(JSON.stringify(webView.props)).not.toContain('scrolled-off')
  })

  it('costs one exec per pane — re-opening the surface reads from cache (B8)', async () => {
    const server = scriptedServer()
    const connection = createTransportConnection(REMOTE, server.transport)
    const target = await mountAt(FIRST_PANE, [connection])
    await settle()

    await press(target, 'Open pane history')
    const afterFirstOpen = execCount(server)
    expect(paneReads(server)).toHaveLength(1)

    await press(target, 'Close pane history')
    await press(target, 'Open pane history')
    await press(target, 'Close pane history')
    await press(target, 'Open pane history')

    // The receipt is the *channel* count, not a call count: one JSON request is one ssh exec is one
    // remote herdr process (`src/api/server.rs:139-152`), which is the cost B8 is about.
    expect(execCount(server)).toBe(afterFirstOpen)
    expect(paneReads(server)).toHaveLength(1)
    // And the screen still shows the first read, rather than an empty surface.
    expect(textNodes(target)).toContain(`scrolled-off ${FIRST_PANE} read#1\nsecond line\n`)
  })

  it('spends a second exec only on an explicit refresh', async () => {
    const server = scriptedServer()
    const connection = createTransportConnection(REMOTE, server.transport)
    const target = await mountAt(FIRST_PANE, [connection])
    await settle()

    await press(target, 'Open pane history')
    await press(target, 'Re-read pane history')

    expect(paneReads(server)).toHaveLength(2)
    expect(textNodes(target)).toContain(`scrolled-off ${FIRST_PANE} read#2\nsecond line\n`)
  })

  it('leaves the live observe stream alone — same channel, still open, no re-attach', async () => {
    const server = scriptedServer()
    const connection = createTransportConnection(REMOTE, server.transport)
    const target = await mountAt(FIRST_PANE, [connection])
    await settle()

    const before = server.sent.flat().slice()
    const stream = server.transport.ofKind(HerdrChannelKind.ClientStream)
    expect(stream).toHaveLength(1)

    await press(target, 'Open pane history')

    // Asserted **while the overlay is open**, which is the whole constraint: the terminal is
    // covered, not replaced. Unmounting it would destroy the xterm document, and since the pane's
    // ANSI stream is a sequence of absolute-positioned overwrites rather than a replayable log
    // (`src/protocol/render_ansi.rs:613`), a remounted document stays blank until the server happens
    // to send another full frame — i.e. closing history would hand back a broken screen.
    expect(target.root.findAllByType(host('WebView'))).toHaveLength(1)
    const during = server.transport.ofKind(HerdrChannelKind.ClientStream)
    expect(during).toHaveLength(1)
    expect(during[0]).toBe(stream[0])
    expect(during[0]!.closed).toBe(false)
    expect(server.sent.flat()).toEqual(before)

    await press(target, 'Re-read pane history')
    expect(target.root.findAllByType(host('WebView'))).toHaveLength(1)
    await press(target, 'Close pane history')

    // Nothing was said on the client bridge at all: no second `ObserveTerminal` (0x0c), no
    // `RetargetTerminal` (0x0e), and no `Resize` — history is read-only and lives on the other
    // bridge, so M3's PTY contract is untouched.
    expect(server.sent.flat()).toEqual(before)
    const after = server.transport.ofKind(HerdrChannelKind.ClientStream)
    expect(after).toHaveLength(1)
    expect(after[0]).toBe(stream[0])
    expect(after[0]!.closed).toBe(false)
    expect(target.root.findAllByType(host('WebView'))).toHaveLength(1)
  })

  it('closes on a pane change and does not read the new pane until asked', async () => {
    const server = scriptedServer()
    const connection = createTransportConnection(REMOTE, server.transport)
    const target = await mountAt(FIRST_PANE, [connection])
    await settle()
    await press(target, 'Open pane history')
    expect(paneReads(server)).toHaveLength(1)

    await routeTo(SECOND_PANE, [connection])
    await settle()

    // A switch is the gesture the user makes most often (M6a), so it must not carry an exec — and
    // the surface must not keep showing the previous pane's scrollback over the new pane's screen.
    expect(paneReads(server)).toHaveLength(1)
    expect(textNodes(target)).not.toContain(`scrolled-off ${FIRST_PANE} read#1\nsecond line\n`)
    expect(() => pressableWithLabel(target, 'Close pane history')).toThrow()

    await press(target, 'Open pane history')
    expect(paneReads(server).map((request) => request.params['pane_id'])).toEqual([
      FIRST_PANE,
      SECOND_PANE
    ])
  })

  it('offers no history at all without a transport, instead of a button that cannot answer', async () => {
    const target = await mountAt(FIRST_PANE)
    expect(pressableWithLabel(target, 'Open pane history').props.disabled).toBe(true)
  })
})
