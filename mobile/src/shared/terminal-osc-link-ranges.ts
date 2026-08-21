// Ported from orca src/shared/terminal-osc-link-ranges.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
export type TerminalOscLinkRange = {
  row: number
  startCol: number
  endCol: number
  uri: string
}

export function isTerminalOscLinkRanges(value: unknown): value is TerminalOscLinkRange[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry != null &&
        typeof entry === 'object' &&
        Number.isInteger((entry as TerminalOscLinkRange).row) &&
        Number.isInteger((entry as TerminalOscLinkRange).startCol) &&
        Number.isInteger((entry as TerminalOscLinkRange).endCol) &&
        typeof (entry as TerminalOscLinkRange).uri === 'string'
    )
  )
}
