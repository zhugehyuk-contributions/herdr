// Not from orca — orca has no pane swipe (`src/session/pane-swipe.ts` header).
//
// The other half of M6a's iOS repair: `./terminal-webview-pane-swipe-report.test.ts` proves the
// document *posts* the swipe; this proves what RN does with it. The page is outside the trust
// boundary — this app serves the document, but everything that arrives at `onMessage` is JSON the
// document wrote — so the two numbers are checked rather than cast through `as number`.
//
// Why that check earns a test instead of a comment: a bad pair does not crash. `"120"` or `NaN`
// would flow into `resolvePaneSwipeTarget` -> `paneSwipeDirection`, whose own `Number.isFinite`
// guard returns `null` silently. The symptom would be a swipe that does nothing, indistinguishable
// from a swipe the page never sent — which is exactly the reading that cost §JJ eight rounds.
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
// later test's teardown (same reason as `./terminal-webview-init-delivery.test.ts`).
let activeRenderer: ReactTestRenderer | null = null

function mountTerminalWebView(onPaneSwipe: (translation: unknown) => void) {
  const ref = createRef<TerminalWebViewHandle>()
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(TerminalWebView, { onPaneSwipe, ref }))
  })
  if (!renderer) {
    throw new Error('TerminalWebView did not render')
  }
  activeRenderer = renderer
  return renderer as ReactTestRenderer
}

function postFromDocument(renderer: ReactTestRenderer, payload: Record<string, unknown>) {
  act(() => {
    renderer.root
      .findByType('WebView')
      .props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } })
  })
}

describe('TerminalWebView pane-swipe reports from the page', () => {
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

  it('hands a well-formed report to the screen, both numbers intact', () => {
    const onPaneSwipe = vi.fn()
    const renderer = mountTerminalWebView(onPaneSwipe)

    postFromDocument(renderer, { type: 'pane-swipe', translationX: -160, translationY: 6 })

    expect(onPaneSwipe).toHaveBeenCalledTimes(1)
    expect(onPaneSwipe).toHaveBeenCalledWith({ translationX: -160, translationY: 6 })
  })

  it('logs both outcomes, so a dropped report is distinguishable from one never sent', () => {
    // The 9차 device round could confirm this path only through the *page's* `[touchProbe]`
    // counters — nothing on the RN side said a word — and asked for this line by name. Two states
    // look identical from outside without it: the page never sent, and the page sent something
    // malformed that was dropped here. Asserted rather than left as a comment because a log line
    // is exactly the kind of thing a later edit deletes as noise.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const renderer = mountTerminalWebView(vi.fn())
      postFromDocument(renderer, { type: 'pane-swipe', translationX: -160, translationY: 6 })
      postFromDocument(renderer, { type: 'pane-swipe', translationX: '120', translationY: 6 })
      const lines = log.mock.calls.map((call) => String(call[0]))
      expect(lines.filter((line) => line.startsWith('[paneSwipeMsg]'))).toEqual([
        '[paneSwipeMsg] ok=true dx=-160 dy=6',
        '[paneSwipeMsg] ok=false dx=120 dy=6'
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('refuses every malformed pair rather than passing it on to be dropped silently', () => {
    const onPaneSwipe = vi.fn()
    const renderer = mountTerminalWebView(onPaneSwipe)

    const rejected: Array<Record<string, unknown>> = [
      // Numbers as strings: what a hand-built JSON payload or a stringifying bridge produces.
      { type: 'pane-swipe', translationX: '-160', translationY: '6' },
      { type: 'pane-swipe', translationX: -160, translationY: '6' },
      // NaN survives no round trip — `JSON.stringify(NaN)` is `null` — so it arrives as null, and
      // the arithmetic form of the same accident (0/0 computed page-side) arrives as null too.
      { type: 'pane-swipe', translationX: Number.NaN, translationY: 6 },
      { type: 'pane-swipe', translationX: null, translationY: 6 },
      // Infinity, the other non-finite: `startX` unset would produce it, not a crash.
      { type: 'pane-swipe', translationX: Number.POSITIVE_INFINITY, translationY: 6 },
      // A field that never made it out of the page.
      { type: 'pane-swipe', translationX: -160 },
      { type: 'pane-swipe', translationY: 6 },
      { type: 'pane-swipe' },
      // The whole payload as an object, i.e. a shape change on the page side.
      { type: 'pane-swipe', translation: { translationX: -160, translationY: 6 } }
    ]
    for (const payload of rejected) {
      postFromDocument(renderer, payload)
    }

    expect(onPaneSwipe).not.toHaveBeenCalled()
  })

  it('keeps zero, which is a real reading and not a missing one', () => {
    // A finger that yielded horizontally and came back to where it started. The screen decides it
    // is not a switch (`paneSwipeDirection`'s 64px commit distance); this layer must not decide
    // that for it by discarding the message.
    const onPaneSwipe = vi.fn()
    const renderer = mountTerminalWebView(onPaneSwipe)

    postFromDocument(renderer, { type: 'pane-swipe', translationX: 0, translationY: 0 })

    expect(onPaneSwipe).toHaveBeenCalledWith({ translationX: 0, translationY: 0 })
  })

  it('does not confuse the touch probe with a swipe', () => {
    // Both are §JJ instruments posted by the same handler, one line apart, and the probe carries
    // no translation at all. Routing it here would call the screen with garbage on every gesture.
    const onPaneSwipe = vi.fn()
    const renderer = mountTerminalWebView(onPaneSwipe)

    postFromDocument(renderer, { type: 'touch-probe', phase: 'end', moves: 24 })

    expect(onPaneSwipe).not.toHaveBeenCalled()
  })

  it('survives a page that reports a swipe when the screen wired no callback', () => {
    // Android's shape: the document still posts `pane-swipe` there, and the screen passes
    // `undefined` so RN drops it. That must be a no-op, not a TypeError inside `onMessage` — which
    // would take the rest of the message routing down with it.
    const ref = createRef<TerminalWebViewHandle>()
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(createElement(TerminalWebView, { ref }))
    })
    activeRenderer = renderer
    expect(() =>
      postFromDocument(renderer as unknown as ReactTestRenderer, {
        type: 'pane-swipe',
        translationX: -160,
        translationY: 6
      })
    ).not.toThrow()
  })
})
