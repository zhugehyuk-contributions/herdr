// Not from orca. The adapter between the fixture (`mock-fixture.ts`) and the provider
// (`../snapshot-context.tsx`): it is the *stage-4 stand-in* for the stage-6 loader that will run
// the same four requests over ssh through `packages/herdr-client-ts`.
//
// It goes through `handleMockApiRequest` rather than calling the fixture builders directly, on
// purpose: that way the app consumes the same envelopes the socket serves, so a shape the mock
// server could not have produced cannot reach a screen.
//
// Stage 5 changed one thing: it asks *every* remote, not just one. That is not a mock detail — it
// is the actual call pattern, because herdr's JSON API is per-server (02-architecture.md §2.1: one
// bridge per remote, `remote-api-bridge`). `remote.list` comes from the server the phone reached;
// each remaining remote then answers its own three lists over its own bridge. Here that fan-out is
// modelled by re-asking the same dispatcher with `seed` set to the remote's fleet index, so the
// boxes do not all report an identical tree.
import { handleMockApiRequest } from './mock-api-handlers'
import { DEFAULT_SCENARIO, type MockScenario } from './mock-fixture'
import type {
  AgentInfo,
  PaneInfo,
  RemoteDefinition,
  RemoteSnapshot,
  WorkspaceInfo
} from '../herdr-api-types'
import type { HerdrSnapshot, SnapshotLoader } from '../snapshot-context'

function resultOf(method: string, scenario: MockScenario): Record<string, unknown> {
  const response = handleMockApiRequest({ id: `mock-${method}`, method }, scenario)
  if ('error' in response) {
    throw new Error(`mock ${method} failed: ${response.error.message}`)
  }
  return response.result
}

/** The three per-box lists, as one remote's bridge would answer them. */
function snapshotOf(remote: RemoteDefinition, scenario: MockScenario): RemoteSnapshot {
  return {
    remote,
    workspaces: resultOf('workspace.list', scenario)['workspaces'] as WorkspaceInfo[],
    panes: resultOf('pane.list', scenario)['panes'] as PaneInfo[],
    agents: resultOf('agent.list', scenario)['agents'] as AgentInfo[]
  }
}

export function createMockSnapshotLoader(
  scenario: MockScenario = DEFAULT_SCENARIO
): SnapshotLoader {
  return async (): Promise<HerdrSnapshot> => {
    const remotes = resultOf('remote.list', scenario)['remotes'] as RemoteDefinition[]
    const perRemote = remotes
      // Why the fleet index and not the filtered index: a remote's tree must not change shape
      // because some *other* remote was disabled.
      .map((remote, index) => ({ remote, index }))
      .filter(({ remote }) => !remote.disabled)
      .map(({ remote, index }) => snapshotOf(remote, { ...scenario, seed: index }))
    return { remotes, perRemote }
  }
}

/** The default dev loader, referenced by `app/_layout.tsx` until stage 6 wires the ssh transport. */
export const loadMockSnapshot: SnapshotLoader = createMockSnapshotLoader()
