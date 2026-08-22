// Not from orca — orca has no counterpart, because orca resizes the desktop to the phone instead
// (port map §6 위험 3). This pins the rule stated in `./observer-geometry.ts`, including the two
// live measurements that motivated it.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OBSERVER_COLS,
  DEFAULT_OBSERVER_ROWS,
  paneLayoutFromResult,
  resolveObserverGeometry,
  type PaneLayoutSnapshot
} from './observer-geometry'

/** Verbatim shape of `pane.layout` on a fresh isolated server (measured 2026-08-22). */
const SINGLE_PANE: PaneLayoutSnapshot = {
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  zoomed: false,
  area: { x: 26, y: 1, width: 54, height: 23 },
  focused_pane_id: 'w1:p1',
  panes: [{ pane_id: 'w1:p1', focused: true, rect: { x: 26, y: 1, width: 54, height: 23 } }],
  splits: []
}

/** The same server after `pane.split {direction:"right"}` — rects halve, the PTYs do not. */
const SPLIT: PaneLayoutSnapshot = {
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  zoomed: false,
  area: { x: 26, y: 1, width: 54, height: 23 },
  focused_pane_id: 'w1:p1',
  panes: [
    { pane_id: 'w1:p1', focused: true, rect: { x: 26, y: 1, width: 27, height: 23 } },
    { pane_id: 'w1:p2', focused: false, rect: { x: 53, y: 1, width: 27, height: 23 } }
  ],
  splits: []
}

describe('observer geometry', () => {
  it('never falls below the size the server itself renders at with no client attached', () => {
    expect(resolveObserverGeometry({ paneId: 'w1:p1' })).toEqual({
      cols: DEFAULT_OBSERVER_COLS,
      rows: DEFAULT_OBSERVER_ROWS
    })
    expect([DEFAULT_OBSERVER_COLS, DEFAULT_OBSERVER_ROWS]).toEqual([80, 24])
  })

  it('covers the whole pane when the layout is a single pane', () => {
    // 54x23 rect, and the pane inside it measured 53 columns by `stty size`. Asking for 54 is one
    // spare column; asking for 53 would have been a guess that happened to fit.
    const geometry = resolveObserverGeometry({ paneId: 'w1:p1', layout: SINGLE_PANE })
    expect(geometry.cols).toBeGreaterThanOrEqual(54)
    expect(geometry.rows).toBeGreaterThanOrEqual(23)
  })

  it('does NOT shrink to a split pane rect, because the PTY does not shrink with it', () => {
    // The measurement this test exists for: after the split both rects said 27 columns while
    // `stty size` inside the panes still said 53 and 54. Believing the rect would crop 26 columns
    // off every line — blocker B4, silently.
    const geometry = resolveObserverGeometry({ paneId: 'w1:p1', layout: SPLIT })
    expect(geometry.cols).toBe(80)
    expect(geometry.cols).toBeGreaterThan(SPLIT.panes[0]!.rect.width)
  })

  it('takes a pane wider than its area — the 200-column case milestone M2 (e) names', () => {
    const wide: PaneLayoutSnapshot = {
      ...SINGLE_PANE,
      area: { x: 0, y: 0, width: 54, height: 23 },
      panes: [{ pane_id: 'w1:p1', focused: true, rect: { x: 0, y: 0, width: 200, height: 50 } }]
    }
    expect(resolveObserverGeometry({ paneId: 'w1:p1', layout: wide })).toEqual({
      cols: 200,
      rows: 50
    })
  })

  it('uses the exact row count from `scroll.viewport_rows` when the snapshot carries one', () => {
    const geometry = resolveObserverGeometry({
      paneId: 'w1:p1',
      layout: SINGLE_PANE,
      viewportRows: 120
    })
    expect(geometry.rows).toBe(120)
  })

  it('ignores a pane id the layout does not contain rather than reporting zero', () => {
    const geometry = resolveObserverGeometry({ paneId: 'w9:p9', layout: SPLIT })
    expect(geometry.cols).toBeGreaterThanOrEqual(54)
    expect(geometry.rows).toBeGreaterThanOrEqual(23)
  })

  it('reads the live result envelope, and rejects a shape it cannot trust', () => {
    expect(paneLayoutFromResult({ type: 'pane_layout', layout: SINGLE_PANE })?.area.width).toBe(54)
    expect(paneLayoutFromResult({ type: 'pane_layout' })).toBeNull()
    expect(paneLayoutFromResult({ type: 'pane_layout', layout: { area: {} } })).toBeNull()
  })
})
