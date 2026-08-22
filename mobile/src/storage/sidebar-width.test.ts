// Not from orca (orca has no test for `preferences.ts`). Fixes the clamp bounds the resize handle
// in `app/h/_layout.tsx` depends on, so a later tuning pass cannot silently let the sidebar starve
// the detail pane.
import { describe, expect, it } from 'vitest'
import {
  REMOTE_SIDEBAR_DEFAULT_WIDTH,
  REMOTE_SIDEBAR_MAX_WIDTH,
  REMOTE_SIDEBAR_MIN_WIDTH,
  clampRemoteSidebarWidth
} from './sidebar-width'

describe('remote sidebar width', () => {
  it('keeps the default inside the bounds', () => {
    expect(REMOTE_SIDEBAR_DEFAULT_WIDTH).toBeGreaterThanOrEqual(REMOTE_SIDEBAR_MIN_WIDTH)
    expect(REMOTE_SIDEBAR_DEFAULT_WIDTH).toBeLessThanOrEqual(REMOTE_SIDEBAR_MAX_WIDTH)
  })

  it('clamps to the bounds and rounds', () => {
    expect(clampRemoteSidebarWidth(10)).toBe(REMOTE_SIDEBAR_MIN_WIDTH)
    expect(clampRemoteSidebarWidth(9999)).toBe(REMOTE_SIDEBAR_MAX_WIDTH)
    expect(clampRemoteSidebarWidth(340.6)).toBe(341)
  })

  it('falls back to the default for a non-finite stored value', () => {
    expect(clampRemoteSidebarWidth(Number.NaN)).toBe(REMOTE_SIDEBAR_DEFAULT_WIDTH)
  })
})
