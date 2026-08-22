// The two properties `safeChromePadding` exists to hold, stated as cases from the three devices
// this app has actually been run on. The mount-level proof that the screens *use* it is
// `../app-shell/safe-area-mount.test.tsx`; this file is why the arithmetic itself is not a guess.
import { describe, expect, it } from 'vitest'
import { safeChromePadding } from './safe-area-chrome'

describe('safeChromePadding', () => {
  it('clears the inset when the inset is the larger of the two', () => {
    // iPhone 17 Pro portrait, the D1 case: 24 left the `settings` button at y=31.7, under a 59pt
    // Dynamic Island.
    expect(safeChromePadding(59, 24)).toBe(59)
    // Home indicator, bottom edge — the bars had no bottom padding at all.
    expect(safeChromePadding(34, 0)).toBe(34)
  })

  it('never renders tighter than the padding the bar already had', () => {
    // iPhone landscape: status bar hidden, inset 0. This orientation was the one that worked, and
    // the fix must not move it.
    expect(safeChromePadding(0, 24)).toBe(24)
    expect(safeChromePadding(16, 24)).toBe(24)
  })

  it('is a no-op on Android, where the constant was the status bar all along', () => {
    // edge-to-edge is on (`android/gradle.properties:47`), so the inset is the status bar height
    // the hardcoded 24 was standing in for.
    expect(safeChromePadding(24, 24)).toBe(24)
    // ...and a taller status bar (cutout devices) grows the bar rather than being ignored.
    expect(safeChromePadding(32, 24)).toBe(32)
  })
})
