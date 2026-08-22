// Not from orca. orca's screens are pushed to over a live WebSocket, so "how long since a
// server last answered" is not a question its UI has to render; herdr v1 polls instead
// (.prd/03-blockers.md B9, `./use-foreground-refresh.ts`) and a poll can fail forever in
// silence. `./snapshot-context.tsx` keeps the last good snapshot on screen when a background
// refresh throws — which is right, a dropped ssh exec must not blank a readable fleet view —
// and is exactly why the glass then stops distinguishing "nothing is happening on my fleet"
// from "my phone stopped being able to ask". That is .prd/09-review-followups.md §G's residual:
// "10분째 실패 중인 링크와 건강한 링크가 화면에서 동일하게 보인다".
//
// Why `refreshError` alone is not the label: one failed tick on a train is the normal case and
// ten minutes of them is an outage, and "Refresh failed" says the same thing about both. The
// duration is the information; the label carries it or it is not worth rendering.
//
// Kept a pure function for the reason `../transport/connection-health.ts` and
// `../session/pane-chips.ts` are: the thresholds *are* the decision here, and a threshold that
// can only be exercised by mounting a screen is a threshold nobody re-checks.

/**
 * Below this, say nothing.
 *
 * The poll is every 4s (`./use-foreground-refresh.ts`), and on a phone two or three missed ticks is
 * a tunnel, a lock screen or a Wi-Fi handover — not a fleet the user has lost. Labelling those
 * teaches the user to ignore the label, which is the failure mode L6 names for connection state
 * (`../transport/connection-health.ts` holds `WARNING_ATTEMPTS = 3` for the identical reason:
 * "absorb a normal laptop wake / brief network blip without alarming the user").
 */
export const STALE_AFTER_MS = 15_000

/** Past this the seconds digit is noise; under it `1m` would round most of the outage away. */
export const STALE_MINUTES_AFTER_MS = 90_000

/** Same argument one unit up — nobody reads `137m`. */
export const STALE_HOURS_AFTER_MS = 90 * 60_000

/**
 * Seconds are floored to a 5s grid because the label only advances when the context re-renders, and
 * while refreshes are failing that is once per failed poll (~4s, `./snapshot-context.tsx:160-163`
 * writes a fresh state object on every failure). `stale 43s` would claim a resolution the render
 * schedule does not have; minutes and hours floor for the same reason.
 */
const SECONDS_GRID_S = 5

/**
 * The header's staleness hint, or `null` when there is nothing honest to say.
 *
 * `null` while healthy is a hard rule, not a default: there is no "up to date" state to invent here,
 * for the same reason `../components/ConnectionStatusLine.tsx` refuses to render one for a remote
 * with no supervisor ("No supervisor renders nothing. Not 'Connected', not a placeholder dot").
 * An old `updatedAt` with no `refreshError` is not evidence of anything — the poller stops while the
 * app is backgrounded (`./use-foreground-refresh.ts:51-54`), so age alone means "nobody was asking".
 */
export function snapshotStalenessLabel(args: {
  /** Epoch ms of the last snapshot a server actually returned, or `null` before the first one. */
  updatedAt: number | null
  /** `SnapshotState.refreshError`: the last background refresh failed and has not since succeeded. */
  refreshError: string | null
  nowMs?: number
}): string | null {
  if (args.refreshError === null) {
    return null
  }
  // Failing before the first success: nothing on screen came from a server, so "stale 2m" would be a
  // claim about data the user is not looking at. The screen's own `status: 'error'` body says what
  // happened; this line says only that asking is still not working.
  if (args.updatedAt === null) {
    return 'never loaded'
  }
  const ageMs = (args.nowMs ?? Date.now()) - args.updatedAt
  if (ageMs < STALE_AFTER_MS) {
    return null
  }
  if (ageMs < STALE_MINUTES_AFTER_MS) {
    return `stale ${Math.floor(ageMs / 1000 / SECONDS_GRID_S) * SECONDS_GRID_S}s`
  }
  if (ageMs < STALE_HOURS_AFTER_MS) {
    return `stale ${Math.floor(ageMs / 60_000)}m`
  }
  return `stale ${Math.floor(ageMs / 3_600_000)}h`
}
