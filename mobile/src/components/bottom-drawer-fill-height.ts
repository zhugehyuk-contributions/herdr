// Ported from orca mobile/src/components/bottom-drawer-fill-height.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
// Why: fill-mode sheets need a stable outer height so docked chrome (e.g. the
// smart-source TextInput) does not ride result-list reflow. Height shrinks by
// the keyboard inset; the sheet is also lifted with marginBottom equal to that
// inset so the bottom edge sits on the keyboard top (height shrink alone still
// leaves the dock in the keyboard footprint).

export function resolveBottomDrawerFillHeight(input: {
  screenHeight: number
  topInset: number
  keyboardInset: number
  topGap?: number
}): number {
  const topGap = input.topGap ?? 16
  const keyboardInset = Math.max(0, input.keyboardInset)
  // Never exceed the space under the status-bar gap and above the keyboard —
  // a hard minHeight here would grow the sheet upward under the status bar
  // while marginBottom still equals the full keyboard inset.
  return Math.max(0, input.screenHeight - input.topInset - topGap - keyboardInset)
}
