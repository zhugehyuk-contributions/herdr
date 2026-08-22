// Not from orca as a file, and the one line of arithmetic in it is the whole D1 fix
// (.prd/09-review-followups.md §D1). The rule it states — "chrome pinned to a window edge is padded
// by the safe-area inset" — is already in this repo twice, both times in ported orca code:
// `../components/RightDrawer.tsx:193` pads by `insets.top + spacing.md` / `insets.bottom +
// spacing.lg`, and `../components/mounted-bottom-drawer.tsx:378` by `insets.bottom + spacing.lg`.
// Those two were the *only* readers of the inset in the app. Every screen's own top bar hardcoded
// `paddingTop: 24` instead, and 24 is the Android status-bar height and nothing else: on an
// iPhone 17 Pro the top inset is ~59pt, so the `settings` button rendered at y=31.7 sat entirely
// under the Dynamic Island — XCUITest delivered the tap and nothing navigated, while the same tap
// in landscape (status bar hidden, inset 0) worked.
//
// `Math.max`, not orca's `inset + base`, and that divergence is deliberate rather than an
// oversight. orca's two call sites are *overlay* surfaces whose base is interior spacing
// (`spacing.md`), a quantity that stacks with an inset. The screens' 24 is not spacing, it is a
// status bar drawn as a number, so adding it would count the same bar twice. Reading it as a floor
// instead gives, on the three cases that exist:
//   · Android — edge-to-edge (`android/gradle.properties:47 edgeToEdgeEnabled=true`), so
//     `insets.top` there *is* the ~24dp status bar the constant was standing in for:
//     max(24, 24) = 24, and every Android screen renders exactly as it did before this file.
//   · iPhone portrait — max(59, 24) = 59. The fix.
//   · iPhone landscape — the status bar is hidden and `insets.top` is 0: max(0, 24) = 24, i.e. the
//     orientation that already worked is left alone. `insets.top` on its own would have flattened
//     it to 0 and jammed the appbar against the top edge.
//
// Scope: the vertical axis only. `insets.left`/`insets.right` are the same defect class in
// landscape (the notch eats one side gutter), but the master-detail layout puts two panes side by
// side (`app/h/_layout.tsx`) and only the outer one owns a horizontal inset — deciding which
// without a device to look at would be guessing. Left as a known residual, not fixed here.

/**
 * The padding an edge-pinned bar needs so it clears the system chrome without ever being tighter
 * than the constant it was designed with.
 *
 * @param inset the safe-area inset for that edge (`useSafeAreaInsets()`)
 * @param base the padding the bar had before there was an inset in the picture
 */
export function safeChromePadding(inset: number, base: number): number {
  return Math.max(inset, base)
}
