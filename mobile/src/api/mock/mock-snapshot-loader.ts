// Not from orca. The adapter between the fixture (`mock-fixture.ts`) and the provider
// (`../snapshot-context.tsx`): it is the *stage-4 stand-in* for the stage-6 loader that will run
// the same four requests over ssh through `packages/herdr-client-ts`.
//
// It goes through `handleMockApiRequest` rather than calling the fixture builders directly, on
// purpose: that way the app consumes the same envelopes the socket serves, so a shape the mock
// server could not have produced cannot reach a screen.
import { handleMockApiRequest } from './mock-api-handlers'
import { DEFAULT_SCENARIO, type MockScenario } from './mock-fixture'
import type { AgentInfo, PaneInfo, RemoteDefinition, WorkspaceInfo } from '../herdr-api-types'
import type { HerdrSnapshot, SnapshotLoader } from '../snapshot-context'

function resultOf(method: string, scenario: MockScenario): Record<string, unknown> {
  const response = handleMockApiRequest({ id: `mock-${method}`, method }, scenario)
  if ('error' in response) {
    throw new Error(`mock ${method} failed: ${response.error.message}`)
  }
  return response.result
}

export function createMockSnapshotLoader(
  scenario: MockScenario = DEFAULT_SCENARIO
): SnapshotLoader {
  return async (): Promise<HerdrSnapshot> => ({
    remotes: resultOf('remote.list', scenario)['remotes'] as RemoteDefinition[],
    workspaces: resultOf('workspace.list', scenario)['workspaces'] as WorkspaceInfo[],
    panes: resultOf('pane.list', scenario)['panes'] as PaneInfo[],
    agents: resultOf('agent.list', scenario)['agents'] as AgentInfo[]
  })
}

/** The default dev loader, referenced by `app/_layout.tsx` until stage 6 wires the ssh transport. */
export const loadMockSnapshot: SnapshotLoader = createMockSnapshotLoader()
