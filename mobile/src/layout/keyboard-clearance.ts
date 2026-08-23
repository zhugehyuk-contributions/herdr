// Not from orca. The bottom-edge companion to `./safe-area-chrome.ts`: the same arithmetic question
// asked about a different obstruction — not the home indicator, the soft keyboard.
//
// The defect (.prd/09-review-followups.md §BB, iOS lab 2026-08-23, iPhone 17 Pro simulator): the
// pane viewer's `Send input` (↵) button measured `{{352, 796}, {38, 38}}` in an 874pt window, so
// with the keyboard up it sat under the keyboard and reported `isHittable = false`. M3 passed only
// because the *keyboard's* own Return is wired to the same submit (`returnKeyType="send"` +
// `onSubmitEditing`) — an alternate route around a control that is visible and dead, which is the
// §R D1 shape again (there the `settings` button took taps and navigated nowhere).
//
// `Math.max`, not `+`, for the same reason §D1 chose `Math.max(inset, base)` over orca's
// `inset + spacing`: the bar already pads its bottom by `insets.bottom` for the home indicator, and
// iOS reports the keyboard's frame from the *window's* bottom edge — the keyboard covers that
// indicator strip rather than standing on top of it. `insets.bottom + keyboardHeight` therefore
// counts the strip twice and parks the bar 34pt above the keyboard on this phone. What the bar owes
// the window's bottom edge is `max(insets.bottom, keyboardHeight)`; expressed as the extra shift on
// top of the padding it already carries, that is `keyboardHeight - insets.bottom`, floored at zero.
//
// Which platforms shift at all is not this file's decision — it is `./use-soft-keyboard-height.ts`,
// because it is a fact about the window, not about the arithmetic.

/**
 * How far an edge-pinned input bar has to be shifted up to clear the soft keyboard, given that it
 * is already padded away from the window edge by `bottomInset`.
 *
 * @param keyboardHeight the keyboard frame's height in points; 0 when the keyboard is down
 * @param bottomInset the safe-area inset the bar already pads by (`useSafeAreaInsets().bottom`)
 */
export function keyboardBarLift(keyboardHeight: number, bottomInset: number): number {
  if (!Number.isFinite(keyboardHeight) || keyboardHeight <= 0) {
    return 0
  }
  const alreadyClear = Number.isFinite(bottomInset) ? Math.max(0, bottomInset) : 0
  return Math.max(0, keyboardHeight - alreadyClear)
}
