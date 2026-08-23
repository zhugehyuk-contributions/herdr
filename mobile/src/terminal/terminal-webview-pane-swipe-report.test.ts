// Not from orca — orca has no pane swipe at all (`src/session/pane-swipe.ts` header: in orca a drag
// on the terminal is TUI input, so the horizontal axis was already spent).
//
// What this pins is M6a's iOS repair, and the repair is a inversion worth stating plainly: on iOS
// the WebView wins the UIKit gesture arbitration outright. Eight measured rounds — passive
// listeners, `touch-action: none`, `preventDefault` removed, RNGH
// `blocksExternalGesture(Gesture.Native())` — all ended with `[paneSwipe] finalize dx=0` while the
// document counted every touchmove of the same drag (`.prd/09-review-followups.md` §JJ). So the
// page reports the swipe it is already receiving, using the *same* window the recognizer would have
// used: `shouldYieldHorizontal` is compiled from `PANE_SWIPE_ACTIVATE_OFFSET_X` /
// `PANE_SWIPE_AXIS_RATIO`, the recognizer's own thresholds.
//
// `./terminal-webview-horizontal-yield.test.ts` reads that rule as *text*; this file runs it. The
// three things text cannot check are exactly the three that would ship a dead repair: that a
// horizontal drag posts one message and not one per touchmove, that a vertical drag posts none (a
// swipe that ate scrollback would be a worse defect than no swipe), and that a zoomed pane posts
// none (there the horizontal axis is the reader's pan and yielding it takes panning away).
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { XTERM_HTML } from './terminal-webview-html'
import { PANE_SWIPE_ACTIVATE_OFFSET_X } from '../session/pane-swipe'

function iifeSource(): string {
  const start = XTERM_HTML.indexOf('(function() {')
  const end = XTERM_HTML.lastIndexOf('})();')
  return XTERM_HTML.slice(start, end + '})();'.length)
}

function bodyMarkup(): string {
  const start = XTERM_HTML.indexOf('<body>') + '<body>'.length
  const end = XTERM_HTML.indexOf('<script>', start)
  return XTERM_HTML.slice(start, end)
}

type TerminalStub = ReturnType<typeof makeTerminal>
type RegisteredListener = {
  listener: EventListenerOrEventListenerObject
  options?: boolean | AddEventListenerOptions
  type: string
}

// The same fixture as `./terminal-webview-pinch-zoom.test.ts`: the pane measured by the 2026-08-23
// QA run, on the phone it was read on. A 213-column grid is fit-scaled *below* 1 on this viewport,
// which is the resting state every swipe has to work in.
const SERVER_COLS = 213
const SERVER_ROWS = 51
const CELL_WIDTH = 8
const CELL_HEIGHT = 15
const VIEWPORT_WIDTH = 381
const VIEWPORT_HEIGHT = 612

type TerminalOptions = { cols?: number; fontSize?: number; rows?: number }

function makeTerminal(options: TerminalOptions) {
  const terminal = {
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    options: { fontSize: options.fontSize ?? 13 },
    modes: { mouseTrackingMode: 'none' as string },
    element: null as HTMLElement | null,
    _core: {
      _renderService: { dimensions: { css: { cell: { width: CELL_WIDTH, height: CELL_HEIGHT } } } }
    },
    buffer: {
      active: {
        baseY: 0,
        type: 'normal' as const,
        viewportY: 0,
        cursorY: 0,
        length: 1,
        getLine: () => null
      }
    },
    write(_data: string, callback?: () => void) {
      callback?.()
    },
    open(surface: HTMLElement) {
      terminal.element = surface
    },
    loadAddon() {},
    resize(cols: number, rows: number) {
      terminal.cols = cols
      terminal.rows = rows
    },
    clear() {},
    reset() {},
    refresh() {},
    selectAll() {},
    clearSelection() {},
    select() {},
    scrollLines() {},
    scrollToBottom() {},
    scrollToLine() {},
    attachCustomKeyEventHandler() {},
    getSelection: () => '',
    onData: () => ({ dispose() {} }),
    onLineFeed: () => ({ dispose() {} }),
    onScroll: () => ({ dispose() {} }),
    onWriteParsed: () => ({ dispose() {} }),
    dispose() {}
  }
  return terminal
}

function terminalSurface(): HTMLElement {
  const surface = document.getElementById('terminal-surface')
  if (!surface) {
    throw new Error('terminal surface missing')
  }
  return surface
}

type TouchPoint = { clientX: number; clientY: number }

// Why hand-rolled: happy-dom has no TouchEvent constructor, and the WebView handlers only ever read
// `touches[].clientX/Y` — the same duck typing `./terminal-webview-pinch-zoom.test.ts` does.
function dispatchTouch(type: 'touchstart' | 'touchmove' | 'touchend', touches: TouchPoint[]): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', { value: touches })
  terminalSurface().dispatchEvent(event)
}

describe('the terminal document reports the pane swipe it kept', () => {
  let animationFrames: Array<() => void>
  let postMessage: ReturnType<typeof vi.fn>
  let registeredDocumentListeners: RegisteredListener[]
  let registeredWindowListeners: RegisteredListener[]
  let terminals: TerminalStub[]

  function boot(): void {
    document.body.innerHTML = bodyMarkup()
    new Function(iifeSource())()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'init',
          cols: SERVER_COLS,
          rows: SERVER_ROWS,
          initialData: ''
        })
      })
    )
    flushFrames()
  }

  function flushFrames(): void {
    for (let i = 0; i < 8 && animationFrames.length > 0; i++) {
      animationFrames.shift()?.()
    }
  }

  /** Every message the page posted, in order, narrowed to the one type this file is about. */
  function paneSwipes(): Array<Record<string, unknown>> {
    return postMessage.mock.calls
      .map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>)
      .filter((msg) => msg.type === 'pane-swipe')
  }

  /**
   * One finger from `from` to `to`, in `steps` touchmoves — the multi-move shape a real drag has,
   * because "one message per gesture, not one per move" is only observable with more than one.
   */
  function drag(from: TouchPoint, to: TouchPoint, steps = 4): void {
    dispatchTouch('touchstart', [from])
    for (let step = 1; step <= steps; step++) {
      dispatchTouch('touchmove', [
        {
          clientX: from.clientX + ((to.clientX - from.clientX) * step) / steps,
          clientY: from.clientY + ((to.clientY - from.clientY) * step) / steps
        }
      ])
    }
    dispatchTouch('touchend', [])
    flushFrames()
  }

  /** A two-finger spread centred on the viewport, borrowed from the pinch-zoom fixture. */
  function pinch(fromSpan: number, toSpan: number): void {
    const cx = VIEWPORT_WIDTH / 2
    const cy = VIEWPORT_HEIGHT / 2
    const pair = (span: number): TouchPoint[] => [
      { clientX: cx - span / 2, clientY: cy },
      { clientX: cx + span / 2, clientY: cy }
    ]
    dispatchTouch('touchstart', pair(fromSpan))
    dispatchTouch('touchmove', pair(toSpan))
    dispatchTouch('touchend', [])
    flushFrames()
  }

  beforeEach(() => {
    animationFrames = []
    registeredDocumentListeners = []
    registeredWindowListeners = []
    terminals = []
    const addDocumentEventListener = document.addEventListener.bind(document)
    vi.spyOn(document, 'addEventListener').mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      registeredDocumentListeners.push({ type, listener, options })
      addDocumentEventListener(type, listener, options)
    }) as typeof document.addEventListener)
    const addWindowEventListener = window.addEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      registeredWindowListeners.push({ type, listener, options })
      addWindowEventListener(type, listener, options)
    }) as typeof window.addEventListener)
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      animationFrames.push(callback)
      return animationFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    Object.defineProperty(window, 'innerWidth', { value: VIEWPORT_WIDTH, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: VIEWPORT_HEIGHT, configurable: true })
    postMessage = vi.fn()
    const webWindow = window as unknown as {
      Terminal: new (options: TerminalOptions) => TerminalStub
      ReactNativeWebView: { postMessage: (data: string) => void }
    }
    webWindow.Terminal = function (options: TerminalOptions) {
      const terminal = makeTerminal(options)
      terminals.push(terminal)
      return terminal
    } as unknown as new (options: TerminalOptions) => TerminalStub
    webWindow.ReactNativeWebView = { postMessage }
  })

  afterEach(() => {
    for (const { type, listener, options } of registeredDocumentListeners) {
      document.removeEventListener(type, listener as EventListener, options)
    }
    for (const { type, listener, options } of registeredWindowListeners) {
      window.removeEventListener(type, listener as EventListener, options)
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('posts one message for a leftward drag, carrying the whole travel', () => {
    boot()
    drag({ clientX: 200, clientY: 300 }, { clientX: 40, clientY: 306 })
    // Sign is the routing: `paneSwipeDirection` reads negative as 'next', the pane to the right in
    // the strip. A dropped minus would switch the wrong way on every swipe and still look wired.
    expect(paneSwipes()).toEqual([{ type: 'pane-swipe', translationX: -160, translationY: 6 }])
  })

  it('posts one message for a rightward drag, with the opposite sign', () => {
    boot()
    drag({ clientX: 40, clientY: 300 }, { clientX: 200, clientY: 294 })
    expect(paneSwipes()).toEqual([{ type: 'pane-swipe', translationX: 160, translationY: -6 }])
  })

  it('reports the release position, not the position that latched the yield', () => {
    boot()
    // The latch fires on the first move past ±32; every later move has to keep updating, or a
    // 200px swipe arrives as the 40px one that tripped the threshold and never clears the
    // recognizer's 64px commit distance — a swipe that does nothing, with nothing to see.
    drag({ clientX: 300, clientY: 300 }, { clientX: 60, clientY: 300 }, 12)
    const [swipe] = paneSwipes()
    expect(swipe?.translationX).toBe(-240)
    expect(Math.abs(Number(swipe?.translationX))).toBeGreaterThan(PANE_SWIPE_ACTIVATE_OFFSET_X)
  })

  it('says nothing about a vertical drag — that axis is the terminal’s', () => {
    boot()
    drag({ clientX: 200, clientY: 500 }, { clientX: 204, clientY: 120 }, 8)
    // Scrollback, alt-screen scroll routed as input and selection edge-scroll all live here. A
    // pane switch stealing this would be a worse defect than no pane switch at all.
    expect(paneSwipes()).toEqual([])
  })

  it('says nothing about a short horizontal drag that never reached the window', () => {
    boot()
    drag(
      { clientX: 200, clientY: 300 },
      { clientX: 200 - (PANE_SWIPE_ACTIVATE_OFFSET_X - 4), clientY: 300 }
    )
    expect(paneSwipes()).toEqual([])
  })

  it('says nothing once the reader has zoomed in, where horizontal is their pan', () => {
    boot()
    pinch(100, 300)
    drag({ clientX: 300, clientY: 300 }, { clientX: 60, clientY: 300 })
    // `shouldYieldHorizontal` returns false above `userScale > 1`, so the page keeps the gesture
    // and pans the magnified grid with it. Reporting here would take panning away from a zoomed
    // pane entirely (`src/session/pane-swipe.ts`, `.prd/09` §KK).
    expect(paneSwipes()).toEqual([])
  })

  it('says nothing about a pinch, however sideways the fingers travel', () => {
    boot()
    pinch(100, 300)
    expect(paneSwipes()).toEqual([])
  })

  it('reports each of two consecutive swipes, so the latch is cleared at the end', () => {
    boot()
    drag({ clientX: 200, clientY: 300 }, { clientX: 40, clientY: 300 })
    drag({ clientX: 40, clientY: 300 }, { clientX: 200, clientY: 300 })
    expect(paneSwipes().map((msg) => msg.translationX)).toEqual([-160, 160])
  })

  it('leaves the server geometry alone — a swipe is a route, not a resize', () => {
    boot()
    drag({ clientX: 200, clientY: 300 }, { clientX: 40, clientY: 300 })
    expect(terminals.at(-1)?.cols).toBe(SERVER_COLS)
    expect(terminals.at(-1)?.rows).toBe(SERVER_ROWS)
  })
})
