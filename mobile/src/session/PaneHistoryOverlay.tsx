// Not from orca — orca has no such screen, because its history lives in the xterm buffer and its
// surface is therefore the terminal itself (`./pane-history.ts` explains why herdr cannot copy
// that). This is the divergence made visible.
//
// Three constraints shaped the component, and all three come from the renderer's absolute cursor
// positioning (`src/protocol/render_ansi.rs:613`) and from M6a's gesture settlement:
//
//  1. **Separate surface, never the xterm buffer.** The pane's ANSI stream rewrites the viewport in
//     place, so anything written into that buffer is gone on the next frame. The history text is
//     rendered by React Native, above the WebView, and the WebView never sees it.
//  2. **A button, not a scroll.** M6a gave the vertical axis to the terminal — the pan recognizer
//     fails at ±12px of vertical travel (`./pane-swipe.ts`) precisely so the WebView keeps
//     scrollback, alt-screen scroll and selection edge-scroll. Opening history off a vertical drag
//     would take that axis back and kill the routing this milestone just repaired.
//  3. **The ScrollView is outside the WebView.** `9a256d0a` removed `nestedScrollEnabled` from the
//     terminal WebView because on Android it calls `requestDisallowInterceptTouchEvent(true)` on
//     every MotionEvent and cancels every RNGH handler at touch-down. This overlay is a *sibling*
//     of the terminal, mounted only while open, so its scrolling never crosses that boundary and
//     the prop stays dead.
//
// It also renders nothing at all while closed, so a pane the user never asks about pays neither a
// mount nor an exec.
import { useCallback, useRef } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { historySummary } from './pane-history'
import { mono } from '../theme/monotone'
import { typography } from '../theme/mobile-theme'
import type { PaneHistoryView } from './use-pane-history'

/**
 * The pane's server-side scrollback, on its own surface.
 *
 * Holds no state and reads no context: everything is `history`, so it renders identically in the
 * route and in the mount suite.
 */
export function PaneHistoryOverlay({
  history,
  paneLabel
}: {
  history: PaneHistoryView
  paneLabel: string
}) {
  const bodyRef = useRef<ScrollView | null>(null)
  // The interesting end of a fixed-size read is the bottom — the rows that just scrolled off the
  // live pane, which is what the user opened this for. Driven from `onContentSizeChange` rather
  // than from the ref callback because at ref time the text has not been measured and
  // `scrollToEnd` would be a no-op; this fires again when a refresh replaces the content.
  const toBottom = useCallback(() => {
    bodyRef.current?.scrollToEnd({ animated: false })
  }, [])

  // After the hooks, so the hook order is the same on every render of a mounted overlay. A closed
  // overlay renders nothing: no ScrollView, no text, and no exec was spent to get here.
  if (!history.visible) {
    return null
  }
  return (
    <View style={styles.overlay}>
      <View style={styles.header}>
        <Text style={styles.title}>History</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {paneLabel}
        </Text>
        <View style={styles.spacer} />
        <Pressable
          accessibilityRole="button"
          // Named for what it costs, not for what it looks like: this is the one press in the
          // feature that opens another ssh exec (B8), so it should not read as a free redraw.
          accessibilityLabel="Re-read pane history"
          accessibilityHint="Asks the remote for this pane's scrollback again"
          style={styles.action}
          onPress={history.refresh}
        >
          <Text style={styles.actionLabel}>Refresh</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close pane history"
          style={styles.action}
          onPress={history.close}
        >
          <Text style={styles.actionLabel}>Close</Text>
        </Pressable>
      </View>

      <Text style={styles.meta} numberOfLines={1}>
        {metaLine(history)}
      </Text>

      <ScrollView
        ref={bodyRef}
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        onContentSizeChange={toBottom}
      >
        <Text style={styles.text} selectable>
          {history.snapshot?.text ?? ''}
        </Text>
      </ScrollView>
    </View>
  )
}

/** One line about the read itself — never about the pane, which the live screen already reports. */
function metaLine(history: PaneHistoryView): string {
  switch (history.status) {
    case 'loading':
      return 'reading…'
    case 'failed':
      return `read failed: ${history.error ?? 'unknown'}`
    case 'ready':
      return history.snapshot === null ? 'no history' : historySummary(history.snapshot)
    default:
      return 'no history'
  }
}

const styles = StyleSheet.create({
  // Absolute fill over the pane rather than a modal: the terminal underneath stays mounted and its
  // observe stream stays open, which is the point — closing this returns to a live screen, not to a
  // re-handshake.
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: mono.ink,
    zIndex: 2
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8
  },
  title: { color: mono.fg, fontSize: 15, fontWeight: '700' },
  subtitle: { color: mono.fgSoft, fontSize: 12, flexShrink: 1 },
  spacer: { flex: 1 },
  action: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: mono.line,
    borderRadius: 4,
    backgroundColor: mono.ink2
  },
  actionLabel: { color: mono.fg, fontSize: 11, fontWeight: '600' },
  meta: { color: mono.dim, fontSize: 11, paddingHorizontal: 16, paddingBottom: 8 },
  body: { flex: 1, borderTopWidth: 1, borderTopColor: mono.line },
  bodyContent: { padding: 12 },
  text: {
    color: mono.fgSoft,
    fontFamily: typography.monoFamily,
    fontSize: 11,
    lineHeight: 15
  }
})
