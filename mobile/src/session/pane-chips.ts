// Not from orca as a file, but the model is entirely orca's, and the port map says so in as many
// words (§6 위험 4, the correction to 01-spec.md): herdr's `remote ▸ workspace ▸ tab ▸ pane` is not
// a new design problem, because orca already has a layout leaf under a tab and its mobile client
// **flattens** it — `tabs[]` carries `{id: "tab-1::<uuid>", parentTabId, leafId}`
// (`mobile/src/session/mobile-session-route-types.ts:14-32`) while the tab layer survives only as a
// grouping. This is that flattening with herdr's ids, and `./active-session-tab.ts` (copied
// verbatim from orca) is the selection rule on top of it.
//
// Two constraints inherited with it, both of which the port map calls out as real rather than
// incidental: one terminal per surface (`mobile-session-route-types.ts:22`) and one *active*
// surface at a time (`active-session-tab.ts:19-60`). herdr's pane viewer takes both — one pane on
// screen, chips to switch — which is why nothing here models a split view.
//
// Why the id is composite when `pane_id` is already unique on a box: it is not unique across boxes
// (`../agents/fleet-agents.ts` had to solve the same thing for the Agents home), and the strip is
// the one place a tab's identity has to survive into the row. `${tab_id}::${pane_id}` is orca's own
// separator.
import type { AgentInfo, AgentStatus, PaneInfo } from '../api/herdr-api-types'
import { groupPanesByTab, tabLabelsFrom, type PaneTabGroup } from '../panes/pane-tree'
import { agentIdentityLabel } from '../agents/agent-display'
import { resolveActiveSessionTab, type ResolveActiveSessionTabResult } from './active-session-tab'

export type PaneChip = {
  /** `${tab_id}::${pane_id}` — orca's composite surface key. */
  id: string
  paneId: string
  tabId: string
  /** The short handle herdr shows in its own UI (`1-2`), or the id when the pane was never named. */
  handle: string
  /** The tab this pane belongs to, as the strip labels it (`tab 1`, `tab 2 · build`). */
  tabLabel: string
  /**
   * Who is in the pane — the strip's second line (`.prd/11` N3, mockup chip `1-1 claude`).
   *
   * The strip used to render {@link tabLabel} there, which repeats the section header the chips
   * already sit under and is long enough that a third chip clipped off screen. `tabLabel` stays on
   * the record because the accessibility label still names the tab, which is what a screen reader
   * needs and a sighted user reads from the header instead.
   */
  agentLabel: string
  status: AgentStatus
  /**
   * The *server's* opinion of which pane is current (`PaneInfo.focused`), not the phone's. It feeds
   * `resolveActiveSessionTab` as the snapshot's candidate, exactly where orca's `isActive` does.
   */
  isActive: boolean
}

export function paneChipId(pane: Pick<PaneInfo, 'pane_id' | 'tab_id'>): string {
  return `${pane.tab_id}::${pane.pane_id}`
}

/** The short handle herdr shows in its own UI (`1-2`), or the id when never renamed. */
export function paneChipHandle(pane: PaneInfo): string {
  const label = pane.label?.trim()
  return label && label.length > 0 ? label : pane.pane_id
}

/**
 * Every pane of one workspace, flattened into strip order: `pane.list` order within a tab, tabs in
 * first-appearance order. `groupPanesByTab` (stage 5) already owns both orderings and the tab
 * labels, so the strip and the browser list cannot disagree about what a tab is called.
 */
export function buildPaneChips(
  panes: readonly PaneInfo[],
  agents: readonly AgentInfo[] = []
): PaneChip[] {
  const labels = tabLabelsFrom(agents)
  return groupPanesByTab(panes, labels).flatMap((group: PaneTabGroup) =>
    group.panes.map((pane) => ({
      id: paneChipId(pane),
      paneId: pane.pane_id,
      tabId: pane.tab_id,
      handle: paneChipHandle(pane),
      tabLabel: group.label,
      agentLabel: agentIdentityLabel({
        agent_status: pane.agent_status,
        state_labels: pane.state_labels,
        display_agent: pane.display_agent,
        agent: pane.agent,
        title: pane.title,
        terminal_title_stripped: pane.terminal_title_stripped
      }),
      status: pane.agent_status,
      isActive: pane.focused
    }))
  )
}

/**
 * Which chip the viewer is showing.
 *
 * The route segment is the "selected" id in orca's vocabulary and therefore **wins over the
 * server's focus** (`active-session-tab.ts:58-64`): the user tapped a pane, and the desktop moving
 * its own focus a second later must not yank the phone somewhere else. When the routed pane is not
 * in this workspace's list — a stale deep link, a closed pane — it falls back to the server's
 * focused pane and then to the first chip, which is the same ladder orca walks.
 */
export function resolveActivePaneChip(
  chips: readonly PaneChip[],
  routedPaneId: string | null | undefined
): ResolveActiveSessionTabResult<PaneChip> {
  const routed = routedPaneId
    ? (chips.find((chip) => chip.paneId === routedPaneId)?.id ?? routedPaneId)
    : null
  return resolveActiveSessionTab(chips, {
    // Nothing sets a pending id yet: that slot is for an activation RPC that has been sent and not
    // yet confirmed, and M2 sends none (`app/h/[hostId]/session/[worktreeId].tsx:4122-4131` is the
    // orca call site, and it is `pane.activate`-shaped write traffic — M3 at the earliest).
    pendingActiveSessionTabId: null,
    selectedSessionTabId: routed
  })
}
