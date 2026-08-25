// Not from orca. orca's mobile talked to an Electron desktop over its own RPC envelope
// (`{id, ok, result, _meta}`); herdr's control plane is the newline-delimited JSON API on
// `herdr.sock`, whose shapes are generated from the Rust types and checked in CI as
// `docs/next/api/herdr-api.schema.json` (protocol 20, schema_version 1).
//
// These declarations are a hand transcription of that file, so the transcription is *machine
// checked* against it by `herdr-api-types.schema.test.ts`: every type below names its schema
// `$defs` entry, and the test fails if the required-field set or the enum members drift. Guessing a
// field name here would be caught by that test, not by a device.
//
// Scope: only the four list responses M2 stage 4 needs (`remote.list`, `workspace.list`,
// `pane.list`, `agent.list`) plus the objects they contain. `packages/herdr-client-ts/src/jsonApi.ts`
// deliberately leaves results untyped (`jsonApi.ts:182-189`); this file is the mobile-side view of
// the subset the screens read, not a competing client.

/** `#/schemas/success_response/$defs/AgentStatus` */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

/** `#/schemas/success_response/$defs/RemoteKeybindingsSnapshot` */
export type RemoteKeybindings = 'local' | 'server'

/** `#/schemas/success_response/$defs/RemoteTargetSnapshot` — an externally tagged Rust enum. */
export type RemoteTarget =
  | { type: 'ssh'; target: string; args?: string[] }
  | { type: 'local'; session?: string | null }

/** `#/schemas/success_response/$defs/RemoteDefinitionSnapshot` */
export type RemoteDefinition = {
  id: string
  name: string
  target: RemoteTarget
  session?: string | null
  disabled?: boolean
  auto_update?: boolean
  keybindings?: RemoteKeybindings
}

/** `#/schemas/success_response/$defs/WorkspaceGitInfo` */
export type WorkspaceGitInfo = {
  repo_key: string
  is_linked_worktree: boolean
}

/** `#/schemas/success_response/$defs/WorkspaceWorktreeInfo` */
export type WorkspaceWorktreeInfo = {
  repo_key: string
  repo_name: string
  repo_root: string
  checkout_path: string
  is_linked_worktree: boolean
}

/** `#/schemas/success_response/$defs/WorkspaceInfo` */
export type WorkspaceInfo = {
  workspace_id: string
  number: number
  label: string
  focused: boolean
  pane_count: number
  tab_count: number
  active_tab_id: string
  agent_status: AgentStatus
  branch?: string | null
  git?: WorkspaceGitInfo | null
  worktree?: WorkspaceWorktreeInfo | null
  tokens?: Record<string, string>
}

/** `#/schemas/success_response/$defs/AgentSessionRefKind` */
export type AgentSessionRefKind = 'id' | 'path'

/** `#/schemas/success_response/$defs/AgentSessionInfo` */
export type AgentSessionInfo = {
  source: string
  agent: string
  kind: AgentSessionRefKind
  value: string
}

/** `#/schemas/success_response/$defs/PaneScrollInfo` */
export type PaneScrollInfo = {
  offset_from_bottom: number
  max_offset_from_bottom: number
  viewport_rows: number
}

/** `#/schemas/success_response/$defs/PaneInfo` */
export type PaneInfo = {
  pane_id: string
  terminal_id: string
  workspace_id: string
  tab_id: string
  focused: boolean
  agent_status: AgentStatus
  revision: number
  agent?: string | null
  display_agent?: string | null
  agent_session?: AgentSessionInfo | null
  cwd?: string | null
  foreground_cwd?: string | null
  label?: string | null
  title?: string | null
  terminal_title?: string | null
  terminal_title_stripped?: string | null
  scroll?: PaneScrollInfo | null
  state_labels?: Record<string, string>
  tokens?: Record<string, string>
  /**
   * The pane's last N lines of recent output, oldest first — **only** when the request asked for
   * it with {@link PaneListParams.recent_lines}; absent on every other producer of a `PaneInfo`
   * (`src/api/schema/panes.rs`, `PaneInfo::recent`). Read from the same source `pane.read
   * {source: recent}` reads, so the batch field and the per-pane read cannot disagree.
   */
  recent?: string[] | null
}

/**
 * `#/schemas/success_response/$defs/AgentInfo`
 *
 * Not a subtype of {@link PaneInfo} even though it overlaps: `agent.list` is the flat cross-tree
 * roll-up the Agents home is built on, and it is the only place `tab_label` / `manual_label` exist
 * (herdr-mx #58, added so a client can group panes into tabs without a second round trip).
 */
export type AgentInfo = {
  pane_id: string
  terminal_id: string
  workspace_id: string
  tab_id: string
  focused: boolean
  agent_status: AgentStatus
  revision: number
  agent?: string | null
  display_agent?: string | null
  agent_session?: AgentSessionInfo | null
  name?: string | null
  manual_label?: string | null
  tab_label?: string | null
  title?: string | null
  terminal_title?: string | null
  terminal_title_stripped?: string | null
  cwd?: string | null
  foreground_cwd?: string | null
  interactive_ready?: boolean
  launch_pending?: boolean
  screen_detection_skipped?: boolean
  state_change_seq?: number
  state_labels?: Record<string, string>
  tokens?: Record<string, string>
}

/** `remote.list` result — `#/schemas/success_response/$defs/ResponseResult` variant `remote_list`. */
export type RemoteListResult = { type: 'remote_list'; remotes: RemoteDefinition[] }

/** `workspace.list` result. */
export type WorkspaceListResult = { type: 'workspace_list'; workspaces: WorkspaceInfo[] }

/**
 * `pane.list` params — `#/schemas/request/$defs/PaneListParams`.
 *
 * `recent_lines` is opt-in and counts terminal ROWS the way `pane.read`'s `lines` does, so a pane
 * whose cursor rests on a blank row spends one of them on that blank row: ask for a couple more
 * rows than you intend to render. Clamped server-side (`PANE_LIST_MAX_RECENT_LINES` = 80).
 */
export type PaneListParams = {
  workspace_id?: string | null
  recent_lines?: number | null
}

/** `pane.list` result. Params: {@link PaneListParams}. */
export type PaneListResult = { type: 'pane_list'; panes: PaneInfo[] }

/** `agent.list` result. Params: none (`EmptyParams`). */
export type AgentListResult = { type: 'agent_list'; agents: AgentInfo[] }

/** `remote.set_keybindings` method name, in one place so a caller cannot misspell it. */
export const REMOTE_SET_KEYBINDINGS = 'remote.set_keybindings'

/**
 * `remote.set_keybindings` params — `#/schemas/request/$defs/RemoteSetKeybindingsParams`.
 *
 * The only mutating request the phone sends over this API, and mockup #7's whole wire
 * (`src/app/api/remotes.rs`, `handle_remote_set_keybindings`). `remote_id` is resolved against the
 * **answering server's** registry (`remote.list` returns `state.remote_registry.remotes` verbatim),
 * so a remote that server does not manage comes back as `remote_not_found` rather than silently
 * doing nothing — which is why the settings screen renders the answer instead of assuming one.
 */
export type RemoteSetKeybindingsParams = {
  remote_id: string
  keybindings: RemoteKeybindings
}

/**
 * What `remote.set_keybindings` answers with — the same body `remote.set_enabled` and
 * `remote.set_auto_update` use, carrying the updated definition and nothing else.
 *
 * Shared rather than a variant per setter: the server reuses `ResponseResult::RemoteEnabledChanged`
 * for all three (`src/app/api/remotes.rs`), and inventing a second name here would make a client
 * branch on a discriminator the wire never sends.
 */
export type RemoteEnabledChangedResult = {
  type: 'remote_enabled_changed'
  remote: RemoteDefinition
}

/**
 * What one remote answers with. herdr's JSON API is per-server, so the phone asks every configured
 * remote and the app stitches; `remotes` is what the *first* server knows about (its own
 * `remote.list`), which is how the phone learns the fleet.
 */
export type RemoteSnapshot = {
  remote: RemoteDefinition
  workspaces: WorkspaceInfo[]
  panes: PaneInfo[]
  agents: AgentInfo[]
}
