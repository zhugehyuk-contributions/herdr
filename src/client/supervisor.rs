// This model is being wired into the thin client in vertical slices. Some
// routing and sidebar methods are test-covered before the real client-owned UI
// calls them, so the non-test binary temporarily sees them as unused.
#![cfg_attr(not(test), allow(dead_code))]

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct ServerId(String);

impl ServerId {
    pub(crate) fn main() -> Self {
        Self("main".to_string())
    }

    pub(crate) fn secondary(id: impl Into<String>) -> Self {
        Self(format!("secondary:{}", id.into()))
    }

    /// item 3 (Area 5): the registry `remote_id` for a secondary server (the part after the
    /// `secondary:` prefix); for the main server it is the raw inner string. Used to address the
    /// off-thread `remote.set_enabled`/`remote.remove` request against the registry.
    pub(crate) fn registry_id(&self) -> &str {
        self.0.strip_prefix("secondary:").unwrap_or(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ServerFilter {
    All,
    Server(ServerId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServerRole {
    Main,
    Secondary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ConnectionState {
    Connecting,
    Connected,
    Disconnected,
    ProtocolMismatch {
        server_protocol: Option<u32>,
        client_protocol: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ServerConnectionTarget {
    Main,
    LocalSession(Option<String>),
    /// `destination` is the ssh host (dedup/display key); `options` are the extra ssh flags from a
    /// full add-remote spec (e.g. `-L`, `-J`, `-p`) carried so port-forwards/jump hosts apply.
    /// `session` is the remote-side session this host attaches to (`None` = the remote's default);
    /// it rides the target so every ssh-bridge start reads it from the SAME place the connection
    /// identity lives (`herdr --session <name>` on the far side).
    Ssh {
        destination: String,
        options: Vec<String>,
        session: Option<String>,
    },
}

impl ServerConnectionTarget {
    /// Build the connection target from a whole registry definition, so the definition-level
    /// session reaches the ssh bridge. Replaces the old `From<RemoteTargetSnapshot>`, which only
    /// saw the target and therefore could never carry an `Ssh` remote's session.
    /// [`RemoteDefinitionSnapshot::session_name`] is the single source of truth for BOTH kinds (a
    /// local remote keeps its session in the target, an ssh remote on the definition).
    pub(crate) fn from_definition(
        definition: &crate::remote_registry::RemoteDefinitionSnapshot,
    ) -> Self {
        let session = definition.session_name().map(str::to_string);
        match &definition.target {
            crate::remote_registry::RemoteTargetSnapshot::Local { .. } => {
                Self::LocalSession(session)
            }
            crate::remote_registry::RemoteTargetSnapshot::Ssh { target, args } => Self::Ssh {
                destination: target.clone(),
                options: args.clone(),
                session,
            },
        }
    }

    /// item 3 (Area 5): the short target string shown in the management overlay row.
    pub(crate) fn display_label(&self) -> String {
        match self {
            ServerConnectionTarget::Main => "local".to_string(),
            ServerConnectionTarget::LocalSession(session) => {
                format!("local:{}", session.as_deref().unwrap_or("default"))
            }
            ServerConnectionTarget::Ssh {
                destination,
                session,
                ..
            } => match session {
                Some(session) => format!("{destination} ({session})"),
                None => destination.clone(),
            },
        }
    }

    /// The remote-side session this target attaches to (`None` = the remote's default session).
    /// One accessor for both kinds, so callers never re-derive it per variant.
    pub(crate) fn session(&self) -> Option<&str> {
        match self {
            ServerConnectionTarget::Main => None,
            ServerConnectionTarget::LocalSession(session) => session.as_deref(),
            ServerConnectionTarget::Ssh { session, .. } => session.as_deref(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ServerSummary {
    pub(crate) workspaces: Vec<WorkspaceSummary>,
    pub(crate) agents: Vec<AgentSummary>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct WorkspaceSummary {
    pub(crate) workspace_id: String,
    pub(crate) label: String,
    pub(crate) branch: Option<String>,
    pub(crate) focused: bool,
    // #22: worktree-grouping provenance, mirrored from the wire `WorkspaceInfo.worktree`. The
    // client-rendered sidebar reuses the SERVER's grouping renderer, which only needs the group
    // `key` (members sharing a key form a group) and whether this member is a linked worktree (the
    // non-linked member is the group parent). `None` key = a standalone (ungrouped) workspace.
    pub(crate) worktree_key: Option<String>,
    pub(crate) worktree_is_linked: bool,
    // Worktree-MENU provenance, mirrored from the wire `WorkspaceInfo.git`: set when the checkout
    // is a git repo even WITHOUT worktree-space membership, so the workspace context menu can
    // offer worktree actions on plain git workspaces (server-menu parity). NEVER used for
    // grouping — `worktree_key` stays the only grouping signal.
    pub(crate) git_repo_key: Option<String>,
    pub(crate) git_is_linked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentSummary {
    pub(crate) agent_id: String,
    pub(crate) workspace_id: String,
    pub(crate) label: String,
    pub(crate) status: String,
    pub(crate) focused: bool,
    /// #58: the pane's manual rename (wire `AgentInfo.manual_label`) — the sidebar "pane name". `None`
    /// for an unrenamed pane.
    pub(crate) pane_label: Option<String>,
    /// #58: the id + display name of the tab this pane lives in, so the client can group panes into
    /// tabs and render the sidebar "tab name". `tab_label` is `None` for an older server.
    pub(crate) tab_id: String,
    pub(crate) tab_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedServer {
    pub(crate) id: ServerId,
    pub(crate) display_name: String,
    pub(crate) role: ServerRole,
    pub(crate) target: ServerConnectionTarget,
    pub(crate) keybindings: crate::remote_registry::RemoteKeybindingsSnapshot,
    pub(crate) connection_state: ConnectionState,
    pub(crate) summaries: ServerSummary,
    pub(crate) disabled: bool, // item 3 (serde-driven via registry; default false)
    /// #61: per-remote auto-update flag, synced from the registry (like `disabled`). When set, the
    /// client auto-pushes its own build onto this remote on a detected protocol mismatch.
    pub(crate) auto_update: bool,
    /// Recent round-trip samples (ms) for the host banner readout; capped at the last
    /// [`HOST_PING_SAMPLE_WINDOW`] (issue #13). The banner shows their average.
    pub(crate) ping_samples: std::collections::VecDeque<u32>,
    /// Most recent downstream frame throughput from this host in bytes/sec, if measured.
    pub(crate) download_bps: Option<u64>,
    /// #44: the remote's reported herdr version string (e.g. `0.6.4`), captured over the Ping/Pong
    /// runtime-status path (NOT the handshake Welcome, which carries only the protocol u32). `None`
    /// until the first status fetch lands; shown in the host context menu's version readout row.
    pub(crate) remote_version: Option<String>,
    /// #44: the remote's reported wire protocol version, captured over the same Ping/Pong path. The
    /// host context menu flags a mismatch when this differs from the local `PROTOCOL_VERSION`.
    pub(crate) remote_protocol: Option<u32>,
}

/// How many recent round-trip samples feed the host-banner ping average.
pub(crate) const HOST_PING_SAMPLE_WINDOW: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServerDestination {
    pub(crate) server_id: ServerId,
    pub(crate) display_name: String,
}

/// item 1 (Area 3 / Decision 4): the new-workspace destination picker state. Carries the
/// connected destinations AND the current keyboard/mouse selection so the composited modal
/// can render a highlighted row and arrow-key navigate. Replaces the bare
/// `Option<Vec<ServerDestination>>` field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewWorkspacePickerState {
    pub(crate) destinations: Vec<ServerDestination>,
    pub(crate) selected: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SecondaryConnectionPlan {
    pub(crate) server_id: ServerId,
    pub(crate) display_name: String,
    pub(crate) target: ServerConnectionTarget,
    pub(crate) keybindings: crate::remote_registry::RemoteKeybindingsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SummarySubscriptionPlan {
    pub(crate) server_id: ServerId,
    pub(crate) target: ServerConnectionTarget,
}

/// #47: the one model behind all three client-rendered side menus — the global launcher (the
/// sidebar "menu" button), the workspace right-click context menu, and the host right-click context
/// menu. One render path, one hit-test, one hover resolver, one keyboard handler, one dismiss — so
/// the cross-cutting behavior (renders topmost AND is topmost in the event pipeline, mouse-over
/// highlights, click selects, outside-press dismisses, keyboard up/down/enter/esc) holds for all
/// three by construction instead of being re-implemented (and drifting) per menu. Replaces the three
/// separate `ClientOverlayState` variants (`GlobalMenu` / `WorkspaceContextMenu` / `HostContextMenu`)
/// and their three render/hit-test/keyboard worlds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClientMenu {
    /// Which menu this is + the per-menu context a selected row needs to act on (server / workspace).
    pub(crate) kind: ClientMenuKind,
    /// The panel header title ("menu" / "workspace" / "host").
    pub(crate) title: &'static str,
    /// Optional sub-header under the title — the workspace label / host name. `None` for the global
    /// launcher (which has no target), which also drops the sub-header row from the geometry.
    pub(crate) subheader: Option<String>,
    /// The anchor cell: the right-click cursor for the context menus, the clicked menu-button cell
    /// for the launcher. Both render and hit-test derive the popup rect from this (clamped to screen).
    pub(crate) anchor_col: u16,
    pub(crate) anchor_row: u16,
    /// The highlighted row.
    pub(crate) selected: usize,
    /// The ordered rows, with their labels + per-row selectable flag + action baked at open time
    /// (so a state-dependent label like "disable"/"enable" and its action can never drift apart).
    pub(crate) items: Vec<ClientMenuItem>,
}

/// #47: one row of a [`ClientMenu`]. `selectable` is false for non-actionable rows (the host
/// version readout); such rows still render and can be hovered, but activating one is a no-op and
/// the initial highlight skips them. `action` is resolved at open time so the row order is the only
/// source of truth (no hard-coded index → action mapping that can drift when rows are added).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClientMenuItem {
    pub(crate) label: String,
    pub(crate) selectable: bool,
    pub(crate) action: ClientMenuAction,
}

/// #47: which client menu, plus the context an activated row needs. The launcher carries no target;
/// the context menus carry the server (+ workspace) the action routes to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClientMenuKind {
    GlobalLauncher,
    Workspace {
        server_id: ServerId,
        workspace_id: String,
        label: String,
    },
    Host {
        server_id: ServerId,
    },
}

/// #47: the per-row action, baked at open time. The host rows bake their connection-dependent shape
/// here (e.g. `HostToggleEnabled { enabled }`, or `Noop` for an add-space/update row whose host is
/// disconnected) so [`select_client_menu_item`](ClientSupervisorModel::select_client_menu_item) is a
/// pure lookup. `Noop` rows keep the menu open (matching the old version-readout / disconnected
/// behavior).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClientMenuAction {
    Noop,
    // global launcher
    Settings,
    Keybinds,
    ReloadConfig,
    Detach,
    OpenAddRemote,
    OpenManageRemotes,
    // workspace context menu
    OpenRename,
    OpenConfirmClose,
    // workspace context menu — worktree rows (server-menu parity). Baked from the workspace's
    // summary worktree info at open time, like the host rows bake connection state.
    OpenNewWorktree,
    OpenWorktreePicker,
    OpenConfirmDeleteWorktree,
    /// Toggle the worktree group's collapsed state (client-local, same set the chevron flips).
    /// The label ("expand"/"collapse") is baked from the state captured at open time.
    ToggleWorktreeGroup {
        group_key: String,
    },
    // host context menu
    HostAddSpace,
    HostToggleEnabled {
        enabled: bool,
    },
    HostDisconnect,
    HostReconnect,
    HostUpdate,
    // #61: flip this remote's per-remote auto-update flag (baked from its current state at open time).
    HostToggleAutoUpdate {
        auto_update: bool,
    },
    /// C4: promote the host menu's `session <name>` readout into the session picker. Reached by
    /// Enter, a left-click, OR a right-click on that row (the one row that survives the
    /// right-click-dismisses-the-menu rule, matching the user's literal wording).
    OpenSessionPicker,
}

/// #47: the typed outcome of activating a [`ClientMenu`] row, mapped by the client loop into a
/// `ClientInputDispatch`. The launcher's overlay-opening rows (`add remote` / `manage remotes`) and
/// the workspace rename/close rows open their follow-on overlay inside
/// [`select_client_menu_item`](ClientSupervisorModel::select_client_menu_item) and report `Redraw`;
/// the rest carry the context the loop needs (the menu is already closed by `select`). Merges the
/// old `ClientGlobalMenuAction` / `WorkspaceContextOutcome` / `HostContextOutcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClientMenuOutcome {
    Redraw,
    Settings,
    Keybinds,
    ReloadConfig,
    Detach,
    HostAddSpace(ServerId),
    HostToggleEnabled {
        remote_id: String,
        enabled: bool,
    },
    HostDisconnect(ServerId),
    HostReconnect(ServerId),
    HostUpdate(ServerId),
    // #61: persist this remote's auto-update flag (routed to a `remote.set_auto_update` request).
    HostToggleAutoUpdate {
        remote_id: String,
        auto_update: bool,
    },
    /// The "open worktree…" picker opened in its loading state: the loop must fetch this
    /// workspace's `worktree.list` off the UI thread and fill the picker via
    /// [`ClientSupervisorModel::fill_worktree_picker`].
    FetchWorktreeList {
        server_id: ServerId,
        workspace_id: String,
    },
    /// Flip the worktree group's client-local collapsed state (the compositor owns the set).
    ToggleWorktreeGroup {
        group_key: String,
    },
    /// C4: the session picker opened in its loading state; the loop must fetch this host's
    /// `session.list` off the UI thread (against the OWNING server's api target, which is what
    /// makes it enumerate the REMOTE host's sessions) and fill it via
    /// [`ClientSupervisorModel::fill_session_picker`].
    FetchSessionList {
        server_id: ServerId,
        remote_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AddRemoteField {
    Target,
    Name,
    /// C1: the OPTIONAL remote-side session. Empty = the remote's default session.
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AddRemoteForm {
    pub(crate) target: String,
    pub(crate) name: String,
    /// C1: optional session name; empty means the remote's default session.
    pub(crate) session: String,
    pub(crate) focused_field: AddRemoteField,
    pub(crate) error: Option<String>,
    /// True while the submission worker is connecting/installing/attaching. Rendered as an
    /// animated status line (distinct from `error`) so a slow connect reads as progress, not as a
    /// failure, and never as the old static red "adding remote..." string.
    pub(crate) in_progress: bool,
    /// Latest provisioning stage the worker reported (e.g. "installing herdr on the remote…"), shown
    /// on the in-progress status row in place of the static "connecting to remote…" so seeding a
    /// fresh machine reads as live progress (issue #32). `None` until the first stage arrives.
    pub(crate) progress: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AddRemoteDraft {
    pub(crate) target: String,
    pub(crate) name: Option<String>,
    /// C1: the requested session, or `None` for the remote's default session (an empty/whitespace
    /// field). Validated server-side by `normalize_session`, so the form stays a dumb carrier.
    pub(crate) session: Option<String>,
    pub(crate) keybindings: crate::remote_registry::RemoteKeybindingsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AddRemoteFormOutcome {
    Redraw,
    Submit(AddRemoteDraft),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ClientOverlayState {
    None,
    // #47: the single slot for all three client-rendered side menus (global launcher / workspace
    // context / host context). Collapses the old `GlobalMenu` / `WorkspaceContextMenu` /
    // `HostContextMenu` variants onto one `ClientMenu` — one render/hit-test/hover/keyboard/dismiss.
    Menu(ClientMenu),
    AddRemote(AddRemoteForm),
    ManageRemotes(RemoteManageOverlay), // item 3 (Area 5)
    // #23: the two follow-on overlays a workspace context-menu row promotes into (rename /
    // confirm-close). All client-local; the action routes to the owning server via workspace.* API.
    RenameWorkspace(RenameWorkspaceForm),
    ConfirmCloseWorkspace(ConfirmCloseWorkspace),
    // Worktree-menu parity: the follow-on overlays the worktree context-menu rows promote into.
    // All route to the owning server via worktree.* API requests.
    NewWorktree(NewWorktreeForm),
    ConfirmDeleteWorktree(ConfirmDeleteWorktree),
    WorktreePicker(WorktreePicker),
    // C4/C5/C6: the two follow-on overlays the host menu's `session` row promotes into — the
    // remote's session list, and the free-text "new session" input its last row opens.
    SessionPicker(SessionPicker),
    NewSession(NewSessionForm),
}

/// #23: the inline rename text overlay. Mirrors `AddRemoteForm` (a single editable text field +
/// error line). `label` holds the in-progress edit, prefilled with the workspace's current label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RenameWorkspaceForm {
    pub(crate) server_id: ServerId,
    pub(crate) workspace_id: String,
    pub(crate) label: String,
    pub(crate) error: Option<String>,
}

/// #23: the close-confirmation overlay ("Close <label>?"). Mirrors `RemoteManageOverlay`'s
/// `confirm_delete` sub-state, hoisted to its own overlay since it has no parent list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfirmCloseWorkspace {
    pub(crate) server_id: ServerId,
    pub(crate) workspace_id: String,
    pub(crate) label: String,
}

/// #23: the typed outcome of a key press in the rename overlay. `Submit` carries the
/// `(server_id, workspace_id, label)` the client turns into a `workspace.rename` round-trip.
/// Mirrors `AddRemoteFormOutcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RenameWorkspaceOutcome {
    Redraw,
    Submit {
        server_id: ServerId,
        workspace_id: String,
        label: String,
    },
}

/// #23: the typed outcome of a key press in the close-confirm overlay. `Confirm` carries the
/// `(server_id, workspace_id)` the client turns into a `workspace.close` round-trip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ConfirmCloseOutcome {
    Redraw,
    Confirm {
        server_id: ServerId,
        workspace_id: String,
    },
}

/// Worktree-menu parity: the "new worktree" branch-name input. Mirrors `RenameWorkspaceForm`
/// (one editable text field + error line); submit routes to a `worktree.create` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewWorktreeForm {
    pub(crate) server_id: ServerId,
    pub(crate) workspace_id: String,
    pub(crate) branch: String,
    pub(crate) error: Option<String>,
}

/// Worktree-menu parity: the "delete worktree checkout…" confirmation. Mirrors
/// `ConfirmCloseWorkspace`; confirm routes to a `worktree.remove` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfirmDeleteWorktree {
    pub(crate) server_id: ServerId,
    pub(crate) workspace_id: String,
    pub(crate) label: String,
}

/// Worktree-menu parity: the "open worktree…" picker. Opens in `loading` while the loop fetches
/// `worktree.list` from the owning server off the UI thread, then shows the repo's checkouts;
/// Enter opens the selected one via `worktree.open`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorktreePicker {
    pub(crate) server_id: ServerId,
    pub(crate) workspace_id: String,
    pub(crate) loading: bool,
    pub(crate) error: Option<String>,
    pub(crate) items: Vec<WorktreePickerItem>,
    pub(crate) selected: usize,
}

/// One row of the worktree picker: a checkout path plus its display label (branch or label).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorktreePickerItem {
    pub(crate) path: String,
    pub(crate) label: String,
    /// Already open as a workspace — selecting it focuses instead of re-opening.
    pub(crate) open_workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NewWorktreeOutcome {
    Redraw,
    Submit {
        server_id: ServerId,
        workspace_id: String,
        branch: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ConfirmDeleteWorktreeOutcome {
    Redraw,
    Confirm {
        server_id: ServerId,
        workspace_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WorktreePickerOutcome {
    Redraw,
    Open {
        server_id: ServerId,
        workspace_id: String,
        path: String,
    },
}

/// C4/C5: the remote's session list, promoted from the host menu's `session <name>` row. Opens in
/// `loading` while the loop fetches `session.list` from the OWNING server (so it enumerates THAT
/// host's sessions), then lists them with the current one marked.
///
/// The list ALWAYS carries one extra trailing `new session…` row (see [`Self::row_count`]) — it is
/// NOT part of `items`, so it survives `loading` and the error path. That is what makes C6 reachable
/// on an old remote whose server has no `session.list` method.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionPicker {
    pub(crate) server_id: ServerId,
    /// The registry id the `remote.set_session` mutation addresses (`server_id.registry_id()` at
    /// open time, captured so the picker stays valid if the menu is gone).
    pub(crate) remote_id: String,
    /// The session this host is attached to right now (`None` = its default session).
    pub(crate) current: Option<String>,
    pub(crate) loading: bool,
    pub(crate) error: Option<String>,
    pub(crate) items: Vec<SessionPickerItem>,
    pub(crate) selected: usize,
}

/// One listed session. `name: None` is the remote's default session (the registry stores it as an
/// absent session, so it must round-trip as `None`, not as the literal `"default"`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionPickerItem {
    pub(crate) name: Option<String>,
    pub(crate) label: String,
    pub(crate) running: bool,
    pub(crate) is_current: bool,
}

impl SessionPicker {
    /// Rows the picker renders/hit-tests: every listed session plus the always-present trailing
    /// `new session…` row.
    pub(crate) fn row_count(&self) -> usize {
        self.items.len() + 1
    }

    /// Whether `index` is the trailing `new session…` row.
    pub(crate) fn is_new_session_row(&self, index: usize) -> bool {
        index >= self.items.len()
    }
}

/// C5/C6: the typed outcome of activating a session-picker row. The trailing `new session…` row
/// promotes into the [`NewSessionForm`] inside the model and reports `OpenNewSession` (mirroring how
/// the menu's overlay-opening rows report `Redraw`); every other row carries the session to apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SessionPickerOutcome {
    Redraw,
    OpenNewSession,
    Select {
        server_id: ServerId,
        remote_id: String,
        session: Option<String>,
    },
}

/// C6: the free-text session input the picker's `new session…` row opens. Mirrors
/// `RenameWorkspaceForm` (one editable field + an inline error). An EMPTY submit means the remote's
/// default session; anything else must pass `crate::session::validate_name`, and a rejection keeps
/// the overlay open with the reason inline instead of silently closing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewSessionForm {
    pub(crate) server_id: ServerId,
    pub(crate) remote_id: String,
    pub(crate) name: String,
    pub(crate) error: Option<String>,
    /// True from submit until `remote.set_session` answers. The overlay STAYS OPEN across the
    /// round-trip so a server-side rejection (`duplicate_remote_target`, `invalid_session_name`)
    /// lands back on this form's `error` instead of vanishing with the closed overlay.
    pub(crate) in_flight: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NewSessionOutcome {
    Redraw,
    Submit {
        server_id: ServerId,
        remote_id: String,
        session: Option<String>,
    },
}

/// item 3 (Area 5): remote-management overlay state. Inert in C0; item 3 fills behavior.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteManageOverlay {
    pub selected: usize,
    pub scroll: usize,
    pub confirm_delete: Option<String>, // remote_id
    pub pending: Option<String>,        // in-flight toggle/delete remote_id
}

/// item 6 (Area 6): optimistic focus target. Inert in C0; item 6 sets/clears it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OptimisticFocusTarget {
    Workspace(String),
    Agent(String),
}

/// #39: whether an applied summary AGREES with the optimistic focus target — i.e. the server has
/// visibly applied the focus the client requested, so the optimistic override can retire.
fn summary_confirms_focus_target(summary: &ServerSummary, target: &OptimisticFocusTarget) -> bool {
    match target {
        OptimisticFocusTarget::Workspace(workspace_id) => summary
            .workspaces
            .iter()
            .any(|ws| ws.focused && ws.workspace_id == *workspace_id),
        OptimisticFocusTarget::Agent(agent_id) => summary
            .agents
            .iter()
            .any(|agent| agent.focused && agent.agent_id == *agent_id),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NewWorkspaceRoute {
    CreateOn(ServerId),
    PickDestination(Vec<ServerDestination>),
    Unavailable { server_id: ServerId, reason: String },
}

impl NewWorkspaceRoute {
    pub(crate) fn api_request(
        &self,
        id: impl Into<String>,
    ) -> Option<(ServerId, crate::api::schema::Request)> {
        match self {
            NewWorkspaceRoute::CreateOn(server_id) => Some((
                server_id.clone(),
                crate::api::schema::Request {
                    id: id.into(),
                    method: crate::api::schema::Method::WorkspaceCreate(
                        crate::api::schema::WorkspaceCreateParams {
                            cwd: None,
                            focus: true,
                            label: None,
                            env: std::collections::HashMap::new(),
                        },
                    ),
                },
            )),
            NewWorkspaceRoute::PickDestination(_) | NewWorkspaceRoute::Unavailable { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FocusRoute {
    Workspace {
        server_id: ServerId,
        workspace_id: String,
    },
    Agent {
        server_id: ServerId,
        target: String,
    },
    Unavailable {
        server_id: ServerId,
        reason: String,
    },
    NotFound,
}

impl FocusRoute {
    pub(crate) fn api_request(&self, id: impl Into<String>) -> Option<crate::api::schema::Request> {
        match self {
            FocusRoute::Workspace { workspace_id, .. } => Some(crate::api::schema::Request {
                id: id.into(),
                method: crate::api::schema::Method::WorkspaceFocus(
                    crate::api::schema::WorkspaceTarget {
                        workspace_id: workspace_id.clone(),
                    },
                ),
            }),
            FocusRoute::Agent { target, .. } => Some(crate::api::schema::Request {
                id: id.into(),
                method: crate::api::schema::Method::AgentFocus(crate::api::schema::AgentTarget {
                    target: target.clone(),
                }),
            }),
            FocusRoute::Unavailable { .. } | FocusRoute::NotFound => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceSidebarRow {
    pub(crate) server_id: ServerId,
    pub(crate) workspace_id: Option<String>,
    pub(crate) label: String,
    pub(crate) branch: Option<String>,
    pub(crate) focused: bool,
    pub(crate) disabled: bool,
    pub(crate) is_remote: bool, // item 4: server.role == ServerRole::Secondary
    // #22: worktree-grouping provenance threaded from the wire summary so `from_model` can populate
    // each placeholder workspace's `worktree_space`, letting the SHARED grouping renderer group
    // worktree parents/children. `None` for placeholder/unavailable rows (they never group).
    pub(crate) worktree_key: Option<String>,
    pub(crate) worktree_is_linked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentSidebarRow {
    pub(crate) agent_id: String,
    pub(crate) label: String,
    pub(crate) status: String,
    pub(crate) focused: bool,
    /// #58: the pane's manual rename ("pane name"); `None` for an unrenamed pane.
    pub(crate) pane_label: Option<String>,
    /// #58: id + display name of the tab this pane lives in, so the client groups panes into tabs.
    pub(crate) tab_id: String,
    pub(crate) tab_label: Option<String>,
}

/// item 3 (Area 5): the overlay-state of a remote in the management overlay, analogous to
/// `ConnectionState` but flattened for display. `Disabled` (the gate) wins over the connection
/// state, mirroring `host_banner_state`. The compositor maps this to the ui-owned
/// `RemoteStateGlyph` (the layering rule keeps `client::supervisor` types out of `ui`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteManageState {
    Connected,
    Connecting,
    Disconnected,
    Disabled,
    ProtocolMismatch,
}

impl RemoteManageState {
    /// The short state word rendered in the overlay row.
    pub(crate) fn state_word(self) -> &'static str {
        match self {
            RemoteManageState::Connected => "connected",
            RemoteManageState::Connecting => "connecting",
            RemoteManageState::Disconnected => "offline",
            RemoteManageState::Disabled => "disabled",
            RemoteManageState::ProtocolMismatch => "protocol mismatch",
        }
    }
}

/// item 3 (Area 5): a pure view row for the remote-management overlay, one per `Secondary` host.
/// `remote_id` is the registry id (NOT the supervisor `ServerId`) so the off-thread
/// `remote.set_enabled`/`remote.remove` request targets the registry directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteManageRow {
    pub(crate) remote_id: String,
    pub(crate) name: String,
    pub(crate) target: String,
    pub(crate) enabled: bool,
    pub(crate) state: RemoteManageState,
}

/// item 3 (Area 5): the typed outcome of a key press in the management overlay. The client loop
/// consumes it and spawns the off-thread main-server API request (toggle / delete).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RemoteManageOutcome {
    Redraw,
    OpenAddRemote,
    SetEnabled { remote_id: String, enabled: bool },
    Delete { remote_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentSidebarGroup {
    pub(crate) server_id: ServerId,
    pub(crate) workspace_id: String,
    pub(crate) label: String,
    pub(crate) focused: bool,
    pub(crate) agents: Vec<AgentSidebarRow>,
}

pub(crate) struct ClientSupervisorModel {
    servers: Vec<ManagedServer>,
    filter: ServerFilter,
    active_server_id: ServerId,
    ui_settings: crate::api::schema::UiSettingsInfo,
    new_workspace_picker: Option<NewWorkspacePickerState>, // item 1 (was new_workspace_picker_destinations)
    client_overlay: ClientOverlayState,
    // #47: the ONE drag offset (cols, rows) shared by EVERY client overlay (the three menus +
    // add-remote / manage-remotes / new-workspace picker / rename / confirm-close). Reset to (0, 0)
    // whenever any overlay opens or closes, so a dragged overlay never carries its offset to the
    // next. Render, hit-test, and the content-exclusion rect all shift the open overlay's default
    // popup by this (clamped on-screen). Dragging the popup's top border accumulates here.
    overlay_drag_offset: (i16, i16),
    optimistic_focus: Option<(ServerId, OptimisticFocusTarget)>, // item 6 (always None in C0)
    /// #39: how many applied summaries have DISAGREED with the live optimistic focus. A summary
    /// fetched before the focus request landed server-side must not clobber the optimistic
    /// highlight (the click-then-snap-back flicker); but a focus that silently never lands must
    /// not pin the highlight forever either. Confirming summaries retire the override
    /// immediately; after `OPTIMISTIC_FOCUS_MAX_STALE_APPLIES` disagreeing applies, summary truth
    /// wins. Counter-based (not wall-clock) because the model holds no clock.
    optimistic_focus_stale_applies: u8,
    /// #44: per-host live provisioning progress LOG, keyed by `ServerId` so the banner sub-lines
    /// target the right host. Fed one stage line at a time by `set_update_progress` from BOTH the
    /// update worker and the add/reconnect provisioning worker; cleared when the operation finishes.
    /// The full stage history renders as multiple sub-lines (tail-capped) under the banner, so a
    /// slow install shows what already happened instead of a single mutating line.
    update_progress: std::collections::HashMap<ServerId, Vec<String>>,
    /// #61: per-host TERMINAL update outcome (✓ success / ✗ failure) shown on the banner sub-line
    /// once an update finishes, so completion is observable rather than inferred from the spinner
    /// vanishing. Set by `set_update_outcome`; the client loop expires it on a timer (the model holds
    /// no clock). Threaded into `host_banner_specs` and takes precedence over `update_progress`.
    update_outcomes: std::collections::HashMap<ServerId, crate::app::state::HostUpdateOutcome>,
}

const SUPERVISOR_API_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// #39: disagreeing summary applies tolerated before the optimistic focus yields to summary
/// truth. At the active remote's 400ms poll cadence this bounds a silently-lost focus request's
/// stale highlight to ~1.2s, while comfortably outlasting the one or two in-flight pre-focus
/// summaries that used to snap the highlight back on every click.
const OPTIMISTIC_FOCUS_MAX_STALE_APPLIES: u8 = 3;

pub(crate) trait SupervisorApi {
    fn request(
        &mut self,
        request: crate::api::schema::Request,
    ) -> Result<crate::api::schema::SuccessResponse, String>;
}

impl SupervisorApi for crate::api::client::ApiClient {
    fn request(
        &mut self,
        request: crate::api::schema::Request,
    ) -> Result<crate::api::schema::SuccessResponse, String> {
        let value = self
            .request_value_with_timeout(&request, SUPERVISOR_API_TIMEOUT)
            .map_err(|err| err.to_string())?;
        crate::api::client::parse_response_value(value).map_err(|err| err.to_string())
    }
}

pub(crate) fn bootstrap_from_main_api(
    api: &mut impl SupervisorApi,
    main_display_name: impl Into<String>,
) -> Result<ClientSupervisorModel, String> {
    let mut model = ClientSupervisorModel::new(main_display_name);
    // A missing/older-server `remote.list` MUST NOT abort the whole supervisor bootstrap: a hard
    // failure here silently drops the client into the server's pass-through sidebar, which has no
    // "add remote"/"manage remotes" affordances — leaving no way to add a first remote. Degrade to
    // an empty registry (the client still owns the sidebar + remote menu), mirroring the UI-settings
    // fallback below. This is the common case while developing: a newer client attaches to an older
    // server that doesn't yet know the `remote.list` method.
    match request_remote_list(api) {
        Ok(remotes) => model.sync_remote_registry(remotes),
        Err(err) => tracing::warn!(
            err = %err,
            "failed to fetch remote registry from main server (older/mismatched server?); \
             continuing with no remotes so the client sidebar and add/manage-remote menu stay available"
        ),
    }
    let summary = request_server_summary(api)?;
    model
        .set_summary(&ServerId::main(), summary)
        .map_err(|()| "main server is missing from supervisor model".to_string())?;
    match request_ui_settings(api) {
        Ok(ui_settings) => model.set_ui_settings(ui_settings),
        Err(err) => tracing::warn!(
            err = %err,
            "failed to fetch main server UI settings; using defaults"
        ),
    }
    Ok(model)
}

impl ClientSupervisorModel {
    pub(crate) fn new(main_display_name: impl Into<String>) -> Self {
        Self {
            servers: vec![ManagedServer {
                id: ServerId::main(),
                display_name: main_display_name.into(),
                role: ServerRole::Main,
                target: ServerConnectionTarget::Main,
                keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Server,
                connection_state: ConnectionState::Connected,
                summaries: ServerSummary::default(),
                disabled: false,
                auto_update: false,
                ping_samples: std::collections::VecDeque::new(),
                download_bps: None,
                remote_version: None,
                remote_protocol: None,
            }],
            filter: ServerFilter::All,
            active_server_id: ServerId::main(),
            ui_settings: crate::api::schema::UiSettingsInfo::default(),
            new_workspace_picker: None,
            client_overlay: ClientOverlayState::None,
            overlay_drag_offset: (0, 0),
            optimistic_focus: None,
            optimistic_focus_stale_applies: 0,
            update_progress: std::collections::HashMap::new(),
            update_outcomes: std::collections::HashMap::new(),
        }
    }

    /// #44: append a live provisioning progress line for `id` (`Some(message)`) or clear the whole
    /// log (`None`, on finish/teardown). Consecutive duplicate stages collapse so a re-reported
    /// stage doesn't spam the log. Mirrors `set_server_download_bps` in spirit but keyed in a side
    /// map (the banner sub-lines are render-only, not tied to the `ManagedServer`'s persisted state).
    pub(crate) fn set_update_progress(&mut self, id: &ServerId, message: Option<String>) {
        match message {
            Some(message) => {
                let log = self.update_progress.entry(id.clone()).or_default();
                if log.last() != Some(&message) {
                    log.push(message);
                }
            }
            None => {
                self.update_progress.remove(id);
            }
        }
    }

    /// #44: the latest live provisioning progress line for `id`, if an operation is in flight.
    pub(crate) fn update_progress_for(&self, id: &ServerId) -> Option<&str> {
        self.update_progress
            .get(id)
            .and_then(|log| log.last())
            .map(String::as_str)
    }

    /// #61: set the TERMINAL update outcome banner sub-line for `id` (a positive "✓ updated …" on
    /// success, or "✗ update failed …" on failure). Shown in place of the in-flight progress; the
    /// client loop expires it on a timer via [`Self::clear_update_outcome`].
    pub(crate) fn set_update_outcome(
        &mut self,
        id: &ServerId,
        outcome: crate::app::state::HostUpdateOutcome,
    ) {
        self.update_outcomes.insert(id.clone(), outcome);
    }

    /// #61: clear `id`'s terminal update outcome (the loop's timer-driven expiry, or a teardown).
    pub(crate) fn clear_update_outcome(&mut self, id: &ServerId) {
        self.update_outcomes.remove(id);
    }

    /// #61: the current terminal update outcome for `id`, if one is being shown.
    pub(crate) fn update_outcome_for(
        &self,
        id: &ServerId,
    ) -> Option<&crate::app::state::HostUpdateOutcome> {
        self.update_outcomes.get(id)
    }

    /// #61: if `id` is currently showing a SUCCESS outcome, fold the freshly-installed `version` into
    /// its message ("✓ updated to vX.Y.Z"). Called when the post-update reconnect/refetch delivers
    /// the new version; gated on a live success outcome so a routine runtime-status fetch for a host
    /// that was never updated can never pop a toast. Returns whether it changed anything (so the loop
    /// can re-arm the display timer to show the enriched line for its full window).
    pub(crate) fn enrich_update_success_with_version(
        &mut self,
        id: &ServerId,
        version: &str,
    ) -> bool {
        match self.update_outcomes.get_mut(id) {
            Some(outcome) if outcome.success => {
                let enriched = format!("✓ updated to v{version}");
                if outcome.message == enriched {
                    return false;
                }
                outcome.message = enriched;
                true
            }
            _ => false,
        }
    }

    pub(crate) fn ui_settings(&self) -> &crate::api::schema::UiSettingsInfo {
        &self.ui_settings
    }

    pub(crate) fn set_ui_settings(&mut self, ui_settings: crate::api::schema::UiSettingsInfo) {
        self.ui_settings = ui_settings;
    }

    pub(crate) fn activate_main_server(&mut self) {
        self.close_new_workspace_picker();
        self.active_server_id = ServerId::main();
    }

    pub(crate) fn add_secondary(
        &mut self,
        definition: crate::remote_registry::RemoteDefinitionSnapshot,
    ) -> ServerId {
        self.add_secondary_with_state(definition, ConnectionState::Connected)
    }

    /// Add a freshly-registered secondary in an explicit connection state. The non-modal
    /// add-remote flow inserts the host row as `Connecting` BEFORE any provisioning happens,
    /// so the sidebar shows the host (with live progress sub-lines) while the retry sweep
    /// brings the bridge up.
    pub(crate) fn add_secondary_with_state(
        &mut self,
        definition: crate::remote_registry::RemoteDefinitionSnapshot,
        connection_state: ConnectionState,
    ) -> ServerId {
        let id = ServerId::secondary(definition.id.clone());
        self.servers
            .push(managed_secondary(definition, connection_state));
        id
    }

    pub(crate) fn sync_remote_registry(
        &mut self,
        remotes: Vec<crate::remote_registry::RemoteDefinitionSnapshot>,
    ) {
        // #40: capture the current client-local host ordering BEFORE the rebuild so a user's
        // host drag-reorder survives this registry-driven sync. Secondaries are re-sorted by their
        // prior position below; genuinely-new remotes (absent from this map) sort last in the
        // registry's own order. Without this, the secondaries were pushed in registry iteration
        // order and a drag-reorder snapped back on the next poll.
        let prior_secondary_order: std::collections::HashMap<ServerId, usize> = self
            .servers
            .iter()
            .filter(|server| server.role == ServerRole::Secondary)
            .enumerate()
            .map(|(idx, server)| (server.id.clone(), idx))
            .collect();

        let mut next_servers: Vec<ManagedServer> = self
            .servers
            .iter()
            .filter(|server| server.role == ServerRole::Main)
            .cloned()
            .collect();

        let mut next_secondaries: Vec<ManagedServer> = Vec::new();
        for definition in remotes {
            let id = ServerId::secondary(definition.id.clone());
            let existing = self
                .servers
                .iter()
                .find(|server| server.id == id && server.role == ServerRole::Secondary)
                .cloned();
            let mut server = existing.unwrap_or_else(|| {
                managed_secondary(definition.clone(), ConnectionState::Connecting)
            });
            server.display_name = definition.name.clone();
            server.target = ServerConnectionTarget::from_definition(&definition);
            server.keybindings = definition.keybindings;
            // item 3 (Area 5): re-apply the gate input on every sync (like display_name/target/
            // keybindings). NOTE: connection_state is intentionally NOT re-applied here, so a
            // re-enabled remote keeps its prior state — the toggle-success handler explicitly
            // sets it to `Connecting` so the now-ungated plans pick it back up.
            server.disabled = definition.disabled;
            // #61: re-apply the auto-update flag on every sync too (like `disabled`), so toggling it
            // server-side reflects on the client by the next registry refresh.
            server.auto_update = definition.auto_update;
            next_secondaries.push(server);
        }

        // #40: stable-sort the rebuilt secondaries back into the client-local order. `sort_by_key`
        // is stable, so genuinely-new remotes (`usize::MAX`) retain their registry order at the end.
        next_secondaries.sort_by_key(|server| {
            prior_secondary_order
                .get(&server.id)
                .copied()
                .unwrap_or(usize::MAX)
        });
        next_servers.extend(next_secondaries);

        self.servers = next_servers;
        self.reconcile_selected_servers();
        self.reconcile_new_workspace_picker();
    }

    pub(crate) fn filter(&self) -> &ServerFilter {
        &self.filter
    }

    pub(crate) fn set_filter(&mut self, filter: ServerFilter) {
        self.close_new_workspace_picker();
        self.filter = match filter {
            ServerFilter::All => ServerFilter::All,
            ServerFilter::Server(id) if self.server(&id).is_some() => ServerFilter::Server(id),
            ServerFilter::Server(_) => ServerFilter::All,
        };
    }

    pub(crate) fn filter_label(&self) -> String {
        match &self.filter {
            ServerFilter::All => "all".to_string(),
            ServerFilter::Server(id) => self
                .server(id)
                .map(|server| server.display_name.clone())
                .unwrap_or_else(|| "all".to_string()),
        }
    }

    pub(crate) fn cycle_filter(&mut self) {
        self.close_new_workspace_picker();
        let order: Vec<ServerId> = self
            .servers
            .iter()
            .map(|server| server.id.clone())
            .collect();
        self.filter = match &self.filter {
            ServerFilter::All => order
                .first()
                .cloned()
                .map(ServerFilter::Server)
                .unwrap_or(ServerFilter::All),
            ServerFilter::Server(current) => order
                .iter()
                .position(|id| id == current)
                .and_then(|idx| order.get(idx + 1))
                .cloned()
                .map(ServerFilter::Server)
                .unwrap_or(ServerFilter::All),
        };
    }

    pub(crate) fn active_server_id(&self) -> &ServerId {
        &self.active_server_id
    }

    pub(crate) fn set_active_server(&mut self, id: ServerId) -> Result<(), ()> {
        if self.server(&id).is_none() {
            return Err(());
        }
        self.active_server_id = id;
        Ok(())
    }

    pub(crate) fn remove_secondary(&mut self, id: &ServerId) -> bool {
        let Some(index) = self
            .servers
            .iter()
            .position(|server| server.id == *id && server.role == ServerRole::Secondary)
        else {
            return false;
        };
        self.servers.remove(index);
        if matches!(&self.filter, ServerFilter::Server(selected) if selected == id) {
            self.filter = ServerFilter::All;
        }
        if &self.active_server_id == id {
            self.active_server_id = ServerId::main();
        }
        self.reconcile_new_workspace_picker();
        true
    }

    pub(crate) fn set_connection_state(
        &mut self,
        id: &ServerId,
        connection_state: ConnectionState,
    ) -> Result<(), ()> {
        let is_connected = connection_state == ConnectionState::Connected;
        let Some(server) = self.server_mut(id) else {
            return Err(());
        };
        server.connection_state = connection_state;
        if &self.active_server_id == id && !is_connected {
            self.active_server_id = ServerId::main();
        }
        self.reconcile_new_workspace_picker();
        Ok(())
    }

    /// Record a round-trip latency sample (ms) for the host-banner ping average (issue #13),
    /// keeping only the most recent [`HOST_PING_SAMPLE_WINDOW`] samples.
    pub(crate) fn record_server_ping(&mut self, id: &ServerId, latency_ms: u32) {
        if let Some(server) = self.server_mut(id) {
            if server.ping_samples.len() >= HOST_PING_SAMPLE_WINDOW {
                server.ping_samples.pop_front();
            }
            server.ping_samples.push_back(latency_ms);
        }
    }

    /// Record the latest downstream throughput (bytes/sec) from a host for its banner readout.
    pub(crate) fn set_server_download_bps(&mut self, id: &ServerId, bps: u64) {
        if let Some(server) = self.server_mut(id) {
            server.download_bps = Some(bps);
        }
    }

    /// #44: record the remote's reported herdr version + wire protocol (from the Ping/Pong runtime
    /// status). Drives the host context-menu version readout and its mismatch flag. Mirrors
    /// `set_server_download_bps`.
    pub(crate) fn set_remote_runtime_info(
        &mut self,
        id: &ServerId,
        version: Option<String>,
        protocol: Option<u32>,
    ) {
        if let Some(server) = self.server_mut(id) {
            server.remote_version = version;
            server.remote_protocol = protocol;
        }
    }

    pub(crate) fn set_summary(&mut self, id: &ServerId, summary: ServerSummary) -> Result<(), ()> {
        let Some(server) = self.server_mut(id) else {
            return Err(());
        };
        server.summaries = summary;
        // #39: reconcile — retire the optimistic focus only once the applied summary CONFIRMS it
        // (or it has overstayed its stale-apply budget). Unconditional clearing let a summary
        // fetched BEFORE the focus request landed snap the highlight back on every click.
        self.reconcile_optimistic_focus_after_summary(id);
        Ok(())
    }

    pub(crate) fn secondary_connection_plans(&self) -> Vec<SecondaryConnectionPlan> {
        let mut plans: Vec<SecondaryConnectionPlan> = self
            .servers
            .iter()
            .filter(|server| server.role == ServerRole::Secondary)
            // item 3 (Area 5): a disabled remote is inert — emit no connection plan.
            .filter(|server| !server.disabled)
            .map(|server| SecondaryConnectionPlan {
                server_id: server.id.clone(),
                display_name: server.display_name.clone(),
                target: server.target.clone(),
                keybindings: server.keybindings,
            })
            .collect();
        plans.sort_by_key(|plan| connection_target_rank(&plan.target));
        plans
    }

    pub(crate) fn summary_subscription_plans(&self) -> Vec<SummarySubscriptionPlan> {
        self.servers
            .iter()
            .filter(|server| server.connection_state == ConnectionState::Connected)
            // item 3 (Area 5): even a stale-connected disabled remote stops being polled.
            .filter(|server| !server.disabled)
            .map(|server| SummarySubscriptionPlan {
                server_id: server.id.clone(),
                target: server.target.clone(),
            })
            .collect()
    }

    pub(crate) fn server_connection_target(&self, id: &ServerId) -> Option<ServerConnectionTarget> {
        self.server(id).map(|server| server.target.clone())
    }

    /// Whether `id` is a secondary whose stream is down (disconnected or stuck on a protocol
    /// mismatch) — i.e. a click on its banner status glyph should retry the connection.
    pub(crate) fn server_is_reconnectable(&self, id: &ServerId) -> bool {
        self.server(id).is_some_and(|server| {
            server.role == ServerRole::Secondary
                && !server.disabled
                && matches!(
                    server.connection_state,
                    ConnectionState::Disconnected | ConnectionState::ProtocolMismatch { .. }
                )
        })
    }

    pub(crate) fn unconnected_secondary_server_ids(&self) -> Vec<ServerId> {
        self.servers
            .iter()
            .filter(|server| server.role == ServerRole::Secondary)
            // item 3 (Area 5): a disabled remote is not a reconnect candidate.
            .filter(|server| !server.disabled)
            .filter(|server| {
                matches!(
                    server.connection_state,
                    ConnectionState::Connecting | ConnectionState::Disconnected
                )
            })
            .map(|server| server.id.clone())
            .collect()
    }

    pub(crate) fn secondary_server_ids_missing_client_stream(
        &self,
        connected_streams: &std::collections::HashSet<ServerId>,
    ) -> Vec<ServerId> {
        self.servers
            .iter()
            .filter(|server| server.role == ServerRole::Secondary)
            // item 3 (Area 5): a disabled remote needs no client stream.
            .filter(|server| !server.disabled)
            .filter(|server| !connected_streams.contains(&server.id))
            .filter(|server| {
                !matches!(
                    server.connection_state,
                    ConnectionState::ProtocolMismatch { .. }
                )
            })
            .map(|server| server.id.clone())
            .collect()
    }

    pub(crate) fn refresh_secondary_summaries(
        &mut self,
        mut fetch: impl FnMut(&SecondaryConnectionPlan) -> Result<ServerSummary, ConnectionState>,
    ) {
        let results: Vec<_> = self
            .secondary_connection_plans()
            .into_iter()
            .map(|plan| {
                let result = fetch(&plan);
                (plan.server_id, result)
            })
            .collect();
        self.apply_secondary_summary_results(results);
    }

    pub(crate) fn apply_secondary_summary_results(
        &mut self,
        results: impl IntoIterator<Item = (ServerId, Result<ServerSummary, ConnectionState>)>,
    ) {
        for (server_id, result) in results {
            match result {
                Ok(summary) => {
                    if let Some(server) = self.server_mut(&server_id) {
                        server.connection_state = ConnectionState::Connected;
                        server.summaries = summary;
                    }
                    // #39: a fresh summary arrived — retire the optimistic override only when it
                    // confirms the target (or the stale-apply budget ran out). `Err(_)` results
                    // carry no fresh truth and never touch the override.
                    self.reconcile_optimistic_focus_after_summary(&server_id);
                }
                Err(connection_state) => {
                    if let Some(server) = self.server_mut(&server_id) {
                        server.connection_state = connection_state;
                    }
                }
            }
        }
        self.reconcile_new_workspace_picker();
    }

    /// item 6 (Area 6): clear the optimistic focus override on a focus-request failure so the
    /// highlight reconciles back to summary truth on the next refresh.
    pub(crate) fn clear_optimistic_focus_on_failure(&mut self, server_id: &ServerId) {
        self.clear_optimistic_focus_for_server(server_id);
    }

    fn clear_optimistic_focus_for_server(&mut self, server_id: &ServerId) {
        if matches!(&self.optimistic_focus, Some((id, _)) if id == server_id) {
            self.optimistic_focus = None;
            self.optimistic_focus_stale_applies = 0;
        }
    }

    /// #39: called after a fresh summary has been stored for `server_id`. Retires the optimistic
    /// focus override when the summary agrees with it (truth caught up — the normal path, one
    /// poll after the focus request lands), or when
    /// [`OPTIMISTIC_FOCUS_MAX_STALE_APPLIES`] disagreeing summaries have been applied (the focus
    /// request evidently never landed; stop overriding so summary truth wins). A disagreeing
    /// summary within the budget leaves the override in place — it was fetched before the focus
    /// applied and must not snap the highlight back.
    fn reconcile_optimistic_focus_after_summary(&mut self, server_id: &ServerId) {
        let Some((focus_server, target)) = self.optimistic_focus.as_ref() else {
            return;
        };
        if focus_server != server_id {
            return;
        }
        let confirmed = self
            .server(server_id)
            .is_some_and(|server| summary_confirms_focus_target(&server.summaries, target));
        if confirmed {
            self.clear_optimistic_focus_for_server(server_id);
            return;
        }
        self.optimistic_focus_stale_applies = self.optimistic_focus_stale_applies.saturating_add(1);
        if self.optimistic_focus_stale_applies >= OPTIMISTIC_FOCUS_MAX_STALE_APPLIES {
            self.clear_optimistic_focus_for_server(server_id);
        }
    }

    pub(crate) fn refresh_main_summary_from_api(
        &mut self,
        api: &mut impl SupervisorApi,
    ) -> Result<(), String> {
        let summary = request_server_summary(api)?;
        self.set_summary(&ServerId::main(), summary)
            .map_err(|()| "main server is missing from supervisor model".to_string())
    }

    /// #42: apply a [`MainSupervisorSnapshot`] fetched off the UI loop (registry + UI settings +
    /// main summary). This is the on-loop-thread half of the async main refresh; it does the same
    /// three applies the old inline `refresh_main_local_summaries` did, just without the blocking
    /// fetches. `set_summary` failing only means the main server is (impossibly) absent — ignore it
    /// rather than dropping the registry/ui-settings updates that already landed.
    pub(crate) fn apply_main_supervisor_snapshot(&mut self, snapshot: MainSupervisorSnapshot) {
        // Apply only the parts that were fetched successfully (see `fetch_main_supervisor_snapshot`):
        // a failed remote.list / ui_settings leaves the prior registry / settings intact rather than
        // clobbering them with an empty/default value.
        if let Some(remotes) = snapshot.remotes {
            self.sync_remote_registry(remotes);
        }
        if let Some(ui_settings) = snapshot.ui_settings {
            self.set_ui_settings(ui_settings);
        }
        let _ = self.set_summary(&ServerId::main(), snapshot.summary);
    }

    pub(crate) fn new_workspace_route(&self) -> NewWorkspaceRoute {
        match &self.filter {
            ServerFilter::Server(id) => self.route_for_specific_server(id),
            ServerFilter::All => {
                let destinations = self.connected_destinations();
                if destinations.len() > 1 {
                    NewWorkspaceRoute::PickDestination(destinations)
                } else if let Some(destination) = destinations.into_iter().next() {
                    NewWorkspaceRoute::CreateOn(destination.server_id)
                } else {
                    NewWorkspaceRoute::Unavailable {
                        server_id: ServerId::main(),
                        reason: "server disconnected".to_string(),
                    }
                }
            }
        }
    }

    pub(crate) fn new_workspace_picker(&self) -> Option<&NewWorkspacePickerState> {
        self.new_workspace_picker.as_ref()
    }

    pub(crate) fn new_workspace_picker_destinations(&self) -> Option<&[ServerDestination]> {
        self.new_workspace_picker
            .as_ref()
            .map(|picker| picker.destinations.as_slice())
    }

    pub(crate) fn open_new_workspace_picker(&mut self) -> NewWorkspaceRoute {
        self.close_client_overlay();
        let route = self.new_workspace_route();
        match &route {
            NewWorkspaceRoute::CreateOn(server_id) => {
                self.new_workspace_picker = None;
                self.active_server_id = server_id.clone();
            }
            NewWorkspaceRoute::PickDestination(destinations) => {
                self.new_workspace_picker = Some(NewWorkspacePickerState {
                    destinations: destinations.clone(),
                    selected: 0,
                });
            }
            NewWorkspaceRoute::Unavailable { .. } => {
                self.new_workspace_picker = None;
            }
        }
        route
    }

    /// item 1: advance the picker highlight, saturating at the last destination.
    pub(crate) fn move_new_workspace_picker_next(&mut self) {
        if let Some(picker) = self.new_workspace_picker.as_mut() {
            let last = picker.destinations.len().saturating_sub(1);
            picker.selected = (picker.selected + 1).min(last);
        }
    }

    /// item 1: retreat the picker highlight, saturating at the first destination.
    pub(crate) fn move_new_workspace_picker_prev(&mut self) {
        if let Some(picker) = self.new_workspace_picker.as_mut() {
            picker.selected = picker.selected.saturating_sub(1);
        }
    }

    /// item 1: resolve the highlighted destination into a create route (clamping the selection
    /// defensively), routing through the same `choose_new_workspace_destination` the mouse path
    /// uses. Returns `Unavailable` when the picker is not open.
    pub(crate) fn accept_new_workspace_picker(&mut self) -> NewWorkspaceRoute {
        let Some(picker) = self.new_workspace_picker.as_ref() else {
            return NewWorkspaceRoute::Unavailable {
                server_id: self.active_server_id.clone(),
                reason: "no destination picker open".to_string(),
            };
        };
        let index = picker
            .selected
            .min(picker.destinations.len().saturating_sub(1));
        let Some(destination) = picker.destinations.get(index) else {
            return NewWorkspaceRoute::Unavailable {
                server_id: self.active_server_id.clone(),
                reason: "no destination available".to_string(),
            };
        };
        let server_id = destination.server_id.clone();
        self.choose_new_workspace_destination(&server_id)
    }

    /// #47: the global launcher rows, in render order, as (label, action) pairs — the single source
    /// of truth for both the labels (`client_global_menu_items`) and the menu the launcher opens
    /// (`open_client_global_menu`), so they cannot drift. Every launcher row is selectable.
    fn global_launcher_rows() -> [(&'static str, ClientMenuAction); 6] {
        [
            ("settings", ClientMenuAction::Settings),
            ("keybinds", ClientMenuAction::Keybinds),
            ("reload config", ClientMenuAction::ReloadConfig),
            ("detach", ClientMenuAction::Detach),
            ("add remote", ClientMenuAction::OpenAddRemote),
            ("manage remotes", ClientMenuAction::OpenManageRemotes),
        ]
    }

    /// #47: the launcher row labels, in render order. Mirrors the server launcher
    /// (`global_menu_labels`); `client_global_menu_uses_server_launcher_items` pins the two together.
    pub(crate) fn client_global_menu_items(&self) -> Vec<&'static str> {
        Self::global_launcher_rows()
            .iter()
            .map(|(label, _)| *label)
            .collect()
    }

    // ----- #47: the unified client menu (global launcher / workspace context / host context) ------

    /// #47: the open client menu, or `None`. The single accessor behind all three menus' render,
    /// hit-test, hover, keyboard and dismiss paths.
    pub(crate) fn client_menu(&self) -> Option<&ClientMenu> {
        match &self.client_overlay {
            ClientOverlayState::Menu(menu) => Some(menu),
            ClientOverlayState::None
            | ClientOverlayState::AddRemote(_)
            | ClientOverlayState::ManageRemotes(_)
            | ClientOverlayState::RenameWorkspace(_)
            | ClientOverlayState::ConfirmCloseWorkspace(_) => None,
            ClientOverlayState::NewWorktree(_)
            | ClientOverlayState::ConfirmDeleteWorktree(_)
            | ClientOverlayState::WorktreePicker(_)
            | ClientOverlayState::SessionPicker(_)
            | ClientOverlayState::NewSession(_) => None,
        }
    }

    fn client_menu_mut(&mut self) -> Option<&mut ClientMenu> {
        match &mut self.client_overlay {
            ClientOverlayState::Menu(menu) => Some(menu),
            ClientOverlayState::None
            | ClientOverlayState::AddRemote(_)
            | ClientOverlayState::ManageRemotes(_)
            | ClientOverlayState::RenameWorkspace(_)
            | ClientOverlayState::ConfirmCloseWorkspace(_) => None,
            ClientOverlayState::NewWorktree(_)
            | ClientOverlayState::ConfirmDeleteWorktree(_)
            | ClientOverlayState::WorktreePicker(_)
            | ClientOverlayState::SessionPicker(_)
            | ClientOverlayState::NewSession(_) => None,
        }
    }

    /// Whether a client overlay owns keyboard input right now — the ONE gate the input pipeline
    /// asks before forwarding a keystroke to the focused pane.
    ///
    /// Deliberately an EXHAUSTIVE `match` with no `_` wildcard: this used to be a hand-written
    /// `||` chain of nine `model.x_form().is_some()` calls in the client, and adding an overlay
    /// without remembering to extend it silently made that overlay keyboard-dead — typed
    /// characters leaked straight through to the user's shell. (That is exactly what happened to
    /// the session picker and the new-session input.) With this shape, a new
    /// [`ClientOverlayState`] variant is a compile error until it is classified here.
    pub(crate) fn client_overlay_open(&self) -> bool {
        match &self.client_overlay {
            ClientOverlayState::None => false,
            ClientOverlayState::Menu(_)
            | ClientOverlayState::AddRemote(_)
            | ClientOverlayState::ManageRemotes(_)
            | ClientOverlayState::RenameWorkspace(_)
            | ClientOverlayState::ConfirmCloseWorkspace(_)
            | ClientOverlayState::NewWorktree(_)
            | ClientOverlayState::ConfirmDeleteWorktree(_)
            | ClientOverlayState::WorktreePicker(_)
            | ClientOverlayState::SessionPicker(_)
            | ClientOverlayState::NewSession(_) => true,
        }
    }

    /// #46/#47: whether any client menu is open. The mouse pipeline routes events to it FIRST — it
    /// renders topmost, so it must be topmost in the event pipeline too. Now covers ALL three menus
    /// (the launcher was the gap #46's per-menu guard left open). Replaces `context_menu_open`.
    pub(crate) fn client_menu_open(&self) -> bool {
        matches!(self.client_overlay, ClientOverlayState::Menu(_))
    }

    /// #47: whether ANY overlay is open. THE predicate behind all three cross-cutting gates — the
    /// keyboard-ownership gate in the client's input pipeline, the compositor's modal (cursor-hide)
    /// flag, and the shared top-border drag — so those can never disagree about what is open.
    ///
    /// Delegates to the exhaustive [`Self::client_overlay_open`] instead of re-listing overlays by
    /// hand; the previous chain had silently fallen behind by five overlays (the three worktree ones
    /// plus both session ones). `new_workspace_picker` is a separate model field, not a
    /// `ClientOverlayState` variant, so it is ORed in explicitly.
    pub(crate) fn any_overlay_open(&self) -> bool {
        self.client_overlay_open() || self.new_workspace_picker().is_some()
    }

    /// #47: the first selectable row — the initial highlight, so a menu never opens on a
    /// non-actionable row (e.g. the host version readout). Falls back to 0 when none are selectable.
    fn first_selectable_index(items: &[ClientMenuItem]) -> usize {
        items.iter().position(|item| item.selectable).unwrap_or(0)
    }

    /// #47: open the global launcher menu, anchored at the clicked menu-button cell. The launcher has
    /// no target sub-header.
    pub(crate) fn open_client_global_menu(&mut self, anchor_col: u16, anchor_row: u16) {
        let items: Vec<ClientMenuItem> = Self::global_launcher_rows()
            .into_iter()
            .map(|(label, action)| ClientMenuItem {
                label: label.to_string(),
                selectable: true,
                action,
            })
            .collect();
        self.new_workspace_picker = None;
        self.overlay_drag_offset = (0, 0);
        let selected = Self::first_selectable_index(&items);
        self.client_overlay = ClientOverlayState::Menu(ClientMenu {
            kind: ClientMenuKind::GlobalLauncher,
            title: "menu",
            subheader: None,
            anchor_col,
            anchor_row,
            selected,
            items,
        });
    }

    /// #47: motion/keyboard highlight movement, shared by all three menus. Down clamps to the last
    /// row; Up saturates at the first. Both can pass over a non-selectable row (matching the old
    /// per-menu nav); activating one is the no-op (`select_client_menu_item`).
    pub(crate) fn move_client_menu_next(&mut self) {
        if let Some(menu) = self.client_menu_mut() {
            let count = menu.items.len();
            menu.selected = (menu.selected + 1).min(count.saturating_sub(1));
        }
    }

    pub(crate) fn move_client_menu_prev(&mut self) {
        if let Some(menu) = self.client_menu_mut() {
            menu.selected = menu.selected.saturating_sub(1);
        }
    }

    /// #47: mouse-driven selection — clamp and set the highlighted row (shared by all three menus).
    pub(crate) fn set_client_menu_selected(&mut self, index: usize) {
        if let Some(menu) = self.client_menu_mut() {
            let count = menu.items.len();
            menu.selected = index.min(count.saturating_sub(1));
        }
    }

    /// #47: the shared overlay drag offset (cols, rows from the open overlay's default position).
    /// `(0, 0)` at open; accumulated while dragging the popup's top border.
    pub(crate) fn overlay_drag_offset(&self) -> (i16, i16) {
        self.overlay_drag_offset
    }

    /// #47: set the open overlay's drag offset, used while the user drags the popup's top border to
    /// reposition it. Applies to WHICHEVER overlay is open (menu / form / picker / manage) — one
    /// mechanism for all.
    pub(crate) fn set_overlay_drag_offset(&mut self, offset: (i16, i16)) {
        self.overlay_drag_offset = offset;
    }

    /// #47: translate a key press into a typed outcome — the single keyboard handler for all three
    /// menus. Up/Down (and k/j) move, Enter activates the highlighted row, Esc dismisses.
    pub(crate) fn handle_client_menu_key(
        &mut self,
        key: crate::input::TerminalKey,
    ) -> ClientMenuOutcome {
        use crossterm::event::{KeyCode, KeyEventKind};

        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return ClientMenuOutcome::Redraw;
        }

        match key.code {
            KeyCode::Esc => {
                self.close_client_overlay();
                ClientMenuOutcome::Redraw
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.move_client_menu_prev();
                ClientMenuOutcome::Redraw
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.move_client_menu_next();
                ClientMenuOutcome::Redraw
            }
            KeyCode::Enter => self.accept_client_menu_item(),
            _ => ClientMenuOutcome::Redraw,
        }
    }

    pub(crate) fn accept_client_menu_item(&mut self) -> ClientMenuOutcome {
        let Some(selected) = self.client_menu().map(|menu| menu.selected) else {
            return ClientMenuOutcome::Redraw;
        };
        self.select_client_menu_item(selected)
    }

    /// #47: activate row `index` — the single selection path for all three menus. A non-selectable
    /// or `Noop` row keeps the menu open and just redraws. Overlay-opening rows (`add remote` /
    /// `manage remotes` / workspace rename / workspace close) open their follow-on overlay here and
    /// report `Redraw`; the rest close the menu and carry the context the client loop needs.
    pub(crate) fn select_client_menu_item(&mut self, index: usize) -> ClientMenuOutcome {
        let Some(menu) = self.client_menu() else {
            return ClientMenuOutcome::Redraw;
        };
        let Some(item) = menu.items.get(index) else {
            return ClientMenuOutcome::Redraw;
        };
        if !item.selectable {
            return ClientMenuOutcome::Redraw;
        }
        let action = item.action.clone();
        let host_server_id = match &menu.kind {
            ClientMenuKind::Host { server_id } => Some(server_id.clone()),
            ClientMenuKind::GlobalLauncher | ClientMenuKind::Workspace { .. } => None,
        };
        match action {
            ClientMenuAction::Noop => ClientMenuOutcome::Redraw,
            ClientMenuAction::Settings => {
                self.close_client_overlay();
                ClientMenuOutcome::Settings
            }
            ClientMenuAction::Keybinds => {
                self.close_client_overlay();
                ClientMenuOutcome::Keybinds
            }
            ClientMenuAction::ReloadConfig => {
                self.close_client_overlay();
                ClientMenuOutcome::ReloadConfig
            }
            ClientMenuAction::Detach => {
                self.close_client_overlay();
                ClientMenuOutcome::Detach
            }
            ClientMenuAction::OpenAddRemote => {
                self.open_add_remote_form();
                ClientMenuOutcome::Redraw
            }
            ClientMenuAction::OpenManageRemotes => {
                self.open_remote_manage_overlay();
                ClientMenuOutcome::Redraw
            }
            ClientMenuAction::OpenRename => {
                self.open_rename_workspace();
                ClientMenuOutcome::Redraw
            }
            ClientMenuAction::OpenConfirmClose => {
                self.open_confirm_close_workspace();
                ClientMenuOutcome::Redraw
            }
            ClientMenuAction::OpenNewWorktree => {
                self.open_new_worktree_form();
                ClientMenuOutcome::Redraw
            }
            ClientMenuAction::OpenWorktreePicker => {
                // Open in the loading state and hand the fetch to the loop (the list lives on the
                // owning server; the round-trip must stay off the UI thread).
                match self.open_worktree_picker() {
                    Some((server_id, workspace_id)) => ClientMenuOutcome::FetchWorktreeList {
                        server_id,
                        workspace_id,
                    },
                    None => ClientMenuOutcome::Redraw,
                }
            }
            ClientMenuAction::OpenConfirmDeleteWorktree => {
                self.open_confirm_delete_worktree();
                ClientMenuOutcome::Redraw
            }
            ClientMenuAction::ToggleWorktreeGroup { group_key } => {
                self.close_client_overlay();
                ClientMenuOutcome::ToggleWorktreeGroup { group_key }
            }
            ClientMenuAction::HostAddSpace => {
                self.close_client_overlay();
                host_server_id
                    .map(ClientMenuOutcome::HostAddSpace)
                    .unwrap_or(ClientMenuOutcome::Redraw)
            }
            ClientMenuAction::HostToggleEnabled { enabled } => {
                self.close_client_overlay();
                host_server_id
                    .map(|id| ClientMenuOutcome::HostToggleEnabled {
                        remote_id: id.registry_id().to_string(),
                        enabled,
                    })
                    .unwrap_or(ClientMenuOutcome::Redraw)
            }
            ClientMenuAction::HostDisconnect => {
                self.close_client_overlay();
                host_server_id
                    .map(ClientMenuOutcome::HostDisconnect)
                    .unwrap_or(ClientMenuOutcome::Redraw)
            }
            ClientMenuAction::HostReconnect => {
                self.close_client_overlay();
                host_server_id
                    .map(ClientMenuOutcome::HostReconnect)
                    .unwrap_or(ClientMenuOutcome::Redraw)
            }
            ClientMenuAction::HostUpdate => {
                self.close_client_overlay();
                host_server_id
                    .map(ClientMenuOutcome::HostUpdate)
                    .unwrap_or(ClientMenuOutcome::Redraw)
            }
            ClientMenuAction::OpenSessionPicker => {
                // Open in the loading state and hand the fetch to the loop (the list lives on the
                // REMOTE host; the round-trip must stay off the UI thread) — same shape as
                // `OpenWorktreePicker`.
                match self.open_session_picker() {
                    Some((server_id, remote_id)) => ClientMenuOutcome::FetchSessionList {
                        server_id,
                        remote_id,
                    },
                    None => ClientMenuOutcome::Redraw,
                }
            }
            ClientMenuAction::HostToggleAutoUpdate { auto_update } => {
                self.close_client_overlay();
                host_server_id
                    .map(|id| ClientMenuOutcome::HostToggleAutoUpdate {
                        remote_id: id.registry_id().to_string(),
                        auto_update,
                    })
                    .unwrap_or(ClientMenuOutcome::Redraw)
            }
        }
    }

    pub(crate) fn open_add_remote_form(&mut self) {
        self.new_workspace_picker = None;
        self.overlay_drag_offset = (0, 0);
        self.client_overlay = ClientOverlayState::AddRemote(AddRemoteForm {
            target: String::new(),
            name: String::new(),
            session: String::new(),
            focused_field: AddRemoteField::Target,
            error: None,
            in_progress: false,
            progress: None,
        });
    }

    pub(crate) fn add_remote_form(&self) -> Option<&AddRemoteForm> {
        match &self.client_overlay {
            ClientOverlayState::AddRemote(form) => Some(form),
            ClientOverlayState::None
            | ClientOverlayState::Menu(_)
            | ClientOverlayState::ManageRemotes(_)
            | ClientOverlayState::RenameWorkspace(_)
            | ClientOverlayState::ConfirmCloseWorkspace(_) => None,
            ClientOverlayState::NewWorktree(_)
            | ClientOverlayState::ConfirmDeleteWorktree(_)
            | ClientOverlayState::WorktreePicker(_)
            | ClientOverlayState::SessionPicker(_)
            | ClientOverlayState::NewSession(_) => None,
        }
    }

    pub(crate) fn handle_add_remote_key(
        &mut self,
        key: crate::input::TerminalKey,
    ) -> AddRemoteFormOutcome {
        use crossterm::event::{KeyCode, KeyEventKind, KeyModifiers};

        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return AddRemoteFormOutcome::Redraw;
        }

        match key.code {
            KeyCode::Esc => {
                self.close_client_overlay();
                AddRemoteFormOutcome::Redraw
            }
            KeyCode::Tab | KeyCode::Down | KeyCode::Up => {
                if let Some(form) = self.add_remote_form_mut() {
                    form.focused_field = match form.focused_field {
                        AddRemoteField::Target => AddRemoteField::Name,
                        AddRemoteField::Name => AddRemoteField::Session,
                        AddRemoteField::Session => AddRemoteField::Target,
                    };
                    form.error = None;
                }
                AddRemoteFormOutcome::Redraw
            }
            KeyCode::Enter => {
                let Some(form) = self.add_remote_form_mut() else {
                    return AddRemoteFormOutcome::Redraw;
                };
                let target = form.target.trim().to_string();
                if target.is_empty() {
                    form.error = Some("target required".to_string());
                    return AddRemoteFormOutcome::Redraw;
                }
                let name = trimmed_optional(&form.name);
                let session = trimmed_optional(&form.session);
                AddRemoteFormOutcome::Submit(AddRemoteDraft {
                    target,
                    name,
                    session,
                    keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
                })
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                if let Some(input) = self.add_remote_current_input_mut() {
                    input.clear();
                }
                if let Some(form) = self.add_remote_form_mut() {
                    form.error = None;
                }
                AddRemoteFormOutcome::Redraw
            }
            KeyCode::Backspace => {
                if let Some(input) = self.add_remote_current_input_mut() {
                    input.pop();
                }
                if let Some(form) = self.add_remote_form_mut() {
                    form.error = None;
                }
                AddRemoteFormOutcome::Redraw
            }
            KeyCode::Char(ch) if key.modifiers.difference(KeyModifiers::SHIFT).is_empty() => {
                if let Some(input) = self.add_remote_current_input_mut() {
                    input.push(ch);
                }
                if let Some(form) = self.add_remote_form_mut() {
                    form.error = None;
                }
                AddRemoteFormOutcome::Redraw
            }
            _ => AddRemoteFormOutcome::Redraw,
        }
    }

    pub(crate) fn append_add_remote_paste(&mut self, text: &str) -> AddRemoteFormOutcome {
        if let Some(input) = self.add_remote_current_input_mut() {
            input.push_str(text);
        }
        if let Some(form) = self.add_remote_form_mut() {
            form.error = None;
        }
        AddRemoteFormOutcome::Redraw
    }

    pub(crate) fn set_add_remote_error(&mut self, error: impl Into<String>) {
        if let Some(form) = self.add_remote_form_mut() {
            form.error = Some(error.into());
            form.in_progress = false;
            form.progress = None;
        }
    }

    /// Mark the add-remote submission as in flight: clears any prior error/progress and switches the
    /// status row to the animated progress line.
    pub(crate) fn set_add_remote_in_progress(&mut self) {
        if let Some(form) = self.add_remote_form_mut() {
            form.error = None;
            form.progress = None;
            form.in_progress = true;
        }
    }

    /// Update the in-flight provisioning line with the worker's latest stage (issue #32). Ignored if
    /// the form is gone or no longer in progress (a terminal error/finish already won the race).
    pub(crate) fn set_add_remote_progress(&mut self, message: impl Into<String>) {
        if let Some(form) = self.add_remote_form_mut() {
            if form.in_progress {
                form.progress = Some(message.into());
            }
        }
    }

    pub(crate) fn add_remote_in_progress(&self) -> bool {
        self.add_remote_form().is_some_and(|form| form.in_progress)
    }

    pub(crate) fn finish_add_remote(&mut self) {
        self.close_client_overlay();
    }

    // ----- item 3 (Area 5): remote-management overlay -----------------------------------------

    /// Open the management overlay with a fresh selection clamped to the current secondary rows.
    pub(crate) fn open_remote_manage_overlay(&mut self) {
        self.new_workspace_picker = None;
        self.overlay_drag_offset = (0, 0);
        self.client_overlay = ClientOverlayState::ManageRemotes(RemoteManageOverlay {
            selected: 0,
            scroll: 0,
            confirm_delete: None,
            pending: None,
        });
    }

    pub(crate) fn remote_manage_overlay(&self) -> Option<&RemoteManageOverlay> {
        match &self.client_overlay {
            ClientOverlayState::ManageRemotes(overlay) => Some(overlay),
            ClientOverlayState::None
            | ClientOverlayState::Menu(_)
            | ClientOverlayState::AddRemote(_)
            | ClientOverlayState::RenameWorkspace(_)
            | ClientOverlayState::ConfirmCloseWorkspace(_) => None,
            ClientOverlayState::NewWorktree(_)
            | ClientOverlayState::ConfirmDeleteWorktree(_)
            | ClientOverlayState::WorktreePicker(_)
            | ClientOverlayState::SessionPicker(_)
            | ClientOverlayState::NewSession(_) => None,
        }
    }

    fn remote_manage_overlay_mut(&mut self) -> Option<&mut RemoteManageOverlay> {
        match &mut self.client_overlay {
            ClientOverlayState::ManageRemotes(overlay) => Some(overlay),
            ClientOverlayState::None
            | ClientOverlayState::Menu(_)
            | ClientOverlayState::AddRemote(_)
            | ClientOverlayState::RenameWorkspace(_)
            | ClientOverlayState::ConfirmCloseWorkspace(_) => None,
            ClientOverlayState::NewWorktree(_)
            | ClientOverlayState::ConfirmDeleteWorktree(_)
            | ClientOverlayState::WorktreePicker(_)
            | ClientOverlayState::SessionPicker(_)
            | ClientOverlayState::NewSession(_) => None,
        }
    }

    /// Pure view builder: one `RemoteManageRow` per `Secondary` host, in registry order. `Main`
    /// is never listed. The `Disabled` overlay-state wins over the connection state (the gate).
    pub(crate) fn remote_manage_rows(&self) -> Vec<RemoteManageRow> {
        self.servers
            .iter()
            .filter(|server| server.role == ServerRole::Secondary)
            .map(|server| {
                let state = if server.disabled {
                    RemoteManageState::Disabled
                } else {
                    match server.connection_state {
                        ConnectionState::Connected => RemoteManageState::Connected,
                        ConnectionState::Connecting => RemoteManageState::Connecting,
                        ConnectionState::Disconnected => RemoteManageState::Disconnected,
                        ConnectionState::ProtocolMismatch { .. } => {
                            RemoteManageState::ProtocolMismatch
                        }
                    }
                };
                RemoteManageRow {
                    remote_id: server.id.registry_id().to_string(),
                    name: server.display_name.clone(),
                    target: server.target.display_label(),
                    enabled: !server.disabled,
                    state,
                }
            })
            .collect()
    }

    pub(crate) fn move_remote_manage_next(&mut self) {
        let count = self.remote_manage_rows().len();
        if let Some(overlay) = self.remote_manage_overlay_mut() {
            if overlay.confirm_delete.is_some() {
                return;
            }
            overlay.selected = (overlay.selected + 1).min(count.saturating_sub(1));
        }
    }

    pub(crate) fn move_remote_manage_prev(&mut self) {
        if let Some(overlay) = self.remote_manage_overlay_mut() {
            if overlay.confirm_delete.is_some() {
                return;
            }
            overlay.selected = overlay.selected.saturating_sub(1);
        }
    }

    /// Enter the two-step delete confirmation for the currently-selected remote (if any).
    pub(crate) fn begin_remote_manage_delete(&mut self) {
        let selected_id = self
            .remote_manage_overlay()
            .map(|overlay| overlay.selected)
            .and_then(|selected| self.remote_manage_rows().into_iter().nth(selected))
            .map(|row| row.remote_id);
        if let (Some(remote_id), Some(overlay)) = (selected_id, self.remote_manage_overlay_mut()) {
            overlay.confirm_delete = Some(remote_id);
        }
    }

    pub(crate) fn cancel_remote_manage_delete(&mut self) {
        if let Some(overlay) = self.remote_manage_overlay_mut() {
            overlay.confirm_delete = None;
        }
    }

    /// item 3 (Area 5): mouse-driven selection — clamp and set the selected row index.
    pub(crate) fn set_remote_manage_selected(&mut self, index: usize) {
        let count = self.remote_manage_rows().len();
        if let Some(overlay) = self.remote_manage_overlay_mut() {
            if overlay.confirm_delete.is_some() {
                return;
            }
            overlay.selected = index.min(count.saturating_sub(1));
        }
    }

    /// item 3 (Area 5): clear the in-flight `pending` marker for a finished request, and drop the
    /// delete-confirm sub-state if it was targeting the same remote (a completed delete closes the
    /// popup). No-op when the overlay is closed (e.g. it was navigated away while in flight).
    pub(crate) fn clear_remote_manage_pending(&mut self, remote_id: &str) {
        if let Some(overlay) = self.remote_manage_overlay_mut() {
            if overlay.pending.as_deref() == Some(remote_id) {
                overlay.pending = None;
            }
            if overlay.confirm_delete.as_deref() == Some(remote_id) {
                overlay.confirm_delete = None;
            }
        }
    }

    /// item 3 (Area 5): mouse-driven confirm of the active delete (the red popup's delete button).
    /// Sets `pending` and emits the `Delete` outcome, mirroring the `Enter` key in confirm state.
    pub(crate) fn confirm_remote_manage_delete(&mut self) -> RemoteManageOutcome {
        let Some(remote_id) = self
            .remote_manage_overlay()
            .and_then(|overlay| overlay.confirm_delete.clone())
        else {
            return RemoteManageOutcome::Redraw;
        };
        if self
            .remote_manage_overlay()
            .and_then(|overlay| overlay.pending.as_deref())
            == Some(remote_id.as_str())
        {
            return RemoteManageOutcome::Redraw;
        }
        if let Some(overlay) = self.remote_manage_overlay_mut() {
            overlay.pending = Some(remote_id.clone());
        }
        RemoteManageOutcome::Delete { remote_id }
    }

    /// Translate a key press in the management overlay into a typed outcome. `Space` toggles the
    /// selected remote's enabled flag, `d` enters delete-confirm, `a` jumps to the add-remote
    /// form, `Esc` closes. In delete-confirm sub-state the popup owns input (`Enter`/`d` confirm,
    /// `Esc` cancels; nav keys are inert). A `pending` request for a remote blocks re-issuing a
    /// toggle/delete for THAT remote while it is in flight.
    pub(crate) fn handle_remote_manage_key(
        &mut self,
        key: crate::input::TerminalKey,
    ) -> RemoteManageOutcome {
        use crossterm::event::{KeyCode, KeyEventKind};

        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return RemoteManageOutcome::Redraw;
        }

        let rows = self.remote_manage_rows();
        let Some(overlay) = self.remote_manage_overlay() else {
            return RemoteManageOutcome::Redraw;
        };

        // delete-confirm sub-state: the popup owns input.
        if let Some(remote_id) = overlay.confirm_delete.clone() {
            return match key.code {
                KeyCode::Enter | KeyCode::Char('d') => {
                    if overlay.pending.as_deref() == Some(remote_id.as_str()) {
                        return RemoteManageOutcome::Redraw;
                    }
                    if let Some(overlay) = self.remote_manage_overlay_mut() {
                        overlay.pending = Some(remote_id.clone());
                    }
                    RemoteManageOutcome::Delete { remote_id }
                }
                KeyCode::Esc => {
                    self.cancel_remote_manage_delete();
                    RemoteManageOutcome::Redraw
                }
                _ => RemoteManageOutcome::Redraw,
            };
        }

        match key.code {
            KeyCode::Esc => {
                self.close_client_overlay();
                RemoteManageOutcome::Redraw
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.move_remote_manage_prev();
                RemoteManageOutcome::Redraw
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.move_remote_manage_next();
                RemoteManageOutcome::Redraw
            }
            KeyCode::Char(' ') => {
                let Some(row) = rows.get(overlay.selected) else {
                    return RemoteManageOutcome::Redraw;
                };
                if overlay.pending.as_deref() == Some(row.remote_id.as_str()) {
                    return RemoteManageOutcome::Redraw;
                }
                let remote_id = row.remote_id.clone();
                let enabled = !row.enabled;
                if let Some(overlay) = self.remote_manage_overlay_mut() {
                    overlay.pending = Some(remote_id.clone());
                }
                RemoteManageOutcome::SetEnabled { remote_id, enabled }
            }
            KeyCode::Char('d') => {
                if rows.get(overlay.selected).is_some() {
                    self.begin_remote_manage_delete();
                }
                RemoteManageOutcome::Redraw
            }
            KeyCode::Char('a') => {
                self.open_add_remote_form();
                RemoteManageOutcome::OpenAddRemote
            }
            _ => RemoteManageOutcome::Redraw,
        }
    }

    // ----- #23: workspace context menu + rename + confirm-close overlays ----------------------

    /// #41: whether `(server_id, workspace_id)` may be individually drag-reordered. A worktree-
    /// grouped space (any row carrying a `worktree_key` — parent or linked checkout) is NOT
    /// reorderable: its rendered position is owned by the worktree grouping, so a storage move would
    /// not change what the user sees, producing the "indicator shown but drop does nothing" bug. The
    /// monolithic sidebar blocks the same case via `worktree_space().is_none()`; this mirrors it so
    /// the client arms a drag (and paints the drop indicator) only where a drop will take effect.
    pub(crate) fn workspace_is_reorderable(
        &self,
        server_id: &ServerId,
        workspace_id: &str,
    ) -> bool {
        self.server(server_id)
            .and_then(|server| {
                server
                    .summaries
                    .workspaces
                    .iter()
                    .find(|ws| ws.workspace_id == workspace_id)
            })
            .map(|ws| ws.worktree_key.is_none())
            .unwrap_or(false)
    }

    /// #43: the display name of `server_id`, used by the host right-click handler to capture the
    /// host name for the context-menu sub-header. `None` when the server is not in the model.
    pub(crate) fn server_display_name(&self, server_id: &ServerId) -> Option<String> {
        self.server(server_id)
            .map(|server| server.display_name.clone())
    }

    /// #23: the current label of `(server_id, workspace_id)` from the cached summaries, used by the
    /// right-click handler to capture the label for the context menu (rename prefill / close text).
    /// Falls back to `None` when the server or workspace is not in the model.
    pub(crate) fn workspace_label(
        &self,
        server_id: &ServerId,
        workspace_id: &str,
    ) -> Option<String> {
        self.server(server_id)?
            .summaries
            .workspaces
            .iter()
            .find(|ws| ws.workspace_id == workspace_id)
            .map(|ws| ws.label.clone())
    }

    /// The workspace's worktree grouping, read from its summary: `(repo_key, is_linked,
    /// has_linked_children)`. `None` for a non-git workspace. Drives the worktree rows of the
    /// workspace context menu (server-menu parity) and the caller's collapsed-state lookup.
    ///
    /// Mirrors the server menu's two-tier detection: worktree-space MEMBERSHIP when present,
    /// otherwise the plain-git signal (`WorkspaceInfo.git`) — so a git workspace that has never
    /// created a worktree still gets the "new worktree" / "open worktree…" rows. Grouping
    /// (`has_linked_children`) keys on membership only, exactly like the sidebar renderer.
    pub(crate) fn workspace_worktree_group(
        &self,
        server_id: &ServerId,
        workspace_id: &str,
    ) -> Option<(String, bool, bool)> {
        let server = self.server(server_id)?;
        let workspace = server
            .summaries
            .workspaces
            .iter()
            .find(|ws| ws.workspace_id == workspace_id)?;
        let (group_key, is_linked) = match &workspace.worktree_key {
            Some(key) => (key.clone(), workspace.worktree_is_linked),
            None => (workspace.git_repo_key.clone()?, workspace.git_is_linked),
        };
        let has_linked_children = !is_linked
            && server.summaries.workspaces.iter().any(|other| {
                other.workspace_id != workspace_id
                    && other.worktree_key.as_deref() == Some(group_key.as_str())
                    && other.worktree_is_linked
            });
        Some((group_key, is_linked, has_linked_children))
    }

    /// #23: open the workspace context menu for `(server_id, workspace_id)`, capturing the current
    /// `label` for the rename prefill and the close-confirm text. Mirrors `open_remote_manage_overlay`.
    ///
    /// Server-menu parity: bakes the same conditional worktree rows the server-rendered sidebar
    /// shows (`ContextMenuState::items`): a git ROOT adds "new worktree" / "open worktree…"; a
    /// LINKED checkout adds "delete worktree checkout…"; a root with linked children closes as a
    /// group and gets the expand/collapse toggle. `group_collapsed` is the client-local collapsed
    /// state captured by the caller (the compositor owns that set), `None` when not grouped.
    pub(crate) fn open_workspace_context_menu(
        &mut self,
        server_id: ServerId,
        workspace_id: String,
        label: String,
        group_collapsed: Option<bool>,
        anchor_col: u16,
        anchor_row: u16,
    ) {
        let worktree = self.workspace_worktree_group(&server_id, &workspace_id);
        let has_children = worktree
            .as_ref()
            .is_some_and(|(_, _, has_children)| *has_children);
        let mut items = vec![
            ClientMenuItem {
                label: "rename".to_string(),
                selectable: true,
                action: ClientMenuAction::OpenRename,
            },
            ClientMenuItem {
                label: if has_children { "close group" } else { "close" }.to_string(),
                selectable: true,
                action: ClientMenuAction::OpenConfirmClose,
            },
        ];
        match &worktree {
            Some((_, true, _)) => {
                items.push(ClientMenuItem {
                    label: "delete worktree checkout…".to_string(),
                    selectable: true,
                    action: ClientMenuAction::OpenConfirmDeleteWorktree,
                });
            }
            Some((group_key, false, _)) => {
                items.push(ClientMenuItem {
                    label: "new worktree".to_string(),
                    selectable: true,
                    action: ClientMenuAction::OpenNewWorktree,
                });
                items.push(ClientMenuItem {
                    label: "open worktree…".to_string(),
                    selectable: true,
                    action: ClientMenuAction::OpenWorktreePicker,
                });
                if has_children {
                    if let Some(collapsed) = group_collapsed {
                        items.push(ClientMenuItem {
                            label: if collapsed { "expand" } else { "collapse" }.to_string(),
                            selectable: true,
                            action: ClientMenuAction::ToggleWorktreeGroup {
                                group_key: group_key.clone(),
                            },
                        });
                    }
                }
            }
            None => {}
        }
        self.new_workspace_picker = None;
        self.overlay_drag_offset = (0, 0);
        let selected = Self::first_selectable_index(&items);
        self.client_overlay = ClientOverlayState::Menu(ClientMenu {
            kind: ClientMenuKind::Workspace {
                server_id,
                workspace_id,
                label: label.clone(),
            },
            title: "workspace",
            subheader: Some(label),
            anchor_col,
            anchor_row,
            selected,
            items,
        });
    }

    // ----- #43/#44: host context menu (version readout / add-space / enable-disable /
    // disconnect-reconnect / update) ---------------------------------------------------------------

    /// #43/#44: open the host context menu for `server_id`, baking each row's label AND action from
    /// the host's `disabled`/`connected`/version captured at open time. The version readout is a
    /// non-selectable info row; add-space/update degrade to a no-op action when disconnected (the row
    /// stays so the menu shape is stable). Baking label+action together means the dynamic
    /// "disable"/"enable" + "disconnect"/"reconnect" labels can never drift from what a press does.
    /// Mirrors `open_workspace_context_menu`.
    pub(crate) fn open_host_context_menu(
        &mut self,
        server_id: ServerId,
        display_name: String,
        anchor_col: u16,
        anchor_row: u16,
    ) {
        let (disabled, connected, remote_version, remote_protocol, auto_update) = self
            .server(&server_id)
            .map(|server| {
                (
                    server.disabled,
                    server.connection_state == ConnectionState::Connected,
                    server.remote_version.clone(),
                    server.remote_protocol,
                    server.auto_update,
                )
            })
            .unwrap_or((false, false, None, None, false));
        // C3: the effective session this host is attached to; an unset session IS the remote's
        // `default` session, so it reads as that rather than as blank.
        let session = self.server_session(&server_id);
        let (version_label, is_mismatch) =
            host_version_readout(remote_version.as_deref(), remote_protocol);
        let items = vec![
            ClientMenuItem {
                label: if is_mismatch {
                    format!("⚠ {version_label}")
                } else {
                    version_label
                },
                selectable: false,
                action: ClientMenuAction::Noop,
            },
            // C2/C3: the session readout, directly under the version. Unlike the version row it is
            // SELECTABLE — activating it (Enter / left-click / right-click) opens the picker.
            ClientMenuItem {
                label: format!(
                    "session  {}",
                    session
                        .as_deref()
                        .unwrap_or(crate::session::DEFAULT_SESSION_NAME)
                ),
                selectable: true,
                action: ClientMenuAction::OpenSessionPicker,
            },
            ClientMenuItem {
                label: "add new space".to_string(),
                selectable: true,
                action: if connected {
                    ClientMenuAction::HostAddSpace
                } else {
                    ClientMenuAction::Noop
                },
            },
            ClientMenuItem {
                label: if disabled { "enable" } else { "disable" }.to_string(),
                selectable: true,
                action: ClientMenuAction::HostToggleEnabled { enabled: disabled },
            },
            ClientMenuItem {
                label: if connected { "disconnect" } else { "reconnect" }.to_string(),
                selectable: true,
                action: if connected {
                    ClientMenuAction::HostDisconnect
                } else {
                    ClientMenuAction::HostReconnect
                },
            },
            ClientMenuItem {
                label: "update".to_string(),
                selectable: true,
                action: if connected {
                    ClientMenuAction::HostUpdate
                } else {
                    ClientMenuAction::Noop
                },
            },
            // #61: per-remote auto-update toggle. Always selectable (it just flips a persisted flag,
            // independent of the live connection); the label shows the ACTION like enable/disable.
            ClientMenuItem {
                label: if auto_update {
                    "disable auto-update"
                } else {
                    "enable auto-update"
                }
                .to_string(),
                selectable: true,
                action: ClientMenuAction::HostToggleAutoUpdate {
                    auto_update: !auto_update,
                },
            },
        ];
        self.new_workspace_picker = None;
        // #47: a freshly opened overlay starts unshifted (mirrors every other open_* path), so a
        // stale drag offset from a previous overlay can never displace the host menu from its anchor.
        self.overlay_drag_offset = (0, 0);
        // #46 (item 5): start on the first ACTIONABLE row — `first_selectable_index` skips the
        // non-selectable version readout (row 0), so the menu never opens looking dead.
        let selected = Self::first_selectable_index(&items);
        self.client_overlay = ClientOverlayState::Menu(ClientMenu {
            kind: ClientMenuKind::Host { server_id },
            title: "host",
            subheader: Some(display_name),
            anchor_col,
            anchor_row,
            selected,
            items,
        });
    }

    /// #43: public wrapper over the private `route_for_specific_server`, so the client loop can
    /// resolve a host context-menu `AddSpace(server_id)` into a `workspace.create` request without
    /// reaching into the private routing internals.
    pub(crate) fn route_for_server(&self, id: &ServerId) -> NewWorkspaceRoute {
        self.route_for_specific_server(id)
    }

    /// #23/#47: transition the open workspace context menu into the rename overlay, prefilled with
    /// the captured label. A no-op when the open menu is not a workspace menu. Reads the
    /// `(server_id, workspace_id, label)` from the `ClientMenu`'s `Workspace` kind.
    pub(crate) fn open_rename_workspace(&mut self) {
        let form = match self.client_menu().map(|menu| &menu.kind) {
            Some(ClientMenuKind::Workspace {
                server_id,
                workspace_id,
                label,
            }) => RenameWorkspaceForm {
                server_id: server_id.clone(),
                workspace_id: workspace_id.clone(),
                label: label.clone(),
                error: None,
            },
            _ => return,
        };
        self.overlay_drag_offset = (0, 0);
        self.client_overlay = ClientOverlayState::RenameWorkspace(form);
    }

    pub(crate) fn rename_workspace_form(&self) -> Option<&RenameWorkspaceForm> {
        match &self.client_overlay {
            ClientOverlayState::RenameWorkspace(form) => Some(form),
            ClientOverlayState::None
            | ClientOverlayState::Menu(_)
            | ClientOverlayState::AddRemote(_)
            | ClientOverlayState::ManageRemotes(_)
            | ClientOverlayState::ConfirmCloseWorkspace(_) => None,
            ClientOverlayState::NewWorktree(_)
            | ClientOverlayState::ConfirmDeleteWorktree(_)
            | ClientOverlayState::WorktreePicker(_)
            | ClientOverlayState::SessionPicker(_)
            | ClientOverlayState::NewSession(_) => None,
        }
    }

    fn rename_workspace_form_mut(&mut self) -> Option<&mut RenameWorkspaceForm> {
        match &mut self.client_overlay {
            ClientOverlayState::RenameWorkspace(form) => Some(form),
            ClientOverlayState::None
            | ClientOverlayState::Menu(_)
            | ClientOverlayState::AddRemote(_)
            | ClientOverlayState::ManageRemotes(_)
            | ClientOverlayState::ConfirmCloseWorkspace(_) => None,
            ClientOverlayState::NewWorktree(_)
            | ClientOverlayState::ConfirmDeleteWorktree(_)
            | ClientOverlayState::WorktreePicker(_)
            | ClientOverlayState::SessionPicker(_)
            | ClientOverlayState::NewSession(_) => None,
        }
    }

    /// #23: text editing for the rename overlay. Mirrors `handle_add_remote_key`'s
    /// Esc/Backspace/Ctrl-U/Char handling; Enter submits a non-empty trimmed label.
    pub(crate) fn handle_rename_workspace_key(
        &mut self,
        key: crate::input::TerminalKey,
    ) -> RenameWorkspaceOutcome {
        use crossterm::event::{KeyCode, KeyEventKind, KeyModifiers};

        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return RenameWorkspaceOutcome::Redraw;
        }

        match key.code {
            KeyCode::Esc => {
                self.close_client_overlay();
                RenameWorkspaceOutcome::Redraw
            }
            KeyCode::Enter => {
                let Some(form) = self.rename_workspace_form_mut() else {
                    return RenameWorkspaceOutcome::Redraw;
                };
                let label = form.label.trim().to_string();
                if label.is_empty() {
                    form.error = Some("label required".to_string());
                    return RenameWorkspaceOutcome::Redraw;
                }
                let outcome = RenameWorkspaceOutcome::Submit {
                    server_id: form.server_id.clone(),
                    workspace_id: form.workspace_id.clone(),
                    label,
                };
                // Close the overlay on submit so it can't linger and be re-submitted (the request
                // flows through the overlay-agnostic ApiRequest path, which never closes it). Esc and
                // Cancel already close; mirror them here.
                self.close_client_overlay();
                outcome
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                if let Some(form) = self.rename_workspace_form_mut() {
                    form.label.clear();
                    form.error = None;
                }
                RenameWorkspaceOutcome::Redraw
            }
            KeyCode::Backspace => {
                if let Some(form) = self.rename_workspace_form_mut() {
                    form.label.pop();
                    form.error = None;
                }
                RenameWorkspaceOutcome::Redraw
            }
            KeyCode::Char(ch) if key.modifiers.difference(KeyModifiers::SHIFT).is_empty() => {
                if let Some(form) = self.rename_workspace_form_mut() {
                    form.label.push(ch);
                    form.error = None;
                }
                RenameWorkspaceOutcome::Redraw
            }
            _ => RenameWorkspaceOutcome::Redraw,
        }
    }

    /// #23: paste support for the rename field, mirroring `append_add_remote_paste`.
    pub(crate) fn append_rename_workspace_paste(&mut self, text: &str) -> RenameWorkspaceOutcome {
        if let Some(form) = self.rename_workspace_form_mut() {
            form.label.push_str(text);
            form.error = None;
        }
        RenameWorkspaceOutcome::Redraw
    }

    /// #23: transition the open context menu into the close-confirm overlay. A no-op (closes) when
    /// no context menu is open. Mirrors `begin_remote_manage_delete`.
    pub(crate) fn open_confirm_close_workspace(&mut self) {
        let confirm = match self.client_menu().map(|menu| &menu.kind) {
            Some(ClientMenuKind::Workspace {
                server_id,
                workspace_id,
                label,
            }) => ConfirmCloseWorkspace {
                server_id: server_id.clone(),
                workspace_id: workspace_id.clone(),
                label: label.clone(),
            },
            _ => return,
        };
        self.overlay_drag_offset = (0, 0);
        self.client_overlay = ClientOverlayState::ConfirmCloseWorkspace(confirm);
    }

    pub(crate) fn confirm_close_workspace(&self) -> Option<&ConfirmCloseWorkspace> {
        match &self.client_overlay {
            ClientOverlayState::ConfirmCloseWorkspace(confirm) => Some(confirm),
            _ => None,
        }
    }

    /// #23: confirm the close (Enter / y / a confirm button), emitting the `(server_id,
    /// workspace_id)` the client turns into a `workspace.close` round-trip. Mirrors
    /// `confirm_remote_manage_delete`.
    pub(crate) fn accept_confirm_close_workspace(&mut self) -> ConfirmCloseOutcome {
        let Some(confirm) = self.confirm_close_workspace() else {
            return ConfirmCloseOutcome::Redraw;
        };
        let outcome = ConfirmCloseOutcome::Confirm {
            server_id: confirm.server_id.clone(),
            workspace_id: confirm.workspace_id.clone(),
        };
        // Close the overlay on confirm so it can't linger and be re-confirmed (the workspace.close
        // request flows through the overlay-agnostic ApiRequest path, which never closes it). Esc
        // and Cancel already close; mirror them here.
        self.close_client_overlay();
        outcome
    }

    /// #23: translate a key press in the close-confirm overlay into a typed outcome. Enter / y
    /// confirms, Esc / n cancels (mirrors the remote-manage delete-confirm sub-state).
    pub(crate) fn handle_confirm_close_workspace_key(
        &mut self,
        key: crate::input::TerminalKey,
    ) -> ConfirmCloseOutcome {
        use crossterm::event::{KeyCode, KeyEventKind};

        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return ConfirmCloseOutcome::Redraw;
        }

        match key.code {
            KeyCode::Enter | KeyCode::Char('y') | KeyCode::Char('Y') => {
                self.accept_confirm_close_workspace()
            }
            KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') => {
                self.close_client_overlay();
                ConfirmCloseOutcome::Redraw
            }
            _ => ConfirmCloseOutcome::Redraw,
        }
    }

    // ----- worktree-menu parity: new-worktree form / delete-confirm / open-picker --------------

    /// Promote the open workspace context menu into the "new worktree" branch-name input.
    /// Mirrors `open_rename_workspace`.
    pub(crate) fn open_new_worktree_form(&mut self) {
        let form = match self.client_menu().map(|menu| &menu.kind) {
            Some(ClientMenuKind::Workspace {
                server_id,
                workspace_id,
                ..
            }) => NewWorktreeForm {
                server_id: server_id.clone(),
                workspace_id: workspace_id.clone(),
                branch: String::new(),
                error: None,
            },
            _ => return,
        };
        self.overlay_drag_offset = (0, 0);
        self.client_overlay = ClientOverlayState::NewWorktree(form);
    }

    pub(crate) fn new_worktree_form(&self) -> Option<&NewWorktreeForm> {
        match &self.client_overlay {
            ClientOverlayState::NewWorktree(form) => Some(form),
            _ => None,
        }
    }

    fn new_worktree_form_mut(&mut self) -> Option<&mut NewWorktreeForm> {
        match &mut self.client_overlay {
            ClientOverlayState::NewWorktree(form) => Some(form),
            _ => None,
        }
    }

    /// Text editing for the new-worktree branch input. Mirrors `handle_rename_workspace_key`;
    /// Enter submits a non-empty trimmed branch name.
    pub(crate) fn handle_new_worktree_key(
        &mut self,
        key: crate::input::TerminalKey,
    ) -> NewWorktreeOutcome {
        use crossterm::event::{KeyCode, KeyEventKind, KeyModifiers};

        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return NewWorktreeOutcome::Redraw;
        }

        match key.code {
            KeyCode::Esc => {
                self.close_client_overlay();
                NewWorktreeOutcome::Redraw
            }
            KeyCode::Enter => {
                let Some(form) = self.new_worktree_form_mut() else {
                    return NewWorktreeOutcome::Redraw;
                };
                let branch = form.branch.trim().to_string();
                if branch.is_empty() {
                    form.error = Some("branch required".to_string());
                    return NewWorktreeOutcome::Redraw;
                }
                let outcome = NewWorktreeOutcome::Submit {
                    server_id: form.server_id.clone(),
                    workspace_id: form.workspace_id.clone(),
                    branch,
                };
                self.close_client_overlay();
                outcome
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                if let Some(form) = self.new_worktree_form_mut() {
                    form.branch.clear();
                    form.error = None;
                }
                NewWorktreeOutcome::Redraw
            }
            KeyCode::Backspace => {
                if let Some(form) = self.new_worktree_form_mut() {
                    form.branch.pop();
                    form.error = None;
                }
                NewWorktreeOutcome::Redraw
            }
            KeyCode::Char(ch) if key.modifiers.difference(KeyModifiers::SHIFT).is_empty() => {
                if let Some(form) = self.new_worktree_form_mut() {
                    form.branch.push(ch);
                    form.error = None;
                }
                NewWorktreeOutcome::Redraw
            }
            _ => NewWorktreeOutcome::Redraw,
        }
    }

    pub(crate) fn append_new_worktree_paste(&mut self, text: &str) -> NewWorktreeOutcome {
        if let Some(form) = self.new_worktree_form_mut() {
            form.branch.push_str(text);
            form.error = None;
        }
        NewWorktreeOutcome::Redraw
    }

    /// Promote the open workspace context menu into the delete-worktree confirmation.
    /// Mirrors `open_confirm_close_workspace`.
    pub(crate) fn open_confirm_delete_worktree(&mut self) {
        let confirm = match self.client_menu().map(|menu| &menu.kind) {
            Some(ClientMenuKind::Workspace {
                server_id,
                workspace_id,
                label,
            }) => ConfirmDeleteWorktree {
                server_id: server_id.clone(),
                workspace_id: workspace_id.clone(),
                label: label.clone(),
            },
            _ => return,
        };
        self.overlay_drag_offset = (0, 0);
        self.client_overlay = ClientOverlayState::ConfirmDeleteWorktree(confirm);
    }

    pub(crate) fn confirm_delete_worktree(&self) -> Option<&ConfirmDeleteWorktree> {
        match &self.client_overlay {
            ClientOverlayState::ConfirmDeleteWorktree(confirm) => Some(confirm),
            _ => None,
        }
    }

    /// Enter / y confirms the worktree-checkout delete, Esc / n cancels. Mirrors
    /// `handle_confirm_close_workspace_key`.
    pub(crate) fn handle_confirm_delete_worktree_key(
        &mut self,
        key: crate::input::TerminalKey,
    ) -> ConfirmDeleteWorktreeOutcome {
        use crossterm::event::{KeyCode, KeyEventKind};

        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return ConfirmDeleteWorktreeOutcome::Redraw;
        }

        match key.code {
            KeyCode::Enter | KeyCode::Char('y') | KeyCode::Char('Y') => {
                let Some(confirm) = self.confirm_delete_worktree() else {
                    return ConfirmDeleteWorktreeOutcome::Redraw;
                };
                let outcome = ConfirmDeleteWorktreeOutcome::Confirm {
                    server_id: confirm.server_id.clone(),
                    workspace_id: confirm.workspace_id.clone(),
                };
                self.close_client_overlay();
                outcome
            }
            KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') => {
                self.close_client_overlay();
                ConfirmDeleteWorktreeOutcome::Redraw
            }
            _ => ConfirmDeleteWorktreeOutcome::Redraw,
        }
    }

    /// Promote the open workspace context menu into the "open worktree…" picker (loading state).
    /// Returns the `(server_id, workspace_id)` the loop must fetch `worktree.list` for.
    pub(crate) fn open_worktree_picker(&mut self) -> Option<(ServerId, String)> {
        let (server_id, workspace_id) = match self.client_menu().map(|menu| &menu.kind) {
            Some(ClientMenuKind::Workspace {
                server_id,
                workspace_id,
                ..
            }) => (server_id.clone(), workspace_id.clone()),
            _ => return None,
        };
        self.overlay_drag_offset = (0, 0);
        self.client_overlay = ClientOverlayState::WorktreePicker(WorktreePicker {
            server_id: server_id.clone(),
            workspace_id: workspace_id.clone(),
            loading: true,
            error: None,
            items: Vec::new(),
            selected: 0,
        });
        Some((server_id, workspace_id))
    }

    pub(crate) fn worktree_picker(&self) -> Option<&WorktreePicker> {
        match &self.client_overlay {
            ClientOverlayState::WorktreePicker(picker) => Some(picker),
            _ => None,
        }
    }

    fn worktree_picker_mut(&mut self) -> Option<&mut WorktreePicker> {
        match &mut self.client_overlay {
            ClientOverlayState::WorktreePicker(picker) => Some(picker),
            _ => None,
        }
    }

    /// Apply the off-thread `worktree.list` result to the open picker. Ignored when the picker
    /// has been closed or re-targeted in the meantime (a stale fetch must not resurrect it).
    pub(crate) fn fill_worktree_picker(
        &mut self,
        server_id: &ServerId,
        workspace_id: &str,
        result: Result<Vec<WorktreePickerItem>, String>,
    ) {
        let Some(picker) = self.worktree_picker_mut() else {
            return;
        };
        if &picker.server_id != server_id || picker.workspace_id != workspace_id {
            return;
        }
        picker.loading = false;
        match result {
            Ok(items) => {
                picker.items = items;
                picker.selected = 0;
                picker.error = if picker.items.is_empty() {
                    Some("no worktrees found for this repo".to_string())
                } else {
                    None
                };
            }
            Err(error) => picker.error = Some(error),
        }
    }

    /// Up/Down moves the selection, Enter opens the selected checkout (`worktree.open` on the
    /// owning server), Esc closes. Mirrors the remote-manage overlay's key handling.
    pub(crate) fn handle_worktree_picker_key(
        &mut self,
        key: crate::input::TerminalKey,
    ) -> WorktreePickerOutcome {
        use crossterm::event::{KeyCode, KeyEventKind};

        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return WorktreePickerOutcome::Redraw;
        }

        match key.code {
            KeyCode::Esc => {
                self.close_client_overlay();
                WorktreePickerOutcome::Redraw
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if let Some(picker) = self.worktree_picker_mut() {
                    picker.selected = picker.selected.saturating_sub(1);
                }
                WorktreePickerOutcome::Redraw
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if let Some(picker) = self.worktree_picker_mut() {
                    if picker.selected + 1 < picker.items.len() {
                        picker.selected += 1;
                    }
                }
                WorktreePickerOutcome::Redraw
            }
            KeyCode::Enter => {
                let Some(picker) = self.worktree_picker() else {
                    return WorktreePickerOutcome::Redraw;
                };
                let Some(item) = picker.items.get(picker.selected) else {
                    return WorktreePickerOutcome::Redraw;
                };
                let outcome = WorktreePickerOutcome::Open {
                    server_id: picker.server_id.clone(),
                    workspace_id: picker.workspace_id.clone(),
                    path: item.path.clone(),
                };
                self.close_client_overlay();
                outcome
            }
            _ => WorktreePickerOutcome::Redraw,
        }
    }

    // ----- C4/C5/C6: the host-menu session picker + its new-session input ----------------------

    /// C4: promote the open HOST menu into the session picker (loading state). Returns the
    /// `(server_id, remote_id)` the loop must fetch `session.list` for. Mirrors
    /// `open_worktree_picker`; a no-op (`None`) when the open menu is not a host menu.
    pub(crate) fn open_session_picker(&mut self) -> Option<(ServerId, String)> {
        let server_id = match self.client_menu().map(|menu| &menu.kind) {
            Some(ClientMenuKind::Host { server_id }) => server_id.clone(),
            _ => return None,
        };
        let remote_id = server_id.registry_id().to_string();
        let current = self.server_session(&server_id);
        self.overlay_drag_offset = (0, 0);
        self.client_overlay = ClientOverlayState::SessionPicker(SessionPicker {
            server_id: server_id.clone(),
            remote_id: remote_id.clone(),
            current,
            loading: true,
            error: None,
            items: Vec::new(),
            selected: 0,
        });
        Some((server_id, remote_id))
    }

    pub(crate) fn session_picker(&self) -> Option<&SessionPicker> {
        match &self.client_overlay {
            ClientOverlayState::SessionPicker(picker) => Some(picker),
            _ => None,
        }
    }

    fn session_picker_mut(&mut self) -> Option<&mut SessionPicker> {
        match &mut self.client_overlay {
            ClientOverlayState::SessionPicker(picker) => Some(picker),
            _ => None,
        }
    }

    /// Apply the off-thread `session.list` result to the open picker. Ignored when the picker has
    /// been closed or re-targeted meanwhile (a stale fetch must not resurrect it). The model — not
    /// the worker — decides which row is CURRENT, and the selection lands on it. An error (e.g. an
    /// old remote with no `session.list` method) is shown inline and leaves the trailing
    /// `new session…` row usable, so C6 still works.
    pub(crate) fn fill_session_picker(
        &mut self,
        server_id: &ServerId,
        result: Result<Vec<SessionPickerItem>, String>,
    ) {
        let Some(picker) = self.session_picker_mut() else {
            return;
        };
        if &picker.server_id != server_id {
            return;
        }
        picker.loading = false;
        match result {
            Ok(items) => {
                let current = picker.current.clone();
                picker.items = items
                    .into_iter()
                    .map(|item| SessionPickerItem {
                        is_current: item.name.as_deref() == current.as_deref(),
                        ..item
                    })
                    .collect();
                picker.error = None;
                picker.selected = picker
                    .items
                    .iter()
                    .position(|item| item.is_current)
                    .unwrap_or(0);
            }
            Err(error) => {
                picker.items = Vec::new();
                picker.error = Some(error);
                picker.selected = 0;
            }
        }
    }

    /// C5: mouse row-select — clamp to the row range (listed sessions + the trailing
    /// `new session…` row) and highlight. Mirrors `set_client_menu_selected`.
    pub(crate) fn set_session_picker_selected(&mut self, index: usize) {
        if let Some(picker) = self.session_picker_mut() {
            picker.selected = index.min(picker.row_count().saturating_sub(1));
        }
    }

    /// C5: activate row `index` — the ONE selection path shared by Enter and a click.
    pub(crate) fn select_session_picker_row(&mut self, index: usize) -> SessionPickerOutcome {
        let Some(picker) = self.session_picker() else {
            return SessionPickerOutcome::Redraw;
        };
        if index >= picker.row_count() {
            return SessionPickerOutcome::Redraw;
        }
        if picker.is_new_session_row(index) {
            // C6: promote into the free-text input (the model owns the overlay transition, like the
            // menu's `OpenRename`); the loop just repaints.
            self.open_new_session_form();
            return SessionPickerOutcome::OpenNewSession;
        }
        let Some(item) = picker.items.get(index) else {
            return SessionPickerOutcome::Redraw;
        };
        let outcome = SessionPickerOutcome::Select {
            server_id: picker.server_id.clone(),
            remote_id: picker.remote_id.clone(),
            session: item.name.clone(),
        };
        self.close_client_overlay();
        outcome
    }

    /// C5: Up/Down moves over listed sessions AND the trailing `new session…` row, Enter activates
    /// the highlighted one, Esc closes. Mirrors `handle_worktree_picker_key`.
    pub(crate) fn handle_session_picker_key(
        &mut self,
        key: crate::input::TerminalKey,
    ) -> SessionPickerOutcome {
        use crossterm::event::{KeyCode, KeyEventKind};

        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return SessionPickerOutcome::Redraw;
        }

        match key.code {
            KeyCode::Esc => {
                self.close_client_overlay();
                SessionPickerOutcome::Redraw
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if let Some(picker) = self.session_picker_mut() {
                    picker.selected = picker.selected.saturating_sub(1);
                }
                SessionPickerOutcome::Redraw
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if let Some(picker) = self.session_picker_mut() {
                    if picker.selected + 1 < picker.row_count() {
                        picker.selected += 1;
                    }
                }
                SessionPickerOutcome::Redraw
            }
            KeyCode::Enter => {
                let Some(selected) = self.session_picker().map(|picker| picker.selected) else {
                    return SessionPickerOutcome::Redraw;
                };
                self.select_session_picker_row(selected)
            }
            _ => SessionPickerOutcome::Redraw,
        }
    }

    /// C6: transition the open session picker into the free-text session input. A no-op when the
    /// picker is not open. Mirrors `open_rename_workspace`.
    pub(crate) fn open_new_session_form(&mut self) {
        let form = match self.session_picker() {
            Some(picker) => NewSessionForm {
                server_id: picker.server_id.clone(),
                remote_id: picker.remote_id.clone(),
                name: String::new(),
                error: None,
                in_flight: false,
            },
            None => return,
        };
        self.overlay_drag_offset = (0, 0);
        self.client_overlay = ClientOverlayState::NewSession(form);
    }

    pub(crate) fn new_session_form(&self) -> Option<&NewSessionForm> {
        match &self.client_overlay {
            ClientOverlayState::NewSession(form) => Some(form),
            _ => None,
        }
    }

    fn new_session_form_mut(&mut self) -> Option<&mut NewSessionForm> {
        match &mut self.client_overlay {
            ClientOverlayState::NewSession(form) => Some(form),
            _ => None,
        }
    }

    /// C6: text editing for the new-session input. Mirrors `handle_rename_workspace_key`; Enter
    /// submits. An EMPTY name is the remote's default session (`None`); anything else must pass
    /// `crate::session::validate_name` — a rejection keeps the overlay OPEN with the reason inline
    /// (the same rule the server enforces, surfaced before the round-trip).
    pub(crate) fn handle_new_session_key(
        &mut self,
        key: crate::input::TerminalKey,
    ) -> NewSessionOutcome {
        use crossterm::event::{KeyCode, KeyEventKind, KeyModifiers};

        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return NewSessionOutcome::Redraw;
        }

        match key.code {
            KeyCode::Esc => {
                self.close_client_overlay();
                NewSessionOutcome::Redraw
            }
            KeyCode::Enter => {
                let Some(form) = self.new_session_form_mut() else {
                    return NewSessionOutcome::Redraw;
                };
                // One submit at a time — the in-flight flag also blocks the double-Enter that the
                // now-persistent overlay would otherwise allow.
                if form.in_flight {
                    return NewSessionOutcome::Redraw;
                }
                let name = form.name.trim().to_string();
                let session = if name.is_empty() || name == crate::session::DEFAULT_SESSION_NAME {
                    None
                } else {
                    if let Err(err) = crate::session::validate_name(&name) {
                        form.error = Some(err);
                        return NewSessionOutcome::Redraw;
                    }
                    Some(name)
                };
                // Deliberately NOT closed here (unlike rename): the overlay stays open until
                // `remote.set_session` answers, so a rejection can be shown inline. `finish_new_session`
                // closes it on success, `fail_new_session` re-arms it with the error. Esc still bails.
                form.in_flight = true;
                form.error = None;
                NewSessionOutcome::Submit {
                    server_id: form.server_id.clone(),
                    remote_id: form.remote_id.clone(),
                    session,
                }
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                if let Some(form) = self.new_session_form_mut() {
                    form.name.clear();
                    form.error = None;
                }
                NewSessionOutcome::Redraw
            }
            KeyCode::Backspace => {
                if let Some(form) = self.new_session_form_mut() {
                    form.name.pop();
                    form.error = None;
                }
                NewSessionOutcome::Redraw
            }
            KeyCode::Char(ch) if key.modifiers.difference(KeyModifiers::SHIFT).is_empty() => {
                if let Some(form) = self.new_session_form_mut() {
                    form.name.push(ch);
                    form.error = None;
                }
                NewSessionOutcome::Redraw
            }
            _ => NewSessionOutcome::Redraw,
        }
    }

    /// C6: the in-flight `remote.set_session` for `remote_id` SUCCEEDED — close the new-session
    /// overlay if it is still the one that submitted it. A no-op when the user already moved on.
    pub(crate) fn finish_new_session(&mut self, remote_id: &str) {
        if self
            .new_session_form()
            .is_some_and(|form| form.remote_id == remote_id)
        {
            self.close_client_overlay();
        }
    }

    /// C6: the in-flight `remote.set_session` for `remote_id` was REJECTED — put the server's reason
    /// on the still-open overlay and let the user correct the name. A no-op when the overlay is gone
    /// (the picker-click path, which has no overlay to return to — that failure is surfaced on the
    /// host banner instead).
    pub(crate) fn fail_new_session(&mut self, remote_id: &str, message: String) {
        if let Some(form) = self.new_session_form_mut() {
            if form.remote_id == remote_id {
                form.in_flight = false;
                form.error = Some(message);
            }
        }
    }

    /// C6: paste support for the new-session field, mirroring `append_rename_workspace_paste`.
    pub(crate) fn append_new_session_paste(&mut self, text: &str) -> NewSessionOutcome {
        if let Some(form) = self.new_session_form_mut() {
            form.name.push_str(text);
            form.error = None;
        }
        NewSessionOutcome::Redraw
    }

    pub(crate) fn choose_new_workspace_destination(
        &mut self,
        server_id: &ServerId,
    ) -> NewWorkspaceRoute {
        let destination_is_visible = self.new_workspace_picker.as_ref().is_some_and(|picker| {
            picker
                .destinations
                .iter()
                .any(|destination| &destination.server_id == server_id)
        });
        self.new_workspace_picker = None;
        if !destination_is_visible {
            return NewWorkspaceRoute::Unavailable {
                server_id: server_id.clone(),
                reason: "server unavailable".to_string(),
            };
        }

        let route = self.route_for_specific_server(server_id);
        if matches!(route, NewWorkspaceRoute::CreateOn(_)) {
            self.active_server_id = server_id.clone();
        }
        route
    }

    pub(crate) fn focus_workspace_route(
        &mut self,
        server_id: &ServerId,
        workspace_id: &str,
    ) -> FocusRoute {
        let Some(server) = self.server(server_id) else {
            return FocusRoute::NotFound;
        };

        if server.connection_state != ConnectionState::Connected {
            return FocusRoute::Unavailable {
                server_id: server_id.clone(),
                reason: unavailable_reason(&server.connection_state).to_string(),
            };
        }

        if !server
            .summaries
            .workspaces
            .iter()
            .any(|workspace| workspace.workspace_id == workspace_id)
        {
            return FocusRoute::NotFound;
        }

        self.close_new_workspace_picker();
        self.active_server_id = server_id.clone();
        // item 6 (Area 6): optimistic focus override. This arm is only reached after the
        // existence check above, so the target is a real workspace with a `Some(_)` id when
        // rendered. `Unavailable`/`NotFound` return before this point and set NO optimistic
        // focus (the "only set on resolved `Some(_)` targets" rule).
        self.optimistic_focus = Some((
            server_id.clone(),
            OptimisticFocusTarget::Workspace(workspace_id.to_string()),
        ));
        self.optimistic_focus_stale_applies = 0;
        FocusRoute::Workspace {
            server_id: server_id.clone(),
            workspace_id: workspace_id.to_string(),
        }
    }

    pub(crate) fn focus_agent_route(&mut self, server_id: &ServerId, agent_id: &str) -> FocusRoute {
        let Some(server) = self.server(server_id) else {
            return FocusRoute::NotFound;
        };

        if server.connection_state != ConnectionState::Connected {
            return FocusRoute::Unavailable {
                server_id: server_id.clone(),
                reason: unavailable_reason(&server.connection_state).to_string(),
            };
        }

        if !server
            .summaries
            .agents
            .iter()
            .any(|agent| agent.agent_id == agent_id)
        {
            return FocusRoute::NotFound;
        }

        self.close_new_workspace_picker();
        self.active_server_id = server_id.clone();
        // item 6 (Area 6): optimistic agent focus. Only reached after the existence check
        // above, so the agent (and its workspace) is real. `Unavailable`/`NotFound` set none.
        self.optimistic_focus = Some((
            server_id.clone(),
            OptimisticFocusTarget::Agent(agent_id.to_string()),
        ));
        self.optimistic_focus_stale_applies = 0;
        FocusRoute::Agent {
            server_id: server_id.clone(),
            target: agent_id.to_string(),
        }
    }

    fn route_for_specific_server(&self, id: &ServerId) -> NewWorkspaceRoute {
        let Some(server) = self.server(id) else {
            return NewWorkspaceRoute::Unavailable {
                server_id: id.clone(),
                reason: "server unavailable".to_string(),
            };
        };

        if server.connection_state == ConnectionState::Connected {
            return NewWorkspaceRoute::CreateOn(id.clone());
        }

        NewWorkspaceRoute::Unavailable {
            server_id: id.clone(),
            reason: unavailable_reason(&server.connection_state).to_string(),
        }
    }

    fn connected_destinations(&self) -> Vec<ServerDestination> {
        self.servers
            .iter()
            .filter(|server| server.connection_state == ConnectionState::Connected)
            .map(|server| ServerDestination {
                server_id: server.id.clone(),
                display_name: server.display_name.clone(),
            })
            .collect()
    }

    pub(crate) fn workspace_rows(&self) -> Vec<WorkspaceSidebarRow> {
        let all_filter = self.filter == ServerFilter::All;
        // item 6 (Area 6): the optimistic-focus override. For the optimistically-focused server
        // only, clear summary-derived `focused` on all of its rows and set it on the optimistic
        // target's row. Placeholder rows have `workspace_id == None`, so they never match and
        // never become focused. Every other server's rows are returned untouched. The override
        // only flips a `focused` bool on a real `Workspace` row; it never reorders rows, so
        // `from_model`'s `active_idx` (computed from this flat stream) cannot be shifted.
        self.visible_servers()
            .into_iter()
            .flat_map(|server| {
                let mut rows = workspace_rows_for_server(server, all_filter);
                if let Some(focused_workspace) = self.optimistic_focused_workspace_id(&server.id) {
                    for row in &mut rows {
                        row.focused =
                            row.workspace_id.as_deref() == Some(focused_workspace.as_str());
                    }
                }
                rows
            })
            .collect()
    }

    /// item 6 (Area 6): resolve the workspace id that the optimistic focus targets on `server_id`
    /// (if any). For a `Workspace` target it is the target id directly; for an `Agent` target it
    /// is the agent's owning workspace, joined through the server's summary (the same
    /// `agent.workspace_id == workspace.workspace_id` join `agent_groups_for_server` uses). Returns
    /// `None` when the optimistic focus is unset, targets another server, or the agent is unknown.
    fn optimistic_focused_workspace_id(&self, server_id: &ServerId) -> Option<String> {
        let (focus_server, target) = self.optimistic_focus.as_ref()?;
        if focus_server != server_id {
            return None;
        }
        match target {
            OptimisticFocusTarget::Workspace(workspace_id) => Some(workspace_id.clone()),
            OptimisticFocusTarget::Agent(agent_id) => self
                .server(server_id)?
                .summaries
                .agents
                .iter()
                .find(|agent| &agent.agent_id == agent_id)
                .map(|agent| agent.workspace_id.clone()),
        }
    }

    /// item 2 (C3): one banner spec per visible host, in `visible_servers()` order. Each tuple
    /// is `(insertion_index, spec)` where `insertion_index` is the position in the flat
    /// `workspace_rows()` stream at which the banner precedes that host's first row.
    ///
    /// #19 (host half): the Local/Main host also gets a banner — but ONLY in multi-host mode
    /// (≥2 visible hosts, i.e. at least one remote), so its banner is the draggable handle for
    /// reordering hosts. The single-local case stays banner-free (unchanged single-host UX).
    pub(crate) fn host_banner_specs(&self) -> Vec<(usize, crate::app::state::HostBannerSpec)> {
        let all_filter = self.filter == ServerFilter::All;
        let visible = self.visible_servers();
        // #19: in multi-host mode every host (Local included) gets a banner; otherwise only
        // remotes do (and a lone local yields none, preserving the single-host UX).
        let banner_local = visible.len() >= 2;
        let mut specs = Vec::new();
        let mut row_offset = 0usize;
        for server in visible {
            let rows = workspace_rows_for_server(server, all_filter);
            if server.role == ServerRole::Secondary || banner_local {
                let space_count = server
                    .summaries
                    .workspaces
                    .iter()
                    .filter(|workspace| !workspace.workspace_id.is_empty())
                    .count();
                specs.push((
                    row_offset,
                    crate::app::state::HostBannerSpec {
                        display_name: server.display_name.clone(),
                        connection_state: host_banner_state(server),
                        space_count,
                        latency_ms: server.avg_ping_ms(),
                        download_bps: server.download_bps,
                        progress_lines: self
                            .update_progress
                            .get(&server.id)
                            .cloned()
                            .unwrap_or_default(),
                        update_outcome: self.update_outcomes.get(&server.id).cloned(),
                    },
                ));
            }
            row_offset += rows.len();
        }
        specs
    }

    /// #19 (host half): the ordered list of `ServerId`s that get a host banner, in the SAME
    /// `visible_servers()` order and using the SAME multi-host gate as `host_banner_specs`. The
    /// client builds a parallel `banner_idx -> server_id` map from this so host hit-testing and
    /// the drag preview resolve a banner to its host deterministically (render == hit geometry).
    pub(crate) fn host_banner_server_ids(&self) -> Vec<ServerId> {
        let visible = self.visible_servers();
        let banner_local = visible.len() >= 2;
        visible
            .into_iter()
            .filter(|server| server.role == ServerRole::Secondary || banner_local)
            .map(|server| server.id.clone())
            .collect()
    }

    /// #19 (host half): reorder the host (server) block. `source_server_id` is the dragged host;
    /// `insert_index` is its target slot among the ORDERED host list (0..=len), matching the
    /// `WorkspaceReorder` insert contract. Client-local — host order is owned by this client
    /// (session-local; not persisted to the remote registry), so this only reorders the in-memory
    /// `servers` Vec and never round-trips to a server. `active_server_id` keeps pointing at the
    /// same host after the move. Returns whether the order actually changed.
    pub(crate) fn reorder_server(
        &mut self,
        source_server_id: &ServerId,
        insert_index: usize,
    ) -> bool {
        let Some(from) = self.servers.iter().position(|s| &s.id == source_server_id) else {
            return false;
        };
        // Translate the insert slot (a position in the post-removal list) into the destination
        // index, mirroring the monolithic `move_workspace` contract: removing the source first
        // shifts every later slot left by one.
        let clamped = insert_index.min(self.servers.len());
        let to = if clamped > from { clamped - 1 } else { clamped };
        if to == from {
            return false;
        }
        let server = self.servers.remove(from);
        self.servers.insert(to, server);
        true
    }

    /// item 2 (C3) coordination flag — `true` whenever the host-banner feature is live, i.e.
    /// at least one visible `Secondary` host group will render a banner. Read once in
    /// `from_model` and used by `workspace_list_entries` to flip the divider to plain. `false`
    /// in monolithic mode. This is read-only render state; never mutated during render.
    pub(crate) fn host_banner_active(&self) -> bool {
        !self.host_banner_specs().is_empty()
    }

    /// Whether a host banner is currently animating. The SINGLE banner-active input read by
    /// `compositor::sidebar_wants_animation` (contract Area 1: do not invent a second clock or
    /// second flag). `true` iff the animation is set to `Animated` AND at least one banner is
    /// visible.
    pub(crate) fn host_banner_animation_active(&self) -> bool {
        self.ui_settings().sidebar_host.animation == crate::config::HostBannerAnimation::Animated
            && self.host_banner_active()
    }

    pub(crate) fn agent_groups(&self) -> Vec<AgentSidebarGroup> {
        let all_filter = self.filter == ServerFilter::All;
        self.visible_servers()
            .into_iter()
            .filter(|server| server.connection_state == ConnectionState::Connected)
            .flat_map(|server| {
                let mut groups = agent_groups_for_server(server, all_filter);
                // item 6 (Area 6): apply the optimistic focus override to the optimistically-
                // focused server's groups only. Other servers are untouched.
                if let Some((focus_server, target)) = self.optimistic_focus.as_ref() {
                    if focus_server == &server.id {
                        Self::apply_optimistic_focus_to_groups(&mut groups, target);
                    }
                }
                groups
            })
            .collect()
    }

    /// item 6 (Area 6): rewrite the per-group `focused` (spaces highlight) and per-agent
    /// `focused` flags so the optimistic target is the only focused entry on its server.
    fn apply_optimistic_focus_to_groups(
        groups: &mut [AgentSidebarGroup],
        target: &OptimisticFocusTarget,
    ) {
        match target {
            OptimisticFocusTarget::Workspace(workspace_id) => {
                for group in groups.iter_mut() {
                    group.focused = &group.workspace_id == workspace_id;
                    for agent in &mut group.agents {
                        agent.focused = false;
                    }
                }
            }
            OptimisticFocusTarget::Agent(agent_id) => {
                for group in groups.iter_mut() {
                    let mut group_has_focus = false;
                    for agent in &mut group.agents {
                        agent.focused = &agent.agent_id == agent_id;
                        group_has_focus |= agent.focused;
                    }
                    // Mark the agent's group focused so the spaces highlight follows the agent
                    // (matches the `focused: workspace.focused || agents.any(..)` invariant).
                    group.focused = group_has_focus;
                }
            }
        }
    }

    fn visible_servers(&self) -> Vec<&ManagedServer> {
        match &self.filter {
            ServerFilter::All => self.servers.iter().collect(),
            ServerFilter::Server(id) => self.server(id).into_iter().collect(),
        }
    }

    fn server(&self, id: &ServerId) -> Option<&ManagedServer> {
        self.servers.iter().find(|server| &server.id == id)
    }

    /// Whether `id` is still a live server in the model. Used by the client to prune per-server
    /// state (e.g. #36's retained `frame_cache`) for a remote dropped by a registry sync.
    pub(crate) fn contains_server(&self, id: &ServerId) -> bool {
        self.server(id).is_some()
    }

    /// #44: the ssh `(destination, options)` for `id`, or `None` for a non-ssh (local) host. The
    /// one-click "update" worker reuses these to rebuild the `SshTarget` for the add-remote
    /// provisioning flow without reaching into the private `ManagedServer`.
    pub(crate) fn server_ssh_target(&self, id: &ServerId) -> Option<(String, Vec<String>)> {
        match self.server(id).map(|server| &server.target) {
            Some(ServerConnectionTarget::Ssh {
                destination,
                options,
                ..
            }) => Some((destination.clone(), options.clone())),
            _ => None,
        }
    }

    /// The remote-side session `id` attaches to (`None` = its default session). Sibling of
    /// `server_ssh_target` so a throwaway bridge (post-update status refetch) and the host menu's
    /// session readout both read the SAME session the live bridge was built with.
    pub(crate) fn server_session(&self, id: &ServerId) -> Option<String> {
        self.server(id)
            .and_then(|server| server.target.session())
            .map(str::to_string)
    }

    /// #61: secondary SSH remotes with per-remote auto-update enabled that are at a KNOWN protocol
    /// mismatch vs this client. The loop pushes this client's build onto each (same flow as the manual
    /// `update`). Excludes: disabled remotes (inert), non-SSH remotes (nothing to reinstall over ssh),
    /// and any host whose protocol is still unknown (not yet probed) — we never auto-update on a guess.
    /// Connection state is intentionally NOT filtered: a mismatched host is NOT `Connected` (its stream
    /// handshake is rejected on the protocol gap), so the trigger keys off the captured protocol alone.
    pub(crate) fn auto_update_candidates(&self) -> Vec<ServerId> {
        self.servers
            .iter()
            .filter(|server| server.role == ServerRole::Secondary)
            .filter(|server| server.auto_update && !server.disabled)
            .filter(|server| matches!(server.target, ServerConnectionTarget::Ssh { .. }))
            .filter(|server| {
                matches!(server.remote_protocol, Some(protocol)
                    if protocol != crate::protocol::PROTOCOL_VERSION)
            })
            .map(|server| server.id.clone())
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn server_for_test(&self, id: &ServerId) -> Option<&ManagedServer> {
        self.server(id)
    }

    fn server_mut(&mut self, id: &ServerId) -> Option<&mut ManagedServer> {
        self.servers.iter_mut().find(|server| &server.id == id)
    }

    fn reconcile_selected_servers(&mut self) {
        if matches!(&self.filter, ServerFilter::Server(selected) if self.server(selected).is_none())
        {
            self.filter = ServerFilter::All;
        }
        if self.server(&self.active_server_id).is_none() {
            self.active_server_id = ServerId::main();
        }
    }

    pub(crate) fn close_new_workspace_picker(&mut self) {
        self.new_workspace_picker = None;
    }

    pub(crate) fn close_client_overlay(&mut self) {
        self.client_overlay = ClientOverlayState::None;
        // #47: a closed overlay carries no drag offset to the next one.
        self.overlay_drag_offset = (0, 0);
    }

    fn add_remote_form_mut(&mut self) -> Option<&mut AddRemoteForm> {
        match &mut self.client_overlay {
            ClientOverlayState::AddRemote(form) => Some(form),
            ClientOverlayState::None
            | ClientOverlayState::Menu(_)
            | ClientOverlayState::ManageRemotes(_)
            | ClientOverlayState::RenameWorkspace(_)
            | ClientOverlayState::ConfirmCloseWorkspace(_) => None,
            ClientOverlayState::NewWorktree(_)
            | ClientOverlayState::ConfirmDeleteWorktree(_)
            | ClientOverlayState::WorktreePicker(_)
            | ClientOverlayState::SessionPicker(_)
            | ClientOverlayState::NewSession(_) => None,
        }
    }

    fn add_remote_current_input_mut(&mut self) -> Option<&mut String> {
        let form = self.add_remote_form_mut()?;
        match form.focused_field {
            AddRemoteField::Target => Some(&mut form.target),
            AddRemoteField::Name => Some(&mut form.name),
            AddRemoteField::Session => Some(&mut form.session),
        }
    }

    fn reconcile_new_workspace_picker(&mut self) {
        let connected_destinations = self.connected_destinations();
        let Some(picker) = self.new_workspace_picker.take() else {
            return;
        };

        let next_destinations: Vec<ServerDestination> = picker
            .destinations
            .into_iter()
            .filter_map(|existing| {
                connected_destinations
                    .iter()
                    .find(|current| current.server_id == existing.server_id)
                    .cloned()
            })
            .collect();
        if !next_destinations.is_empty() {
            // item 1: clamp the carried selection to the filtered list so a disconnect of the
            // highlighted (e.g. last) destination cannot leave `selected` out of range.
            let selected = picker.selected.min(next_destinations.len() - 1);
            self.new_workspace_picker = Some(NewWorkspacePickerState {
                destinations: next_destinations,
                selected,
            });
        }
    }
}

fn workspace_rows_for_server(server: &ManagedServer, all_filter: bool) -> Vec<WorkspaceSidebarRow> {
    // item 4: a row is remote iff its server is a secondary host.
    let is_remote = server.role == ServerRole::Secondary;

    if server.connection_state != ConnectionState::Connected
        && server.summaries.workspaces.is_empty()
    {
        return vec![WorkspaceSidebarRow {
            server_id: server.id.clone(),
            workspace_id: None,
            label: unavailable_row_label(server),
            branch: None,
            focused: false,
            disabled: true,
            is_remote,
            worktree_key: None,
            worktree_is_linked: false,
        }];
    }

    if server.role == ServerRole::Secondary && server.summaries.workspaces.is_empty() {
        return vec![WorkspaceSidebarRow {
            server_id: server.id.clone(),
            workspace_id: None,
            label: "no workspaces".to_string(),
            branch: None,
            focused: false,
            disabled: true,
            is_remote,
            worktree_key: None,
            worktree_is_linked: false,
        }];
    }

    server
        .summaries
        .workspaces
        .iter()
        .map(|workspace| WorkspaceSidebarRow {
            server_id: server.id.clone(),
            workspace_id: Some(workspace.workspace_id.clone()),
            label: workspace_label(server, &workspace.label, all_filter),
            branch: workspace.branch.clone(),
            focused: workspace.focused,
            disabled: server.connection_state != ConnectionState::Connected,
            is_remote,
            // #22: thread the worktree group key + linked flag through to `from_model`.
            worktree_key: workspace.worktree_key.clone(),
            worktree_is_linked: workspace.worktree_is_linked,
        })
        .collect()
}

fn agent_groups_for_server(server: &ManagedServer, all_filter: bool) -> Vec<AgentSidebarGroup> {
    server
        .summaries
        .workspaces
        .iter()
        .filter_map(|workspace| {
            let agents: Vec<AgentSidebarRow> = server
                .summaries
                .agents
                .iter()
                .filter(|agent| agent.workspace_id == workspace.workspace_id)
                .map(|agent| AgentSidebarRow {
                    agent_id: agent.agent_id.clone(),
                    label: agent.label.clone(),
                    status: agent.status.clone(),
                    focused: agent.focused,
                    pane_label: agent.pane_label.clone(),
                    tab_id: agent.tab_id.clone(),
                    tab_label: agent.tab_label.clone(),
                })
                .collect();

            (!agents.is_empty()).then(|| AgentSidebarGroup {
                server_id: server.id.clone(),
                workspace_id: workspace.workspace_id.clone(),
                label: workspace_label(server, &workspace.label, all_filter),
                focused: workspace.focused || agents.iter().any(|agent| agent.focused),
                agents,
            })
        })
        .collect()
}

fn workspace_label(_server: &ManagedServer, label: &str, _all_filter: bool) -> String {
    // item 2 (C3): always the bare space label. Host identity now lives in the per-host
    // banner row above each remote group (drops the jammed "{display_name} {label}"). This
    // applies to both `workspace_rows_for_server` and `agent_groups_for_server` call sites.
    label.to_string()
}

fn unavailable_row_label(server: &ManagedServer) -> String {
    // item 3 (Area 5): a disabled remote reads "<name> disabled" first — the gate, not the
    // connection state, governs the placeholder. Checked BEFORE the connection-state match.
    if server.disabled {
        return format!("{} disabled", server.display_name);
    }
    // item 2 (C3): drop the `display_name` prefix — the banner above carries the host name.
    // The placeholder row keeps the state word for layout; the banner suffix is the primary
    // state signal.
    match server.connection_state {
        ConnectionState::Connecting => "connecting".to_string(),
        ConnectionState::Disconnected => "offline".to_string(),
        ConnectionState::ProtocolMismatch { .. } => "protocol mismatch".to_string(),
        ConnectionState::Connected => "connected".to_string(),
    }
}

/// item 2 (C3): map a managed host's connection/disabled state to the banner state used for
/// the per-host banner suffix + glyph. `Disabled` (item 3 `server.disabled`) wins over the
/// connection state; until item 3 wires the flag it is always `false`.
fn host_banner_state(server: &ManagedServer) -> crate::app::state::HostBannerState {
    use crate::app::state::HostBannerState;
    if server.disabled {
        return HostBannerState::Disabled;
    }
    match server.connection_state {
        ConnectionState::Connected => HostBannerState::Connected,
        ConnectionState::Connecting => HostBannerState::Connecting,
        ConnectionState::Disconnected => HostBannerState::Disconnected,
        ConnectionState::ProtocolMismatch { .. } => HostBannerState::ProtocolMismatch,
    }
}

fn unavailable_reason(connection_state: &ConnectionState) -> &'static str {
    match connection_state {
        ConnectionState::Connecting => "server connecting",
        ConnectionState::Connected => "server connected",
        ConnectionState::Disconnected => "server disconnected",
        ConnectionState::ProtocolMismatch { .. } => "protocol mismatch",
    }
}

fn trimmed_optional(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// #44: format the host context-menu version-readout label and whether the remote's wire protocol
/// mismatches the LOCAL client. Pure so the label + mismatch flag derive from one place and are
/// unit-testable. Returns `("v<ver> · proto <n>", is_mismatch)` when both are known, `("proto <n>",
/// is_mismatch)` with only a protocol, and `("unknown", false)` when nothing was captured yet.
///
/// `is_mismatch` is true only when a protocol is KNOWN and differs from `PROTOCOL_VERSION`; an
/// unknown protocol is treated as neutral (false) so a not-yet-probed host never shows a false ⚠.
pub(crate) fn host_version_readout(
    remote_version: Option<&str>,
    remote_protocol: Option<u32>,
) -> (String, bool) {
    let is_mismatch = matches!(remote_protocol, Some(proto)
        if proto != crate::protocol::PROTOCOL_VERSION);
    let label = match (remote_version, remote_protocol) {
        (Some(version), Some(proto)) => format!("v{version} · proto {proto}"),
        (Some(version), None) => format!("v{version}"),
        (None, Some(proto)) => format!("proto {proto}"),
        (None, None) => "unknown".to_string(),
    };
    (label, is_mismatch)
}

fn managed_secondary(
    definition: crate::remote_registry::RemoteDefinitionSnapshot,
    connection_state: ConnectionState,
) -> ManagedServer {
    let target = ServerConnectionTarget::from_definition(&definition);
    ManagedServer {
        id: ServerId::secondary(definition.id),
        display_name: definition.name,
        role: ServerRole::Secondary,
        target,
        keybindings: definition.keybindings,
        connection_state,
        summaries: ServerSummary::default(),
        disabled: definition.disabled, // item 3 (Area 5): gate input from the registry.
        auto_update: definition.auto_update, // #61: per-remote auto-update flag from the registry.
        ping_samples: std::collections::VecDeque::new(),
        download_bps: None,
        remote_version: None,
        remote_protocol: None,
    }
}

impl ManagedServer {
    /// Average of the recent round-trip samples (ms), or `None` until the first sample lands.
    pub(crate) fn avg_ping_ms(&self) -> Option<u32> {
        if self.ping_samples.is_empty() {
            return None;
        }
        let sum: u64 = self.ping_samples.iter().map(|ms| *ms as u64).sum();
        Some((sum / self.ping_samples.len() as u64) as u32)
    }
}

fn connection_target_rank(target: &ServerConnectionTarget) -> u8 {
    match target {
        ServerConnectionTarget::LocalSession(_) => 0,
        ServerConnectionTarget::Ssh { .. } => 1,
        ServerConnectionTarget::Main => 2,
    }
}

fn request_remote_list(
    api: &mut impl SupervisorApi,
) -> Result<Vec<crate::remote_registry::RemoteDefinitionSnapshot>, String> {
    let response = api.request(crate::api::schema::Request {
        id: "client-supervisor:remote-list".into(),
        method: crate::api::schema::Method::RemoteList(crate::api::schema::EmptyParams::default()),
    })?;
    match response.result {
        crate::api::schema::ResponseResult::RemoteList { remotes } => Ok(remotes),
        other => Err(format!("remote.list returned unexpected result: {other:?}")),
    }
}

fn request_server_summary(api: &mut impl SupervisorApi) -> Result<ServerSummary, String> {
    let workspaces_response = api.request(crate::api::schema::Request {
        id: "client-supervisor:workspace-list".into(),
        method: crate::api::schema::Method::WorkspaceList(
            crate::api::schema::EmptyParams::default(),
        ),
    })?;
    let workspaces = match workspaces_response.result {
        crate::api::schema::ResponseResult::WorkspaceList { workspaces } => workspaces,
        other => {
            return Err(format!(
                "workspace.list returned unexpected result: {other:?}"
            ))
        }
    };

    let agents_response = api.request(crate::api::schema::Request {
        id: "client-supervisor:agent-list".into(),
        method: crate::api::schema::Method::AgentList(crate::api::schema::EmptyParams::default()),
    })?;
    let agents = match agents_response.result {
        crate::api::schema::ResponseResult::AgentList { agents } => agents,
        other => return Err(format!("agent.list returned unexpected result: {other:?}")),
    };

    Ok(ServerSummary::from_api(workspaces, agents))
}

/// #61: the remote's runtime herdr version + wire protocol, captured from the Ping the summary fetch
/// already issues. Recorded into the model so the host context-menu version readout reflects a LIVE
/// host. Previously this Ping's `version` was fetched only to gate the protocol check and then thrown
/// away, so an already-connected host's readout stayed stuck on "unknown" — only an in-flight
/// `update` (via the post-update refetch) ever populated it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteRuntimeInfo {
    pub(crate) version: Option<String>,
    pub(crate) protocol: Option<u32>,
}

/// #61: fetch a secondary's summary AND its runtime version/protocol over the SAME api connection —
/// the summary fetch already Pings for the protocol gate, so this captures the `version` it used to
/// discard at zero extra round-trips. The runtime info is returned whenever the Ping SUCCEEDS,
/// INCLUDING on a protocol mismatch (when the summary itself errors): that is exactly the case the
/// host-menu ⚠ readout exists for (and #61's auto-update trigger keys off). `None` runtime only when
/// the Ping itself failed (host unreachable), where there is nothing truthful to record.
pub(crate) fn fetch_server_summary_with_runtime_status(
    target: crate::api::client::ConnectionTarget,
) -> (
    Option<RemoteRuntimeInfo>,
    Result<ServerSummary, ConnectionState>,
) {
    let mut api = crate::api::client::ApiClient::for_target(target);
    summary_with_runtime_status_via_api(&mut api)
}

/// Testable core of [`fetch_server_summary_with_runtime_status`] over a mockable [`SupervisorApi`].
fn summary_with_runtime_status_via_api(
    api: &mut impl SupervisorApi,
) -> (
    Option<RemoteRuntimeInfo>,
    Result<ServerSummary, ConnectionState>,
) {
    let status = match request_runtime_status(api) {
        Ok(status) => status,
        // The Ping itself failed → the host is unreachable; record nothing (no truthful version).
        Err(_) => return (None, Err(ConnectionState::Disconnected)),
    };
    let runtime = RemoteRuntimeInfo {
        version: status.version.clone(),
        protocol: status.protocol,
    };
    if status.protocol != Some(crate::protocol::PROTOCOL_VERSION) {
        // Surface the version anyway — the readout's ⚠ is precisely for this mismatch, and the
        // summary cannot be trusted across a protocol gap.
        return (
            Some(runtime),
            Err(ConnectionState::ProtocolMismatch {
                server_protocol: status.protocol,
                client_protocol: crate::protocol::PROTOCOL_VERSION,
            }),
        );
    }

    let summary = request_server_summary(api).map_err(|_| ConnectionState::Disconnected);
    (Some(runtime), summary)
}

pub(crate) fn request_runtime_status(
    api: &mut impl SupervisorApi,
) -> Result<crate::api::RuntimeStatus, String> {
    let response = api.request(crate::api::schema::Request {
        id: "client-supervisor:status".into(),
        method: crate::api::schema::Method::Ping(crate::api::schema::PingParams::default()),
    })?;
    match response.result {
        crate::api::schema::ResponseResult::Pong {
            version,
            protocol,
            capabilities,
        } => Ok(crate::api::RuntimeStatus {
            version: Some(version),
            protocol: Some(protocol),
            capabilities,
        }),
        other => Err(format!("ping returned unexpected result: {other:?}")),
    }
}

pub(crate) fn request_ui_settings(
    api: &mut impl SupervisorApi,
) -> Result<crate::api::schema::UiSettingsInfo, String> {
    let response = api.request(crate::api::schema::Request {
        id: "client-supervisor:ui-settings".into(),
        method: crate::api::schema::Method::ServerUiSettings(
            crate::api::schema::EmptyParams::default(),
        ),
    })?;
    match response.result {
        crate::api::schema::ResponseResult::UiSettings { settings } => Ok(settings),
        other => Err(format!(
            "server.ui_settings returned unexpected result: {other:?}"
        )),
    }
}

/// #42: a snapshot of the main (local) server's supervisor state — registry + UI settings + the
/// main summary. Fetched off the UI loop (pure I/O via [`fetch_main_supervisor_snapshot`]) and
/// applied back on the loop thread via [`ClientSupervisorModel::apply_main_supervisor_snapshot`],
/// so the render/event-loop thread never blocks on the four local API round-trips.
pub(crate) struct MainSupervisorSnapshot {
    /// `None` when `remote.list` failed this refresh (older/mismatched server, transient timeout);
    /// the apply step then keeps the existing registry instead of wiping it.
    pub(crate) remotes: Option<Vec<crate::remote_registry::RemoteDefinitionSnapshot>>,
    /// `None` when `server.ui_settings` failed this refresh; the apply step keeps prior settings.
    pub(crate) ui_settings: Option<crate::api::schema::UiSettingsInfo>,
    pub(crate) summary: ServerSummary,
}

/// #42: fetch the whole main-server supervisor snapshot in one worker-thread call. Pure blocking
/// I/O — never call this on the render/event-loop thread (it issues `remote.list`,
/// `server.ui_settings`, `workspace.list` + `agent.list` round-trips); spawn it and apply the
/// result via `apply_main_supervisor_snapshot`.
pub(crate) fn fetch_main_supervisor_snapshot(
    api: &mut impl SupervisorApi,
) -> Result<MainSupervisorSnapshot, String> {
    // The main summary (workspaces + agents) is the point of this refresh, so a failure here aborts.
    // `remote.list` and `server.ui_settings` are INDEPENDENT and optional — an older/mismatched main
    // server may not implement `remote.list` at all — so a failure in either must NOT block the
    // others (mirrors `bootstrap_from_main_api`). Chaining all three with `?` previously let a
    // missing `remote.list` permanently stop the main server's own workspace/agent + UI refresh.
    let summary = request_server_summary(api)?;
    let remotes = match request_remote_list(api) {
        Ok(remotes) => Some(remotes),
        Err(err) => {
            tracing::warn!(
                err = %err,
                "main supervisor refresh: remote.list failed (older/mismatched server?); \
                 keeping the existing registry"
            );
            None
        }
    };
    let ui_settings = match request_ui_settings(api) {
        Ok(ui_settings) => Some(ui_settings),
        Err(err) => {
            tracing::warn!(
                err = %err,
                "main supervisor refresh: server.ui_settings failed; keeping the existing settings"
            );
            None
        }
    };
    Ok(MainSupervisorSnapshot {
        remotes,
        ui_settings,
        summary,
    })
}

impl ServerSummary {
    fn from_api(
        workspaces: Vec<crate::api::schema::WorkspaceInfo>,
        agents: Vec<crate::api::schema::AgentInfo>,
    ) -> Self {
        Self {
            workspaces: workspaces
                .into_iter()
                .map(|workspace| WorkspaceSummary {
                    workspace_id: workspace.workspace_id,
                    label: workspace.label,
                    branch: workspace.branch,
                    focused: workspace.focused,
                    // #22: carry the wire worktree group key + linked flag so the client's shared
                    // sidebar grouping renderer can collapse/expand worktree groups.
                    worktree_key: workspace.worktree.as_ref().map(|w| w.repo_key.clone()),
                    worktree_is_linked: workspace
                        .worktree
                        .as_ref()
                        .is_some_and(|w| w.is_linked_worktree),
                    // Plain-git signal for the worktree context-menu rows (older servers
                    // don't send it — the menu then degrades to membership-only, as before).
                    git_repo_key: workspace.git.as_ref().map(|git| git.repo_key.clone()),
                    git_is_linked: workspace
                        .git
                        .as_ref()
                        .is_some_and(|git| git.is_linked_worktree),
                })
                .collect(),
            agents: agents
                .into_iter()
                .map(|agent| {
                    let label = agent_label(&agent);
                    let status = agent_status_label(agent.agent_status);
                    AgentSummary {
                        agent_id: agent.terminal_id,
                        workspace_id: agent.workspace_id,
                        label,
                        status,
                        focused: agent.focused,
                        pane_label: agent.manual_label,
                        tab_id: agent.tab_id,
                        tab_label: agent.tab_label,
                    }
                })
                .collect(),
        }
    }
}

fn agent_label(agent: &crate::api::schema::AgentInfo) -> String {
    agent
        .name
        .as_ref()
        .or(agent.display_agent.as_ref())
        .or(agent.agent.as_ref())
        .or(agent.title.as_ref())
        .cloned()
        .unwrap_or_else(|| agent.terminal_id.clone())
}

fn agent_status_label(status: crate::api::schema::AgentStatus) -> String {
    match status {
        crate::api::schema::AgentStatus::Idle => "idle",
        crate::api::schema::AgentStatus::Working => "working",
        crate::api::schema::AgentStatus::Blocked => "blocked",
        crate::api::schema::AgentStatus::Done => "done",
        crate::api::schema::AgentStatus::Unknown => "unknown",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_remote_in_progress_clears_error_and_animates() {
        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form();
        assert!(!model.add_remote_in_progress());

        model.set_add_remote_error("boom");
        assert!(!model.add_remote_in_progress());
        assert_eq!(
            model.add_remote_form().unwrap().error.as_deref(),
            Some("boom")
        );

        model.set_add_remote_in_progress();
        assert!(model.add_remote_in_progress());
        assert_eq!(model.add_remote_form().unwrap().error, None);
    }

    #[test]
    fn add_remote_error_supersedes_in_progress() {
        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form();
        model.set_add_remote_in_progress();
        assert!(model.add_remote_in_progress());

        // Mirrors the AddRemoteFinished(Err) path: the failure replaces the spinner with an error.
        model.set_add_remote_error("cannot reach host over ssh — check the address");
        assert!(!model.add_remote_in_progress());
        assert!(model
            .add_remote_form()
            .unwrap()
            .error
            .as_deref()
            .is_some_and(|err| err.contains("cannot reach host")));
    }

    #[test]
    fn add_remote_progress_updates_in_flight_line_and_resets_on_resubmit() {
        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form();

        // Progress before the worker starts is ignored (not in progress yet).
        model.set_add_remote_progress("detecting remote platform…");
        assert_eq!(model.add_remote_form().unwrap().progress, None);

        model.set_add_remote_in_progress();
        model.set_add_remote_progress("detecting remote platform…");
        model.set_add_remote_progress("installing herdr on the remote…");
        assert_eq!(
            model.add_remote_form().unwrap().progress.as_deref(),
            Some("installing herdr on the remote…"),
            "the latest provisioning stage should be shown"
        );

        // A terminal error clears the live line so a stale stage never lingers under the error.
        model.set_add_remote_error("boom");
        assert_eq!(model.add_remote_form().unwrap().progress, None);

        // Re-submitting (e.g. after the restart y/N) starts the progress fresh.
        model.set_add_remote_in_progress();
        assert_eq!(model.add_remote_form().unwrap().progress, None);
    }

    #[test]
    fn host_banner_ping_average_caps_at_window_and_reports_rate() {
        let mut model = ClientSupervisorModel::new("local");
        let id = model.add_secondary(local_remote("m", "macmini", Some("macmini")));
        // 11 samples; only the last 10 count: nine 100s + one 40 → (900+40)/10 = 94.
        for ms in [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 40] {
            model.record_server_ping(&id, ms);
        }
        model.set_server_download_bps(&id, 312_000);

        let specs = model.host_banner_specs();
        let (_, spec) = specs
            .iter()
            .find(|(_, spec)| spec.display_name == "macmini")
            .expect("macmini banner spec");
        assert_eq!(spec.latency_ms, Some(94));
        assert_eq!(spec.download_bps, Some(312_000));
    }

    #[test]
    fn workspace_sidebar_row_is_remote_set_in_all_paths() {
        // Path 1: secondary offline placeholder (disconnected, no summary).
        let offline = ServerId::secondary("offline");
        // Path 2: secondary empty-remote placeholder (connected, empty summary).
        let empty = ServerId::secondary("empty");
        // Path 3: secondary normal row (connected, with summary).
        let normal = ServerId::secondary("normal");

        let mut model = ClientSupervisorModel::new("local");
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "main-ws".into(),
                        label: "herdr".into(),
                        branch: None,
                        focused: true,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();
        model.add_secondary(ssh_remote("offline", "off", "off"));
        model.add_secondary(ssh_remote("empty", "emp", "emp"));
        model.add_secondary(ssh_remote("normal", "nrm", "nrm"));

        model
            .set_connection_state(&offline, ConnectionState::Disconnected)
            .unwrap();
        model
            .set_connection_state(&empty, ConnectionState::Connected)
            .unwrap();
        model.set_summary(&empty, ServerSummary::default()).unwrap();
        model
            .set_connection_state(&normal, ConnectionState::Connected)
            .unwrap();
        model
            .set_summary(
                &normal,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "remote-ws".into(),
                        label: "api".into(),
                        branch: None,
                        focused: false,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();

        let rows = model.workspace_rows();
        let row_for = |id: &ServerId| {
            rows.iter()
                .find(|row| &row.server_id == id)
                .expect("row for server")
        };

        // Main server row is local.
        assert!(!row_for(&ServerId::main()).is_remote);
        // All three secondary paths report remote.
        let offline_row = row_for(&offline);
        assert!(offline_row.is_remote);
        assert!(offline_row.workspace_id.is_none());
        let empty_row = row_for(&empty);
        assert!(empty_row.is_remote);
        assert!(empty_row.workspace_id.is_none());
        let normal_row = row_for(&normal);
        assert!(normal_row.is_remote);
        assert!(normal_row.workspace_id.is_some());
    }

    fn ssh_remote(
        id: &str,
        name: &str,
        target: &str,
    ) -> crate::remote_registry::RemoteDefinitionSnapshot {
        crate::remote_registry::RemoteDefinitionSnapshot {
            id: id.into(),
            name: name.into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Ssh {
                target: target.into(),
                args: Vec::new(),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        }
    }

    fn local_remote(
        id: &str,
        name: &str,
        session: Option<&str>,
    ) -> crate::remote_registry::RemoteDefinitionSnapshot {
        crate::remote_registry::RemoteDefinitionSnapshot {
            id: id.into(),
            name: name.into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: session.map(str::to_string),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Server,
            disabled: false,
            auto_update: false,
        }
    }

    fn workspace_info(
        workspace_id: &str,
        label: &str,
        focused: bool,
    ) -> crate::api::schema::WorkspaceInfo {
        crate::api::schema::WorkspaceInfo {
            workspace_id: workspace_id.into(),
            number: 1,
            label: label.into(),
            branch: None,
            focused,
            pane_count: 1,
            tab_count: 1,
            active_tab_id: "tab-1".into(),
            agent_status: crate::api::schema::AgentStatus::Idle,
            tokens: std::collections::HashMap::new(),
            worktree: None,
            git: None,
        }
    }

    fn agent_info(
        terminal_id: &str,
        workspace_id: &str,
        label: &str,
        status: crate::api::schema::AgentStatus,
        focused: bool,
    ) -> crate::api::schema::AgentInfo {
        crate::api::schema::AgentInfo {
            terminal_id: terminal_id.into(),
            name: Some(label.into()),
            manual_label: None,
            agent: None,
            title: None,
            tab_label: None,
            display_agent: None,
            agent_status: status,
            screen_detection_skipped: false,
            state_labels: std::collections::HashMap::new(),
            terminal_title: None,
            terminal_title_stripped: None,
            tokens: std::collections::HashMap::new(),
            agent_session: None,
            workspace_id: workspace_id.into(),
            tab_id: "tab-1".into(),
            pane_id: "pane-1".into(),
            focused,
            launch_pending: false,
            interactive_ready: false,
            state_change_seq: 0,
            cwd: None,
            foreground_cwd: None,
            revision: 1,
        }
    }

    #[derive(Default)]
    struct FakeSupervisorApi {
        requests: Vec<&'static str>,
        remotes: Vec<crate::remote_registry::RemoteDefinitionSnapshot>,
        workspaces: Vec<crate::api::schema::WorkspaceInfo>,
        agents: Vec<crate::api::schema::AgentInfo>,
        ui_settings: crate::api::schema::UiSettingsInfo,
        fail_ui_settings: bool,
        fail_remote_list: bool,
        // #61: the version/protocol this fake answers a Ping with (drives the runtime-status path).
        pong_version: String,
        pong_protocol: u32,
    }

    impl SupervisorApi for FakeSupervisorApi {
        fn request(
            &mut self,
            request: crate::api::schema::Request,
        ) -> Result<crate::api::schema::SuccessResponse, String> {
            let result = match request.method {
                crate::api::schema::Method::Ping(_) => {
                    self.requests.push("ping");
                    crate::api::schema::ResponseResult::Pong {
                        version: self.pong_version.clone(),
                        protocol: self.pong_protocol,
                        capabilities: None,
                    }
                }
                crate::api::schema::Method::RemoteList(_) => {
                    self.requests.push("remote.list");
                    if self.fail_remote_list {
                        // mimic an older server that doesn't know the `remote.list` variant.
                        return Err("invalid request: unknown variant `remote.list`".into());
                    }
                    crate::api::schema::ResponseResult::RemoteList {
                        remotes: self.remotes.clone(),
                    }
                }
                crate::api::schema::Method::WorkspaceList(_) => {
                    self.requests.push("workspace.list");
                    crate::api::schema::ResponseResult::WorkspaceList {
                        workspaces: self.workspaces.clone(),
                    }
                }
                crate::api::schema::Method::AgentList(_) => {
                    self.requests.push("agent.list");
                    crate::api::schema::ResponseResult::AgentList {
                        agents: self.agents.clone(),
                    }
                }
                crate::api::schema::Method::ServerUiSettings(_) => {
                    self.requests.push("server.ui_settings");
                    if self.fail_ui_settings {
                        return Err("settings unavailable".into());
                    }
                    crate::api::schema::ResponseResult::UiSettings {
                        settings: self.ui_settings.clone(),
                    }
                }
                other => return Err(format!("unexpected method: {other:?}")),
            };

            Ok(crate::api::schema::SuccessResponse {
                id: request.id,
                result,
            })
        }
    }

    #[test]
    fn summary_with_runtime_status_captures_version_for_a_matched_live_host() {
        // #61 regression: the summary fetch Pings for the protocol gate; that Pong's `version` used
        // to be discarded, leaving a live host's readout on "unknown". It must now come back so the
        // host-menu version row reflects the connected host.
        let mut api = FakeSupervisorApi {
            pong_version: "0.6.4".into(),
            pong_protocol: crate::protocol::PROTOCOL_VERSION,
            workspaces: vec![workspace_info("main-workspace", "herdr", true)],
            ..FakeSupervisorApi::default()
        };

        let (runtime, result) = summary_with_runtime_status_via_api(&mut api);

        let runtime = runtime.expect("a successful Ping must surface the runtime version/protocol");
        assert_eq!(runtime.version.as_deref(), Some("0.6.4"));
        assert_eq!(runtime.protocol, Some(crate::protocol::PROTOCOL_VERSION));
        assert!(result.is_ok(), "a matched host still returns its summary");
    }

    #[test]
    fn summary_with_runtime_status_records_version_even_on_protocol_mismatch() {
        // #61: a mismatch is exactly when the ⚠ readout (and the auto-update trigger) must show the
        // version — so the runtime info comes back even though the summary errors with the mismatch.
        let mut api = FakeSupervisorApi {
            pong_version: "0.5.0".into(),
            pong_protocol: crate::protocol::PROTOCOL_VERSION.wrapping_add(1),
            ..FakeSupervisorApi::default()
        };

        let (runtime, result) = summary_with_runtime_status_via_api(&mut api);

        let runtime = runtime.expect("a mismatched-but-reachable host still reports its version");
        assert_eq!(runtime.version.as_deref(), Some("0.5.0"));
        assert_eq!(
            runtime.protocol,
            Some(crate::protocol::PROTOCOL_VERSION.wrapping_add(1))
        );
        assert!(matches!(
            result,
            Err(ConnectionState::ProtocolMismatch { .. })
        ));
    }

    #[test]
    fn bootstrap_survives_remote_list_failure_so_remote_menu_stays_available() {
        // An older/mismatched server that doesn't know `remote.list` must NOT disable the client
        // sidebar: bootstrap degrades to an empty registry, the supervisor still builds, and the
        // global menu (incl. add remote / manage remotes) stays available so a first remote can be
        // added. Regression guard for the silent pass-through fallback that hid the remote menus.
        let mut api = FakeSupervisorApi {
            fail_remote_list: true,
            workspaces: vec![workspace_info("main-workspace", "herdr", true)],
            ..FakeSupervisorApi::default()
        };

        let model = bootstrap_from_main_api(&mut api, "local")
            .expect("bootstrap must succeed despite remote.list failing");

        // remote.list was attempted, then bootstrap CONTINUED to summary + ui settings.
        assert_eq!(
            api.requests,
            vec![
                "remote.list",
                "workspace.list",
                "agent.list",
                "server.ui_settings"
            ]
        );
        // empty registry → only the main server row, no secondaries.
        assert_eq!(
            model.workspace_rows(),
            vec![WorkspaceSidebarRow {
                server_id: ServerId::main(),
                workspace_id: Some("main-workspace".into()),
                label: "herdr".into(),
                branch: None,
                focused: true,
                disabled: false,
                is_remote: false,
                worktree_key: None,
                worktree_is_linked: false,
            }]
        );
        // the client-owned global menu still offers add remote / manage remotes.
        assert_eq!(
            model.client_global_menu_items(),
            [
                "settings",
                "keybinds",
                "reload config",
                "detach",
                "add remote",
                "manage remotes"
            ]
        );
    }

    #[test]
    fn fetch_and_apply_main_supervisor_snapshot_updates_registry_ui_and_summary() {
        // #42: the off-loop fetch + on-loop apply must reproduce exactly what the old inline
        // blocking refresh did — registry, ui-settings, and the main summary all land.
        let ui = crate::api::schema::UiSettingsInfo {
            sidebar_default_width: 41, // non-default marker proving ui-settings applied
            ..Default::default()
        };
        let mut api = FakeSupervisorApi {
            remotes: vec![ssh_remote("r1", "alpha", "alpha")],
            workspaces: vec![workspace_info("ws-1", "one", true)],
            agents: vec![],
            ui_settings: ui,
            ..FakeSupervisorApi::default()
        };

        let snapshot = fetch_main_supervisor_snapshot(&mut api).expect("snapshot");
        let mut model = ClientSupervisorModel::new("local");
        model.apply_main_supervisor_snapshot(snapshot);

        assert!(
            model.server_for_test(&ServerId::secondary("r1")).is_some(),
            "registry applied"
        );
        assert_eq!(
            model.ui_settings().sidebar_default_width,
            41,
            "ui-settings applied"
        );
        assert!(
            model
                .workspace_rows()
                .iter()
                .any(|row| row.server_id == ServerId::main()
                    && row.workspace_id.as_deref() == Some("ws-1")),
            "main summary applied"
        );
    }

    #[test]
    fn bootstrap_from_main_api_fetches_registry_summary_and_connection_plans() {
        let mut api = FakeSupervisorApi {
            remotes: vec![
                ssh_remote("remote-ssh", "prod", "prod.example.com"),
                local_remote("remote-dev", "dev", Some("dev")),
            ],
            workspaces: vec![workspace_info("main-workspace", "herdr", true)],
            agents: vec![agent_info(
                "terminal-1",
                "main-workspace",
                "claude",
                crate::api::schema::AgentStatus::Working,
                true,
            )],
            ..FakeSupervisorApi::default()
        };

        let model = bootstrap_from_main_api(&mut api, "local").unwrap();

        assert_eq!(
            api.requests,
            vec![
                "remote.list",
                "workspace.list",
                "agent.list",
                "server.ui_settings"
            ]
        );
        assert_eq!(
            model.workspace_rows(),
            vec![
                WorkspaceSidebarRow {
                    server_id: ServerId::main(),
                    workspace_id: Some("main-workspace".into()),
                    label: "herdr".into(),
                    branch: None,
                    focused: true,
                    disabled: false,
                    is_remote: false,
                    worktree_key: None,
                    worktree_is_linked: false,
                },
                WorkspaceSidebarRow {
                    server_id: ServerId::secondary("remote-ssh"),
                    workspace_id: None,
                    label: "connecting".into(),
                    branch: None,
                    focused: false,
                    disabled: true,
                    is_remote: true,
                    worktree_key: None,
                    worktree_is_linked: false,
                },
                WorkspaceSidebarRow {
                    server_id: ServerId::secondary("remote-dev"),
                    workspace_id: None,
                    label: "connecting".into(),
                    branch: None,
                    focused: false,
                    disabled: true,
                    is_remote: true,
                    worktree_key: None,
                    worktree_is_linked: false,
                },
            ]
        );
        assert_eq!(
            model.agent_groups(),
            vec![AgentSidebarGroup {
                server_id: ServerId::main(),
                workspace_id: "main-workspace".into(),
                label: "herdr".into(),
                focused: true,
                agents: vec![AgentSidebarRow {
                    agent_id: "terminal-1".into(),
                    label: "claude".into(),
                    status: "working".into(),
                    focused: true,
                    pane_label: None,
                    tab_id: "tab-1".into(),
                    tab_label: None,
                }],
            }]
        );
        assert_eq!(
            model.secondary_connection_plans(),
            vec![
                SecondaryConnectionPlan {
                    server_id: ServerId::secondary("remote-dev"),
                    display_name: "dev".into(),
                    target: ServerConnectionTarget::LocalSession(Some("dev".into())),
                    keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Server,
                },
                SecondaryConnectionPlan {
                    server_id: ServerId::secondary("remote-ssh"),
                    display_name: "prod".into(),
                    target: ServerConnectionTarget::Ssh {
                        destination: "prod.example.com".into(),
                        options: Vec::new(),
                        session: None,
                    },
                    keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
                },
            ]
        );
    }

    #[test]
    fn bootstrap_from_main_api_stores_main_ui_settings_snapshot() {
        let mut ui_settings = crate::api::schema::UiSettingsInfo {
            sidebar_width: 33,
            ..crate::api::schema::UiSettingsInfo::default()
        };
        crate::app::state::SidebarSpaceItem::Branch
            .set_enabled(&mut ui_settings.sidebar_spaces, false);
        let mut api = FakeSupervisorApi {
            workspaces: vec![workspace_info("main-workspace", "herdr", true)],
            ui_settings: ui_settings.clone(),
            ..FakeSupervisorApi::default()
        };

        let model = bootstrap_from_main_api(&mut api, "local").unwrap();

        assert_eq!(model.ui_settings(), &ui_settings);
        assert_eq!(
            api.requests,
            vec![
                "remote.list",
                "workspace.list",
                "agent.list",
                "server.ui_settings"
            ]
        );
    }

    #[test]
    fn bootstrap_from_main_api_keeps_default_ui_settings_when_snapshot_fails() {
        let mut api = FakeSupervisorApi {
            workspaces: vec![workspace_info("main-workspace", "herdr", true)],
            fail_ui_settings: true,
            ..FakeSupervisorApi::default()
        };

        let model = bootstrap_from_main_api(&mut api, "local").unwrap();

        assert_eq!(
            model.ui_settings(),
            &crate::api::schema::UiSettingsInfo::default()
        );
        assert_eq!(
            api.requests,
            vec![
                "remote.list",
                "workspace.list",
                "agent.list",
                "server.ui_settings"
            ]
        );
    }

    #[test]
    fn refresh_main_summary_from_api_replaces_main_summary_only() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model
            .set_summary(
                &remote_id,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "remote-api".into(),
                        label: "api".into(),
                        branch: None,
                        focused: false,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();
        let mut api = FakeSupervisorApi {
            workspaces: vec![workspace_info("main-updated", "herdr", true)],
            agents: vec![agent_info(
                "main-agent",
                "main-updated",
                "claude",
                crate::api::schema::AgentStatus::Idle,
                true,
            )],
            ..FakeSupervisorApi::default()
        };

        model.refresh_main_summary_from_api(&mut api).unwrap();

        assert_eq!(api.requests, vec!["workspace.list", "agent.list"]);
        assert_eq!(
            model.workspace_rows(),
            vec![
                WorkspaceSidebarRow {
                    server_id: ServerId::main(),
                    workspace_id: Some("main-updated".into()),
                    label: "herdr".into(),
                    branch: None,
                    focused: true,
                    disabled: false,
                    is_remote: false,
                    worktree_key: None,
                    worktree_is_linked: false,
                },
                WorkspaceSidebarRow {
                    server_id: remote_id,
                    workspace_id: Some("remote-api".into()),
                    label: "api".into(),
                    branch: None,
                    focused: false,
                    disabled: false,
                    is_remote: true,
                    worktree_key: None,
                    worktree_is_linked: false,
                },
            ]
        );
    }

    #[test]
    fn refresh_secondary_summaries_visits_local_first_and_marks_per_server_state() {
        let mut model = ClientSupervisorModel::new("local");
        model.sync_remote_registry(vec![
            ssh_remote("remote-ssh", "prod", "prod.example.com"),
            local_remote("remote-dev", "dev", Some("dev")),
        ]);
        let mut visited = Vec::new();

        model.refresh_secondary_summaries(|plan| {
            visited.push(plan.target.clone());
            match &plan.target {
                ServerConnectionTarget::LocalSession(_) => Ok(ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "dev-workspace".into(),
                        label: "api".into(),
                        branch: None,
                        focused: false,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                }),
                ServerConnectionTarget::Ssh { .. } => Err(ConnectionState::ProtocolMismatch {
                    server_protocol: Some(10),
                    client_protocol: crate::protocol::PROTOCOL_VERSION,
                }),
                ServerConnectionTarget::Main => unreachable!("secondary plans never include main"),
            }
        });

        assert_eq!(
            visited,
            vec![
                ServerConnectionTarget::LocalSession(Some("dev".into())),
                ServerConnectionTarget::Ssh {
                    destination: "prod.example.com".into(),
                    options: Vec::new(),
                    session: None,
                },
            ]
        );
        assert_eq!(
            model.workspace_rows(),
            vec![
                WorkspaceSidebarRow {
                    server_id: ServerId::secondary("remote-ssh"),
                    workspace_id: None,
                    label: "protocol mismatch".into(),
                    branch: None,
                    focused: false,
                    disabled: true,
                    is_remote: true,
                    worktree_key: None,
                    worktree_is_linked: false,
                },
                WorkspaceSidebarRow {
                    server_id: ServerId::secondary("remote-dev"),
                    workspace_id: Some("dev-workspace".into()),
                    label: "api".into(),
                    branch: None,
                    focused: false,
                    disabled: false,
                    is_remote: true,
                    worktree_key: None,
                    worktree_is_linked: false,
                },
            ]
        );
    }

    #[test]
    fn server_filter_cycles_all_main_then_secondary_registry_order() {
        let mut model = ClientSupervisorModel::new("local");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model.add_secondary(ssh_remote("remote-y", "y", "y"));

        assert_eq!(model.filter(), &ServerFilter::All);
        assert_eq!(model.filter_label(), "all");

        model.cycle_filter();
        assert_eq!(model.filter(), &ServerFilter::Server(ServerId::main()));
        assert_eq!(model.filter_label(), "local");

        model.cycle_filter();
        assert_eq!(
            model.filter(),
            &ServerFilter::Server(ServerId::secondary("remote-x"))
        );
        assert_eq!(model.filter_label(), "x");

        model.cycle_filter();
        assert_eq!(
            model.filter(),
            &ServerFilter::Server(ServerId::secondary("remote-y"))
        );
        assert_eq!(model.filter_label(), "y");

        model.cycle_filter();
        assert_eq!(model.filter(), &ServerFilter::All);
        assert_eq!(model.filter_label(), "all");
    }

    #[test]
    fn removing_selected_remote_falls_back_to_all_and_main_active_server() {
        let mut model = ClientSupervisorModel::new("local");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        let remote_id = ServerId::secondary("remote-x");
        model.set_filter(ServerFilter::Server(remote_id.clone()));
        model.set_active_server(remote_id.clone()).unwrap();

        let removed = model.remove_secondary(&remote_id);

        assert!(removed);
        assert_eq!(model.filter(), &ServerFilter::All);
        assert_eq!(model.active_server_id(), &ServerId::main());
    }

    #[test]
    fn new_workspace_route_uses_filter_or_picker() {
        let mut model = ClientSupervisorModel::new("local");

        assert_eq!(
            model.new_workspace_route(),
            NewWorkspaceRoute::CreateOn(ServerId::main())
        );

        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        assert_eq!(
            model.new_workspace_route(),
            NewWorkspaceRoute::PickDestination(vec![
                ServerDestination {
                    server_id: ServerId::main(),
                    display_name: "local".into(),
                },
                ServerDestination {
                    server_id: ServerId::secondary("remote-x"),
                    display_name: "x".into(),
                },
            ])
        );

        model.set_filter(ServerFilter::Server(ServerId::secondary("remote-x")));
        assert_eq!(
            model.new_workspace_route(),
            NewWorkspaceRoute::CreateOn(ServerId::secondary("remote-x"))
        );
    }

    #[test]
    fn new_workspace_route_builds_focused_create_request_for_single_destination() {
        let mut model = ClientSupervisorModel::new("local");
        model.set_filter(ServerFilter::Server(ServerId::main()));
        let route = model.new_workspace_route();

        assert_eq!(
            route.api_request("client:workspace-create"),
            Some((
                ServerId::main(),
                crate::api::schema::Request {
                    id: "client:workspace-create".into(),
                    method: crate::api::schema::Method::WorkspaceCreate(
                        crate::api::schema::WorkspaceCreateParams {
                            cwd: None,
                            focus: true,
                            label: None,
                            env: std::collections::HashMap::new(),
                        },
                    ),
                }
            ))
        );
    }

    #[test]
    fn new_workspace_route_waits_for_picker_when_multiple_destinations_exist() {
        let mut model = ClientSupervisorModel::new("local");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        let route = model.new_workspace_route();

        assert_eq!(route.api_request("client:workspace-create"), None);
    }

    #[test]
    fn opening_new_workspace_picker_tracks_connected_destinations() {
        let mut model = ClientSupervisorModel::new("local");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        let expected = vec![
            ServerDestination {
                server_id: ServerId::main(),
                display_name: "local".into(),
            },
            ServerDestination {
                server_id: ServerId::secondary("remote-x"),
                display_name: "x".into(),
            },
        ];

        let route = model.open_new_workspace_picker();

        assert_eq!(route, NewWorkspaceRoute::PickDestination(expected.clone()));
        assert_eq!(
            model.new_workspace_picker_destinations(),
            Some(expected.as_slice())
        );
    }

    #[test]
    fn open_new_workspace_picker_keeps_single_remaining_destination() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model.open_new_workspace_picker();

        model
            .set_connection_state(&remote_id, ConnectionState::Disconnected)
            .unwrap();

        let expected = vec![ServerDestination {
            server_id: ServerId::main(),
            display_name: "local".into(),
        }];
        assert_eq!(
            model.new_workspace_picker_destinations(),
            Some(expected.as_slice())
        );
    }

    #[test]
    fn secondary_server_id_cannot_collide_with_main_server_id() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(local_remote("main", "remote main", Some("main")));

        assert_ne!(remote_id, ServerId::main());
        assert_eq!(
            model
                .servers
                .iter()
                .filter(|server| server.id == ServerId::main())
                .count(),
            1
        );
        assert_eq!(
            model.server(&remote_id).map(|server| server.role),
            Some(ServerRole::Secondary)
        );
    }

    #[test]
    fn choosing_new_workspace_destination_routes_create_and_switches_active_server() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model.open_new_workspace_picker();

        let route = model.choose_new_workspace_destination(&remote_id);

        assert_eq!(route, NewWorkspaceRoute::CreateOn(remote_id.clone()));
        assert_eq!(model.active_server_id(), &remote_id);
        assert_eq!(model.new_workspace_picker_destinations(), None);
        assert_eq!(
            route.api_request("client:workspace-create"),
            Some((
                remote_id,
                crate::api::schema::Request {
                    id: "client:workspace-create".into(),
                    method: crate::api::schema::Method::WorkspaceCreate(
                        crate::api::schema::WorkspaceCreateParams {
                            cwd: None,
                            focus: true,
                            label: None,
                            env: std::collections::HashMap::new(),
                        },
                    ),
                },
            ))
        );
    }

    #[test]
    fn new_workspace_picker_selection_defaults_to_zero_and_moves() {
        let mut model = ClientSupervisorModel::new("local");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model.add_secondary(ssh_remote("remote-y", "y", "y"));

        model.open_new_workspace_picker();
        assert_eq!(model.new_workspace_picker().map(|p| p.selected), Some(0));

        model.move_new_workspace_picker_next();
        assert_eq!(model.new_workspace_picker().map(|p| p.selected), Some(1));
        model.move_new_workspace_picker_next();
        assert_eq!(model.new_workspace_picker().map(|p| p.selected), Some(2));
        // saturates at the last destination (main + 2 remotes == 3).
        model.move_new_workspace_picker_next();
        assert_eq!(model.new_workspace_picker().map(|p| p.selected), Some(2));

        model.move_new_workspace_picker_prev();
        assert_eq!(model.new_workspace_picker().map(|p| p.selected), Some(1));
        model.move_new_workspace_picker_prev();
        model.move_new_workspace_picker_prev();
        // saturates at the first destination.
        assert_eq!(model.new_workspace_picker().map(|p| p.selected), Some(0));
    }

    #[test]
    fn new_workspace_picker_clamps_selection_on_reconcile() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model.open_new_workspace_picker();
        // highlight the last destination (the remote).
        model.move_new_workspace_picker_next();
        assert_eq!(model.new_workspace_picker().map(|p| p.selected), Some(1));

        // disconnecting the highlighted destination triggers reconcile.
        model
            .set_connection_state(&remote_id, ConnectionState::Disconnected)
            .unwrap();

        let picker = model.new_workspace_picker().expect("picker remains open");
        assert!(picker.selected < picker.destinations.len());
        assert_eq!(picker.selected, 0);
    }

    #[test]
    fn closing_picker_clears_selection() {
        let mut model = ClientSupervisorModel::new("local");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model.open_new_workspace_picker();
        assert!(model.new_workspace_picker().is_some());

        model.close_new_workspace_picker();
        assert_eq!(model.new_workspace_picker(), None);
    }

    #[test]
    fn new_workspace_picker_single_destination_skips_modal() {
        let mut model = ClientSupervisorModel::new("local");

        let route = model.open_new_workspace_picker();

        assert_eq!(route, NewWorkspaceRoute::CreateOn(ServerId::main()));
        assert_eq!(model.new_workspace_picker(), None);
    }

    #[test]
    fn accept_new_workspace_picker_returns_highlighted_route() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model.open_new_workspace_picker();
        // move the highlight onto the remote destination.
        model.move_new_workspace_picker_next();

        let route = model.accept_new_workspace_picker();

        assert_eq!(route, NewWorkspaceRoute::CreateOn(remote_id.clone()));
        assert_eq!(model.active_server_id(), &remote_id);
        assert_eq!(model.new_workspace_picker(), None);
    }

    #[test]
    fn disconnected_filtered_server_does_not_route_new_workspace_elsewhere() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model
            .set_connection_state(&remote_id, ConnectionState::Disconnected)
            .unwrap();
        model.set_filter(ServerFilter::Server(remote_id));

        assert_eq!(
            model.new_workspace_route(),
            NewWorkspaceRoute::Unavailable {
                server_id: ServerId::secondary("remote-x"),
                reason: "server disconnected".into(),
            }
        );
    }

    #[test]
    fn unavailable_filtered_server_reports_specific_connection_state() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model.set_filter(ServerFilter::Server(remote_id.clone()));

        model
            .set_connection_state(&remote_id, ConnectionState::Connecting)
            .unwrap();
        assert_eq!(
            model.new_workspace_route(),
            NewWorkspaceRoute::Unavailable {
                server_id: remote_id.clone(),
                reason: "server connecting".into(),
            }
        );

        model
            .set_connection_state(
                &remote_id,
                ConnectionState::ProtocolMismatch {
                    server_protocol: Some(10),
                    client_protocol: 11,
                },
            )
            .unwrap();
        assert_eq!(
            model.new_workspace_route(),
            NewWorkspaceRoute::Unavailable {
                server_id: remote_id,
                reason: "protocol mismatch".into(),
            }
        );
    }

    #[test]
    fn active_remote_falls_back_to_main_when_connection_becomes_unavailable() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model.set_active_server(remote_id.clone()).unwrap();

        model
            .set_connection_state(&remote_id, ConnectionState::Disconnected)
            .unwrap();

        assert_eq!(model.active_server_id(), &ServerId::main());
    }

    #[test]
    fn workspace_label_drops_host_prefix() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "main-herdr".into(),
                        label: "herdr".into(),
                        branch: None,
                        focused: true,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();
        model
            .set_summary(
                &remote_id,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "remote-herdr".into(),
                        label: "herdr".into(),
                        branch: None,
                        focused: false,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();

        assert_eq!(
            model.workspace_rows(),
            vec![
                WorkspaceSidebarRow {
                    server_id: ServerId::main(),
                    workspace_id: Some("main-herdr".into()),
                    label: "herdr".into(),
                    branch: None,
                    focused: true,
                    disabled: false,
                    is_remote: false,
                    worktree_key: None,
                    worktree_is_linked: false,
                },
                WorkspaceSidebarRow {
                    server_id: remote_id.clone(),
                    workspace_id: Some("remote-herdr".into()),
                    // item 2 (C3): bare label even in the `All` filter — host identity is the
                    // banner above, not a jammed prefix.
                    label: "herdr".into(),
                    branch: None,
                    focused: false,
                    disabled: false,
                    is_remote: true,
                    worktree_key: None,
                    worktree_is_linked: false,
                },
            ]
        );

        model.set_filter(ServerFilter::Server(remote_id.clone()));
        assert_eq!(
            model.workspace_rows(),
            vec![WorkspaceSidebarRow {
                server_id: remote_id,
                workspace_id: Some("remote-herdr".into()),
                label: "herdr".into(),
                branch: None,
                focused: false,
                disabled: false,
                is_remote: true,
                worktree_key: None,
                worktree_is_linked: false,
            }]
        );
    }

    #[test]
    fn offline_remote_without_summary_renders_disabled_workspace_row() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model
            .set_connection_state(&remote_id, ConnectionState::Disconnected)
            .unwrap();

        assert_eq!(
            model.workspace_rows(),
            vec![WorkspaceSidebarRow {
                server_id: remote_id.clone(),
                workspace_id: None,
                label: "offline".into(),
                branch: None,
                focused: false,
                disabled: true,
                is_remote: true,
                worktree_key: None,
                worktree_is_linked: false,
            }]
        );

        model.set_filter(ServerFilter::Server(remote_id.clone()));
        assert_eq!(
            model.workspace_rows(),
            vec![WorkspaceSidebarRow {
                server_id: remote_id,
                workspace_id: None,
                label: "offline".into(),
                branch: None,
                focused: false,
                disabled: true,
                is_remote: true,
                worktree_key: None,
                worktree_is_linked: false,
            }]
        );
    }

    #[test]
    fn connected_empty_remote_renders_empty_workspace_row() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model
            .set_summary(&remote_id, ServerSummary::default())
            .unwrap();

        assert_eq!(
            model.workspace_rows(),
            vec![WorkspaceSidebarRow {
                server_id: remote_id,
                workspace_id: None,
                label: "no workspaces".into(),
                branch: None,
                focused: false,
                disabled: true,
                is_remote: true,
                worktree_key: None,
                worktree_is_linked: false,
            }]
        );
    }

    #[test]
    fn agent_group_label_has_no_host_prefix() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "main-herdr".into(),
                        label: "herdr".into(),
                        branch: None,
                        focused: false,
                        ..Default::default()
                    }],
                    agents: vec![AgentSummary {
                        agent_id: "main-agent".into(),
                        workspace_id: "main-herdr".into(),
                        label: "claude".into(),
                        status: "idle".into(),
                        focused: false,
                        pane_label: None,
                        tab_id: String::new(),
                        tab_label: None,
                    }],
                },
            )
            .unwrap();
        model
            .set_summary(
                &remote_id,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "remote-herdr".into(),
                        label: "herdr".into(),
                        branch: None,
                        focused: true,
                        ..Default::default()
                    }],
                    agents: vec![AgentSummary {
                        agent_id: "remote-agent".into(),
                        workspace_id: "remote-herdr".into(),
                        label: "claude".into(),
                        status: "idle".into(),
                        focused: true,
                        pane_label: None,
                        tab_id: String::new(),
                        tab_label: None,
                    }],
                },
            )
            .unwrap();

        assert_eq!(
            model.agent_groups(),
            vec![
                AgentSidebarGroup {
                    server_id: ServerId::main(),
                    workspace_id: "main-herdr".into(),
                    label: "herdr".into(),
                    focused: false,
                    agents: vec![AgentSidebarRow {
                        agent_id: "main-agent".into(),
                        label: "claude".into(),
                        status: "idle".into(),
                        focused: false,
                        pane_label: None,
                        tab_id: String::new(),
                        tab_label: None,
                    }],
                },
                AgentSidebarGroup {
                    server_id: remote_id.clone(),
                    workspace_id: "remote-herdr".into(),
                    label: "herdr".into(),
                    focused: true,
                    agents: vec![AgentSidebarRow {
                        agent_id: "remote-agent".into(),
                        label: "claude".into(),
                        status: "idle".into(),
                        focused: true,
                        pane_label: None,
                        tab_id: String::new(),
                        tab_label: None,
                    }],
                },
            ]
        );

        model.set_filter(ServerFilter::Server(remote_id.clone()));
        assert_eq!(
            model.agent_groups(),
            vec![AgentSidebarGroup {
                server_id: remote_id,
                workspace_id: "remote-herdr".into(),
                label: "herdr".into(),
                focused: true,
                agents: vec![AgentSidebarRow {
                    agent_id: "remote-agent".into(),
                    label: "claude".into(),
                    status: "idle".into(),
                    focused: true,
                    pane_label: None,
                    tab_id: String::new(),
                    tab_label: None,
                }],
            }]
        );
    }

    #[test]
    fn focus_workspace_route_switches_active_server_for_connected_owner() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model
            .set_summary(
                &remote_id,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "remote-api".into(),
                        label: "api".into(),
                        branch: None,
                        focused: false,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();

        let route = model.focus_workspace_route(&remote_id, "remote-api");

        assert_eq!(
            route,
            FocusRoute::Workspace {
                server_id: remote_id.clone(),
                workspace_id: "remote-api".into(),
            }
        );
        assert_eq!(model.active_server_id(), &remote_id);
        assert_eq!(
            route.api_request("client:workspace-focus"),
            Some(crate::api::schema::Request {
                id: "client:workspace-focus".into(),
                method: crate::api::schema::Method::WorkspaceFocus(
                    crate::api::schema::WorkspaceTarget {
                        workspace_id: "remote-api".into(),
                    },
                ),
            })
        );
    }

    #[test]
    fn focus_agent_route_switches_active_server_for_connected_owner() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model
            .set_summary(
                &remote_id,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "remote-api".into(),
                        label: "api".into(),
                        branch: None,
                        focused: false,
                        ..Default::default()
                    }],
                    agents: vec![AgentSummary {
                        agent_id: "remote-agent".into(),
                        workspace_id: "remote-api".into(),
                        label: "claude".into(),
                        status: "idle".into(),
                        focused: false,
                        pane_label: None,
                        tab_id: String::new(),
                        tab_label: None,
                    }],
                },
            )
            .unwrap();

        let route = model.focus_agent_route(&remote_id, "remote-agent");

        assert_eq!(
            route,
            FocusRoute::Agent {
                server_id: remote_id.clone(),
                target: "remote-agent".into(),
            }
        );
        assert_eq!(model.active_server_id(), &remote_id);
        assert_eq!(
            route.api_request("client:agent-focus"),
            Some(crate::api::schema::Request {
                id: "client:agent-focus".into(),
                method: crate::api::schema::Method::AgentFocus(crate::api::schema::AgentTarget {
                    target: "remote-agent".into(),
                },),
            })
        );
    }

    #[test]
    fn focus_route_rejects_disconnected_owner_without_fallback() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model
            .set_connection_state(&remote_id, ConnectionState::Disconnected)
            .unwrap();

        let route = model.focus_workspace_route(&remote_id, "remote-api");

        assert_eq!(
            route,
            FocusRoute::Unavailable {
                server_id: remote_id,
                reason: "server disconnected".into(),
            }
        );
        assert_eq!(model.active_server_id(), &ServerId::main());
        assert_eq!(route.api_request("client:workspace-focus"), None);
    }

    #[test]
    fn focus_route_does_not_send_unknown_rows() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));

        let route = model.focus_agent_route(&remote_id, "missing-agent");

        assert_eq!(route, FocusRoute::NotFound);
        assert_eq!(model.active_server_id(), &ServerId::main());
        assert_eq!(route.api_request("client:agent-focus"), None);
    }

    // item 6 (Area 6): optimistic focus override tests. A connected remote with two workspaces
    // and one agent so the override can be observed across `workspace_rows()`/`agent_groups()`.
    fn optimistic_focus_model() -> (ClientSupervisorModel, ServerId) {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model
            .set_summary(
                &remote_id,
                ServerSummary {
                    workspaces: vec![
                        WorkspaceSummary {
                            workspace_id: "remote-api".into(),
                            label: "api".into(),
                            branch: None,
                            focused: false,
                            ..Default::default()
                        },
                        WorkspaceSummary {
                            workspace_id: "remote-web".into(),
                            label: "web".into(),
                            branch: None,
                            focused: true,
                            ..Default::default()
                        },
                    ],
                    agents: vec![AgentSummary {
                        agent_id: "remote-agent".into(),
                        workspace_id: "remote-api".into(),
                        label: "claude".into(),
                        status: "idle".into(),
                        focused: false,
                        pane_label: None,
                        tab_id: String::new(),
                        tab_label: None,
                    }],
                },
            )
            .unwrap();
        (model, remote_id)
    }

    #[test]
    fn focus_workspace_route_sets_optimistic_focus() {
        let (mut model, remote_id) = optimistic_focus_model();

        // Pre-focus: the summary's `remote-web` row is the focused remote row.
        assert!(model
            .workspace_rows()
            .iter()
            .any(|row| row.workspace_id.as_deref() == Some("remote-web") && row.focused));

        model.focus_workspace_route(&remote_id, "remote-api");

        let rows = model.workspace_rows();
        let remote_rows: Vec<_> = rows
            .iter()
            .filter(|row| row.server_id == remote_id)
            .collect();
        assert!(
            remote_rows
                .iter()
                .filter(|row| row.focused)
                .all(|row| row.workspace_id.as_deref() == Some("remote-api")),
            "only the optimistic target should be focused"
        );
        assert!(remote_rows
            .iter()
            .any(|row| row.workspace_id.as_deref() == Some("remote-api") && row.focused));
        // Every OTHER remote row is now unfocused (summary `focused` cleared on this server).
        assert!(remote_rows
            .iter()
            .filter(|row| row.workspace_id.as_deref() != Some("remote-api"))
            .all(|row| !row.focused));
    }

    #[test]
    fn focus_agent_route_sets_optimistic_focus() {
        let (mut model, remote_id) = optimistic_focus_model();

        model.focus_agent_route(&remote_id, "remote-agent");

        let groups = model.agent_groups();
        let group = groups
            .iter()
            .find(|group| group.workspace_id == "remote-api")
            .expect("agent's workspace group should exist");
        assert!(
            group.focused,
            "the agent's group (spaces highlight) follows"
        );
        assert!(group
            .agents
            .iter()
            .any(|agent| agent.agent_id == "remote-agent" && agent.focused));

        // The agent's workspace row also follows in `workspace_rows()`.
        let rows = model.workspace_rows();
        assert!(rows
            .iter()
            .any(|row| row.workspace_id.as_deref() == Some("remote-api") && row.focused));
        assert!(rows
            .iter()
            .filter(|row| row.server_id == remote_id)
            .filter(|row| row.workspace_id.as_deref() != Some("remote-api"))
            .all(|row| !row.focused));
    }

    /// #39: a summary fetched BEFORE the focus request landed (still reporting the OLD focus)
    /// must not snap the highlight back to the old row — the optimistic override survives
    /// disagreeing applies within the stale budget.
    #[test]
    fn optimistic_focus_survives_stale_summary() {
        let (mut model, remote_id) = optimistic_focus_model();

        model.focus_workspace_route(&remote_id, "remote-api");
        // A stale in-flight summary still reporting the pre-click focus (remote-web).
        let stale = ServerSummary {
            workspaces: vec![
                WorkspaceSummary {
                    workspace_id: "remote-api".into(),
                    label: "api".into(),
                    branch: None,
                    focused: false,
                    ..Default::default()
                },
                WorkspaceSummary {
                    workspace_id: "remote-web".into(),
                    label: "web".into(),
                    branch: None,
                    focused: true,
                    ..Default::default()
                },
            ],
            agents: Vec::new(),
        };
        model.apply_secondary_summary_results([(remote_id.clone(), Ok(stale.clone()))]);
        assert!(
            model
                .workspace_rows()
                .iter()
                .any(|row| row.workspace_id.as_deref() == Some("remote-api") && row.focused),
            "the clicked row stays highlighted through a stale summary apply"
        );

        // The next poll reflects the applied focus — the override retires and truth carries on.
        let confirming = ServerSummary {
            workspaces: vec![
                WorkspaceSummary {
                    workspace_id: "remote-api".into(),
                    label: "api".into(),
                    branch: None,
                    focused: true,
                    ..Default::default()
                },
                WorkspaceSummary {
                    workspace_id: "remote-web".into(),
                    label: "web".into(),
                    branch: None,
                    focused: false,
                    ..Default::default()
                },
            ],
            agents: Vec::new(),
        };
        model.apply_secondary_summary_results([(remote_id.clone(), Ok(confirming))]);
        // After retirement, a LATER server-side focus change is honored (no pinning).
        model.apply_secondary_summary_results([(remote_id.clone(), Ok(stale))]);
        assert!(
            model
                .workspace_rows()
                .iter()
                .any(|row| row.workspace_id.as_deref() == Some("remote-web") && row.focused),
            "once confirmed and retired, summary truth drives the highlight again"
        );
    }

    /// #39: an agent-focus click must survive a stale summary too — including via `set_summary`
    /// (the main-server apply path).
    #[test]
    fn optimistic_agent_focus_survives_stale_set_summary() {
        let (mut model, remote_id) = optimistic_focus_model();

        model.focus_agent_route(&remote_id, "remote-agent");
        model
            .set_summary(
                &remote_id,
                ServerSummary {
                    workspaces: vec![
                        WorkspaceSummary {
                            workspace_id: "remote-api".into(),
                            label: "api".into(),
                            branch: None,
                            focused: false,
                            ..Default::default()
                        },
                        WorkspaceSummary {
                            workspace_id: "remote-web".into(),
                            label: "web".into(),
                            branch: None,
                            focused: true,
                            ..Default::default()
                        },
                    ],
                    agents: vec![AgentSummary {
                        agent_id: "remote-agent".into(),
                        workspace_id: "remote-api".into(),
                        label: "claude".into(),
                        status: "idle".into(),
                        focused: false,
                        pane_label: None,
                        tab_id: String::new(),
                        tab_label: None,
                    }],
                },
            )
            .unwrap();
        let groups = model.agent_groups();
        assert!(
            groups
                .iter()
                .flat_map(|group| group.agents.iter())
                .any(|agent| agent.agent_id == "remote-agent" && agent.focused),
            "the clicked agent stays highlighted through a stale set_summary"
        );
    }

    /// #39: a focus request that silently never lands must not pin the highlight forever —
    /// after the stale-apply budget, summary truth wins.
    #[test]
    fn optimistic_focus_expires_after_stale_apply_budget() {
        let (mut model, remote_id) = optimistic_focus_model();

        model.focus_workspace_route(&remote_id, "remote-api");
        let stale = ServerSummary {
            workspaces: vec![
                WorkspaceSummary {
                    workspace_id: "remote-api".into(),
                    label: "api".into(),
                    branch: None,
                    focused: false,
                    ..Default::default()
                },
                WorkspaceSummary {
                    workspace_id: "remote-web".into(),
                    label: "web".into(),
                    branch: None,
                    focused: true,
                    ..Default::default()
                },
            ],
            agents: Vec::new(),
        };
        for _ in 0..OPTIMISTIC_FOCUS_MAX_STALE_APPLIES {
            model.apply_secondary_summary_results([(remote_id.clone(), Ok(stale.clone()))]);
        }
        assert!(
            model
                .workspace_rows()
                .iter()
                .any(|row| row.workspace_id.as_deref() == Some("remote-web") && row.focused),
            "after the stale budget the summary's focused row wins"
        );
        assert!(model
            .workspace_rows()
            .iter()
            .filter(|row| row.workspace_id.as_deref() != Some("remote-web"))
            .all(|row| !row.focused));
    }

    #[test]
    fn optimistic_focus_only_affects_its_server() {
        let mut model = ClientSupervisorModel::new("local");
        let server_a = model.add_secondary(ssh_remote("a", "a", "a"));
        let server_b = model.add_secondary(ssh_remote("b", "b", "b"));
        model
            .set_summary(
                &server_a,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "a-ws".into(),
                        label: "a".into(),
                        branch: None,
                        focused: false,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();
        model
            .set_summary(
                &server_b,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "b-ws".into(),
                        label: "b".into(),
                        branch: None,
                        focused: true,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();

        model.focus_workspace_route(&server_a, "a-ws");

        let rows = model.workspace_rows();
        // B's summary-derived focused flag is untouched.
        assert!(rows
            .iter()
            .any(|row| row.workspace_id.as_deref() == Some("b-ws") && row.focused));
        assert!(rows
            .iter()
            .any(|row| row.workspace_id.as_deref() == Some("a-ws") && row.focused));
    }

    #[test]
    fn optimistic_focus_overrides_stale_focused_on_other_server() {
        let mut model = ClientSupervisorModel::new("local");
        let server_a = model.add_secondary(ssh_remote("a", "a", "a"));
        let server_b = model.add_secondary(ssh_remote("b", "b", "b"));
        model
            .set_summary(
                &server_a,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "a-ws".into(),
                        label: "a".into(),
                        branch: None,
                        focused: false,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();
        // B carries a stale focused row, and main is focused too.
        model
            .set_summary(
                &server_b,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "b-ws".into(),
                        label: "b".into(),
                        branch: None,
                        focused: true,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();

        model.focus_workspace_route(&server_a, "a-ws");

        let rows = model.workspace_rows();
        let focused: Vec<_> = rows
            .iter()
            .filter(|row| row.focused)
            .filter_map(|row| row.workspace_id.clone())
            .collect();
        // Focus is single across the fleet on server A's optimistic row. B's stale focus is
        // left intact (single-server override), but since focus on A overrides A's summary, the
        // optimistic row is the only focused row server A contributes — and `from_model` lands
        // `active_idx` on it. Here we assert A's optimistic row is focused and is the only
        // focused row on A.
        assert!(focused.contains(&"a-ws".to_string()));
        assert!(rows
            .iter()
            .filter(|row| row.server_id == server_a)
            .filter(|row| row.focused)
            .all(|row| row.workspace_id.as_deref() == Some("a-ws")));
    }

    #[test]
    fn optimistic_focus_skips_disabled_or_unavailable_targets() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = ServerId::secondary("remote-x");
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        model
            .set_connection_state(&remote_id, ConnectionState::Disconnected)
            .unwrap();

        // Unavailable owner: no optimistic focus is set.
        let route = model.focus_workspace_route(&remote_id, "remote-api");
        assert!(matches!(route, FocusRoute::Unavailable { .. }));
        // The disconnected remote renders a `None`-id placeholder row; it stays unfocused.
        assert!(model
            .workspace_rows()
            .iter()
            .filter(|row| row.server_id == remote_id)
            .all(|row| !row.focused && row.workspace_id.is_none()));

        // Reconnect, but focus an unknown id (NotFound) — still no optimistic focus.
        model
            .set_connection_state(&remote_id, ConnectionState::Connected)
            .unwrap();
        model
            .set_summary(
                &remote_id,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "remote-api".into(),
                        label: "api".into(),
                        branch: None,
                        focused: false,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();
        let route = model.focus_workspace_route(&remote_id, "does-not-exist");
        assert_eq!(route, FocusRoute::NotFound);
        assert!(model
            .workspace_rows()
            .iter()
            .filter(|row| row.server_id == remote_id)
            .all(|row| !row.focused));
    }

    #[test]
    fn client_global_menu_uses_server_launcher_items() {
        let mut model = ClientSupervisorModel::new("local");

        model.open_client_global_menu(0, 0);

        assert_eq!(model.client_menu().map(|m| m.selected), Some(0));
        assert_eq!(
            model.client_global_menu_items(),
            [
                "settings",
                "keybinds",
                "reload config",
                "detach",
                "add remote",
                "manage remotes"
            ]
        );
        for _ in 0..4 {
            model.move_client_menu_next();
        }
        assert_eq!(model.client_menu().map(|m| m.selected), Some(4));
        // #47: "add remote" opens the add-remote overlay and reports Redraw (one outcome type).
        assert_eq!(model.accept_client_menu_item(), ClientMenuOutcome::Redraw);
        assert_eq!(
            model.add_remote_form(),
            Some(&AddRemoteForm {
                target: String::new(),
                name: String::new(),
                session: String::new(),
                focused_field: AddRemoteField::Target,
                error: None,
                in_progress: false,
                progress: None,
            })
        );
    }

    #[test]
    fn set_client_menu_selected_moves_highlight() {
        let mut model = ClientSupervisorModel::new("local");
        // a no-op when the menu is closed.
        model.set_client_menu_selected(2);
        assert_eq!(model.client_menu().map(|m| m.selected), None);

        model.open_client_global_menu(0, 0);
        assert_eq!(model.client_menu().map(|m| m.selected), Some(0));

        // setting snaps the highlight to the hovered row.
        model.set_client_menu_selected(2);
        assert_eq!(model.client_menu().map(|m| m.selected), Some(2));

        // an out-of-range index clamps to the last item.
        model.set_client_menu_selected(99);
        assert_eq!(
            model.client_menu().map(|m| m.selected),
            Some(model.client_global_menu_items().len() - 1)
        );
    }

    #[test]
    fn add_remote_form_edits_fields_and_builds_draft() {
        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form();

        for ch in "local:dev".chars() {
            assert_eq!(
                model.handle_add_remote_key(crate::input::TerminalKey::new(
                    crossterm::event::KeyCode::Char(ch),
                    crossterm::event::KeyModifiers::empty(),
                )),
                AddRemoteFormOutcome::Redraw
            );
        }
        assert_eq!(
            model.handle_add_remote_key(crate::input::TerminalKey::new(
                crossterm::event::KeyCode::Tab,
                crossterm::event::KeyModifiers::empty(),
            )),
            AddRemoteFormOutcome::Redraw
        );
        for ch in "dev".chars() {
            assert_eq!(
                model.handle_add_remote_key(crate::input::TerminalKey::new(
                    crossterm::event::KeyCode::Char(ch),
                    crossterm::event::KeyModifiers::empty(),
                )),
                AddRemoteFormOutcome::Redraw
            );
        }

        assert_eq!(
            model.handle_add_remote_key(crate::input::TerminalKey::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::empty(),
            )),
            AddRemoteFormOutcome::Submit(AddRemoteDraft {
                target: "local:dev".into(),
                name: Some("dev".into()),
                session: None,
                keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            })
        );
    }

    #[test]
    fn add_remote_form_cycles_three_fields_and_carries_the_session() {
        use crossterm::event::{KeyCode, KeyModifiers};
        fn key(code: KeyCode) -> crate::input::TerminalKey {
            crate::input::TerminalKey::new(code, KeyModifiers::empty())
        }
        fn type_into(model: &mut ClientSupervisorModel, text: &str) {
            for ch in text.chars() {
                assert_eq!(
                    model.handle_add_remote_key(key(KeyCode::Char(ch))),
                    AddRemoteFormOutcome::Redraw
                );
            }
        }

        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form();
        // C1: the session field opens empty (= the remote's default session).
        assert_eq!(
            model.add_remote_form().map(|form| form.session.as_str()),
            Some("")
        );

        type_into(&mut model, "user@dev");
        model.handle_add_remote_key(key(KeyCode::Tab));
        assert_eq!(
            model.add_remote_form().map(|form| form.focused_field),
            Some(AddRemoteField::Name)
        );
        type_into(&mut model, "dev");
        model.handle_add_remote_key(key(KeyCode::Tab));
        assert_eq!(
            model.add_remote_form().map(|form| form.focused_field),
            Some(AddRemoteField::Session)
        );
        type_into(&mut model, "work");

        // …and a third Tab wraps back to `target` (target -> name -> session -> target).
        model.handle_add_remote_key(key(KeyCode::Tab));
        assert_eq!(
            model.add_remote_form().map(|form| form.focused_field),
            Some(AddRemoteField::Target)
        );

        assert_eq!(
            model.handle_add_remote_key(key(KeyCode::Enter)),
            AddRemoteFormOutcome::Submit(AddRemoteDraft {
                target: "user@dev".into(),
                name: Some("dev".into()),
                session: Some("work".into()),
                keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            })
        );
    }

    #[test]
    fn add_remote_draft_treats_a_blank_session_as_the_default_session() {
        use crossterm::event::{KeyCode, KeyModifiers};
        fn key(code: KeyCode) -> crate::input::TerminalKey {
            crate::input::TerminalKey::new(code, KeyModifiers::empty())
        }

        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form();
        for ch in "user@dev".chars() {
            model.handle_add_remote_key(key(KeyCode::Char(ch)));
        }
        // Focus the session field and leave only whitespace on it.
        model.handle_add_remote_key(key(KeyCode::Tab));
        model.handle_add_remote_key(key(KeyCode::Tab));
        model.handle_add_remote_key(key(KeyCode::Char(' ')));

        assert_eq!(
            model.handle_add_remote_key(key(KeyCode::Enter)),
            AddRemoteFormOutcome::Submit(AddRemoteDraft {
                target: "user@dev".into(),
                name: None,
                session: None,
                keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            })
        );
    }

    #[test]
    fn summary_subscription_plans_include_connected_main_and_local_secondaries_only() {
        let mut model = ClientSupervisorModel::new("local");
        let dev_id = model.add_secondary(local_remote("remote-dev", "dev", Some("dev")));
        let ssh_id = model.add_secondary(ssh_remote("remote-ssh", "prod", "prod.example.com"));
        model
            .set_connection_state(&ssh_id, ConnectionState::Connecting)
            .unwrap();

        assert_eq!(
            model.summary_subscription_plans(),
            vec![
                SummarySubscriptionPlan {
                    server_id: ServerId::main(),
                    target: ServerConnectionTarget::Main,
                },
                SummarySubscriptionPlan {
                    server_id: dev_id,
                    target: ServerConnectionTarget::LocalSession(Some("dev".into())),
                },
            ]
        );
    }

    fn set_host_animation(
        model: &mut ClientSupervisorModel,
        animation: crate::config::HostBannerAnimation,
    ) {
        let mut ui_settings = model.ui_settings().clone();
        ui_settings.sidebar_host.animation = animation;
        model.set_ui_settings(ui_settings);
    }

    #[test]
    fn host_banner_specs_one_per_visible_remote() {
        use crate::app::state::HostBannerState;
        let mut model = ClientSupervisorModel::new("local");
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "main-ws".into(),
                        label: "herdr".into(),
                        branch: None,
                        focused: true,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();
        let dev = model.add_secondary(local_remote("dev", "dev", Some("dev")));
        let prod = model.add_secondary(ssh_remote("prod", "prod", "prod.example.com"));
        model
            .set_summary(
                &dev,
                ServerSummary {
                    workspaces: vec![
                        WorkspaceSummary {
                            workspace_id: "dev-a".into(),
                            label: "a".into(),
                            branch: None,
                            focused: false,
                            ..Default::default()
                        },
                        WorkspaceSummary {
                            workspace_id: "dev-b".into(),
                            label: "b".into(),
                            branch: None,
                            focused: false,
                            ..Default::default()
                        },
                    ],
                    agents: Vec::new(),
                },
            )
            .unwrap();
        model
            .set_summary(
                &prod,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "prod-a".into(),
                        label: "p".into(),
                        branch: None,
                        focused: false,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();

        let specs = model.host_banner_specs();
        // #19 (host half): a banner per visible host (Local + each Secondary), in
        // visible_servers() order — Local first (it is the draggable host handle).
        assert_eq!(specs.len(), 3);
        assert_eq!(specs[0].1.display_name, "local");
        assert_eq!(specs[1].1.display_name, "dev");
        assert_eq!(specs[1].1.connection_state, HostBannerState::Connected);
        assert_eq!(specs[1].1.space_count, 2);
        assert_eq!(specs[2].1.display_name, "prod");
        assert_eq!(specs[2].1.space_count, 1);

        // The insertion index precedes that host's first row in the flat workspace_rows() stream.
        let rows = model.workspace_rows();
        assert_eq!(
            rows[specs[0].0].server_id,
            ServerId::main(),
            "local banner index precedes the local row"
        );
        assert_eq!(
            rows[specs[1].0].server_id,
            ServerId::secondary("dev"),
            "dev banner index precedes dev's first row"
        );
        assert_eq!(
            rows[specs[2].0].server_id,
            ServerId::secondary("prod"),
            "prod banner index precedes prod's first row"
        );
    }

    #[test]
    fn host_banner_state_mapping() {
        use crate::app::state::HostBannerState;
        let mut model = ClientSupervisorModel::new("local");
        let connecting = model.add_secondary(ssh_remote("c", "c", "c"));
        let disconnected = model.add_secondary(ssh_remote("d", "d", "d"));
        let mismatch = model.add_secondary(ssh_remote("m", "m", "m"));
        let empty = model.add_secondary(ssh_remote("e", "e", "e"));

        model
            .set_connection_state(&connecting, ConnectionState::Connecting)
            .unwrap();
        model
            .set_connection_state(&disconnected, ConnectionState::Disconnected)
            .unwrap();
        model
            .set_connection_state(
                &mismatch,
                ConnectionState::ProtocolMismatch {
                    server_protocol: Some(1),
                    client_protocol: 2,
                },
            )
            .unwrap();
        // Empty connected host: connected with zero spaces.
        model.set_summary(&empty, ServerSummary::default()).unwrap();

        let by_name = |name: &str| {
            model
                .host_banner_specs()
                .into_iter()
                .find(|(_, spec)| spec.display_name == name)
                .map(|(_, spec)| spec)
                .expect("spec exists")
        };
        assert_eq!(by_name("c").connection_state, HostBannerState::Connecting);
        assert_eq!(by_name("d").connection_state, HostBannerState::Disconnected);
        assert_eq!(
            by_name("m").connection_state,
            HostBannerState::ProtocolMismatch
        );
        let empty_spec = by_name("e");
        assert_eq!(empty_spec.connection_state, HostBannerState::Connected);
        assert_eq!(empty_spec.space_count, 0);
    }

    #[test]
    fn host_banner_active_true_with_remote() {
        // Monolithic / all-main: no banner.
        let mut model = ClientSupervisorModel::new("local");
        assert!(!model.host_banner_active());
        // One visible secondary → active.
        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        assert!(model.host_banner_active());
    }

    #[test]
    fn host_banner_animation_active_gated() {
        let mut model = ClientSupervisorModel::new("local");
        // No remote → never active even when Animated.
        set_host_animation(&mut model, crate::config::HostBannerAnimation::Animated);
        assert!(!model.host_banner_animation_active());

        model.add_secondary(ssh_remote("remote-x", "x", "x"));
        // Animated + a banner → active (this feeds sidebar_wants_animation).
        assert!(model.host_banner_animation_active());
        // Static → not active even with a banner.
        set_host_animation(&mut model, crate::config::HostBannerAnimation::Static);
        assert!(!model.host_banner_animation_active());
    }

    // ----- item 3 (Area 5): disabled-gate + management overlay -------------------------------

    fn disabled_ssh_remote(
        id: &str,
        name: &str,
        target: &str,
    ) -> crate::remote_registry::RemoteDefinitionSnapshot {
        let mut remote = ssh_remote(id, name, target);
        remote.disabled = true;
        remote
    }

    #[test]
    fn disabled_remote_excluded_from_all_four_plan_producers() {
        let mut model = ClientSupervisorModel::new("local");
        // Sync with one disabled secondary.
        model.sync_remote_registry(vec![disabled_ssh_remote("r1", "alpha", "alpha")]);
        let id = ServerId::secondary("r1");

        let connected: std::collections::HashSet<ServerId> = std::collections::HashSet::new();
        assert!(model
            .secondary_connection_plans()
            .iter()
            .all(|plan| plan.server_id != id));
        assert!(model
            .summary_subscription_plans()
            .iter()
            .all(|plan| plan.server_id != id));
        assert!(!model.unconnected_secondary_server_ids().contains(&id));
        assert!(!model
            .secondary_server_ids_missing_client_stream(&connected)
            .contains(&id));

        // Re-enable (sync with disabled = false) — now included again.
        model.sync_remote_registry(vec![ssh_remote("r1", "alpha", "alpha")]);
        assert!(model
            .secondary_connection_plans()
            .iter()
            .any(|plan| plan.server_id == id));
        assert!(model.unconnected_secondary_server_ids().contains(&id));
        assert!(model
            .secondary_server_ids_missing_client_stream(&connected)
            .contains(&id));
    }

    #[test]
    fn disabled_remote_row_label_is_name_disabled() {
        let mut model = ClientSupervisorModel::new("local");
        model.sync_remote_registry(vec![disabled_ssh_remote("r1", "alpha", "alpha")]);

        let rows = model.workspace_rows();
        let row = rows
            .iter()
            .find(|row| row.server_id == ServerId::secondary("r1"))
            .expect("disabled secondary row");
        assert!(row.disabled);
        assert_eq!(row.label, "alpha disabled");
    }

    #[test]
    fn host_reorder_survives_remote_registry_sync() {
        // #40: a host drag-reorder must NOT snap back to registry order on the next sync.
        let mut model = ClientSupervisorModel::new("local");
        model.sync_remote_registry(vec![
            ssh_remote("r1", "alpha", "alpha"),
            ssh_remote("r2", "bravo", "bravo"),
            ssh_remote("r3", "charlie", "charlie"),
        ]);
        // host_banner_server_ids reflects the visible host order (main first when multi-host).
        assert_eq!(
            model.host_banner_server_ids(),
            vec![
                ServerId::main(),
                ServerId::secondary("r1"),
                ServerId::secondary("r2"),
                ServerId::secondary("r3"),
            ]
        );

        // Drag r3 to the slot right after main (insert index 1 among the ordered host list).
        assert!(model.reorder_server(&ServerId::secondary("r3"), 1));
        let reordered = vec![
            ServerId::main(),
            ServerId::secondary("r3"),
            ServerId::secondary("r1"),
            ServerId::secondary("r2"),
        ];
        assert_eq!(model.host_banner_server_ids(), reordered);

        // The registry poll lands again in its own (r1, r2, r3) order — the client-local drag
        // order must persist instead of being clobbered.
        model.sync_remote_registry(vec![
            ssh_remote("r1", "alpha", "alpha"),
            ssh_remote("r2", "bravo", "bravo"),
            ssh_remote("r3", "charlie", "charlie"),
        ]);
        assert_eq!(model.host_banner_server_ids(), reordered);
    }

    #[test]
    fn newly_added_remote_appends_after_reordered_hosts() {
        // #40: a genuinely-new remote still appears, at the end, without disturbing the drag order.
        let mut model = ClientSupervisorModel::new("local");
        model.sync_remote_registry(vec![
            ssh_remote("r1", "alpha", "alpha"),
            ssh_remote("r2", "bravo", "bravo"),
        ]);
        assert!(model.reorder_server(&ServerId::secondary("r2"), 1));
        // Sync adds r3 alongside the existing two.
        model.sync_remote_registry(vec![
            ssh_remote("r1", "alpha", "alpha"),
            ssh_remote("r2", "bravo", "bravo"),
            ssh_remote("r3", "charlie", "charlie"),
        ]);
        assert_eq!(
            model.host_banner_server_ids(),
            vec![
                ServerId::main(),
                ServerId::secondary("r2"),
                ServerId::secondary("r1"),
                ServerId::secondary("r3"),
            ]
        );
    }

    #[test]
    fn disconnected_host_keeps_individual_greyed_space_rows() {
        // #36: a host that WAS connected (has summaries) keeps its individual space rows — greyed —
        // when it drops, instead of collapsing to a single "unavailable" placeholder.
        let mut model = ClientSupervisorModel::new("local");
        let id = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model
            .set_connection_state(&id, ConnectionState::Connected)
            .unwrap();
        model
            .set_summary(
                &id,
                ServerSummary {
                    workspaces: vec![
                        WorkspaceSummary {
                            workspace_id: "ws-a".into(),
                            label: "soma-work".into(),
                            branch: None,
                            focused: true,
                            worktree_key: None,
                            worktree_is_linked: false,
                            git_repo_key: None,
                            git_is_linked: false,
                        },
                        WorkspaceSummary {
                            workspace_id: "ws-b".into(),
                            label: "scratch".into(),
                            branch: None,
                            focused: false,
                            worktree_key: None,
                            worktree_is_linked: false,
                            git_repo_key: None,
                            git_is_linked: false,
                        },
                    ],
                    agents: Vec::new(),
                },
            )
            .unwrap();

        // Drop the connection — summaries are intentionally retained.
        model
            .set_connection_state(&id, ConnectionState::Disconnected)
            .unwrap();

        let rows: Vec<_> = model
            .workspace_rows()
            .into_iter()
            .filter(|row| row.server_id == id)
            .collect();
        // Both individual spaces still listed (NOT a single placeholder), and greyed (disabled).
        assert_eq!(
            rows.len(),
            2,
            "individual spaces persist, no placeholder collapse"
        );
        assert_eq!(rows[0].workspace_id.as_deref(), Some("ws-a"));
        assert_eq!(rows[1].workspace_id.as_deref(), Some("ws-b"));
        assert!(
            rows.iter().all(|row| row.disabled),
            "rows greyed while disconnected"
        );
    }

    #[test]
    fn worktree_grouped_space_is_not_reorderable() {
        // #41: a worktree-grouped space must not arm a drag (storage move == visual no-op when
        // regrouped under its parent); a standalone space stays reorderable.
        let mut model = ClientSupervisorModel::new("local");
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![
                        WorkspaceSummary {
                            workspace_id: "plain".into(),
                            label: "plain".into(),
                            branch: None,
                            focused: false,
                            worktree_key: None,
                            worktree_is_linked: false,
                            git_repo_key: None,
                            git_is_linked: false,
                        },
                        WorkspaceSummary {
                            workspace_id: "wt-child".into(),
                            label: "wt-child".into(),
                            branch: None,
                            focused: false,
                            worktree_key: Some("repo-1".into()),
                            worktree_is_linked: true,
                            git_repo_key: None,
                            git_is_linked: false,
                        },
                    ],
                    agents: Vec::new(),
                },
            )
            .unwrap();

        assert!(model.workspace_is_reorderable(&ServerId::main(), "plain"));
        assert!(!model.workspace_is_reorderable(&ServerId::main(), "wt-child"));
        // Unknown workspace / server are not reorderable (no panic, false).
        assert!(!model.workspace_is_reorderable(&ServerId::main(), "missing"));
        assert!(!model.workspace_is_reorderable(&ServerId::secondary("nope"), "plain"));
    }

    fn worktree_summary(
        workspace_id: &str,
        worktree_key: Option<&str>,
        is_linked: bool,
    ) -> WorkspaceSummary {
        WorkspaceSummary {
            workspace_id: workspace_id.into(),
            label: workspace_id.into(),
            branch: None,
            focused: false,
            worktree_key: worktree_key.map(str::to_string),
            worktree_is_linked: is_linked,
            git_repo_key: None,
            git_is_linked: false,
        }
    }

    fn model_with_worktree_summaries(workspaces: Vec<WorkspaceSummary>) -> ClientSupervisorModel {
        let mut model = ClientSupervisorModel::new("local");
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces,
                    agents: Vec::new(),
                },
            )
            .unwrap();
        model
    }

    #[test]
    fn workspace_menu_plain_workspace_has_rename_and_close_only() {
        let mut model = model_with_worktree_summaries(vec![worktree_summary("plain", None, false)]);
        model.open_workspace_context_menu(
            ServerId::main(),
            "plain".into(),
            "plain".into(),
            None,
            0,
            0,
        );
        assert_eq!(menu_labels(&model), vec!["rename", "close"]);
    }

    #[test]
    fn workspace_menu_git_root_offers_new_and_open_worktree() {
        // Server-menu parity: a git root WITHOUT linked children gets the create/open rows.
        let mut model =
            model_with_worktree_summaries(vec![worktree_summary("root", Some("repo-1"), false)]);
        model.open_workspace_context_menu(
            ServerId::main(),
            "root".into(),
            "root".into(),
            None,
            0,
            0,
        );
        assert_eq!(
            menu_labels(&model),
            vec!["rename", "close", "new worktree", "open worktree…"]
        );
    }

    #[test]
    fn workspace_menu_plain_git_repo_without_membership_offers_worktree_rows() {
        // The screenshot bug: a git workspace that has never created a worktree carries NO
        // worktree-space membership (`worktree_key: None`) — only the plain-git signal
        // (`WorkspaceInfo.git`). The menu must still offer the create/open rows, mirroring
        // the server menu's `git_space` fallback.
        let mut workspace = worktree_summary("herdr", None, false);
        workspace.git_repo_key = Some("repo-herdr".into());
        let mut model = model_with_worktree_summaries(vec![workspace]);
        model.open_workspace_context_menu(
            ServerId::main(),
            "herdr".into(),
            "herdr".into(),
            None,
            0,
            0,
        );
        assert_eq!(
            menu_labels(&model),
            vec!["rename", "close", "new worktree", "open worktree…"]
        );

        // A plain-git LINKED checkout (opened manually, no membership) gets the delete row.
        let mut linked = worktree_summary("wt", None, false);
        linked.git_repo_key = Some("repo-herdr".into());
        linked.git_is_linked = true;
        let mut model = model_with_worktree_summaries(vec![linked]);
        model.open_workspace_context_menu(ServerId::main(), "wt".into(), "wt".into(), None, 0, 0);
        assert_eq!(
            menu_labels(&model),
            vec!["rename", "close", "delete worktree checkout…"]
        );
    }

    #[test]
    fn workspace_menu_linked_worktree_offers_delete_checkout() {
        let mut model = model_with_worktree_summaries(vec![
            worktree_summary("root", Some("repo-1"), false),
            worktree_summary("child", Some("repo-1"), true),
        ]);
        model.open_workspace_context_menu(
            ServerId::main(),
            "child".into(),
            "child".into(),
            None,
            0,
            0,
        );
        assert_eq!(
            menu_labels(&model),
            vec!["rename", "close", "delete worktree checkout…"]
        );
    }

    #[test]
    fn workspace_menu_group_root_closes_group_and_toggles_collapse() {
        let mut model = model_with_worktree_summaries(vec![
            worktree_summary("root", Some("repo-1"), false),
            worktree_summary("child", Some("repo-1"), true),
        ]);
        // Collapsed group → the toggle row reads "expand"; close reads "close group".
        model.open_workspace_context_menu(
            ServerId::main(),
            "root".into(),
            "root".into(),
            Some(true),
            0,
            0,
        );
        assert_eq!(
            menu_labels(&model),
            vec![
                "rename",
                "close group",
                "new worktree",
                "open worktree…",
                "expand"
            ]
        );
        let toggle_index = 4;
        let outcome = model.select_client_menu_item(toggle_index);
        assert_eq!(
            outcome,
            ClientMenuOutcome::ToggleWorktreeGroup {
                group_key: "repo-1".into()
            }
        );

        // Expanded group → "collapse".
        model.open_workspace_context_menu(
            ServerId::main(),
            "root".into(),
            "root".into(),
            Some(false),
            0,
            0,
        );
        assert_eq!(menu_labels(&model)[toggle_index], "collapse");
    }

    #[test]
    fn workspace_menu_worktree_rows_promote_to_their_overlays() {
        let mut model = model_with_worktree_summaries(vec![
            worktree_summary("root", Some("repo-1"), false),
            worktree_summary("child", Some("repo-1"), true),
        ]);

        // "new worktree" (row 2 on the root) → the branch input overlay.
        model.open_workspace_context_menu(
            ServerId::main(),
            "root".into(),
            "root".into(),
            None,
            0,
            0,
        );
        assert_eq!(model.select_client_menu_item(2), ClientMenuOutcome::Redraw);
        assert!(model.new_worktree_form().is_some());
        // Submit flows the typed branch to a worktree.create outcome.
        for ch in "feat-x".chars() {
            let _ = model.handle_new_worktree_key(crate::input::TerminalKey::new(
                crossterm::event::KeyCode::Char(ch),
                crossterm::event::KeyModifiers::empty(),
            ));
        }
        let outcome = model.handle_new_worktree_key(crate::input::TerminalKey::new(
            crossterm::event::KeyCode::Enter,
            crossterm::event::KeyModifiers::empty(),
        ));
        assert_eq!(
            outcome,
            NewWorktreeOutcome::Submit {
                server_id: ServerId::main(),
                workspace_id: "root".into(),
                branch: "feat-x".into(),
            }
        );
        assert!(model.new_worktree_form().is_none());

        // "open worktree…" (row 3 on the root) → the picker in loading state + a fetch outcome.
        model.open_workspace_context_menu(
            ServerId::main(),
            "root".into(),
            "root".into(),
            None,
            0,
            0,
        );
        assert_eq!(
            model.select_client_menu_item(3),
            ClientMenuOutcome::FetchWorktreeList {
                server_id: ServerId::main(),
                workspace_id: "root".into(),
            }
        );
        let picker = model.worktree_picker().expect("picker open");
        assert!(picker.loading);
        // The fetch result fills the rows; Enter opens the selected checkout.
        model.fill_worktree_picker(
            &ServerId::main(),
            "root",
            Ok(vec![WorktreePickerItem {
                path: "/repos/x-feat".into(),
                label: "feat".into(),
                open_workspace_id: None,
            }]),
        );
        let outcome = model.handle_worktree_picker_key(crate::input::TerminalKey::new(
            crossterm::event::KeyCode::Enter,
            crossterm::event::KeyModifiers::empty(),
        ));
        assert_eq!(
            outcome,
            WorktreePickerOutcome::Open {
                server_id: ServerId::main(),
                workspace_id: "root".into(),
                path: "/repos/x-feat".into(),
            }
        );
        assert!(model.worktree_picker().is_none());

        // "delete worktree checkout…" (row 2 on the child) → the confirm overlay; y confirms.
        model.open_workspace_context_menu(
            ServerId::main(),
            "child".into(),
            "child".into(),
            None,
            0,
            0,
        );
        assert_eq!(model.select_client_menu_item(2), ClientMenuOutcome::Redraw);
        assert!(model.confirm_delete_worktree().is_some());
        let outcome = model.handle_confirm_delete_worktree_key(crate::input::TerminalKey::new(
            crossterm::event::KeyCode::Char('y'),
            crossterm::event::KeyModifiers::empty(),
        ));
        assert_eq!(
            outcome,
            ConfirmDeleteWorktreeOutcome::Confirm {
                server_id: ServerId::main(),
                workspace_id: "child".into(),
            }
        );
        assert!(model.confirm_delete_worktree().is_none());
    }

    #[test]
    fn summary_subscription_excludes_stale_connected_disabled() {
        let mut model = ClientSupervisorModel::new("local");
        let id = ServerId::secondary("r1");
        // Bring it up connected, then disable while leaving connection_state == Connected.
        model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model
            .set_connection_state(&id, ConnectionState::Connected)
            .unwrap();
        // sync to a disabled definition flips ManagedServer.disabled WITHOUT touching state.
        model.sync_remote_registry(vec![disabled_ssh_remote("r1", "alpha", "alpha")]);

        let server = model.server(&id).expect("server");
        assert_eq!(server.connection_state, ConnectionState::Connected);
        assert!(server.disabled);
        // The gate (not just connection state) keeps it out of summary subscriptions.
        assert!(model
            .summary_subscription_plans()
            .iter()
            .all(|plan| plan.server_id != id));
    }

    #[test]
    fn open_remote_manage_overlay_sets_state() {
        let mut model = ClientSupervisorModel::new("local");
        assert!(model.remote_manage_overlay().is_none());
        model.open_remote_manage_overlay();
        assert!(model.remote_manage_overlay().is_some());
    }

    #[test]
    fn remote_manage_rows_lists_all_secondaries() {
        let mut model = ClientSupervisorModel::new("local");
        model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model.add_secondary(disabled_ssh_remote("r2", "beta", "beta"));

        let rows = model.remote_manage_rows();
        assert_eq!(rows.len(), 2, "Main is never listed");
        assert_eq!(rows[0].remote_id, "r1");
        assert_eq!(rows[0].name, "alpha");
        assert!(rows[0].enabled);
        assert_eq!(rows[0].state, RemoteManageState::Connected);
        assert_eq!(rows[1].remote_id, "r2");
        assert!(!rows[1].enabled);
        assert_eq!(rows[1].state, RemoteManageState::Disabled);
    }

    #[test]
    fn remote_manage_nav_clamps() {
        let mut model = ClientSupervisorModel::new("local");
        model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model.add_secondary(ssh_remote("r2", "beta", "beta"));
        model.open_remote_manage_overlay();

        model.move_remote_manage_prev(); // already at 0
        assert_eq!(model.remote_manage_overlay().unwrap().selected, 0);
        model.move_remote_manage_next();
        assert_eq!(model.remote_manage_overlay().unwrap().selected, 1);
        model.move_remote_manage_next(); // clamp to last (index 1)
        assert_eq!(model.remote_manage_overlay().unwrap().selected, 1);
    }

    #[test]
    fn begin_cancel_delete_scopes_to_selected() {
        let mut model = ClientSupervisorModel::new("local");
        model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model.add_secondary(ssh_remote("r2", "beta", "beta"));
        model.open_remote_manage_overlay();
        model.move_remote_manage_next(); // select r2

        model.begin_remote_manage_delete();
        assert_eq!(
            model
                .remote_manage_overlay()
                .unwrap()
                .confirm_delete
                .as_deref(),
            Some("r2")
        );
        model.cancel_remote_manage_delete();
        assert!(model
            .remote_manage_overlay()
            .unwrap()
            .confirm_delete
            .is_none());
    }

    fn press(code: crossterm::event::KeyCode) -> crate::input::TerminalKey {
        crate::input::TerminalKey::new(code, crossterm::event::KeyModifiers::empty())
    }

    #[test]
    fn manage_key_emits_expected_outcomes() {
        use crossterm::event::KeyCode;
        let mut model = ClientSupervisorModel::new("local");
        model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model.open_remote_manage_overlay();

        // Space toggles enable -> disable for the selected (currently-enabled) remote.
        let outcome = model.handle_remote_manage_key(press(KeyCode::Char(' ')));
        assert_eq!(
            outcome,
            RemoteManageOutcome::SetEnabled {
                remote_id: "r1".into(),
                enabled: false
            }
        );
        // pending now blocks a re-issue for r1.
        assert_eq!(
            model.handle_remote_manage_key(press(KeyCode::Char(' '))),
            RemoteManageOutcome::Redraw
        );
        // clear pending and enter delete-confirm.
        model.clear_remote_manage_pending("r1");
        let confirm = model.handle_remote_manage_key(press(KeyCode::Char('d')));
        assert_eq!(confirm, RemoteManageOutcome::Redraw);
        assert_eq!(
            model
                .remote_manage_overlay()
                .unwrap()
                .confirm_delete
                .as_deref(),
            Some("r1")
        );
        // nav keys are inert while confirm is active.
        model.handle_remote_manage_key(press(KeyCode::Down));
        assert_eq!(model.remote_manage_overlay().unwrap().selected, 0);
        // Enter in confirm emits Delete.
        let deleted = model.handle_remote_manage_key(press(KeyCode::Enter));
        assert_eq!(
            deleted,
            RemoteManageOutcome::Delete {
                remote_id: "r1".into()
            }
        );

        // `a` opens the add-remote form (fresh overlay first).
        let mut model = ClientSupervisorModel::new("local");
        model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model.open_remote_manage_overlay();
        assert_eq!(
            model.handle_remote_manage_key(press(KeyCode::Char('a'))),
            RemoteManageOutcome::OpenAddRemote
        );
        assert!(model.add_remote_form().is_some());
    }

    #[test]
    fn global_menu_includes_manage_remotes() {
        let mut model = ClientSupervisorModel::new("local");
        assert!(model.client_global_menu_items().contains(&"manage remotes"));
        model.open_client_global_menu(0, 0);
        // #47: "manage remotes" (index 5) opens the manage overlay and reports Redraw.
        assert_eq!(model.select_client_menu_item(5), ClientMenuOutcome::Redraw);
        assert!(model.remote_manage_overlay().is_some());
    }

    // ----- #23: workspace context menu + rename + confirm-close --------------------------------

    fn model_with_workspace() -> (ClientSupervisorModel, ServerId) {
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model
            .set_connection_state(&remote, ConnectionState::Connected)
            .unwrap();
        model
            .set_summary(
                &remote,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "ws-1".into(),
                        label: "feature".into(),
                        branch: None,
                        focused: false,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();
        (model, remote)
    }

    fn ctrl_u() -> crate::input::TerminalKey {
        crate::input::TerminalKey::new(
            crossterm::event::KeyCode::Char('u'),
            crossterm::event::KeyModifiers::CONTROL,
        )
    }

    /// #47: the open client menu's row labels, in render order — replaces the old per-menu
    /// `host_context_menu_items()` / `workspace_context_menu_items()` for tests that assert labels.
    fn menu_labels(model: &ClientSupervisorModel) -> Vec<String> {
        model
            .client_menu()
            .map(|menu| menu.items.iter().map(|item| item.label.clone()).collect())
            .unwrap_or_default()
    }

    #[test]
    fn open_workspace_context_menu_captures_target_and_label() {
        use crossterm::event::KeyCode;
        let (mut model, server_id) = model_with_workspace();
        let label = model.workspace_label(&server_id, "ws-1").unwrap();
        assert_eq!(label, "feature");

        model.open_workspace_context_menu(server_id.clone(), "ws-1".into(), label, None, 0, 0);

        let menu = model.client_menu().expect("menu open");
        assert_eq!(
            menu.kind,
            ClientMenuKind::Workspace {
                server_id: server_id.clone(),
                workspace_id: "ws-1".into(),
                label: "feature".into(),
            }
        );
        assert_eq!(menu.subheader.as_deref(), Some("feature"));
        assert_eq!(menu.selected, 0);
        let labels: Vec<&str> = menu.items.iter().map(|item| item.label.as_str()).collect();
        assert_eq!(labels, ["rename", "close"]);

        // a missing workspace yields no label.
        assert!(model.workspace_label(&server_id, "nope").is_none());
        let _ = KeyCode::Esc;
    }

    #[test]
    fn context_menu_nav_and_esc_dismiss() {
        use crossterm::event::KeyCode;
        let (mut model, server_id) = model_with_workspace();
        model.open_workspace_context_menu(server_id, "ws-1".into(), "feature".into(), None, 0, 0);

        // Down moves to "close", k clamps back to "rename".
        assert_eq!(
            model.handle_client_menu_key(press(KeyCode::Down)),
            ClientMenuOutcome::Redraw
        );
        assert_eq!(model.client_menu().unwrap().selected, 1);
        model.handle_client_menu_key(press(KeyCode::Char('k')));
        assert_eq!(model.client_menu().unwrap().selected, 0);

        // Esc dismisses.
        model.handle_client_menu_key(press(KeyCode::Esc));
        assert!(model.client_menu().is_none());
    }

    #[test]
    fn context_menu_enter_on_rename_opens_prefilled_rename_overlay() {
        use crossterm::event::KeyCode;
        let (mut model, server_id) = model_with_workspace();
        model.open_workspace_context_menu(
            server_id.clone(),
            "ws-1".into(),
            "feature".into(),
            None,
            0,
            0,
        );

        assert_eq!(
            model.handle_client_menu_key(press(KeyCode::Enter)),
            ClientMenuOutcome::Redraw
        );
        let form = model.rename_workspace_form().expect("rename overlay open");
        assert_eq!(form.server_id, server_id);
        assert_eq!(form.workspace_id, "ws-1");
        assert_eq!(form.label, "feature", "prefilled with current label");
        assert!(model.client_menu().is_none());
    }

    #[test]
    fn rename_typing_builds_label_and_enter_submits_rename() {
        use crossterm::event::KeyCode;
        let (mut model, server_id) = model_with_workspace();
        model.open_workspace_context_menu(
            server_id.clone(),
            "ws-1".into(),
            String::new(),
            None,
            0,
            0,
        );
        model.handle_client_menu_key(press(KeyCode::Enter)); // -> rename overlay

        for ch in "next".chars() {
            model.handle_rename_workspace_key(press(KeyCode::Char(ch)));
        }
        assert_eq!(model.rename_workspace_form().unwrap().label, "next");

        let outcome = model.handle_rename_workspace_key(press(KeyCode::Enter));
        assert_eq!(
            outcome,
            RenameWorkspaceOutcome::Submit {
                server_id,
                workspace_id: "ws-1".into(),
                label: "next".into(),
            }
        );
    }

    #[test]
    fn rename_empty_label_does_not_submit() {
        use crossterm::event::KeyCode;
        let (mut model, server_id) = model_with_workspace();
        model.open_workspace_context_menu(server_id, "ws-1".into(), "feature".into(), None, 0, 0);
        model.handle_client_menu_key(press(KeyCode::Enter)); // -> rename overlay

        // clear the prefilled label with Ctrl-U, then Enter must NOT submit.
        model.handle_rename_workspace_key(ctrl_u());
        assert_eq!(model.rename_workspace_form().unwrap().label, "");

        let outcome = model.handle_rename_workspace_key(press(KeyCode::Enter));
        assert_eq!(outcome, RenameWorkspaceOutcome::Redraw);
        assert!(
            model.rename_workspace_form().unwrap().error.is_some(),
            "empty label surfaces an inline error"
        );
        assert!(
            model.rename_workspace_form().is_some(),
            "overlay stays open"
        );
    }

    #[test]
    fn context_menu_close_opens_confirm_and_enter_confirms_close() {
        use crossterm::event::KeyCode;
        let (mut model, server_id) = model_with_workspace();
        model.open_workspace_context_menu(
            server_id.clone(),
            "ws-1".into(),
            "feature".into(),
            None,
            0,
            0,
        );
        // select "close" (index 1) then Enter -> confirm overlay.
        model.handle_client_menu_key(press(KeyCode::Down));
        assert_eq!(
            model.handle_client_menu_key(press(KeyCode::Enter)),
            ClientMenuOutcome::Redraw
        );
        let confirm = model
            .confirm_close_workspace()
            .expect("confirm overlay open");
        assert_eq!(confirm.server_id, server_id);
        assert_eq!(confirm.workspace_id, "ws-1");
        assert_eq!(confirm.label, "feature");

        let outcome = model.handle_confirm_close_workspace_key(press(KeyCode::Enter));
        assert_eq!(
            outcome,
            ConfirmCloseOutcome::Confirm {
                server_id,
                workspace_id: "ws-1".into(),
            }
        );
    }

    #[test]
    fn confirm_close_cancel_dismisses_without_request() {
        use crossterm::event::KeyCode;
        let (mut model, server_id) = model_with_workspace();
        model.open_workspace_context_menu(server_id, "ws-1".into(), "feature".into(), None, 0, 0);
        model.handle_client_menu_key(press(KeyCode::Down));
        model.handle_client_menu_key(press(KeyCode::Enter)); // -> confirm overlay

        // 'n' cancels with no request and closes the overlay.
        let outcome = model.handle_confirm_close_workspace_key(press(KeyCode::Char('n')));
        assert_eq!(outcome, ConfirmCloseOutcome::Redraw);
        assert!(model.confirm_close_workspace().is_none());
    }

    // ----- #43: host context menu ---------------------------------------------------------------

    #[test]
    fn open_host_context_menu_captures_host_and_labels() {
        // A connected, enabled host: items are add/disable/disconnect.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model
            .set_connection_state(&remote, ConnectionState::Connected)
            .unwrap();

        model.open_host_context_menu(remote.clone(), "alpha".into(), 4, 5);
        let menu = model.client_menu().expect("host menu open");
        assert_eq!(
            menu.kind,
            ClientMenuKind::Host {
                server_id: remote.clone()
            }
        );
        assert_eq!(menu.subheader.as_deref(), Some("alpha"));
        // the version-readout row (0) is non-selectable; connected + enabled state shows in the
        // baked labels asserted below ("disable" / "disconnect").
        assert!(!menu.items[0].selectable);
        // #46 (item 5): opens on the first actionable row, skipping the non-selectable
        // version-readout at row 0. C3: that first actionable row is now the session readout.
        assert_eq!(menu.selected, 1);
        assert_eq!(menu.anchor_col, 4);
        assert_eq!(menu.anchor_row, 5);
        // #44/#61: a non-selectable version-readout row leads; C3 puts the session readout right
        // under it; then add/disable/disconnect; then update; then the per-remote auto-update
        // toggle (off -> "enable auto-update").
        assert_eq!(
            menu_labels(&model),
            [
                "unknown",
                "session  default",
                "add new space",
                "disable",
                "disconnect",
                "update",
                "enable auto-update"
            ]
        );
        // C4: activating that row opens the picker (asserted in full below).
        assert_eq!(menu.items[1].action, ClientMenuAction::OpenSessionPicker);
        assert!(menu.items[1].selectable);

        // A disabled + disconnected host flips both toggle labels.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(disabled_ssh_remote("r2", "beta", "beta"));
        model
            .set_connection_state(&remote, ConnectionState::Disconnected)
            .unwrap();
        model.open_host_context_menu(remote.clone(), "beta".into(), 0, 0);
        // A disabled + disconnected host flips both toggle labels ("enable" / "reconnect"); the
        // auto-update row stays (off -> "enable auto-update").
        assert_eq!(
            menu_labels(&model),
            [
                "unknown",
                "session  default",
                "add new space",
                "enable",
                "reconnect",
                "update",
                "enable auto-update"
            ]
        );
    }

    #[test]
    fn host_context_menu_toggle_label_reflects_state() {
        // #44/C3: the toggle row is index 3 (after version readout / session readout / add-space).
        // A disabled host shows "enable" there, and selecting it yields ToggleEnabled{true}.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(disabled_ssh_remote("r1", "alpha", "alpha"));
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        assert_eq!(menu_labels(&model)[3], "enable");
        assert_eq!(
            model.select_client_menu_item(3),
            ClientMenuOutcome::HostToggleEnabled {
                remote_id: "r1".into(),
                enabled: true,
            }
        );

        // An enabled host shows "disable" and selecting it yields ToggleEnabled{false}.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        assert_eq!(menu_labels(&model)[3], "disable");
        assert_eq!(
            model.select_client_menu_item(3),
            ClientMenuOutcome::HostToggleEnabled {
                remote_id: "r1".into(),
                enabled: false,
            }
        );
    }

    #[test]
    fn host_context_menu_add_space_unavailable_when_disconnected() {
        // #44/C3 row order: 0=version readout, 1=session readout, 2=add space, 3=toggle,
        // 4=disconnect/reconnect, 5=update.
        // #47: activating a terminal row closes the menu (it has done its job), so re-open before
        // each selection. Disconnected host: add-space (2) and update (5) are no-op redraws; the
        // version row (0) is non-selectable (redraw); the disconnect row (4) reconnects instead.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model
            .set_connection_state(&remote, ConnectionState::Disconnected)
            .unwrap();
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        assert_eq!(model.select_client_menu_item(0), ClientMenuOutcome::Redraw);
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        assert_eq!(model.select_client_menu_item(2), ClientMenuOutcome::Redraw);
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        assert_eq!(
            model.select_client_menu_item(4),
            ClientMenuOutcome::HostReconnect(remote.clone())
        );
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        assert_eq!(model.select_client_menu_item(5), ClientMenuOutcome::Redraw);

        // Connected host: add-space (row 2) yields AddSpace; row 4 disconnects; row 5 updates.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model
            .set_connection_state(&remote, ConnectionState::Connected)
            .unwrap();
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        assert_eq!(
            model.select_client_menu_item(2),
            ClientMenuOutcome::HostAddSpace(remote.clone())
        );
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        assert_eq!(
            model.select_client_menu_item(4),
            ClientMenuOutcome::HostDisconnect(remote.clone())
        );
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        assert_eq!(
            model.select_client_menu_item(5),
            ClientMenuOutcome::HostUpdate(remote.clone())
        );
    }

    #[test]
    fn host_context_menu_nav_and_esc_dismiss() {
        use crossterm::event::KeyCode;
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model
            .set_connection_state(&remote, ConnectionState::Connected)
            .unwrap();
        model.open_host_context_menu(remote, "alpha".into(), 0, 0);

        // #44/#61/C3: Down advances through the 7-row menu (version/session/add/toggle/disconnect/
        // update/auto-update), clamped at the last row (index 6). #46: the menu OPENS on row 1
        // (the session readout), skipping the non-actionable version readout.
        assert_eq!(model.client_menu().unwrap().selected, 1);
        assert_eq!(
            model.handle_client_menu_key(press(KeyCode::Down)),
            ClientMenuOutcome::Redraw
        );
        assert_eq!(model.client_menu().unwrap().selected, 2);
        model.handle_client_menu_key(press(KeyCode::Char('j')));
        assert_eq!(model.client_menu().unwrap().selected, 3);
        model.handle_client_menu_key(press(KeyCode::Down));
        model.handle_client_menu_key(press(KeyCode::Down));
        model.handle_client_menu_key(press(KeyCode::Down));
        assert_eq!(model.client_menu().unwrap().selected, 6);
        model.handle_client_menu_key(press(KeyCode::Down));
        assert_eq!(model.client_menu().unwrap().selected, 6);
        // k moves back up.
        model.handle_client_menu_key(press(KeyCode::Char('k')));
        assert_eq!(model.client_menu().unwrap().selected, 5);

        // Esc dismisses.
        model.handle_client_menu_key(press(KeyCode::Esc));
        assert!(model.client_menu().is_none());
    }

    // ----- C2/C3/C4/C5/C6: the host-menu session readout, picker, and new-session input ---------

    fn ssh_remote_with_session(
        id: &str,
        name: &str,
        target: &str,
        session: &str,
    ) -> crate::remote_registry::RemoteDefinitionSnapshot {
        let mut remote = ssh_remote(id, name, target);
        remote.session = Some(session.to_string());
        remote
    }

    fn session_item(name: Option<&str>, running: bool) -> SessionPickerItem {
        SessionPickerItem {
            name: name.map(str::to_string),
            label: name.unwrap_or("default").to_string(),
            running,
            is_current: false,
        }
    }

    #[test]
    fn host_context_menu_session_row_reads_the_effective_session() {
        // C3: an unset session IS the remote's `default` session, so the readout says so.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model.open_host_context_menu(remote, "alpha".into(), 0, 0);
        assert_eq!(menu_labels(&model)[1], "session  default");

        // …and a remote pinned to a session shows THAT name.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote_with_session("r1", "alpha", "alpha", "work"));
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        assert_eq!(menu_labels(&model)[1], "session  work");

        // C4: activating it opens the picker in its loading state and asks the loop to fetch.
        assert_eq!(
            model.select_client_menu_item(1),
            ClientMenuOutcome::FetchSessionList {
                server_id: remote.clone(),
                remote_id: "r1".into(),
            }
        );
        let picker = model.session_picker().expect("picker open");
        assert!(picker.loading);
        assert_eq!(picker.current.as_deref(), Some("work"));
        // C6: the trailing `new session…` row exists even while loading.
        assert_eq!(picker.row_count(), 1);
        assert!(picker.is_new_session_row(0));
    }

    #[test]
    fn fill_session_picker_marks_the_current_row_and_keeps_the_new_session_row() {
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote_with_session("r1", "alpha", "alpha", "work"));
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        model.select_client_menu_item(1);

        model.fill_session_picker(
            &remote,
            Ok(vec![
                session_item(None, true),
                session_item(Some("work"), true),
                session_item(Some("scratch"), false),
            ]),
        );

        let picker = model.session_picker().expect("picker open");
        assert!(!picker.loading);
        assert_eq!(picker.error, None);
        assert_eq!(
            picker
                .items
                .iter()
                .map(|item| item.is_current)
                .collect::<Vec<_>>(),
            [false, true, false]
        );
        // The selection lands on the current session, and the trailing row is one past the list.
        assert_eq!(picker.selected, 1);
        assert_eq!(picker.row_count(), 4);
        assert!(picker.is_new_session_row(3));
    }

    #[test]
    fn fill_session_picker_error_still_offers_the_new_session_row() {
        // C6: an old remote whose server has no `session.list` must still be switchable by name.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        model.select_client_menu_item(1);

        model.fill_session_picker(&remote, Err("unknown method: session.list".to_string()));

        let picker = model.session_picker().expect("picker open");
        assert!(!picker.loading);
        assert_eq!(
            picker.error.as_deref(),
            Some("unknown method: session.list")
        );
        assert!(picker.items.is_empty());
        assert_eq!(picker.row_count(), 1);
        assert!(picker.is_new_session_row(0));

        // …and activating it opens the free-text input rather than dying on the error.
        assert_eq!(
            model.handle_session_picker_key(press(crossterm::event::KeyCode::Enter)),
            SessionPickerOutcome::OpenNewSession
        );
        assert!(model.new_session_form().is_some());
    }

    #[test]
    fn session_picker_enter_selects_a_session_or_opens_the_new_session_input() {
        use crossterm::event::KeyCode;

        // C5: Enter on a listed row yields the session to switch to (the default row -> `None`).
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote_with_session("r1", "alpha", "alpha", "work"));
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        model.select_client_menu_item(1);
        model.fill_session_picker(
            &remote,
            Ok(vec![
                session_item(None, true),
                session_item(Some("work"), true),
            ]),
        );
        // Selection opened on `work` (row 1); move up to the default session.
        model.handle_session_picker_key(press(KeyCode::Up));
        assert_eq!(
            model.handle_session_picker_key(press(KeyCode::Enter)),
            SessionPickerOutcome::Select {
                server_id: remote.clone(),
                remote_id: "r1".into(),
                session: None,
            }
        );
        assert!(model.session_picker().is_none(), "picker closes on select");

        // C6: Enter on the LAST row (the trailing `new session…`) opens the input instead.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        model.select_client_menu_item(1);
        model.fill_session_picker(&remote, Ok(vec![session_item(None, true)]));
        model.handle_session_picker_key(press(KeyCode::Down));
        assert_eq!(model.session_picker().unwrap().selected, 1);
        assert_eq!(
            model.handle_session_picker_key(press(KeyCode::Enter)),
            SessionPickerOutcome::OpenNewSession
        );
        assert_eq!(
            model.new_session_form().map(|form| form.remote_id.as_str()),
            Some("r1")
        );
        // Down cannot walk past the trailing row.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        model.select_client_menu_item(1);
        model.fill_session_picker(&remote, Ok(vec![session_item(None, true)]));
        for _ in 0..5 {
            model.handle_session_picker_key(press(KeyCode::Down));
        }
        assert_eq!(model.session_picker().unwrap().selected, 1);
    }

    #[test]
    fn session_picker_click_selects_the_same_rows_as_enter() {
        // C5: "클릭해서 선택할수 있고" — the click path is the SAME `select_session_picker_row`.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        model.select_client_menu_item(1);
        model.fill_session_picker(
            &remote,
            Ok(vec![
                session_item(None, true),
                session_item(Some("work"), false),
            ]),
        );

        assert_eq!(
            model.select_session_picker_row(1),
            SessionPickerOutcome::Select {
                server_id: remote,
                remote_id: "r1".into(),
                session: Some("work".into()),
            }
        );
    }

    #[test]
    fn new_session_submit_rejects_an_invalid_name_without_closing() {
        use crossterm::event::KeyCode;

        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        model.select_client_menu_item(1);
        model.fill_session_picker(&remote, Ok(Vec::new()));
        model.handle_session_picker_key(press(KeyCode::Enter));

        for ch in "bad name!".chars() {
            model.handle_new_session_key(press(KeyCode::Char(ch)));
        }
        assert_eq!(
            model.handle_new_session_key(press(KeyCode::Enter)),
            NewSessionOutcome::Redraw
        );
        let form = model
            .new_session_form()
            .expect("invalid name keeps the overlay open");
        assert_eq!(form.name, "bad name!");
        assert!(
            form.error.is_some(),
            "the rejection reason is shown inline: {form:?}"
        );

        // A valid name submits and closes.
        for _ in 0..form.name.len() {
            model.handle_new_session_key(press(KeyCode::Backspace));
        }
        for ch in "work".chars() {
            model.handle_new_session_key(press(KeyCode::Char(ch)));
        }
        assert_eq!(
            model.handle_new_session_key(press(KeyCode::Enter)),
            NewSessionOutcome::Submit {
                server_id: remote.clone(),
                remote_id: "r1".into(),
                session: Some("work".into()),
            }
        );
        // D2: the overlay STAYS OPEN (in flight) so a server-side rejection can land on it; a
        // second Enter cannot double-submit while it is in flight.
        let form = model
            .new_session_form()
            .expect("overlay open while in flight");
        assert!(form.in_flight);
        assert_eq!(form.error, None);
        assert_eq!(
            model.handle_new_session_key(press(KeyCode::Enter)),
            NewSessionOutcome::Redraw,
            "an in-flight submit must not be re-sent"
        );

        // The server rejects it -> the reason lands inline and the overlay is editable again.
        model.fail_new_session("r1", "remote target already exists".into());
        let form = model
            .new_session_form()
            .expect("overlay still open after a rejection");
        assert!(!form.in_flight);
        assert_eq!(form.error.as_deref(), Some("remote target already exists"));

        // …and a success closes it.
        model.finish_new_session("r1");
        assert!(model.new_session_form().is_none());
    }

    #[test]
    fn new_session_empty_submit_means_the_default_session() {
        use crossterm::event::KeyCode;

        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote_with_session("r1", "alpha", "alpha", "work"));
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        model.select_client_menu_item(1);
        model.fill_session_picker(&remote, Ok(Vec::new()));
        model.handle_session_picker_key(press(KeyCode::Enter));

        assert_eq!(
            model.handle_new_session_key(press(KeyCode::Enter)),
            NewSessionOutcome::Submit {
                server_id: remote,
                remote_id: "r1".into(),
                session: None,
            }
        );
    }

    #[test]
    fn secondary_connection_plan_carries_the_remotes_session() {
        // The value that reaches `start_ssh_remote_bridge` as `--session work` on the far side.
        let mut model = ClientSupervisorModel::new("local");
        model.sync_remote_registry(vec![ssh_remote_with_session(
            "r1", "alpha", "alpha", "work",
        )]);

        let plans = model.secondary_connection_plans();
        assert_eq!(
            plans
                .iter()
                .map(|plan| plan.target.clone())
                .collect::<Vec<_>>(),
            vec![ServerConnectionTarget::Ssh {
                destination: "alpha".into(),
                options: Vec::new(),
                session: Some("work".into()),
            }]
        );
        assert_eq!(
            model.server_session(&ServerId::secondary("r1")).as_deref(),
            Some("work")
        );
        // C3: the management-overlay label spells the session out too.
        assert_eq!(plans[0].target.display_label(), "alpha (work)");
    }

    #[test]
    fn local_remote_session_still_comes_from_its_target() {
        // A `Local` remote keeps its session in the target (`local:<name>`), so `from_definition`
        // must read it from there — the definition-level field is the SSH-only carrier.
        let mut model = ClientSupervisorModel::new("local");
        model.sync_remote_registry(vec![local_remote("r1", "dev", Some("dev"))]);
        assert_eq!(
            model.server_session(&ServerId::secondary("r1")).as_deref(),
            Some("dev")
        );
    }

    // ----- #44: remote version/protocol readout + one-click update -------------------------------

    #[test]
    fn host_version_readout_flags_protocol_mismatch() {
        let local = crate::protocol::PROTOCOL_VERSION;

        // A matching protocol is NOT a mismatch; the label carries the version + "proto".
        let (label, mismatch) = host_version_readout(Some("0.6.4"), Some(local));
        assert!(!mismatch, "matching protocol is not a mismatch");
        assert_eq!(label, format!("v0.6.4 · proto {local}"));
        assert!(label.contains("proto"));

        // A differing protocol IS a mismatch and still carries "proto" in the label.
        let (label, mismatch) = host_version_readout(Some("0.6.3"), Some(local.wrapping_sub(1)));
        assert!(mismatch, "differing protocol is a mismatch");
        assert!(label.contains("proto"));

        // Unknown (nothing captured) is neutral: label "unknown", not a mismatch.
        let (label, mismatch) = host_version_readout(None, None);
        assert!(!mismatch, "unknown is neutral, never a false mismatch");
        assert_eq!(label, "unknown");
    }

    #[test]
    fn set_remote_runtime_info_populates_managed_server() {
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));

        // Initially unset.
        let server = model.server_for_test(&remote).expect("server present");
        assert_eq!(server.remote_version, None);
        assert_eq!(server.remote_protocol, None);

        model.set_remote_runtime_info(&remote, Some("0.6.4".into()), Some(13));
        let server = model.server_for_test(&remote).expect("server present");
        assert_eq!(server.remote_version.as_deref(), Some("0.6.4"));
        assert_eq!(server.remote_protocol, Some(13));

        // Clearing both back to None is honored.
        model.set_remote_runtime_info(&remote, None, None);
        let server = model.server_for_test(&remote).expect("server present");
        assert_eq!(server.remote_version, None);
        assert_eq!(server.remote_protocol, None);
    }

    #[test]
    fn host_menu_includes_version_row_and_update_item() {
        let local = crate::protocol::PROTOCOL_VERSION;
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model
            .set_connection_state(&remote, ConnectionState::Connected)
            .unwrap();
        model.set_remote_runtime_info(&remote, Some("0.6.4".into()), Some(local));
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);

        // The items list STARTS with the version readout row and CONTAINS "update".
        let items = menu_labels(&model);
        assert_eq!(
            items.first().map(String::as_str),
            Some(format!("v0.6.4 · proto {local}").as_str())
        );
        assert!(
            items.iter().any(|item| item == "update"),
            "menu contains an update item: {items:?}"
        );

        // The version-readout row (index 0) is non-actionable -> Redraw.
        assert_eq!(model.select_client_menu_item(0), ClientMenuOutcome::Redraw);

        // Selecting the update row index returns Update(server_id) for a connected host.
        let update_index = items
            .iter()
            .position(|item| item == "update")
            .expect("update row present");
        assert_eq!(
            model.select_client_menu_item(update_index),
            ClientMenuOutcome::HostUpdate(remote.clone())
        );
    }

    #[test]
    fn host_menu_version_row_marks_mismatch() {
        let local = crate::protocol::PROTOCOL_VERSION;
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model
            .set_connection_state(&remote, ConnectionState::Connected)
            .unwrap();
        // A stale protocol flags a ⚠ marker on the readout row.
        model.set_remote_runtime_info(&remote, Some("0.6.0".into()), Some(local.wrapping_add(1)));
        model.open_host_context_menu(remote, "alpha".into(), 0, 0);
        let first = menu_labels(&model)[0].clone();
        assert!(
            first.starts_with("⚠ "),
            "mismatched proto marks ⚠: {first:?}"
        );
    }

    #[test]
    fn update_progress_threads_into_host_banner_spec() {
        // Two visible servers (local + remote) so the multi-host gate emits a banner per host.
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model
            .set_connection_state(&remote, ConnectionState::Connected)
            .unwrap();

        // The remote's banner is the 2nd spec (visible order: [local, remote]).
        let banner_index = model
            .host_banner_specs()
            .iter()
            .position(|(_, spec)| spec.display_name == "alpha")
            .expect("remote banner present");

        // No progress yet.
        assert!(model.host_banner_specs()[banner_index]
            .1
            .progress_lines
            .is_empty());

        // Stages ACCUMULATE into a log (consecutive duplicates collapse) so a slow install
        // shows its history as multiple sub-lines.
        model.set_update_progress(&remote, Some("detecting remote platform…".into()));
        model.set_update_progress(&remote, Some("installing herdr on the remote…".into()));
        model.set_update_progress(&remote, Some("installing herdr on the remote…".into()));
        assert_eq!(
            model.host_banner_specs()[banner_index].1.progress_lines,
            vec![
                "detecting remote platform…".to_string(),
                "installing herdr on the remote…".to_string(),
            ]
        );

        // Clearing empties the log.
        model.set_update_progress(&remote, None);
        assert!(model.host_banner_specs()[banner_index]
            .1
            .progress_lines
            .is_empty());
    }

    #[test]
    fn update_outcome_threads_into_banner_and_enriches_with_new_version() {
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model
            .set_connection_state(&remote, ConnectionState::Connected)
            .unwrap();
        let banner_index = model
            .host_banner_specs()
            .iter()
            .position(|(_, spec)| spec.display_name == "alpha")
            .expect("remote banner present");

        // No outcome yet → nothing on the banner, and enrich is a no-op (no live success outcome).
        assert!(model.host_banner_specs()[banner_index]
            .1
            .update_outcome
            .is_none());
        assert!(!model.enrich_update_success_with_version(&remote, "0.6.5"));

        // A success outcome threads onto the banner sub-line.
        model.set_update_outcome(
            &remote,
            crate::app::state::HostUpdateOutcome {
                message: "✓ update complete".into(),
                success: true,
            },
        );
        assert_eq!(
            model.host_banner_specs()[banner_index]
                .1
                .update_outcome
                .as_ref()
                .map(|o| (o.message.as_str(), o.success)),
            Some(("✓ update complete", true))
        );

        // The post-update status fetch folds in the freshly-installed version (and re-fires once).
        assert!(model.enrich_update_success_with_version(&remote, "0.6.5"));
        assert_eq!(
            model
                .update_outcome_for(&remote)
                .map(|o| o.message.as_str()),
            Some("✓ updated to v0.6.5")
        );
        assert!(
            !model.enrich_update_success_with_version(&remote, "0.6.5"),
            "the same version must not re-fire the display-timer re-arm"
        );

        // A FAILURE outcome is never version-enriched.
        model.set_update_outcome(
            &remote,
            crate::app::state::HostUpdateOutcome {
                message: "✗ update failed: boom".into(),
                success: false,
            },
        );
        assert!(!model.enrich_update_success_with_version(&remote, "0.7.0"));
        assert_eq!(
            model
                .update_outcome_for(&remote)
                .map(|o| o.message.as_str()),
            Some("✗ update failed: boom")
        );

        // Clearing removes it from the banner.
        model.clear_update_outcome(&remote);
        assert!(model.host_banner_specs()[banner_index]
            .1
            .update_outcome
            .is_none());
    }

    fn ssh_remote_auto_update(
        id: &str,
        name: &str,
        target: &str,
    ) -> crate::remote_registry::RemoteDefinitionSnapshot {
        crate::remote_registry::RemoteDefinitionSnapshot {
            auto_update: true,
            ..ssh_remote(id, name, target)
        }
    }

    #[test]
    fn auto_update_candidates_selects_only_enabled_mismatched_ssh_remotes() {
        let local = crate::protocol::PROTOCOL_VERSION;
        let mut model = ClientSupervisorModel::new("local");
        // r1: auto-update ON, ssh, mismatched protocol -> the one candidate.
        let r1 = model.add_secondary(ssh_remote_auto_update("r1", "alpha", "alpha"));
        // r2: auto-update OFF, ssh, mismatched -> excluded (flag off).
        let r2 = model.add_secondary(ssh_remote("r2", "bravo", "bravo"));
        // r3: auto-update ON, ssh, MATCHING protocol -> excluded (no mismatch).
        let r3 = model.add_secondary(ssh_remote_auto_update("r3", "charlie", "charlie"));
        // r4: auto-update ON but a LOCAL (non-ssh) target -> excluded (nothing to reinstall over ssh).
        let r4 = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            auto_update: true,
            ..local_remote("r4", "delta", Some("delta"))
        });

        model.set_remote_runtime_info(&r1, Some("0.5.0".into()), Some(local.wrapping_add(1)));
        model.set_remote_runtime_info(&r2, Some("0.5.0".into()), Some(local.wrapping_add(1)));
        model.set_remote_runtime_info(&r3, Some("0.6.4".into()), Some(local));
        model.set_remote_runtime_info(&r4, Some("0.5.0".into()), Some(local.wrapping_add(1)));

        assert_eq!(model.auto_update_candidates(), vec![r1.clone()]);

        // A host with an unknown (not-yet-probed) protocol is NOT a candidate (never on a guess).
        model.set_remote_runtime_info(&r1, None, None);
        assert!(model.auto_update_candidates().is_empty());

        // Re-probe a mismatch, then DISABLE r1 -> excluded (a disabled remote is inert).
        model.set_remote_runtime_info(&r1, Some("0.5.0".into()), Some(local.wrapping_add(1)));
        assert_eq!(model.auto_update_candidates(), vec![r1.clone()]);
        model.sync_remote_registry(vec![crate::remote_registry::RemoteDefinitionSnapshot {
            disabled: true,
            ..ssh_remote_auto_update("r1", "alpha", "alpha")
        }]);
        assert!(model.auto_update_candidates().is_empty());

        let _ = (r2, r3, r4);
    }

    #[test]
    fn host_menu_auto_update_row_toggles_the_flag() {
        let mut model = ClientSupervisorModel::new("local");
        let remote = model.add_secondary(ssh_remote("r1", "alpha", "alpha"));
        model
            .set_connection_state(&remote, ConnectionState::Connected)
            .unwrap();

        // Auto-update OFF -> the row reads "enable auto-update" and selecting it turns it ON.
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        let labels = menu_labels(&model);
        let row = labels
            .iter()
            .position(|item| item == "enable auto-update")
            .expect("an auto-update row is present when off");
        assert_eq!(
            model.select_client_menu_item(row),
            ClientMenuOutcome::HostToggleAutoUpdate {
                remote_id: remote.registry_id().to_string(),
                auto_update: true,
            }
        );

        // Auto-update ON -> the row reads "disable auto-update" and selecting it turns it OFF.
        model.sync_remote_registry(vec![ssh_remote_auto_update("r1", "alpha", "alpha")]);
        model.open_host_context_menu(remote.clone(), "alpha".into(), 0, 0);
        let labels = menu_labels(&model);
        let row = labels
            .iter()
            .position(|item| item == "disable auto-update")
            .expect("an auto-update row is present when on");
        assert_eq!(
            model.select_client_menu_item(row),
            ClientMenuOutcome::HostToggleAutoUpdate {
                remote_id: remote.registry_id().to_string(),
                auto_update: false,
            }
        );
    }
}
