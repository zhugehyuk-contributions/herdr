// Ported from orca src/shared/file-link-location.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
export type ParsedFileLinkLocation = {
  pathText: string
  line: number | null
  column: number | null
}

export function parseFileLinkLocation(value: string): ParsedFileLinkLocation | null {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value)
  const pathText = match?.[1]
  if (!pathText) {
    return null
  }
  const line = match[2] ? Number.parseInt(match[2], 10) : null
  const column = match[3] ? Number.parseInt(match[3], 10) : null
  if ((line !== null && line < 1) || (column !== null && column < 1)) {
    return null
  }
  return { pathText, line, column }
}
