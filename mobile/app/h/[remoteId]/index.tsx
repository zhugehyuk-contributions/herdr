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
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AgentStateDot } from '../../../src/components/AgentStateDot'
import { StateBadge } from '../../../src/components/StateBadge'
import { WorkspaceListRow } from '../../../src/components/WorkspaceListRow'
import { useRemote, useRemoteSnapshot, remoteSubtitle } from '../../../src/api/snapshot-context'
import {
  agentPaneHandle,
  agentIdentityLabel,
  paneActivityLabel,
  agentStateLabel
} from '../../../src/agents/agent-display'
import { paneHref } from '../../../src/agents/fleet-agents'
import {
  groupPanesByTab,
  positionalPaneHandle,
  rollupText,
  tabLabelsFrom
} from '../../../src/panes/pane-tree'
import { safeChromePadding } from '../../../src/layout/safe-area-chrome'
import { typography } from '../../../src/theme/herdr-typography'
import { mono } from '../../../src/theme/monotone'

// This screen has no appbar — its header is the remote's name — so its floor is the 16 it was
// drawn with, not the list screens' 24. Under §D1 that 16 was *less* than the Android status bar
// too: this title has been clipped on both platforms, not only on iOS.
const HEADER_TOP_PADDING = 16
import type { PaneInfo } from '../../../src/api/herdr-api-types'

function paneActivity(pane: PaneInfo): string | null {
  return paneActivityLabel({
    agent_status: pane.agent_status,
    state_labels: pane.state_labels,
    display_agent: pane.display_agent,
    agent: pane.agent,
    title: pane.title,
    terminal_title_stripped: pane.terminal_title_stripped
  })
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
  const insets = useSafeAreaInsets()

  return (
    <View
      style={[styles.screen, { paddingTop: safeChromePadding(insets.top, HEADER_TOP_PADDING) }]}
    >
      <View style={styles.header}>
        {/* .prd/11 누락 #10 — see the pane screen's copy. Hidden in the embedded master-detail
            pane, where the node list is already on screen beside it. */}
        {embedded ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="back to nodes"
            onPress={() => router.push('/nodes')}
            style={styles.back}
          >
            <Text style={styles.backLabel}>‹ nodes</Text>
          </Pressable>
        )}
        <Text style={styles.title}>{remote ? remote.name : (remoteId ?? 'Remote')}</Text>
        <View style={styles.spacer} />
        {remote ? <Text style={styles.meta}>{remoteSubtitle(remote)}</Text> : null}
        {embedded && onHideSidebar ? (
          <Pressable accessibilityRole="button" onPress={onHideSidebar}>
            <Text style={styles.meta}>hide</Text>
          </Pressable>
        ) : null}
      </View>
      {/* The only screen whose scroll content reaches the window's bottom edge — there is no bar
          below it to take the inset, so the list itself has to end above the home indicator. */}
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom }}>
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
                ? groupPanesByTab(panes, tabLabels).map((group, tabIndex) => (
                    <View key={group.tabId}>
                      <Text style={styles.tabLabel}>{group.label}</Text>
                      {group.panes.map((pane, paneIndex) => (
                        <Pressable
                          key={pane.pane_id}
                          accessibilityRole="button"
                          accessibilityLabel={`${positionalPaneHandle(tabIndex, paneIndex)} ${paneTitle(pane)}`}
                          onPress={() => router.push(paneHref(remoteId ?? '', pane.pane_id))}
                          style={[
                            styles.paneRowOuter,
                            // `.rowcard.alert` (:148): the blocked row is the only one the mockup
                            // lifts off the background. A band rather than a border because these
                            // rows have no card chrome to thicken.
                            pane.agent_status === 'blocked' && styles.paneRowAlert
                          ]}
                        >
                          <View style={styles.paneRow}>
                            <Text style={styles.paneHandle}>
                              {positionalPaneHandle(tabIndex, paneIndex)}
                            </Text>
                            <AgentStateDot state={pane.agent_status} />
                            <Text style={styles.paneTitle} numberOfLines={1}>
                              {paneTitle(pane)}
                            </Text>
                            <View style={styles.spacer} />
                            {/* .prd/11 누락 #14 — the mockup inverts exactly this one word
                                (`assets/mockup.html:538`). Every other state keeps the dim text it
                                had: the state word is not deleted for them, because `state_labels`
                                lets a server say something more specific than the bare status and
                                dropping it to match the mockup's quieter rows would lose that. */}
                            {pane.agent_status === 'blocked' ? (
                              <StateBadge
                                label={agentStateLabel({
                                  agent_status: pane.agent_status,
                                  state_labels: pane.state_labels
                                })}
                              />
                            ) : (
                              <Text style={styles.paneState}>
                                {agentStateLabel({
                                  agent_status: pane.agent_status,
                                  state_labels: pane.state_labels
                                })}
                              </Text>
                            )}
                            <Text style={styles.chevron}>›</Text>
                          </View>
                          {/* .prd/11 누락 #13 — the mockup's `└ …` line. Without it this list is
                              names and one state word, so choosing which pane to open means
                              opening them one at a time. Rendered only when it says something the
                              row above does not (`paneActivityLabel` returns null otherwise). */}
                          {paneActivity(pane) ? (
                            <Text style={styles.paneActivity} numberOfLines={1}>
                              {`└ ${paneActivity(pane)}`}
                            </Text>
                          ) : null}
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
  // No `paddingTop`: it is the inset's, above.
  screen: { flex: 1, backgroundColor: mono.ink },
  header: { flexDirection: 'row', alignItems: 'center', paddingBottom: 8, paddingHorizontal: 16 },
  title: { color: mono.fg, fontSize: 18, fontFamily: typography.monoFamilyBold },
  meta: { color: mono.dim, fontSize: 12, marginLeft: 8, fontFamily: typography.monoFamily },
  tabLabel: {
    color: mono.dim2,
    fontSize: 10,
    fontWeight: '700',
    paddingTop: 8,
    paddingLeft: 40,
    paddingBottom: 2,
    fontFamily: typography.monoFamily
  },
  paneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingLeft: 40,
    paddingRight: 16
  },
  paneHandle: { color: mono.dim, fontSize: 11, minWidth: 24, fontFamily: typography.monoFamily },
  paneTitle: { color: mono.fgSoft, fontSize: 13, flexShrink: 1, fontFamily: typography.monoFamily },
  paneRowOuter: { paddingVertical: 2 },
  paneRowAlert: { backgroundColor: mono.ink2 },
  // Hangs *inside* the row, just right of the handle column, the way the mockup's `└` does.
  //
  // `.prd/11` N4 twice: the first attempt read the 1차 measurement ("x≈48, outside the row") and
  // *reduced* the padding, which moved it further left — the 2차 QA measured the connector at
  // x=25 device px against a row whose text starts at x=108. The row's own `paddingLeft` is 40 and
  // the handle column is `minWidth: 24` with a 6px gap, so 46 is the first column boundary inside
  // it. A sibling of the row `View` does not inherit that padding, which is what made both
  // attempts guesses instead of arithmetic.
  paneActivity: {
    color: mono.dim,
    fontSize: 12,
    paddingLeft: 46,
    paddingBottom: 4,
    fontFamily: typography.monoFamily
  },
  paneState: { color: mono.dim, fontSize: 11, fontFamily: typography.monoFamily },
  chevron: { color: mono.dim2, fontSize: 13, fontFamily: typography.monoFamily },
  spacer: { flex: 1 },
  back: { paddingRight: 6 },
  backLabel: { color: mono.fgSoft, fontSize: 13, fontFamily: typography.monoFamily }
})
