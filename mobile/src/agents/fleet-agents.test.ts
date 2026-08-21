// Not from orca — orca has no cross-host agent view to test (see ./fleet-agents.ts).
//
// These are the three ways a cross-remote list silently lies, each pinned:
//   1. `blocked` not first — the one thing 04-milestones.md M2 "됐다" (a) is about.
//   2. Two remotes' `ws-1-p1` collapsing into one row, because `pane_id` is per-server.
//   3. A status this build has never seen ranking above `blocked` by accident.
import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_ORDER,
  buildFleetAgentRows,
  countByStatus,
  groupFleetAgentsByStatus,
  paneHref
} from './fleet-agents'
import { createMockSnapshotLoader } from '../api/mock/mock-snapshot-loader'
import type { AgentInfo, AgentStatus, RemoteDefinition } from '../api/herdr-api-types'
import type { HerdrSnapshot } from '../api/snapshot-context'

function remote(id: string, name: string): RemoteDefinition {
  return { id, name, target: { type: 'local', session: null } }
}

function agent(paneId: string, status: AgentStatus, workspaceId = 'ws-1'): AgentInfo {
  return {
    pane_id: paneId,
    terminal_id: `term-${paneId}`,
    workspace_id: workspaceId,
    tab_id: `${workspaceId}-tab-1`,
    focused: false,
    agent_status: status,
    revision: 1
  }
}

/** Two boxes that both call their first pane `ws-1-p1`, which is what a real fleet looks like. */
function collidingFleet(): HerdrSnapshot {
  const a = remote('remote-1', 'fable-m5max')
  const b = remote('remote-2', 'iq-64')
  return {
    remotes: [a, b],
    perRemote: [
      {
        remote: a,
        workspaces: [
          {
            workspace_id: 'ws-1',
            number: 1,
            label: 'herdr',
            focused: true,
            pane_count: 1,
            tab_count: 1,
            active_tab_id: 'ws-1-tab-1',
            agent_status: 'working'
          }
        ],
        panes: [],
        agents: [agent('ws-1-p1', 'working')]
      },
      {
        remote: b,
        workspaces: [],
        panes: [],
        agents: [agent('ws-1-p1', 'blocked')]
      }
    ]
  }
}

describe('fleet agent rows', () => {
  it('keys and routes by remote + pane, so the same pane id on two boxes is two rows', () => {
    const rows = buildFleetAgentRows(collidingFleet())
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.key)).toEqual(['remote-1:ws-1-p1', 'remote-2:ws-1-p1'])
    expect(rows.map((row) => row.href)).toEqual([
      '/h/remote-1/pane/ws-1-p1',
      '/h/remote-2/pane/ws-1-p1'
    ])
    expect(new Set(rows.map((row) => row.key)).size).toBe(2)
  })

  it('resolves the workspace label from that remote, and falls back to the id when absent', () => {
    const rows = buildFleetAgentRows(collidingFleet())
    // remote-1 lists ws-1 as "herdr"; remote-2 answered `workspace.list` with nothing, so the row
    // says the id rather than borrowing the other box's label.
    expect(rows[0]!.workspaceLabel).toBe('herdr')
    expect(rows[1]!.workspaceLabel).toBe('ws-1')
  })

  it('names the remote on every row — a row that cannot be located cannot be acted on', () => {
    for (const row of buildFleetAgentRows(collidingFleet())) {
      expect(row.remote.name.length).toBeGreaterThan(0)
    }
  })
})

describe('grouping', () => {
  it('puts blocked first, then working, then done', () => {
    const groups = groupFleetAgentsByStatus(
      buildFleetAgentRows({
        remotes: [],
        perRemote: [
          {
            remote: remote('r', 'r'),
            workspaces: [],
            panes: [],
            agents: [
              agent('p1', 'done'),
              agent('p2', 'idle'),
              agent('p3', 'working'),
              agent('p4', 'blocked'),
              agent('p5', 'unknown')
            ]
          }
        ]
      })
    )
    expect(groups.map((group) => group.status)).toEqual([
      'blocked',
      'working',
      'done',
      'unknown',
      'idle'
    ])
  })

  it('drops empty statuses instead of rendering "blocked · 0"', () => {
    const groups = groupFleetAgentsByStatus(buildFleetAgentRows(collidingFleet()))
    expect(groups.map((group) => `${group.status} · ${group.rows.length}`)).toEqual([
      'blocked · 1',
      'working · 1'
    ])
  })

  it('sorts a status this build does not know *after* blocked, never before it', () => {
    // A server newer than the app is the realistic case; ranking an unrecognised status 0 would put
    // it above blocked, which is the one ordering the screen must never get wrong.
    const rows = buildFleetAgentRows({
      remotes: [],
      perRemote: [
        {
          remote: remote('r', 'r'),
          workspaces: [],
          panes: [],
          agents: [
            agent('p1', 'from-the-future' as AgentStatus),
            agent('p2', 'blocked')
          ]
        }
      ]
    })
    expect(groupFleetAgentsByStatus(rows)[0]!.status).toBe('blocked')
  })

  it('keeps remote order inside a status, so the list does not reshuffle between renders', () => {
    const rows = buildFleetAgentRows({
      remotes: [],
      perRemote: [
        { remote: remote('r1', 'a'), workspaces: [], panes: [], agents: [agent('p1', 'working')] },
        { remote: remote('r2', 'b'), workspaces: [], panes: [], agents: [agent('p1', 'working')] }
      ]
    })
    expect(groupFleetAgentsByStatus(rows)[0]!.rows.map((row) => row.remote.id)).toEqual([
      'r1',
      'r2'
    ])
  })
})

describe('against the mock fleet', () => {
  it('unions every dialled remote and finds blocked agents on more than one of them', async () => {
    const snapshot = await createMockSnapshotLoader()()
    const rows = buildFleetAgentRows(snapshot)
    // 5 remotes declared, 1 disabled -> 4 dialled; 10 agents each after idle panes drop out.
    expect(snapshot.remotes).toHaveLength(5)
    expect(snapshot.perRemote).toHaveLength(4)
    expect(rows).toHaveLength(40)
    expect(countByStatus(rows, 'blocked')).toBe(8)
    expect(countByStatus(rows, 'working')).toBe(16)
    const blockedRemotes = new Set(
      rows.filter((row) => row.agent.agent_status === 'blocked').map((row) => row.remote.id)
    )
    expect(blockedRemotes.size).toBeGreaterThan(1)
  })

  it('gives every row a distinct key across the whole fleet', async () => {
    const rows = buildFleetAgentRows(await createMockSnapshotLoader()())
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
    // ...and the underlying pane ids really do collide, so the key is doing work.
    expect(new Set(rows.map((row) => row.agent.pane_id)).size).toBeLessThan(rows.length)
  })
})

describe('shared definitions', () => {
  it('starts the order at blocked — 01-spec.md decision 3', () => {
    expect(AGENT_STATUS_ORDER[0]).toBe('blocked')
    expect(AGENT_STATUS_ORDER.slice(0, 3)).toEqual(['blocked', 'working', 'done'])
  })

  it('has one definition of a pane address, shared by the list and the router', () => {
    expect(paneHref('remote-2', 'ws-1-p1')).toBe('/h/remote-2/pane/ws-1-p1')
  })
})
