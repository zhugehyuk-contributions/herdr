// Ported from orca mobile/src/storage/preferences.ts:129-159.
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Only the sidebar-width block. The rest of orca's `preferences.ts` persists preference keys that
// have no herdr counterpart yet (push-notification opt-in, terminal text scale, pins); the port map
// grades that file `port` and schedules it later, so splitting the constants out keeps the stage-3
// route shell off a stage-5+ dependency — the same split already applied to
// `src/storage/terminal-text-scales.ts`.
//
// Renamed: `orca:hostSidebarWidth` -> `herdr:remoteSidebarWidth`, `HOST_` -> `REMOTE_`. herdr's
// first tree level is a *remote*, not a host (01-spec.md: `remote ▸ workspace ▸ tab ▸ pane`), and
// the storage key is user-visible state that would otherwise ship orca's brand.
import AsyncStorage from '@react-native-async-storage/async-storage'

const SIDEBAR_WIDTH_KEY = 'herdr:remoteSidebarWidth'

// Bounds for the draggable remote workspace-list sidebar on tablet/foldable layouts. The caller
// additionally caps the max against the window so the detail pane keeps usable space.
export const REMOTE_SIDEBAR_MIN_WIDTH = 280
export const REMOTE_SIDEBAR_MAX_WIDTH = 560
export const REMOTE_SIDEBAR_DEFAULT_WIDTH = 340

export function clampRemoteSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return REMOTE_SIDEBAR_DEFAULT_WIDTH
  }
  return Math.min(
    REMOTE_SIDEBAR_MAX_WIDTH,
    Math.max(REMOTE_SIDEBAR_MIN_WIDTH, Math.round(width))
  )
}

export async function loadRemoteSidebarWidth(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (raw === null) {
      return REMOTE_SIDEBAR_DEFAULT_WIDTH
    }
    return clampRemoteSidebarWidth(Number(raw))
  } catch {
    return REMOTE_SIDEBAR_DEFAULT_WIDTH
  }
}

export async function saveRemoteSidebarWidth(width: number): Promise<void> {
  await AsyncStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampRemoteSidebarWidth(width)))
}
