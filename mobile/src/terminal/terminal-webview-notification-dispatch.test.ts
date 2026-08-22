// Ported from orca mobile/src/terminal/terminal-webview-notification-dispatch.test.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
import { describe, expect, it, vi } from 'vitest'

import { dispatchTerminalWebViewNotification } from './terminal-webview-notification-dispatch'

describe('dispatchTerminalWebViewNotification', () => {
  it('preserves bounded keyboard metrics through the dispatcher', () => {
    const onKeyboardAvoidanceMetrics = vi.fn()
    dispatchTerminalWebViewNotification(
      {
        type: 'keyboard-avoidance-metrics',
        cursorY: 30,
        contentBottomRow: 99,
        rows: 40,
        altScreen: true
      },
      { onKeyboardAvoidanceMetrics, reportEngineError: vi.fn() }
    )
    expect(onKeyboardAvoidanceMetrics).toHaveBeenCalledWith({
      cursorY: 30,
      contentBottomRow: 39,
      rows: 40,
      altScreen: true
    })
  })

  it('keeps old WebView payloads cursor-compatible', () => {
    const onKeyboardAvoidanceMetrics = vi.fn()
    dispatchTerminalWebViewNotification(
      { type: 'keyboard-avoidance-metrics', cursorY: 12, rows: 40 },
      { onKeyboardAvoidanceMetrics, reportEngineError: vi.fn() }
    )
    expect(onKeyboardAvoidanceMetrics).toHaveBeenCalledWith({
      cursorY: 12,
      contentBottomRow: 12,
      rows: 40,
      altScreen: false
    })
  })
})
