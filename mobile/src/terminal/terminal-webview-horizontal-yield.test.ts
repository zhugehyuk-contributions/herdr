// Not from orca. .prd/09-review-followups.md §HH: on iOS the pane-swipe recognizer produced no
// switch while the *same* synthetic drag scrolled an RN ScrollView 425pt away on the same screen.
// The page was declaring it had consumed every touchmove — `e.preventDefault()` unconditionally —
// while the branch that would actually use a horizontal drag is guarded by "content wider than the
// viewport", i.e. does nothing on any unzoomed pane.
//
// What this file guards is the part that can rot silently: the yield rule is written in the page's
// JavaScript as *text*, so nothing typechecks it and no runtime in this repo executes it. Two
// things can therefore drift apart without anyone noticing — the thresholds the recognizer uses
// (`src/session/pane-swipe.ts`) and the thresholds the page yields at. If they disagree there is a
// band of gestures the page keeps and the recognizer wants, which is exactly the bug §HH describes,
// wearing different numbers.
import { describe, expect, it } from 'vitest'
import { XTERM_HTML } from './terminal-webview-html'
import { PANE_SWIPE_ACTIVATE_OFFSET_X, PANE_SWIPE_AXIS_RATIO } from '../session/pane-swipe'

/** The two numbers the page compiled in, read back out of the document it will actually serve. */
function yieldThresholds(): { offsetX: number; ratio: number } {
  const match = XTERM_HTML.match(
    /var YIELD_OFFSET_X = ([0-9.]+);[\s\S]{0,400}?var YIELD_AXIS_RATIO = ([0-9.]+);/
  )
  if (!match?.[1] || !match[2]) {
    throw new Error('the yield thresholds are not in the served document')
  }
  return { offsetX: Number(match[1]), ratio: Number(match[2]) }
}

describe('the terminal document yields the gesture the recognizer wants', () => {
  it('compiles the recognizer’s own thresholds in, not a second copy', () => {
    // The interpolation landing at all is half the assertion: a `${…}` that fell outside the
    // template would ship the literal text and the page would compare against `NaN`, which is
    // false for every gesture — the yield would simply never happen and §HH would be back.
    expect(yieldThresholds()).toEqual({
      offsetX: PANE_SWIPE_ACTIVATE_OFFSET_X,
      ratio: PANE_SWIPE_AXIS_RATIO
    })
  })

  it('leaves no unresolved interpolation in the yield block', () => {
    expect(XTERM_HTML).not.toMatch(/YIELD_(OFFSET_X|AXIS_RATIO) = \$\{/)
  })

  it('checks the latch before the overflow test, so a curving drag is not re-claimed', () => {
    // Order is behaviour here: `ts.yieldedH` has to short-circuit, or a gesture that started
    // horizontal and curves back under the ratio would be taken back mid-flight and the page would
    // start scrolling under a finger the recognizer already owns.
    const fn = XTERM_HTML.slice(
      XTERM_HTML.indexOf('function shouldYieldHorizontal'),
      XTERM_HTML.indexOf("targetSurface.addEventListener('touchmove'")
    )
    expect(fn).toContain('if (ts.yieldedH) return true;')
    expect(fn.indexOf('ts.yieldedH')).toBeLessThan(fn.indexOf('getContentWidth()'))
  })

  it('still lets the page keep horizontal when the grid overflows', () => {
    // The one occupant of the horizontal axis that is real (`src/session/pane-swipe.ts` header):
    // a zoomed-in pane pans. Yielding there would take panning away from the user entirely.
    const fn = XTERM_HTML.slice(
      XTERM_HTML.indexOf('function shouldYieldHorizontal'),
      XTERM_HTML.indexOf("targetSurface.addEventListener('touchmove'")
    )
    expect(fn).toContain('getContentWidth() * getTotalScale() > window.innerWidth + 1')
    expect(fn).toContain('return false;')
  })

  it('only yields single-finger gestures, never a pinch', () => {
    // The end marker is searched *from* the listener, not from the top of the document: two
    // earlier handlers call `stopPropagation` (the mousedown/click suppressors), so a bare
    // `indexOf` returns a position before the start and slices an empty string — which then
    // "passes" every `not.toContain` and fails every `toContain` for the wrong reason.
    const start = XTERM_HTML.indexOf("targetSurface.addEventListener('touchmove'")
    const guard = XTERM_HTML.slice(start, XTERM_HTML.indexOf('e.stopPropagation();', start))
    expect(guard).toContain('e.touches.length === 1 && !ts.isPinching && shouldYieldHorizontal')
  })
})

// §HH's extraction moved *live* handlers out of `terminal-webview-html.ts` (to stay inside its
// max-lines budget), and a text move into a template string has one silent failure mode: the block
// lands twice, or lands out of order, and the document still parses. Both are invisible to every
// other test here, which reads the pieces rather than their arrangement.
describe('the served document survived the extraction intact', () => {
  const occurrences = (needle: string): number => XTERM_HTML.split(needle).length - 1
  const at = (needle: string): number => XTERM_HTML.indexOf(needle)

  it('attaches each surface touch handler exactly once', () => {
    // Three `touchstart` listeners exist in the document and only two are on the surface: the
    // third is the document-level dispatcher. Of the surface pair, one is the mouse/click-drag
    // module's (`./terminal-webview-mouse-click-drag-injected.ts:197`) and one is the touch-pan
    // module's — they were two before the extraction and are two after it.
    expect(occurrences("targetSurface.addEventListener('touchstart'")).toBe(2)
    expect(occurrences("targetSurface.addEventListener('touchmove'")).toBe(1)
    expect(occurrences("targetSurface.addEventListener('touchend'")).toBe(1)
    expect(occurrences('function shouldYieldHorizontal')).toBe(1)
  })

  it('defines the yield rule before the handler that calls it', () => {
    // Order is not cosmetic across an injection boundary: the rule and its caller now live in
    // different modules, and a swapped interpolation would throw a ReferenceError on the first
    // finger rather than at build time.
    expect(at('function shouldYieldHorizontal')).toBeLessThan(
      at("targetSurface.addEventListener('touchmove'")
    )
    expect(at("targetSurface.addEventListener('touchmove'")).toBeLessThan(
      at("targetSurface.addEventListener('touchend'")
    )
  })
})

// §JJ's discriminator is an instrument whose *absence* is a reading: if the document posts no
// `touch-probe`, the QA run concludes "the page never saw the touches either" and iOS M6a moves to
// a real-device gate. A probe that silently stopped being emitted produces exactly that reading
// while being a wiring bug — the one failure mode that would send the investigation the wrong way.
describe('the touch probe stays wired', () => {
  const at = (needle: string): number => XTERM_HTML.indexOf(needle)

  it('reports the start, the first move and the totals', () => {
    expect(XTERM_HTML).toContain("type: 'touch-probe', phase: 'start'")
    expect(XTERM_HTML).toContain("type: 'touch-probe', phase: 'first-move'")
    expect(XTERM_HTML).toContain("type: 'touch-probe', phase: 'end'")
  })

  it('counts the move before any early return can swallow it', () => {
    // The whole question is "did a touchmove reach this document at all". A guard that returns
    // first — the dispatcher block, or the horizontal yield — would answer it with a silence
    // indistinguishable from never being called.
    const handler = XTERM_HTML.slice(
      at("targetSurface.addEventListener('touchmove'"),
      at("targetSurface.addEventListener('touchend'")
    )
    const counted = handler.indexOf('ts.moveCount = (ts.moveCount || 0) + 1;')
    expect(counted).toBeGreaterThan(-1)
    expect(counted).toBeLessThan(handler.indexOf('dispatcherShouldBlockSurface()'))
    expect(counted).toBeLessThan(handler.indexOf('shouldYieldHorizontal'))
  })
})
