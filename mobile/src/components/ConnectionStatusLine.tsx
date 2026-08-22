// Rewritten for herdr, from orca mobile/app/h/[hostId]/session/[worktreeId].tsx:4191-4203 (the
// right-aligned status line that doubles as the connection verdict and becomes a Retry button)
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// **L6 and L7 of mobile/.prd/05-orca-transport.md, on screen.** The two rules are one component
// because they are one affordance:
//
//   L6  "'연결 중…' 라벨이 실패 루프를 가린다" → the label is the *verdict*, not the state, so a
//       loop that has failed three times says "Can’t connect" and one that has failed twelve says
//       "Can’t reach remote". `./StatusDot` escalates with it (fill → bright fill → ring).
//   L7  "유일한 복구가 앱 강제종료" → above `normal` the line is a `Pressable`, and its press calls
//       `ConnectionSupervisor.forceReconnect()`. **Not a request resend.** Resending against a
//       refused key changes nothing; what orca's #5049 users lacked was any way to replace the
//       transport short of the app switcher.
//
// Three properties this file is responsible for, each of which has a test rather than a comment:
//
//   1. **No supervisor renders nothing.** Not "Connected", not a placeholder dot. The mock build and
//      every build before M4 have connections and no supervision, and inventing a green state there
//      is the exact lie L6 exists to stop.
//   2. **Below the escalation threshold there is no button.** `showConnectionRetry` is the gate
//      (`../transport/connection-health.ts`) and orca's reason is worth keeping verbatim: offering
//      "Retry" during a 500ms backoff teaches the user to poke at a loop that is already working.
//   3. **Monotone.** The palette is the grayscale ramp only (`../theme/monotone.ts`); severity is
//      carried by the dot's shape and the label's text, never by a hue. `../theme/
//      monotone-discipline.test.tsx` renders this component at every verdict and fails on any
//      colour outside the ramp.
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { StatusDot } from './StatusDot'
import { mono } from '../theme/monotone'
import type { ConnectionStatus } from '../transport/use-connection-status'

/**
 * The supervised connection's line, or `null` when the remote has no supervisor.
 *
 * `status` comes from `useConnectionStatus`; this component holds no state and reads no context, so
 * it renders the same in the route, in the mount suite and in the live outage receipt.
 */
export function ConnectionStatusLine({ status }: { status: ConnectionStatus | null }) {
  if (status === null) {
    return null
  }
  const body = (
    <>
      <StatusDot state={status.state} verdict={status.verdict} />
      <Text style={styles.label} numberOfLines={1}>
        {status.label}
      </Text>
      {status.canRetry ? <Text style={styles.retry}>Retry</Text> : null}
    </>
  )
  if (!status.canRetry) {
    return <View style={styles.line}>{body}</View>
  }
  return (
    <Pressable
      accessibilityRole="button"
      // The label says what pressing does, because "Retry" next to "Can’t reach remote" is
      // ambiguous between "try that request again" and "reconnect" — and L7 is only the second one.
      accessibilityLabel={`${status.label} — reconnect`}
      accessibilityHint="Reopens the connection to this remote"
      style={styles.line}
      onPress={status.retry}
    >
      {body}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8
  },
  // `dim` is the same weight the header's other meta text uses: an escalated verdict is made loud by
  // the dot's shape and by the words, not by a brighter grey competing with the pane title.
  label: { color: mono.dim, fontSize: 11, flexShrink: 1 },
  retry: {
    color: mono.fg,
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: mono.line,
    borderRadius: 4
  }
})
