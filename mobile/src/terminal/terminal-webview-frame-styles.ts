// Ported from orca mobile/src/terminal/terminal-webview-frame-styles.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
import { StyleSheet } from 'react-native'
import { colors } from '../theme/mobile-theme'

export const TERMINAL_WEBVIEW_FRAME_STYLES = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.terminalBg
  },
  webview: {
    flex: 1,
    backgroundColor: colors.terminalBg
  }
})
