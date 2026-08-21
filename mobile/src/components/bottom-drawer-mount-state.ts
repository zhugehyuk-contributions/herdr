// Ported from orca mobile/src/components/bottom-drawer-mount-state.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
export function resolveBottomDrawerMounted(visible: boolean, mounted: boolean): boolean {
  return visible || mounted
}
