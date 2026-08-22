// Not from orca. orca's `active-session-tab.test.ts` covers the selection rule (that file is copied
// verbatim next to this one); what has no orca counterpart is the *flattening*, because orca's
// composite key is `${tabId}::${leafId}` and herdr's is `${tab_id}::${pane_id}`.
import { describe, expect, it } from 'vitest'
import { buildPaneChips, paneChipId, resolveActivePaneChip } from './pane-chips'
import type { AgentInfo, PaneInfo } from '../api/herdr-api-types'

function pane(overrides: Partial<PaneInfo> & Pick<PaneInfo, 'pane_id' | 'tab_id'>): PaneInfo {
  return {
    terminal_id: `term-${overrides.pane_id}`,
    workspace_id: 'ws-1',
    focused: false,
    agent_status: 'idle',
    revision: 0,
    ...overrides
  }
}

const PANES: PaneInfo[] = [
  pane({ pane_id: 'ws-1-p1', tab_id: 'ws-1-t1', label: '1-1', agent_status: 'blocked' }),
  pane({ pane_id: 'ws-1-p2', tab_id: 'ws-1-t1', label: '1-2', focused: true }),
  pane({ pane_id: 'ws-1-p3', tab_id: 'ws-1-t2', agent_status: 'working' })
]

const AGENTS: AgentInfo[] = [
  {
    pane_id: 'ws-1-p3',
    terminal_id: 'term-ws-1-p3',
    workspace_id: 'ws-1',
    tab_id: 'ws-1-t2',
    focused: false,
    agent_status: 'working',
    revision: 0,
    tab_label: 'build'
  }
]

describe('pane chips', () => {
  it('flattens tabs into one strip, keeping the tab as a label and not as a destination', () => {
    const chips = buildPaneChips(PANES, AGENTS)
    expect(chips.map((chip) => chip.paneId)).toEqual(['ws-1-p1', 'ws-1-p2', 'ws-1-p3'])
    expect(chips.map((chip) => chip.tabLabel)).toEqual(['tab 1', 'tab 1', 'tab 2 · build'])
    // The handle is herdr's own short form, falling back to the id when a pane was never named.
    expect(chips.map((chip) => chip.handle)).toEqual(['1-1', '1-2', 'ws-1-p3'])
    expect(chips[0]!.status).toBe('blocked')
  })

  it('keys a chip by tab AND pane, the composite orca uses for the same reason', () => {
    expect(paneChipId({ pane_id: 'ws-1-p1', tab_id: 'ws-1-t1' })).toBe('ws-1-t1::ws-1-p1')
    expect(new Set(buildPaneChips(PANES).map((chip) => chip.id)).size).toBe(3)
  })

  it('lets the routed pane win over the pane the server has focused', () => {
    const chips = buildPaneChips(PANES, AGENTS)
    // ws-1-p2 is `focused: true` — the desktop is looking at it. The phone was routed to p3.
    const resolved = resolveActivePaneChip(chips, 'ws-1-p3')
    expect(resolved.activeTab?.paneId).toBe('ws-1-p3')
    expect(resolved.selectionSource).toBe('selected-tab')
  })

  it('falls back to the server focus when the routed pane is gone, then to the first chip', () => {
    const chips = buildPaneChips(PANES, AGENTS)
    expect(resolveActivePaneChip(chips, 'ws-1-p404').activeTab?.paneId).toBe('ws-1-p2')
    const unfocused = buildPaneChips(PANES.map((entry) => ({ ...entry, focused: false })))
    expect(resolveActivePaneChip(unfocused, null).activeTab?.paneId).toBe('ws-1-p1')
  })

  it('has no chip at all for a workspace with no panes', () => {
    expect(buildPaneChips([])).toEqual([])
    expect(resolveActivePaneChip([], 'ws-1-p1').activeTab).toBeNull()
  })
})
