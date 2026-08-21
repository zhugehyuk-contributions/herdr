// Not from orca (its tab strip lives inside the 5,333-line session screen; see ./pane-tree.ts).
import { describe, expect, it } from 'vitest'
import { groupPanesByTab, rollupText, tabLabelsFrom } from './pane-tree'
import { mockAgents, mockPanes } from '../api/mock/mock-fixture'
import type { AgentInfo, AgentStatus, PaneInfo } from '../api/herdr-api-types'

function pane(paneId: string, tabId: string, status: AgentStatus = 'idle'): PaneInfo {
  return {
    pane_id: paneId,
    terminal_id: `t-${paneId}`,
    workspace_id: 'ws-1',
    tab_id: tabId,
    focused: false,
    agent_status: status,
    revision: 1
  }
}

describe('grouping panes into tabs', () => {
  it('groups by tab_id in first-appearance order and numbers positionally', () => {
    const groups = groupPanesByTab([
      pane('p1', 'tab-a'),
      pane('p2', 'tab-b'),
      pane('p3', 'tab-a')
    ])
    expect(groups.map((group) => group.tabId)).toEqual(['tab-a', 'tab-b'])
    expect(groups.map((group) => group.label)).toEqual(['tab 1', 'tab 2'])
    expect(groups[0]!.panes.map((p) => p.pane_id)).toEqual(['p1', 'p3'])
  })

  it('names a tab from agent.list when the server gave it a name', () => {
    // AgentInfo.tab_label is `Tab::display_name()`, added (herdr-mx #58) precisely so a client can
    // group panes into tabs without a second round trip. PaneInfo has no such field.
    const agents: AgentInfo[] = [
      {
        pane_id: 'p1',
        terminal_id: 't',
        workspace_id: 'ws-1',
        tab_id: 'tab-a',
        focused: false,
        agent_status: 'working',
        revision: 1,
        tab_label: 'agents'
      }
    ]
    const groups = groupPanesByTab([pane('p1', 'tab-a'), pane('p2', 'tab-b')], tabLabelsFrom(agents))
    expect(groups.map((group) => group.label)).toEqual(['tab 1 · agents', 'tab 2'])
  })

  it('does not alias one tab per pane on the real fixture', () => {
    const panes = mockPanes().filter((p) => p.workspace_id === 'ws-1')
    const groups = groupPanesByTab(panes, tabLabelsFrom(mockAgents()))
    expect(panes).toHaveLength(3)
    expect(groups).toHaveLength(2)
  })
})

describe('workspace roll-up', () => {
  it('names every non-zero status, blocked first', () => {
    expect(
      rollupText([
        pane('p1', 't', 'idle'),
        pane('p2', 't', 'working'),
        pane('p3', 't', 'blocked'),
        pane('p4', 't', 'working')
      ])
    ).toBe('1 blocked · 2 working · 1 idle')
  })

  it('omits zero counts rather than printing "0 blocked"', () => {
    expect(rollupText([pane('p1', 't', 'idle')])).toBe('1 idle')
  })

  it('says so when there is nothing to roll up', () => {
    expect(rollupText([])).toBe('no panes')
  })
})
