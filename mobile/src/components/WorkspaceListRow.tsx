// Ported from orca mobile/src/components/WorktreeListRow.tsx
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Kept from orca, because this is the layout that makes a list of repositories readable on a phone
// and it is not obvious:
//  · Three-column row — fixed-width indicator gutter (`indicatorCol`, width 20, `paddingTop` so the
//    dot aligns with the first text line, not the row centre), flexible main column, fixed trailing
//    count. Rows stay aligned as statuses change.
//  · `borderLeftWidth: 2` with a *transparent* colour on the inactive row, so the focused row's
//    accent bar does not shift the text by two points when it appears.
//  · `alignItems: 'flex-start'` — the row grows downwards as the inline agent list expands.
//  · `displayBranch` stripping `refs/heads/`, byte-identical to orca.
//  · The inline agent list, and orca's rule about it: only agents get a secondary activity line.
//  · `memo` with the `as typeof …Component` cast that keeps the generic parameter through `memo`.
//
// Changed:
//  · **`AgentSpinner` -> `AgentStateDot`.** orca's spinner is hued by design (its comment says the
//    palette is 1:1 with the desktop `StatusIndicator`); herdr's mockup fixes a monotone ramp with
//    emphasis by inversion (../theme/monotone.ts) and `src/theme/monotone-discipline.test.tsx`
//    enforces it on exactly these surfaces. Using `AgentSpinner` here would put `#eab308` on the
//    main list. Its vocabulary maps 1:1 anyway: herdr's `WorkspaceInfo.agent_status` is already the
//    workspace roll-up the server computed.
//  · **PR / issue / Linear / GitLab badges, `WorktreeMetaGlyphs`, `MobileRepoIcon`, `unread`,
//    lineage (`lineageDepth`/`lineageChildCount`/`onToggleLineage`), `isReadOnly`, long-press +
//    `triggerMediumImpact` — all dropped.** Every one of them is fed by an orca RPC herdr's JSON
//    API does not have (`git.*` is `drop`, port map §2.2) or by orca-only client state. What
//    replaces the lineage toggle is a *pane* toggle, in the same position and with the same
//    stop-propagation behaviour, because the herdr thing a workspace row expands into is its panes.
//  · **`repo` / `displayName` -> `WorkspaceInfo`.** herdr's row is a workspace: `label` is the name,
//    the repo comes from `worktree.repo_name` or `git.repo_key`, and the `Folder` badge becomes a
//    `worktree` badge (the provenance the mockup asks for, mockup.html:497).
import { memo } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { AgentInfo, WorkspaceInfo } from '../api/herdr-api-types'
import { radii, spacing, typography } from '../theme/mobile-theme'
import { mono } from '../theme/monotone'
import { AgentList } from './AgentList'
import { AgentStateDot } from './AgentStateDot'

// Strip the refs/heads/ prefix for display, matching the desktop sidebar
// (WorktreeCardHelpers.formatBranchName).
function displayBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

/** The repo a workspace belongs to, when the server knows one. */
export function workspaceRepoName(workspace: WorkspaceInfo): string | null {
  return workspace.worktree?.repo_name ?? workspace.git?.repo_key ?? null
}

type Props = {
  workspace: WorkspaceInfo
  /** This workspace's agents, for the inline list. Empty means no agent line at all. */
  agents: AgentInfo[]
  /** Roll-up of this workspace's panes, rendered as `n blocked · n working · n idle`. */
  rollup: string
  paneHandleOf?: (agent: AgentInfo) => string
  expanded: boolean
  onPress: (workspace: WorkspaceInfo) => void
}

function WorkspaceListRowComponent({
  workspace,
  agents,
  rollup,
  paneHandleOf,
  expanded,
  onPress
}: Props) {
  // orca's `hideRepo` rule, self-applied: it omits the repo glyph+name when the list is already
  // grouped under that repo, "to avoid the redundant '📁 orca' on every row". herdr has no repo
  // grouping, but it has the same redundancy from the other direction — a workspace is usually
  // named after its repo, so `worktree.repo_name` equals `label` on most rows.
  const repoName = workspaceRepoName(workspace)
  const repo = repoName === workspace.label ? null : repoName
  const branch = workspace.branch ? displayBranch(workspace.branch) : null

  return (
    <Pressable
      style={({ pressed }) => [
        styles.workspaceRow,
        workspace.focused && styles.workspaceRowActive,
        pressed && styles.workspaceRowPressed
      ]}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${workspace.label} — ${rollup}`}
      onPress={() => onPress(workspace)}
    >
      <View style={styles.indicatorCol}>
        <AgentStateDot state={workspace.agent_status} />
      </View>

      <View style={styles.workspaceMain}>
        <View style={styles.workspaceNameRow}>
          <Text style={styles.workspaceName} numberOfLines={1}>
            {workspace.label}
          </Text>
          {workspace.worktree ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>worktree</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.workspaceMetaRow}>
          {repo ? (
            <Text style={styles.repoName} numberOfLines={1}>
              {repo}
            </Text>
          ) : null}
          {branch ? (
            <Text style={styles.branchName} numberOfLines={1}>
              {branch}
            </Text>
          ) : null}
        </View>
        <Text style={styles.rollup}>{rollup}</Text>
        {/* Only agents get a secondary activity line, matching orca and the desktop: a plain
            shell pane's output tail is intentionally not surfaced here. */}
        {agents.length > 0 ? <AgentList agents={agents} paneHandleOf={paneHandleOf} /> : null}
        <View style={styles.paneToggle}>
          {expanded ? (
            <ChevronDown size={12} color={mono.dim} />
          ) : (
            <ChevronRight size={12} color={mono.dim} />
          )}
          <Text style={styles.paneToggleText}>
            {`${workspace.pane_count} panes · ${workspace.tab_count} tabs`}
          </Text>
        </View>
      </View>
    </Pressable>
  )
}

export const WorkspaceListRow = memo(WorkspaceListRowComponent)

const styles = StyleSheet.create({
  workspaceRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.sm + 2,
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg,
    // Reserve the active accent bar width so active/inactive rows align.
    borderLeftWidth: 2,
    borderLeftColor: 'transparent'
  },
  workspaceRowPressed: {
    backgroundColor: mono.ink2
  },
  // Highlight the workspace currently focused on the desktop, mirroring orca's selected-card
  // treatment (raised fill + left accent).
  workspaceRowActive: {
    backgroundColor: mono.ink2,
    borderLeftColor: mono.dim
  },
  indicatorCol: {
    width: 20,
    alignItems: 'center',
    paddingTop: 4,
    marginRight: spacing.sm
  },
  workspaceMain: {
    flex: 1,
    marginRight: spacing.sm
  },
  workspaceNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  workspaceName: {
    fontSize: 14,
    fontWeight: '600',
    color: mono.fg,
    flexShrink: 1,
    fontFamily: typography.monoFamily
  },
  badge: {
    backgroundColor: mono.ink3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4
  },
  badgeText: {
    fontSize: 10,
    color: mono.dim,
    fontFamily: typography.monoFamily
  },
  workspaceMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
    gap: spacing.xs
  },
  repoName: {
    fontSize: 11,
    color: mono.fgSoft,
    maxWidth: 120,
    fontFamily: typography.monoFamily
  },
  branchName: {
    fontSize: 11,
    color: mono.dim,
    fontFamily: typography.monoFamily,
    flexShrink: 1
  },
  rollup: {
    marginTop: 2,
    fontSize: 11,
    color: mono.dim,
    fontFamily: typography.monoFamily
  },
  paneToggle: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: spacing.xs,
    backgroundColor: mono.ink2,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.button
  },
  paneToggleText: {
    fontSize: 11,
    color: mono.fgSoft,
    fontWeight: '600',
    fontFamily: typography.monoFamily
  }
})
