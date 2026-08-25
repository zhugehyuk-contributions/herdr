// Not from orca. Guards the two halves of `./terminal-webview-font-injected.ts` that a screenshot
// caught and no test did: the document carries the face at all, and it does not let xterm measure
// before that face has loaded. The 12차 iOS QA round could only see the first half (a zoomed `0`
// with no centre dot); the second half is invisible on a screenshot and is the one that decides
// whether the whole fit/scale chain is arithmetic on JetBrains Mono's advance or on a fallback's.
// @vitest-environment happy-dom
import { runInThisContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  TERMINAL_FONT_FACE_CSS,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_WEIGHT,
  TERMINAL_FONT_WEIGHT_BOLD
} from './terminal-webview-font-injected'
import { XTERM_HTML } from './terminal-webview-html'

type FontFace = { range: [number, number]; source: string }

/** `@font-face` blocks are safe to split on braces: a base64 payload cannot contain one. */
function embeddedFaces(): FontFace[] {
  return [...TERMINAL_FONT_FACE_CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => {
    const range = /font-weight:\s*(\d+)\s+(\d+);/.exec(body)
    const source = /src:\s*url\('([^']+)'\)\s*format\('truetype'\);/.exec(body)
    expect(body, 'every face declares the embedded family').toContain(
      `font-family: '${TERMINAL_FONT_FAMILY}';`
    )
    expect(range, 'every face declares a weight range').not.toBeNull()
    expect(source, 'every face is an inline truetype payload').not.toBeNull()
    return {
      range: [Number(range?.[1]), Number(range?.[2])],
      source: String(source?.[1])
    }
  })
}

function faceFor(weight: string): FontFace {
  const faces = embeddedFaces().filter(
    ({ range }) => Number(weight) >= range[0] && Number(weight) <= range[1]
  )
  expect(faces, `exactly one embedded face answers weight ${weight}`).toHaveLength(1)
  return faces[0] as FontFace
}

describe('terminal WebView embedded typeface', () => {
  it('embeds two truetype faces inline, with no URL to fetch', () => {
    const faces = embeddedFaces()
    expect(faces).toHaveLength(2)
    for (const { source } of faces) {
      expect(source.startsWith('data:font/ttf;base64,')).toBe(true)
      // A real TTF, not a placeholder: the smallest face in the family is ~110 KB.
      expect(source.length).toBeGreaterThan(100_000)
    }
    // The document has no origin and no network; `terminal-webview-engine.test.ts` bans http(s)
    // across the whole document, and this restates it for the payload that made the file huge.
    expect(TERMINAL_FONT_FACE_CSS).not.toMatch(/\bhttps?:\/\//)
    expect(XTERM_HTML).toContain(TERMINAL_FONT_FACE_CSS)
  })

  it('gives xterm regular and bold as two different faces, not one weight twice', () => {
    const regular = faceFor(TERMINAL_FONT_WEIGHT)
    const bold = faceFor(TERMINAL_FONT_WEIGHT_BOLD)
    // The defect this pins: with plain `font-weight: 400` / `700` faces, CSS matching hands a
    // desired 500 to the 400 face (it searches downward before upward inside [400,500]), so bold
    // silently becomes regular and every TUI that emphasises with bold loses the distinction.
    expect(bold.source).not.toBe(regular.source)
    expect(regular.range[1]).toBeLessThan(bold.range[0])
  })

  it('covers the whole CSS weight axis, so no weight can escape to the fallback stack', () => {
    const faces = embeddedFaces().sort((a, b) => a.range[0] - b.range[0])
    expect(faces[0]?.range[0]).toBe(100)
    expect(faces.at(-1)?.range[1]).toBe(900)
    expect(faces[1]?.range[0]).toBe((faces[0]?.range[1] ?? 0) + 100)
  })
})

type Deferred = { promise: Promise<void>; reject: () => void; resolve: () => void }

function deferred(): Deferred {
  let resolve = () => {}
  let reject = () => {}
  const promise = new Promise<void>((resolveFn, rejectFn) => {
    resolve = () => resolveFn()
    reject = () => rejectFn(new Error('face failed to decode'))
  })
  return { promise, reject, resolve }
}

function iifeSource(): string {
  const start = XTERM_HTML.indexOf('(function() {')
  const end = XTERM_HTML.lastIndexOf('})();')
  return XTERM_HTML.slice(start, end + '})();'.length)
}

function bodyMarkup(): string {
  const start = XTERM_HTML.indexOf('<body>') + '<body>'.length
  return XTERM_HTML.slice(start, XTERM_HTML.indexOf('<script>', start))
}

describe('terminal WebView font readiness gate', () => {
  let loads: Deferred[]
  let loadSpecs: string[]
  let postMessage: Mock<(data: string) => void>

  /**
   * Boots the terminal document exactly as the WebView does, optionally with a CSS Font Loading API
   * under this test's control. `fontsSupported: false` is the case every *other* WebView test runs
   * in — happy-dom implements no `document.fonts` — and is why adding this gate left them all
   * synchronous.
   */
  function boot(fontsSupported: boolean): void {
    document.body.innerHTML = bodyMarkup()
    if (fontsSupported) {
      Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: {
          load: (spec: string) => {
            loadSpecs.push(spec)
            const pending = deferred()
            loads.push(pending)
            return pending.promise
          }
        }
      })
    }
    const webWindow = window as unknown as {
      ReactNativeWebView: { postMessage: (data: string) => void }
      Terminal: unknown
    }
    webWindow.Terminal = function () {}
    webWindow.ReactNativeWebView = { postMessage }
    runInThisContext(iifeSource())
  }

  function announced(): string[] {
    return postMessage.mock.calls.map(([raw]) => String(JSON.parse(String(raw)).type))
  }

  async function settleMicrotasks(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  beforeEach(() => {
    loads = []
    loadSpecs = []
    postMessage = vi.fn<(data: string) => void>()
  })

  afterEach(() => {
    Reflect.deleteProperty(document, 'fonts')
    vi.useRealTimers()
  })

  it('asks for exactly the two weights xterm will render with', () => {
    boot(true)
    expect(loadSpecs).toEqual([
      `${TERMINAL_FONT_WEIGHT} 13px "${TERMINAL_FONT_FAMILY}"`,
      `${TERMINAL_FONT_WEIGHT_BOLD} 13px "${TERMINAL_FONT_FAMILY}"`
    ])
  })

  it('withholds web-ready until every face has loaded', async () => {
    boot(true)
    // web-ready is the edge that releases init (TerminalWebView.tsx:60-74), and init is where the
    // cell box is measured. Announcing it here would freeze the grid on fallback metrics.
    expect(announced()).not.toContain('web-ready')
    loads[0]?.resolve()
    await settleMicrotasks()
    expect(announced(), 'one face is not the font').not.toContain('web-ready')
    loads[1]?.resolve()
    await settleMicrotasks()
    expect(announced()).toContain('web-ready')
  })

  it('announces once the faces are in, and only once', async () => {
    boot(true)
    for (const pending of loads) {
      pending.resolve()
    }
    await settleMicrotasks()
    expect(announced().filter((type) => type === 'web-ready')).toHaveLength(1)
  })

  it('still opens the terminal when a face fails to decode', async () => {
    boot(true)
    loads[0]?.reject()
    loads[1]?.resolve()
    await settleMicrotasks()
    // A face that failed will not succeed later, and the fallback behind it is still monospace.
    // Wrong metrics beat a pane that never appears.
    expect(announced()).toContain('web-ready')
  })

  it('gives up on a load that never settles rather than hanging the pane', async () => {
    vi.useFakeTimers()
    boot(true)
    expect(announced()).not.toContain('web-ready')
    vi.advanceTimersByTime(2999)
    await settleMicrotasks()
    expect(announced()).not.toContain('web-ready')
    vi.advanceTimersByTime(1)
    await settleMicrotasks()
    expect(announced()).toContain('web-ready')
  })

  it('does not wait at all where there is no font loading API', () => {
    boot(false)
    // Synchronous, in the same turn as the IIFE: an engine without the API cannot report progress,
    // and the @font-face rules still resolve the classic way on first paint.
    expect(announced()).toContain('web-ready')
  })
})
