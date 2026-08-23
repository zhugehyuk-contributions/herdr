// Ported from orca mobile/src/terminal/terminal-webview-init-surface.test.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
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
type TerminalOptions = {
  cursorInactiveStyle?: string
  cursorStyle?: string
  showCursorImmediately?: boolean
}
type RegisteredWindowListener = {
  listener: EventListenerOrEventListenerObject
  options?: boolean | AddEventListenerOptions
  type: string
}

function makeTerminal(writeCallbacks: Array<() => void>, writes: string[]) {
  const terminal = {
    cols: 80,
    rows: 24,
    options: { fontSize: 13 },
    modes: {},
    element: null as HTMLElement | null,
    disposed: false,
    _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 15 } } } } },
    buffer: {
      active: {
        viewportY: 0,
        baseY: 0,
        length: 1,
        cursorY: 0,
        type: 'normal' as const,
        getLine: () => null
      }
    },
    write(data: string, callback?: () => void) {
      writes.push(data)
      if (callback) {
        writeCallbacks.push(callback)
      }
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
    getSelection: () => '',
    onData: () => ({ dispose() {} }),
    onLineFeed: () => ({ dispose() {} }),
    onScroll: () => ({ dispose() {} }),
    onWriteParsed: () => ({ dispose() {} }),
    dispose() {
      terminal.disposed = true
    }
  }
  return terminal
}

function dispatchInit(cols: number, initialData: string): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ type: 'init', cols, rows: 40, initialData })
    })
  )
}

describe('terminal WebView init surface replacement', () => {
  let animationFrames: Array<() => void>
  let registeredWindowListeners: RegisteredWindowListener[]
  let terminalOptions: TerminalOptions[]
  let terminals: TerminalStub[]
  let writeCallbacks: Array<() => void>
  let writes: string[]

  beforeEach(() => {
    animationFrames = []
    registeredWindowListeners = []
    terminalOptions = []
    terminals = []
    writeCallbacks = []
    writes = []
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
    Object.defineProperty(window, 'innerWidth', { value: 381, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 612, configurable: true })
    const webWindow = window as unknown as {
      Terminal: new (options: TerminalOptions) => TerminalStub
      ReactNativeWebView: { postMessage: (data: string) => void }
    }
    webWindow.Terminal = function (options: TerminalOptions) {
      terminalOptions.push(options)
      const terminal = makeTerminal(writeCallbacks, writes)
      terminals.push(terminal)
      return terminal
    } as unknown as new (options: TerminalOptions) => TerminalStub
    webWindow.ReactNativeWebView = { postMessage: vi.fn() }
    document.body.innerHTML = bodyMarkup()
    // eslint-disable-next-line no-new-func
    new Function(iifeSource())()
  })

  afterEach(() => {
    for (const { type, listener, options } of registeredWindowListeners) {
      window.removeEventListener(type, listener as EventListener, options)
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Drives one init all the way to `commitFitScale('init-replay')`. */
  function settleInit(): void {
    animationFrames.shift()?.()
    writeCallbacks.shift()?.()
    animationFrames.shift()?.()
  }

  function rendererLogs(): Record<string, unknown>[] {
    const post = (window as unknown as { ReactNativeWebView: { postMessage: Mock } })
      .ReactNativeWebView.postMessage
    return post.mock.calls
      .map(([data]) => JSON.parse(String(data)) as Record<string, unknown>)
      .filter((msg) => msg.type === 'log' && msg.tag === '[fit]renderer')
      .map((msg) => msg.payload as Record<string, unknown>)
  }

  // `.prd/09-review-followups.md` \u00a7P hung for two rounds on a single unmeasured value —
  // `document.querySelector('.xterm-rows') !== null` — because nothing in the document ever said
  // which renderer had painted it, and \u00a7U then diagnosed "iOS draws nothing" from a
  // dominant-colour scan that cannot separate a blank canvas from a grid drawn at scale 0.21.
  // These two pin the report that answers both without a device.
  it('reports the WebGL renderer, and that it left no DOM rows to measure', () => {
    vi.stubGlobal('WebglAddon', {
      WebglAddon: class {
        dispose() {}
      }
    })

    dispatchInit(80, 'payload')
    settleInit()

    expect(rendererLogs()).toHaveLength(1)
    expect(rendererLogs()[0]).toMatchObject({
      renderer: 'webgl',
      domRows: false,
      // The painted-cell probe (`terminal-webview-painted-cell-injected.ts`) is inert on this
      // path by construction, so the grid width is xterm's own `css.cell.width` x cols — which is
      // why contentW is read against xtermCols and not against the server's grid.
      paintedCellW: 0,
      cellW: 8,
      contentW: 640,
      xtermCols: 80,
      cols: 80,
      rows: 40
    })
  })

  it('reports the DOM renderer when no WebGL addon is present', () => {
    dispatchInit(80, 'payload')
    const rows = document.createElement('div')
    rows.className = 'xterm-rows'
    document.getElementById('terminal-surface')?.appendChild(rows)
    settleInit()

    expect(rendererLogs()).toHaveLength(1)
    expect(rendererLogs()[0]).toMatchObject({ renderer: 'dom', domRows: true, cols: 80, rows: 40 })
  })

  // \u00a7AA: the first version of this report read `term.cols`, i.e. `cols || 80` — xterm's own
  // default — and printed "80" for a pane `tput cols` measured at 53. The two grids are separate
  // fields now, and the stub terminal ignores the constructor's dimensions on purpose: it stays at
  // xterm's 80x24 whatever init asks for, so a report that reads xterm cannot pass this.
  it("reports the server grid init delivered, not xterm's own", () => {
    dispatchInit(120, 'payload')
    settleInit()

    expect(rendererLogs()).toHaveLength(1)
    expect(rendererLogs()[0]).toMatchObject({
      cols: 120,
      rows: 40,
      xtermCols: 80,
      xtermRows: 24
    })
  })

  // And the case the defaulting hid entirely: init without geometry. `cols: 0` says "the server
  // told us nothing and xterm is painting its own 80x24", which is a different diagnosis from a
  // server that really asked for 80 columns.
  it('reports a zero server grid when init carried none', () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'init', initialData: 'payload' })
      })
    )
    settleInit()

    expect(rendererLogs()).toHaveLength(1)
    expect(rendererLogs()[0]).toMatchObject({
      cols: 0,
      rows: 0,
      xtermCols: 80,
      xtermRows: 24
    })
  })

  it("keeps xterm's inactive cursor visible across replacement surfaces", () => {
    dispatchInit(120, 'desktop')
    dispatchInit(51, 'phone-resize')
    dispatchInit(51, 'phone-scrollback')

    expect(terminalOptions).toHaveLength(3)
    for (const options of terminalOptions) {
      expect(options).toMatchObject({
        cursorStyle: 'bar',
        cursorInactiveStyle: 'block',
        showCursorImmediately: true
      })
    }
  })

  it('grounds the initial replay without clearing the host live pen', () => {
    dispatchInit(80, '\x1b[1mBOLD-RUN-LEFT-OPEN')
    animationFrames.shift()?.()

    expect(writes).toEqual(['\x1b[0m\x1b[1mBOLD-RUN-LEFT-OPEN'])
  })

  it('commits only the newest surface when phone-fit init calls overlap', () => {
    // Why: restored terminals can receive desktop scrollback, a phone resize,
    // and phone scrollback before any xterm replay callback has completed.
    dispatchInit(120, 'desktop')
    animationFrames.shift()?.()
    dispatchInit(51, 'phone-resize')
    animationFrames.shift()?.()
    dispatchInit(51, 'phone-scrollback')
    animationFrames.shift()?.()

    expect(terminals).toHaveLength(3)
    expect(writeCallbacks).toHaveLength(3)
    writeCallbacks[2]?.()
    writeCallbacks[0]?.()
    writeCallbacks[1]?.()

    const surfaces = document.querySelectorAll('#terminal-container > div')
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]?.id).toBe('terminal-surface')
    expect((surfaces[0] as HTMLElement).style.visibility).toBe('visible')
    expect(terminals.map((terminal) => terminal.disposed)).toEqual([true, true, false])
  })
})
