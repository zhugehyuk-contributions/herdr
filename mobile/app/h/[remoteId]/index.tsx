// Not from orca as a file, but its row *is* orca's: the body below is a list of
// `../../../src/components/WorkspaceListRow`, ported from `WorktreeListRow.tsx` (330 lines,
// graded `port` in the port map §2.5), which in turn nests the ported `AgentList` / `AgentSummary`
// / `AgentRow`. orca's own `app/h/[hostId]/index.tsx` is 1,719 lines because most of it is the
// new-worktree flow, the repo grouping drawer, the sort/filter sheets and the tasks entry point —
// all `drop` here (no `git.*` in herdr's JSON API, port map §2.2). What remains of that screen once
// those are gone is the list and the roll-up, which is what this is.
//
// The screen is the *workspace and pane* browser, one route, two levels: a workspace row expands in
// place into its panes, grouped by tab. That is deliberate and it is where herdr's tree differs
// from orca's — herdr is `remote ▸ workspace ▸ tab ▸ pane` and orca is host ▸ worktree ▸ session,
// so orca's row navigates straight to a session while herdr's has one more level to show before
// there is anything to open. 01-spec.md folds it the same way: "tab은 pane 그룹이므로 뷰어 안의
// 세그먼트로 평탄화한다" — the tab is a grouping, never a destination. A pane row is the
// destination, and it routes at `/h/{remoteId}/pane/{paneId}`; that route file is stage 7.
//
// Kept from the stage-3 scaffolding, because `app/h/_layout.tsx` depends on it: the named
// `RemoteScreen` export with `embedded` / `onHideSidebar`, imported *twice* by the layout (sidebar
// and detail Stack), plus the default route wrapper that reads the segment itself. That dual use is
// orca's master-detail structure (`app/h/_layout.tsx:14`, `:146-151`).
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { AgentStateDot } from '../../../src/components/AgentStateDot'
import { WorkspaceListRow } from '../../../src/components/WorkspaceListRow'
import { useRemote, useRemoteSnapshot, remoteSubtitle } from '../../../src/api/snapshot-context'
import {
  agentPaneHandle,
  agentIdentityLabel,
  agentStateLabel
} from '../../../src/agents/agent-display'
import { paneHref } from '../../../src/agents/fleet-agents'
import { groupPanesByTab, rollupText, tabLabelsFrom } from '../../../src/panes/pane-tree'
import { mono } from '../../../src/theme/monotone'
import type { PaneInfo } from '../../../src/api/herdr-api-types'

/** The short pane handle herdr shows in its own UI (`1-2`), or the id when never renamed. */
function paneHandle(pane: PaneInfo): string {
  const label = pane.label?.trim()
  return label && label.length > 0 ? label : pane.pane_id
}

function paneTitle(pane: PaneInfo): string {
  return agentIdentityLabel({
    agent_status: pane.agent_status,
    state_labels: pane.state_labels,
    display_agent: pane.display_agent,
    agent: pane.agent,
    title: pane.title,
    terminal_title_stripped: pane.terminal_title_stripped
  })
}

export function RemoteScreen({
  remoteId,
  embedded,
  onHideSidebar
}: {
  remoteId?: string
  embedded?: boolean
  onHideSidebar?: () => void
}) {
  const router = useRouter()
  const remote = useRemote(remoteId)
  const entry = useRemoteSnapshot(remoteId)
  // Which workspace rows are expanded into their panes. Keyed by workspace id, which is unique
  // within this remote — this screen never spans remotes, unlike the Agents home.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const tabLabels = tabLabelsFrom(entry?.agents ?? [])

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
        {(entry?.workspaces ?? []).map((workspace) => {
          const panes = (entry?.panes ?? []).filter(
            (pane) => pane.workspace_id === workspace.workspace_id
          )
          const agents = (entry?.agents ?? []).filter(
            (agent) => agent.workspace_id === workspace.workspace_id
          )
          const isOpen = expanded[workspace.workspace_id] === true
          return (
            <View key={workspace.workspace_id}>
              <WorkspaceListRow
                workspace={workspace}
                agents={agents}
                rollup={rollupText(panes)}
                paneHandleOf={agentPaneHandle}
                expanded={isOpen}
                onPress={() =>
                  setExpanded((current) => ({
                    ...current,
                    [workspace.workspace_id]: !isOpen
                  }))
                }
              />
              {isOpen
                ? groupPanesByTab(panes, tabLabels).map((group) => (
                    <View key={group.tabId}>
                      <Text style={styles.tabLabel}>{group.label}</Text>
                      {group.panes.map((pane) => (
                        <Pressable
                          key={pane.pane_id}
                          accessibilityRole="button"
                          accessibilityLabel={`${paneHandle(pane)} ${paneTitle(pane)}`}
                          onPress={() => router.push(paneHref(remoteId ?? '', pane.pane_id))}
                          style={styles.paneRow}
                        >
                          <Text style={styles.paneHandle}>{paneHandle(pane)}</Text>
                          <AgentStateDot state={pane.agent_status} />
                          <Text style={styles.paneTitle} numberOfLines={1}>
                            {paneTitle(pane)}
                          </Text>
                          <View style={styles.spacer} />
                          <Text style={styles.paneState}>
                            {agentStateLabel({
                              agent_status: pane.agent_status,
                              state_labels: pane.state_labels
                            })}
                          </Text>
                          <Text style={styles.chevron}>›</Text>
                        </Pressable>
                      ))}
                    </View>
                  ))
                : null}
            </View>
          )
        })}
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
  screen: { flex: 1, backgroundColor: mono.ink, paddingTop: 16 },
  header: { flexDirection: 'row', alignItems: 'center', paddingBottom: 8, paddingHorizontal: 16 },
  title: { color: mono.fg, fontSize: 18, fontWeight: '700' },
  meta: { color: mono.dim, fontSize: 12, marginLeft: 8 },
  tabLabel: {
    color: mono.dim2,
    fontSize: 10,
    fontWeight: '700',
    paddingTop: 8,
    paddingLeft: 40,
    paddingBottom: 2
  },
  paneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingLeft: 40,
    paddingRight: 16
  },
  paneHandle: { color: mono.dim, fontSize: 11, minWidth: 24 },
  paneTitle: { color: mono.fgSoft, fontSize: 13, flexShrink: 1 },
  paneState: { color: mono.dim, fontSize: 11 },
  chevron: { color: mono.dim2, fontSize: 13 },
  spacer: { flex: 1 }
})
