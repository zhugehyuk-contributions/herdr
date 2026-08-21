// Ported from orca src/shared/runtime-types.ts:209-212 (that file is 1,314 lines and pulls in the
// whole desktop runtime surface; only this one type is on the terminal path, so it is re-declared
// here — mobile/.prd/08-orca-port-map.md §6 risk 1, "이식하는 타입만 재정의한다").
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
import type { TerminalColorOverrides } from './terminal-color-overrides'

export type RuntimeMobileTerminalTheme = {
  mode: 'dark' | 'light'
  theme: TerminalColorOverrides
}
