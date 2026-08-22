// Ported from orca mobile/src/storage/preferences.ts:39-42.
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Only the preset table is taken. The rest of orca's `preferences.ts` is AsyncStorage load/save for
// preference keys that do not exist yet in herdr; the port map grades that file `port`, not `copy`,
// and schedules it after the terminal layer. Splitting the constant out keeps the WebView HTML
// builder free of a storage dependency at this stage.

// Fixed presets rather than a continuous slider: keeps the settings picker simple and bounds the
// value to ones the zoom logic handles; pinch-to-zoom in the terminal snaps to these same presets.
// Sub-1 steps shrink below fit-to-width (more columns visible with side margins).
export const TERMINAL_TEXT_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
