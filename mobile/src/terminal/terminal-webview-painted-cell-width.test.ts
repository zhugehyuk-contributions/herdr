// Not from orca. The defect this pins is `.prd/09-review-followups.md` §P: on a 213-column pane the
// right-most 7~9 columns could not be brought on screen at any magnification, and were cut at fit
// too. `getContentWidth()` sized the grid from `cellWidth × cols`, and xterm's `cellWidth` is a
// *canvas* measurement — `CharSizeService`'s `TextMetricsMeasureStrategy` measures 'W' with
// `OffscreenCanvas.measureText` (node_modules/@xterm/xterm CharSizeService.ts, the
// `TextMetricsMeasureStrategy` branch), and the DOM renderer's correction for it is canvas-measured
// on *both* sides (`DomRenderer.ts:325`, `dimensions.css.cell.width - this._widthCache.get('W')`,
// and `WidthCache` measures on a canvas as well). So when the canvas and the layout engine resolve
// the same font-family list differently — the Android case, where none of "SF Mono"/"Menlo"/… exist
// and only the `monospace` fallback does — the deviation cancels out of the correction and survives
// into the paint: xterm sizes the grid box 1630 CSS wide while the rows paint ~1700.
//
// The vertical axis cannot drift this way, which is why the QA run found row height in agreement:
// `DomRenderer.ts:152-154` *writes* `height` and `line-height` onto every row element, so the DOM is
// forced to obey the number. Nothing writes a per-column advance; `letter-spacing` is the only lever
// and it is computed from the wrong measurement.
//
// The repair may not be a constant: the size of the deviation is a property of whichever font the
// device actually resolved. So the width is measured in the DOM — the same place the text is painted
// — and only ever *widens* the grid (`Math.max`), so a renderer whose metric is already honest
// (WebGL, which paints into a canvas sized from that very metric) is left exactly as it was.
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

type RegisteredListener = {
  listener: EventListenerOrEventListenerObject
  options?: boolean | AddEventListenerOptions
  type: string
}

// The pane, the phone and the two disagreeing numbers from the 2026-08-23 QA run.
const SERVER_COLS = 213
const SERVER_ROWS = 51
/** What `_renderService.dimensions.css.cell.width` reported: 1630 / 213. */
const METRIC_CELL_WIDTH = 1630 / SERVER_COLS
/** What the font actually advanced per column on screen. */
const PAINTED_CELL_WIDTH = 7.98
const CELL_HEIGHT = 15
const VIEWPORT_WIDTH = 381
const VIEWPORT_HEIGHT = 612

type TerminalOptions = { cols?: number; fontSize?: number; rows?: number }

function makeTerminal(options: TerminalOptions, paintsRowsInTheDom: boolean) {
  const terminal = {
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    options: { fontSize: options.fontSize ?? 13 },
    modes: { mouseTrackingMode: 'none' as string },
    element: null as HTMLElement | null,
    _core: {
      _renderService: {
        dimensions: { css: { cell: { width: METRIC_CELL_WIDTH, height: CELL_HEIGHT } } }
      }
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
    // The real `term.open()` builds `.xterm > .xterm-screen > .xterm-rows` when the DOM renderer is
    // live, and the WebGL addon disposes the DOM renderer — which removes that row container
    // (`DomRenderer.ts:119`). `paintsRowsInTheDom` is exactly that fork.
    open(surface: HTMLElement) {
      terminal.element = surface
      if (!paintsRowsInTheDom) {
        return
      }
      const rows = document.createElement('div')
      rows.className = 'xterm-rows'
      surface.append(rows)
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

type TerminalStub = ReturnType<typeof makeTerminal>

function terminalSurface(): HTMLElement {
  const surface = document.getElementById('terminal-surface')
  if (!surface) {
    throw new Error('terminal surface missing')
  }
  return surface
}

type TouchPoint = { clientX: number; clientY: number }

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

describe('terminal WebView content width follows the paint, not xterm cell metric', () => {
  let animationFrames: Array<() => void>
  let registeredDocumentListeners: RegisteredListener[]
  let registeredWindowListeners: RegisteredListener[]
  let terminals: TerminalStub[]
  /** happy-dom has no layout engine, so the test supplies the one number a browser would measure. */
  let paintedCellWidth: number
  let rowsInTheDom: boolean

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

  /** Zoom in as far as the magnifier goes, then drag right past the end of the grid. */
  function zoomInAndPanFullyRight(): void {
    const cx = VIEWPORT_WIDTH / 2
    const cy = VIEWPORT_HEIGHT / 2
    const pair = (span: number): TouchPoint[] => [
      { clientX: cx - span / 2, clientY: cy },
      { clientX: cx + span / 2, clientY: cy }
    ]
    dispatchTouch('touchstart', pair(100))
    dispatchTouch('touchmove', pair(300))
    dispatchTouch('touchend', [])
    flushFrames()
    for (let step = 0; step < 40; step++) {
      dispatchTouch('touchstart', [{ clientX: cx, clientY: cy }])
      dispatchTouch('touchmove', [{ clientX: cx - 300, clientY: cy }])
      dispatchTouch('touchend', [])
      flushFrames()
    }
  }

  beforeEach(() => {
    animationFrames = []
    registeredDocumentListeners = []
    registeredWindowListeners = []
    terminals = []
    paintedCellWidth = PAINTED_CELL_WIDTH
    rowsInTheDom = true
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
    const measureRect = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        if (!this.hasAttribute('data-herdr-cell-probe')) {
          return measureRect.call(this)
        }
        const run = this.textContent?.length ?? 0
        return { ...measureRect.call(this).toJSON(), width: run * paintedCellWidth } as DOMRect
      }
    )
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      animationFrames.push(callback)
      return animationFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    Object.defineProperty(window, 'innerWidth', { value: VIEWPORT_WIDTH, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: VIEWPORT_HEIGHT, configurable: true })
    const webWindow = window as unknown as {
      Terminal: new (options: TerminalOptions) => TerminalStub
      ReactNativeWebView: { postMessage: (data: string) => void }
    }
    webWindow.Terminal = function (options: TerminalOptions) {
      const terminal = makeTerminal(options, rowsInTheDom)
      terminals.push(terminal)
      return terminal
    } as unknown as new (options: TerminalOptions) => TerminalStub
    webWindow.ReactNativeWebView = { postMessage: vi.fn() }
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

  it('fits the width the font paints, not the narrower width xterm measured', () => {
    boot()
    // At fit the whole pane must be on screen. Against the 1630 metric it is not: the last
    // (1699.74 - 1630) / 7.98 ≈ 8.7 columns are already past the right edge of the phone.
    expect(transform().scale).toBeCloseTo(VIEWPORT_WIDTH / (PAINTED_CELL_WIDTH * SERVER_COLS), 5)
  })

  it('pans all the way to the last painted column', () => {
    boot()
    zoomInAndPanFullyRight()
    const scale = transform().scale
    expect(transform().x).toBeCloseTo(VIEWPORT_WIDTH - PAINTED_CELL_WIDTH * SERVER_COLS * scale, 3)
  })

  it('leaves the metric untouched when the paint agrees with it', () => {
    // xterm's `letter-spacing` correction working as designed: the probe inherits it and reports
    // exactly the cell width. Nothing to widen, so the fit is bit-for-bit the old one.
    paintedCellWidth = METRIC_CELL_WIDTH
    boot()
    expect(transform().scale).toBeCloseTo(VIEWPORT_WIDTH / (METRIC_CELL_WIDTH * SERVER_COLS), 5)
  })

  it('never narrows the grid below the cell metric when the probe reads short', () => {
    paintedCellWidth = METRIC_CELL_WIDTH / 2
    boot()
    expect(transform().scale).toBeCloseTo(VIEWPORT_WIDTH / (METRIC_CELL_WIDTH * SERVER_COLS), 5)
  })

  it('ignores the paint probe when no DOM rows exist — the WebGL canvas owns the metric', () => {
    // WebGL draws the glyphs into a canvas it sizes from `css.cell.width` itself, so that metric is
    // the paint by construction; there is nothing to correct and no `.xterm-rows` to measure.
    rowsInTheDom = false
    boot()
    expect(transform().scale).toBeCloseTo(VIEWPORT_WIDTH / (METRIC_CELL_WIDTH * SERVER_COLS), 5)
  })
})
