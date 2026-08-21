// Not from orca — and that is the divergence, not an omission.
//
// orca's `app/index.tsx` (1,362 lines) is the **host catalog**: pick a host, then a worktree, then
// a session. The port map grades it `port` for this stage and pairs it with `MobileHostCard`. That
// screen still exists here — it is `app/nodes.tsx`, and it is where the stage-3 body moved.
//
// What sits at the app's home instead is the Agents view, because 01-spec.md decision 3 is
// explicit: "**Agents 화면 = 홈.** 전 서버 에이전트를 상태순(blocked → working → done)으로. 폰에서
// 사람이 실제로 하는 일은 트리 브라우징이 아니라 '누가 나를 기다리나 → 그 화면 보고 → y 눌러주기'
// 다." orca has no cross-host screen to port for that (see ../src/agents/fleet-agents.ts), so the
// information architecture is herdr's and only the row components underneath are orca's:
// `AgentRow` / `AgentSummary` / `AgentList`, ported from the `WorktreeAgent*` family.
//
// The two properties this screen is judged on (04-milestones.md M2 "됐다" (a) — blocked found from
// the home screen):
//   1. `blocked` is the first section, always. Enforced in `groupFleetAgentsByStatus`, asserted by
//      position — not by presence — in `../src/app-shell/agents-home-mount.test.tsx`.
//   2. Every row names its remote *and* its workspace. A cross-remote list whose rows do not say
//      where they are is not usable: you cannot go there.
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { AgentRow } from '../src/components/AgentRow'
import { BottomNav } from '../src/components/BottomNav'
import { useHerdrSnapshot } from '../src/api/snapshot-context'
import { agentPaneHandle } from '../src/agents/agent-display'
import { buildFleetAgentRows, countByStatus, groupFleetAgentsByStatus } from '../src/agents/fleet-agents'
import { mono } from '../src/theme/monotone'

export default function AgentsHomeScreen() {
  const router = useRouter()
  const { status, snapshot, error } = useHerdrSnapshot()
  const rows = buildFleetAgentRows(snapshot)
  const groups = groupFleetAgentsByStatus(rows)
  const blocked = countByStatus(rows, 'blocked')
  const working = countByStatus(rows, 'working')

  return (
    <View style={styles.screen}>
      <View style={styles.appbar}>
        <Text style={styles.logo}>herdr</Text>
        <Text style={styles.crumb}>/ agents</Text>
        <View style={styles.spacer} />
        {/* Which remotes this list is the union of — the mockup's "all nodes" (mockup.html:637). */}
        <Text style={styles.meta}>{`${snapshot.perRemote.length} nodes`}</Text>
      </View>
      {status === 'loading' ? <Text style={styles.meta}>Loading…</Text> : null}
      {status === 'error' ? <Text style={styles.meta}>{error ?? 'Load failed'}</Text> : null}
      {status === 'ready' ? (
        <Text style={styles.summary}>{`${blocked} blocked · ${working} working`}</Text>
      ) : null}
      <ScrollView style={styles.body}>
        {groups.map((group) => (
          <View key={group.status}>
            <Text style={styles.sectionLabel}>{`${group.status} · ${group.rows.length}`}</Text>
            {group.rows.map((row) => (
              <AgentRow
                key={row.key}
                agent={row.agent}
                meta={`${row.remote.name} / ${row.workspaceLabel}`}
                trailing={agentPaneHandle(row.agent)}
                emphasis={row.agent.agent_status === 'blocked'}
                onPress={() => router.push(row.href)}
              />
            ))}
          </View>
        ))}
        {status === 'ready' && groups.length === 0 ? (
          <Text style={styles.meta}>No agents on any node.</Text>
        ) : null}
      </ScrollView>
      <BottomNav active="agents" onSelect={(tab) => (tab === 'nodes' ? router.push('/nodes') : undefined)} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: mono.ink },
  appbar: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 16, paddingTop: 24 },
  logo: { color: mono.fg, fontSize: 20, fontWeight: '700' },
  crumb: { color: mono.dim, fontSize: 13, marginLeft: 6 },
  meta: { color: mono.dim, fontSize: 12, paddingHorizontal: 16 },
  summary: { color: mono.fgSoft, fontSize: 12, paddingHorizontal: 16, paddingTop: 4 },
  sectionLabel: {
    color: mono.dim,
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingTop: 14,
    paddingBottom: 2
  },
  body: { flex: 1, paddingHorizontal: 8 },
  spacer: { flex: 1 }
})
