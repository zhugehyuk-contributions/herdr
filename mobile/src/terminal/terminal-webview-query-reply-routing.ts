// Ported from orca mobile/src/terminal/terminal-webview-query-reply-routing.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
import { isTerminalQueryReply } from '../shared/terminal-query-reply'

export function routeTerminalQueryReply(
  message: Record<string, unknown>,
  onTerminalQueryReply: ((bytes: string) => void) | undefined
): void {
  if (
    message.type === 'terminal-data' &&
    typeof message.bytes === 'string' &&
    isTerminalQueryReply(message.bytes)
  ) {
    onTerminalQueryReply?.(message.bytes)
  }
}
