// Ported from orca mobile/src/terminal/terminal-webview-messages.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
import type { RuntimeMobileTerminalTheme } from '../shared/runtime-terminal-theme'
import type { TerminalOscLinkRange } from '../shared/terminal-osc-link-ranges'

export type TerminalWebViewCommand =
  | { type: 'ping'; id?: number }
  | { type: 'write'; id?: number; data: string }
  | {
      type: 'init'
      id?: number
      cols: number
      rows: number
      initialData?: string
      oscLinks?: TerminalOscLinkRange[]
      terminalTheme?: RuntimeMobileTerminalTheme
      fontScale?: number
      // Why: width-reflow re-streams replay the same content rewrapped at new
      // cols; preserve the reader's scroll position instead of jumping to bottom.
      preserveScroll?: boolean
    }
  | { type: 'set-font-scale'; id?: number; fontScale: number }
  | { type: 'resize'; id?: number; cols: number; rows: number }
  | { type: 'reflow'; id?: number; cols: number; rows: number }
  | { type: 'clear'; id?: number }
  | { type: 'measure'; id?: number; containerHeight?: number }
  | { type: 'reset-zoom'; id?: number }
  | { type: 'cancel-select'; id?: number }
  | { type: 'do-select-all'; id?: number }
  | { type: 'set-theme'; id?: number; terminalTheme?: RuntimeMobileTerminalTheme }
