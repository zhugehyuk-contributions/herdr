// Ported from orca mobile/src/components/StatusDot.tsx
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Two changes from the orca original, both recorded because the port map grades this file `copy`:
//
// 1. The colour table is monotone. orca maps the transport state onto green/amber/red
//    (`statusGreen`/`statusAmber`/`statusRed`); herdr's mockup fixes a single grayscale ramp where
//    emphasis is brightness and the top level is inversion (mobile/src/theme/monotone.ts). The
//    *structure* — verdict overrides state, verdict severity escalates — is orca's, unchanged.
// 2. The `unreachable`/`auth-failed` dot is a ring rather than a fill. That is the "emphasis by
//    inversion" rule (mockup.html:165, `.dot.blocked`); in a monotone ramp a brighter fill alone
//    cannot carry "this is an error", so shape does.
//
// Imports: orca resolved both types through its transport layer, which is not ported yet; see
// ../transport/connection-state-types.
import { View, StyleSheet } from 'react-native'
import { dotMetrics, mono } from '../theme/monotone'
import type { ConnectionState } from '../transport/connection-state-types'
import type { ConnectionVerdictKind } from '../transport/connection-state-types'

const stateColors: Record<ConnectionState, string> = {
  connected: mono.fgSoft,
  connecting: mono.dim,
  handshaking: mono.dim,
  reconnecting: mono.dim,
  disconnected: mono.off,
  'auth-failed': mono.fg
}

// Why: when caller passes a verdict, the dot reflects the verdict's severity instead of the raw
// transport state. This avoids the "neutral dot next to a 'Can't reach remote' label" mismatch —
// the underlying transport is still 'reconnecting' but the user-visible meaning has escalated.
export function StatusDot({
  state,
  verdict
}: {
  state: ConnectionState
  verdict?: { kind: ConnectionVerdictKind }
}) {
  const escalated = verdict?.kind === 'unreachable' || verdict?.kind === 'auth-failed'
  if (escalated) {
    return <View style={styles.ring} />
  }
  const color =
    verdict?.kind === 'warning' ? mono.fg : (stateColors[state] ?? mono.dim2)
  return <View style={[styles.dot, { backgroundColor: color }]} />
}

const styles = StyleSheet.create({
  dot: {
    width: dotMetrics.size,
    height: dotMetrics.size,
    borderRadius: dotMetrics.size / 2,
    marginRight: 8
  },
  ring: {
    width: dotMetrics.ringSize,
    height: dotMetrics.ringSize,
    borderRadius: dotMetrics.ringSize / 2,
    borderWidth: dotMetrics.ringWidth,
    borderColor: mono.fg,
    backgroundColor: 'transparent',
    marginRight: 8
  }
})
