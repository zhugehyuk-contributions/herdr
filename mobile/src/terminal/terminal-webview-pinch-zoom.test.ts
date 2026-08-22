// Not from orca — orca cannot have this test, because orca resizes the desktop PTY to the phone
// (`mobile/.prd/08-orca-port-map.md` §4 N5) and so its pinch is *allowed* to re-grid the client.
// herdr's observe path resizes nothing (`.prd/02-architecture.md` §2.3, `./observer-geometry.ts`):
// the server keeps rendering the pane's own grid — 213x51 in the 2026-08-23 M2 QA — and the phone
// only chooses how much of it to look at. So the grid is the server's and a gesture may not touch
// it; a pinch is a pure visual zoom plus pan, which is exactly what M2 acceptance (e) asks for
// ("폰보다 넓은 pane에서 커서와 최신 출력에 도달 — 수동 이동(핀치줌·가로스크롤) 후", 04-milestones.md).
//
// The bug this pins: pinch-end used to call `term.resize(floor(innerWidth / cellW), …)`, which cut
// a 213-column grid to ~38 while the server went on sending 213-column frames. Every later frame
// then landed on the wrong grid and the pane stayed shredded until it was remounted — zooming back
// out did not repair it, because nothing on the phone ever restores the server's column count.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { XTERM_HTML } from './terminal-webview-html'

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

// The pane measured by the 2026-08-23 QA run, and the phone it was read on.
const SERVER_COLS = 213
const SERVER_ROWS = 51
const CELL_WIDTH = 8
const CELL_HEIGHT = 15
const VIEWPORT_WIDTH = 381
const VIEWPORT_HEIGHT = 612
/** What `computeFitScale()` must land on: the whole 213-column grid squeezed into the phone. */
const FIT_SCALE = VIEWPORT_WIDTH / (CELL_WIDTH * SERVER_COLS)

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
// `touches[].clientX/Y` — the same duck typing the mouse tests do for `pointerType`.
function dispatchTouch(type: 'touchstart' | 'touchmove' | 'touchend', touches: TouchPoint[]): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', { value: touches })
  terminalSurface().dispatchEvent(event)
}

function transform(): { scale: number; x: number; y: number } {
  const raw = terminalSurface().style.transform
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(raw)
  if (!match) {
    throw new Error(`unparsable transform: ${raw}`)
  }
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) }
}

describe('terminal WebView pinch zoom over a server-owned grid', () => {
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

  function activeTerminal(): TerminalStub {
    const terminal = terminals.at(-1)
    if (!terminal) {
      throw new Error('terminal missing')
    }
    return terminal
  }

  /** A two-finger spread centred on the viewport, from `fromSpan` px apart to `toSpan` px apart. */
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

  /** One finger dragged horizontally by `dx`, the gesture M2 (e) calls 가로스크롤. */
  function dragHorizontally(dx: number): void {
    const startX = VIEWPORT_WIDTH / 2
    const y = VIEWPORT_HEIGHT / 2
    dispatchTouch('touchstart', [{ clientX: startX, clientY: y }])
    dispatchTouch('touchmove', [{ clientX: startX + dx, clientY: y }])
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

  it('opens a 213-column pane at fit, whole width on screen, nothing panned away', () => {
    boot()
    expect(activeTerminal().cols).toBe(SERVER_COLS)
    expect(transform().scale).toBeCloseTo(FIT_SCALE, 5)
    expect(transform()).toMatchObject({ x: 0, y: 0 })
  })

  it('leaves the grid at the server geometry after a pinch — the whole defect', () => {
    boot()
    pinch(100, 300)
    // If this ever reads ~38 again, every subsequent 213-column frame is being written into a
    // narrower grid and the pane is shredded until it is remounted (2026-08-23 QA shot-15/16).
    expect(activeTerminal().cols).toBe(SERVER_COLS)
    expect(activeTerminal().rows).toBe(SERVER_ROWS)
  })

  it('keeps the magnification a pinch asked for instead of snapping back to fit', () => {
    boot()
    pinch(100, 300)
    expect(transform().scale).toBeGreaterThan(FIT_SCALE * 2)
  })

  it('holds the zoom while the server keeps streaming frames', () => {
    boot()
    pinch(100, 300)
    const zoomed = transform().scale
    for (let frame = 0; frame < 3; frame++) {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'write', data: `frame ${frame}\r\n` })
        })
      )
      flushFrames()
    }
    expect(transform().scale).toBeCloseTo(zoomed, 5)
    expect(activeTerminal().cols).toBe(SERVER_COLS)
  })

  it('will not zoom out past fit, where the whole pane is already on screen', () => {
    boot()
    pinch(300, 60)
    expect(transform().scale).toBeCloseTo(FIT_SCALE, 5)
    expect(transform().x).toBe(0)
  })

  it('pans horizontally once zoomed, and refuses to pan at fit', () => {
    boot()
    dragHorizontally(-120)
    // At fit the grid exactly covers the viewport: there is nothing off-screen to pan to.
    expect(transform().x).toBe(0)

    pinch(100, 300)
    const zoomed = transform().scale
    dragHorizontally(-120)
    const panned = transform()
    expect(panned.x).toBeLessThan(0)
    expect(panned.scale).toBeCloseTo(zoomed, 5)
    expect(activeTerminal().cols).toBe(SERVER_COLS)
  })

  it('reaches the far right of the grid — the column the cursor sits in', () => {
    boot()
    pinch(100, 300)
    const scale = transform().scale
    // Drag left far past the content width; clamping must stop exactly at the right edge.
    for (let step = 0; step < 40; step++) {
      dragHorizontally(-300)
    }
    const rightEdge = VIEWPORT_WIDTH - CELL_WIDTH * SERVER_COLS * scale
    expect(transform().x).toBeCloseTo(rightEdge, 3)
  })

  it('does not re-grid on a text-size change either', () => {
    boot()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'set-font-scale', fontScale: 2 })
      })
    )
    flushFrames()
    expect(activeTerminal().cols).toBe(SERVER_COLS)
    expect(activeTerminal().rows).toBe(SERVER_ROWS)
  })

  it('drops the zoom when the server hands over a different grid', () => {
    boot()
    pinch(100, 300)
    expect(transform().scale).toBeGreaterThan(FIT_SCALE)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'resize', cols: 80, rows: 24 })
      })
    )
    flushFrames()
    expect(activeTerminal().cols).toBe(80)
    expect(transform()).toMatchObject({ x: 0, y: 0 })
    expect(transform().scale).toBeCloseTo(VIEWPORT_WIDTH / (CELL_WIDTH * 80), 5)
  })
})
