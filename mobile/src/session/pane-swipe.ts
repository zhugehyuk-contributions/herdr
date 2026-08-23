// Not from orca — and the **absence** is the finding, not a hole in the port map (§2.5 lists every
// `src/session/` file it took and none of them is a gesture).
//
// What orca does at this position, read at `838f5bfb` (`stablyai/orca`; the port map pins
// `1ce2e562`, and this position is unchanged between them): it switches terminal surfaces by **chip
// press only** — `setActiveSessionTabId(tab.id)` from the strip
// (`mobile/app/h/[hostId]/session/[worktreeId].tsx:2834,2859`). Grepping `swipe` across orca's
// `mobile/src` + `mobile/app` returns five files and not one of them changes the active surface:
// `components/RightDrawer.tsx` (a drawer pan), `src/host-route-exit.ts` (the OS swipe-back
// affordance), `onboarding/`, and the session screen's single hit is a *comment* at `:3273` —
// "gesture arrows parked across a reconnect would move a TUI long after the swipe".
//
// That comment is the reason, and it is why herdr may diverge where orca could not: in orca a drag
// on the terminal is **input**. `mobile/src/terminal/terminal-gesture-input.ts` translates it into
// mouse/arrow sequences and ships them to the TUI, so orca had already spent the horizontal axis
// and left surface switching to the chips. herdr did not port that file (there is no
// `terminal-gesture-input.ts` under `src/terminal/`), so on herdr a touch drag is never TUI input.
//
// The horizontal axis is therefore *nearly* free here — one occupant is left, and it is
// conditional: the injected script pans the zoomed grid horizontally **only when the content is
// wider than the viewport** (`src/terminal/terminal-webview-html.ts:1777-1786`, guarded by the same
// test `clampPan()` uses at `:435-445`). At fit width — every unzoomed pane — a horizontal drag
// does nothing today. A zoomed-in pane still loses long horizontal pans to this gesture; that is a
// real cost, recorded here rather than hidden, and the thresholds below are chosen to make it the
// *only* cost.
//
// So: horizontal is ours, vertical stays the terminal's, and both edges of that split are numbers
// rather than a feeling. The numbers live here, next to the rule that reads them, because the RN
// side and the recognizer configuration have to agree and a constant in two files does not.
import type { PaneChip } from './pane-chips'

/**
 * How far the finger must travel **horizontally** before the recognizer takes the gesture away from
 * the WebView. 32 is deliberately larger than the terminal's own `TAP_SLOP` of 24
 * (`src/terminal/terminal-webview-html.ts:1049`): a tap is disqualified there only past that slop,
 * so a tap can never be stolen half-way through and turn into a pane switch.
 */
export const PANE_SWIPE_ACTIVATE_OFFSET_X = 32

/**
 * How far the finger may travel **vertically** before the recognizer gives up for good and the
 * WebView keeps the whole gesture. Everything the terminal owns lives on that axis — scrollback,
 * alt-screen scroll routed as input (`terminal-webview-html.ts:1789-1806`), selection edge-scroll —
 * so the tie is broken in the terminal's favour, not ours. 12 = the terminal's `LONG_PRESS_SLOP`
 * (10, `:1043`) plus jitter: by then the terminal has already decided the finger moved.
 */
export const PANE_SWIPE_FAIL_OFFSET_Y = 12

/**
 * Distance at release. Activation (32) only means "this is horizontal"; committing to a *switch*
 * asks for twice that, so a finger that starts sideways and comes back lands on the pane it left.
 */
export const PANE_SWIPE_COMMIT_DISTANCE_X = 64

/**
 * Axis dominance at release: `|dx| >= 1.5 * |dy|`. The recognizer already refused anything that went
 * vertical *first*, but a gesture can activate horizontally and then curve; this is the second, JS-
 * side half of the same rule, and it is the half a unit test can see (the offsets above are
 * enforced by native code that no test in this repo runs).
 */
export const PANE_SWIPE_AXIS_RATIO = 1.5

/** The two fields of a pan-gesture end event this rule reads, and nothing else. */
export type PaneSwipeTranslation = {
  translationX: number
  translationY: number
}

/**
 * `next` = the chip to the right in the strip, `previous` = the chip to the left.
 *
 * A finger moving **left** (`translationX < 0`) drags the current pane off to the left and pulls the
 * next one in from the right — the direction every paged surface on both platforms uses, and the
 * direction the strip is read in.
 */
export type PaneSwipeDirection = 'next' | 'previous'

export function paneSwipeDirection(swipe: PaneSwipeTranslation): PaneSwipeDirection | null {
  const dx = swipe.translationX
  const dy = swipe.translationY
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return null
  }
  if (Math.abs(dx) < PANE_SWIPE_COMMIT_DISTANCE_X) {
    return null
  }
  if (Math.abs(dx) < Math.abs(dy) * PANE_SWIPE_AXIS_RATIO) {
    return null
  }
  return dx < 0 ? 'next' : 'previous'
}

/**
 * Which pane a swipe lands on, or `null` for "stay where you are".
 *
 * The chip array **is** the order — `buildPaneChips` (`./pane-chips.ts:54`) owns it and the strip
 * renders it, so a swipe and a tap can never disagree about what "next" means.
 *
 * There is no wrap-around, on purpose: a strip has ends, and a swipe that silently teleports from
 * the last pane to the first leaves the user with no idea where they are. Off the end is a no-op —
 * the same nothing the strip does when you tap the chip you are already on.
 */
export function resolvePaneSwipeTarget(
  chips: readonly PaneChip[],
  activeChipId: string | null | undefined,
  swipe: PaneSwipeTranslation
): string | null {
  const direction = paneSwipeDirection(swipe)
  if (direction === null || !activeChipId) {
    return null
  }
  const index = chips.findIndex((chip) => chip.id === activeChipId)
  if (index === -1) {
    return null
  }
  const target = chips[direction === 'next' ? index + 1 : index - 1]
  return target ? target.paneId : null
}
