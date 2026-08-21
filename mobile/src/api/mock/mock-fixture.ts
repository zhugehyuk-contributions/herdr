// Rewritten for herdr; the orca original (mobile/scripts/mobile-lag-scenario.ts @ 4fd93ead, MIT /
// Lovecast Inc.) is the shape but not the content — see mobile/THIRD_PARTY_NOTICES.md.
//
// What is orca's: the *shape* of a mock scenario — a small set of numeric knobs, deterministic
// index arithmetic (`index % n`) so a given knob set always produces the same tree, and no
// randomness anywhere (`createMockRepos`/`createMockWorktrees`, mobile-lag-scenario.ts:18-90).
// What is herdr's: every field, because the payloads are herdr's JSON API objects
// (`../herdr-api-types.ts`, transcribed from docs/next/api/herdr-api.schema.json) and orca's are
// `RuntimeWorktreePsSummary` from its desktop-shared directory.
//
// Why it lives under `src/` and not `scripts/` as in orca: the port map's P1 boundary is "폰·서버
// 없이 재현" (§3 P1), and orca's own rule is that if the phone-less reproduction fails you do not
// touch the UI. That is only enforceable if this code is on the test path — and vitest.config.ts
// (copied from orca) collects `src/**` only. `scripts/mock-server.ts` is the socket shell over it.

import type {
  AgentInfo,
  AgentStatus,
  PaneInfo,
  RemoteDefinition,
  WorkspaceInfo
} from '../herdr-api-types'

export type MockScenario = {
  /** Entries in `remote.list`. The first is the server answering (a `local` target). */
  remoteCount: number
  /** Workspaces the answering server reports from `workspace.list`. */
  workspaceCount: number
  /** Panes per workspace, spread over `ceil(panesPerWorkspace / 2)` tabs. */
  panesPerWorkspace: number
}

export const DEFAULT_SCENARIO: MockScenario = {
  remoteCount: 5,
  workspaceCount: 4,
  panesPerWorkspace: 3
}

// Names from the mockup's remote list (mobile/.prd/assets/mockup.html:399-416) so a screenshot of
// the mock and a screenshot of the mockup are comparable at a glance.
const REMOTE_NAMES = ['fable-m5max', 'iq-64', 'work-m16', 'blade-4090', 'jump'] as const
const SSH_TARGETS: Record<string, string> = {
  'iq-64': 'z@iq-64',
  'work-m16': 'z@macmini',
  'blade-4090': 'z@blade-4090',
  jump: 'z@jump'
}
const WORKSPACE_LABELS = ['herdr', 'zbrain', 'gtimeline', 'llmux', 'palladium', 'autopoe'] as const
const AGENT_NAMES = ['claude', 'codex', 'build', 'shell', 'tail'] as const

/** Deterministic status wheel: index 0 blocked, so every fixture has the state the app exists for. */
const STATUS_WHEEL: AgentStatus[] = ['blocked', 'working', 'done', 'idle', 'working', 'unknown']

function statusAt(index: number): AgentStatus {
  return STATUS_WHEEL[index % STATUS_WHEEL.length]!
}

/** `remote.list` — the fleet as the answering server knows it. Index 0 is the server itself. */
export function mockRemotes(scenario: MockScenario = DEFAULT_SCENARIO): RemoteDefinition[] {
  return Array.from({ length: scenario.remoteCount }, (_, index) => {
    const base = REMOTE_NAMES[index % REMOTE_NAMES.length]!
    const name = index < REMOTE_NAMES.length ? base : `${base}-${Math.floor(index / REMOTE_NAMES.length) + 1}`
    const sshTarget = SSH_TARGETS[base]
    return {
      id: `remote-${index + 1}`,
      name,
      target:
        index === 0 || !sshTarget
          ? { type: 'local' as const, session: null }
          : { type: 'ssh' as const, target: sshTarget, args: [] },
      session: null,
      // The mockup's last row is a disabled remote ("jump · disabled", mockup.html:416).
      disabled: name === 'jump',
      auto_update: false,
      keybindings: 'local' as const
    }
  })
}

/** `workspace.list`. `agent_status` is the roll-up the server computes over the workspace's panes. */
export function mockWorkspaces(scenario: MockScenario = DEFAULT_SCENARIO): WorkspaceInfo[] {
  const panes = mockPanes(scenario)
  return Array.from({ length: scenario.workspaceCount }, (_, index) => {
    const label = WORKSPACE_LABELS[index % WORKSPACE_LABELS.length]!
    const workspaceId = `ws-${index + 1}`
    const own = panes.filter((pane) => pane.workspace_id === workspaceId)
    const tabIds = [...new Set(own.map((pane) => pane.tab_id))]
    return {
      workspace_id: workspaceId,
      number: index + 1,
      label,
      focused: index === 0,
      pane_count: own.length,
      tab_count: tabIds.length,
      active_tab_id: tabIds[0] ?? `${workspaceId}-tab-1`,
      agent_status: rollUp(own.map((pane) => pane.agent_status)),
      branch: index % 3 === 0 ? 'main' : `feat/mobile-${index + 1}`,
      git: { repo_key: `repo-${label}`, is_linked_worktree: index % 3 !== 0 },
      worktree:
        index % 3 === 0
          ? null
          : {
              repo_key: `repo-${label}`,
              repo_name: label,
              repo_root: `/Users/z/2lab.ai/${label}`,
              checkout_path: `/Users/z/2lab.ai/${label}/.worktrees/feat-mobile-${index + 1}`,
              is_linked_worktree: true
            }
    }
  })
}

/**
 * The workspace-level roll-up the mockup sorts by: blocked wins outright, then working, then done.
 * Same precedence the Agents home uses ("blocked 최상단 정렬", mockup.html:647).
 */
export function rollUp(statuses: readonly AgentStatus[]): AgentStatus {
  for (const candidate of ['blocked', 'working', 'done'] as const) {
    if (statuses.includes(candidate)) {
      return candidate
    }
  }
  return statuses.length > 0 ? 'idle' : 'idle'
}

/** `pane.list`. Two panes per tab, so `tab_id` is a real grouping and not a 1:1 alias of the pane. */
export function mockPanes(scenario: MockScenario = DEFAULT_SCENARIO): PaneInfo[] {
  const panes: PaneInfo[] = []
  let flat = 0
  for (let ws = 0; ws < scenario.workspaceCount; ws += 1) {
    const workspaceId = `ws-${ws + 1}`
    for (let index = 0; index < scenario.panesPerWorkspace; index += 1) {
      const tabNumber = Math.floor(index / 2) + 1
      const agent = AGENT_NAMES[flat % AGENT_NAMES.length]!
      const status = statusAt(flat)
      panes.push({
        pane_id: `${workspaceId}-p${index + 1}`,
        terminal_id: `term-${workspaceId}-${index + 1}`,
        workspace_id: workspaceId,
        tab_id: `${workspaceId}-tab-${tabNumber}`,
        focused: index === 0,
        agent_status: status,
        revision: 100 + flat,
        agent: status === 'idle' ? null : agent,
        display_agent: status === 'idle' ? null : agent,
        agent_session:
          status === 'idle'
            ? null
            : { source: 'herdr', agent, kind: 'id', value: `sess-${workspaceId}-${index + 1}` },
        cwd: `/Users/z/2lab.ai/${WORKSPACE_LABELS[ws % WORKSPACE_LABELS.length]}`,
        foreground_cwd: null,
        label: `${tabNumber}-${(index % 2) + 1}`,
        title: agent,
        terminal_title: `${agent} — ${workspaceId}`,
        terminal_title_stripped: `${agent} — ${workspaceId}`,
        scroll: { offset_from_bottom: 0, max_offset_from_bottom: 5000, viewport_rows: 44 },
        state_labels: {},
        tokens: {}
      })
      flat += 1
    }
  }
  return panes
}

/**
 * `agent.list` — the flat cross-workspace roll-up the Agents home reads. Derived from
 * {@link mockPanes} rather than authored separately, because on a real server it is the same panes
 * seen from the other end; a fixture where the two disagree would teach the UI a lie.
 * Panes with no agent (`idle`, no session) are omitted, matching "agents" being agents.
 */
export function mockAgents(scenario: MockScenario = DEFAULT_SCENARIO): AgentInfo[] {
  const workspaces = mockWorkspaces(scenario)
  const labelOf = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace.label]))
  return mockPanes(scenario)
    .filter((pane) => pane.agent !== null)
    .map((pane) => ({
      pane_id: pane.pane_id,
      terminal_id: pane.terminal_id,
      workspace_id: pane.workspace_id,
      tab_id: pane.tab_id,
      focused: pane.focused,
      agent_status: pane.agent_status,
      revision: pane.revision,
      agent: pane.agent,
      display_agent: pane.display_agent,
      agent_session: pane.agent_session,
      name: pane.agent,
      manual_label: pane.label,
      tab_label: `${labelOf.get(pane.workspace_id) ?? pane.workspace_id} ${pane.tab_id.slice(-1)}`,
      title: pane.title,
      terminal_title: pane.terminal_title,
      terminal_title_stripped: pane.terminal_title_stripped,
      cwd: pane.cwd,
      foreground_cwd: pane.foreground_cwd,
      interactive_ready: true,
      launch_pending: false,
      screen_detection_skipped: false,
      state_change_seq: pane.revision,
      state_labels: {},
      tokens: {}
    }))
}
