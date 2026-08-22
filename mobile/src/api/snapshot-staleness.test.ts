// Not from orca (neither is the function under test). The receipt for .prd/09-review-followups.md
// §G's residual — "10분째 실패 중인 링크와 건강한 링크가 화면에서 동일하게 보인다" — at the layer
// where the decision actually lives: what the header is allowed to say, and when it must say
// nothing. `../app-shell/stale-snapshot-mount.test.tsx` proves the same label reaches the glass.
//
// Every case below is a threshold from `./snapshot-staleness.ts`, exercised on both sides, because
// a threshold nobody crosses in a test is a number nobody will dare change later.
import { describe, expect, it } from 'vitest'
import {
  snapshotStalenessLabel,
  STALE_AFTER_MS,
  STALE_HOURS_AFTER_MS,
  STALE_MINUTES_AFTER_MS
} from './snapshot-staleness'

/** Mount time, so every `nowMs` below reads as "this long after the last good snapshot". */
const LOADED_AT = 1_700_000_000_000

function labelAfter(
  ms: number,
  refreshError: string | null = 'ssh: channel closed'
): string | null {
  return snapshotStalenessLabel({ updatedAt: LOADED_AT, refreshError, nowMs: LOADED_AT + ms })
}

describe('snapshot staleness label', () => {
  it('says nothing while refreshes are succeeding, however old the snapshot is', () => {
    expect(labelAfter(0, null)).toBeNull()
    expect(labelAfter(10 * 60_000, null)).toBeNull()
    // The poller stops while the app is backgrounded, so a day-old `updatedAt` with no error means
    // nobody was asking — not that the fleet is unreachable. Inventing a warning here is the same
    // lie as inventing a green "Connected" (`../components/ConnectionStatusLine.tsx`, property 1).
    expect(labelAfter(24 * 3_600_000, null)).toBeNull()
  })

  it('absorbs the first failed ticks — a tunnel is not an outage', () => {
    expect(labelAfter(0)).toBeNull()
    expect(labelAfter(4_000)).toBeNull()
    expect(labelAfter(STALE_AFTER_MS - 1)).toBeNull()
  })

  it('reports seconds once the failures outlast the absorption window', () => {
    expect(labelAfter(STALE_AFTER_MS)).toBe('stale 15s')
    expect(labelAfter(40_000)).toBe('stale 40s')
    expect(labelAfter(STALE_MINUTES_AFTER_MS - 1)).toBe('stale 85s')
  })

  it('never claims a resolution the 4s poll cannot deliver', () => {
    // 43s of failure renders as 40s: the label only advances when a failed poll re-renders the
    // context, so a second-precise number would be made up between ticks.
    expect(labelAfter(43_000)).toBe('stale 40s')
    expect(labelAfter(44_999)).toBe('stale 40s')
    expect(labelAfter(45_000)).toBe('stale 45s')
  })

  it('switches to minutes, then to hours, rather than growing a longer number', () => {
    expect(labelAfter(STALE_MINUTES_AFTER_MS)).toBe('stale 1m')
    expect(labelAfter(10 * 60_000)).toBe('stale 10m')
    expect(labelAfter(STALE_HOURS_AFTER_MS - 60_000)).toBe('stale 89m')
    expect(labelAfter(STALE_HOURS_AFTER_MS)).toBe('stale 1h')
    expect(labelAfter(5 * 3_600_000)).toBe('stale 5h')
  })

  it('does not date a snapshot that never arrived', () => {
    // Reachable: the initial load fails (`status: 'error'`, `updatedAt` still null) and the poller
    // keeps failing on top of it. "stale 2m" would be a claim about data the user cannot see.
    expect(
      snapshotStalenessLabel({
        updatedAt: null,
        refreshError: 'ssh: channel closed',
        nowMs: LOADED_AT
      })
    ).toBe('never loaded')
    expect(snapshotStalenessLabel({ updatedAt: null, refreshError: null })).toBeNull()
  })

  it('stays silent when the clock moves backwards under it', () => {
    // A phone's wall clock jumps (NTP, timezone daemon, the user). A negative age is not evidence
    // of freshness either, but "stale -3m" is the one thing it must never print.
    expect(labelAfter(-180_000)).toBeNull()
  })
})
