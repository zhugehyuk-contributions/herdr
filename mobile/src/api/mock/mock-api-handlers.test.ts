// Not from orca (orca does not test its mock server at all — `scripts/` is outside its vitest
// include, as it is here). These are the envelope-level contracts `packages/herdr-client-ts` will
// hold the real server to, asserted against the mock so the mock cannot drift into a shape the
// client would reject.
import { describe, expect, it } from 'vitest'
import { parseJsonApiResponse, encodeJsonApiRequest } from '@herdr/client-ts'
import { handleMockApiLine, handleMockApiRequest, MOCK_API_METHODS } from './mock-api-handlers'
import { DEFAULT_SCENARIO, mockAgents, mockPanes, mockWorkspaces, rollUp } from './mock-fixture'

describe('mock API dispatcher', () => {
  it.each(MOCK_API_METHODS)('%s answers a result envelope the real client can parse', (method) => {
    const line = handleMockApiLine(encodeJsonApiRequest('ts-7', method).trimEnd())
    expect(line.endsWith('\n')).toBe(true)
    const parsed = parseJsonApiResponse(line.trimEnd())
    expect(parsed.id).toBe('ts-7')
    expect('result' in parsed && parsed.result.type).toBe(method.replace('.', '_'))
  })

  it('echoes the request id, because a mismatch makes the client throw', () => {
    // packages/herdr-client-ts/src/jsonApi.ts:168-180 — a reply that does not echo `id` is a broken
    // wire, not a server error. A mock that got this wrong would look like a transport bug later.
    const response = handleMockApiRequest({ id: 'ts-99', method: 'agent.list' })
    expect(response.id).toBe('ts-99')
  })

  it('answers an unknown method the way the server does: invalid_request with a dropped id', () => {
    // src/api/schema.rs:42-44 tags `Method` externally, so an unknown method never becomes a
    // Request at all — src/api/server.rs:159-172 answers `invalid_request` with `id: ""`.
    const response = handleMockApiRequest({ id: 'ts-1', method: 'git.status' })
    expect(response.id).toBe('')
    expect('error' in response && response.error.code).toBe('invalid_request')
  })

  it('answers an unparseable line with id "" — the one reply the client exempts from correlation', () => {
    const parsed = parseJsonApiResponse(handleMockApiLine('{not json').trimEnd())
    expect(parsed.id).toBe('')
    expect('error' in parsed && parsed.error.code).toBe('invalid_request')
  })

  it('honours a scenario knob rather than hard-coding the tree size', () => {
    const scenario = { remoteCount: 2, workspaceCount: 1, panesPerWorkspace: 5 }
    const response = handleMockApiRequest({ id: 'ts-1', method: 'pane.list' }, scenario)
    expect('result' in response && (response.result['panes'] as unknown[]).length).toBe(5)
  })
})

describe('mock fixture invariants', () => {
  it('always contains a blocked agent — the state the app exists to surface', () => {
    expect(mockAgents().some((agent) => agent.agent_status === 'blocked')).toBe(true)
  })

  it('derives agent.list from pane.list so the two views cannot disagree', () => {
    const panes = new Map(mockPanes().map((pane) => [pane.pane_id, pane]))
    for (const agent of mockAgents()) {
      expect(panes.get(agent.pane_id)?.agent_status).toBe(agent.agent_status)
      expect(panes.get(agent.pane_id)?.workspace_id).toBe(agent.workspace_id)
    }
  })

  it('groups panes into tabs rather than aliasing one tab per pane', () => {
    const panes = mockPanes()
    expect(new Set(panes.map((pane) => pane.tab_id)).size).toBeLessThan(panes.length)
  })

  it('rolls a workspace up to blocked over working over done', () => {
    expect(rollUp(['idle', 'working', 'blocked'])).toBe('blocked')
    expect(rollUp(['done', 'working'])).toBe('working')
    expect(rollUp(['idle', 'done'])).toBe('done')
    expect(rollUp(['idle'])).toBe('idle')
  })

  it('answers as a *different box* when the seed changes, without changing the tree size', () => {
    // herdr's JSON API is per-server: `workspace.list` describes the box you asked. Stage 5's
    // Agents home is the union over every remote, so the fixture has to be able to answer as more
    // than one box — otherwise every remote would report an identical tree and the screen would
    // look right while proving nothing.
    const base = mockWorkspaces()
    const other = mockWorkspaces({ ...DEFAULT_SCENARIO, seed: 1 })
    expect(other).toHaveLength(base.length)
    expect(other.map((workspace) => workspace.label)).not.toEqual(
      base.map((workspace) => workspace.label)
    )
    expect(mockPanes({ ...DEFAULT_SCENARIO, seed: 1 })).toHaveLength(mockPanes().length)
  })

  it('is deterministic: the same scenario always produces the same tree', () => {
    expect(mockPanes({ ...DEFAULT_SCENARIO, seed: 3 })).toEqual(
      mockPanes({ ...DEFAULT_SCENARIO, seed: 3 })
    )
    // ...and an absent seed is seed 0, so every pre-stage-5 caller is unaffected.
    expect(mockPanes()).toEqual(mockPanes({ ...DEFAULT_SCENARIO, seed: 0 }))
  })

  it('only ever keys state_labels by a status the server would accept', () => {
    // `normalize_state_labels` (src/app/api/panes.rs:1676-1681) rejects any key outside the
    // AgentStatus enum, so a fixture with a free-form key would be a payload the server cannot
    // emit — and the phone would learn to read a field that never arrives.
    const allowed = new Set(['idle', 'working', 'blocked', 'done', 'unknown'])
    for (const seed of [0, 1, 2, 3]) {
      for (const pane of mockPanes({ ...DEFAULT_SCENARIO, seed })) {
        for (const [key, value] of Object.entries(pane.state_labels ?? {})) {
          expect(allowed, `state_labels key ${key}`).toContain(key)
          // Only the *current* status may carry a label; a label for another status is dead weight
          // the UI would never show (src/ui/sidebar.rs:2268-2272 looks up exactly one key).
          expect(key).toBe(pane.agent_status)
          expect(value.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('carries the pane state label onto the agent row, as src/app/agents.rs:392 does', () => {
    const panes = new Map(mockPanes().map((pane) => [pane.pane_id, pane]))
    for (const agent of mockAgents()) {
      expect(agent.state_labels).toEqual(panes.get(agent.pane_id)?.state_labels)
    }
  })

  it('reports each workspace pane_count/tab_count consistently with pane.list', () => {
    const panes = mockPanes()
    for (const workspace of mockWorkspaces()) {
      const own = panes.filter((pane) => pane.workspace_id === workspace.workspace_id)
      expect(workspace.pane_count).toBe(own.length)
      expect(workspace.tab_count).toBe(new Set(own.map((pane) => pane.tab_id)).size)
      expect(own.map((pane) => pane.tab_id)).toContain(workspace.active_tab_id)
    }
    expect(panes).toHaveLength(
      DEFAULT_SCENARIO.workspaceCount * DEFAULT_SCENARIO.panesPerWorkspace
    )
  })
})
