// The rule half of M6a, pinned as arithmetic: which pane a swipe lands on, and — more often — that
// it lands on none. The wiring half (that the screen asks the recognizer for these thresholds and
// routes rather than retargets) is `src/app-shell/pane-swipe-mount.test.tsx`.
//
// Chips are built here through the real `buildPaneChips` rather than hand-written, because the
// claim under test is that **the strip's order is the swipe's order** — a fixture of my own making
// could hold while the two UIs drifted apart.
import { describe, expect, it } from 'vitest'
import { buildPaneChips } from './pane-chips'
import {
  PANE_SWIPE_ACTIVATE_OFFSET_X,
  PANE_SWIPE_AXIS_RATIO,
  PANE_SWIPE_COMMIT_DISTANCE_X,
  PANE_SWIPE_FAIL_OFFSET_Y,
  paneSwipeDirection,
  resolvePaneSwipeTarget
} from './pane-swipe'
import type { AgentInfo, PaneInfo } from '../api/herdr-api-types'

function pane(id: string, tab: string): PaneInfo {
  return {
    pane_id: id,
    terminal_id: `term-${id}`,
    workspace_id: 'ws-1',
    tab_id: tab,
    focused: false,
    agent_status: 'idle',
    revision: 0
  }
}

/** Three panes over two tabs — the shape `pane-chips.test.ts` and the mock snapshot both use. */
const CHIPS = buildPaneChips(
  [pane('p1', 'tab-1'), pane('p2', 'tab-1'), pane('p3', 'tab-2')],
  [] as AgentInfo[]
)
const [FIRST, MIDDLE, LAST] = CHIPS

const LEFT = { translationX: -120, translationY: 0 }
const RIGHT = { translationX: 120, translationY: 0 }

describe('paneSwipeDirection', () => {
  it('reads a leftward finger as the next chip and a rightward one as the previous', () => {
    expect(paneSwipeDirection(LEFT)).toBe('next')
    expect(paneSwipeDirection(RIGHT)).toBe('previous')
  })

  it('ignores anything short of the commit distance', () => {
    expect(
      paneSwipeDirection({ translationX: -(PANE_SWIPE_COMMIT_DISTANCE_X - 1), translationY: 0 })
    ).toBeNull()
    expect(
      paneSwipeDirection({ translationX: -PANE_SWIPE_COMMIT_DISTANCE_X, translationY: 0 })
    ).toBe('next')
    // A tap that jittered sideways is far below the floor, which is the point of the floor sitting
    // above the WebView's own 24px tap slop.
    expect(paneSwipeDirection({ translationX: 3, translationY: 2 })).toBeNull()
  })

  it('leaves a vertical drag to the terminal, however far it travels', () => {
    // Scrollback: a long flick up, with the sideways wobble a thumb always adds.
    expect(paneSwipeDirection({ translationX: -30, translationY: -400 })).toBeNull()
    expect(paneSwipeDirection({ translationX: 30, translationY: 400 })).toBeNull()
    // And a diagonal that clears the horizontal floor but is still mostly vertical: the native
    // `failOffsetY` should already have killed it, and this is the JS half of the same rule.
    expect(paneSwipeDirection({ translationX: -100, translationY: -90 })).toBeNull()
    expect(
      paneSwipeDirection({
        translationX: -PANE_SWIPE_COMMIT_DISTANCE_X * PANE_SWIPE_AXIS_RATIO,
        translationY: -PANE_SWIPE_COMMIT_DISTANCE_X
      })
    ).toBe('next')
  })

  it('keeps the two thresholds ordered — activation below commit, vertical below both', () => {
    // A swipe that could commit before the recognizer even woke up would be unreachable, and a
    // vertical tolerance above the horizontal one would hand the terminal's axis to this gesture.
    expect(PANE_SWIPE_ACTIVATE_OFFSET_X).toBeLessThan(PANE_SWIPE_COMMIT_DISTANCE_X)
    expect(PANE_SWIPE_FAIL_OFFSET_Y).toBeLessThan(PANE_SWIPE_ACTIVATE_OFFSET_X)
  })
})

describe('resolvePaneSwipeTarget', () => {
  it('moves along the strip, in the strip’s own order', () => {
    expect(resolvePaneSwipeTarget(CHIPS, FIRST!.id, LEFT)).toBe(MIDDLE!.paneId)
    expect(resolvePaneSwipeTarget(CHIPS, MIDDLE!.id, LEFT)).toBe(LAST!.paneId)
    expect(resolvePaneSwipeTarget(CHIPS, MIDDLE!.id, RIGHT)).toBe(FIRST!.paneId)
    expect(resolvePaneSwipeTarget(CHIPS, LAST!.id, RIGHT)).toBe(MIDDLE!.paneId)
  })

  it('crosses a tab boundary, because the strip does', () => {
    // `p2` is the last pane of tab-1 and `p3` the first of tab-2: the viewer flattens tabs, so a
    // swipe must too or the last pane of a tab becomes a dead end.
    expect(MIDDLE!.tabId).not.toBe(LAST!.tabId)
    expect(resolvePaneSwipeTarget(CHIPS, MIDDLE!.id, LEFT)).toBe(LAST!.paneId)
  })

  it('does nothing at either end — no wrap-around', () => {
    expect(resolvePaneSwipeTarget(CHIPS, FIRST!.id, RIGHT)).toBeNull()
    expect(resolvePaneSwipeTarget(CHIPS, LAST!.id, LEFT)).toBeNull()
  })

  it('does nothing for a lone pane, an unknown chip or no chip at all', () => {
    expect(resolvePaneSwipeTarget([FIRST!], FIRST!.id, LEFT)).toBeNull()
    expect(resolvePaneSwipeTarget(CHIPS, 'tab-9::p9', LEFT)).toBeNull()
    expect(resolvePaneSwipeTarget(CHIPS, null, LEFT)).toBeNull()
  })

  it('does nothing for a vertical gesture, wherever it started', () => {
    for (const chip of CHIPS) {
      expect(
        resolvePaneSwipeTarget(CHIPS, chip.id, { translationX: -20, translationY: -300 })
      ).toBeNull()
    }
  })
})
