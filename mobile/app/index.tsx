// Not from orca. orca's `app/index.tsx` is 1,362 lines (host catalog, pairing entry point, QR,
// quick actions) and the port map grades it `port` for stage 5, together with `MobileHostCard`,
// `WorktreeListRow` and the `WorktreeAgent*` family.
//
// This is NOT that screen. It is the minimum route file stage 3 needs to exist at all — expo-router
// resolves `<Stack.Screen name="index">` to a file, and without one the shell cannot mount, so a
// receipt proving the shell mounts would be proving nothing. It renders the remote list and the
// blocked/working roll-up from the snapshot and stops there. Stage 5 replaces the body; the route
// file and its provider wiring stay.
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { StatusDot } from '../src/components/StatusDot'
import { useHerdrSnapshot, remoteSubtitle } from '../src/api/snapshot-context'
import { mono } from '../src/theme/monotone'
import type { AgentStatus } from '../src/api/herdr-api-types'

function countByStatus(statuses: readonly AgentStatus[], wanted: AgentStatus): number {
  return statuses.filter((status) => status === wanted).length
}

export default function RemoteListScreen() {
  const router = useRouter()
  const { status, snapshot, error } = useHerdrSnapshot()
  const agentStatuses = snapshot.agents.map((agent) => agent.agent_status)
  const blocked = countByStatus(agentStatuses, 'blocked')
  const working = countByStatus(agentStatuses, 'working')

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>herdr</Text>
      {status === 'loading' ? <Text style={styles.meta}>Loading…</Text> : null}
      {status === 'error' ? <Text style={styles.meta}>{error ?? 'Load failed'}</Text> : null}
      {status === 'ready' ? (
        <Text style={styles.meta}>{`${blocked} blocked · ${working} working`}</Text>
      ) : null}
      <ScrollView>
        {snapshot.remotes.map((remote) => (
          <Pressable
            key={remote.id}
            accessibilityRole="button"
            onPress={() => router.push(`/h/${remote.id}`)}
            style={styles.row}
          >
            <StatusDot state={remote.disabled ? 'disconnected' : 'connected'} />
            <Text style={styles.name}>{remote.name}</Text>
            <View style={styles.spacer} />
            <Text style={styles.meta}>{remote.disabled ? 'disabled' : remoteSubtitle(remote)}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: mono.ink, paddingHorizontal: 16, paddingTop: 24 },
  title: { color: mono.fg, fontSize: 22, fontWeight: '700' },
  meta: { color: mono.dim, fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  name: { color: mono.fg, fontSize: 15 },
  spacer: { flex: 1 }
})
