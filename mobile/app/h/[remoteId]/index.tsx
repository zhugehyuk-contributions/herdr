// Not from orca. orca's `app/h/[hostId]/index.tsx` is 1,719 lines (worktree list, agent rollups,
// drawers, new-worktree flow) and the port map grades it `port` for stage 5.
//
// This is NOT that screen. It is the stage-3 detail/sidebar pane: `app/h/_layout.tsx` imports it
// *twice* — once as the master pane when the layout is wide, once through the detail Stack — which
// is orca's structure (`app/h/_layout.tsx:14`, `:146-151`), and it is that dual use, not the body,
// that makes the master-detail skeleton real. The `embedded` / `onHideSidebar` props exist for the
// same reason they do in orca. Stage 5 replaces the body.
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { AgentStateDot } from '../../../src/components/AgentStateDot'
import { useHerdrSnapshot, useRemote, remoteSubtitle } from '../../../src/api/snapshot-context'
import { mono } from '../../../src/theme/monotone'

export function RemoteScreen({
  remoteId,
  embedded,
  onHideSidebar
}: {
  remoteId?: string
  embedded?: boolean
  onHideSidebar?: () => void
}) {
  const { snapshot } = useHerdrSnapshot()
  const remote = useRemote(remoteId)

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{remote ? remote.name : (remoteId ?? 'Remote')}</Text>
        <View style={styles.spacer} />
        {remote ? <Text style={styles.meta}>{remoteSubtitle(remote)}</Text> : null}
        {embedded && onHideSidebar ? (
          <Pressable accessibilityRole="button" onPress={onHideSidebar}>
            <Text style={styles.meta}>hide</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView>
        {snapshot.workspaces.map((workspace) => (
          <View key={workspace.workspace_id} style={styles.row}>
            <AgentStateDot state={workspace.agent_status} />
            <Text style={styles.name}>{workspace.label}</Text>
            <View style={styles.spacer} />
            <Text style={styles.meta}>
              {`${workspace.pane_count} panes · ${workspace.tab_count} tabs`}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

// expo-router needs a default export per route file; `app/h/_layout.tsx` uses the named export so
// it can pass `embedded`. The route form reads the segment itself — orca's split exactly
// (`app/h/[hostId]/index.tsx` exports `HostScreen` and a default route wrapper).
export default function RemoteRoute() {
  const { remoteId } = useLocalSearchParams<{ remoteId?: string }>()
  return <RemoteScreen remoteId={remoteId} />
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: mono.ink, paddingHorizontal: 16, paddingTop: 16 },
  header: { flexDirection: 'row', alignItems: 'center', paddingBottom: 8 },
  title: { color: mono.fg, fontSize: 18, fontWeight: '700' },
  meta: { color: mono.dim, fontSize: 12, marginLeft: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  name: { color: mono.fg, fontSize: 15, marginLeft: 8 },
  spacer: { flex: 1 }
})
