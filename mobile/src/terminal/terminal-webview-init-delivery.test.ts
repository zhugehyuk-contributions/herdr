// Not from orca. The seam where a pane goes permanently blank with nothing in any log, measured on
// the iOS simulator on 2026-08-23 (`.prd/10-mobile-qa.md` iOS lab, cold launch, 80x40 fixture).
//
// The chain: `TerminalFrameSink` sets `opened` **before** it calls `init` and never issues a second
// one (`./terminal-frame-sink.ts`), so `TerminalWebViewHandle.init` is a one-shot for the life of a
// screen. `TerminalWebView` used to hand that one shot to `pendingMessages`, whose whole content
// `handleLoadStart` throws away. On a cold launch the first `full` frame lands ~70ms *before* the
// WebView begins loading its document, so the ordering measured on the device was:
//
//   pm.queue init  ->  wv.loadStart  ->  pm.clear-dropping [...,"init"]  ->  web-ready  ->  flush []
//
// and the terminal band stayed one flat colour (2,033,316 background pixels, zero `[fit]renderer`
// lines) for the rest of the session. No exception, no engine-error overlay: the document simply
// never heard about a terminal.
//
// So the snapshot now lives in a ref and `confirmWebReady` (re)sends it, which also closes the
// second door on the same room — a WebKit content-process loss reloads the document, and nothing in
// this app would ever have sent it an `init` again either.
import { createElement, createRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalWebView } from './TerminalWebView'
import type { TerminalWebViewHandle } from './terminal-webview-contract'

const nativeWebViewMethods = vi.hoisted(() => ({
  postMessage: vi.fn<(message: string) => void>(),
  reload: vi.fn<() => void>()
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active' },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: {
    absoluteFillObject: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
    create: (styles: unknown) => styles
  },
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  const WebView = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => nativeWebViewMethods)
    return React.createElement('WebView', props)
  })
  return { WebView, default: WebView }
})

vi.mock('lucide-react-native', () => ({ RefreshCw: 'RefreshCw' }))

// Why: mounting arms the web-ready watchdog; every test unmounts so its timer cannot fire in a
// later test's teardown (same reason as `./terminal-webview-engine-error.test.ts`).
let activeRenderer: ReactTestRenderer | null = null

function mountTerminalWebView() {
  const ref = createRef<TerminalWebViewHandle>()
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(TerminalWebView, { ref }))
  })
  if (!renderer || !ref.current) {
    throw new Error('TerminalWebView did not render')
  }
  activeRenderer = renderer
  return { handle: ref.current, renderer: renderer as ReactTestRenderer }
}

function fireLoadStart(renderer: ReactTestRenderer) {
  act(() => {
    renderer.root.findByType('WebView').props.onLoadStart()
  })
}

function postFromDocument(renderer: ReactTestRenderer, payload: Record<string, unknown>) {
  act(() => {
    renderer.root
      .findByType('WebView')
      .props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } })
  })
}

function postedCommands(): Array<Record<string, unknown>> {
  return nativeWebViewMethods.postMessage.mock.calls.map(([message]) => JSON.parse(message))
}

function postedTypes(): string[] {
  return postedCommands().map((command) => String(command.type))
}

describe('TerminalWebView init delivery', () => {
  afterEach(() => {
    if (activeRenderer) {
      act(() => {
        activeRenderer?.unmount()
      })
      activeRenderer = null
    }
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('delivers a snapshot taken before the document started loading', () => {
    const { handle, renderer } = mountTerminalWebView()

    // The cold-start order, exactly as measured: the frame beats the document's own load.
    handle.init(80, 39, 'SNAPSHOT-4417')
    fireLoadStart(renderer)
    postFromDocument(renderer, { type: 'web-ready' })

    const init = postedCommands().find((command) => command.type === 'init')
    expect(init).toBeDefined()
    expect(init?.initialData).toBe('SNAPSHOT-4417')
    expect(init?.cols).toBe(80)
    expect(init?.rows).toBe(39)
  })

  it('sends the snapshot before the writes that only mean anything against it', () => {
    const { handle, renderer } = mountTerminalWebView()

    handle.init(80, 39, 'SNAPSHOT-4417')
    fireLoadStart(renderer)
    // A diff that arrived while the replacement document was still loading: it is only meaningful
    // against the snapshot, so it must not overtake it.
    handle.resize(80, 40)
    postFromDocument(renderer, { type: 'web-ready' })

    const types = postedTypes()
    expect(types).toContain('init')
    expect(types).toContain('resize')
    expect(types.indexOf('init')).toBeLessThan(types.indexOf('resize'))
  })

  it('drops the chunks the snapshot supersedes rather than replaying them after it', () => {
    const { handle, renderer } = mountTerminalWebView()

    // Pre-snapshot data: bytes that belong to a buffer the snapshot is about to replace.
    handle.write('STALE-BEFORE-SNAPSHOT')
    handle.init(80, 39, 'SNAPSHOT-4417')
    fireLoadStart(renderer)
    postFromDocument(renderer, { type: 'web-ready' })

    const writes = postedCommands().filter((command) => command.type === 'write')
    expect(writes.every((command) => !String(command.data).includes('STALE'))).toBe(true)
  })

  it('gives a replacement document its own terminal after a content-process loss', () => {
    const { handle, renderer } = mountTerminalWebView()

    handle.init(80, 39, 'SNAPSHOT-4417')
    fireLoadStart(renderer)
    postFromDocument(renderer, { type: 'web-ready' })
    expect(postedTypes().filter((type) => type === 'init')).toHaveLength(1)

    // WKWebView loses its content process and reloads: a fresh, empty document. Nothing upstream
    // will ever call `init` again — the sink is `opened` for good.
    act(() => {
      renderer.root.findByType('WebView').props.onContentProcessDidTerminate()
    })
    fireLoadStart(renderer)
    postFromDocument(renderer, { type: 'web-ready' })

    const inits = postedCommands().filter((command) => command.type === 'init')
    expect(inits).toHaveLength(2)
    expect(inits[1]?.initialData).toBe('SNAPSHOT-4417')
  })

  it('does not re-send the snapshot to a document that already has it', () => {
    const { handle, renderer } = mountTerminalWebView()

    fireLoadStart(renderer)
    postFromDocument(renderer, { type: 'web-ready' })
    handle.init(80, 39, 'SNAPSHOT-4417')

    // A foreground recovery ping re-confirms the *same* document; that is not a new terminal.
    handle.prepareForForegroundRecovery()
    const ping = postedCommands().find((command) => command.type === 'ping')
    expect(ping).toBeDefined()
    postFromDocument(renderer, { type: 'pong', pingId: ping?.id })

    expect(postedCommands().filter((command) => command.type === 'init')).toHaveLength(1)
  })
})
