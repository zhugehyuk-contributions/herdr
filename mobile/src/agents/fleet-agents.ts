// Not from orca — and this file is the single place where the port deliberately diverges, so the
// reason is here rather than in a commit message.
//
// orca's home screen is the **host catalog** (`app/index.tsx`, 1,362 lines): you pick a host, then
// a worktree, then a session. Agents only ever appear *inside* a worktree row, as
// `WorktreeAgentList` nested in `WorktreeListRow` — there is no screen in orca that shows agents
// from more than one host at a time, and no type that carries "which host is this agent on",
// because in that layout the enclosing screen already answers it.
//
// herdr's decision 3 inverts that: "**Agents 화면 = 홈.** 전 서버 에이전트를 상태순(blocked →
// working → done)으로. 폰에서 사람이 실제로 하는 일은 트리 브라우징이 아니라 '누가 나를 기다리나
// → 그 화면 보고 → y 눌러주기'다" (01-spec.md). A cross-remote, status-ordered list has no orca
// counterpart to port, so it is written here — and the *row* components it renders
// (`../components/AgentList`, `AgentRow`, `AgentSummary`) are still orca's, ported.
//
// The two things this module exists to get right:
//
//  1. **Identity is composite.** `pane_id` / `workspace_id` are unique only within one server, and
//     the mock proves it: `ws-1-p1` exists on every remote. A React key or a route built from
//     `pane_id` alone silently merges two different agents on two different machines. Every key and
//     href below is `remote.id` + pane id.
//  2. **A row that does not say where it is, is unusable.** The whole screen is "who is waiting for
//     me"; answering that with a bare agent name means the user cannot go there. So the row model
//     carries the remote and the workspace label, resolved here (the workspace label lives in
//     `workspace.list`, not in `agent.list`) rather than looked up per render.
import type { AgentInfo, AgentStatus, PaneInfo, RemoteDefinition } from '../api/herdr-api-types'
import { groupPanesByTab, positionalPaneHandle } from '../panes/pane-tree'
import type { HerdrSnapshot } from '../api/snapshot-context'

/**
 * Sort order of the home screen.
 *
 * `blocked → working → done` is fixed by 01-spec.md. `unknown` and `idle` are not mentioned there
 * because the spec names the states that are *worth surfacing*; they still arrive on the wire
 * (`AgentStatus`, docs/next/api/herdr-api.schema.json), so they go after `done` — an agent whose
 * state the server could not determine is more interesting than one that is definitively idle.
 */
export const AGENT_STATUS_ORDER: readonly AgentStatus[] = [
  'blocked',
  'working',
  'done',
  'unknown',
  'idle'
]

const RANK = new Map(AGENT_STATUS_ORDER.map((status, index) => [status, index]))

export type FleetAgentRow = {
  /** `${remote.id}:${pane_id}` — see the note above on why `pane_id` alone is not a key. */
  key: string
  remote: RemoteDefinition
  agent: AgentInfo
  /** From this remote's `workspace.list`; the workspace id when the workspace is not listed. */
  workspaceLabel: string
  /** Where a tap goes. The pane viewer route is stage 7; the href is its address either way. */
  href: string
  /**
   * `1-2` — tab 1, pane 2 *within its workspace*, the short handle herdr shows in its own UI and
   * the one the mockup's agent rows carry (`assets/mockup.html:610`).
   *
   * Computed here rather than read off the agent because the wire has no such field: `manual_label`
   * is a rename, not a position, and using it made this screen print pane *names* (`build`,
   * `nextest`) where the mockup prints positions. The 3차 device QA caught that the pane list and
   * the chip strip had both been repaired and this one screen had not.
   */
  handle: string
}

export type FleetAgentGroup = {
  status: AgentStatus
  rows: FleetAgentRow[]
}

/** Every agent on every dialled remote, flattened, with its remote/workspace context attached. */
export function buildFleetAgentRows(snapshot: HerdrSnapshot): FleetAgentRow[] {
  return snapshot.perRemote.flatMap((entry) => {
    const labels = new Map(
      entry.workspaces.map((workspace) => [workspace.workspace_id, workspace.label])
    )
    const handles = positionalHandles(entry.panes)
    return entry.agents.map((agent) => ({
      key: `${entry.remote.id}:${agent.pane_id}`,
      remote: entry.remote,
      agent,
      workspaceLabel: labels.get(agent.workspace_id) ?? agent.workspace_id,
      href: paneHref(entry.remote.id, agent.pane_id),
      // Falls back to the id when the pane is not in `pane.list` — an agent whose pane vanished
      // between the two calls is a real state, and a handle invented for it would be a lie about
      // where it sits.
      handle: handles.get(agent.pane_id) ?? agent.pane_id
    }))
  })
}

/**
 * `pane_id -> "1-2"`, for one remote.
 *
 * Numbering is per workspace and then per tab, in list order — the same walk
 * `app/h/[remoteId]/index.tsx` does through `groupPanesByTab`, so a pane carries one handle
 * wherever it is shown. Doing it twice with two walks is how the two screens would drift.
 */
function positionalHandles(panes: readonly PaneInfo[]): Map<string, string> {
  const byWorkspace = new Map<string, PaneInfo[]>()
  for (const pane of panes) {
    const list = byWorkspace.get(pane.workspace_id)
    if (list) {
      list.push(pane)
    } else {
      byWorkspace.set(pane.workspace_id, [pane])
    }
  }
  const handles = new Map<string, string>()
  for (const workspacePanes of byWorkspace.values()) {
    for (const [tabIndex, group] of groupPanesByTab(workspacePanes).entries()) {
      for (const [paneIndex, pane] of group.panes.entries()) {
        handles.set(pane.pane_id, positionalPaneHandle(tabIndex, paneIndex))
      }
    }
  }
  return handles
}

/** The address of one pane on one remote. One definition, so the list and the router cannot drift. */
export function paneHref(remoteId: string, paneId: string): string {
  return `/h/${remoteId}/pane/${paneId}`
}

/**
 * Groups into the sections the screen renders, in {@link AGENT_STATUS_ORDER}. Empty statuses are
 * dropped (a `blocked · 0` header is noise); within a section the input order is kept, which is
 * remote order then pane order, because `Array.prototype.sort` is stable.
 */
export function groupFleetAgentsByStatus(rows: readonly FleetAgentRow[]): FleetAgentGroup[] {
  const groups = new Map<AgentStatus, FleetAgentRow[]>()
  for (const row of rows) {
    const bucket = groups.get(row.agent.agent_status)
    if (bucket) {
      bucket.push(row)
    } else {
      groups.set(row.agent.agent_status, [row])
    }
  }
  return [...groups.entries()]
    .map(([status, statusRows]) => ({ status, rows: statusRows }))
    .sort((a, b) => rankOf(a.status) - rankOf(b.status))
}

/**
 * Unknown statuses sort last rather than first. A server newer than the app can send a status this
 * build has never heard of; ranking it 0 would put it above `blocked`, which is the one thing the
 * screen must never do.
 */
function rankOf(status: AgentStatus): number {
  return RANK.get(status) ?? AGENT_STATUS_ORDER.length
}

/** How many agents on the fleet are in this status — the one number the home screen leads with. */
export function countByStatus(rows: readonly FleetAgentRow[], status: AgentStatus): number {
  return rows.filter((row) => row.agent.agent_status === status).length
}
