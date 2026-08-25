// Rewritten for herdr; the orca original (mobile/scripts/mock-server-rpc-handlers.ts @ 4fd93ead,
// MIT / Lovecast Inc.) is the shape but not the content — see mobile/THIRD_PARTY_NOTICES.md.
//
// What is orca's: a dispatcher that is *pure* with respect to the socket — it takes a parsed
// request and a `respond` callback, so the same handlers serve any transport, and per-method delay
// knobs live beside it (`mock-server-rpc-handlers.ts:47-100`). What is herdr's: everything below
// the dispatch, because the envelope is different in kind. orca's is
// `{id, ok, result, error, _meta:{runtimeId}}` over an encrypted WebSocket with an E2EE handshake
// and a device token; herdr's is one newline-delimited JSON line per connection, with no auth field
// on the wire at all (ssh is the authentication — 01-spec.md), shaped by
// `docs/next/api/herdr-api.schema.json` and by `packages/herdr-client-ts/src/jsonApi.ts:31-47`.
//
// This module never touches a socket, so `mock-api-handlers.test.ts` is the whole P1 boundary: if a
// screen shows the wrong thing and this file's tests are green, the defect is in the screen.

import {
  DEFAULT_SCENARIO,
  mockAgents,
  mockPanes,
  mockRemotes,
  mockWorkspaces,
  type MockScenario
} from './mock-fixture'

/** What `ping` reports. `protocol` is the value the schema artefact itself was generated at. */
export const MOCK_PROTOCOL = 20
export const MOCK_SERVER_VERSION = '0.8.0-mx.1-mock'

/** One request line, as `encodeJsonApiRequest` writes it (`jsonApi.ts:105-111`). */
export type MockApiRequest = {
  id?: unknown
  method?: unknown
  params?: unknown
}

/** Mirrors `JsonApiResponse` (`packages/herdr-client-ts/src/jsonApi.ts:31-43`). */
export type MockApiResponse =
  | { id: string; result: { type: string } & Record<string, unknown> }
  | { id: string; error: { code: string; message: string } }

/**
 * Error codes are the server's. `src/api/server.rs:159-172` answers anything `serde_json` cannot
 * deserialize into `Request` with `{"id":"","error":{"code":"invalid_request",…}}` — and because
 * `Method` is an externally tagged enum (`src/api/schema.rs:42-44`), an *unknown method* is exactly
 * such a failure, not a distinct code. `jsonApi.ts:168-180` exempts that `id: ""` from correlation.
 */
export function mockApiError(id: string, code: string, message: string): MockApiResponse {
  return { id, error: { code, message } }
}

function workspaceFilter(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) {
    return null
  }
  const value = (params as Record<string, unknown>)['workspace_id']
  return typeof value === 'string' ? value : null
}

/** `src/app/api/panes.rs:40` — the server clamps `recent_lines` to this, so the mock does too. */
export const MOCK_PANE_LIST_MAX_RECENT_LINES = 80

/** The requested row count, or `null` for the opt-out that every pre-existing caller takes. */
function recentLines(params: unknown): number | null {
  if (typeof params !== 'object' || params === null) {
    return null
  }
  const value = (params as Record<string, unknown>)['recent_lines']
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.trunc(value), MOCK_PANE_LIST_MAX_RECENT_LINES)
    : null
}

/**
 * Dispatches one parsed request. Returns the response envelope; never throws for a *server*-level
 * problem, because on the wire those are values.
 */
export function handleMockApiRequest(
  request: MockApiRequest,
  scenario: MockScenario = DEFAULT_SCENARIO
): MockApiResponse {
  const id = typeof request.id === 'string' ? request.id : ''
  const method = typeof request.method === 'string' ? request.method : ''

  switch (method) {
    case 'remote.list':
      return { id, result: { type: 'remote_list', remotes: mockRemotes(scenario) } }
    case 'workspace.list':
      return { id, result: { type: 'workspace_list', workspaces: mockWorkspaces(scenario) } }
    case 'pane.list': {
      const workspaceId = workspaceFilter(request.params)
      const lines = recentLines(request.params)
      const panes = mockPanes(scenario)
        .filter((pane) => workspaceId === null || pane.workspace_id === workspaceId)
        // `recent` is opt-in on the server (`src/app/api/panes.rs`, `handle_pane_list`): without
        // `recent_lines` no pane is read at all and the field is skipped entirely. A mock that
        // always shipped it would let a screen depend on a field the server withholds.
        // `slice(-0)` is the whole array, so zero rows is spelled out rather than computed.
        .map(({ recent, ...pane }) =>
          lines === null
            ? pane
            : { ...pane, recent: lines === 0 ? [] : (recent ?? []).slice(-lines) }
        )
      return { id, result: { type: 'pane_list', panes } }
    }
    case 'agent.list':
      return { id, result: { type: 'agent_list', agents: mockAgents(scenario) } }
    case 'ping':
      return {
        id,
        result: {
          type: 'pong',
          version: MOCK_SERVER_VERSION,
          protocol: MOCK_PROTOCOL,
          capabilities: null
        }
      }
    default:
      // Faithful to the server: unknown method = the request did not deserialize, so `id` is
      // dropped and the code is `invalid_request`. A mock that invented `unknown_method` here
      // would let a client ship a branch the real server never takes.
      return mockApiError(
        '',
        'invalid_request',
        `invalid request: unknown variant \`${method}\`, method not implemented by the mock`
      )
  }
}

/**
 * One request line in, one response line out — the unit `src/api/server.rs:139-152` implements and
 * `jsonApi.ts` documents as "one request is one connection".
 */
export function handleMockApiLine(line: string, scenario: MockScenario = DEFAULT_SCENARIO): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch (error) {
    return `${JSON.stringify(mockApiError('', 'invalid_request', `invalid request: ${(error as Error).message}`))}\n`
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return `${JSON.stringify(mockApiError('', 'invalid_request', 'invalid request: not an object'))}\n`
  }
  return `${JSON.stringify(handleMockApiRequest(parsed as MockApiRequest, scenario))}\n`
}

/** The four methods the phone needs before a transport exists (port map §5 step 4). */
export const MOCK_API_METHODS = [
  'remote.list',
  'workspace.list',
  'pane.list',
  'agent.list'
] as const
