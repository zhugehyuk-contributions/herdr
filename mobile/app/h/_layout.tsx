// Ported from orca mobile/app/h/_layout.tsx
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// This is the master-detail skeleton the port map calls "master-detail의 실체" (§2.2), and every
// non-obvious line is orca's: `MIN_DETAIL_WIDTH` and the window-aware clamp (`:16-28`), the
// phone/tablet animation split (`:36-39`), the *dedicated edge handle* for the resizer and the
// Android responder reason it exists (`:110-115`), the "no reveal button" rule (`:101-108`), and
// keeping the detail Stack at a stable tree position so a fold/rotation does not remount the
// navigator (`:138-140`).
//
// Renamed for herdr's domain, at the route-segment and title level only (01-spec.md: herdr's tree is
// `remote ▸ workspace ▸ tab ▸ pane`, and orca's `host`/`worktree` vocabulary is not it):
//   `[hostId]` -> `[remoteId]`, `hostId` -> `remoteId`, `HostGroupLayout` -> `RemoteGroupLayout`,
//   `HostScreen` -> `RemoteScreen`, `HOST_SIDEBAR_*` -> `REMOTE_SIDEBAR_*`, title 'Host' -> 'Remote'.
// Deliberately no bulk rename beyond that.
//
// Dropped: `HostProtocolGate` (`:13`, `:142`) — the protocol-compat hard block is X6/B1, port map
// stage 8, and the gate has nothing to check before a transport exists. Its wrapper position is
// marked below so it goes back exactly where orca has it.
// Screens: orca lists nine; `tasks`, `source-control`, `review`, `pr`, `agent-history` and
// `accounts` are all `drop` (§2.2 — no `git.*`/`files.*`/tasks in herdr's JSON API), so what remains
// is the workspace list and the pane viewer (the latter is stage 7 and not created yet).
import { useCallback, useEffect, useRef, useState } from 'react'
import { View, StyleSheet, PanResponder } from 'react-native'
import { Stack, useGlobalSearchParams, usePathname } from 'expo-router'
import { mono } from '../../src/theme/monotone'
import { useResponsiveLayout } from '../../src/layout/responsive-layout'
import {
  REMOTE_SIDEBAR_DEFAULT_WIDTH,
  REMOTE_SIDEBAR_MAX_WIDTH,
  REMOTE_SIDEBAR_MIN_WIDTH,
  loadRemoteSidebarWidth,
  saveRemoteSidebarWidth
} from '../../src/storage/sidebar-width'
import { RemoteScreen } from './[remoteId]/index'

// Keep at least this much room for the detail pane when resizing the sidebar.
const MIN_DETAIL_WIDTH = 320
const RESIZE_EDGE_WIDTH = 24

// Clamp a sidebar width to the bounds and to the current window, so a width
// saved on a larger device can't starve the detail pane on a narrower one.
export function clampSidebarToWindow(width: number, windowWidth: number): number {
  const hardMax = Math.max(
    REMOTE_SIDEBAR_MIN_WIDTH,
    Math.min(REMOTE_SIDEBAR_MAX_WIDTH, windowWidth - MIN_DETAIL_WIDTH)
  )
  return Math.min(hardMax, Math.max(REMOTE_SIDEBAR_MIN_WIDTH, Math.round(width)))
}

function RemoteStack({ animation }: { animation: 'none' | 'default' }) {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: mono.ink },
        // In the tablet split view the detail pane should swap instantly like
        // a desktop master-detail; the default slide animates the outgoing
        // screen and briefly reveals the one beneath it. Phones keep the slide.
        animation
      }}
    >
      <Stack.Screen name="[remoteId]/index" options={{ title: 'Remote' }} />
    </Stack>
  )
}

export default function RemoteGroupLayout() {
  // Wide layout = tablet/foldable canvas (see responsive-layout-metrics).
  const { isWideLayout, width: windowWidth } = useResponsiveLayout()
  const { remoteId } = useGlobalSearchParams<{ remoteId?: string }>()
  const pathname = usePathname()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(REMOTE_SIDEBAR_DEFAULT_WIDTH)

  // Refs keep the once-created PanResponder reading live values without
  // re-creating its handlers on every width/window change.
  const widthRef = useRef(sidebarWidth)
  widthRef.current = sidebarWidth
  const windowWidthRef = useRef(windowWidth)
  windowWidthRef.current = windowWidth
  const dragStartRef = useRef(sidebarWidth)

  // Restore the user's last sidebar width, clamped to the current window.
  useEffect(() => {
    let stale = false
    void loadRemoteSidebarWidth().then((saved) => {
      if (!stale) {
        setSidebarWidth(clampSidebarToWindow(saved, windowWidthRef.current))
      }
    })
    return () => {
      stale = true
    }
  }, [])

  // Re-clamp when the window shrinks (fold, rotation, split-screen) so the
  // detail pane keeps at least MIN_DETAIL_WIDTH.
  useEffect(() => {
    setSidebarWidth((current) => clampSidebarToWindow(current, windowWidth))
  }, [windowWidth])

  const hideSidebar = useCallback(() => setSidebarOpen(false), [])
  const showSidebar = isWideLayout && !!remoteId
  const detailHasContent = !!remoteId && pathname !== `/h/${remoteId}`
  const canCollapseSidebar = showSidebar && detailHasContent

  // Why: there is no reveal button — navigating Back to the base remote route brings
  // the sidebar back (and that route's detail pane is only a placeholder, so a
  // hidden sidebar would leave nothing useful).
  useEffect(() => {
    if (showSidebar && !detailHasContent) {
      setSidebarOpen(true)
    }
  }, [detailHasContent, showSidebar])

  // Why: the resizer lives on a dedicated edge handle (a leaf overlay at the
  // sidebar's right border), NOT on the sidebar container. On Android a child
  // ScrollView/FlatList claims the native touch responder, so a parent-View
  // PanResponder never sees the move events and the drag silently no-ops; a
  // dedicated handle on top of the content captures the gesture on both
  // platforms. It claims on start (capture too) since nothing sits under it.
  const resizer = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        dragStartRef.current = widthRef.current
      },
      onPanResponderMove: (_evt, g) => {
        setSidebarWidth(clampSidebarToWindow(dragStartRef.current + g.dx, windowWidthRef.current))
      },
      onPanResponderRelease: () => {
        void saveRemoteSidebarWidth(widthRef.current)
      },
      onPanResponderTerminate: () => {
        void saveRemoteSidebarWidth(widthRef.current)
      }
    })
  ).current

  // The detail Stack stays at a stable position in the tree across width
  // changes so a fold/rotation doesn't remount the navigator and reset the
  // navigation stack — only the sidebar pane toggles in and out.
  // (orca wraps this whole View in `<HostProtocolGate hostId=…>`; that gate is stage 8.)
  return (
    <View style={styles.row}>
      {showSidebar && sidebarOpen ? (
        <View style={[styles.sidebar, { width: sidebarWidth }]}>
          <RemoteScreen
            embedded
            remoteId={remoteId}
            onHideSidebar={canCollapseSidebar ? hideSidebar : undefined}
          />
          {/* Dedicated drag handle straddling the right border — see resizer note. */}
          <View style={styles.resizeHandle} {...resizer.panHandlers} />
        </View>
      ) : null}
      <View style={styles.detail}>
        <RemoteStack animation={showSidebar ? 'none' : 'default'} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: mono.ink
  },
  sidebar: {
    borderRightWidth: 1,
    borderRightColor: mono.line
  },
  // Invisible grab strip over the sidebar's right edge. Absolute + elevated so it
  // sits above the workspace list and reliably owns the drag on Android.
  resizeHandle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: RESIZE_EDGE_WIDTH,
    zIndex: 20,
    elevation: 20
  },
  detail: {
    flex: 1,
    minWidth: 0
  }
})
