// Not from orca (orca's `agent-row-display.test.ts` tests the staleness decay and the time-ago
// thresholds, neither of which has a herdr producer — see ./agent-display.ts).
//
// What is worth pinning here is the one rule that came out of herdr's own source rather than out of
// orca: the server's `state_labels` override beats any word this app might hard-code.
import { describe, expect, it } from 'vitest'
import { agentIdentityLabel, agentPaneHandle, agentStateLabel, hasCustomStateLabel } from './agent-display'
import { mockAgents } from '../api/mock/mock-fixture'

describe('state label', () => {
  it('prefers the server override for the current status', () => {
    // src/ui/sidebar.rs:2268-2272 — herdr's own sidebar reads state_labels[status] first.
    expect(
      agentStateLabel({
        agent_status: 'blocked',
        state_labels: { blocked: 'waiting for approval', working: 'building' }
      })
    ).toBe('waiting for approval')
  })

  it('ignores an override that belongs to a different status', () => {
    expect(
      agentStateLabel({ agent_status: 'working', state_labels: { blocked: 'waiting' } })
    ).toBe('working')
  })

  it('falls back to the bare status word, which is what the server prints too', () => {
    // src/ui/status.rs:221-229 returns the status name itself as the default label.
    expect(agentStateLabel({ agent_status: 'working' })).toBe('working')
    expect(agentStateLabel({ agent_status: 'blocked', state_labels: {} })).toBe('blocked')
    expect(agentStateLabel({ agent_status: 'done', state_labels: { done: '   ' } })).toBe('done')
    expect(hasCustomStateLabel({ agent_status: 'done', state_labels: { done: '  ' } })).toBe(false)
  })
})

describe('identity label', () => {
  it('walks the fallback chain and never returns blank', () => {
    expect(agentIdentityLabel({ agent_status: 'idle', name: 'claude', agent: 'x' })).toBe('claude')
    expect(agentIdentityLabel({ agent_status: 'idle', name: null, display_agent: 'codex' })).toBe('codex')
    expect(agentIdentityLabel({ agent_status: 'idle', name: '  ', agent: 'gemini' })).toBe('gemini')
    expect(agentIdentityLabel({ agent_status: 'idle', manual_label: '1-2' })).toBe('1-2')
    expect(agentIdentityLabel({ agent_status: 'idle', terminal_title_stripped: 'zsh' })).toBe('zsh')
    expect(agentIdentityLabel({ agent_status: 'idle' })).toBe('pane')
  })
})

describe('pane handle', () => {
  it('uses the manual rename, else the id', () => {
    expect(agentPaneHandle({ manual_label: '1-2', pane_id: 'ws-1-p2' })).toBe('1-2')
    expect(agentPaneHandle({ manual_label: null, pane_id: 'ws-1-p2' })).toBe('ws-1-p2')
  })
})

describe('over the mock', () => {
  it('gives every blocked agent a state label the user can read', () => {
    const blocked = mockAgents().filter((agent) => agent.agent_status === 'blocked')
    expect(blocked.length).toBeGreaterThan(0)
    for (const agent of blocked) {
      expect(agentStateLabel(agent)).not.toBe('blocked')
      expect(hasCustomStateLabel(agent)).toBe(true)
    }
  })
})
