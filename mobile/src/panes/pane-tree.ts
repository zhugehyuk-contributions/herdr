// Not from orca. orca's equivalent lives inside `app/h/[hostId]/session/[worktreeId].tsx` (5,333
// lines) as the tab-chip strip, and the port map forbids taking that file whole (§6 위험 2) and
// schedules the viewer for stage 7. What is needed at stage 5 is only the *grouping*, and grouping
// is a pure function, so it lives here where a test can reach it.
//
// The herdr fact it encodes: `remote ▸ workspace ▸ tab ▸ pane` (01-spec.md) — a tab is a group of
// panes, not a pane. `pane.list` returns a flat array with `tab_id` on each element
// (docs/next/api/herdr-api.schema.json, `PaneInfo`), and the mock keeps two panes per tab
// specifically so a client that aliases one tab per pane fails
// (`../api/mock/mock-api-handlers.test.ts`, "groups panes into tabs rather than aliasing").
//
// The tab's display name comes from `agent.list`, not `pane.list`: `AgentInfo.tab_label` is
// `Tab::display_name()` and the schema says it was added (herdr-mx #58) so "the multi-remote client
// can group panes into tabs" without a second round trip. `PaneInfo` has no such field.
import type { AgentInfo, AgentStatus, PaneInfo } from '../api/herdr-api-types'
import { AGENT_STATUS_ORDER } from '../agents/fleet-agents'

export type PaneTabGroup = {
  tabId: string
  /** `tab 1` plus the server's own tab name when it has one. */
  label: string
  panes: PaneInfo[]
}

/** `tab_id` -> the tab's display name, as `agent.list` reports it. */
export function tabLabelsFrom(agents: readonly AgentInfo[]): Map<string, string> {
  const labels = new Map<string, string>()
  for (const agent of agents) {
    const label = agent.tab_label?.trim()
    if (label && !labels.has(agent.tab_id)) {
      labels.set(agent.tab_id, label)
    }
  }
  return labels
}

/**
 * Groups a workspace's panes into its tabs, in first-appearance order — which is `pane.list` order,
 * i.e. the server's own ordering. Numbering is positional (`tab 1`, `tab 2`) because `tab_id` is an
 * opaque id and the mockup's section header is a number (mockup.html:466).
 */
/**
 * herdr's own short handle for a pane — `1-2` = tab 1, pane 2 (`mockup.html:472`, and the
 * acceptance line `:555`: *"pane id = herdr 표기 그대로 (`1-1`, `1-2` …)"*).
 *
 * Derived from position rather than read off the wire, because the wire has no such field: the
 * pane carries `label` (a manual rename) and `pane_id` (`w1:p3`), neither of which is the notation
 * herdr's own UI prints. The first device UI QA caught what using `label` here costs — a pane
 * renamed `claude` rendered `claude claude`, the handle slot repeating the title slot beside it
 * (`.prd/11-mockup-conformance.md` N1).
 *
 * Both indices are 1-based and both come from the order `groupPanesByTab` already established, so
 * the handle a row shows is the position that row occupies on screen.
 */
export function positionalPaneHandle(tabIndex: number, paneIndex: number): string {
  return `${tabIndex + 1}-${paneIndex + 1}`
}

export function groupPanesByTab(
  panes: readonly PaneInfo[],
  tabLabels?: ReadonlyMap<string, string>
): PaneTabGroup[] {
  const groups: PaneTabGroup[] = []
  const byId = new Map<string, PaneTabGroup>()
  for (const pane of panes) {
    const existing = byId.get(pane.tab_id)
    if (existing) {
      existing.panes.push(pane)
      continue
    }
    const named = tabLabels?.get(pane.tab_id)
    const group: PaneTabGroup = {
      tabId: pane.tab_id,
      label: named ? `tab ${groups.length + 1} · ${named}` : `tab ${groups.length + 1}`,
      panes: [pane]
    }
    byId.set(pane.tab_id, group)
    groups.push(group)
  }
  return groups
}

/**
 * The per-row roll-up the plan asks a workspace row to carry ("행마다 idle/working/blocked 롤업").
 *
 * Every non-zero status is named, in {@link AGENT_STATUS_ORDER}, so `blocked` is always the first
 * word when there is one — the same precedence `rollUp` uses to pick the workspace's single status
 * and the same one the Agents home sorts by. Zero counts are omitted rather than printed as `0
 * blocked`, which reads as a state rather than as an absence.
 */
export function rollupText(panes: readonly PaneInfo[]): string {
  if (panes.length === 0) {
    return 'no panes'
  }
  const counts = new Map<AgentStatus, number>()
  for (const pane of panes) {
    counts.set(pane.agent_status, (counts.get(pane.agent_status) ?? 0) + 1)
  }
  const parts = AGENT_STATUS_ORDER.filter((status) => (counts.get(status) ?? 0) > 0).map(
    (status) => `${counts.get(status)!} ${status}`
  )
  return parts.length > 0 ? parts.join(' · ') : 'no panes'
}
