use std::collections::HashMap;
use std::time::Instant;

use ratatui::{
    layout::{Alignment, Rect},
    style::{Modifier, Style},
    text::Span,
    widgets::Paragraph,
};
use unicode_width::UnicodeWidthStr;

use crate::app::state::{MenuListState, ViewLayout};
use crate::app::Mode;
use crate::client::supervisor::{AgentSidebarRow, ServerId};
use crate::detect::AgentState;
use crate::protocol::{CellData, CursorState, FrameData};
use crate::terminal::{TerminalId, TerminalRuntimeRegistry, TerminalState};

pub(crate) const DEFAULT_SIDEBAR_WIDTH: u16 = 26;

/// #26: double-click window for the width-divider reset, matching the monolithic host's
/// `DOUBLE_CLICK_WINDOW` (`src/app/input/mouse.rs`).
const DIVIDER_DOUBLE_CLICK_WINDOW: std::time::Duration = std::time::Duration::from_millis(400);

/// #17: latest-wins throttle for the width-divider drag. A drag emits a content/PTY resize at most
/// once per this interval (the sidebar still reflows locally every tick); the final settled size is
/// always flushed on release. ~100ms ≈ 10 resizes/sec, well under the ~60/sec a raw drag produced
/// that collapsed multi-server rendering to <5 fps.
const SIDEBAR_RESIZE_THROTTLE: std::time::Duration = std::time::Duration::from_millis(100);

/// #9: the narrow width of the collapsed (mini) sidebar — a status-only glance strip showing each
/// space's marker + agent status dot. Matches the SHARED renderer's `COLLAPSED_WIDTH` (num + space +
/// dot + separator) so `render_sidebar_collapsed` lays out cleanly at this width.
const MINI_SIDEBAR_WIDTH: u16 = 4;

/// #9/#58: fraction of the collapse/expand transition covered per gated 80ms Timer tick. A full
/// `1.0` makes the transition a SINGLE step: each rendered tick reruns the synchronous, O(hosts×
/// agents) `build_shell`/`from_model` on the UI loop, so a multi-tick slide multiplied that cost
/// (≈5 rebuilds) and visibly janked collapse/expand under a many-remote fleet. One step = one
/// rebuild — the snappy minimum (the remaining cost is a single `from_model`, the known O(visible)
/// ceiling), with no resize storm (the tick still emits at most one content resize).
const SIDEBAR_COLLAPSE_ANIM_STEP: f32 = 1.0;

/// #9: round-interpolate a width between `full` (t=0) and `mini` (t=1).
fn lerp_sidebar_width(full: u16, mini: u16, t: f32) -> u16 {
    let t = t.clamp(0.0, 1.0);
    let full = full as f32;
    let mini = mini as f32;
    (full + (mini - full) * t).round() as u16
}

/// #19: minimum pointer travel (in cells) before a workspace press becomes a drag-reorder, mirroring
/// the monolithic host's `WORKSPACE_DRAG_THRESHOLD` (`src/app/input/mod.rs`).
const WORKSPACE_DRAG_THRESHOLD: u16 = 1;

/// #21: which sidebar list a scrollbar drag is acting on.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ScrollbarPanel {
    Workspace,
    Agent,
}

/// #21: an in-progress scrollbar thumb drag (client-local). `grab_row_offset` keeps the grab point
/// fixed under the pointer, matching the monolithic host's scrollbar drag.
#[derive(Clone, Copy)]
struct ScrollbarDrag {
    panel: ScrollbarPanel,
    grab_row_offset: u16,
}

/// #19: an in-progress press on a workspace card. A press that moves past `WORKSPACE_DRAG_THRESHOLD`
/// becomes a drag-reorder; on release it commits a `workspace.reorder` to the owning server.
#[derive(Clone)]
struct WorkspacePress {
    server_id: ServerId,
    workspace_id: String,
    origin_col: u16,
    origin_row: u16,
    dragging: bool,
    /// #19: latest pointer row while dragging, so `from_model` can render a live drop indicator
    /// each frame (the drop position the release would commit). `None` until the press becomes a drag.
    last_drag_row: Option<u16>,
}

/// #19: outcome of feeding a mouse event to the workspace drag-reorder tracker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WorkspaceReorderOutcome {
    /// Not part of a drag-reorder (caller continues its normal dispatch).
    Ignored,
    /// An active drag moved — the caller should redraw (drop indicator follows the pointer).
    Dragging,
    /// A drag was released over a valid slot — send `workspace.reorder` to `server_id`.
    Commit {
        server_id: ServerId,
        workspace_id: String,
        insert_index: usize,
    },
    /// A drag was released but resolved to no valid slot — swallow it (no request).
    Cancelled,
}

/// #19 (host half): an in-progress press on a host banner. Mirrors `WorkspacePress`: a press that
/// moves past `WORKSPACE_DRAG_THRESHOLD` becomes a host drag-reorder; on release it commits a
/// client-local host move (host order is client-owned, no server round-trip).
#[derive(Clone)]
struct HostPress {
    server_id: ServerId,
    origin_col: u16,
    origin_row: u16,
    dragging: bool,
    /// Latest pointer row while dragging, so `from_model` can render a live host drop indicator
    /// each frame. `None` until the press becomes a drag.
    last_drag_row: Option<u16>,
}

/// #19 (host half): outcome of feeding a mouse event to the host drag-reorder tracker. Mirrors
/// `WorkspaceReorderOutcome`, but `Commit` carries an `insert_index` into the ORDERED host list
/// and is applied client-locally (`model.reorder_server`), never sent to a server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HostReorderOutcome {
    /// Not part of a host drag-reorder (caller continues its normal dispatch).
    Ignored,
    /// An active host drag moved — the caller should redraw (drop indicator follows the pointer).
    Dragging,
    /// A host drag was released over a valid slot — reorder `source_server_id` to `insert_index`.
    Commit {
        source_server_id: ServerId,
        insert_index: usize,
    },
    /// A host drag was released but resolved to no valid slot — swallow it (no reorder).
    Cancelled,
}

/// #19: resolve a drop row to a RENDER POSITION (`0..=cards.len()`) among a contiguous block of
/// cards — the count of cards whose vertical midpoint sits strictly above the drop row. This is a
/// position in the slice AS PASSED (render order, possibly scroll-truncated), NOT a storage index.
/// Callers translate it into the index space their consumer needs via `block_insert_global_index`:
/// render order may differ from storage order (worktree grouping #22) or omit leading cards (when
/// scrolled), so the bare position must be mapped through each card's true stored index.
fn server_insert_index(cards: &[Rect], drop_row: u16) -> usize {
    let mut insert = 0usize;
    for rect in cards {
        let midpoint = rect.y.saturating_add(rect.height / 2);
        if drop_row > midpoint {
            insert += 1;
        } else {
            break;
        }
    }
    insert.min(cards.len())
}

/// #19: map a drop within ONE contiguous block to the GLOBAL index slot it lands on. `cards` are
/// the block's cards in RENDER order, each paired with its true global index (`ws_idx` for
/// workspaces, `banner_idx` for hosts). Returns the global index of the card the drop lands above,
/// or `max(index) + 1` when dropped past the last card — `max`, NOT the last *rendered* card,
/// because render order != storage order under worktree grouping (#22). The live drop indicator
/// and the committed reorder both derive their slot from THIS function (the commit then subtracts
/// the block's base to get a server-local index), so the preview and the commit cannot disagree.
/// `None` only when `cards` is empty.
fn block_insert_global_index(cards: &[(usize, Rect)], drop_row: u16) -> Option<usize> {
    let rects: Vec<Rect> = cards.iter().map(|(_, rect)| *rect).collect();
    let above = server_insert_index(&rects, drop_row);
    match cards.get(above) {
        Some((global, _)) => Some(*global),
        // Dropped past the last rendered card: insert after the block's HIGHEST stored slot.
        None => cards
            .iter()
            .map(|(global, _)| *global)
            .max()
            .map(|max| max + 1),
    }
}

/// Outcome of a width-divider mouse interaction. A change to the sidebar width changes the content
/// area, so it must resize the remote PTY (`Resized`); merely beginning/ending a drag only needs a
/// local redraw (`Redraw`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SidebarResizeOutcome {
    Redraw,
    Resized(u16, u16),
}

pub(crate) struct ClientCompositor {
    sidebar_width: u16,
    workspace_scroll: usize,
    agent_panel_scroll: usize,
    resizing_sidebar: bool,
    // #16: client-local spaces↔agents split override. `None` follows the server/settings default;
    // `Some(ratio)` is a user drag. Fed into `from_model` and tracked while `resizing_section`.
    section_split: Option<f32>,
    resizing_section: bool,
    // #26: instant of the last left-press on the width divider, for double-click reset detection.
    last_divider_down: Option<Instant>,
    // #17: instant of the last PTY-resize we emitted during the CURRENT width-divider drag. The
    // sidebar reflows locally every drag tick, but the (expensive) remote PTY resize is latest-wins
    // throttled to `SIDEBAR_RESIZE_THROTTLE`; the final settled size is always flushed on release.
    // `None` between gestures so the first drag tick of a new drag resizes immediately.
    last_resize_emitted: Option<Instant>,
    // #19: in-progress press on a workspace card, promoted to a drag-reorder past the threshold.
    workspace_press: Option<WorkspacePress>,
    // #19 (host half): in-progress press on a host banner, promoted to a host drag-reorder past
    // the threshold. Only one of `workspace_press`/`host_press` is ever dragging at a time.
    host_press: Option<HostPress>,
    // #21: in-progress scrollbar thumb drag for the workspace or agent list.
    scrollbar_drag: Option<ScrollbarDrag>,
    animation_tick: u32,                                  // item 5
    hover: Option<crate::app::state::SidebarHoverTarget>, // item 7
    // #48: the latest sidebar motion position awaiting hover resolution. The `Moved` dispatch records
    // it here (O(1)) instead of resolving it through `hover_test` per event — resolving per event
    // rebuilt the O(hosts×agents) `from_model` snapshot on every motion report, dropping a fast
    // sidebar sweep to <1fps. `resolve_pending_hover` runs `hover_test` ONCE per frame at the
    // deferred-render flush (latest-wins). `None` when nothing is pending.
    pending_hover_pos: Option<(u16, u16)>,
    // #20: client-local agents-panel scope ("all" vs "current"). The server never owns this; it is
    // a per-client view preference fed into the render snapshot (`from_model`) and used to scope
    // the flat `agent_routes` so agent-row hit-testing stays aligned with the rendered entries.
    agent_panel_scope: crate::app::state::AgentPanelScope,
    // #25: client-local collapsed-sidebar view state. The server never owns this; it is a per-client
    // view preference fed into `from_model` (sets `app.sidebar_collapsed`) so the SHARED renderer
    // branches to the narrow collapsed (mini) layout and `hit_test` reads the collapsed geometry.
    sidebar_collapsed: bool,
    // #9: collapse/expand width-animation progress, 0.0 == fully expanded (full `sidebar_width`),
    // 1.0 == fully collapsed (mini `MINI_SIDEBAR_WIDTH`). `effective_sidebar_width` interpolates the
    // rendered+hit-tested width across this value so the sidebar SLIDES instead of snapping. The
    // loop's gated 80ms Timer steps it toward `sidebar_collapse_target()`; decoupled from
    // `sidebar_width` so a live resize drag never animates.
    collapse_progress: f32,
    // #24: client-local prefix-mode flag. Mirrors the server's `Mode::Prefix` state machine so the
    // configured prefix key (a modified chord, e.g. `ctrl+b`) arms interception of the very next
    // key for prefix-bound sidebar-nav actions. Bare keys are never intercepted unless armed, so
    // normal terminal input is preserved.
    prefix_armed: bool,
    // #30: raw bytes of the prefix keypress that armed prefix mode, buffered so an unhandled
    // follow-up key can be replayed to the active server as `prefix + key`. The client owns only a
    // subset of prefix actions (sidebar nav); the server owns the rest (tabs/panes/splits/detach),
    // so a key the client does not handle must reach the server WITH the prefix that preceded it.
    prefix_pending_bytes: Option<Vec<u8>>,
    // #22: client-local collapsed worktree-group keys. The server persists its OWN set
    // (`AppState.collapsed_space_keys`); collapse of the client's AGGREGATED multi-host view is a
    // per-client display concern, so the client owns this set (no server round-trip). Fed into
    // `from_model` (sets `app.collapsed_space_keys`) so the SHARED grouping renderer collapses the
    // right groups.
    collapsed_space_keys: std::collections::HashSet<String>,
    // #47: an in-progress drag of the open client menu's top border. `Some` between the mousedown on
    // the title row and the button release; carries the press origin + the menu's offset at press, so
    // each motion sets the new offset = start_offset + (mouse - start). Cleared on release/close.
    menu_drag: Option<ClientMenuDrag>,
    // item 5 freshness, key = (server_id, agent_id):
    working_since: HashMap<(ServerId, String), std::time::Instant>,
}

/// #47: the in-progress state of dragging the open client menu's top border to reposition it.
#[derive(Debug, Clone, Copy)]
struct ClientMenuDrag {
    start_col: u16,
    start_row: u16,
    start_offset: (i16, i16),
}

/// #45: the cached, content-independent half of a composited client frame.
///
/// Producing it runs the expensive `ClientSidebarSnapshot::from_model` (which walks every
/// workspace × agent × host, allocating a `TerminalState` per agent) **and** a full ratatui
/// sidebar render. Both depend ONLY on the model, the compositor view-state, the host size and
/// `now` — never on the active content frame. So on a pure content-output frame (an agent's
/// terminal changed but the sidebar did not) the client reuses this and only re-lays the content
/// region via [`overlay_content_onto_shell`], instead of rebuilding the entire sidebar per frame.
/// That per-frame rebuild was what throttled attach to <1fps while N agent TUIs flooded the client
/// with content frames during their redraw burst (issue #45).
pub(crate) struct ComposedShell {
    /// The rendered shell: sidebar + any open composited overlay/modal. The content columns hold
    /// the shell background and get overwritten by [`overlay_content_onto_shell`] (except the
    /// protected `excluded_rects`, where a floating popup must stay visible over the content).
    frame: FrameData,
    /// Footer-anchored popup rects protected from the content copy so floating modals stay visible.
    excluded_rects: Vec<Rect>,
    /// Whether ANY composited modal/overlay is open (the live content cursor must then be hidden).
    modal_open: bool,
    /// Sidebar width this shell was laid out at (the content region starts at this column).
    sidebar_width: u16,
    /// Content region width (`host_width - sidebar_width`).
    content_width: u16,
    /// Host dimensions this shell was built for; a mismatch (a resize) forces a rebuild before reuse.
    host_width: u16,
    host_height: u16,
    /// #56: the cell geometry + theme colors for every hover/selection highlight. The shell is
    /// rendered with NO hover baked in (so it stays valid across hover changes); the highlight is
    /// painted per-frame by [`apply_hover_overlay`] from THIS geometry + the live hover target. The
    /// geometry depends only on the model/view/size, exactly like the shell, so it is cached with it.
    hover: HoverGeometry,
}

/// #56: per-frame hover/selection highlight geometry, carried on the (hover-less) cached shell so a
/// hover change repaints via [`apply_hover_overlay`] instead of rebuilding the shell. Every rect is
/// derived from the SAME `ClientSidebarSnapshot` geometry the renderer and `hit_test`/`hover_test`
/// share, and the equivalence tests (Seam 1) pin the painted result cell-identical to the old
/// hover-baked render so the two geometries can never silently drift.
#[derive(Clone, Default)]
pub(crate) struct HoverGeometry {
    /// `hover_bg` packed — the subtle theme-derived bg lift shared by the workspace-card, agent-row
    /// and new-workspace-picker-row hovers.
    hover_bg: u32,
    /// The affordance fg lift (`overlay0` → `subtext0`, both packed) for the filter label, the
    /// new/menu buttons and the agent-scope toggle. Painted as a conditional recolor so only the
    /// affordance glyphs (already `overlay0`) lift, never the surrounding cells.
    affordance_from: u32,
    affordance_to: u32,
    /// Workspace cards paintable on hover: `(ws_idx, list_bottom-clipped rect)`. Selected / active /
    /// dragged cards are EXCLUDED here (their bg already wins over hover, so hovering them is a no-op).
    workspace_cards: Vec<(usize, Rect)>,
    /// Agent-panel rows paintable on hover: `(route_idx, full multi-line row rect)`. The active row
    /// is EXCLUDED (its `surface_dim` bg wins over hover).
    agent_rows: Vec<(usize, Rect)>,
    /// New-workspace-picker destination rows paintable on hover: `(row, row rect)`. The keyboard
    /// `selected` row is EXCLUDED (its bg wins; hover never overrides it).
    picker_rows: Vec<(usize, Rect)>,
    /// Affordance fg-lift rects, present only when the affordance is actually drawn (mirrors the
    /// renderer's `mouse_capture` / layout draw gates, so paint == hover-test).
    filter: Option<Rect>,
    new_button: Option<Rect>,
    menu_button: Option<Rect>,
    scope_toggle: Option<Rect>,
    /// The open client menu's selected-row paint (None when no menu is open). Carries the per-row
    /// cell geometry + the selection style so the overlay lifts whichever row the model now selects.
    menu: Option<MenuHoverGeometry>,
}

/// #56: the open-menu selected-row highlight, painted by the overlay so a menu-selection change does
/// not rebuild the shell (#55). The launcher and the context menus paint the selection differently,
/// so each carries the cells it actually styles.
#[derive(Clone)]
enum MenuHoverGeometry {
    /// The global launcher dropdown: the selected row styles ONLY its text-span cells (badge +
    /// label) — `fg`/`bg` packed, plus BOLD — leaving the row's padding at the panel bg.
    Launcher { rows: Vec<Rect>, fg: u32, bg: u32 },
    /// A workspace/host context menu: the selected row styles its FULL row rect (`fg`/`bg` packed +
    /// BOLD) and swaps the leading marker cell to "›".
    Context { rows: Vec<Rect>, fg: u32, bg: u32 },
}

/// #56: whether `build_shell_inner` bakes the live hover/selection into the rendered shell. Production
/// uses `Hoverless` (the highlight is painted per-frame by [`apply_hover_overlay`]); `Baked` is the
/// pre-#56 behavior, constructed only by the `#[cfg(test)]` `build_shell_hover_baked` as the Seam-1
/// equivalence golden — hence `Baked` is "never constructed" in a non-test build.
#[derive(Clone, Copy)]
#[cfg_attr(not(test), allow(dead_code))]
enum ShellHoverMode {
    Hoverless,
    Baked,
}

impl ComposedShell {
    /// Whether this cached shell was laid out for the given host dimensions. A resize changes the
    /// sidebar/content geometry, so on a mismatch the cache MUST be rebuilt before it is reused.
    pub(crate) fn matches_dims(&self, host_width: u16, host_height: u16) -> bool {
        self.host_width == host_width && self.host_height == host_height
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SidebarHitTarget {
    Filter,
    Workspace {
        server_id: crate::client::supervisor::ServerId,
        workspace_id: String,
    },
    Agent {
        server_id: crate::client::supervisor::ServerId,
        agent_id: String,
    },
    NewWorkspaceDestination {
        server_id: crate::client::supervisor::ServerId,
    },
    /// #19 (host half): a host banner row. A `Down(Left)` here arms a host drag-reorder (and
    /// otherwise focuses the host's first workspace via the existing dispatch). Client-local.
    HostBanner {
        server_id: crate::client::supervisor::ServerId,
    },
    /// The 1-cell status glyph at the left edge of a host banner (config `glyph = Left`). A
    /// `Down(Left)` here RETRIES a disconnected/provision-failed host (the click affordance the
    /// banner's failure sub-line points at); on a connected host it falls back to plain
    /// banner behaviour.
    HostBannerGlyph {
        server_id: crate::client::supervisor::ServerId,
    },
    /// #47: a row of the one open client menu (global launcher / workspace context / host context).
    /// Resolved by `hit_test_client_menu` from the SAME geometry the renderer uses. Replaces the old
    /// per-menu `ClientGlobalMenuItem` / `WorkspaceContextMenuRow` / `HostContextMenuRow` targets.
    ClientMenuRow {
        index: usize,
    },
    New,
    Menu,
    /// #20: the agents-panel "all"/"current" scope toggle. Client-local view state (no server
    /// round-trip), handled in `dispatch_composited_mouse_input` since it needs `&mut compositor`.
    AgentScopeToggle,
    /// #25: the collapse/expand sidebar toggle (bottom-right 1x1). Drawn in BOTH modes by
    /// `render_sidebar_toggle`, so it is hittable to collapse (expanded) AND to expand (collapsed).
    /// Client-local view state, flipped via `compositor.toggle_sidebar_collapsed()`.
    CollapsedSidebarToggle,
    /// #22: the chevron column of a worktree-group PARENT row. A `Down(Left)` here toggles the
    /// group's collapsed state in the client-local set (no server round-trip), handled in
    /// `dispatch_composited_mouse_input` since it needs `&mut compositor`. A NON-chevron click on the
    /// parent row stays `Workspace` (focus), matching the server's `mouse.rs` chevron geometry.
    WorktreeChevron {
        group_key: String,
    },
    // item 1: composited-modal action buttons (centered ratatui modals).
    AddRemoteSubmit,
    AddRemoteCancel,
    NewWorkspacePickerConfirm,
    NewWorkspacePickerCancel,
    // item 3 (Area 5): remote-management overlay targets.
    RemoteManageRow {
        index: usize,
    },
    RemoteManageAdd,
    RemoteManageConfirmDelete,
    RemoteManageCancelDelete,
    // #23: workspace rename + confirm-close overlay targets (the menu row itself is `ClientMenuRow`).
    RenameWorkspaceSubmit,
    RenameWorkspaceCancel,
    ConfirmCloseWorkspaceConfirm,
    ConfirmCloseWorkspaceCancel,
    /// C5: a row of the open session picker — listed sessions plus the trailing `new session…`
    /// row, indexed together. A `Down(Left)` here activates it (switch / open the input).
    SessionPickerRow {
        index: usize,
    },
    // C6: the new-session input's action buttons, mirroring the rename overlay's pair.
    NewSessionSubmit,
    NewSessionCancel,
}

#[derive(Clone)]
struct WorkspaceRoute {
    server_id: ServerId,
    workspace_id: Option<String>,
    disabled: bool,
}

#[derive(Clone)]
struct AgentRoute {
    server_id: ServerId,
    agent_id: String,
}

struct ClientSidebarSnapshot {
    app: crate::app::AppState,
    filter_label: String,
    workspace_routes: Vec<WorkspaceRoute>,
    // #19 (host half): `banner_idx -> server_id`, in the SAME order banners are emitted
    // (`host_banner_server_ids`), so `host_banner_areas[i]` resolves to `host_banner_server_ids[i]`
    // deterministically (render == hit geometry).
    host_banner_server_ids: Vec<ServerId>,
    agent_routes: Vec<AgentRoute>,
    // #25: the SELECTED workspace's agent routes, in pane order — the SAME order the collapsed
    // detail section renders `pane_details`. Carried separately from the scope-dependent flat
    // `agent_routes` so a collapsed agent-detail row resolves to `Agent { server_id, agent_id }`
    // regardless of the (irrelevant-when-collapsed) agents-panel scope.
    collapsed_detail_agent_routes: Vec<AgentRoute>,
    // overlay carriers (items 1 & 3), all ui-owned/cloned — see Area 3:
    add_remote_form: Option<crate::client::supervisor::AddRemoteForm>, // item 1
    new_workspace_picker: Option<(Vec<crate::client::supervisor::ServerDestination>, usize)>, // item 1
    // item 3: the overlay state plus the snapshot of secondary rows it renders. The closure maps
    // `RemoteManageRow` -> ui-owned `RemoteManageRowView` before calling `render_*` (layering).
    remote_manage: Option<(
        crate::client::supervisor::RemoteManageOverlay,
        Vec<crate::client::supervisor::RemoteManageRow>,
    )>,
    // #47: the one client menu (launcher / workspace context / host context), cloned out of the
    // model. The render closure maps it into a ui-owned `ClientMenuView` before drawing (layering
    // rule); hit-test reads its anchor + baked item labels/flags from the same clone.
    client_menu: Option<crate::client::supervisor::ClientMenu>,
    // #23: the rename / confirm-close follow-on overlays a workspace menu row promotes into.
    rename_workspace: Option<crate::client::supervisor::RenameWorkspaceForm>,
    confirm_close_workspace: Option<crate::client::supervisor::ConfirmCloseWorkspace>,
    // Worktree-menu parity: the worktree follow-on overlays (new / delete-confirm / open-picker).
    new_worktree: Option<crate::client::supervisor::NewWorktreeForm>,
    confirm_delete_worktree: Option<crate::client::supervisor::ConfirmDeleteWorktree>,
    worktree_picker: Option<crate::client::supervisor::WorktreePicker>,
    // C4/C5/C6: the host-menu session follow-on overlays (picker + new-session input).
    session_picker: Option<crate::client::supervisor::SessionPicker>,
    new_session: Option<crate::client::supervisor::NewSessionForm>,
    // #47: the one drag offset (cols, rows) shared by EVERY overlay, cloned from the model. Render,
    // hit-test, and the content-exclusion rect shift the open overlay's default popup by this.
    overlay_drag_offset: (i16, i16),
    // #53: the open overlay's drag-shifted, on-screen-clamped popup rect — computed ONCE here so
    // render, hit-test, hover-test, exclusion, the top-border drag, and the #56 hover overlay all
    // read one rect (mirrors how `ViewState` caches `workspace_card_areas`). `None` when no overlay
    // is open or it does not fit. Selection-independent, so it stays valid across #56 HoverRedraws.
    overlay_popup: Option<Rect>,
}

impl ClientCompositor {
    pub(crate) fn new(sidebar_width: u16) -> Self {
        Self {
            sidebar_width,
            workspace_scroll: 0,
            agent_panel_scroll: 0,
            resizing_sidebar: false,
            section_split: None,
            resizing_section: false,
            last_divider_down: None,
            last_resize_emitted: None,
            workspace_press: None,
            host_press: None,
            scrollbar_drag: None,
            animation_tick: 0,
            hover: None,
            pending_hover_pos: None,
            agent_panel_scope: crate::app::state::AgentPanelScope::default(),
            sidebar_collapsed: false,
            collapse_progress: 0.0,
            prefix_armed: false,
            prefix_pending_bytes: None,
            collapsed_space_keys: std::collections::HashSet::new(),
            menu_drag: None,
            working_since: HashMap::new(),
        }
    }

    /// The RESTING (expanded) sidebar width. #71: production geometry must use
    /// `effective_sidebar_width` (collapse-aware) instead — the last production caller of this
    /// accessor was the collapsed-click-offset bug. Test-only accessor now.
    #[cfg(test)]
    pub(crate) fn sidebar_width(&self) -> u16 {
        self.sidebar_width
    }

    /// #24: whether the prefix key has been pressed and the next key should be matched against
    /// prefix-mode sidebar-nav bindings.
    pub(crate) fn prefix_armed(&self) -> bool {
        self.prefix_armed
    }

    /// #24/#30: arm prefix mode (the configured prefix key was pressed), buffering its raw bytes so
    /// an unhandled follow-up key can be replayed to the server as `prefix + key`.
    pub(crate) fn arm_prefix(&mut self, prefix_bytes: Vec<u8>) {
        self.prefix_armed = true;
        self.prefix_pending_bytes = Some(prefix_bytes);
    }

    /// #24: clear prefix mode (a key was resolved/consumed, or it did not match a binding).
    pub(crate) fn disarm_prefix(&mut self) {
        self.prefix_armed = false;
        self.prefix_pending_bytes = None;
    }

    /// #30: take the buffered prefix-key bytes, used to replay `prefix + follow-up` to the server
    /// when the follow-up is not a client-handled sidebar action. Leaves the buffer empty.
    pub(crate) fn take_prefix_pending_bytes(&mut self) -> Option<Vec<u8>> {
        self.prefix_pending_bytes.take()
    }

    /// #24: test accessor for the client-local collapsed-sidebar flag (the value `from_model`
    /// feeds into `app.sidebar_collapsed`). Lets the #24 key-nav tests assert the collapse toggle
    /// without reaching into the private field.
    #[cfg(test)]
    pub(crate) fn sidebar_collapsed_for_test(&self) -> bool {
        self.sidebar_collapsed
    }

    #[cfg(test)]
    pub(crate) fn agent_panel_scope(&self) -> crate::app::state::AgentPanelScope {
        self.agent_panel_scope
    }

    /// #20: flip the agents-panel scope and reset the panel scroll, mirroring the monolithic
    /// host's toggle handler (`src/app/input/mouse.rs:525`). Client-local; no server traffic.
    pub(crate) fn toggle_agent_panel_scope(&mut self) {
        use crate::app::state::AgentPanelScope;
        self.agent_panel_scope = match self.agent_panel_scope {
            AgentPanelScope::CurrentWorkspace => AgentPanelScope::AllWorkspaces,
            AgentPanelScope::AllWorkspaces => AgentPanelScope::CurrentWorkspace,
        };
        self.agent_panel_scroll = 0;
    }

    /// #25: flip the client-local collapsed-sidebar view state. Mirrors the monolithic host's
    /// collapse toggle; `from_model` feeds the flag into `app.sidebar_collapsed`, which gates the
    /// SHARED renderer onto its narrow collapsed layout. Client-local; no server traffic.
    pub(crate) fn toggle_sidebar_collapsed(&mut self) {
        self.sidebar_collapsed = !self.sidebar_collapsed;
    }

    /// #9: the collapse-animation target — 1.0 (mini) when collapsed, 0.0 (full) when expanded.
    fn sidebar_collapse_target(&self) -> f32 {
        if self.sidebar_collapsed {
            1.0
        } else {
            0.0
        }
    }

    /// #9: advance the collapse/expand width slide one tick toward the target. Driven by the loop's
    /// gated 80ms Timer (alongside `advance_animation_tick`); a no-op once settled. Snaps the final
    /// fractional step so the slide reaches the exact target instead of asymptoting.
    pub(crate) fn step_sidebar_width_animation(&mut self) {
        let target = self.sidebar_collapse_target();
        let delta = target - self.collapse_progress;
        if delta.abs() <= SIDEBAR_COLLAPSE_ANIM_STEP {
            self.collapse_progress = target;
        } else {
            self.collapse_progress += SIDEBAR_COLLAPSE_ANIM_STEP * delta.signum();
        }
    }

    /// #9: whether the collapse/expand width is mid-slide, so the loop keeps the 80ms animation wake
    /// alive (via `next_select_deadline`) until it settles. Pairs with `sidebar_wants_animation`.
    pub(crate) fn sidebar_width_animating(&self) -> bool {
        (self.sidebar_collapse_target() - self.collapse_progress).abs() > f32::EPSILON
    }

    /// #22: toggle a worktree group's collapsed state in the client-local set (no server round-trip,
    /// since collapse of the aggregated multi-host view is a per-client display concern). Mirrors the
    /// server's `mouse.rs` chevron toggle (remove if present, else insert). Fed into `from_model`.
    pub(crate) fn toggle_collapsed_space_key(&mut self, key: String) {
        if !self.collapsed_space_keys.remove(&key) {
            self.collapsed_space_keys.insert(key);
        }
    }

    /// Whether a worktree group is collapsed in this client's local view. Read by the workspace
    /// context menu at open time so its expand/collapse row bakes the matching label.
    pub(crate) fn space_key_is_collapsed(&self, key: &str) -> bool {
        self.collapsed_space_keys.contains(key)
    }

    /// #22: test accessor for the client-local collapsed worktree-group set, so the chevron-toggle
    /// tests can assert the set's membership without reaching into the private field.
    #[cfg(test)]
    pub(crate) fn collapsed_space_keys_for_test(&self) -> &std::collections::HashSet<String> {
        &self.collapsed_space_keys
    }

    /// Advance the single client-owned animation clock by `step`. Called ONLY from the
    /// `run_client_loop` `Timer` arm (never during render). `from_model` reads it into
    /// `AppState.spinner_tick`; items 2/7 consume the SAME tick (no second clock).
    pub(crate) fn advance_animation_tick(&mut self, step: u32) {
        self.animation_tick = self.animation_tick.wrapping_add(step);
    }

    pub(crate) fn animation_tick(&self) -> u32 {
        self.animation_tick
    }

    /// Insert/refresh the working-start instant for `(server_id, agent_id)`. Called by the
    /// event-loop upkeep helper before compose so the live duration timer survives recompose.
    pub(crate) fn seed_working_since(&mut self, key: (ServerId, String), now: Instant) {
        self.working_since.entry(key).or_insert(now);
    }

    /// Drop every working-start instant whose key is not in `keep`. Keeps the map bounded to
    /// currently-Working agents (option (a) freshness, contract Area 1 / Area 7 §6).
    pub(crate) fn retain_working_since<F>(&mut self, mut keep: F)
    where
        F: FnMut(&(ServerId, String)) -> bool,
    {
        self.working_since.retain(|key, _| keep(key));
    }

    /// item 7: update the client-truth sidebar hover target, returning whether it changed. The
    /// caller redraws only on a change so a same-row motion sweep coalesces to zero redraws.
    pub(crate) fn set_hover(
        &mut self,
        next: Option<crate::app::state::SidebarHoverTarget>,
    ) -> bool {
        let changed = self.hover != next;
        self.hover = next;
        changed
    }

    /// item 7: the current client-truth hover target. Read by the `Moved` dispatch so motion off
    /// the sidebar still clears a stale highlight, and by render mirroring in `from_model`.
    pub(crate) fn hover(&self) -> Option<crate::app::state::SidebarHoverTarget> {
        self.hover
    }

    /// #48: record the latest sidebar motion WITHOUT resolving it. Resolving every motion event
    /// through `hover_test` rebuilds the O(hosts×agents) `from_model` snapshot per event — the
    /// <1fps hover flood (issue #48). The `Moved` dispatch stores the position here (O(1)) and
    /// `resolve_pending_hover` runs `hover_test` once per frame at the deferred-render flush.
    pub(crate) fn set_pending_hover_pos(&mut self, pos: (u16, u16)) {
        self.pending_hover_pos = Some(pos);
    }

    /// #48: whether a sidebar motion is waiting to be resolved. The `Moved` dispatch keeps
    /// intercepting motion while this is set (even off the sidebar) so a sweep that leaves the
    /// sidebar still resolves to `None` and clears the highlight — the role `hover().is_some()`
    /// plays once the hover has been resolved.
    pub(crate) fn has_pending_hover(&self) -> bool {
        self.pending_hover_pos.is_some()
    }

    /// #48: resolve the latest pending sidebar motion into the hover target, ONCE. This runs the
    /// expensive `hover_test`/`from_model` a single time at the per-frame deferred-render flush, not
    /// once per motion event. Returns whether the hover target changed (so a same-position sweep
    /// coalesces to no visible change). A no-op (returns `false`) when nothing is pending.
    pub(crate) fn resolve_pending_hover(
        &mut self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        host_width: u16,
        host_height: u16,
    ) -> bool {
        let Some((col, row)) = self.pending_hover_pos.take() else {
            return false;
        };
        let next = self.hover_test(model, col, row, host_width, host_height);
        self.set_hover(next)
    }

    #[cfg(test)]
    pub(crate) fn working_since_len(&self) -> usize {
        self.working_since.len()
    }

    #[cfg(test)]
    pub(crate) fn working_since_at(&self, key: &(ServerId, String)) -> Option<Instant> {
        self.working_since.get(key).copied()
    }

    pub(crate) fn handle_sidebar_resize_mouse(
        &mut self,
        mouse: &crossterm::event::MouseEvent,
        host_width: u16,
        host_height: u16,
        settings: &crate::api::schema::UiSettingsInfo,
        now: Instant,
    ) -> Option<SidebarResizeOutcome> {
        use crossterm::event::{MouseButton, MouseEventKind};

        let sidebar_width = self.effective_sidebar_width(host_width);
        let divider_col = sidebar_width.checked_sub(1)?;
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) if mouse.column == divider_col => {
                // #26: a second press on the divider within the double-click window resets the
                // width to the configured default (mirrors the host's divider double-click), rather
                // than starting another drag. Clear the timestamp so a third click can't chain.
                let double_click = self
                    .last_divider_down
                    .is_some_and(|prev| now.duration_since(prev) <= DIVIDER_DOUBLE_CLICK_WINDOW);
                if double_click {
                    self.resizing_sidebar = false;
                    self.last_divider_down = None;
                    // #17: a reset is a single settled size — clear the throttle so it ships now.
                    self.last_resize_emitted = None;
                    self.sidebar_width = settings
                        .sidebar_default_width
                        .clamp(settings.sidebar_min_width, settings.sidebar_max_width);
                    // The reset changes the content width, so the remote PTY must resize.
                    let (cols, rows) = self.content_size(host_width, host_height);
                    Some(SidebarResizeOutcome::Resized(cols, rows))
                } else {
                    self.resizing_sidebar = true;
                    self.last_divider_down = Some(now);
                    // #17: a fresh drag — clear the throttle so its first tick resizes immediately.
                    self.last_resize_emitted = None;
                    // Starting a drag does not change the width yet — only redraw.
                    Some(SidebarResizeOutcome::Redraw)
                }
            }
            MouseEventKind::Drag(MouseButton::Left) if self.resizing_sidebar => {
                // #26: a drag is a resize gesture, not part of a double-click — clear the press
                // timestamp so the next press starts a fresh double-click window (a press → drag →
                // press sequence must NOT reset to default).
                self.last_divider_down = None;
                self.set_sidebar_width_from_column(
                    mouse.column,
                    host_width,
                    settings.sidebar_min_width,
                    settings.sidebar_max_width,
                );
                let (cols, rows) = self.content_size(host_width, host_height);
                // #17: latest-wins coalescing. Recompose the sidebar locally every tick (Redraw is
                // cheap and client-local), but only push the expensive remote PTY resize at most once
                // per SIDEBAR_RESIZE_THROTTLE. Intermediate ticks return Redraw so the divider still
                // tracks the cursor without flooding every server with un-coalesced resizes (which
                // each force a full-frame baseline reset + PTY reflow). The final size is flushed on Up.
                let due = self
                    .last_resize_emitted
                    .is_none_or(|prev| now.duration_since(prev) >= SIDEBAR_RESIZE_THROTTLE);
                if due {
                    self.last_resize_emitted = Some(now);
                    Some(SidebarResizeOutcome::Resized(cols, rows))
                } else {
                    Some(SidebarResizeOutcome::Redraw)
                }
            }
            MouseEventKind::Up(MouseButton::Left) if self.resizing_sidebar => {
                self.resizing_sidebar = false;
                // #17: always flush the final settled size on release, even if the last drag tick was
                // throttled to a local-only Redraw — the committed size must match where the user
                // released the divider (no stale size). Clear the throttle for the next gesture.
                self.last_resize_emitted = None;
                let (cols, rows) = self.content_size(host_width, host_height);
                Some(SidebarResizeOutcome::Resized(cols, rows))
            }
            _ => None,
        }
    }

    pub(crate) fn handle_sidebar_scroll_mouse(
        &mut self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        mouse: &crossterm::event::MouseEvent,
        host_width: u16,
        host_height: u16,
    ) -> Option<bool> {
        use crossterm::event::MouseEventKind;

        // #46: a context menu is modal — never wheel-scroll the sidebar beneath it, even if a stray
        // event reaches here past the dispatch-level guard (belt-and-suspenders).
        if model.client_menu_open() {
            return None;
        }

        let delta = match mouse.kind {
            MouseEventKind::ScrollUp => -1,
            MouseEventKind::ScrollDown => 1,
            _ => return None,
        };
        let sidebar_width = self.effective_sidebar_width(host_width);
        if sidebar_width == 0
            || host_height == 0
            || mouse.column >= sidebar_width
            || mouse.row >= host_height
        {
            return None;
        }

        let snapshot = ClientSidebarSnapshot::from_model(
            model,
            self,
            sidebar_width,
            host_width,
            host_height,
            Instant::now(),
        );
        let (_, detail_area) = crate::ui::expanded_sidebar_sections(
            snapshot.app.view.sidebar_rect,
            snapshot.app.sidebar_section_split,
        );
        let over_agent_panel = detail_area != Rect::default()
            && mouse.row >= detail_area.y
            && mouse.row < detail_area.y.saturating_add(detail_area.height);

        if over_agent_panel {
            let metrics = crate::ui::agent_panel_scroll_metrics(&snapshot.app, detail_area);
            if !crate::ui::should_show_scrollbar(metrics) {
                return Some(false);
            }
            let next = scrolled_offset(snapshot.app.agent_panel_scroll, delta, metrics);
            let changed = next != snapshot.app.agent_panel_scroll;
            self.agent_panel_scroll = next;
            return Some(changed);
        }

        let area = crate::ui::workspace_list_rect(
            snapshot.app.view.sidebar_rect,
            snapshot.app.sidebar_section_split,
        );
        let metrics = crate::ui::workspace_list_scroll_metrics(&snapshot.app, area);
        if !crate::ui::should_show_scrollbar(metrics) {
            return Some(false);
        }
        let next = scrolled_offset(snapshot.app.workspace_scroll, delta, metrics);
        let changed = next != snapshot.app.workspace_scroll;
        self.workspace_scroll = next;
        Some(changed)
    }

    /// #16: drag the spaces↔agents section divider, mirroring the monolithic host's
    /// `on_sidebar_section_divider` + `set_sidebar_section_split` (`src/app/input/`). Client-local
    /// (no server traffic): it only re-splits the sidebar's two panels, the content area is
    /// unchanged, so the caller redraws rather than resizing the remote PTY. Returns `Some(true)`
    /// when it owned the event (Down on the divider, or Drag/Up while dragging), else `None`.
    pub(crate) fn handle_sidebar_section_divider_mouse(
        &mut self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        mouse: &crossterm::event::MouseEvent,
        host_width: u16,
        host_height: u16,
    ) -> Option<bool> {
        use crossterm::event::{MouseButton, MouseEventKind};

        let sidebar_width = self.effective_sidebar_width(host_width);
        if sidebar_width == 0 || host_height == 0 {
            return None;
        }
        // Resolve the divider row from the SAME rendered geometry the renderer uses, so a click
        // lands on exactly the drawn divider (render == hit_test). `sidebar_rect`/`split` are Copy,
        // so the snapshot borrow ends here and the match below can mutate `self`.
        let snapshot = ClientSidebarSnapshot::from_model(
            model,
            self,
            sidebar_width,
            host_width,
            host_height,
            Instant::now(),
        );
        let sidebar_rect = snapshot.app.view.sidebar_rect;
        let divider = crate::ui::sidebar_section_divider_rect(
            sidebar_rect,
            snapshot.app.sidebar_section_split,
        );

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left)
                if rect_contains(divider, mouse.column, mouse.row) =>
            {
                self.resizing_section = true;
                self.set_section_split_from_row(sidebar_rect, mouse.row);
                Some(true)
            }
            MouseEventKind::Drag(MouseButton::Left) if self.resizing_section => {
                self.set_section_split_from_row(sidebar_rect, mouse.row);
                Some(true)
            }
            MouseEventKind::Up(MouseButton::Left) if self.resizing_section => {
                self.resizing_section = false;
                Some(true)
            }
            _ => None,
        }
    }

    /// #16: set the section split from an absolute row, clamped 0.1..0.9 (mirrors the host's
    /// `set_sidebar_section_split`). Requires a tall-enough sidebar (>= 6 rows), matching
    /// `sidebar_section_divider_rect`'s guard.
    fn set_section_split_from_row(&mut self, sidebar_rect: Rect, row: u16) {
        let content_height = sidebar_rect.height;
        if content_height < 6 {
            return;
        }
        let relative_y = row.saturating_sub(sidebar_rect.y);
        let ratio = (relative_y as f32) / (content_height as f32);
        self.section_split = Some(ratio.clamp(0.1, 0.9));
    }

    /// #21: scrollbar track-click + thumb-drag for the workspace and agent lists (client-local; the
    /// scroll offsets already live on the compositor). A `Down` on a thumb starts a drag, a `Down`
    /// on the track pages to that position, a `Drag` moves the active thumb, and `Up` ends it.
    /// Returns `Some(changed)` when it owned the event, else `None` (caller continues dispatch).
    pub(crate) fn handle_sidebar_scrollbar_mouse(
        &mut self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        mouse: &crossterm::event::MouseEvent,
        host_width: u16,
        host_height: u16,
    ) -> Option<bool> {
        use crossterm::event::{MouseButton, MouseEventKind};

        // #46: a context menu is modal — never let the sidebar scrollbar (track click / thumb drag)
        // act while one is open, even if a stray event reaches here past the dispatch-level guard.
        // A release still clears any leaked in-progress drag so it can't resume after the menu closes.
        if model.client_menu_open() {
            if matches!(mouse.kind, MouseEventKind::Up(MouseButton::Left)) {
                self.scrollbar_drag = None;
            }
            return None;
        }

        // A release always ends an active drag, regardless of geometry.
        if matches!(mouse.kind, MouseEventKind::Up(MouseButton::Left)) {
            return self.scrollbar_drag.take().map(|_| false);
        }
        let is_press = matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left));
        let is_drag = matches!(mouse.kind, MouseEventKind::Drag(MouseButton::Left))
            && self.scrollbar_drag.is_some();
        if !is_press && !is_drag {
            return None;
        }
        let sidebar_width = self.effective_sidebar_width(host_width);
        if sidebar_width == 0 || host_height == 0 {
            return None;
        }

        // Snapshot geometry/metrics are Copy, so the immutable borrow of `self` (via `from_model`)
        // ends here and the offset writes below can mutate `self`.
        let snapshot = ClientSidebarSnapshot::from_model(
            model,
            self,
            sidebar_width,
            host_width,
            host_height,
            Instant::now(),
        );
        let ws_area = crate::ui::workspace_list_rect(
            snapshot.app.view.sidebar_rect,
            snapshot.app.sidebar_section_split,
        );
        let (_, agent_area) = crate::ui::expanded_sidebar_sections(
            snapshot.app.view.sidebar_rect,
            snapshot.app.sidebar_section_split,
        );
        let ws_track = crate::ui::workspace_list_scrollbar_rect(&snapshot.app, ws_area);
        let agent_track = crate::ui::agent_panel_scrollbar_rect(&snapshot.app, agent_area);
        let ws_metrics = crate::ui::workspace_list_scroll_metrics(&snapshot.app, ws_area);
        let agent_metrics = crate::ui::agent_panel_scroll_metrics(&snapshot.app, agent_area);

        if is_press {
            if let Some(track) = ws_track {
                if rect_contains(track, mouse.column, mouse.row) {
                    if let Some(grab) =
                        crate::ui::scrollbar_thumb_grab_offset(ws_metrics, track, mouse.row)
                    {
                        self.scrollbar_drag = Some(ScrollbarDrag {
                            panel: ScrollbarPanel::Workspace,
                            grab_row_offset: grab,
                        });
                        return Some(false);
                    }
                    let offset = crate::ui::scrollbar_offset_from_row(ws_metrics, track, mouse.row);
                    return Some(self.set_workspace_scroll_from_bottom(ws_metrics, offset));
                }
            }
            if let Some(track) = agent_track {
                if rect_contains(track, mouse.column, mouse.row) {
                    if let Some(grab) =
                        crate::ui::scrollbar_thumb_grab_offset(agent_metrics, track, mouse.row)
                    {
                        self.scrollbar_drag = Some(ScrollbarDrag {
                            panel: ScrollbarPanel::Agent,
                            grab_row_offset: grab,
                        });
                        return Some(false);
                    }
                    let offset =
                        crate::ui::scrollbar_offset_from_row(agent_metrics, track, mouse.row);
                    return Some(self.set_agent_scroll_from_bottom(agent_metrics, offset));
                }
            }
            return None;
        }

        // is_drag: move the active thumb, keeping the grab point under the pointer.
        let drag = self.scrollbar_drag?;
        match drag.panel {
            ScrollbarPanel::Workspace => {
                let track = ws_track?;
                let offset = crate::ui::scrollbar_offset_from_drag_row(
                    ws_metrics,
                    track,
                    mouse.row,
                    drag.grab_row_offset,
                );
                Some(self.set_workspace_scroll_from_bottom(ws_metrics, offset))
            }
            ScrollbarPanel::Agent => {
                let track = agent_track?;
                let offset = crate::ui::scrollbar_offset_from_drag_row(
                    agent_metrics,
                    track,
                    mouse.row,
                    drag.grab_row_offset,
                );
                Some(self.set_agent_scroll_from_bottom(agent_metrics, offset))
            }
        }
    }

    /// #21: convert a scrollbar `offset_from_bottom` to the workspace scroll offset and store it,
    /// mirroring the host's `set_workspace_list_offset_from_bottom`. Returns whether it changed.
    fn set_workspace_scroll_from_bottom(
        &mut self,
        metrics: crate::pane::ScrollMetrics,
        offset_from_bottom: usize,
    ) -> bool {
        let next = metrics
            .max_offset_from_bottom
            .saturating_sub(offset_from_bottom);
        let changed = next != self.workspace_scroll;
        self.workspace_scroll = next;
        changed
    }

    /// #21: agent-panel sibling of `set_workspace_scroll_from_bottom`.
    fn set_agent_scroll_from_bottom(
        &mut self,
        metrics: crate::pane::ScrollMetrics,
        offset_from_bottom: usize,
    ) -> bool {
        let next = metrics
            .max_offset_from_bottom
            .saturating_sub(offset_from_bottom);
        let changed = next != self.agent_panel_scroll;
        self.agent_panel_scroll = next;
        changed
    }

    /// #19: record a press on a workspace card (called when a `Down(Left)` hit-tests to a
    /// workspace). The click still focuses immediately (focus-on-down, unchanged); this only arms a
    /// potential drag-reorder that commits on release.
    pub(crate) fn begin_workspace_press(
        &mut self,
        server_id: ServerId,
        workspace_id: String,
        col: u16,
        row: u16,
    ) {
        self.workspace_press = Some(WorkspacePress {
            server_id,
            workspace_id,
            origin_col: col,
            origin_row: row,
            dragging: false,
            last_drag_row: None,
        });
    }

    /// #19: feed a `Drag`/`Up` to the workspace drag-reorder tracker. `Down` is recorded separately
    /// via `begin_workspace_press` (so the click can still focus). Returns `Ignored` for everything
    /// that is not an active drag, so the caller falls through to its normal dispatch.
    pub(crate) fn handle_workspace_reorder_mouse(
        &mut self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        mouse: &crossterm::event::MouseEvent,
        host_width: u16,
        host_height: u16,
    ) -> WorkspaceReorderOutcome {
        use crossterm::event::{MouseButton, MouseEventKind};

        match mouse.kind {
            MouseEventKind::Drag(MouseButton::Left) => {
                let Some(press) = self.workspace_press.as_mut() else {
                    return WorkspaceReorderOutcome::Ignored;
                };
                let moved = mouse
                    .column
                    .abs_diff(press.origin_col)
                    .max(mouse.row.abs_diff(press.origin_row));
                if !press.dragging && moved < WORKSPACE_DRAG_THRESHOLD {
                    return WorkspaceReorderOutcome::Ignored;
                }
                press.dragging = true;
                // #19: remember the pointer row so `from_model` can draw a live drop indicator
                // (the slot this drag would commit to) every frame until release.
                press.last_drag_row = Some(mouse.row);
                WorkspaceReorderOutcome::Dragging
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let Some(press) = self.workspace_press.take() else {
                    return WorkspaceReorderOutcome::Ignored;
                };
                if !press.dragging {
                    // A plain click (no drag) already focused on the down-press; nothing to commit.
                    return WorkspaceReorderOutcome::Ignored;
                }
                match self.workspace_reorder_target(
                    model,
                    &press,
                    mouse.row,
                    host_width,
                    host_height,
                ) {
                    Some(insert_index) => WorkspaceReorderOutcome::Commit {
                        server_id: press.server_id,
                        workspace_id: press.workspace_id,
                        insert_index,
                    },
                    None => WorkspaceReorderOutcome::Cancelled,
                }
            }
            _ => WorkspaceReorderOutcome::Ignored,
        }
    }

    /// #19: resolve a drop row to an insert position within the pressed server's workspace list.
    /// Reorder is constrained to the source server's rows (a workspace belongs to exactly one
    /// server). The drop row's visual midpoint count gives a *render position*; that position is
    /// then mapped to the STORAGE index of the card it lands on (`card.ws_idx - base`), matching the
    /// server-local `move_workspace` contract. A bare count diverges from storage order under
    /// worktree grouping (#22, render order != storage order) or a scrolled list (leading cards
    /// omitted), so we must read the actual `ws_idx` rather than counting visible cards.
    fn workspace_reorder_target(
        &self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        press: &WorkspacePress,
        drop_row: u16,
        host_width: u16,
        host_height: u16,
    ) -> Option<usize> {
        let sidebar_width = self.effective_sidebar_width(host_width);
        if sidebar_width == 0 || host_height == 0 {
            return None;
        }
        let snapshot = ClientSidebarSnapshot::from_model(
            model,
            self,
            sidebar_width,
            host_width,
            host_height,
            Instant::now(),
        );
        // The pressed server's first GLOBAL `ws_idx`. `workspace_routes` is the full (never scrolled,
        // storage-ordered) per-server flat list, so this anchors the server's contiguous block and
        // lets a global `ws_idx` be translated into the server-local index `move_workspace` expects.
        let base = snapshot
            .workspace_routes
            .iter()
            .position(|route| route.server_id == press.server_id && route.workspace_id.is_some())?;
        // The pressed server's cards, in render order, paired with their true global `ws_idx`.
        let server_cards: Vec<(usize, Rect)> = snapshot
            .app
            .view
            .workspace_card_areas
            .iter()
            .filter_map(|card| {
                let route = snapshot.workspace_routes.get(card.ws_idx)?;
                (route.server_id == press.server_id && route.workspace_id.is_some())
                    .then_some((card.ws_idx, card.rect))
            })
            .collect();
        // Resolve to the global `ws_idx` slot, then offset into the server's contiguous block to the
        // server-local index `move_workspace` expects. Shares `block_insert_global_index` with the
        // live drop indicator (`from_model`) so the preview and the commit can never diverge.
        let global = block_insert_global_index(&server_cards, drop_row)?;
        Some(global.saturating_sub(base))
    }

    /// #19 (host half): record a press on a host banner (called when a `Down(Left)` hit-tests to a
    /// `HostBanner`). Mirrors `begin_workspace_press`: the click still focuses-on-down (handled by
    /// the normal dispatch); this only arms a potential host drag-reorder that commits on release.
    pub(crate) fn begin_host_press(&mut self, server_id: ServerId, col: u16, row: u16) {
        self.host_press = Some(HostPress {
            server_id,
            origin_col: col,
            origin_row: row,
            dragging: false,
            last_drag_row: None,
        });
    }

    /// #19 (host half): feed a `Drag`/`Up` to the host drag-reorder tracker, mirroring
    /// `handle_workspace_reorder_mouse`. `Down` is recorded separately via `begin_host_press` (so
    /// the click can still focus). Returns `Ignored` for everything that is not an active host drag.
    pub(crate) fn handle_host_reorder_mouse(
        &mut self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        mouse: &crossterm::event::MouseEvent,
        host_width: u16,
        host_height: u16,
    ) -> HostReorderOutcome {
        use crossterm::event::{MouseButton, MouseEventKind};

        match mouse.kind {
            MouseEventKind::Drag(MouseButton::Left) => {
                let Some(press) = self.host_press.as_mut() else {
                    return HostReorderOutcome::Ignored;
                };
                let moved = mouse
                    .column
                    .abs_diff(press.origin_col)
                    .max(mouse.row.abs_diff(press.origin_row));
                if !press.dragging && moved < WORKSPACE_DRAG_THRESHOLD {
                    return HostReorderOutcome::Ignored;
                }
                press.dragging = true;
                press.last_drag_row = Some(mouse.row);
                HostReorderOutcome::Dragging
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let Some(press) = self.host_press.take() else {
                    return HostReorderOutcome::Ignored;
                };
                if !press.dragging {
                    // A plain click (no drag) already focused on the down-press; nothing to commit.
                    return HostReorderOutcome::Ignored;
                }
                match self.host_reorder_target(model, mouse.row, host_width, host_height) {
                    Some(insert_index) => HostReorderOutcome::Commit {
                        source_server_id: press.server_id,
                        insert_index,
                    },
                    None => HostReorderOutcome::Cancelled,
                }
            }
            _ => HostReorderOutcome::Ignored,
        }
    }

    /// #19 (host half): resolve a drop row to an insert position among the ORDERED host list, so the
    /// host drop slot is ALWAYS a host boundary — never inside a space block. `reorder_server`
    /// expects a position in the full, never-scrolled host list (`self.servers` order, == each
    /// banner's `banner_idx`), so resolve the render position through the banner's true `banner_idx`
    /// via `block_insert_global_index` rather than a bare count over the (scroll-truncated) visible
    /// banners — otherwise a leading banner scrolled off the top would offset the committed slot.
    /// (The live host indicator instead wants a visible-slice position, since `host_drop_indicator_row`
    /// indexes the visible banners positionally; it keeps the bare `server_insert_index` count.)
    fn host_reorder_target(
        &self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        drop_row: u16,
        host_width: u16,
        host_height: u16,
    ) -> Option<usize> {
        // C2: a host reorder is only well-defined in the unfiltered ("all hosts") view, where each
        // banner's `banner_idx` equals its position in `self.servers` — exactly the space
        // `reorder_server` indexes. Under a single-server filter only one banner is visible, so a
        // banner-space drop index would be mis-applied to the full server list (moving the wrong
        // host). Refuse the reorder rather than commit a bogus slot.
        if !matches!(model.filter(), crate::client::supervisor::ServerFilter::All) {
            return None;
        }
        let sidebar_width = self.effective_sidebar_width(host_width);
        if sidebar_width == 0 || host_height == 0 {
            return None;
        }
        let snapshot = ClientSidebarSnapshot::from_model(
            model,
            self,
            sidebar_width,
            host_width,
            host_height,
            Instant::now(),
        );
        let host_cards: Vec<(usize, Rect)> = snapshot
            .app
            .view
            .host_banner_areas
            .iter()
            .map(|banner| (banner.banner_idx, banner.rect))
            .collect();
        block_insert_global_index(&host_cards, drop_row)
    }

    fn set_sidebar_width_from_column(
        &mut self,
        column: u16,
        host_width: u16,
        configured_min_width: u16,
        configured_max_width: u16,
    ) {
        if host_width <= 1 {
            self.sidebar_width = host_width;
            return;
        }
        let max_width = configured_max_width.min(host_width.saturating_sub(1));
        let min_width = configured_min_width.min(max_width);
        self.sidebar_width = column.saturating_add(1).clamp(min_width, max_width);
    }

    /// #45: build the content-independent sidebar shell (see [`ComposedShell`]). This is the
    /// expensive half of `compose_frame` — `from_model` + a full ratatui sidebar render — so the
    /// caller caches the result and reuses it across pure content frames, only re-laying the live
    /// content region with [`overlay_content_onto_shell`].
    ///
    /// #56: the shell is rendered with NO hover/selection highlight baked in, and the highlight is
    /// painted per-frame by [`apply_hover_overlay`] from the [`HoverGeometry`] this carries. So the
    /// cached shell stays valid across hover changes (a hover no longer drops the cache) — only a
    /// genuine model/view/size change rebuilds it.
    pub(crate) fn build_shell(
        &self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        host_width: u16,
        host_height: u16,
        now: Instant,
    ) -> ComposedShell {
        self.build_shell_inner(
            model,
            host_width,
            host_height,
            now,
            ShellHoverMode::Hoverless,
        )
    }

    /// #56: the old, hover-BAKED shell build — kept only as the equivalence golden for the Seam-1
    /// tests, which assert it is cell-identical to `build_shell` + [`apply_hover_overlay`]. The
    /// compositor's current hover (`set_hover`) and the model's menu selection are baked into the
    /// render, exactly as before #56.
    #[cfg(test)]
    pub(crate) fn build_shell_hover_baked(
        &self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        host_width: u16,
        host_height: u16,
        now: Instant,
    ) -> ComposedShell {
        self.build_shell_inner(model, host_width, host_height, now, ShellHoverMode::Baked)
    }

    fn build_shell_inner(
        &self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        host_width: u16,
        host_height: u16,
        now: Instant,
        hover_mode: ShellHoverMode,
    ) -> ComposedShell {
        let sidebar_width = self.effective_sidebar_width(host_width);
        let content_width = host_width.saturating_sub(sidebar_width);
        let mut snapshot = ClientSidebarSnapshot::from_model(
            model,
            self,
            sidebar_width,
            host_width,
            host_height,
            now,
        );
        // #56: compute the hover highlight geometry from the (hover-less) snapshot BEFORE clearing
        // the baked hover, so it captures the same card/row/menu rects the renderer lays out.
        let hover = compute_hover_geometry(&snapshot);
        // #56: render the shell with NO hover/selection highlight — `from_model` mirrored the live
        // hover (`compositor.set_hover`) and the menu selection into the snapshot; strip them so the
        // cached shell carries no highlight and the per-frame overlay paints whichever row is hovered.
        // A no-match sentinel (`len`) leaves every menu row unselected (render compares `idx == sel`).
        if matches!(hover_mode, ShellHoverMode::Hoverless) {
            snapshot.app.set_sidebar_hover(None);
            snapshot.app.global_menu.highlighted = snapshot.app.global_menu_labels().len();
            if let Some(menu) = snapshot.client_menu.as_mut() {
                menu.selected = menu.items.len();
            }
        }
        // The composited client overlays (add-remote / new-workspace picker / manage-remotes) float
        // over the live content like the global launcher menu: they are footer-anchored popups (NOT
        // centered, full-screen-dimmed modals). The content copy must protect EXACTLY the open
        // popup's rect(s) — so the overlay stays visible AND the rest of the content shows around
        // it. Both render and these exclusion rects derive from the SAME `*_popup_rect(anchor_area)`
        // helpers, so what we protect lines up cell-for-cell with what gets drawn. Without an open
        // overlay we fall back to protecting just the open global-menu rect.
        //
        // Derive the anchor from the snapshot already built above instead of calling
        // `overlay_anchor_area` (which rebuilds the full snapshot a second time per frame just to
        // read `sidebar_footer_rect().y` — a heavy `from_model` of terminal/route state we already
        // have). This is exactly what `overlay_anchor_area` returns.
        let anchor_area = Rect::new(0, 0, host_width, snapshot.app.sidebar_footer_rect().y);
        let mut excluded_rects: Vec<Rect> = Vec::new();
        // #47/#53: protect the open overlay's (drag-shifted) popup so it floats over the content
        // cell-for-cell — read the ONE rect the view cached for every overlay's current position (the
        // three menus + the five footer forms), keeping render == hit-test == exclusion by construction.
        excluded_rects.extend(snapshot.overlay_popup);
        // the manage delete-confirm sub-popup stays centered on top of the (possibly dragged) list.
        if let Some((overlay, _)) = snapshot.remote_manage.as_ref() {
            if overlay.confirm_delete.is_some() {
                excluded_rects.extend(crate::ui::remote_manage_confirm_popup_rect(anchor_area));
            }
        }
        let frame = render_client_shell(&snapshot, host_width, host_height);

        // item 1/3: the add-remote / new-workspace-picker / manage modals are rendered as ratatui
        // widgets inside `render_client_shell` (composited). The live content cursor must be hidden
        // while ANY modal is open so the real terminal cursor never leaks through it. The cursor
        // hide + the content copy run per-frame in `overlay_content_onto_shell`; we capture only
        // the model-derived modal-open flag here (the SAME condition as the old inline block) so
        // the cached shell carries it without re-reading the model on a reused content frame.
        // Same set as before, but sourced from the EXHAUSTIVE `client_overlay_open` match instead of
        // a hand-written `||` chain (the shape that silently made the two session overlays
        // keyboard-dead). `new_workspace_picker` is a separate model field, not a
        // `ClientOverlayState` variant, so it is still ORed in explicitly.
        let modal_open = model.any_overlay_open();

        ComposedShell {
            frame,
            excluded_rects,
            modal_open,
            sidebar_width,
            content_width,
            host_width,
            host_height,
            hover,
        }
    }

    /// Compose one client frame: the cached/rebuilt sidebar shell with the live `active_frame`
    /// content laid into it. Pure (`&self`) — production reuses the shell via `build_shell` +
    /// [`overlay_content_onto_shell`] (so this is test-only), but the output is identical either way,
    /// which is exactly what the equivalence tests assert.
    #[cfg(test)]
    pub(crate) fn compose_frame(
        &self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        active_frame: &FrameData,
        host_width: u16,
        host_height: u16,
        now: Instant,
    ) -> FrameData {
        let shell = self.build_shell(model, host_width, host_height, now);
        overlay_content_onto_shell(&shell, active_frame)
    }

    /// The footer-anchored `anchor_area` the composited client overlays (add-remote /
    /// new-workspace picker / manage-remotes) are positioned within: it spans the host top down to
    /// the sidebar footer row, so the popups open upward from the footer like the global launcher
    /// menu (instead of dead-centered). Render, content-copy exclusion, hit-test and hover-test all
    /// derive overlay geometry from this SAME rect, so they cannot drift.
    ///
    /// Production code inlines this body (`compose_frame`/`hit_test` build the snapshot once and
    /// reuse it); only tests call the helper standalone, hence `#[cfg(test)]`.
    #[cfg(test)]
    pub(crate) fn overlay_anchor_area(
        &self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        host_width: u16,
        host_height: u16,
    ) -> Rect {
        let sidebar_width = self.effective_sidebar_width(host_width);
        let snapshot = ClientSidebarSnapshot::from_model(
            model,
            self,
            sidebar_width,
            host_width,
            host_height,
            Instant::now(),
        );
        Rect::new(0, 0, host_width, snapshot.app.sidebar_footer_rect().y)
    }

    pub(crate) fn content_size(&self, host_width: u16, host_height: u16) -> (u16, u16) {
        (
            host_width
                .saturating_sub(self.effective_sidebar_width(host_width))
                .max(1),
            host_height,
        )
    }

    // #71: pub(crate) — the content mouse-forwarding gates in `client/mod.rs` must subtract the
    // SAME collapse-aware origin render/hit-test/content_size use; they previously used the
    // resting `sidebar_width()`, so a collapsed client forwarded content clicks offset by
    // (expanded − mini) columns and swallowed clicks in the gap as sidebar clicks.
    pub(crate) fn effective_sidebar_width(&self, host_width: u16) -> u16 {
        if host_width <= 1 {
            return 0;
        }
        // #9: interpolate between the full width and the mini width across `collapse_progress`, so
        // the sidebar slides on collapse/expand. At rest (progress 0.0) this is exactly the old
        // `sidebar_width.min(host-1)`. Both render and hit-test read this ONE value, so their
        // geometry stays in lockstep frame-by-frame even mid-slide.
        let mini = MINI_SIDEBAR_WIDTH.min(self.sidebar_width);
        let width = lerp_sidebar_width(self.sidebar_width, mini, self.collapse_progress);
        width.min(host_width.saturating_sub(1))
    }

    pub(crate) fn hit_test(
        &self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        x: u16,
        y: u16,
        host_width: u16,
        host_height: u16,
    ) -> Option<SidebarHitTarget> {
        let sidebar_width = self.effective_sidebar_width(host_width);
        if sidebar_width == 0 || host_height == 0 || y >= host_height {
            return None;
        }

        let snapshot = ClientSidebarSnapshot::from_model(
            model,
            self,
            sidebar_width,
            host_width,
            host_height,
            Instant::now(),
        );

        // item 1: the composited overlays are footer-anchored popups that float over the live
        // content, so their hit-test runs before the sidebar-width guard. Geometry is derived from
        // the SAME shared helpers the renderer uses (`new_workspace_picker_inner_rect`/`_row_rect`/
        // `add_remote_inner_rect` + the button-rect helpers) over the SAME `anchor_area`,
        // guaranteeing render == hit_test.
        let anchor_area = Rect::new(0, 0, host_width, snapshot.app.sidebar_footer_rect().y);
        // #47: every overlay hit-tests against its (drag-shifted) popup — the SAME rect the renderer
        // draws — so a dragged overlay's targets follow it and render == hit-test. #53: read the one
        // rect the view computed; render and hit-test now consume the SAME field, not two recomputes.
        let overlay_popup = snapshot.overlay_popup;
        if let Some(popup) = overlay_popup {
            if let Some(target) = hit_test_new_workspace_picker(&snapshot, popup, x, y) {
                return Some(target);
            }
            if let Some(target) = hit_test_add_remote(&snapshot, popup, x, y) {
                return Some(target);
            }
            // item 3 (Area 5): the manage overlay intercepts the whole host rect first (so a click on
            // a sidebar workspace row while the overlay is open never resolves to a `Workspace` hit).
            if snapshot.remote_manage.is_some() {
                return hit_test_remote_manage(&snapshot, popup, anchor_area, x, y);
            }
        }
        // #47: the open client menu (launcher / workspace / host) is modal — when open it owns the
        // whole host rect (its own row targets or none), so a click on a sidebar row beneath never
        // resolves to a `Workspace` hit, and the launcher gets the same modal treatment as the two
        // context menus (the #46 gap). The launcher hit-tests against its ORIGINAL `global_menu_rect`
        // surface (so click/hover line up with the unchanged dropdown render); the context menus use
        // the cursor-anchored helper. Both resolve to the unified `ClientMenuRow { index }` target.
        if let Some(menu) = snapshot.client_menu.as_ref() {
            if matches!(
                menu.kind,
                crate::client::supervisor::ClientMenuKind::GlobalLauncher
            ) {
                // #53: a GlobalLauncher `client_menu` means `overlay_popup` IS the launcher rect.
                return overlay_popup
                    .and_then(|rect| global_menu_item_index_at(&snapshot.app, rect, x, y))
                    .map(|index| SidebarHitTarget::ClientMenuRow { index });
            }
            return hit_test_client_menu(&snapshot, x, y);
        }
        if let Some(popup) = overlay_popup {
            if snapshot.rename_workspace.is_some() {
                return hit_test_rename_workspace(&snapshot, popup, x, y);
            }
            if snapshot.confirm_close_workspace.is_some() {
                return hit_test_confirm_close_workspace(&snapshot, popup, x, y);
            }
            // C5: the session picker is CLICKABLE ("클릭해서 선택할수 있고"), unlike the
            // keyboard-only worktree overlays below. It is modal all the same: a press that misses
            // every row resolves to nothing, never to a sidebar row beneath it.
            if snapshot.session_picker.is_some() {
                return hit_test_session_picker(&snapshot, popup, x, y);
            }
            if snapshot.new_session.is_some() {
                return hit_test_new_session(&snapshot, popup, x, y);
            }
        }
        // Worktree-menu parity: the worktree follow-on overlays are keyboard-driven; while one is
        // open it owns the host rect (a click resolves to nothing rather than a row beneath it).
        if snapshot.new_worktree.is_some()
            || snapshot.confirm_delete_worktree.is_some()
            || snapshot.worktree_picker.is_some()
            || snapshot.session_picker.is_some()
            || snapshot.new_session.is_some()
        {
            return None;
        }

        if x >= sidebar_width {
            return None;
        }

        // #25: the collapse/expand toggle (bottom-right 1x1) is drawn in BOTH modes by
        // `render_sidebar_toggle`, using the SAME `collapsed_sidebar_toggle_rect`. Check it before
        // any mode-specific rows so it is hittable to collapse (expanded) AND to expand (collapsed).
        if rect_contains(
            crate::ui::collapsed_sidebar_toggle_rect(snapshot.app.view.sidebar_rect),
            x,
            y,
        ) {
            return Some(SidebarHitTarget::CollapsedSidebarToggle);
        }

        // #25: in collapsed mode the renderer drew the narrow workspace-glance + agent-detail
        // sections, so hit-test reads the COLLAPSED geometry and SKIPS every expanded hit-test
        // (filter/new/menu/banners/cards/scope/agent-rows all use expanded geometry).
        if snapshot.app.sidebar_collapsed {
            return collapsed_hit_test(&snapshot, x, y);
        }

        if rect_contains(
            filter_label_rect(snapshot.app.view.sidebar_rect, &snapshot.filter_label),
            x,
            y,
        ) {
            return Some(SidebarHitTarget::Filter);
        }
        if rect_contains(snapshot.app.sidebar_new_button_rect(), x, y) {
            return Some(SidebarHitTarget::New);
        }
        if rect_contains(snapshot.app.global_launcher_rect(), x, y) {
            return Some(SidebarHitTarget::Menu);
        }

        // #19 (host half): a press on a host banner resolves to that banner's host. Banner rows
        // produce no `WorkspaceCardArea`, so the card loop below never matches them; resolved here
        // before the cards so a `Down(Left)` arms a host drag-reorder. Index `host_banner_server_ids`
        // by the area's TRUE `banner_idx`, not its positional `enumerate()` index — when the list is
        // scrolled a leading banner is omitted from `host_banner_areas`, so positions no longer line
        // up with the (never-truncated) server-id list.
        for banner in snapshot.app.view.host_banner_areas.iter() {
            if rect_contains(banner.rect, x, y) {
                let server_id = snapshot.host_banner_server_ids.get(banner.banner_idx)?;
                // The status glyph cell (left edge, when configured Left) is the retry
                // affordance for a failed/disconnected host — same geometry the renderer uses
                // (`render` puts the glyph at `banner_area.rect.x`).
                if x == banner.rect.x
                    && snapshot.app.sidebar_host.glyph == crate::config::HostBannerGlyph::Left
                {
                    return Some(SidebarHitTarget::HostBannerGlyph {
                        server_id: server_id.clone(),
                    });
                }
                return Some(SidebarHitTarget::HostBanner {
                    server_id: server_id.clone(),
                });
            }
        }

        for card in &snapshot.app.view.workspace_card_areas {
            if rect_contains(card.rect, x, y) {
                // #22: a click in the chevron column (column 0 of a worktree-PARENT row) toggles the
                // group's collapsed state instead of focusing. Reuses the SERVER's chevron geometry
                // (`mouse.rs`: the chevron glyph is drawn at `card.rect.x`) and the SHARED
                // `workspace_parent_group_state` (parent = a group with >=2 members, not a linked
                // child). A NON-chevron click on the parent falls through to the `Workspace` focus
                // arm below, so the body click still focuses (matches the server contract).
                if x == card.rect.x {
                    if let Some((group_key, _collapsed)) =
                        crate::ui::workspace_parent_group_state(&snapshot.app, card.ws_idx)
                    {
                        return Some(SidebarHitTarget::WorktreeChevron { group_key });
                    }
                }
                let route = snapshot.workspace_routes.get(card.ws_idx)?;
                if route.disabled {
                    return None;
                }
                return route.workspace_id.clone().map(|workspace_id| {
                    SidebarHitTarget::Workspace {
                        server_id: route.server_id.clone(),
                        workspace_id,
                    }
                });
            }
        }

        // #20: the agents-panel scope toggle sits in the panel header; resolve it before the
        // entry rows so a click on "all"/"current" toggles scope instead of focusing an agent.
        // Geometry is the SAME helper the renderer uses (`agent_panel_toggle_rect` over the
        // `expanded_sidebar_sections` detail area), so render == hit_test.
        if rect_contains(agent_panel_toggle_hit_rect(&snapshot.app), x, y) {
            return Some(SidebarHitTarget::AgentScopeToggle);
        }

        hit_test_agent_panel(&snapshot, x, y)
    }

    /// item 7 (Area 4): resolve a mouse-motion position to a sidebar hover target, sharing the
    /// SAME `ClientSidebarSnapshot` + rect checks as `hit_test` so render geometry and hover
    /// geometry cannot drift. Returns `None` (no highlight) for:
    /// - a collapsed/zero-width sidebar (`effective_sidebar_width == 0`),
    /// - an open client menu / add-remote form / manage overlay — those own their own input (an open
    ///   client menu is modal and intercepts motion in `dispatch_open_client_menu_mouse` before this
    ///   fn), so the sidebar must not fight them,
    /// - positions outside the sidebar content,
    /// - disabled remote rows and `None`-`workspace_id` placeholders (matches `hit_test`),
    /// - non-selectable layout rows (divider/banner-skip + headers/separator — they produce no
    ///   card), and undrawn affordances (the ` new`/`menu` gate is `app.mouse_capture`).
    ///
    /// The new-workspace picker is a centered modal that DOES hover (its destination rows resolve
    /// to `NewWorkspaceDestination { row }`, before the sidebar-width guard, like `hit_test`).
    /// Never issues server traffic.
    pub(crate) fn hover_test(
        &self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        x: u16,
        y: u16,
        host_width: u16,
        host_height: u16,
    ) -> Option<crate::app::state::SidebarHoverTarget> {
        use crate::app::state::SidebarHoverTarget;

        let sidebar_width = self.effective_sidebar_width(host_width);
        if sidebar_width == 0 || host_height == 0 || y >= host_height {
            return None;
        }

        // #47: an open client menu / add-remote form / manage overlay owns input; the sidebar hover
        // must yield so the overlay hover is authoritative. An open client menu is modal and already
        // intercepts motion in `dispatch_open_client_menu_mouse` before this fn, but guard here too.
        if model.client_menu().is_some()
            || model.add_remote_form().is_some()
            || model.remote_manage_overlay().is_some()
        {
            return None;
        }

        let snapshot = ClientSidebarSnapshot::from_model(
            model,
            self,
            sidebar_width,
            host_width,
            host_height,
            Instant::now(),
        );

        // The new-workspace picker is a footer-anchored popup (item 1), so it hovers before the
        // sidebar-width guard — the SAME (drag-shifted) popup geometry `hit_test` uses for it. #53:
        // read the one cached rect, so hover-test and hit-test consume the same field, not recomputes.
        if let Some(popup) = snapshot.overlay_popup {
            if let Some(target) = hover_test_new_workspace_picker(&snapshot, popup, x, y) {
                return Some(target);
            }
        }
        // While the picker is open the dimmed sidebar beneath is inert (matches `hit_test`).
        if snapshot.new_workspace_picker.is_some() {
            return None;
        }

        if x >= sidebar_width {
            return None;
        }

        if rect_contains(
            filter_label_rect(snapshot.app.view.sidebar_rect, &snapshot.filter_label),
            x,
            y,
        ) {
            return Some(SidebarHoverTarget::Filter);
        }
        // Affordance hover respects the SAME draw gate as the renderer (`app.mouse_capture` at
        // `sidebar.rs`): the ` new`/`menu` affordances only hover when they are actually drawn.
        if snapshot.app.mouse_capture {
            if rect_contains(snapshot.app.sidebar_new_button_rect(), x, y) {
                return Some(SidebarHoverTarget::New);
            }
            if rect_contains(snapshot.app.global_launcher_rect(), x, y) {
                return Some(SidebarHoverTarget::Menu);
            }
        }

        // host-banner rect (item 2): hoverable as `HostBanner { banner_idx }` when drawn. The
        // banner rows produce no `WorkspaceCardArea`, so they are skipped by the card loop below.
        for banner in &snapshot.app.view.host_banner_areas {
            if rect_contains(banner.rect, x, y) {
                return Some(SidebarHoverTarget::HostBanner {
                    banner_idx: banner.banner_idx,
                });
            }
        }

        // item-4 space-divider rows are non-selectable (they produce no card, so the card loop
        // below would skip them). Resolve them to the defensive `Divider` target, which render
        // treats as NO-highlight (a stable `None`-equivalent). Render never lifts a divider row —
        // the contract's "hover never highlights the divider" (Decision 4).
        if snapshot.app.view.divider_rows.contains(&y) {
            return Some(SidebarHoverTarget::Divider);
        }

        for card in &snapshot.app.view.workspace_card_areas {
            if rect_contains(card.rect, x, y) {
                let route = snapshot.workspace_routes.get(card.ws_idx)?;
                // disabled remote rows and `None`-id placeholders are not selectable → no hover
                // (matches `hit_test`'s rejection so click and hover agree).
                if route.disabled || route.workspace_id.is_none() {
                    return None;
                }
                return Some(SidebarHoverTarget::Workspace {
                    ws_idx: card.ws_idx,
                });
            }
        }

        // #20: hover the scope toggle (matches the monolithic host's `resolve_sidebar_hover`
        // `ScopeToggle` arm). Same geometry as `hit_test` so hover and click agree.
        if rect_contains(agent_panel_toggle_hit_rect(&snapshot.app), x, y) {
            return Some(SidebarHoverTarget::ScopeToggle);
        }

        hover_test_agent_panel(&snapshot, x, y)
    }

    /// #47: the CURRENT popup rect of whichever client overlay is open — its default position shifted
    /// by the shared drag offset (clamped on-screen), or `None` when nothing is open / it does not
    /// fit. Covers ALL overlays: the launcher dropdown, the cursor-anchored context menus, and the
    /// footer-anchored add-remote / picker / manage / rename / confirm forms.
    fn open_overlay_popup_rect(
        &self,
        model: &crate::client::supervisor::ClientSupervisorModel,
        host_width: u16,
        host_height: u16,
    ) -> Option<Rect> {
        let sidebar_width = self.effective_sidebar_width(host_width);
        if sidebar_width == 0 || host_height == 0 {
            return None;
        }
        let snapshot = ClientSidebarSnapshot::from_model(
            model,
            self,
            sidebar_width,
            host_width,
            host_height,
            Instant::now(),
        );
        // #53: the snapshot already computed the popup once in `from_model` — read it, don't recompute.
        // (Building a fresh snapshot per drag-Down is a separate cost tracked by #51, out of scope.)
        snapshot.overlay_popup
    }

    /// #47: feed a mouse event to the open overlay's TOP-BORDER drag-to-move. A left-press on the
    /// popup's top border row starts a drag; each `Drag` moves the overlay by the pointer delta (the
    /// new offset = the offset at press + travel, clamped so the popup stays on-screen); the release
    /// ends it. Returns `Some(changed)` when the event was part of a drag (the caller redraws iff
    /// changed and does NOT also select/dismiss), or `None` when the event is not drag-related (the
    /// caller continues its normal handling). A press anywhere but the top border returns `None`, so
    /// row-select / button-clicks / outside-dismiss still work. ONE handler for every overlay.
    pub(crate) fn handle_overlay_drag(
        &mut self,
        model: &mut crate::client::supervisor::ClientSupervisorModel,
        mouse: &crossterm::event::MouseEvent,
        host_width: u16,
        host_height: u16,
    ) -> Option<bool> {
        use crossterm::event::{MouseButton, MouseEventKind};

        if !model.any_overlay_open() {
            self.menu_drag = None;
            return None;
        }
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                let popup = self.open_overlay_popup_rect(model, host_width, host_height)?;
                let on_top_border = mouse.row == popup.y
                    && mouse.column >= popup.x
                    && mouse.column < popup.x.saturating_add(popup.width);
                if !on_top_border {
                    return None;
                }
                self.menu_drag = Some(ClientMenuDrag {
                    start_col: mouse.column,
                    start_row: mouse.row,
                    start_offset: model.overlay_drag_offset(),
                });
                Some(false)
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                let drag = self.menu_drag?;
                let dx = mouse.column as i32 - drag.start_col as i32;
                let dy = mouse.row as i32 - drag.start_row as i32;
                let next = (
                    (drag.start_offset.0 as i32 + dx).clamp(i16::MIN as i32, i16::MAX as i32)
                        as i16,
                    (drag.start_offset.1 as i32 + dy).clamp(i16::MIN as i32, i16::MAX as i32)
                        as i16,
                );
                let changed = model.overlay_drag_offset() != next;
                model.set_overlay_drag_offset(next);
                Some(changed)
            }
            MouseEventKind::Up(_) => self.menu_drag.take().map(|_| false),
            _ => None,
        }
    }
}

fn scrolled_offset(current: usize, delta: i16, metrics: crate::pane::ScrollMetrics) -> usize {
    if delta.is_negative() {
        current.saturating_sub(delta.unsigned_abs() as usize)
    } else {
        current
            .saturating_add(delta as usize)
            .min(metrics.max_offset_from_bottom)
    }
}

impl Default for ClientCompositor {
    fn default() -> Self {
        Self::new(DEFAULT_SIDEBAR_WIDTH)
    }
}

impl ClientSidebarSnapshot {
    fn from_model(
        model: &crate::client::supervisor::ClientSupervisorModel,
        compositor: &ClientCompositor,
        sidebar_width: u16,
        host_width: u16,
        host_height: u16,
        now: Instant,
    ) -> Self {
        let mut app = crate::app::AppState::empty_for_client_rendering();
        let settings = model.ui_settings();
        app.sidebar_width = sidebar_width;
        app.default_sidebar_width = settings.sidebar_default_width;
        app.sidebar_min_width = settings.sidebar_min_width;
        app.sidebar_max_width = settings.sidebar_max_width;
        // #16: a client drag on the section divider overrides the settings default; otherwise
        // follow the server-provided default split.
        app.sidebar_section_split = compositor
            .section_split
            .unwrap_or_else(|| settings.sidebar_section_split());
        // #20: client-local scope drives both the rendered entries and the scroll-metric clamp
        // below, so it must be set before `agent_panel_scroll_metrics` is consulted.
        app.agent_panel_scope = compositor.agent_panel_scope;
        app.sidebar_space = settings.sidebar_spaces.clone();
        app.sidebar_agent = settings.sidebar_agents.clone();
        // item 2 (C3): host-banner styling rides UiSettingsInfo over the wire.
        app.sidebar_host = settings.sidebar_host.clone();
        app.global_menu_extra_labels = vec!["add remote", "manage remotes"];
        // #25: gate the SHARED renderer onto its collapsed layout BEFORE geometry is computed, so
        // the collapsed sections + toggle rect are what gets laid out and what `hit_test` reads
        // back. Collapsed keeps the normal sidebar width (mirrors the server: width is unchanged,
        // only the layout branches on this flag) — width 0 still means "no sidebar", never collapsed.
        app.sidebar_collapsed = compositor.sidebar_collapsed;
        // #22: feed the client-local collapsed worktree-group keys into the SHARED grouping renderer
        // BEFORE geometry is computed, so `workspace_list_entries` collapses the right groups and the
        // chevron glyph renders the matching state. Client-owned (the aggregated view's collapse is a
        // per-client display concern), unlike the server's persisted set.
        app.collapsed_space_keys = compositor.collapsed_space_keys.clone();
        app.view.layout = ViewLayout::Desktop;
        app.view.sidebar_rect = Rect::new(0, 0, sidebar_width, host_height);
        app.view.terminal_area = Rect::new(
            sidebar_width,
            0,
            host_width.saturating_sub(sidebar_width),
            host_height,
        );
        // #47: the global launcher uses the unified `ClientMenu` STATE (one keyboard/hover/dismiss/
        // modal path), but KEEPS its original visual surface — the server's `Mode::GlobalMenu` +
        // `render_global_launcher_menu` dropdown (no modal header, button-anchored, badge dots) — so
        // the "menu" button looks exactly as it always did. Only the two right-click CONTEXT menus
        // render through the unified overlay. Map an open launcher ClientMenu back onto the AppState
        // global-menu surface here so render/hit-test read the original geometry.
        app.mode = match model.client_menu() {
            Some(menu)
                if matches!(
                    menu.kind,
                    crate::client::supervisor::ClientMenuKind::GlobalLauncher
                ) =>
            {
                app.global_menu = MenuListState::new(
                    menu.selected
                        .min(app.global_menu_labels().len().saturating_sub(1)),
                );
                Mode::GlobalMenu
            }
            _ => Mode::Navigate,
        };

        let mut agents_by_workspace = HashMap::<(ServerId, String), Vec<AgentSidebarRow>>::new();
        for group in model.agent_groups() {
            agents_by_workspace
                .entry((group.server_id, group.workspace_id))
                .or_default()
                .extend(group.agents);
        }

        let mut workspace_routes = Vec::new();
        // #20: collect routes per-workspace so the flat `agent_routes` can be assembled to match
        // the rendered entries under the active scope (all workspaces vs the current one only).
        let mut per_ws_agent_routes: Vec<Vec<AgentRoute>> = Vec::new();
        let mut active_idx = None;
        // #20: in mixed-remote mode every connected server independently reports its own focused
        // workspace, so multiple `workspace_rows()` can carry `row.focused == true`. A plain
        // last-wins on `row.focused || agent-focused` let a trailing remote's *workspace*-focused
        // row override the local row that actually owns the user's focused agent, so under the
        // default `CurrentWorkspace` scope the local agents vanished. Rank the focus signal so an
        // agent-focused row always beats a merely workspace-focused one; on an EQUAL-rank tie prefer
        // the row on the authoritative `active_server_id` (a bare last-wins attached the wrong host
        // whenever two connected servers reported the same rank simultaneously).
        let mut active_rank = 0u8; // 0 = none, 1 = workspace-focused, 2 = agent-focused
        let active_server = model.active_server_id().clone();
        let workspace_rows = model.workspace_rows();
        for (idx, row) in workspace_rows.into_iter().enumerate() {
            let agents = row
                .workspace_id
                .as_ref()
                .and_then(|workspace_id| {
                    agents_by_workspace.remove(&(row.server_id.clone(), workspace_id.clone()))
                })
                .unwrap_or_default();
            let focused_agent_idx = agents.iter().position(|agent| agent.focused);
            let row_rank = if focused_agent_idx.is_some() {
                2
            } else if row.focused {
                1
            } else {
                0
            };
            // #39: the highlight must follow the ACTIVE content — the active server's focused row —
            // not a background host that merely reports a focused agent. A bare `row_rank` let a
            // background server's agent-focused row (rank 2) outrank the active server's
            // workspace-focused row (rank 1), so the wrong host's space stayed highlighted while the
            // content switched correctly. Make active-server membership dominate the focus kind by
            // boosting on-active-server rows above any off-server row; within the same membership
            // tier agent-focus still beats workspace-focus, and an exact tie keeps the prior
            // last-wins so a single-server fleet (every focused row on the active server) is
            // unchanged.
            let on_active_server = row.server_id == active_server;
            let effective_rank = if row_rank == 0 {
                0
            } else {
                row_rank + if on_active_server { 10 } else { 0 }
            };
            if effective_rank > 0
                && (effective_rank > active_rank
                    || (effective_rank == active_rank && on_active_server))
            {
                active_idx = Some(idx);
                active_rank = effective_rank;
            }

            // #58: group this workspace's agents into TABS (by wire `tab_id`, first-seen order) so the
            // client sidebar can show tab names. Per-tab buckets keep the agent routes aligned with
            // the tab-then-pane order `pane_details` renders. A single-tab workspace yields one group.
            let mut tab_index: HashMap<String, usize> = HashMap::new();
            let mut tab_specs: Vec<crate::workspace::SidebarPlaceholderTab> = Vec::new();
            let mut tab_routes: Vec<Vec<AgentRoute>> = Vec::new();
            let mut active_tab = 0usize;
            for agent in &agents {
                let terminal_id = TerminalId::alloc();
                let (state, seen) = agent_state_from_status(&agent.status);
                let mut terminal = TerminalState::new(terminal_id.clone(), "/".into());
                terminal.set_agent_name(agent.label.clone());
                // #58: the sidebar "pane name" = `terminal.manual_label` (see `pane_details_at`). The
                // multi-remote summary now carries the pane's manual rename, so set it here or the
                // client renders no pane name even when the pane was renamed.
                if let Some(pane_label) = &agent.pane_label {
                    terminal.set_manual_label(pane_label.clone());
                }
                if state == AgentState::Working {
                    // Working agents: seed working_since = the persisted start instant so the
                    // live duration timer survives recompose. The map is upkept in the event
                    // loop (pre-compose); here we only READ it. A first-seen agent falls back
                    // to `now`, so its first frame shows ~0s. A fresh terminal starts in
                    // `Unknown`, so the Unknown→Working transition fires (not short-circuited)
                    // and `recompute_effective_state` sets `working_since = Some(started)`.
                    let started = compositor
                        .working_since
                        .get(&(row.server_id.clone(), agent.agent_id.clone()))
                        .copied()
                        .unwrap_or(now);
                    terminal.set_detected_state_with_screen_signals_at(
                        None, // agent: no detected Agent on the client path
                        crate::detect::AgentState::Working,
                        false,   // visible_blocker
                        false,   // visible_idle
                        true,    // visible_working
                        false,   // process_exited
                        started, // now == persisted working-start instant
                    );
                } else {
                    terminal.state = state;
                }
                app.terminals.insert(terminal_id.clone(), terminal);
                let group = *tab_index.entry(agent.tab_id.clone()).or_insert_with(|| {
                    let group = tab_specs.len();
                    tab_specs.push(crate::workspace::SidebarPlaceholderTab {
                        custom_name: agent.tab_label.clone(),
                        number: group + 1,
                        pane_terminals: Vec::new(),
                        focused_pane: None,
                    });
                    tab_routes.push(Vec::new());
                    group
                });
                // #76: the summary-focused agent drives both the active tab AND that tab's focused
                // pane — record the index this agent's pane will take (== current len, before the
                // push below) so the placeholder layout focuses the matching pane for the highlight.
                if agent.focused {
                    active_tab = group;
                    tab_specs[group].focused_pane = Some(tab_specs[group].pane_terminals.len());
                }
                tab_specs[group].pane_terminals.push((terminal_id, seen));
                tab_routes[group].push(AgentRoute {
                    server_id: row.server_id.clone(),
                    agent_id: agent.agent_id.clone(),
                });
            }
            // Flatten routes in tab order so they line up with `pane_details` (tabs, then panes).
            let ws_agent_routes: Vec<AgentRoute> = tab_routes.into_iter().flatten().collect();

            let workspace_id = row
                .workspace_id
                .clone()
                .unwrap_or_else(|| format!("client-sidebar-row-{idx}"));
            let mut workspace = crate::workspace::Workspace::sidebar_placeholder_with_tabs(
                workspace_id,
                row.label.clone(),
                row.branch.clone(),
                tab_specs,
                active_tab,
            );
            // #22: populate the placeholder's worktree grouping from the wire field so the SHARED
            // `workspace_list_entries` groups worktree parents/children exactly like the server. The
            // grouping renderer + `workspace_parent_group_state` only read `key` and
            // `is_linked_worktree`; the path fields are display-only placeholders here (the client
            // sidebar derives the child label from `branch`, not these paths).
            workspace.worktree_space =
                row.worktree_key
                    .clone()
                    .map(|key| crate::workspace::WorktreeSpaceMembership {
                        key,
                        label: row.label.clone(),
                        repo_root: std::path::PathBuf::new(),
                        checkout_path: std::path::PathBuf::new(),
                        is_linked_worktree: row.worktree_is_linked,
                    });
            app.workspaces.push(workspace);
            // item 4: mirror the per-row local/remote signal into AppState, index-aligned with
            // app.workspaces. Empty in monolithic mode (no rows), so monolithic emits no divider.
            app.client_workspace_remote.push(row.is_remote);
            // #20: index-aligned with `app.workspaces` so the current-workspace scope can pick its
            // slice below.
            per_ws_agent_routes.push(ws_agent_routes);
            workspace_routes.push(WorkspaceRoute {
                server_id: row.server_id,
                workspace_id: row.workspace_id,
                disabled: row.disabled,
            });
        }

        if !app.workspaces.is_empty() {
            let selected = active_idx.unwrap_or(0).min(app.workspaces.len() - 1);
            app.active = Some(selected);
            app.selected = selected;
        }

        // #20: flatten the per-workspace routes to match the entries `agent_panel_entries` renders
        // under the active scope. `AllWorkspaces` concatenates every workspace's agents in row
        // order (== the renderer's iteration); `CurrentWorkspace` keeps only the current
        // workspace's slice. The snapshot mode is always Navigate/GlobalMenu, so the renderer's
        // `agent_panel_current_workspace_idx` resolves to `app.selected` — mirror that here so the
        // flat `agent_routes` index stays aligned with `hit_test_agent_panel`.
        // #25: the collapsed detail section always shows the SELECTED workspace's panes (scope-
        // independent), so capture that slice BEFORE the scope match consumes `per_ws_agent_routes`.
        let collapsed_detail_agent_routes = per_ws_agent_routes
            .get(app.selected)
            .cloned()
            .unwrap_or_default();
        let agent_routes: Vec<AgentRoute> = match app.agent_panel_scope {
            crate::app::state::AgentPanelScope::CurrentWorkspace => per_ws_agent_routes
                .get(app.selected)
                .cloned()
                .unwrap_or_default(),
            crate::app::state::AgentPanelScope::AllWorkspaces => {
                per_ws_agent_routes.into_iter().flatten().collect()
            }
        };
        let (_, detail_area) =
            crate::ui::expanded_sidebar_sections(app.view.sidebar_rect, app.sidebar_section_split);
        app.agent_panel_scroll = compositor
            .agent_panel_scroll
            .min(crate::ui::agent_panel_scroll_metrics(&app, detail_area).max_offset_from_bottom);
        // item 2 (C3): populate the per-host banner specs (one per visible Secondary, in
        // visible_servers() order) and the coordination flag BEFORE computing geometry, so that
        // `workspace_list_entries` emits the HostBanner rows and flips the divider to plain. The
        // banner specs ride positionally: `HostBannerArea.banner_idx` indexes `app.host_banners`.
        let host_banner_specs = model.host_banner_specs();
        // The insertion index from `host_banner_specs` is a position in the flat
        // `workspace_rows()` stream, which is 1:1 with `app.workspaces` (each row pushed in
        // order above) — so it is a valid `ws_idx`. `host_banner_rows[i]` is the workspace the
        // i-th banner is emitted immediately before; `host_banners[i]` is its spec.
        app.host_banner_rows = host_banner_specs.iter().map(|(idx, _)| *idx).collect();
        app.host_banners = host_banner_specs
            .into_iter()
            .map(|(_, spec)| spec)
            .collect();
        app.host_banner_active = model.host_banner_active();
        // C1: normalize the workspace scroll AFTER the host-banner rows are populated above.
        // `normalized_workspace_scroll` counts entries via `workspace_list_entries`, which only
        // emits the HostBanner rows once `host_banner_rows` is set — running it earlier clamped the
        // scroll to the banner-less row count (N-1) while the geometry/scrollbar below count N+B,
        // so a multi-host list scrolled to its bottom could not hold its last rows in view.
        app.workspace_scroll = crate::ui::normalized_workspace_scroll(
            &app,
            app.view.sidebar_rect,
            compositor.workspace_scroll,
        );
        // #19 (host half): the parallel `banner_idx -> server_id` map, built from the SAME
        // emission order as `host_banner_specs`, so hit-test and the drag preview resolve a banner
        // to its host. Carried on the snapshot for `hit_test`.
        let host_banner_server_ids = model.host_banner_server_ids();
        // item 4: one pass produces card rects, host-banner rects (item 2), and divider rows,
        // so render and hit-test share one geometry source. `host_banner_areas` is populated
        // from the second slot of THIS single call (render == hit_test geometry), and
        // `host_banner_active` (set above) flips the divider to plain when a banner is live.
        let (cards, banners, dividers) =
            crate::ui::compute_workspace_list_areas_full(&app, app.view.sidebar_rect);
        app.view.workspace_card_areas = cards;
        app.view.host_banner_areas = banners;
        app.view.divider_rows = dividers;
        // item 5: feed the single client-owned animation tick into the rendered AppState so
        // the braille agent spinner advances (was frozen at 0 via empty_for_client_rendering).
        app.spinner_tick = compositor.animation_tick();
        // item 7 (Area 4): mirror the compositor's hover truth into the render snapshot (Copy;
        // pure read). Render reads `app.sidebar_hover` and never mutates it.
        app.set_sidebar_hover(compositor.hover);

        // #19: while a workspace card is being dragged, populate `app.drag` so the shared sidebar
        // renderer draws the same live drop indicator the server-rendered sidebar shows (the client
        // path previously showed nothing until release). Reuse the existing render state — only
        // compute the dragged card's global index and the global insert slot the release would
        // commit to; the renderer (`render_workspace_list`) does the rest.
        if let Some(press) = compositor
            .workspace_press
            .as_ref()
            .filter(|press| press.dragging)
        {
            if let Some(drop_row) = press.last_drag_row {
                // The dragged card's GLOBAL index (into `app.workspaces` / `workspace_routes`).
                let source_ws_idx = workspace_routes.iter().position(|route| {
                    route.server_id == press.server_id
                        && route.workspace_id.as_deref() == Some(press.workspace_id.as_str())
                });
                // The source server's cards, in render order, paired with their true global `ws_idx`.
                let mut server_cards: Vec<(usize, Rect)> = Vec::new();
                for card in &app.view.workspace_card_areas {
                    let Some(route) = workspace_routes.get(card.ws_idx) else {
                        continue;
                    };
                    if route.server_id == press.server_id && route.workspace_id.is_some() {
                        server_cards.push((card.ws_idx, card.rect));
                    }
                }
                if let Some(source_ws_idx) = source_ws_idx {
                    // Resolve to the global `ws_idx` of the slot the drop lands on (what
                    // `workspace_drop_indicator_row` keys off). Shares `block_insert_global_index`
                    // with the commit path (`workspace_reorder_target`, which subtracts the block
                    // base) so the indicator row matches the storage slot the release commits to —
                    // even under worktree grouping (#22, render order != storage order) or a
                    // scrolled list.
                    if let Some(insert_idx) = block_insert_global_index(&server_cards, drop_row) {
                        // The shared renderer keys the indicator off `WorkspaceDropTarget` now:
                        // a global insert slot i maps to Before(i), past the end maps to End.
                        let drop_target = if insert_idx >= app.workspaces.len() {
                            crate::app::state::WorkspaceDropTarget::End
                        } else {
                            crate::app::state::WorkspaceDropTarget::Before(insert_idx)
                        };
                        app.drag = Some(crate::app::state::DragState {
                            target: crate::app::state::DragTarget::WorkspaceReorder {
                                source_ws_idx,
                                drop_target: Some(drop_target),
                            },
                        });
                    }
                }
            }
        }

        // #19 (host half): while a host banner is being dragged, populate `app.drag` with a
        // `HostReorder` so the shared renderer draws a host drop indicator at the boundary the
        // release would commit to. The insert slot is computed from the banner rects ONLY (via
        // `server_insert_index`), so it can never land inside a space block. Only one of
        // workspace_press/host_press is ever dragging, so this never fights the branch above.
        if let Some(press) = compositor
            .host_press
            .as_ref()
            .filter(|press| press.dragging)
        {
            if let Some(drop_row) = press.last_drag_row {
                let source_host_idx = host_banner_server_ids
                    .iter()
                    .position(|id| id == &press.server_id);
                let banner_rects: Vec<Rect> = app
                    .view
                    .host_banner_areas
                    .iter()
                    .map(|banner| banner.rect)
                    .collect();
                if let Some(source_host_idx) = source_host_idx {
                    if !banner_rects.is_empty() {
                        let insert_idx = server_insert_index(&banner_rects, drop_row);
                        app.drag = Some(crate::app::state::DragState {
                            target: crate::app::state::DragTarget::HostReorder {
                                source_host_idx,
                                insert_idx: Some(insert_idx),
                            },
                        });
                    }
                }
            }
        }

        let mut snapshot = Self {
            app,
            filter_label: model.filter_label(),
            workspace_routes,
            host_banner_server_ids,
            agent_routes,
            collapsed_detail_agent_routes,
            // item 1: clone the overlay state out of the model into ui-owned carriers (pure read).
            // The closure maps these into ui view structs before rendering.
            add_remote_form: model.add_remote_form().cloned(),
            new_workspace_picker: model
                .new_workspace_picker()
                .map(|picker| (picker.destinations.clone(), picker.selected)),
            // item 3: clone the overlay state + the secondary rows it renders out of the model
            // (pure read). The render closure maps the rows into ui-owned views.
            remote_manage: model
                .remote_manage_overlay()
                .map(|overlay| (overlay.clone(), model.remote_manage_rows())),
            // #47: clone the one client menu out of the model into a ui-owned carrier (pure read).
            // The render closure maps it into a ui view before drawing; hit-test reads its anchor +
            // baked item labels/flags from the same clone. The rename / confirm-close follow-on
            // overlays are still carried separately.
            client_menu: model.client_menu().cloned(),
            overlay_drag_offset: model.overlay_drag_offset(),
            // #53: filled once below, after the struct (and its overlay carriers + drag offset) exist.
            overlay_popup: None,
            rename_workspace: model.rename_workspace_form().cloned(),
            confirm_close_workspace: model.confirm_close_workspace().cloned(),
            new_worktree: model.new_worktree_form().cloned(),
            confirm_delete_worktree: model.confirm_delete_worktree().cloned(),
            worktree_picker: model.worktree_picker().cloned(),
            session_picker: model.session_picker().cloned(),
            new_session: model.new_session_form().cloned(),
        };
        // #53: ONE computation of the open overlay's geometry, from the just-built view. Every read
        // site (render / hit-test / hover-test / exclusion / drag / #56 hover overlay) reads this
        // field instead of recomputing, so the rects can never drift.
        snapshot.overlay_popup = open_overlay_popup_rect(&snapshot, host_width, host_height);
        snapshot
    }
}

/// #47: the header-line count for a client menu's geometry — 2 when it carries a target sub-header
/// (workspace label / host name), 1 for the launcher (title only). Render, hit-test, and the
/// content-exclusion rect all derive the row offset + popup height from this, so they stay in lockstep.
fn client_menu_header_rows(menu: &crate::client::supervisor::ClientMenu) -> u16 {
    if menu.subheader.is_some() {
        2
    } else {
        1
    }
}

fn render_client_shell(
    snapshot: &ClientSidebarSnapshot,
    host_width: u16,
    host_height: u16,
) -> FrameData {
    if host_width == 0 || host_height == 0 {
        return blank_frame(host_width, host_height);
    }

    let backend = ratatui::backend::TestBackend::new(host_width, host_height);
    let mut terminal = ratatui::Terminal::new(backend).expect("TestBackend::new should not fail");
    let terminal_runtimes = TerminalRuntimeRegistry::new();
    terminal
        .draw(|frame| {
            // #46 (items 1 & 3): in collapsed mode render the dedicated mini strip, mirroring the
            // server gate (`ui.rs`: `else if app.sidebar_collapsed { render_sidebar_collapsed }`).
            // The old code ALWAYS called the EXPANDED `render_sidebar` (then clipped to the 4-col
            // mini width), so the painted layout diverged from `collapsed_hit_test` (collapsed
            // clicks selected nothing) and the expand affordance was the clipped "‹‹ collapse"
            // label instead of the original "»" glyph. Rendering through `render_sidebar_collapsed`
            // fixes both: render == hit-test, and the "»" expand icon matches the server original.
            if snapshot.app.sidebar_collapsed {
                crate::ui::render_sidebar_collapsed(
                    &snapshot.app,
                    frame,
                    snapshot.app.view.sidebar_rect,
                );
            } else {
                crate::ui::render_sidebar(
                    &snapshot.app,
                    &terminal_runtimes,
                    frame,
                    snapshot.app.view.sidebar_rect,
                );
                // The right-aligned filter label belongs to the expanded layout only; the 4-col
                // mini strip has no room for it.
                render_filter_label(snapshot, frame);
            }
            // item 1: render the composited client overlays as footer-anchored popups that float
            // over the live content — the proven `render_global_launcher_menu` compositing path.
            // `anchor_area` spans the host top down to the sidebar footer row so the popups open
            // upward from the footer (matching the launcher menu), NOT dead-centered. The
            // compositor maps the ui-owned snapshot carriers into ui view structs here (no
            // supervisor types reach `ui`).
            let anchor_area = Rect::new(0, 0, host_width, snapshot.app.sidebar_footer_rect().y);
            // #47/#53: the (drag-shifted) popup rect of whichever overlay is open — render every
            // overlay at THIS rect so a dragged overlay moves and render == hit-test == drag geometry.
            // Read from the view (#53): computed once in `from_model`, never recomputed here.
            let overlay_popup = snapshot.overlay_popup;
            if let Some((dests, selected)) = &snapshot.new_workspace_picker {
                let views: Vec<crate::ui::DestinationView> = dests
                    .iter()
                    .map(|d| crate::ui::DestinationView {
                        display_name: &d.display_name,
                    })
                    .collect();
                // item 7 (Area 4): pass the hovered destination row (mirrored into the snapshot)
                // so the modal lifts it; the picker's `Moved` resolves `NewWorkspaceDestination`.
                let hovered_row = match snapshot.app.sidebar_hover {
                    Some(crate::app::state::SidebarHoverTarget::NewWorkspaceDestination {
                        row,
                    }) => Some(row as usize),
                    _ => None,
                };
                if let Some(popup) = overlay_popup {
                    crate::ui::render_new_workspace_picker_overlay(
                        &snapshot.app.palette,
                        &views,
                        *selected,
                        hovered_row,
                        frame,
                        popup,
                    );
                }
            }
            if let Some(form) = &snapshot.add_remote_form {
                let view = crate::ui::AddRemoteOverlayView {
                    target: &form.target,
                    name: &form.name,
                    session: &form.session,
                    focused_field: match form.focused_field {
                        crate::client::supervisor::AddRemoteField::Target => {
                            crate::ui::AddRemoteFieldView::Target
                        }
                        crate::client::supervisor::AddRemoteField::Name => {
                            crate::ui::AddRemoteFieldView::Name
                        }
                        crate::client::supervisor::AddRemoteField::Session => {
                            crate::ui::AddRemoteFieldView::Session
                        }
                    },
                    error: form.error.as_deref(),
                    in_progress: form.in_progress,
                    progress: form.progress.as_deref(),
                    spinner: crate::ui::spinner_frame(snapshot.app.spinner_tick),
                };
                if let Some(popup) = overlay_popup {
                    crate::ui::render_add_remote_overlay(
                        &snapshot.app.palette,
                        &view,
                        frame,
                        popup,
                    );
                }
            }
            // item 3 (Area 5): render the remote-management overlay as a footer-anchored popup. The
            // compositor maps the supervisor rows into ui-owned views here (no supervisor types
            // reach `ui`).
            if let Some((overlay, rows)) = &snapshot.remote_manage {
                let views = model_remote_manage_row_views(rows);
                if let Some(popup) = overlay_popup {
                    crate::ui::render_remote_manage_overlay(
                        &snapshot.app.palette,
                        &views,
                        overlay.selected,
                        overlay.scroll,
                        overlay.confirm_delete.as_deref(),
                        frame,
                        popup,
                        anchor_area,
                    );
                }
            }
            // #47: the global launcher keeps its ORIGINAL look — render it through the unchanged
            // `render_global_launcher_menu` dropdown surface (driven by the AppState `Mode::GlobalMenu`
            // mapping above), so the "menu" button looks exactly as it always did (button-anchored, no
            // modal header, badge dots). #53: read the cached popup; `Mode::GlobalMenu` holds iff the
            // open menu is the launcher (see `from_model`), and there `overlay_popup` IS the launcher
            // rect (drag offset already applied), so this stays identical to `launcher_menu_rect`.
            if matches!(snapshot.app.mode, Mode::GlobalMenu) {
                if let Some(rect) = snapshot.overlay_popup {
                    crate::ui::render_global_launcher_menu(&snapshot.app, frame, rect);
                }
            }
            // #47: render the two right-click CONTEXT menus (workspace / host) through the unified
            // overlay. The launcher is excluded (it renders above via its original surface). At most
            // one client overlay is ever open; the compositor maps the supervisor menu into a ui-owned
            // view here (no supervisor types reach `ui`); geometry == the `client_menu_*` helpers
            // hit-test uses, so render == hit-test.
            if let Some(menu) = &snapshot.client_menu {
                if !matches!(
                    menu.kind,
                    crate::client::supervisor::ClientMenuKind::GlobalLauncher
                ) {
                    let header_rows = client_menu_header_rows(menu);
                    // #53: this branch is gated on a non-launcher `client_menu`, so the cached
                    // `overlay_popup` IS this context menu's popup — read it instead of recomputing.
                    if let Some(popup) = snapshot.overlay_popup {
                        let rows: Vec<crate::ui::ClientMenuRowView> = menu
                            .items
                            .iter()
                            .map(|item| crate::ui::ClientMenuRowView {
                                label: &item.label,
                                selectable: item.selectable,
                            })
                            .collect();
                        let view = crate::ui::ClientMenuView {
                            title: menu.title,
                            subheader: menu.subheader.as_deref(),
                            rows: &rows,
                            selected: menu.selected,
                        };
                        crate::ui::render_client_menu_overlay(
                            &snapshot.app.palette,
                            &view,
                            frame,
                            popup,
                            header_rows,
                        );
                    }
                }
            }
            if let Some(form) = &snapshot.rename_workspace {
                if let Some(popup) = overlay_popup {
                    crate::ui::render_rename_workspace_overlay(
                        &snapshot.app.palette,
                        &form.label,
                        form.error.as_deref(),
                        frame,
                        popup,
                    );
                }
            }
            if let Some(confirm) = &snapshot.confirm_close_workspace {
                if let Some(popup) = overlay_popup {
                    crate::ui::render_confirm_close_workspace_overlay(
                        &snapshot.app.palette,
                        &confirm.label,
                        frame,
                        popup,
                    );
                }
            }
            // Worktree-menu parity: the three worktree follow-on overlays (keyboard-driven).
            if let Some(form) = &snapshot.new_worktree {
                if let Some(popup) = overlay_popup {
                    crate::ui::render_new_worktree_overlay(
                        &snapshot.app.palette,
                        &form.branch,
                        form.error.as_deref(),
                        frame,
                        popup,
                    );
                }
            }
            if let Some(confirm) = &snapshot.confirm_delete_worktree {
                if let Some(popup) = overlay_popup {
                    crate::ui::render_confirm_delete_worktree_overlay(
                        &snapshot.app.palette,
                        &confirm.label,
                        frame,
                        popup,
                    );
                }
            }
            if let Some(picker) = &snapshot.worktree_picker {
                if let Some(popup) = overlay_popup {
                    let rows: Vec<crate::ui::WorktreePickerRowView> = picker
                        .items
                        .iter()
                        .map(|item| crate::ui::WorktreePickerRowView {
                            label: &item.label,
                            path: &item.path,
                            open: item.open_workspace_id.is_some(),
                        })
                        .collect();
                    crate::ui::render_worktree_picker_overlay(
                        &snapshot.app.palette,
                        picker.loading,
                        picker.error.as_deref(),
                        &rows,
                        picker.selected,
                        frame,
                        popup,
                    );
                }
            }
            // C4/C5: the session picker. Supervisor rows are mapped into ui-owned views here (the
            // one-way `ui` <- `client` layering); the trailing `new session…` row is the renderer's.
            if let Some(picker) = &snapshot.session_picker {
                if let Some(popup) = overlay_popup {
                    let rows: Vec<crate::ui::SessionPickerRowView> = picker
                        .items
                        .iter()
                        .map(|item| crate::ui::SessionPickerRowView {
                            label: &item.label,
                            running: item.running,
                            is_current: item.is_current,
                        })
                        .collect();
                    crate::ui::render_session_picker_overlay(
                        &snapshot.app.palette,
                        picker.loading,
                        picker.error.as_deref(),
                        &rows,
                        picker.selected,
                        frame,
                        popup,
                    );
                }
            }
            // C6: the new-session text input.
            if let Some(form) = &snapshot.new_session {
                if let Some(popup) = overlay_popup {
                    crate::ui::render_new_session_overlay(
                        &snapshot.app.palette,
                        &form.name,
                        form.error.as_deref(),
                        form.in_flight,
                        frame,
                        popup,
                    );
                }
            }
        })
        .expect("render to TestBackend should not fail");

    let buffer = terminal.backend().buffer().clone();
    FrameData::from_ratatui_buffer_with_hyperlinks(&buffer, None, &[])
}

fn render_filter_label(snapshot: &ClientSidebarSnapshot, frame: &mut ratatui::Frame) {
    let rect = filter_label_rect(snapshot.app.view.sidebar_rect, &snapshot.filter_label);
    if rect == Rect::default() {
        return;
    }
    // item 7 (Area 4): the filter label hover lifts its fg overlay0 → subtext0.
    let fg = if snapshot.app.sidebar_hover == Some(crate::app::state::SidebarHoverTarget::Filter) {
        snapshot.app.palette.subtext0
    } else {
        snapshot.app.palette.overlay0
    };
    frame.render_widget(
        Paragraph::new(Span::styled(
            snapshot.filter_label.clone(),
            Style::default().fg(fg).add_modifier(Modifier::BOLD),
        ))
        .alignment(Alignment::Right),
        rect,
    );
}

fn filter_label_rect(sidebar: Rect, label: &str) -> Rect {
    if sidebar.width <= 1 || sidebar.height == 0 || label.is_empty() {
        return Rect::default();
    }
    let content_width = sidebar.width.saturating_sub(1);
    let width = (UnicodeWidthStr::width(label) as u16).min(content_width);
    Rect::new(
        sidebar.x + content_width.saturating_sub(width),
        sidebar.y,
        width,
        1,
    )
}

fn agent_state_from_status(status: &str) -> (AgentState, bool) {
    match status {
        "working" => (AgentState::Working, true),
        "blocked" => (AgentState::Blocked, true),
        "done" => (AgentState::Idle, false),
        "idle" => (AgentState::Idle, true),
        _ => (AgentState::Unknown, true),
    }
}

/// Whether anything on the client sidebar is currently animating, gating the animation
/// cadence (no idle CPU spin). Read-only over the cached model; performs NO I/O. The ONLY
/// banner-active input is `host_banner_animation_active` (contract Area 1: do not invent a
/// second clock or second flag); item 2 fills the banner hook, until then it is `false`.
pub(crate) fn sidebar_wants_animation(
    model: &crate::client::supervisor::ClientSupervisorModel,
) -> bool {
    model
        .agent_groups()
        .iter()
        .any(|g| g.agents.iter().any(|r| r.status == "working"))
        || model.host_banner_animation_active()
        || model.add_remote_in_progress()
}

/// item 3 (Area 5): map the supervisor `RemoteManageRow`s into ui-owned `RemoteManageRowView`s
/// (borrowing the row strings). This keeps `client::supervisor` types out of `ui` (the one-way
/// layering rule, contradiction 13).
fn model_remote_manage_row_views(
    rows: &[crate::client::supervisor::RemoteManageRow],
) -> Vec<crate::ui::RemoteManageRowView<'_>> {
    use crate::client::supervisor::RemoteManageState;
    rows.iter()
        .map(|row| crate::ui::RemoteManageRowView {
            glyph: match row.state {
                RemoteManageState::Connected => crate::ui::RemoteStateGlyph::Connected,
                RemoteManageState::Connecting => crate::ui::RemoteStateGlyph::Connecting,
                RemoteManageState::Disconnected => crate::ui::RemoteStateGlyph::Disconnected,
                RemoteManageState::Disabled => crate::ui::RemoteStateGlyph::Disabled,
                RemoteManageState::ProtocolMismatch => {
                    crate::ui::RemoteStateGlyph::ProtocolMismatch
                }
            },
            name: &row.name,
            target: &row.target,
            state_word: row.state.state_word(),
            disabled: !row.enabled,
        })
        .collect()
}

/// item 1: hit-test the centered new-workspace picker modal. Returns a destination row target,
/// the confirm/cancel buttons, or `None` when the picker is closed or the click misses. Geometry
/// is derived from the SAME helpers the renderer uses (`new_workspace_picker_inner_rect`/`_row_rect`
/// + `new_workspace_picker_button_rects`) over the same `full_rect`, so render == hit_test.
fn hit_test_new_workspace_picker(
    snapshot: &ClientSidebarSnapshot,
    popup: Rect,
    x: u16,
    y: u16,
) -> Option<SidebarHitTarget> {
    let (destinations, _) = snapshot.new_workspace_picker.as_ref()?;
    let inner = popup_inner(popup);

    // buttons take precedence over the (overlapping) actions row.
    let (confirm_rect, cancel_rect) = crate::ui::new_workspace_picker_button_rects(inner);
    if rect_contains(confirm_rect, x, y) {
        return Some(SidebarHitTarget::NewWorkspacePickerConfirm);
    }
    if rect_contains(cancel_rect, x, y) {
        return Some(SidebarHitTarget::NewWorkspacePickerCancel);
    }

    // destination rows — same `max_rows` clamp the renderer applies.
    let max_rows = inner.height.saturating_sub(3) as usize;
    for (row_index, destination) in destinations.iter().enumerate().take(max_rows) {
        let row = crate::ui::new_workspace_picker_row_rect(inner, row_index);
        if rect_contains(row, x, y) {
            return Some(SidebarHitTarget::NewWorkspaceDestination {
                server_id: destination.server_id.clone(),
            });
        }
    }
    None
}

/// item 7 (Area 4): hover sibling of `hit_test_new_workspace_picker`. Returns
/// `NewWorkspaceDestination { row }` (keyed on the modal's logical row index, which the modal
/// render keys on) for a hovered destination row. The confirm/cancel buttons have their own
/// styling and are not hover targets. Uses the SAME centered geometry the renderer + hit-test
/// use, so render == hover_test for the modal rows.
fn hover_test_new_workspace_picker(
    snapshot: &ClientSidebarSnapshot,
    popup: Rect,
    x: u16,
    y: u16,
) -> Option<crate::app::state::SidebarHoverTarget> {
    let (destinations, _) = snapshot.new_workspace_picker.as_ref()?;
    let inner = popup_inner(popup);
    let max_rows = inner.height.saturating_sub(3) as usize;
    for row_index in 0..destinations.len().min(max_rows) {
        let row = crate::ui::new_workspace_picker_row_rect(inner, row_index);
        if rect_contains(row, x, y) {
            return Some(
                crate::app::state::SidebarHoverTarget::NewWorkspaceDestination {
                    row: row_index as u16,
                },
            );
        }
    }
    None
}

/// item 1: hit-test the centered add-remote modal's submit/cancel buttons. Returns `None` when the
/// form is closed or the click misses. Uses the shared fixed `add_remote_inner_rect` geometry.
fn hit_test_add_remote(
    snapshot: &ClientSidebarSnapshot,
    popup: Rect,
    x: u16,
    y: u16,
) -> Option<SidebarHitTarget> {
    snapshot.add_remote_form.as_ref()?;
    let inner = popup_inner(popup);
    let (submit_rect, cancel_rect) = crate::ui::add_remote_button_rects(inner);
    if rect_contains(submit_rect, x, y) {
        return Some(SidebarHitTarget::AddRemoteSubmit);
    }
    if rect_contains(cancel_rect, x, y) {
        return Some(SidebarHitTarget::AddRemoteCancel);
    }
    None
}

/// item 3 (Area 5): hit-test the centered remote-management overlay. When delete-confirm is
/// active the red popup OWNS input (its buttons are the only hit targets; list rows are inert).
/// Otherwise a click on a rendered row selects it, and the footer `add` affordance opens the
/// add-remote form. Geometry comes from the SAME shared helpers the renderer uses
/// (`remote_manage_inner_rect`/`_row_rect`/`_confirm_*`), guaranteeing render == hit_test.
fn hit_test_remote_manage(
    snapshot: &ClientSidebarSnapshot,
    popup: Rect,
    full_rect: Rect,
    x: u16,
    y: u16,
) -> Option<SidebarHitTarget> {
    let (overlay, rows) = snapshot.remote_manage.as_ref()?;

    // delete-confirm sub-state: only the (still-centered) popup buttons are hit-testable.
    if overlay.confirm_delete.is_some() {
        let confirm_popup = crate::ui::remote_manage_confirm_popup_rect(full_rect)?;
        let inner = popup_inner(confirm_popup);
        let (delete_rect, cancel_rect) = crate::ui::remote_manage_confirm_button_rects(inner);
        if rect_contains(delete_rect, x, y) {
            return Some(SidebarHitTarget::RemoteManageConfirmDelete);
        }
        if rect_contains(cancel_rect, x, y) {
            return Some(SidebarHitTarget::RemoteManageCancelDelete);
        }
        return None;
    }

    // main list: inner derives from the (drag-shifted) popup so render == hit-test.
    let inner = popup_inner(popup);

    // footer hint row hosts the `add` affordance (whole footer row).
    let footer = Rect::new(
        inner.x,
        inner.y + inner.height.saturating_sub(1),
        inner.width,
        1,
    );
    if rect_contains(footer, x, y) {
        return Some(SidebarHitTarget::RemoteManageAdd);
    }

    // rows — same `max_rows`/visible-window clamp the renderer applies.
    let max_rows = inner.height.saturating_sub(3) as usize;
    let selected = overlay.selected.min(rows.len().saturating_sub(1));
    let start = overlay
        .scroll
        .min(rows.len().saturating_sub(max_rows.max(1)))
        .min(selected)
        .max(selected.saturating_sub(max_rows.max(1).saturating_sub(1)));
    for (visible_idx, (row_index, _)) in rows
        .iter()
        .enumerate()
        .skip(start)
        .take(max_rows)
        .enumerate()
    {
        let rect = crate::ui::remote_manage_row_rect(inner, visible_idx);
        if rect_contains(rect, x, y) {
            return Some(SidebarHitTarget::RemoteManageRow { index: row_index });
        }
    }
    None
}

/// #47: hit-test the one client menu (launcher / workspace / host). Resolves a click on a menu row
/// to its index, derived from the SAME `client_menu_*` geometry the renderer uses (anchor + row
/// count + `header_rows`), guaranteeing render == hit_test. The overlay is modal: a click that
/// misses every row returns `None` (the dimmed sidebar beneath never hit-tests). The row count comes
/// from the cloned menu's baked items (state-dependent for the host menu).
fn hit_test_client_menu(
    snapshot: &ClientSidebarSnapshot,
    x: u16,
    y: u16,
) -> Option<SidebarHitTarget> {
    let menu = snapshot.client_menu.as_ref()?;
    let count = menu.items.len();
    let header_rows = client_menu_header_rows(menu);
    // #53: only reached for a non-launcher `client_menu`, so the cached `overlay_popup` IS this
    // menu's (drag-shifted) popup — derive the inner from it so render == hit-test even after a drag.
    let popup = snapshot.overlay_popup?;
    let inner = popup_inner(popup);
    // Mirror the renderer's `inner.height < 4` bail (render_client_menu_overlay) so a host too short
    // to actually draw the rows also hit-tests to nothing — otherwise a tiny terminal would map
    // clicks to invisible rows that were never painted.
    if inner.height < 4 {
        return None;
    }
    for index in 0..count {
        let rect = crate::ui::client_menu_row_rect(inner, header_rows, index);
        if rect_contains(rect, x, y) {
            return Some(SidebarHitTarget::ClientMenuRow { index });
        }
    }
    None
}

/// #47: the open CONTEXT menu's current popup rect — its cursor-anchored `client_menu_popup_rect_at`
/// base, shifted by the menu's drag offset (clamped on-screen). `None` when it does not fit.
fn context_menu_popup_rect(
    menu: &crate::client::supervisor::ClientMenu,
    offset: (i16, i16),
    host_width: u16,
    host_height: u16,
) -> Option<Rect> {
    let base = crate::ui::client_menu_popup_rect_at(
        menu.anchor_col,
        menu.anchor_row,
        menu.items.len(),
        client_menu_header_rows(menu),
        host_width,
        host_height,
    )?;
    Some(shift_menu_rect(base, offset, host_width, host_height))
}

/// #47: the footer-anchored area the form overlays (add-remote / picker / manage / rename / confirm)
/// anchor their popups within. Spans the host top down to the sidebar footer row.
fn overlay_footer_anchor_area(snapshot: &ClientSidebarSnapshot, host_width: u16) -> Rect {
    Rect::new(0, 0, host_width, snapshot.app.sidebar_footer_rect().y)
}

/// #47: the CURRENT popup rect of whichever client overlay is open — its default position shifted by
/// the shared drag offset (clamped on-screen). Covers every overlay (the three menus + the five
/// footer forms), so render, hit-test, the content-exclusion rect, and the top-border drag all read
/// ONE source of truth. `None` when nothing is open / the popup does not fit.
fn open_overlay_popup_rect(
    snapshot: &ClientSidebarSnapshot,
    host_width: u16,
    host_height: u16,
) -> Option<Rect> {
    let offset = snapshot.overlay_drag_offset;
    if let Some(menu) = snapshot.client_menu.as_ref() {
        return if matches!(
            menu.kind,
            crate::client::supervisor::ClientMenuKind::GlobalLauncher
        ) {
            launcher_menu_rect(snapshot, host_width, host_height)
        } else {
            context_menu_popup_rect(menu, offset, host_width, host_height)
        };
    }
    let anchor_area = overlay_footer_anchor_area(snapshot, host_width);
    let base = if snapshot.add_remote_form.is_some() {
        crate::ui::add_remote_popup_rect(anchor_area)
    } else if let Some((dests, _)) = snapshot.new_workspace_picker.as_ref() {
        crate::ui::new_workspace_picker_popup_rect(anchor_area, dests.len())
    } else if let Some((_, rows)) = snapshot.remote_manage.as_ref() {
        crate::ui::remote_manage_popup_rect(anchor_area, rows.len())
    } else if snapshot.rename_workspace.is_some() {
        crate::ui::rename_workspace_popup_rect(anchor_area)
    } else if snapshot.confirm_close_workspace.is_some() {
        crate::ui::confirm_close_workspace_popup_rect(anchor_area)
    } else if snapshot.new_worktree.is_some() {
        crate::ui::new_worktree_popup_rect(anchor_area)
    } else if snapshot.confirm_delete_worktree.is_some() {
        crate::ui::confirm_delete_worktree_popup_rect(anchor_area)
    } else if let Some(picker) = snapshot.worktree_picker.as_ref() {
        crate::ui::worktree_picker_popup_rect(anchor_area, picker.items.len())
    } else if let Some(picker) = snapshot.session_picker.as_ref() {
        // `row_count` already includes the always-present trailing `new session…` row.
        crate::ui::session_picker_popup_rect(anchor_area, picker.row_count())
    } else if snapshot.new_session.is_some() {
        crate::ui::new_session_popup_rect(anchor_area)
    } else {
        None
    }?;
    Some(shift_menu_rect(base, offset, host_width, host_height))
}

/// #47: the bordered-panel inner rect of a popup — the same inset `render_panel_shell` produces, so
/// hit-test (which has no frame) derives the SAME inner as render.
fn popup_inner(popup: Rect) -> Rect {
    Rect::new(
        popup.x + 1,
        popup.y + 1,
        popup.width.saturating_sub(2),
        popup.height.saturating_sub(2),
    )
}

/// #47: clamp `base` shifted by a drag `offset` (cols, rows) so the popup stays fully on-screen. Used
/// by every menu render/hit-test/exclusion site so a dragged menu's geometry stays consistent.
fn shift_menu_rect(base: Rect, offset: (i16, i16), host_width: u16, host_height: u16) -> Rect {
    let max_x = host_width.saturating_sub(base.width) as i32;
    let max_y = host_height.saturating_sub(base.height) as i32;
    let x = (base.x as i32 + offset.0 as i32).clamp(0, max_x.max(0)) as u16;
    let y = (base.y as i32 + offset.1 as i32).clamp(0, max_y.max(0)) as u16;
    Rect::new(x, y, base.width, base.height)
}

/// #47: the open global launcher's current popup rect — its original `global_menu_rect` dropdown,
/// shifted by the menu's drag offset (clamped on-screen). `None` when no launcher is open.
fn launcher_menu_rect(
    snapshot: &ClientSidebarSnapshot,
    host_width: u16,
    host_height: u16,
) -> Option<Rect> {
    if !matches!(snapshot.app.mode, Mode::GlobalMenu) {
        return None;
    }
    Some(shift_menu_rect(
        snapshot.app.global_menu_rect(),
        snapshot.overlay_drag_offset,
        host_width,
        host_height,
    ))
}

/// #47: resolve a position to a 0-based item index in the open GLOBAL LAUNCHER, against its (possibly
/// drag-shifted) `global_menu_rect` dropdown geometry — so click/hover match the unchanged
/// `render_global_launcher_menu` layout. `None` when the position misses the inner item rows. The
/// hit-test dispatch maps the result to the unified `ClientMenuRow { index }`.
fn global_menu_item_index_at(
    app: &crate::app::AppState,
    rect: Rect,
    x: u16,
    y: u16,
) -> Option<usize> {
    let inner_x = rect.x.saturating_add(1);
    let inner_y = rect.y.saturating_add(1);
    let inner_right = rect.x.saturating_add(rect.width).saturating_sub(1);
    let inner_bottom = rect.y.saturating_add(rect.height).saturating_sub(1);
    if x < inner_x || x >= inner_right || y < inner_y || y >= inner_bottom {
        return None;
    }
    let index = (y - inner_y) as usize;
    (index < app.global_menu_labels().len()).then_some(index)
}

/// #23/#47: hit-test the rename overlay's submit/cancel buttons. Inner derives from the (drag-
/// shifted) `popup` via `popup_inner` + `rename_workspace_button_rects`, so render == hit_test.
fn hit_test_rename_workspace(
    snapshot: &ClientSidebarSnapshot,
    popup: Rect,
    x: u16,
    y: u16,
) -> Option<SidebarHitTarget> {
    snapshot.rename_workspace.as_ref()?;
    let inner = popup_inner(popup);
    let (submit_rect, cancel_rect) = crate::ui::rename_workspace_button_rects(inner);
    if rect_contains(submit_rect, x, y) {
        return Some(SidebarHitTarget::RenameWorkspaceSubmit);
    }
    if rect_contains(cancel_rect, x, y) {
        return Some(SidebarHitTarget::RenameWorkspaceCancel);
    }
    None
}

/// C5: hit-test the session picker's rows. Geometry derives from the (drag-shifted) `popup` via
/// `popup_inner` + `session_picker_row_rect` — the SAME helper the renderer draws with, so a click
/// lands on the row the user sees. Indexes listed sessions AND the trailing `new session…` row.
fn hit_test_session_picker(
    snapshot: &ClientSidebarSnapshot,
    popup: Rect,
    x: u16,
    y: u16,
) -> Option<SidebarHitTarget> {
    let picker = snapshot.session_picker.as_ref()?;
    let inner = popup_inner(popup);
    for index in 0..picker.row_count() {
        let Some(row_rect) = crate::ui::session_picker_row_rect(inner, index) else {
            break;
        };
        if rect_contains(row_rect, x, y) {
            return Some(SidebarHitTarget::SessionPickerRow { index });
        }
    }
    None
}

/// C6: hit-test the new-session input's switch/cancel buttons. Mirrors `hit_test_rename_workspace`.
fn hit_test_new_session(
    snapshot: &ClientSidebarSnapshot,
    popup: Rect,
    x: u16,
    y: u16,
) -> Option<SidebarHitTarget> {
    snapshot.new_session.as_ref()?;
    let inner = popup_inner(popup);
    let (submit_rect, cancel_rect) = crate::ui::new_session_button_rects(inner);
    if rect_contains(submit_rect, x, y) {
        return Some(SidebarHitTarget::NewSessionSubmit);
    }
    if rect_contains(cancel_rect, x, y) {
        return Some(SidebarHitTarget::NewSessionCancel);
    }
    None
}

/// #23: hit-test the close-confirm overlay's confirm/cancel buttons. Geometry comes from the
/// shared `confirm_close_workspace_popup_rect` + `confirm_close_workspace_button_rects`.
fn hit_test_confirm_close_workspace(
    snapshot: &ClientSidebarSnapshot,
    popup: Rect,
    x: u16,
    y: u16,
) -> Option<SidebarHitTarget> {
    snapshot.confirm_close_workspace.as_ref()?;
    let inner = popup_inner(popup);
    let (confirm_rect, cancel_rect) = crate::ui::confirm_close_workspace_button_rects(inner);
    if rect_contains(confirm_rect, x, y) {
        return Some(SidebarHitTarget::ConfirmCloseWorkspaceConfirm);
    }
    if rect_contains(cancel_rect, x, y) {
        return Some(SidebarHitTarget::ConfirmCloseWorkspaceCancel);
    }
    None
}

/// #20: the rect of the agents-panel "all"/"current" toggle in the rendered snapshot, derived from
/// the SAME `expanded_sidebar_sections` detail area + `agent_panel_toggle_rect` the renderer uses
/// (`render_agent_detail`). Returns an empty rect when the panel is too short to draw the toggle.
fn agent_panel_toggle_hit_rect(app: &crate::app::AppState) -> Rect {
    let (_, detail_area) =
        crate::ui::expanded_sidebar_sections(app.view.sidebar_rect, app.sidebar_section_split);
    // Pre-existing label mismatch (broke hover==render on mx before the v0.7.4 merge): the
    // renderer still draws the SORT toggle label here (`render_agent_detail` →
    // `agent_panel_toggle_rect`), while the client toggles SCOPE on click. Hit/hover geometry
    // must cover the cells actually drawn, so derive it from the rendered (sort) label until
    // the in-flight scope-label render work lands.
    crate::ui::agent_panel_toggle_rect(detail_area, app.agent_panel_sort)
}

/// #25: collapsed-mode row hit-test. The collapsed renderer draws (top→bottom) a narrow
/// workspace-glance section then an agent-detail section, both from the SHARED
/// `collapsed_sidebar_sections` geometry. Mirror the server's `collapsed_*_at` row math here,
/// resolving each row to the owning server via the SAME `workspace_routes`/`agent_routes` the
/// expanded path uses, so a collapsed click focuses the right server exactly like the expanded one.
/// The toggle is resolved by the caller; this only covers the two row sections.
fn collapsed_hit_test(
    snapshot: &ClientSidebarSnapshot,
    x: u16,
    y: u16,
) -> Option<SidebarHitTarget> {
    let app = &snapshot.app;
    let sidebar_rect = app.view.sidebar_rect;
    if x >= sidebar_rect.x + sidebar_rect.width {
        return None;
    }
    let (ws_area, _, detail_area) = crate::ui::collapsed_sidebar_sections(sidebar_rect);

    // Agent-detail rows (mirrors the server's `collapsed_agent_detail_target_at`): the detail
    // section shows the selected workspace's panes. The client snapshot is always built in
    // Navigate/GlobalMenu, so the detail workspace is `app.selected` (matching the renderer's
    // `detail_ws_idx` and the server's `collapsed_detail_workspace_idx`). The last detail row is
    // reserved (the renderer subtracts 1 for the toggle row), so use `detail_content_area`.
    let detail_content_area = Rect::new(
        detail_area.x,
        detail_area.y,
        detail_area.width,
        detail_area.height.saturating_sub(1),
    );
    if detail_content_area != Rect::default()
        && y >= detail_content_area.y
        && y < detail_content_area.y + detail_content_area.height
    {
        // Detail rows are the selected workspace's panes in order; `collapsed_detail_agent_routes`
        // is that workspace's agents in the SAME order (built in `from_model`), so row `i` resolves
        // to route `i` — the SAME `AgentRoute { server_id, agent_id }` the expanded path focuses.
        let detail_idx = (y - detail_content_area.y) as usize;
        if let Some(route) = snapshot.collapsed_detail_agent_routes.get(detail_idx) {
            return Some(SidebarHitTarget::Agent {
                server_id: route.server_id.clone(),
                agent_id: route.agent_id.clone(),
            });
        }
        return None;
    }

    // Workspace-glance rows (mirrors the server's `collapsed_workspace_at_row`): one row per
    // workspace, `idx == y - ws_area.y`, resolved through `workspace_routes` exactly like the
    // expanded card path (disabled → no hit, Some(id) → Workspace, None → new-workspace dest).
    if ws_area != Rect::default() && y >= ws_area.y && y < ws_area.y + ws_area.height {
        let idx = (y - ws_area.y) as usize;
        if let Some(route) = snapshot.workspace_routes.get(idx) {
            if route.disabled {
                return None;
            }
            return Some(match route.workspace_id.clone() {
                Some(workspace_id) => SidebarHitTarget::Workspace {
                    server_id: route.server_id.clone(),
                    workspace_id,
                },
                None => SidebarHitTarget::NewWorkspaceDestination {
                    server_id: route.server_id.clone(),
                },
            });
        }
    }

    None
}

fn hit_test_agent_panel(
    snapshot: &ClientSidebarSnapshot,
    x: u16,
    y: u16,
) -> Option<SidebarHitTarget> {
    let (_, detail_area) = crate::ui::expanded_sidebar_sections(
        snapshot.app.view.sidebar_rect,
        snapshot.app.sidebar_section_split,
    );
    let metrics = crate::ui::agent_panel_scroll_metrics(&snapshot.app, detail_area);
    let body =
        crate::ui::agent_panel_body_rect(detail_area, crate::ui::should_show_scrollbar(metrics));
    if !rect_contains(body, x, y) {
        return None;
    }

    let entry_rows = crate::ui::agent_panel_entry_row_count(&snapshot.app);
    if entry_rows == 0 {
        return None;
    }
    let relative_row = y.saturating_sub(body.y);
    let stride = entry_rows.saturating_add(1);
    let index = (relative_row / stride) as usize;
    if relative_row % stride >= entry_rows {
        return None;
    }
    let route = snapshot
        .agent_routes
        .get(snapshot.app.agent_panel_scroll.saturating_add(index))?;
    Some(SidebarHitTarget::Agent {
        server_id: route.server_id.clone(),
        agent_id: route.agent_id.clone(),
    })
}

/// item 7 (Area 4): hover sibling of `hit_test_agent_panel`. Returns `AgentRoute { route_idx }`
/// where `route_idx = agent_panel_scroll + index` — the SAME flat `agent_routes` index
/// `hit_test_agent_panel` resolves. The index is positional in `model.agent_groups()` order, so
/// it survives recompose (a captured `pane_id` would not, contradiction 11). The client snapshot
/// is always `AgentPanelScope::AllWorkspaces`, so this flat index equals the global
/// `agent_panel_entries` index `render_agent_detail` walks (render == hover_test geometry).
fn hover_test_agent_panel(
    snapshot: &ClientSidebarSnapshot,
    x: u16,
    y: u16,
) -> Option<crate::app::state::SidebarHoverTarget> {
    let (_, detail_area) = crate::ui::expanded_sidebar_sections(
        snapshot.app.view.sidebar_rect,
        snapshot.app.sidebar_section_split,
    );
    let metrics = crate::ui::agent_panel_scroll_metrics(&snapshot.app, detail_area);
    let body =
        crate::ui::agent_panel_body_rect(detail_area, crate::ui::should_show_scrollbar(metrics));
    if !rect_contains(body, x, y) {
        return None;
    }

    let entry_rows = crate::ui::agent_panel_entry_row_count(&snapshot.app);
    if entry_rows == 0 {
        return None;
    }
    let relative_row = y.saturating_sub(body.y);
    let stride = entry_rows.saturating_add(1);
    let index = (relative_row / stride) as usize;
    if relative_row % stride >= entry_rows {
        return None;
    }
    let route_idx = snapshot.app.agent_panel_scroll.saturating_add(index);
    // only a real agent route resolves (the gap rows / over-scroll resolve to None).
    snapshot.agent_routes.get(route_idx)?;
    Some(crate::app::state::SidebarHoverTarget::AgentRoute { route_idx })
}

fn rect_contains(rect: Rect, x: u16, y: u16) -> bool {
    rect.width > 0
        && rect.height > 0
        && x >= rect.x
        && x < rect.x.saturating_add(rect.width)
        && y >= rect.y
        && y < rect.y.saturating_add(rect.height)
}

fn blank_frame(width: u16, height: u16) -> FrameData {
    FrameData {
        cells: vec![blank_cell(); (width as usize) * (height as usize)],
        width,
        height,
        cursor: None,
        hyperlinks: Vec::new(),
        graphics: Vec::new(),
    }
}

fn blank_cell() -> CellData {
    CellData {
        symbol: " ".into(),
        fg: 0,
        bg: 0,
        modifier: 0,
        skip: false,
        hyperlink: None,
    }
}

/// #56: derive the hover/selection highlight geometry from the (hover-less) snapshot. Every rect
/// mirrors the renderer's layout — workspace cards, agent-panel rows, affordances, picker rows, open
/// menu rows — so [`apply_hover_overlay`] paints cell-identical to the old hover-baked render. The
/// Seam-1 equivalence tests pin that identity, so the two geometries cannot silently drift.
fn compute_hover_geometry(snapshot: &ClientSidebarSnapshot) -> HoverGeometry {
    use crate::protocol::color_to_u32;
    let app = &snapshot.app;
    let p = &app.palette;
    let mut geom = HoverGeometry {
        hover_bg: color_to_u32(p.hover_bg()),
        affordance_from: color_to_u32(p.overlay0),
        affordance_to: color_to_u32(p.subtext0),
        ..HoverGeometry::default()
    };

    // The open client menu owns the highlight (the sidebar is inert beneath it). Its rows are
    // overlay popups, so they paint regardless of the collapsed/expanded sidebar state below.
    if let Some(menu) = snapshot.client_menu.as_ref() {
        geom.menu = compute_menu_hover_geometry(snapshot, menu);
    }

    // The new-workspace picker (a footer popup) hovers before the sidebar too — capture its
    // destination rows here so they paint in either sidebar layout. Selected row excluded (its bg
    // wins; hover never overrides it — see `render_new_workspace_picker_overlay`).
    if let Some((dests, selected)) = snapshot.new_workspace_picker.as_ref() {
        // #53: the picker's footer popup is the open overlay, so read the cached rect.
        if let Some(inner) = snapshot.overlay_popup.and_then(panel_inner_rect) {
            if inner.height >= 4 {
                let selected = (*selected).min(dests.len().saturating_sub(1));
                let max_rows = inner.height.saturating_sub(3) as usize;
                for row_index in 0..dests.len().min(max_rows) {
                    if row_index == selected {
                        continue;
                    }
                    geom.picker_rows.push((
                        row_index,
                        crate::ui::new_workspace_picker_row_rect(inner, row_index),
                    ));
                }
            }
        }
    }

    // The collapsed mini strip paints no hover highlight, and an open menu/picker makes the sidebar
    // inert — in both cases the sidebar-target rects below are never consulted, so skip them.
    if app.sidebar_collapsed {
        return geom;
    }

    let (ws_area, detail_area) =
        crate::ui::expanded_sidebar_sections(app.view.sidebar_rect, app.sidebar_section_split);

    // -- workspace cards: bg-fill `hover_bg`, suppressing selected / active / dragged (those bgs win
    // over hover in `render_workspace_list`). The fill is clipped to the list bottom, like the render.
    let list_bottom = ws_area.y.saturating_add(ws_area.height.saturating_sub(1));
    let is_navigating = matches!(app.mode, crate::app::state::Mode::Navigate);
    let dragged_ws_idx = match app.drag.as_ref().map(|d| &d.target) {
        Some(crate::app::state::DragTarget::WorkspaceReorder { source_ws_idx, .. }) => {
            Some(*source_ws_idx)
        }
        _ => None,
    };
    for card in &app.view.workspace_card_areas {
        let i = card.ws_idx;
        let selected = i == app.selected && is_navigating;
        let is_active = Some(i) == app.active;
        let is_dragged = dragged_ws_idx == Some(i);
        if selected || is_active || is_dragged {
            continue;
        }
        // disabled remotes / `None`-id placeholders are not hoverable (mirrors `hover_test`).
        if let Some(route) = snapshot.workspace_routes.get(i) {
            if route.disabled || route.workspace_id.is_none() {
                continue;
            }
        }
        if let Some(rect) = clip_rect_to_bottom(card.rect, list_bottom) {
            geom.workspace_cards.push((i, rect));
        }
    }

    // -- agent-panel rows: bg-fill `hover_bg`, suppressing the active row (its `surface_dim` wins).
    // Geometry mirrors `hover_test_agent_panel`: stride = entry_rows + 1, row `i` at body.y+i*stride.
    let metrics = crate::ui::agent_panel_scroll_metrics(app, detail_area);
    let body =
        crate::ui::agent_panel_body_rect(detail_area, crate::ui::should_show_scrollbar(metrics));
    let entry_rows = crate::ui::agent_panel_entry_row_count(app);
    if body.width > 0 && body.height > 0 && entry_rows > 0 {
        let stride = entry_rows.saturating_add(1);
        let body_bottom = body.y.saturating_add(body.height);
        let entries = crate::ui::agent_panel_entries(app);
        for (route_idx, entry) in entries.iter().enumerate().skip(app.agent_panel_scroll) {
            let local = (route_idx - app.agent_panel_scroll) as u16;
            let row_y = body.y.saturating_add(local.saturating_mul(stride));
            if row_y.saturating_add(entry_rows) > body_bottom {
                break;
            }
            // only a real agent route resolves (matches `hover_test_agent_panel`).
            if snapshot.agent_routes.get(route_idx).is_none() {
                continue;
            }
            if app.is_active_pane(entry.ws_idx, entry.tab_idx, entry.pane_id) {
                continue;
            }
            geom.agent_rows
                .push((route_idx, Rect::new(body.x, row_y, body.width, entry_rows)));
        }
    }

    // -- affordance fg-lifts (overlay0 → subtext0), present only when actually drawn (mirrors the
    // renderer's draw gates so paint == hover-test).
    let filter_rect = filter_label_rect(app.view.sidebar_rect, &snapshot.filter_label);
    if filter_rect != Rect::default() {
        geom.filter = Some(filter_rect);
    }
    // `render_workspace_list` draws the ` new`/`menu` affordances only on `mouse_capture &&
    // list_bottom > area.y`; mirror BOTH clauses (not `mouse_capture` alone) so the overlay never
    // recolors an undrawn affordance on a degenerate (≤1-row) workspace list.
    if app.mouse_capture && list_bottom > ws_area.y {
        geom.new_button = Some(app.sidebar_new_button_rect());
        geom.menu_button = Some(app.global_launcher_rect());
    }
    // See `agent_panel_toggle_hit_rect`: geometry must track the RENDERED (sort-label) toggle.
    let toggle_rect = crate::ui::agent_panel_toggle_rect(detail_area, app.agent_panel_sort);
    if toggle_rect != Rect::default() {
        geom.scope_toggle = Some(toggle_rect);
    }

    geom
}

/// #56: the open-menu selected-row paint geometry. The launcher styles only the row's text span; a
/// context menu styles the full row + a "›" marker. Both derive their rects from the SAME helpers
/// `render_client_shell` and `hit_test` use, so the highlight tracks the painted/clickable rows.
fn compute_menu_hover_geometry(
    snapshot: &ClientSidebarSnapshot,
    menu: &crate::client::supervisor::ClientMenu,
) -> Option<MenuHoverGeometry> {
    use crate::protocol::color_to_u32;
    let app = &snapshot.app;
    let p = &app.palette;
    if matches!(
        menu.kind,
        crate::client::supervisor::ClientMenuKind::GlobalLauncher
    ) {
        // #53: a GlobalLauncher `client_menu` means `overlay_popup` IS the launcher rect.
        let inner = panel_inner_rect(snapshot.overlay_popup?)?;
        let inner_bottom = inner.y.saturating_add(inner.height);
        let mut rows = Vec::new();
        for (idx, item) in app.global_menu_labels().iter().enumerate() {
            let y = inner.y.saturating_add(idx as u16);
            if y >= inner_bottom {
                break;
            }
            let width = launcher_menu_line_width(app, item).min(inner.width);
            rows.push(Rect::new(inner.x, y, width, 1));
        }
        // `panel_contrast_fg`: the launcher selected fg falls back to `surface_dim` on a Reset bg.
        let contrast_fg = match p.panel_bg {
            ratatui::style::Color::Reset => p.surface_dim,
            color => color,
        };
        Some(MenuHoverGeometry::Launcher {
            rows,
            fg: color_to_u32(contrast_fg),
            bg: color_to_u32(p.accent),
        })
    } else {
        // #53: a non-launcher `client_menu` means `overlay_popup` IS this context menu's popup.
        let popup = snapshot.overlay_popup?;
        let inner = panel_inner_rect(popup)?;
        if inner.height < 4 {
            return None;
        }
        let header_rows = client_menu_header_rows(menu);
        let max_rows = inner.height.saturating_sub(header_rows) as usize;
        let rows = (0..menu.items.len().min(max_rows))
            .map(|row_index| crate::ui::client_menu_row_rect(inner, header_rows, row_index))
            .collect();
        Some(MenuHoverGeometry::Context {
            rows,
            fg: color_to_u32(p.text),
            bg: color_to_u32(p.surface0),
        })
    }
}

/// The rendered display width of one launcher menu row (badge + label), matching the `Line` that
/// `render_global_launcher_menu` builds — so the selected-row overlay covers exactly the styled span.
fn launcher_menu_line_width(app: &crate::app::AppState, item: &str) -> u16 {
    use ratatui::text::{Line, Span};
    let mut spans = Vec::new();
    if app.global_menu_item_has_badge(item) {
        spans.push(Span::raw(" ●"));
    }
    spans.push(Span::raw(format!(" {item} ")));
    Line::from(spans).width() as u16
}

/// The bordered inner rect of a `render_panel_shell` popup (inset 1 on every side), or None when the
/// popup is too small to have an interior — the SAME inset the panel renders / hit-test derives.
fn panel_inner_rect(popup: Rect) -> Option<Rect> {
    if popup.width < 2 || popup.height < 2 {
        return None;
    }
    Some(Rect::new(
        popup.x + 1,
        popup.y + 1,
        popup.width - 2,
        popup.height - 2,
    ))
}

/// Intersect `rect` with the half-open `[.., list_bottom)` band, matching the workspace-list render's
/// `if y >= list_bottom break` clip. Returns None when nothing remains visible.
fn clip_rect_to_bottom(rect: Rect, list_bottom: u16) -> Option<Rect> {
    if rect.width == 0 || rect.y >= list_bottom {
        return None;
    }
    let height = (rect.y.saturating_add(rect.height)).min(list_bottom) - rect.y;
    (height > 0).then(|| Rect::new(rect.x, rect.y, rect.width, height))
}

/// #56: paint the hover/selection highlight onto a composited frame from the cached shell's
/// [`HoverGeometry`] + the live hover target / menu selection. Cheap (touches only the highlighted
/// cells) and idempotent, so it runs every frame like the content/cursor overlay — a hover change
/// just recomposes from the SAME cached shell instead of rebuilding it (#48/#55/#56).
pub(crate) fn apply_hover_overlay(
    frame: &mut FrameData,
    shell: &ComposedShell,
    hover: Option<crate::app::state::SidebarHoverTarget>,
    menu_selected: Option<usize>,
) {
    use crate::app::state::SidebarHoverTarget;
    let geom = &shell.hover;

    // An open menu owns the highlight (the sidebar is inert beneath it): paint the model's selected
    // row and stop — the sidebar hover is `None` here anyway (`hover_test` yields to the menu).
    if let Some(menu) = geom.menu.as_ref() {
        if let Some(selected) = menu_selected {
            paint_menu_selection(frame, menu, selected);
        }
        return;
    }

    let Some(target) = hover else {
        return;
    };
    match target {
        SidebarHoverTarget::Workspace { ws_idx } => {
            if let Some((_, rect)) = geom.workspace_cards.iter().find(|(i, _)| *i == ws_idx) {
                fill_rect_bg(frame, *rect, geom.hover_bg);
            }
        }
        SidebarHoverTarget::AgentRoute { route_idx } => {
            if let Some((_, rect)) = geom.agent_rows.iter().find(|(i, _)| *i == route_idx) {
                fill_rect_bg(frame, *rect, geom.hover_bg);
            }
        }
        SidebarHoverTarget::NewWorkspaceDestination { row } => {
            if let Some((_, rect)) = geom.picker_rows.iter().find(|(i, _)| *i == row as usize) {
                fill_rect_bg(frame, *rect, geom.hover_bg);
            }
        }
        SidebarHoverTarget::Filter => recolor_affordance(frame, geom.filter, geom),
        SidebarHoverTarget::New => recolor_affordance(frame, geom.new_button, geom),
        SidebarHoverTarget::Menu => recolor_affordance(frame, geom.menu_button, geom),
        SidebarHoverTarget::ScopeToggle => recolor_affordance(frame, geom.scope_toggle, geom),
        // `AgentMono` is the monolithic pane-keyed variant (the client resolves `AgentRoute`);
        // `HostBanner`/`Divider` paint no highlight today (so the overlay is a no-op, matching render).
        SidebarHoverTarget::AgentMono { .. }
        | SidebarHoverTarget::HostBanner { .. }
        | SidebarHoverTarget::Divider => {}
    }
}

fn recolor_affordance(frame: &mut FrameData, rect: Option<Rect>, geom: &HoverGeometry) {
    if let Some(rect) = rect {
        recolor_rect_fg(frame, rect, geom.affordance_from, geom.affordance_to);
    }
}

fn frame_cell_mut(frame: &mut FrameData, x: u16, y: u16) -> Option<&mut CellData> {
    if x >= frame.width || y >= frame.height {
        return None;
    }
    frame
        .cells
        .get_mut(y as usize * frame.width as usize + x as usize)
}

/// Apply `f` to every in-bounds cell of `rect` — the shared (saturating, clipped) cell walk behind
/// every hover/selection paint below, so the bounds + `frame_cell_mut` logic lives in ONE place.
fn for_each_cell_in_rect(frame: &mut FrameData, rect: Rect, mut f: impl FnMut(&mut CellData)) {
    for y in rect.y..rect.y.saturating_add(rect.height) {
        for x in rect.x..rect.x.saturating_add(rect.width) {
            if let Some(cell) = frame_cell_mut(frame, x, y) {
                f(cell);
            }
        }
    }
}

/// Patch only the bg of every cell in `rect` (fg/symbol/modifier untouched) — the
/// `set_style(Style::default().bg(..))` the workspace-card / agent-row / picker-row hovers apply.
fn fill_rect_bg(frame: &mut FrameData, rect: Rect, bg: u32) {
    for_each_cell_in_rect(frame, rect, |cell| cell.bg = bg);
}

/// Recolor only the cells in `rect` whose fg equals `from`, to `to` — the affordance fg-lift
/// (overlay0 → subtext0). The conditional keeps the result cell-identical: only the affordance glyph
/// cells (drawn `overlay0`) lift, never the surrounding cells.
fn recolor_rect_fg(frame: &mut FrameData, rect: Rect, from: u32, to: u32) {
    for_each_cell_in_rect(frame, rect, |cell| {
        if cell.fg == from {
            cell.fg = to;
        }
    });
}

fn paint_menu_selection(frame: &mut FrameData, menu: &MenuHoverGeometry, selected: usize) {
    let bold = ratatui::style::Modifier::BOLD.bits();
    match menu {
        MenuHoverGeometry::Launcher { rows, fg, bg } => {
            let Some(rect) = row_for_selection(rows, selected) else {
                return;
            };
            paint_menu_row_style(frame, rect, *fg, *bg, bold);
        }
        MenuHoverGeometry::Context { rows, fg, bg } => {
            let Some(rect) = row_for_selection(rows, selected) else {
                return;
            };
            paint_menu_row_style(frame, rect, *fg, *bg, bold);
            // the selected context-menu row swaps its leading marker " " → "›".
            if let Some(cell) = frame_cell_mut(frame, rect.x, rect.y) {
                cell.symbol = "›".to_string();
            }
        }
    }
}

/// #56: the painted highlight rect for the model's selected row. `rows` holds only the VISIBLE rows
/// (clipped to what fits the popup), so a selection scrolled past the last visible row yields `None`
/// — matching the renderer, which highlights `row_index == selected` and therefore paints nothing
/// once the selection is off-screen (rather than lighting up the wrong, last-visible row).
fn row_for_selection(rows: &[Rect], selected: usize) -> Option<Rect> {
    rows.get(selected).copied()
}

/// Patch fg+bg and OR in BOLD over the row's cells — exactly the menu selection `Style` patched onto
/// the row by the renderer's `Paragraph::style(..)` (fg/bg replaced, BOLD added).
fn paint_menu_row_style(frame: &mut FrameData, rect: Rect, fg: u32, bg: u32, bold: u16) {
    for_each_cell_in_rect(frame, rect, |cell| {
        cell.fg = fg;
        cell.bg = bg;
        cell.modifier |= bold;
    });
}

/// #45: lay the live `active_frame` content into a cached sidebar [`ComposedShell`], producing the
/// final composited frame. Cheap (a shell clone + a content-region copy + cursor/hyperlink/graphics
/// fixup), so it runs per content frame while the expensive shell build is reused. The output is
/// byte-identical to the tail of `compose_frame` — only the cursor and content region depend on the
/// live frame; everything else (sidebar, overlays, geometry) comes from the cached shell.
pub(crate) fn overlay_content_onto_shell(
    shell: &ComposedShell,
    active_frame: &FrameData,
) -> FrameData {
    let mut frame = shell.frame.clone();
    copy_active_content_excluding(
        active_frame,
        &mut frame,
        shell.sidebar_width,
        shell.content_width,
        &shell.excluded_rects,
    );
    if shell.modal_open {
        frame.cursor = None;
    } else {
        frame.cursor = offset_cursor(
            active_frame.cursor.as_ref(),
            shell.sidebar_width,
            shell.content_width,
        );
    }
    frame.hyperlinks = active_frame.hyperlinks.clone();
    if shell.sidebar_width == 0 {
        frame.graphics = active_frame.graphics.clone();
    }
    frame
}

fn copy_active_content_excluding(
    active_frame: &FrameData,
    target: &mut FrameData,
    target_x: u16,
    target_width: u16,
    excluded_rects: &[Rect],
) {
    let copy_width = target_width.min(active_frame.width);
    let copy_height = target.height.min(active_frame.height);
    for row in 0..copy_height {
        for col in 0..copy_width {
            let source_idx = (row as usize) * (active_frame.width as usize) + (col as usize);
            let target_col = target_x + col;
            if excluded_rects
                .iter()
                .any(|rect| rect_contains(*rect, target_col, row))
            {
                continue;
            }
            let target_idx = (row as usize) * (target.width as usize) + (target_col as usize);
            if let (Some(source), Some(target_cell)) = (
                active_frame.cells.get(source_idx),
                target.cells.get_mut(target_idx),
            ) {
                *target_cell = source.clone();
            }
        }
    }
}

fn offset_cursor(
    cursor: Option<&CursorState>,
    sidebar_width: u16,
    content_width: u16,
) -> Option<CursorState> {
    let cursor = cursor?;
    if cursor.x >= content_width {
        return None;
    }
    Some(CursorState {
        x: sidebar_width + cursor.x,
        y: cursor.y,
        visible: cursor.visible,
        shape: cursor.shape,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::supervisor::{
        AgentSummary, ClientSupervisorModel, NewWorkspaceRoute, ServerId, ServerSummary,
        WorkspaceSummary,
    };
    use crate::protocol::CursorState;
    use std::time::Duration;

    /// #56: `row_for_selection` must paint NO row once the model's selection has scrolled past the
    /// last VISIBLE row (a tall menu on a short host) — matching the renderer's `row_index == selected`
    /// gate — instead of lighting up the wrong, last-visible row.
    #[test]
    fn row_for_selection_skips_offscreen_selection() {
        let rows = [Rect::new(0, 0, 4, 1), Rect::new(0, 1, 4, 1)];
        assert_eq!(row_for_selection(&rows, 0), Some(rows[0]));
        assert_eq!(row_for_selection(&rows, 1), Some(rows[1]));
        // selection beyond the visible rows -> no highlight (NOT clamped to the last row).
        assert_eq!(row_for_selection(&rows, 2), None);
        assert_eq!(row_for_selection(&rows, 99), None);
        // empty visible set -> nothing to paint.
        assert_eq!(row_for_selection(&[], 0), None);
    }

    fn cell(symbol: &str) -> CellData {
        CellData {
            symbol: symbol.into(),
            fg: 0,
            bg: 0,
            modifier: 0,
            skip: false,
            hyperlink: None,
        }
    }

    fn frame(width: u16, height: u16, rows: &[&str]) -> FrameData {
        let mut cells = Vec::new();
        for row in 0..height as usize {
            let line = rows.get(row).copied().unwrap_or("");
            for col in 0..width as usize {
                let symbol = line
                    .chars()
                    .nth(col)
                    .map(|ch| ch.to_string())
                    .unwrap_or_else(|| " ".into());
                cells.push(cell(&symbol));
            }
        }
        FrameData {
            cells,
            width,
            height,
            cursor: Some(CursorState {
                x: 1,
                y: 1,
                visible: true,
                shape: 2,
            }),
            hyperlinks: Vec::new(),
            graphics: Vec::new(),
        }
    }

    /// The footer-anchored `anchor_area` the renderer/hit-test derive the composited client
    /// overlays from: spans the host top down to the sidebar footer row. Tests derive their
    /// expected popup coordinates from this SAME rect so render geometry == hit-test geometry.
    fn anchor_area(
        model: &ClientSupervisorModel,
        compositor: &ClientCompositor,
        host_w: u16,
        host_h: u16,
    ) -> Rect {
        compositor.overlay_anchor_area(model, host_w, host_h)
    }

    fn row_text(frame: &FrameData, row: u16) -> String {
        (0..frame.width)
            .map(|col| {
                frame.cells[(row as usize) * (frame.width as usize) + (col as usize)]
                    .symbol
                    .as_str()
            })
            .collect()
    }

    #[test]
    fn compose_frame_draws_server_sidebar_shell_and_offsets_active_content() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "main-herdr".into(),
                        label: "herdr".into(),
                        branch: Some("master".into()),
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
                        workspace_id: "remote-api".into(),
                        label: "api".into(),
                        branch: Some("feature/api".into()),
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

        let content = frame(8, 3, &["content", "frame"]);
        // item 2 (C3): the host banner adds a row to the spaces list, so render at a taller
        // sidebar to keep the remote card's branch line on screen.
        let composed = ClientCompositor::new(26).compose_frame(
            &model,
            &content,
            60,
            28,
            std::time::Instant::now(),
        );

        assert_eq!(composed.width, 60);
        assert_eq!(composed.height, 28);
        let rows: Vec<_> = (0..composed.height)
            .map(|row| row_text(&composed, row))
            .collect();
        assert!(row_text(&composed, 0).starts_with(" spaces"));
        assert!(row_text(&composed, 0)
            .chars()
            .take(25)
            .collect::<String>()
            .ends_with("all"));
        assert_eq!(composed.cells[25].symbol, "│");
        assert!(rows.iter().any(|row| row.contains("herdr")));
        assert!(rows.iter().any(|row| row.contains("master")));
        // item 2 (C3): bare space label "api" (host "x" now lives in the banner row above).
        assert!(rows.iter().any(|row| row.contains("api")));
        assert!(rows.iter().any(|row| row.contains("feature/api")));
        assert!(rows.iter().any(|row| row.starts_with(" agents")));
        assert!(rows.iter().any(|row| row.contains("claude")));
        let row0_content: String = row_text(&composed, 0).chars().skip(26).collect();
        let row1_content: String = row_text(&composed, 1).chars().skip(26).collect();
        assert!(row0_content.starts_with("content"));
        assert!(row1_content.starts_with("frame"));
        assert_eq!(
            composed.cursor,
            Some(CursorState {
                x: 27,
                y: 1,
                visible: true,
                shape: 2,
            })
        );
    }

    #[test]
    fn compose_frame_uses_main_ui_settings_for_sidebar_fields() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        model
            .set_summary(
                &remote_id,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "remote-api".into(),
                        label: "api".into(),
                        branch: Some("feature/api".into()),
                        focused: true,
                        ..Default::default()
                    }],
                    agents: Vec::new(),
                },
            )
            .unwrap();
        let mut settings = crate::api::schema::UiSettingsInfo::default();
        crate::app::state::SidebarSpaceItem::Branch
            .set_enabled(&mut settings.sidebar_spaces, false);
        crate::app::state::SidebarSpaceItem::BranchStatus
            .set_enabled(&mut settings.sidebar_spaces, false);
        model.set_ui_settings(settings);

        let content = frame(8, 3, &["content", "frame"]);
        let composed = ClientCompositor::new(26).compose_frame(
            &model,
            &content,
            60,
            16,
            std::time::Instant::now(),
        );
        let rows: Vec<_> = (0..composed.height)
            .map(|row| row_text(&composed, row))
            .collect();

        // item 2 (C3): the workspace label is now the bare space name (the host name lives in
        // the banner above), and the branch column is disabled by the ui-settings overrides.
        assert!(rows.iter().any(|row| row.contains("api")));
        assert!(!rows.iter().any(|row| row.contains("feature/api")));
    }

    #[test]
    fn content_size_reserves_sidebar_width_and_keeps_one_column_minimum() {
        let compositor = ClientCompositor::new(12);

        assert_eq!(compositor.content_size(80, 24), (68, 24));
        assert_eq!(compositor.content_size(8, 24), (1, 24));
    }

    #[test]
    fn compose_frame_reserves_content_column_when_host_is_narrower_than_sidebar() {
        let model = ClientSupervisorModel::new("local");
        let compositor = ClientCompositor::new(12);
        let content = frame(1, 1, &["x"]);

        let composed = compositor.compose_frame(&model, &content, 8, 3, std::time::Instant::now());

        assert_eq!(composed.width, 8);
        assert_eq!(composed.cells[7].symbol, "x");
    }

    #[test]
    fn filter_label_rect_uses_display_width_for_wide_text() {
        let rect = filter_label_rect(Rect::new(0, 0, 6, 1), "전체");

        assert_eq!(rect.x, 1);
        assert_eq!(rect.width, 4);
    }

    #[test]
    fn hit_test_uses_server_sidebar_geometry() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
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

        let compositor = ClientCompositor::new(26);
        // Derive row geometry from the same snapshot render uses (render == hit_test): the main
        // card, the divider, item 2's host banner, and the remote card all come from one pass.
        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 28, Instant::now());
        let main_card = snapshot
            .app
            .view
            .workspace_card_areas
            .iter()
            .find(|c| c.ws_idx == 0)
            .expect("main card");
        let remote_card = snapshot
            .app
            .view
            .workspace_card_areas
            .iter()
            .find(|c| c.ws_idx == 1)
            .expect("remote card");
        let divider_y = snapshot.app.view.divider_rows[0];
        // #19 (host half): in multi-host mode the Local banner is the FIRST banner (above the local
        // card — it is the host's drag handle); the remote banner is the LAST one (above the remote
        // card). `local_banner_y` keeps the original "a banner row resolves to no workspace" check.
        let local_banner_y = snapshot.app.view.host_banner_areas[0].rect.y;
        let remote_banner_y = snapshot
            .app
            .view
            .host_banner_areas
            .last()
            .expect("remote banner")
            .rect
            .y;

        assert_eq!(
            compositor.hit_test(&model, 23, 0, 60, 28),
            Some(SidebarHitTarget::Filter)
        );
        assert_eq!(
            compositor.hit_test(&model, 1, main_card.rect.y, 60, 28),
            Some(SidebarHitTarget::Workspace {
                server_id: ServerId::main(),
                workspace_id: "main-herdr".into(),
            })
        );
        // item 4: the local→remote divider row resolves to no workspace. item 2 (C3): the host
        // banner row (below the divider, above the remote card) also resolves to no workspace.
        assert!(!matches!(
            compositor.hit_test(&model, 1, divider_y, 60, 28),
            Some(SidebarHitTarget::Workspace { .. })
        ));
        assert!(!matches!(
            compositor.hit_test(&model, 1, local_banner_y, 60, 28),
            Some(SidebarHitTarget::Workspace { .. })
        ));
        // #19 (host half): the Local banner sits ABOVE the local card (it is the host drag handle).
        // The divider and the remote banner are host boundaries between the local block and the
        // remote card.
        assert!(
            local_banner_y < main_card.rect.y,
            "local banner is above the local card"
        );
        assert!(main_card.rect.y < divider_y);
        assert!(divider_y < remote_card.rect.y);
        assert!(
            main_card.rect.y < remote_banner_y && remote_banner_y < remote_card.rect.y,
            "remote banner sits between the local block and the remote card"
        );
        assert_eq!(
            compositor.hit_test(&model, 1, remote_card.rect.y, 60, 28),
            Some(SidebarHitTarget::Workspace {
                server_id: remote_id.clone(),
                workspace_id: "remote-api".into(),
            })
        );
        // The agent row + affordances still resolve to their targets at their geometry.
        let new_rect = snapshot.app.sidebar_new_button_rect();
        assert_eq!(
            compositor.hit_test(&model, new_rect.x, new_rect.y, 60, 28),
            Some(SidebarHitTarget::New)
        );
        let menu_rect = snapshot.app.global_launcher_rect();
        assert_eq!(
            compositor.hit_test(
                &model,
                menu_rect.x + menu_rect.width - 1,
                menu_rect.y,
                60,
                28
            ),
            Some(SidebarHitTarget::Menu)
        );
        assert_eq!(
            compositor.hit_test(&model, 27, main_card.rect.y, 60, 28),
            None
        );
    }

    #[test]
    fn hit_test_ignores_disabled_workspace_rows() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
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
        model
            .set_connection_state(
                &remote_id,
                crate::client::supervisor::ConnectionState::Disconnected,
            )
            .unwrap();

        let compositor = ClientCompositor::new(26);

        // The disconnected remote's row is a placeholder (no workspace_id), so no row in the
        // sidebar resolves to a `Workspace` hit. #19 (host half): the Local/remote banner rows are
        // `HostBanner` hits, not `Workspace` ones, so the invariant holds across the whole column.
        for y in 0..16 {
            assert!(
                !matches!(
                    compositor.hit_test(&model, 1, y, 60, 16),
                    Some(SidebarHitTarget::Workspace { .. })
                ),
                "row {y} unexpectedly hit-tested to a workspace",
            );
        }
    }

    /// #16/#20/#26: a single local server with two workspaces, each owning one agent. ws-1 is
    /// focused (→ the snapshot's active/selected workspace), so it exercises both the
    /// `CurrentWorkspace` scope slice and the section-divider/divider-reset geometry without the
    /// host-banner rows a secondary server would add.
    fn single_server_two_ws_model() -> ClientSupervisorModel {
        let mut model = ClientSupervisorModel::new("local");
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![
                        WorkspaceSummary {
                            workspace_id: "ws-1".into(),
                            label: "one".into(),
                            branch: None,
                            focused: true,
                            ..Default::default()
                        },
                        WorkspaceSummary {
                            workspace_id: "ws-2".into(),
                            label: "two".into(),
                            branch: None,
                            focused: false,
                            ..Default::default()
                        },
                    ],
                    agents: vec![
                        AgentSummary {
                            agent_id: "agent-1".into(),
                            workspace_id: "ws-1".into(),
                            label: "claude".into(),
                            status: "idle".into(),
                            focused: false,
                            pane_label: None,
                            tab_id: String::new(),
                            tab_label: None,
                        },
                        AgentSummary {
                            agent_id: "agent-2".into(),
                            workspace_id: "ws-2".into(),
                            label: "codex".into(),
                            status: "idle".into(),
                            focused: false,
                            pane_label: None,
                            tab_id: String::new(),
                            tab_label: None,
                        },
                    ],
                },
            )
            .unwrap();
        model
    }

    // #20: the agents-panel "all"/"current" toggle resolves to `AgentScopeToggle`, and toggling it
    // flips the compositor's client-local scope and zeroes the panel scroll.
    #[test]
    fn scope_toggle_hit_test_resolves_and_toggles_scope() {
        use crate::app::state::AgentPanelScope;
        let model = single_server_two_ws_model();
        let mut compositor = ClientCompositor::new(26);
        assert_eq!(
            compositor.agent_panel_scope(),
            AgentPanelScope::AllWorkspaces
        );

        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 28, Instant::now());
        let rect = agent_panel_toggle_hit_rect(&snapshot.app);
        assert!(rect.width > 0, "the scope toggle should be drawn");
        assert_eq!(
            compositor.hit_test(&model, rect.x, rect.y, 60, 28),
            Some(SidebarHitTarget::AgentScopeToggle)
        );

        compositor.agent_panel_scroll = 3;
        compositor.toggle_agent_panel_scope();
        assert_eq!(
            compositor.agent_panel_scope(),
            AgentPanelScope::CurrentWorkspace
        );
        assert_eq!(compositor.agent_panel_scroll, 0);
    }

    // #20: under `CurrentWorkspace` scope, the agent panel only renders the active workspace's
    // agents, and the flat `agent_routes` stays aligned so an agent-row hit resolves correctly.
    #[test]
    fn current_scope_limits_agent_routes_to_active_workspace() {
        let model = single_server_two_ws_model();
        let mut compositor = ClientCompositor::new(26);

        // AllWorkspaces: both agents have routes.
        let all =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 28, Instant::now());
        assert_eq!(all.agent_routes.len(), 2);

        // CurrentWorkspace: only the active workspace's (ws-1) agent route remains.
        compositor.toggle_agent_panel_scope();
        let current =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 28, Instant::now());
        assert_eq!(current.agent_routes.len(), 1);
        assert_eq!(current.agent_routes[0].agent_id, "agent-1");
    }

    // #20 regression: in mixed-remote mode each connected server independently reports its own
    // focused workspace, so the local `main-herdr` row (focused, owning the focused agent the user
    // is attached to) AND the trailing remote `remote-api` row both carry `focused == true`. A
    // plain last-wins selected the remote, so under the default `CurrentWorkspace` scope the local
    // agent disappeared from the panel. The agent-focused local row must win over the merely
    // workspace-focused remote row.
    #[test]
    fn current_scope_keeps_local_agents_when_remote_also_focused() {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        // Local server (row 0): workspace focused AND its agent is the focused one.
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
                    agents: vec![AgentSummary {
                        agent_id: "main-agent".into(),
                        workspace_id: "main-herdr".into(),
                        label: "claude".into(),
                        status: "working".into(),
                        focused: true,
                        pane_label: None,
                        tab_id: String::new(),
                        tab_label: None,
                    }],
                },
            )
            .unwrap();
        // Remote server (row 1): workspace also reports focused, but no focused agent.
        model
            .set_summary(
                &remote_id,
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "remote-api".into(),
                        label: "api".into(),
                        branch: None,
                        focused: true,
                        ..Default::default()
                    }],
                    agents: vec![AgentSummary {
                        agent_id: "remote-agent".into(),
                        workspace_id: "remote-api".into(),
                        label: "codex".into(),
                        status: "idle".into(),
                        focused: false,
                        pane_label: None,
                        tab_id: String::new(),
                        tab_label: None,
                    }],
                },
            )
            .unwrap();

        let mut compositor = ClientCompositor::new(26);
        compositor.toggle_agent_panel_scope(); // -> CurrentWorkspace
        let current =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 28, Instant::now());
        // The local workspace (row 0, the agent-focused one) wins, so its agent renders.
        assert_eq!(current.app.active, Some(0));
        assert_eq!(current.agent_routes.len(), 1);
        assert_eq!(current.agent_routes[0].agent_id, "main-agent");
    }

    // #16: dragging the spaces↔agents section divider sets a client-local split override that
    // grows the workspace section as the divider moves down.
    #[test]
    fn section_divider_drag_sets_local_split() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEventKind};
        let model = single_server_two_ws_model();
        let mut compositor = ClientCompositor::new(26);
        assert!(compositor.section_split.is_none());

        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 28, Instant::now());
        let divider = crate::ui::sidebar_section_divider_rect(
            snapshot.app.view.sidebar_rect,
            snapshot.app.sidebar_section_split,
        );
        assert!(divider.width > 0, "the section divider should be drawn");

        let ev = |kind, row| crossterm::event::MouseEvent {
            kind,
            column: divider.x,
            row,
            modifiers: KeyModifiers::empty(),
        };

        assert_eq!(
            compositor.handle_sidebar_section_divider_mouse(
                &model,
                &ev(MouseEventKind::Down(MouseButton::Left), divider.y),
                60,
                28,
            ),
            Some(true)
        );
        let after_press = compositor.section_split.expect("press sets a split");
        assert_eq!(
            compositor.handle_sidebar_section_divider_mouse(
                &model,
                &ev(MouseEventKind::Drag(MouseButton::Left), divider.y + 2),
                60,
                28,
            ),
            Some(true)
        );
        let after_drag = compositor.section_split.expect("drag keeps a split");
        assert!(
            after_drag > after_press,
            "dragging down increases the workspace ratio ({after_press} -> {after_drag})"
        );

        // Release ends the drag; a later drag with no active drag is ignored.
        assert_eq!(
            compositor.handle_sidebar_section_divider_mouse(
                &model,
                &ev(MouseEventKind::Up(MouseButton::Left), divider.y + 2),
                60,
                28,
            ),
            Some(true)
        );
        assert_eq!(
            compositor.handle_sidebar_section_divider_mouse(
                &model,
                &ev(MouseEventKind::Drag(MouseButton::Left), divider.y + 4),
                60,
                28,
            ),
            None
        );
    }

    // #26: a second divider press within the double-click window resets the width to the default
    // and reports a content resize; the first press only starts a drag (redraw).
    #[test]
    fn divider_double_click_resets_width_to_default() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEventKind};
        let model = single_server_two_ws_model();
        let mut compositor = ClientCompositor::new(26);
        let settings = model.ui_settings();

        // The divider sits at the rightmost sidebar column (`sidebar_width - 1`); a press only
        // registers when it lands on that exact column, which moves as the width changes.
        let press = |column: u16| crossterm::event::MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column,
            row: 5,
            modifiers: KeyModifiers::empty(),
        };

        let t0 = Instant::now();
        assert_eq!(
            compositor.handle_sidebar_resize_mouse(&press(25), 80, 24, settings, t0),
            Some(SidebarResizeOutcome::Redraw)
        );
        assert_eq!(compositor.sidebar_width(), 26);

        // Drag narrower → the divider (and thus the press column) moves to col 18.
        let drag = crossterm::event::MouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            column: 18,
            row: 5,
            modifiers: KeyModifiers::empty(),
        };
        assert!(matches!(
            compositor.handle_sidebar_resize_mouse(&drag, 80, 24, settings, t0),
            Some(SidebarResizeOutcome::Resized(..))
        ));
        assert_eq!(compositor.sidebar_width(), 19);

        // Two quick presses on the NEW divider column (18) → reset to default, reported as a
        // resize. The drag cleared the press timestamp, so the first of these starts a fresh
        // double-click window (redraw) and the second triggers the reset. Both presses share a `now`
        // inside the double-click window.
        assert_eq!(
            compositor.handle_sidebar_resize_mouse(&press(18), 80, 24, settings, t0),
            Some(SidebarResizeOutcome::Redraw)
        );
        assert!(matches!(
            compositor.handle_sidebar_resize_mouse(&press(18), 80, 24, settings, t0),
            Some(SidebarResizeOutcome::Resized(..))
        ));
        assert_eq!(
            compositor.sidebar_width(),
            settings
                .sidebar_default_width
                .clamp(settings.sidebar_min_width, settings.sidebar_max_width)
        );
    }

    // #17: a width-divider drag must coalesce its (expensive) remote PTY resizes latest-wins —
    // emit one immediately, throttle intermediate ticks to local-only Redraw, and ALWAYS flush the
    // final settled size on release so the committed size matches where the divider was let go.
    #[test]
    fn divider_drag_coalesces_resizes_and_flushes_on_release() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEventKind};
        let model = single_server_two_ws_model();
        let mut compositor = ClientCompositor::new(26);
        let settings = model.ui_settings();
        let t0 = Instant::now();

        let down = crossterm::event::MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 25, // divider at sidebar_width(26) - 1
            row: 5,
            modifiers: KeyModifiers::empty(),
        };
        let drag = |column: u16| crossterm::event::MouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            column,
            row: 5,
            modifiers: KeyModifiers::empty(),
        };
        let up = crossterm::event::MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column: 20,
            row: 5,
            modifiers: KeyModifiers::empty(),
        };

        // Press starts the drag (no resize yet) and clears the throttle.
        assert_eq!(
            compositor.handle_sidebar_resize_mouse(&down, 80, 24, settings, t0),
            Some(SidebarResizeOutcome::Redraw)
        );

        // First drag tick resizes immediately (throttle was cleared).
        assert!(matches!(
            compositor.handle_sidebar_resize_mouse(&drag(24), 80, 24, settings, t0),
            Some(SidebarResizeOutcome::Resized(..))
        ));

        // A second tick 40ms later is within the 100ms throttle → local-only Redraw, no PTY resize.
        let t_soon = t0 + std::time::Duration::from_millis(40);
        assert_eq!(
            compositor.handle_sidebar_resize_mouse(&drag(22), 80, 24, settings, t_soon),
            Some(SidebarResizeOutcome::Redraw)
        );
        // ...but the sidebar still tracks the cursor locally every tick.
        assert_eq!(compositor.sidebar_width(), 23);

        // A tick past the throttle window resizes again (latest-wins).
        let t_late = t0 + std::time::Duration::from_millis(120);
        assert!(matches!(
            compositor.handle_sidebar_resize_mouse(&drag(21), 80, 24, settings, t_late),
            Some(SidebarResizeOutcome::Resized(..))
        ));

        // Release always flushes the final settled size as a resize (even though the previous tick
        // already resized) so the committed size can never be stale.
        let t_up = t0 + std::time::Duration::from_millis(125);
        assert!(matches!(
            compositor.handle_sidebar_resize_mouse(&up, 80, 24, settings, t_up),
            Some(SidebarResizeOutcome::Resized(..))
        ));
    }

    // #19: `block_insert_global_index` resolves a render-order drop to a GLOBAL index slot. The
    // critical case is worktree grouping, where render order != storage (ws_idx/banner_idx) order:
    // dropping past the last RENDERED card must land after the block's HIGHEST stored slot (`max`),
    // not after the last rendered card. This is what keeps the live drop indicator and the commit in
    // lockstep (both derive their slot here) and what makes host reorder robust to a scrolled-off
    // leading banner (the visible block's first banner_idx is not 0).
    #[test]
    fn block_insert_global_index_uses_storage_max_not_render_last() {
        // Storage [L=0, M=1, P=2] rendered parent-first as [P(2), L(0), M(1)] (worktree group).
        let cards = vec![
            (2usize, Rect::new(0, 0, 4, 2)), // P: rows 0..2, midpoint 1
            (0usize, Rect::new(0, 2, 4, 2)), // L: rows 2..4, midpoint 3
            (1usize, Rect::new(0, 4, 4, 2)), // M: rows 4..6, midpoint 5
        ];
        // Dropped below every midpoint → after the block's HIGHEST stored slot: max(0,1,2)+1 = 3.
        // (The pre-fix code returned the last RENDERED card's index + 1 = M(1)+1 = 2 — the bug.)
        assert_eq!(block_insert_global_index(&cards, 99), Some(3));
        // Above the very first rendered card → that card's global index (P = 2).
        assert_eq!(block_insert_global_index(&cards, 0), Some(2));
        // Between P and L (above L's midpoint) → L's global index (0).
        assert_eq!(block_insert_global_index(&cards, 3), Some(0));

        // Host scroll analogue: leading banner (banner_idx 0) scrolled off, visible = [1, 2].
        let scrolled = vec![
            (1usize, Rect::new(0, 0, 4, 1)),
            (2usize, Rect::new(0, 1, 4, 1)),
        ];
        // A drop above the first VISIBLE banner resolves to its true banner_idx (1), not 0.
        assert_eq!(block_insert_global_index(&scrolled, 0), Some(1));
        // Past the last → max(1,2)+1 = 3 (the full-list end), not visible-count 2.
        assert_eq!(block_insert_global_index(&scrolled, 99), Some(3));

        // Empty block → no slot.
        assert_eq!(block_insert_global_index(&[], 5), None);
    }

    // #19: pressing a workspace card and dragging past the threshold to another card's row, then
    // releasing, commits a `workspace.reorder` with the drop position within the owning server.
    #[test]
    fn workspace_drag_reorder_commits_insert_index() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEventKind};
        let model = single_server_two_ws_model();
        let mut compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);

        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let card = |ws_idx: usize| {
            snapshot
                .app
                .view
                .workspace_card_areas
                .iter()
                .find(|c| c.ws_idx == ws_idx)
                .expect("card")
                .rect
        };
        let ws1_row = card(0).y;
        let ws2_row = card(1).y;

        // Arm the press on ws-2 (the second workspace), like the Down hit arm does.
        compositor.begin_workspace_press(ServerId::main(), "ws-2".into(), 1, ws2_row);

        // Drag up onto ws-1's row.
        let drag = crossterm::event::MouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            column: 1,
            row: ws1_row,
            modifiers: KeyModifiers::empty(),
        };
        assert_eq!(
            compositor.handle_workspace_reorder_mouse(&model, &drag, host.0, host.1),
            WorkspaceReorderOutcome::Dragging
        );

        // Release on ws-1's row → reorder ws-2 to index 0 within the (single) server's list.
        let up = crossterm::event::MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column: 1,
            row: ws1_row,
            modifiers: KeyModifiers::empty(),
        };
        assert_eq!(
            compositor.handle_workspace_reorder_mouse(&model, &up, host.0, host.1),
            WorkspaceReorderOutcome::Commit {
                server_id: ServerId::main(),
                workspace_id: "ws-2".into(),
                insert_index: 0,
            }
        );
    }

    // #19: while dragging a space the snapshot must carry a live drop indicator (`app.drag`) so the
    // shared renderer draws the drop line every frame — the client path used to show nothing until
    // release. The dragged card's global index and the global insert slot must both be correct.
    #[test]
    fn workspace_drag_preview_populates_app_drag() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEventKind};
        let mut model = ClientSupervisorModel::new("local");
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![
                        WorkspaceSummary {
                            workspace_id: "ws-1".into(),
                            label: "one".into(),
                            branch: None,
                            focused: false,
                            ..Default::default()
                        },
                        WorkspaceSummary {
                            workspace_id: "ws-2".into(),
                            label: "two".into(),
                            branch: None,
                            focused: true,
                            ..Default::default()
                        },
                        WorkspaceSummary {
                            workspace_id: "ws-3".into(),
                            label: "three".into(),
                            branch: None,
                            focused: false,
                            ..Default::default()
                        },
                    ],
                    agents: Vec::new(),
                },
            )
            .unwrap();

        let mut compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        // No drag in progress yet: the renderer gets no drop indicator.
        assert!(snapshot.app.drag.is_none());

        let card = |ws_idx: usize| {
            snapshot
                .app
                .view
                .workspace_card_areas
                .iter()
                .find(|c| c.ws_idx == ws_idx)
                .expect("card")
                .rect
        };
        let ws1_row = card(0).y;
        let ws3_rect = card(2);

        // Press on ws-2 (global index 1), then drag down past ws-3's midpoint.
        compositor.begin_workspace_press(ServerId::main(), "ws-2".into(), 1, ws1_row);
        let drag = crossterm::event::MouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            column: 1,
            row: ws3_rect.y + ws3_rect.height,
            modifiers: KeyModifiers::empty(),
        };
        assert_eq!(
            compositor.handle_workspace_reorder_mouse(&model, &drag, host.0, host.1),
            WorkspaceReorderOutcome::Dragging
        );

        let dragging = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        match dragging.app.drag.as_ref().map(|d| &d.target) {
            Some(crate::app::state::DragTarget::WorkspaceReorder {
                source_ws_idx,
                drop_target,
            }) => {
                // ws-2 is global index 1; dropping past ws-3 (the third, single-server card) lands
                // at global insert position 3 (after the whole block) = End of the 3-space list.
                assert_eq!(*source_ws_idx, 1);
                assert_eq!(
                    *drop_target,
                    Some(crate::app::state::WorkspaceDropTarget::End)
                );
            }
            _ => panic!("expected a WorkspaceReorder drag preview"),
        }
    }

    // #19: the drop indicator must stay inside the SOURCE server's contiguous row block. Dragging a
    // local space far below the remote's rows must still resolve to an insert index at the end of
    // the local block (≤ local card count) and never point into the remote block.
    #[test]
    fn workspace_drag_preview_clamps_to_source_server_block() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEventKind};
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![
                        WorkspaceSummary {
                            workspace_id: "local-1".into(),
                            label: "l1".into(),
                            branch: None,
                            focused: true,
                            ..Default::default()
                        },
                        WorkspaceSummary {
                            workspace_id: "local-2".into(),
                            label: "l2".into(),
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
                &remote_id,
                ServerSummary {
                    workspaces: vec![
                        WorkspaceSummary {
                            workspace_id: "remote-1".into(),
                            label: "r1".into(),
                            branch: None,
                            focused: false,
                            ..Default::default()
                        },
                        WorkspaceSummary {
                            workspace_id: "remote-2".into(),
                            label: "r2".into(),
                            branch: None,
                            focused: false,
                            ..Default::default()
                        },
                    ],
                    agents: Vec::new(),
                },
            )
            .unwrap();

        let mut compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        // Global indices of the LOCAL cards (the source block): base + count == block end.
        let local_indices: Vec<usize> = snapshot
            .workspace_routes
            .iter()
            .enumerate()
            .filter(|(_, route)| {
                route.server_id == ServerId::main() && route.workspace_id.is_some()
            })
            .map(|(idx, _)| idx)
            .collect();
        let local_base = *local_indices.first().expect("local cards present");
        let local_block_end = local_base + local_indices.len();
        let first_local_row = snapshot
            .app
            .view
            .workspace_card_areas
            .iter()
            .find(|c| c.ws_idx == local_base)
            .expect("first local card")
            .rect
            .y;

        // Press the first local space, then drag all the way to the bottom (past every remote card).
        compositor.begin_workspace_press(ServerId::main(), "local-1".into(), 1, first_local_row);
        let drag = crossterm::event::MouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            column: 1,
            row: host.1 - 1,
            modifiers: KeyModifiers::empty(),
        };
        assert_eq!(
            compositor.handle_workspace_reorder_mouse(&model, &drag, host.0, host.1),
            WorkspaceReorderOutcome::Dragging
        );

        let dragging = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        match dragging.app.drag.as_ref().map(|d| &d.target) {
            Some(crate::app::state::DragTarget::WorkspaceReorder {
                source_ws_idx,
                drop_target,
            }) => {
                assert_eq!(*source_ws_idx, local_base);
                // Clamped to the local block: the insert slot never points into the remote block.
                let insert = match drop_target.expect("preview carries an insert slot") {
                    crate::app::state::WorkspaceDropTarget::Before(idx) => idx,
                    crate::app::state::WorkspaceDropTarget::End => dragging.app.workspaces.len(),
                };
                assert!(
                    insert <= local_block_end,
                    "insert {insert} escaped local block end {local_block_end}"
                );
            }
            _ => panic!("expected a WorkspaceReorder drag preview"),
        }
    }

    // #19: a sub-threshold press (no drag) must leave `app.drag` empty so no phantom drop line shows.
    #[test]
    fn workspace_sub_threshold_press_has_no_drag_preview() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEventKind};
        let model = single_server_two_ws_model();
        let mut compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let ws1_row = snapshot
            .app
            .view
            .workspace_card_areas
            .iter()
            .find(|c| c.ws_idx == 0)
            .expect("first card")
            .rect
            .y;
        // Press, then a zero-movement "drag" stays under the threshold: no drag begins.
        compositor.begin_workspace_press(ServerId::main(), "ws-1".into(), 1, ws1_row);
        let drag = crossterm::event::MouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            column: 1,
            row: ws1_row,
            modifiers: KeyModifiers::empty(),
        };
        assert_eq!(
            compositor.handle_workspace_reorder_mouse(&model, &drag, host.0, host.1),
            WorkspaceReorderOutcome::Ignored
        );

        let after = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        assert!(after.app.drag.is_none());
    }

    // #19: a press with no drag (sub-threshold) is not a reorder — release is `Ignored` so the
    // focus-on-down click stands.
    // #19 (host half): a 3-host model — Local + two connected remotes — used by the host
    // drag-reorder tests. Mirrors `mixed_supervisor_model` but with a second remote so reorder
    // has somewhere to move.
    fn three_host_model() -> (ClientSupervisorModel, ServerId, ServerId) {
        let mut model = ClientSupervisorModel::new("local");
        let remote_x = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        let remote_y = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-y".into(),
            name: "y".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("y".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        for (id, ws, label, focused) in [
            (ServerId::main(), "main-herdr", "herdr", true),
            (remote_x.clone(), "x-api", "api", false),
            (remote_y.clone(), "y-api", "api", false),
        ] {
            model
                .set_summary(
                    &id,
                    ServerSummary {
                        workspaces: vec![WorkspaceSummary {
                            workspace_id: ws.into(),
                            label: label.into(),
                            branch: None,
                            focused,
                            worktree_key: None,
                            worktree_is_linked: false,
                            git_repo_key: None,
                            git_is_linked: false,
                        }],
                        agents: Vec::new(),
                    },
                )
                .unwrap();
        }
        (model, remote_x, remote_y)
    }

    // #19 (host half): multi-host mode emits a Local banner (the draggable host handle); the
    // single-local case must stay banner-free. Asserts both directions explicitly.
    #[test]
    fn local_host_banner_only_in_multi_host_mode() {
        // Lone local: no banner.
        let local_only = ClientSupervisorModel::new("local");
        assert!(local_only.host_banner_specs().is_empty());
        assert!(local_only.host_banner_server_ids().is_empty());

        // Local + 2 remotes: a banner per host, in visible order, with Local first.
        let (model, remote_x, remote_y) = three_host_model();
        let ids = model.host_banner_server_ids();
        assert_eq!(ids, vec![ServerId::main(), remote_x, remote_y]);
        let specs = model.host_banner_specs();
        assert_eq!(specs.len(), 3);
        assert_eq!(specs[0].1.display_name, "local");
    }

    // #19 (host half): pressing a host banner then dragging past the threshold populates
    // `app.drag` with a `HostReorder` whose `insert_idx` is a HOST boundary (a banner row),
    // never inside a space block.
    #[test]
    fn host_drag_preview_populates_app_drag_at_host_boundary() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEventKind};
        let (model, _x, _y) = three_host_model();
        let mut compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);

        // Banner rects in render order: [local, x, y].
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let banner_y = |idx: usize| snapshot.app.view.host_banner_areas[idx].rect.y;
        let local_banner_y = banner_y(0);
        let y_banner_y = banner_y(2);
        // The set of every host boundary row (banner tops, and just below the last banner).
        let banner_rects: Vec<Rect> = snapshot
            .app
            .view
            .host_banner_areas
            .iter()
            .map(|b| b.rect)
            .collect();

        // Press the LOCAL banner (host idx 0), then drag down onto the third host's banner.
        compositor.begin_host_press(ServerId::main(), 1, local_banner_y);
        let drag = crossterm::event::MouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            column: 1,
            row: y_banner_y,
            modifiers: KeyModifiers::empty(),
        };
        assert_eq!(
            compositor.handle_host_reorder_mouse(&model, &drag, host.0, host.1),
            HostReorderOutcome::Dragging
        );

        let preview = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let (source_host_idx, insert_idx) = match preview.app.drag.as_ref().map(|d| &d.target) {
            Some(crate::app::state::DragTarget::HostReorder {
                source_host_idx,
                insert_idx,
            }) => (*source_host_idx, *insert_idx),
            _ => panic!("expected HostReorder drag in the preview snapshot"),
        };
        assert_eq!(source_host_idx, 0, "dragged host is Local (idx 0)");
        let insert_idx = insert_idx.expect("preview carries a live insert slot");
        // The insert slot must equal the count of banner midpoints above the drop row — i.e. a
        // host boundary — and never resolve into a space row.
        assert_eq!(insert_idx, server_insert_index(&banner_rects, y_banner_y));
        // A host insert slot is `0..=host_count`; it can never index a space card.
        assert!(insert_idx <= banner_rects.len());
    }

    // #19 (host half): releasing a host drag commits a client-local `move_server`/`reorder_server`
    // — `servers` order changes, `workspace_rows()` follows, and `active_server_id` is preserved.
    #[test]
    fn host_drag_commit_reorders_servers_client_local() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEventKind};
        let (mut model, remote_x, remote_y) = three_host_model();
        // Focus the second remote so we can prove the active server survives the move.
        model.focus_workspace_route(&remote_y, "y-api");
        assert_eq!(model.active_server_id(), &remote_y);

        let mut compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let local_banner_y = snapshot.app.view.host_banner_areas[0].rect.y;
        let y_banner_rect = snapshot.app.view.host_banner_areas[2].rect;

        // Drag Local down past the LAST host's midpoint → Local moves to the end.
        compositor.begin_host_press(ServerId::main(), 1, local_banner_y);
        let drag = crossterm::event::MouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            column: 1,
            row: y_banner_rect.y + y_banner_rect.height,
            modifiers: KeyModifiers::empty(),
        };
        assert_eq!(
            compositor.handle_host_reorder_mouse(&model, &drag, host.0, host.1),
            HostReorderOutcome::Dragging
        );
        let up = crossterm::event::MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column: 1,
            row: y_banner_rect.y + y_banner_rect.height,
            modifiers: KeyModifiers::empty(),
        };
        let outcome = compositor.handle_host_reorder_mouse(&model, &up, host.0, host.1);
        let (source_server_id, insert_index) = match outcome {
            HostReorderOutcome::Commit {
                source_server_id,
                insert_index,
            } => (source_server_id, insert_index),
            other => panic!("expected Commit, got {other:?}"),
        };
        assert_eq!(source_server_id, ServerId::main());

        // Order before: [main, x, y]. Apply the client-local reorder.
        let before: Vec<ServerId> = model
            .workspace_rows()
            .iter()
            .map(|r| r.server_id.clone())
            .collect();
        assert_eq!(
            before,
            vec![ServerId::main(), remote_x.clone(), remote_y.clone()]
        );
        assert!(model.reorder_server(&source_server_id, insert_index));
        // workspace_rows() now reflects the new host order with Local last.
        let after: Vec<ServerId> = model
            .workspace_rows()
            .iter()
            .map(|r| r.server_id.clone())
            .collect();
        assert_eq!(after, vec![remote_x, remote_y.clone(), ServerId::main()]);
        // The active server is unchanged by the host move.
        assert_eq!(model.active_server_id(), &remote_y);
    }

    // #19 (host half): the host drop indicator only ever lands on a host boundary (a banner row
    // or just below the last banner) — never inside a space block — for every drop row.
    #[test]
    fn host_drop_indicator_never_inside_a_space_block() {
        let (model, _x, _y) = three_host_model();
        let compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let banner_rects: Vec<Rect> = snapshot
            .app
            .view
            .host_banner_areas
            .iter()
            .map(|b| b.rect)
            .collect();
        let card_rows: std::collections::HashSet<u16> = snapshot
            .app
            .view
            .workspace_card_areas
            .iter()
            .flat_map(|c| c.rect.y..c.rect.y + c.rect.height)
            .collect();

        // Sweep every drop row over the whole sidebar height and confirm the resolved host
        // drop-indicator row is always a banner-derived boundary, never a space card row.
        let area = snapshot.app.view.sidebar_rect;
        for drop_row in 0..host.1 {
            let insert_idx = server_insert_index(&banner_rects, drop_row);
            if let Some(y) = crate::ui::host_drop_indicator_row(
                &snapshot.app.view.host_banner_areas,
                area,
                insert_idx,
            ) {
                assert!(
                    !card_rows.contains(&y),
                    "host drop indicator at row {y} fell inside a space block",
                );
            }
        }
    }

    // #19 (host half): a press on a SPACE arms a workspace drag (not a host drag); a press on a
    // BANNER hit-tests to `HostBanner` (the host-drag arming target).
    #[test]
    fn space_press_is_workspace_and_banner_press_is_host() {
        let (model, remote_x, _y) = three_host_model();
        let compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );

        // A banner row hit-tests to HostBanner for the right host (banner idx 1 == remote_x).
        let x_banner_y = snapshot.app.view.host_banner_areas[1].rect.y;
        assert_eq!(
            compositor.hit_test(&model, 1, x_banner_y, host.0, host.1),
            Some(SidebarHitTarget::HostBanner {
                server_id: remote_x,
            })
        );

        // A workspace card row hit-tests to a Workspace, never a HostBanner.
        let card_y = snapshot.app.view.workspace_card_areas[0].rect.y;
        assert!(matches!(
            compositor.hit_test(&model, 1, card_y, host.0, host.1),
            Some(SidebarHitTarget::Workspace { .. })
        ));
    }

    #[test]
    fn workspace_press_without_drag_is_not_a_reorder() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEventKind};
        let model = single_server_two_ws_model();
        let mut compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);

        compositor.begin_workspace_press(ServerId::main(), "ws-2".into(), 1, 5);
        let up = crossterm::event::MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column: 1,
            row: 5,
            modifiers: KeyModifiers::empty(),
        };
        assert_eq!(
            compositor.handle_workspace_reorder_mouse(&model, &up, host.0, host.1),
            WorkspaceReorderOutcome::Ignored
        );
    }

    // #21: pressing the workspace scrollbar thumb and dragging it down scrolls the list; release
    // ends the drag and a later drag is no longer owned.
    #[test]
    fn workspace_scrollbar_thumb_drag_scrolls_list() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEventKind};
        let mut model = ClientSupervisorModel::new("local");
        let workspaces: Vec<_> = (0..20)
            .map(|i| WorkspaceSummary {
                workspace_id: format!("ws-{i}"),
                label: format!("w{i}"),
                branch: None,
                focused: i == 0,
                worktree_key: None,
                worktree_is_linked: false,
                git_repo_key: None,
                git_is_linked: false,
            })
            .collect();
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces,
                    agents: Vec::new(),
                },
            )
            .unwrap();
        let mut compositor = ClientCompositor::new(26);
        let host = (60u16, 16u16);

        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let ws_area = crate::ui::workspace_list_rect(
            snapshot.app.view.sidebar_rect,
            snapshot.app.sidebar_section_split,
        );
        let track = crate::ui::workspace_list_scrollbar_rect(&snapshot.app, ws_area)
            .expect("a long list shows the scrollbar");
        assert!(track.height >= 2);

        let ev = |kind, row| crossterm::event::MouseEvent {
            kind,
            column: track.x,
            row,
            modifiers: KeyModifiers::empty(),
        };

        // Press the thumb (top of track at scroll 0) → starts a drag, no movement yet.
        assert_eq!(
            compositor.handle_sidebar_scrollbar_mouse(
                &model,
                &ev(MouseEventKind::Down(MouseButton::Left), track.y),
                host.0,
                host.1,
            ),
            Some(false)
        );
        assert_eq!(compositor.workspace_scroll, 0);

        // Drag to the bottom of the track → scrolls down.
        assert_eq!(
            compositor.handle_sidebar_scrollbar_mouse(
                &model,
                &ev(
                    MouseEventKind::Drag(MouseButton::Left),
                    track.y + track.height - 1,
                ),
                host.0,
                host.1,
            ),
            Some(true)
        );
        assert!(compositor.workspace_scroll > 0);

        // Release ends the drag; a later drag is no longer owned by the scrollbar.
        assert_eq!(
            compositor.handle_sidebar_scrollbar_mouse(
                &model,
                &ev(
                    MouseEventKind::Up(MouseButton::Left),
                    track.y + track.height - 1,
                ),
                host.0,
                host.1,
            ),
            Some(false)
        );
        assert_eq!(
            compositor.handle_sidebar_scrollbar_mouse(
                &model,
                &ev(
                    MouseEventKind::Drag(MouseButton::Left),
                    track.y + track.height - 1,
                ),
                host.0,
                host.1,
            ),
            None
        );
    }

    // item 4: a [Main, Secondary] model with workspaces on both sides.
    fn mixed_supervisor_model() -> (ClientSupervisorModel, ServerId) {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
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
        (model, remote_id)
    }

    #[test]
    fn from_model_aligns_client_workspace_remote_with_workspaces() {
        let (model, _remote_id) = mixed_supervisor_model();
        let compositor = ClientCompositor::new(26);
        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());

        // Index-aligned with app.workspaces, and matches each row's is_remote.
        assert_eq!(
            snapshot.app.client_workspace_remote.len(),
            snapshot.app.workspaces.len()
        );
        let rows = model.workspace_rows();
        let expected: Vec<bool> = rows.iter().map(|row| row.is_remote).collect();
        assert_eq!(snapshot.app.client_workspace_remote, expected);
        // [Main, Secondary] => exactly [false, true].
        assert_eq!(snapshot.app.client_workspace_remote, vec![false, true]);
    }

    #[test]
    fn from_model_populates_divider_rows_for_mixed_model() {
        let (model, _remote_id) = mixed_supervisor_model();
        let compositor = ClientCompositor::new(26);
        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());
        // A mixed model yields exactly one divider row. #19 (host half): in multi-host mode
        // BOTH hosts emit a banner (Local + the one visible Secondary), so two host-banner
        // areas come out of the same compute pass.
        assert_eq!(snapshot.app.view.divider_rows.len(), 1);
        assert_eq!(snapshot.app.view.host_banner_areas.len(), 2);
    }

    #[test]
    fn from_model_populates_host_banner_areas() {
        // item 2 (C3): the host-banner specs + the second slot of the single
        // compute_workspace_list_areas pass populate `app.host_banners` and
        // `app.view.host_banner_areas`, and flip `host_banner_active`. #19 (host half):
        // in multi-host mode the banners are [Local, remote] in visible_servers() order;
        // banner_idx indexes app.host_banners.
        let (model, _remote_id) = mixed_supervisor_model();
        let compositor = ClientCompositor::new(26);
        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());

        assert!(snapshot.app.host_banner_active);
        assert_eq!(snapshot.app.host_banners.len(), 2);
        assert_eq!(snapshot.app.host_banners[0].display_name, "local");
        assert_eq!(snapshot.app.host_banners[1].display_name, "x");
        assert_eq!(snapshot.app.view.host_banner_areas.len(), 2);
        // Every banner area never overlaps a workspace card (render == hit_test).
        for area in &snapshot.app.view.host_banner_areas {
            assert!(snapshot.app.view.workspace_card_areas.iter().all(|card| {
                !(area.rect.y >= card.rect.y && area.rect.y < card.rect.y + card.rect.height)
            }));
        }
    }

    #[test]
    fn divider_banner_insertion_does_not_shift_active_idx() {
        // item 6 (Area 6) / Area 2 no-shift regression: the optimistic override flips a
        // `focused` bool on a real Workspace row; `from_model` derives `active_idx` from the FLAT
        // `workspace_rows()` stream (which contains NO divider/banner entries — those are
        // layout-only). So even though this mixed model emits a divider AND a host banner,
        // `app.active`/`app.selected` land on the optimistic remote workspace's flat index,
        // unshifted by the non-selectable rows.
        let (mut model, remote_id) = mixed_supervisor_model();

        // Sanity: the model really does emit the non-selectable rows.
        let compositor = ClientCompositor::new(26);
        let pre =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());
        assert_eq!(pre.app.view.divider_rows.len(), 1);
        // #19 (host half): multi-host mode banners both hosts (Local + remote).
        assert_eq!(pre.app.view.host_banner_areas.len(), 2);

        // The remote workspace's index in the flat workspace_rows() stream (no divider/banner).
        let remote_idx = model
            .workspace_rows()
            .iter()
            .position(|row| {
                row.server_id == remote_id && row.workspace_id.as_deref() == Some("remote-api")
            })
            .expect("remote workspace row should be present in the flat stream");

        model.focus_workspace_route(&remote_id, "remote-api");

        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());
        // active/selected point at the optimistic remote row's flat index, NOT shifted by the
        // divider/banner rows that sit above it in the rendered list.
        assert_eq!(snapshot.app.active, Some(remote_idx));
        assert_eq!(snapshot.app.selected, remote_idx);
        // The flat workspace_rows() index is unchanged by the divider/banner insertion: the
        // optimistic remote row is at the same index whether or not the layout rows exist.
        assert_eq!(snapshot.app.workspaces.len(), model.workspace_rows().len());
    }

    #[test]
    fn agents_panel_follows_optimistic_group() {
        // item 6 (Area 6): with an optimistic agent focus, the agents panel follows the
        // optimistic server's group — the active workspace is the agent's workspace and that
        // workspace's pane (the agent) is focused, and `agent_groups()` reports the group focused.
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
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

        model.focus_agent_route(&remote_id, "remote-agent");

        // The optimistic agent's group renders focused (the panel reads agent_groups()).
        let group = model
            .agent_groups()
            .into_iter()
            .find(|group| group.workspace_id == "remote-api")
            .expect("the agent's workspace group should exist");
        assert!(group.focused);
        assert!(group
            .agents
            .iter()
            .any(|agent| agent.agent_id == "remote-agent" && agent.focused));

        let compositor = ClientCompositor::new(26);
        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());

        // active/selected point at the agent's workspace row, and that workspace has a focused
        // pane (the agent) — so the composited agents panel renders that group as focused.
        let remote_idx = model
            .workspace_rows()
            .iter()
            .position(|row| {
                row.server_id == remote_id && row.workspace_id.as_deref() == Some("remote-api")
            })
            .expect("remote workspace row should be present");
        assert_eq!(snapshot.app.active, Some(remote_idx));
        assert!(snapshot.app.workspaces[remote_idx]
            .focused_pane_id()
            .is_some());
    }

    #[test]
    fn agents_panel_highlights_summary_focused_agent_pane() {
        // Pins the bug: the sidebar agents-panel highlight must follow the FOCUSED agent's
        // pane, not the tab layout's LAST pane. Two agents share one tab ("t1") and the server
        // marks the FIRST (alpha) focused. `sidebar_placeholder_with_tabs` builds each tab
        // layout by repeated `split_focused`, leaving layout focus on the last-split pane
        // (beta) — so today `is_active_pane` lights beta instead of alpha. Pure summary truth
        // (no secondary, no clicks) exercises the server-pane-focus direction.
        let mut model = ClientSupervisorModel::new("local");
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
                    agents: vec![
                        AgentSummary {
                            agent_id: "agent-a".into(),
                            workspace_id: "main-herdr".into(),
                            label: "alpha".into(),
                            status: "idle".into(),
                            focused: true,
                            pane_label: None,
                            tab_id: "t1".into(),
                            tab_label: None,
                        },
                        AgentSummary {
                            agent_id: "agent-b".into(),
                            workspace_id: "main-herdr".into(),
                            label: "beta".into(),
                            status: "idle".into(),
                            focused: false,
                            pane_label: None,
                            tab_id: "t1".into(),
                            tab_label: None,
                        },
                    ],
                },
            )
            .unwrap();

        let compositor = ClientCompositor::new(26);
        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());

        // Resolve entries by agent label so the assertions don't depend on row ordering.
        let entries = crate::ui::agent_panel_entries(&snapshot.app);
        let entry_a = entries
            .iter()
            .find(|entry| entry.agent_label == Some("alpha".into()))
            .expect("alpha agent panel entry should exist");
        let entry_b = entries
            .iter()
            .find(|entry| entry.agent_label == Some("beta".into()))
            .expect("beta agent panel entry should exist");

        // The highlight must land on alpha (the server-focused agent), not beta (the tab's
        // last pane). This is the assertion that fails today.
        assert!(
            snapshot
                .app
                .is_active_pane(entry_a.ws_idx, entry_a.tab_idx, entry_a.pane_id),
            "alpha (server-focused agent) should be the highlighted pane"
        );
        assert!(
            !snapshot
                .app
                .is_active_pane(entry_b.ws_idx, entry_b.tab_idx, entry_b.pane_id),
            "beta (unfocused agent) must not be highlighted"
        );
    }

    #[test]
    fn agents_panel_highlight_follows_agent_click_optimistically() {
        // Pins the same bug from the client agents-tab click direction: neither agent is
        // server-focused, then the client optimistically focuses agent-a via
        // `focus_agent_route`. The highlight must follow the optimistically-focused agent's
        // pane (alpha), not the tab layout's last pane (beta).
        let mut model = ClientSupervisorModel::new("local");
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
                    agents: vec![
                        AgentSummary {
                            agent_id: "agent-a".into(),
                            workspace_id: "main-herdr".into(),
                            label: "alpha".into(),
                            status: "idle".into(),
                            focused: false,
                            pane_label: None,
                            tab_id: "t1".into(),
                            tab_label: None,
                        },
                        AgentSummary {
                            agent_id: "agent-b".into(),
                            workspace_id: "main-herdr".into(),
                            label: "beta".into(),
                            status: "idle".into(),
                            focused: false,
                            pane_label: None,
                            tab_id: "t1".into(),
                            tab_label: None,
                        },
                    ],
                },
            )
            .unwrap();

        // The client agents-tab click: optimistically mark agent-a focused.
        model.focus_agent_route(&ServerId::main(), "agent-a");

        let compositor = ClientCompositor::new(26);
        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());

        let entries = crate::ui::agent_panel_entries(&snapshot.app);
        let entry_a = entries
            .iter()
            .find(|entry| entry.agent_label == Some("alpha".into()))
            .expect("alpha agent panel entry should exist");
        let entry_b = entries
            .iter()
            .find(|entry| entry.agent_label == Some("beta".into()))
            .expect("beta agent panel entry should exist");

        // The optimistic click focuses alpha; the highlight must follow it, not stay on the
        // tab's last pane (beta). This is the assertion that fails today.
        assert!(
            snapshot
                .app
                .is_active_pane(entry_a.ws_idx, entry_a.tab_idx, entry_a.pane_id),
            "alpha (optimistically-focused agent) should be the highlighted pane"
        );
        assert!(
            !snapshot
                .app
                .is_active_pane(entry_b.ws_idx, entry_b.tab_idx, entry_b.pane_id),
            "beta (unfocused agent) must not be highlighted"
        );
    }

    #[test]
    fn hit_test_none_over_banner_row() {
        // The host-banner row is not a Workspace/affordance target — hit-test yields no
        // Workspace target over it (render == hit_test; banners are non-selectable).
        let (model, _remote_id) = mixed_supervisor_model();
        let compositor = ClientCompositor::new(26);
        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());
        let banner_y = snapshot.app.view.host_banner_areas[0].rect.y;
        let hit = compositor.hit_test(&model, 1, banner_y, 60, 16);
        assert!(
            !matches!(hit, Some(SidebarHitTarget::Workspace { .. })),
            "banner row {banner_y} hit-tested to a workspace: {hit:?}"
        );
        // No card overlaps the banner row, so the real rows still resolve to their cards.
        for card in &snapshot.app.view.workspace_card_areas {
            assert_ne!(card.rect.y, banner_y, "a card overlaps the banner row");
        }
    }

    #[test]
    fn host_banner_right_click_opens_host_menu_and_row_hit_tests() {
        // The host banner row hit-tests to a `HostBanner` target (which the client right-click path
        // turns into an open). Once the host menu is open (modal), a click at a menu row y resolves
        // to `HostContextMenuRow { index }` — render == hit_test via the shared cursor-anchored
        // geometry the renderer uses.
        let (mut model, remote_id) = mixed_supervisor_model();
        let compositor = ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        // The remote host's banner row (index 1 in visible_servers order: [local, remote]).
        let banner_y = snapshot.app.view.host_banner_areas[1].rect.y;
        assert_eq!(
            compositor.hit_test(&model, 1, banner_y, host.0, host.1),
            Some(SidebarHitTarget::HostBanner {
                server_id: remote_id.clone()
            }),
            "the host banner row resolves to its host"
        );

        // Open the host context menu anchored at the banner row (the client right-click handler).
        model.open_host_context_menu(remote_id.clone(), "x".into(), 1, banner_y);

        // The menu's inner rect / row geometry comes from the SAME shared helpers the renderer uses.
        // The host menu carries a sub-header, so `header_rows == 2`.
        let count = model.client_menu().expect("host menu open").items.len();
        let inner = crate::ui::client_menu_inner_rect_at(1, banner_y, count, 2, host.0, host.1)
            .expect("host menu fits");
        for index in 0..count {
            let row = crate::ui::client_menu_row_rect(inner, 2, index);
            assert_eq!(
                compositor.hit_test(&model, row.x, row.y, host.0, host.1),
                Some(SidebarHitTarget::ClientMenuRow { index }),
                "menu row {index} at y={} should hit-test to its index",
                row.y
            );
        }
        // A click off every menu row (the modal owns the whole rect) hit-tests to nothing.
        assert_eq!(compositor.hit_test(&model, 0, 0, host.0, host.1), None);
    }

    #[test]
    fn from_model_no_divider_rows_for_all_local_model() {
        let mut model = ClientSupervisorModel::new("local");
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
        let compositor = ClientCompositor::new(26);
        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());
        assert!(snapshot.app.view.divider_rows.is_empty());
    }

    #[test]
    fn client_hit_test_returns_no_workspace_for_divider_row() {
        let (model, _remote_id) = mixed_supervisor_model();
        let compositor = ClientCompositor::new(26);
        // Derive the divider y from the same snapshot geometry render uses (render == hit_test).
        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());
        let divider_y = snapshot.app.view.divider_rows[0];

        // The divider row resolves to no Workspace target.
        let divider_hit = compositor.hit_test(&model, 1, divider_y, 60, 16);
        assert!(
            !matches!(divider_hit, Some(SidebarHitTarget::Workspace { .. })),
            "divider row {divider_y} hit-tested to a workspace: {divider_hit:?}"
        );
        // The real workspace rows still resolve to their cards (none at the divider y).
        for card in &snapshot.app.view.workspace_card_areas {
            assert_ne!(card.rect.y, divider_y, "a card overlaps the divider row");
            assert!(matches!(
                compositor.hit_test(&model, 1, card.rect.y, 60, 16),
                Some(SidebarHitTarget::Workspace { .. })
            ));
        }
    }

    #[test]
    fn hover_hit_test_skips_divider_row() {
        // Regression lock for the future hover impl (item 7): the click-path geometry used by
        // hover (workspace_card_areas) yields no workspace for the divider row.
        let (model, _remote_id) = mixed_supervisor_model();
        let compositor = ClientCompositor::new(26);
        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());
        let divider_y = snapshot.app.view.divider_rows[0];
        assert!(snapshot
            .app
            .view
            .workspace_card_areas
            .iter()
            .all(|card| !(divider_y >= card.rect.y && divider_y < card.rect.y + card.rect.height)));
    }

    /// Build a mixed two-destination model (main `local` + remote `x`) and open the picker.
    fn two_destination_picker_model() -> (ClientSupervisorModel, ServerId) {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
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
        model.open_new_workspace_picker();
        (model, remote_id)
    }

    #[test]
    fn new_workspace_picker_renders_footer_anchored_selectable_list() {
        let (model, _) = two_destination_picker_model();

        let compositor = ClientCompositor::new(26);
        let content = frame(8, 3, &["content", "frame"]);
        let composed =
            compositor.compose_frame(&model, &content, 60, 20, std::time::Instant::now());
        let rows: Vec<_> = (0..composed.height)
            .map(|row| row_text(&composed, row))
            .collect();

        // footer-anchored ratatui popup: square corner, header, sub-label, both destinations,
        // buttons.
        assert!(rows.iter().any(|row| row.contains("┌")));
        assert!(rows.iter().any(|row| row.contains("new workspace")));
        assert!(rows.iter().any(|row| row.contains("create on")));
        assert!(rows.iter().any(|row| row.contains("local")));
        assert!(rows.iter().any(|row| row.contains("x")));
        // default selection (index 0) carries the `›` marker.
        assert!(rows.iter().any(|row| row.contains("›")));
        assert!(rows.iter().any(|row| row.contains("create")));
        assert!(rows.iter().any(|row| row.contains("cancel")));

        // the popup is footer-anchored (opens upward from the sidebar footer), NOT centered: its
        // top border sits below the host top, and it never reaches the bottom rows.
        let popup =
            crate::ui::new_workspace_picker_popup_rect(anchor_area(&model, &compositor, 60, 20), 2)
                .expect("popup fits");
        assert!(popup.y > 0, "popup is not flush to host top");
        assert!(rows[popup.y as usize].contains("┌"), "top border row");
        // rows below the popup show server content / blanks, not the picker.
        for row in &rows[(popup.y + popup.height) as usize..] {
            assert!(!row.contains("new workspace"));
        }
    }

    #[test]
    fn new_workspace_picker_mouse_click_hit_tests_footer_anchored_rows() {
        let (model, remote_id) = two_destination_picker_model();
        let compositor = ClientCompositor::new(26);

        // derive the FOOTER-ANCHORED row coordinates from the SAME shared geometry + anchor_area
        // the renderer/hit-test use.
        let anchor = anchor_area(&model, &compositor, 60, 20);
        let inner = crate::ui::new_workspace_picker_inner_rect(anchor, 2).expect("modal fits");
        let row0 = crate::ui::new_workspace_picker_row_rect(inner, 0);
        let row1 = crate::ui::new_workspace_picker_row_rect(inner, 1);

        // the popup is footer-anchored, so its rows sit below the host top (not centered, not the
        // old bottom-anchored geometry).
        assert!(row0.y > 0);

        assert_eq!(
            compositor.hit_test(&model, row0.x, row0.y, 60, 20),
            Some(SidebarHitTarget::NewWorkspaceDestination {
                server_id: ServerId::main(),
            })
        );
        assert_eq!(
            compositor.hit_test(&model, row1.x, row1.y, 60, 20),
            Some(SidebarHitTarget::NewWorkspaceDestination {
                server_id: remote_id,
            })
        );
    }

    #[test]
    fn new_workspace_picker_keyboard_navigates_and_confirms() {
        let (mut model, remote_id) = two_destination_picker_model();
        assert_eq!(model.new_workspace_picker().map(|p| p.selected), Some(0));

        model.move_new_workspace_picker_next();
        assert_eq!(model.new_workspace_picker().map(|p| p.selected), Some(1));

        let route = model.accept_new_workspace_picker();
        assert_eq!(route, NewWorkspaceRoute::CreateOn(remote_id));
    }

    #[test]
    fn picker_confirm_and_cancel_buttons_hit_test() {
        let (model, _) = two_destination_picker_model();
        let compositor = ClientCompositor::new(26);

        let anchor = anchor_area(&model, &compositor, 60, 20);
        let inner = crate::ui::new_workspace_picker_inner_rect(anchor, 2).expect("modal fits");
        let (confirm, cancel) = crate::ui::new_workspace_picker_button_rects(inner);

        assert_eq!(
            compositor.hit_test(&model, confirm.x, confirm.y, 60, 20),
            Some(SidebarHitTarget::NewWorkspacePickerConfirm)
        );
        assert_eq!(
            compositor.hit_test(&model, cancel.x, cancel.y, 60, 20),
            Some(SidebarHitTarget::NewWorkspacePickerCancel)
        );
    }

    #[test]
    fn client_global_menu_uses_server_launcher_menu_surface() {
        let mut model = ClientSupervisorModel::new("local");
        model.open_client_global_menu(0, 0);

        let compositor = ClientCompositor::new(26);
        let content = frame(8, 3, &["content", "frame"]);
        let composed =
            compositor.compose_frame(&model, &content, 60, 16, std::time::Instant::now());

        let rows: Vec<_> = (0..composed.height)
            .map(|row| row_text(&composed, row))
            .collect();
        assert!(rows.iter().any(|row| row.contains("┌")));
        assert!(rows.iter().any(|row| row.contains("settings")));
        assert!(rows.iter().any(|row| row.contains("keybinds")));
        assert!(rows.iter().any(|row| row.contains("reload config")));
        assert!(rows.iter().any(|row| row.contains("detach")));
        assert!(rows.iter().any(|row| row.contains("add remote")));
        // #47: the launcher keeps its ORIGINAL `global_menu_rect` dropdown surface, so the first item
        // row sits one cell inside the menu's top-left border (rect.y + 1). It resolves to the unified
        // `ClientMenuRow { index }` target.
        assert_eq!(
            compositor.hit_test(&model, 21, 1, 60, 16),
            Some(SidebarHitTarget::ClientMenuRow { index: 0 })
        );
        assert_eq!(
            compositor.hit_test(&model, 21, 5, 60, 16),
            Some(SidebarHitTarget::ClientMenuRow { index: 4 })
        );
    }

    #[test]
    fn client_global_menu_hover_moves_highlight_render() {
        // #47/#56: moving the highlight (as a hover `Moved` does via `set_client_menu_selected`)
        // repaints the highlight bg onto the newly selected row and clears it from the old one.
        // #56: the launcher shell is rendered with NO selection; the highlight is painted per-frame by
        // `apply_hover_overlay` from the model's selection, so a selection move never rebuilds the shell.
        let compositor = ClientCompositor::new(26);
        let content = frame(8, 3, &["content", "frame"]);

        let mut model = ClientSupervisorModel::new("local");
        model.open_client_global_menu(0, 0);
        let now = std::time::Instant::now();
        // One cached hover-less shell; the selection is painted by the overlay each frame (#56).
        let shell = compositor.build_shell(&model, 60, 16, now);
        let compose_with_selection = |selected: usize| {
            let mut frame = overlay_content_onto_shell(&shell, &content);
            apply_hover_overlay(&mut frame, &shell, None, Some(selected));
            frame
        };
        let before = compose_with_selection(0);
        let after = compose_with_selection(2);

        // The launcher renders at its original `global_menu_rect` dropdown, with rows starting one
        // cell inside the top border (rect.y + 1) — no modal header.
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            60,
            16,
            std::time::Instant::now(),
        );
        let rect = snapshot.app.global_menu_rect();
        let row0 = rect.y + 1; // item index 0 ("settings").
        let row1 = rect.y + 2; // item index 1 ("keybinds").
        let row2 = rect.y + 3; // item index 2 ("reload config").

        let bgs = |frame: &FrameData, row: u16| -> Vec<u32> {
            (0..frame.width)
                .map(|x| cell_at(frame, x, row).bg)
                .collect()
        };
        // before: index 0 is highlighted, so its bg differs from the unhighlighted neighbour row 1
        // (same-width label, so an unhighlighted row 0 would match row 1 exactly).
        assert_ne!(
            bgs(&before, row0),
            bgs(&before, row1),
            "row 0 starts highlighted"
        );
        // after moving the highlight to index 2: row 0 reverts to an unhighlighted row (matches the
        // unhighlighted row 1), and row 2 now carries a highlight bg row 1 lacks.
        assert_eq!(
            bgs(&after, row0),
            bgs(&after, row1),
            "row 0 reverts to unhighlighted"
        );
        assert_ne!(
            bgs(&after, row2),
            bgs(&after, row1),
            "row 2 becomes highlighted"
        );
    }

    /// Read the cell at (x, y) of a composited frame.
    fn cell_at(frame: &FrameData, x: u16, y: u16) -> &CellData {
        &frame.cells[(y as usize) * (frame.width as usize) + (x as usize)]
    }

    /// Encode an RGB color the same way `FrameData::from_ratatui_buffer_with_hyperlinks` does, so
    /// the modal tests can match against palette colors.
    fn encode_rgb(r: u8, g: u8, b: u8) -> u32 {
        0x02_00_00_00 | ((r as u32) << 16) | ((g as u32) << 8) | (b as u32)
    }

    /// True iff any cell on `row` carries `bg` (e.g. the focused field's `surface0` fill).
    fn row_has_bg(frame: &FrameData, row: u16, bg: u32) -> bool {
        (0..frame.width).any(|x| cell_at(frame, x, row).bg == bg)
    }

    #[test]
    fn add_remote_modal_renders_accent_border_and_action_buttons() {
        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form();

        let compositor = ClientCompositor::new(26);
        let content = frame(20, 8, &["content", "frame"]);
        let composed =
            compositor.compose_frame(&model, &content, 80, 24, std::time::Instant::now());
        let rows: Vec<_> = (0..composed.height)
            .map(|row| row_text(&composed, row))
            .collect();

        // border::PLAIN square corner (NOT the legacy rounded `╭`).
        assert!(rows.iter().any(|row| row.contains("┌")));
        assert!(!rows.iter().any(|row| row.contains("╭")));
        assert!(rows.iter().any(|row| row.contains("add remote")));
        assert!(rows.iter().any(|row| row.contains("target")));
        assert!(rows.iter().any(|row| row.contains("name")));
        // action buttons.
        assert!(rows.iter().any(|row| row.contains("add")));
        assert!(rows.iter().any(|row| row.contains("cancel")));
        // legacy ASCII art / raw markers / the old footer literal are ABSENT.
        assert!(!rows.iter().any(|row| row.contains("+---")));
        assert!(!rows.iter().any(|row| row.contains("enter add   esc close")));
    }

    #[test]
    fn modal_survives_full_screen_content_overwrite() {
        // Regression: a composited overlay must stay visible even when the server content frame
        // fills the ENTIRE content area (a real pane full of text). The content copy protects
        // EXACTLY the open popup's rect, so the overlay survives AND the rest of the content stays
        // visible around it (the popup is footer-anchored, NOT a full-screen-dimmed centered modal).
        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form();
        // content frame that fills the whole content area with a sentinel (like a busy pane).
        let filled = "#".repeat(54);
        let rows: Vec<&str> = vec![filled.as_str(); 24];
        let content = frame(54, 24, &rows);

        let compositor = ClientCompositor::new(26);
        let composed =
            compositor.compose_frame(&model, &content, 80, 24, std::time::Instant::now());
        let texts: Vec<String> = (0..composed.height)
            .map(|r| row_text(&composed, r))
            .collect();

        // the overlay (header, a field label, the cancel button) must survive — these sit in the
        // content columns and would be overwritten by the '#' fill without the popup-rect exclusion.
        assert!(
            texts.iter().any(|t| t.contains("add remote")),
            "overlay header overwritten by content; rows={texts:?}"
        );
        assert!(
            texts.iter().any(|t| t.contains("target")),
            "overlay field overwritten by content"
        );
        assert!(
            texts.iter().any(|t| t.contains("cancel")),
            "overlay action button overwritten by content"
        );

        // ...AND the content sentinel must STILL be visible somewhere in the content area OUTSIDE
        // the popup rect — proving the fix protects only the popup, not the whole screen (the old
        // bug blanked everything).
        let popup =
            crate::ui::add_remote_popup_rect(compositor.overlay_anchor_area(&model, 80, 24))
                .expect("popup fits");
        let sidebar_width = 26u16;
        let sentinel_outside_popup = (0..composed.height).any(|row| {
            (sidebar_width..composed.width).any(|col| {
                let inside_popup = col >= popup.x
                    && col < popup.x + popup.width
                    && row >= popup.y
                    && row < popup.y + popup.height;
                !inside_popup && cell_at(&composed, col, row).symbol == "#"
            })
        });
        assert!(
            sentinel_outside_popup,
            "content '#' fully blanked; only the popup rect should be protected; rows={texts:?}"
        );
    }

    #[test]
    fn add_remote_modal_marks_focused_field() {
        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form(); // focus defaults to Target.

        let compositor = ClientCompositor::new(26);
        let content = frame(20, 8, &["content", "frame"]);
        let composed =
            compositor.compose_frame(&model, &content, 80, 24, std::time::Instant::now());

        // inner rect for the footer-anchored overlay: rows[1] (target) and rows[2] (name).
        let inner = crate::ui::add_remote_inner_rect(anchor_area(&model, &compositor, 80, 24))
            .expect("modal fits");
        let target_row = inner.y.saturating_add(1);
        let name_row = inner.y.saturating_add(2);

        // catppuccin surface0 = Rgb(49, 50, 68); the focused target field carries that fill.
        let surface0 = encode_rgb(49, 50, 68);
        assert!(row_has_bg(&composed, target_row, surface0));
        // the target label cells now carry non-zero fg (regression vs. the old colorless draw).
        assert!((0..composed.width).any(|x| cell_at(&composed, x, target_row).fg != 0));
        // the unfocused name row does NOT carry the focused `surface0` bg (it has panel_bg).
        assert!(!row_has_bg(&composed, name_row, surface0));
    }

    #[test]
    fn add_remote_modal_shows_inline_error() {
        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form();
        // Enter with an empty target produces the `target required` inline error.
        model.handle_add_remote_key(crate::input::TerminalKey::new(
            crossterm::event::KeyCode::Enter,
            crossterm::event::KeyModifiers::empty(),
        ));

        let compositor = ClientCompositor::new(26);
        let content = frame(20, 8, &["content", "frame"]);
        let composed =
            compositor.compose_frame(&model, &content, 80, 24, std::time::Instant::now());
        let rows: Vec<_> = (0..composed.height)
            .map(|row| row_text(&composed, row))
            .collect();
        assert!(rows.iter().any(|row| row.contains("target required")));

        // an async-style error string renders too.
        model.set_add_remote_error("adding remote...");
        let composed =
            compositor.compose_frame(&model, &content, 80, 24, std::time::Instant::now());
        let rows: Vec<_> = (0..composed.height)
            .map(|row| row_text(&composed, row))
            .collect();
        assert!(rows.iter().any(|row| row.contains("adding remote...")));
    }

    #[test]
    fn add_remote_modal_keeps_cursor_hidden() {
        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form();

        let compositor = ClientCompositor::new(26);
        let content = frame(20, 8, &["content", "frame"]);
        let composed =
            compositor.compose_frame(&model, &content, 80, 24, std::time::Instant::now());

        assert!(composed.cursor.is_none());
    }

    #[test]
    fn add_remote_button_click_submits_and_cancel_closes() {
        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form();
        let compositor = ClientCompositor::new(26);

        let inner = crate::ui::add_remote_inner_rect(anchor_area(&model, &compositor, 80, 24))
            .expect("modal fits");
        let (submit, cancel) = crate::ui::add_remote_button_rects(inner);

        assert_eq!(
            compositor.hit_test(&model, submit.x, submit.y, 80, 24),
            Some(SidebarHitTarget::AddRemoteSubmit)
        );
        assert_eq!(
            compositor.hit_test(&model, cancel.x, cancel.y, 80, 24),
            Some(SidebarHitTarget::AddRemoteCancel)
        );
    }

    // --- item 5: client agent animation --------------------------------------------------

    /// Build a mixed model with one main workspace and one remote workspace whose single agent
    /// has `agent_status` (e.g. "working" / "idle"). Both servers connect by default.
    fn model_with_agent_status(agent_status: &str) -> (ClientSupervisorModel, ServerId) {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "main-herdr".into(),
                        label: "herdr".into(),
                        branch: Some("master".into()),
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
                        workspace_id: "remote-api".into(),
                        label: "api".into(),
                        branch: Some("feature/api".into()),
                        focused: false,
                        ..Default::default()
                    }],
                    agents: vec![AgentSummary {
                        agent_id: "remote-agent".into(),
                        workspace_id: "remote-api".into(),
                        label: "claude".into(),
                        status: agent_status.into(),
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
    fn animation_tick_feeds_spinner_tick() {
        let (model, _) = model_with_agent_status("working");
        let mut compositor = ClientCompositor::new(26);
        compositor.advance_animation_tick(8);

        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            60,
            16,
            std::time::Instant::now(),
        );

        assert_eq!(snapshot.app.spinner_tick, 8);
    }

    #[test]
    fn spinner_cell_differs_between_tick_0_and_8() {
        let (model, _) = model_with_agent_status("working");
        let content = frame(8, 3, &["content", "frame"]);

        let at_zero = ClientCompositor::new(26);
        let frame_zero = at_zero.compose_frame(&model, &content, 60, 16, std::time::Instant::now());

        let mut at_eight = ClientCompositor::new(26);
        at_eight.advance_animation_tick(8);
        let frame_eight =
            at_eight.compose_frame(&model, &content, 60, 16, std::time::Instant::now());

        let symbols_zero: Vec<_> = frame_zero.cells.iter().map(|c| c.symbol.clone()).collect();
        let symbols_eight: Vec<_> = frame_eight.cells.iter().map(|c| c.symbol.clone()).collect();
        assert_ne!(
            symbols_zero, symbols_eight,
            "spinner_frame should advance the agent-status cell between tick 0 and tick 8"
        );
        // The spinner glyph at tick 0 is SPINNERS[0] = ⠋, at tick 8 it is SPINNERS[1] = ⠙.
        assert!(symbols_zero.iter().any(|s| s == "⠋"));
        assert!(symbols_eight.iter().any(|s| s == "⠙"));
    }

    #[test]
    fn advance_animation_tick_wraps_and_steps() {
        let mut compositor = ClientCompositor::new(26);
        assert_eq!(compositor.animation_tick(), 0);
        compositor.advance_animation_tick(8);
        assert_eq!(compositor.animation_tick(), 8);
        compositor.advance_animation_tick(8);
        assert_eq!(compositor.animation_tick(), 16);

        // Wrap cleanly at the u32 boundary with no discontinuity in the visible step `tick/8`.
        let mut wrapping = ClientCompositor::new(26);
        wrapping.advance_animation_tick(u32::MAX - 3);
        let before = wrapping.animation_tick();
        wrapping.advance_animation_tick(8);
        let after = wrapping.animation_tick();
        assert_eq!(after, before.wrapping_add(8));
        assert!(after < before, "tick should wrap past the u32 boundary");
    }

    #[test]
    fn sidebar_wants_animation_true_with_working_agent() {
        let (model, _) = model_with_agent_status("working");
        assert!(sidebar_wants_animation(&model));
    }

    /// Force the host-banner animation off so a test can isolate the agent-driven animation
    /// gate (item 2 (C3): a visible Secondary now animates its banner by default).
    fn with_static_host_banner(model: &mut ClientSupervisorModel) {
        let mut ui_settings = model.ui_settings().clone();
        ui_settings.sidebar_host.animation = crate::config::HostBannerAnimation::Static;
        model.set_ui_settings(ui_settings);
    }

    #[test]
    fn sidebar_wants_animation_false_when_all_idle() {
        // With the banner animation forced Static, only the agent gate remains — idle agents
        // never request animation.
        for status in ["idle", "done", "blocked", "unknown"] {
            let (mut model, _) = model_with_agent_status(status);
            with_static_host_banner(&mut model);
            assert!(
                !sidebar_wants_animation(&model),
                "status {status:?} should not request animation"
            );
        }
    }

    #[test]
    fn sidebar_wants_animation_true_with_banner() {
        // item 2 (C3): the banner hook is now the real gate. With no working agent the gate is
        // driven solely by `host_banner_animation_active` — a visible Secondary with the default
        // Animated setting makes the gate true (proving the banner hook is the single
        // banner-active input the gate reads).
        let (model, _) = model_with_agent_status("idle");
        assert!(model.host_banner_animation_active());
        assert!(sidebar_wants_animation(&model));
        assert_eq!(
            sidebar_wants_animation(&model),
            model.host_banner_animation_active(),
            "with no working agent the gate equals the banner hook"
        );
    }

    #[test]
    fn working_agent_seeds_working_since_from_map() {
        let (model, remote_id) = model_with_agent_status("working");
        let t0 = std::time::Instant::now();
        let mut compositor = ClientCompositor::new(26);
        compositor.seed_working_since((remote_id.clone(), "remote-agent".to_string()), t0);

        let snapshot = ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, t0);

        // Exactly one terminal (the working remote agent) was built.
        let terminal = snapshot
            .app
            .terminals
            .values()
            .find(|t| t.working_duration_at(t0).is_some())
            .expect("working agent terminal should expose a live duration");

        let at_2s = terminal
            .working_duration_at(t0 + Duration::from_secs(2))
            .expect("working duration should be live");
        let at_3s = terminal
            .working_duration_at(t0 + Duration::from_secs(3))
            .expect("working duration should be live");
        assert!(at_2s.is_live);
        assert_eq!(at_2s.elapsed.as_secs(), 2);
        assert_eq!(at_3s.elapsed.as_secs(), 3);
    }

    #[test]
    fn disabled_remote_agent_rows_do_not_gate_animation() {
        // A disabled remote's placeholder rows are not `working`, so they never request
        // animation on themselves (parity with the render==hit_test disabled-row rejection).
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        model
            .set_connection_state(
                &remote_id,
                crate::client::supervisor::ConnectionState::Disconnected,
            )
            .unwrap();
        // Force the banner animation Static to isolate the agent gate: a disconnected remote's
        // placeholder rows are not `working`, so they never request animation on themselves.
        with_static_host_banner(&mut model);
        assert!(!sidebar_wants_animation(&model));
    }

    // ----- item 3 (Area 5): remote-management overlay render == hit_test --------------------

    fn manage_overlay_model() -> ClientSupervisorModel {
        let mut model = ClientSupervisorModel::new("local");
        model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "r1".into(),
            name: "alpha".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Ssh {
                target: "alpha".into(),
                args: Vec::new(),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "r2".into(),
            name: "beta".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Ssh {
                target: "beta".into(),
                args: Vec::new(),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        model.open_remote_manage_overlay();
        model
    }

    #[test]
    fn remote_manage_render_equals_hit_test_geometry() {
        let model = manage_overlay_model();
        let compositor = ClientCompositor::new(26);
        let anchor = anchor_area(&model, &compositor, 80, 24);

        // the rect the renderer draws row N into is the rect hit_test checks.
        let inner = crate::ui::remote_manage_inner_rect(anchor, 2).expect("modal fits");
        let row0 = crate::ui::remote_manage_row_rect(inner, 0);
        let row1 = crate::ui::remote_manage_row_rect(inner, 1);
        assert_eq!(
            compositor.hit_test(&model, row0.x, row0.y, 80, 24),
            Some(SidebarHitTarget::RemoteManageRow { index: 0 })
        );
        assert_eq!(
            compositor.hit_test(&model, row1.x, row1.y, 80, 24),
            Some(SidebarHitTarget::RemoteManageRow { index: 1 })
        );
    }

    #[test]
    fn hit_test_returns_manage_targets() {
        let model = manage_overlay_model();
        let compositor = ClientCompositor::new(26);
        let anchor = anchor_area(&model, &compositor, 80, 24);
        let inner = crate::ui::remote_manage_inner_rect(anchor, 2).expect("modal fits");

        // row click selects.
        let row0 = crate::ui::remote_manage_row_rect(inner, 0);
        assert_eq!(
            compositor.hit_test(&model, row0.x, row0.y, 80, 24),
            Some(SidebarHitTarget::RemoteManageRow { index: 0 })
        );
        // footer `add` affordance.
        let footer_y = inner.y + inner.height.saturating_sub(1);
        assert_eq!(
            compositor.hit_test(&model, inner.x, footer_y, 80, 24),
            Some(SidebarHitTarget::RemoteManageAdd)
        );
        // click well outside the modal → None.
        assert_eq!(compositor.hit_test(&model, 0, 0, 80, 24), None);
    }

    #[test]
    fn manage_overlay_render_is_pure() {
        let model = manage_overlay_model();
        let compositor = ClientCompositor::new(26);
        let content = frame(8, 3, &["content", "frame"]);

        let a = compositor.compose_frame(&model, &content, 80, 24, std::time::Instant::now());
        let b = compositor.compose_frame(&model, &content, 80, 24, std::time::Instant::now());
        assert_eq!(a.cells, b.cells, "list render must be deterministic");

        // delete-confirm sub-state is also pure. `compose_frame` takes `&model` (shared ref), so
        // non-mutation is structural; determinism across two renders confirms purity.
        let mut model = manage_overlay_model();
        model.begin_remote_manage_delete();
        let c = compositor.compose_frame(&model, &content, 80, 24, std::time::Instant::now());
        let d = compositor.compose_frame(&model, &content, 80, 24, std::time::Instant::now());
        assert_eq!(c.cells, d.cells, "confirm render must be deterministic");
        assert!(model
            .remote_manage_overlay()
            .unwrap()
            .confirm_delete
            .is_some());
    }

    #[test]
    fn confirm_delete_renders_red_panel() {
        let mut model = manage_overlay_model();
        model.begin_remote_manage_delete();
        let compositor = ClientCompositor::new(26);
        let content = frame(8, 3, &["content", "frame"]);
        let composed =
            compositor.compose_frame(&model, &content, 80, 24, std::time::Instant::now());
        let rows: Vec<_> = (0..composed.height)
            .map(|row| row_text(&composed, row))
            .collect();
        assert!(rows.iter().any(|row| row.contains("delete remote?")));
        assert!(rows.iter().any(|row| row.contains("delete")));
        assert!(rows.iter().any(|row| row.contains("cancel")));

        // while confirm is active the list rows are NOT hit-testable; only the popup buttons are.
        let anchor = anchor_area(&model, &compositor, 80, 24);
        let inner = crate::ui::remote_manage_inner_rect(anchor, 2).expect("modal fits");
        let row0 = crate::ui::remote_manage_row_rect(inner, 0);
        assert!(!matches!(
            compositor.hit_test(&model, row0.x, row0.y, 80, 24),
            Some(SidebarHitTarget::RemoteManageRow { .. })
        ));
        let popup = crate::ui::remote_manage_confirm_popup_rect(anchor).expect("popup fits");
        let pinner = Rect::new(
            popup.x + 1,
            popup.y + 1,
            popup.width.saturating_sub(2),
            popup.height.saturating_sub(2),
        );
        let (delete_rect, cancel_rect) = crate::ui::remote_manage_confirm_button_rects(pinner);
        assert_eq!(
            compositor.hit_test(&model, delete_rect.x, delete_rect.y, 80, 24),
            Some(SidebarHitTarget::RemoteManageConfirmDelete)
        );
        assert_eq!(
            compositor.hit_test(&model, cancel_rect.x, cancel_rect.y, 80, 24),
            Some(SidebarHitTarget::RemoteManageCancelDelete)
        );
    }

    #[test]
    fn manage_overlay_hit_test_skips_non_modal() {
        // A model with a focused main workspace AND the overlay open: a click on the (sidebar)
        // workspace row resolves to a manage target or None, NEVER a Workspace hit — the overlay
        // intercepts the whole host rect first.
        let mut model = manage_overlay_model();
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
        let compositor = ClientCompositor::new(26);
        // sweep a column of the sidebar; none may resolve to a Workspace.
        for y in 0..24u16 {
            let hit = compositor.hit_test(&model, 1, y, 80, 24);
            assert!(
                !matches!(hit, Some(SidebarHitTarget::Workspace { .. })),
                "overlay must intercept sidebar workspace hits, got {hit:?} at y={y}"
            );
        }
    }

    // ---- item 7 (Area 4): hover_test / set_hover / from_model mirror ----

    use crate::app::state::SidebarHoverTarget;

    #[test]
    fn set_hover_reports_change() {
        let mut compositor = ClientCompositor::new(26);
        assert!(compositor.set_hover(Some(SidebarHoverTarget::Workspace { ws_idx: 0 })));
        assert!(!compositor.set_hover(Some(SidebarHoverTarget::Workspace { ws_idx: 0 })));
        assert!(compositor.set_hover(Some(SidebarHoverTarget::Workspace { ws_idx: 1 })));
        assert!(compositor.set_hover(None));
        assert!(!compositor.set_hover(None));
    }

    #[test]
    fn from_model_mirrors_compositor_hover() {
        // A hover set on the compositor truth appears in the render snapshot (Copy; pure read).
        let (model, _remote_id) = mixed_supervisor_model();
        let mut compositor = ClientCompositor::new(26);
        compositor.set_hover(Some(SidebarHoverTarget::Workspace { ws_idx: 1 }));
        let snapshot =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 16, Instant::now());
        assert_eq!(
            snapshot.app.sidebar_hover,
            Some(SidebarHoverTarget::Workspace { ws_idx: 1 })
        );
    }

    #[test]
    fn hover_test_resolves_workspace_row() {
        // render == hit_test geometry: drive the row index off `hit_test` (like the click test),
        // then assert `hover_test` over the same (x,y) resolves the matching Workspace ws_idx.
        let (model, remote_id) = mixed_supervisor_model();
        let compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let remote_card = snapshot
            .app
            .view
            .workspace_card_areas
            .iter()
            .find(|c| c.ws_idx == 1)
            .expect("remote card");
        // sanity: the click path resolves the remote workspace at this row.
        assert_eq!(
            compositor.hit_test(&model, 1, remote_card.rect.y, host.0, host.1),
            Some(SidebarHitTarget::Workspace {
                server_id: remote_id.clone(),
                workspace_id: "remote-api".into(),
            })
        );
        assert_eq!(
            compositor.hover_test(&model, 1, remote_card.rect.y, host.0, host.1),
            Some(SidebarHoverTarget::Workspace { ws_idx: 1 })
        );
    }

    #[test]
    fn hover_test_skips_non_selectable_rows() {
        // the ` spaces`/` agents` header rows, the `─` separator, the right-edge resize column,
        // and the item-4 divider row never resolve to a Workspace/Agent hover target.
        let (model, _remote_id) = mixed_supervisor_model();
        let compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );

        // ` spaces` header is the sidebar's first row.
        let header_y = snapshot.app.view.sidebar_rect.y;
        let hover = compositor.hover_test(&model, 1, header_y, host.0, host.1);
        assert!(!matches!(
            hover,
            Some(SidebarHoverTarget::Workspace { .. })
                | Some(SidebarHoverTarget::AgentRoute { .. })
        ));

        // the right-edge resize column (x == sidebar_width - 1 .. is the divider `│`): a position
        // at x >= effective_sidebar_width resolves None.
        assert_eq!(
            compositor.hover_test(&model, 27, header_y, host.0, host.1),
            None
        );

        // the item-4 divider row resolves to the defensive Divider (NEVER a Workspace/Agent) —
        // render treats Divider as no-highlight.
        let divider_y = snapshot.app.view.divider_rows[0];
        assert_eq!(
            compositor.hover_test(&model, 1, divider_y, host.0, host.1),
            Some(SidebarHoverTarget::Divider)
        );
    }

    #[test]
    fn hover_test_ignores_disabled_workspace_rows() {
        // mirror hit_test_ignores_disabled_workspace_rows: a disabled remote route hovers None.
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
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
        model
            .set_connection_state(
                &remote_id,
                crate::client::supervisor::ConnectionState::Disconnected,
            )
            .unwrap();
        let compositor = ClientCompositor::new(26);
        // sweep the sidebar column: no row resolves to a Workspace hover (disabled rows rejected).
        for y in 0..16u16 {
            assert!(!matches!(
                compositor.hover_test(&model, 1, y, 60, 16),
                Some(SidebarHoverTarget::Workspace { .. })
            ));
        }
    }

    #[test]
    fn hover_test_agent_resolves_route_index_and_survives_recompose() {
        // contradiction-11 regression: hover over an agent entry returns AgentRoute { route_idx };
        // rebuilding the snapshot (recompose) keeps the SAME route_idx mapping to the same agent
        // even though the placeholder pane_id is freshly alloc'd each recompose.
        let (model, _remote_id) = mixed_supervisor_model_with_agent();
        let compositor = ClientCompositor::new(26);
        let host = (60u16, 20u16);

        // find the agent row by sweeping (the click path resolves the agent there).
        let agent_row = (0..host.1)
            .find(|y| {
                matches!(
                    compositor.hit_test(&model, 1, *y, host.0, host.1),
                    Some(SidebarHitTarget::Agent { agent_id, .. }) if agent_id == "remote-agent"
                )
            })
            .expect("agent row should be hit-testable");

        let hover = compositor.hover_test(&model, 1, agent_row, host.0, host.1);
        let route_idx = match hover {
            Some(SidebarHoverTarget::AgentRoute { route_idx }) => route_idx,
            other => panic!("expected AgentRoute, got {other:?}"),
        };

        // recompose: the snapshot's agent_routes are rebuilt; the same route_idx still points at
        // the same agent (positional index, not the dead pane_id).
        let snap_a = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let snap_b = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        assert_eq!(
            snap_a.agent_routes[route_idx].agent_id,
            snap_b.agent_routes[route_idx].agent_id
        );
        assert_eq!(snap_a.agent_routes[route_idx].agent_id, "remote-agent");
        // hover_test resolves the SAME route_idx after recompose.
        assert_eq!(
            compositor.hover_test(&model, 1, agent_row, host.0, host.1),
            Some(SidebarHoverTarget::AgentRoute { route_idx })
        );
    }

    #[test]
    fn hover_test_affordances_respect_draw_gate() {
        // over `new`/`menu`/`filter` the hover resolves to the matching affordance. The client
        // snapshot is always `mouse_capture == true` (empty_for_client_rendering), so the
        // affordances are drawn and hoverable (the gate-off branch is exercised monolithically,
        // where mouse_capture can be false — see the input/mouse tests).
        let (model, _remote_id) = mixed_supervisor_model();
        let compositor = ClientCompositor::new(26);
        let host = (60u16, 16u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );

        let new_rect = snapshot.app.sidebar_new_button_rect();
        let menu_rect = snapshot.app.global_launcher_rect();
        // empty_for_client_rendering defaults mouse_capture = true, so affordances are drawn.
        assert!(snapshot.app.mouse_capture);
        assert_eq!(
            compositor.hover_test(&model, new_rect.x, new_rect.y, host.0, host.1),
            Some(SidebarHoverTarget::New)
        );
        assert_eq!(
            compositor.hover_test(
                &model,
                menu_rect.x + menu_rect.width - 1,
                menu_rect.y,
                host.0,
                host.1
            ),
            Some(SidebarHoverTarget::Menu)
        );
        // the filter label (top-right of the sidebar).
        assert_eq!(
            compositor.hover_test(&model, 23, snapshot.app.view.sidebar_rect.y, host.0, host.1),
            Some(SidebarHoverTarget::Filter)
        );
    }

    #[test]
    fn hover_test_suppressed_when_overlay_open() {
        // with the add-remote form open OR the client global menu highlighted, sidebar hover_test
        // returns None (the overlay owns its own hover; the global menu moves its highlight via the
        // separate `client_global_menu_item_at` path in the client `Moved` arm).
        let (mut model, _remote_id) = mixed_supervisor_model();
        model.open_add_remote_form();
        for y in 0..16u16 {
            assert_eq!(model_hover_anywhere(&model, y), None);
        }
        model.close_client_overlay();

        let (mut model, _remote_id) = mixed_supervisor_model();
        model.open_client_global_menu(0, 0);
        for y in 0..16u16 {
            assert_eq!(model_hover_anywhere(&model, y), None);
        }
    }

    #[test]
    fn client_menu_hit_test_resolves_hovered_row() {
        // #47: motion/click over the open LAUNCHER resolves to the row index under the cursor against
        // its original `global_menu_rect` dropdown geometry (the SAME the renderer uses) → the unified
        // `ClientMenuRow` target; a position off the popup resolves to None (the menu is modal).
        let (mut model, _remote_id) = mixed_supervisor_model();
        let compositor = ClientCompositor::new(26);
        let host = (60u16, 16u16);

        model.open_client_global_menu(0, 0);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let rect = snapshot.app.global_menu_rect();
        // the first item row sits one cell inside the menu's top-left border.
        assert_eq!(
            compositor.hit_test(&model, rect.x + 1, rect.y + 1, host.0, host.1),
            Some(SidebarHitTarget::ClientMenuRow { index: 0 })
        );
        // a deeper row resolves to its index.
        assert_eq!(
            compositor.hit_test(&model, rect.x + 1, rect.y + 3, host.0, host.1),
            Some(SidebarHitTarget::ClientMenuRow { index: 2 })
        );
        // the far-left sidebar column misses the menu → None (modal owns the whole rect).
        assert_eq!(
            compositor.hit_test(&model, 0, rect.y + 1, host.0, host.1),
            None
        );
    }

    #[test]
    fn dragging_menu_top_border_repositions_the_popup() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
        let (mut model, remote_id) = mixed_supervisor_model();
        let mut compositor = ClientCompositor::new(26);
        // C3 grew the host menu by one row (the session readout), so the host needs one more row of
        // headroom for the +2 drag below to land unclamped — the assertion here is that a drag moves
        // the popup by EXACTLY the delta, not that it hits the bottom clamp.
        let host = (60u16, 17u16);
        // a cursor-anchored host context menu, anchored well inside the screen so it can move freely.
        model.open_host_context_menu(remote_id, "x".into(), 10, 4);

        let before = compositor
            .open_overlay_popup_rect(&model, host.0, host.1)
            .expect("popup fits");
        let ev = |kind, col, row| MouseEvent {
            kind,
            column: col,
            row,
            modifiers: KeyModifiers::empty(),
        };

        // a press on the popup's TOP BORDER row starts a drag (no offset change yet).
        assert_eq!(
            compositor.handle_overlay_drag(
                &mut model,
                &ev(
                    MouseEventKind::Down(MouseButton::Left),
                    before.x + 2,
                    before.y
                ),
                host.0,
                host.1,
            ),
            Some(false)
        );
        // dragging +3 cols / +2 rows moves the popup by exactly that, and the offset accumulates.
        assert_eq!(
            compositor.handle_overlay_drag(
                &mut model,
                &ev(
                    MouseEventKind::Drag(MouseButton::Left),
                    before.x + 2 + 3,
                    before.y + 2,
                ),
                host.0,
                host.1,
            ),
            Some(true)
        );
        assert_eq!(model.overlay_drag_offset(), (3, 2));
        let after = compositor
            .open_overlay_popup_rect(&model, host.0, host.1)
            .expect("popup fits");
        assert_eq!((after.x, after.y), (before.x + 3, before.y + 2));
        // render == hit-test after the drag: a row now hit-tests at the SHIFTED position.
        let inner_y = after.y + 1; // header row
        assert!(matches!(
            compositor.hit_test(&model, after.x + 2, inner_y + 2, host.0, host.1),
            Some(SidebarHitTarget::ClientMenuRow { .. })
        ));
        // releasing ends the drag.
        assert_eq!(
            compositor.handle_overlay_drag(
                &mut model,
                &ev(
                    MouseEventKind::Up(MouseButton::Left),
                    after.x + 5,
                    after.y + 2
                ),
                host.0,
                host.1,
            ),
            Some(false)
        );
        // a press that is NOT on the top border returns None, so row-select / dismiss still run.
        assert_eq!(
            compositor.handle_overlay_drag(
                &mut model,
                &ev(
                    MouseEventKind::Down(MouseButton::Left),
                    after.x + 2,
                    after.y + 3,
                ),
                host.0,
                host.1,
            ),
            None
        );
    }

    #[test]
    fn dragging_a_footer_form_overlay_repositions_it() {
        // #47: the SAME top-border drag works for the footer FORM overlays, not just the menus — here
        // the add-remote form moves and its submit button hit-tests at the shifted position.
        use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
        let mut model = ClientSupervisorModel::new("local");
        model.open_add_remote_form();
        let mut compositor = ClientCompositor::new(26);
        let host = (80u16, 24u16);

        let before = compositor
            .open_overlay_popup_rect(&model, host.0, host.1)
            .expect("popup fits");
        let ev = |kind, col, row| MouseEvent {
            kind,
            column: col,
            row,
            modifiers: KeyModifiers::empty(),
        };
        // press the top border, then drag -4 cols / -3 rows (up-left).
        assert_eq!(
            compositor.handle_overlay_drag(
                &mut model,
                &ev(
                    MouseEventKind::Down(MouseButton::Left),
                    before.x + 2,
                    before.y
                ),
                host.0,
                host.1,
            ),
            Some(false)
        );
        assert_eq!(
            compositor.handle_overlay_drag(
                &mut model,
                &ev(
                    MouseEventKind::Drag(MouseButton::Left),
                    before.x.saturating_sub(2),
                    before.y.saturating_sub(3),
                ),
                host.0,
                host.1,
            ),
            Some(true)
        );
        let after = compositor
            .open_overlay_popup_rect(&model, host.0, host.1)
            .expect("popup fits");
        // the popup moved up-left (clamped to the screen).
        assert!(after.x < before.x || after.y < before.y, "popup moved");
        // a button inside the dragged form still hit-tests (render == hit-test after the drag).
        let inner = popup_inner(after);
        let (submit, cancel) = crate::ui::add_remote_button_rects(inner);
        assert_eq!(
            compositor.hit_test(&model, submit.x, submit.y, host.0, host.1),
            Some(SidebarHitTarget::AddRemoteSubmit)
        );
        assert_eq!(
            compositor.hit_test(&model, cancel.x, cancel.y, host.0, host.1),
            Some(SidebarHitTarget::AddRemoteCancel)
        );
    }

    #[test]
    fn snapshot_caches_open_overlay_popup_and_is_selection_independent() {
        let mut model = ClientSupervisorModel::new("local");
        model.open_host_context_menu(ServerId::main(), "local".into(), 10, 4);
        let compositor = ClientCompositor::new(26);
        let now = std::time::Instant::now();

        let snap0 = ClientSidebarSnapshot::from_model(&model, &compositor, 26, 80, 24, now);
        // the cached rect equals the (old) on-demand computation.
        assert_eq!(
            snap0.overlay_popup,
            open_overlay_popup_rect(&snap0, 80, 24),
            "#53: cached overlay_popup must equal the on-demand popup rect"
        );
        assert!(
            snap0.overlay_popup.is_some(),
            "an open menu must cache a popup"
        );

        // a menu-SELECTION change must NOT move the popup (it is selection-independent, so caching it
        // on the hover-less #56 snapshot is safe across HoverRedraws).
        model.set_client_menu_selected(2);
        let snap1 = ClientSidebarSnapshot::from_model(&model, &compositor, 26, 80, 24, now);
        assert_eq!(
            snap0.overlay_popup, snap1.overlay_popup,
            "selection must not move the popup"
        );
    }

    fn model_hover_anywhere(model: &ClientSupervisorModel, y: u16) -> Option<SidebarHoverTarget> {
        ClientCompositor::new(26).hover_test(model, 1, y, 60, 16)
    }

    #[test]
    fn hover_test_none_when_collapsed() {
        // effective_sidebar_width == 0 (host_width <= 1) → None.
        let (model, _remote_id) = mixed_supervisor_model();
        let compositor = ClientCompositor::new(26);
        assert_eq!(compositor.hover_test(&model, 0, 0, 1, 16), None);
    }

    #[test]
    fn hover_test_resolves_new_workspace_picker_destination_row() {
        // the footer-anchored picker popup hovers its destination rows to
        // NewWorkspaceDestination { row }.
        let (model, _remote_id) = two_destination_picker_model();
        let compositor = ClientCompositor::new(26);
        let host = (60u16, 20u16);
        let anchor = anchor_area(&model, &compositor, host.0, host.1);
        let inner = crate::ui::new_workspace_picker_inner_rect(anchor, 2).expect("modal fits");
        let row1 = crate::ui::new_workspace_picker_row_rect(inner, 1);
        assert_eq!(
            compositor.hover_test(&model, row1.x, row1.y, host.0, host.1),
            Some(SidebarHoverTarget::NewWorkspaceDestination { row: 1 })
        );
    }

    // a [Main, Secondary] model with a remote agent, for agent-hover tests.
    fn mixed_supervisor_model_with_agent() -> (ClientSupervisorModel, ServerId) {
        let mut model = ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-x".into(),
            name: "x".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("x".into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
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
        (model, remote_id)
    }

    // ---- #25: collapsed sidebar (client compositor) ----

    // #58: a renamed pane's manual_label must travel summary -> agent_groups -> from_model and surface
    // as the sidebar "pane name" (`PaneDetail.pane_label`). Before this plumbing the multi-remote
    // summary dropped it, so the client rendered no pane name even for renamed panes.
    #[test]
    fn from_model_carries_pane_manual_label_to_sidebar() {
        let mut model = ClientSupervisorModel::new("local");
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "ws-1".into(),
                        label: "proj".into(),
                        branch: None,
                        focused: true,
                        ..Default::default()
                    }],
                    agents: vec![AgentSummary {
                        agent_id: "term-1".into(),
                        workspace_id: "ws-1".into(),
                        label: "claude".into(),
                        status: "idle".into(),
                        focused: true,
                        pane_label: Some("backend".into()),
                        tab_id: String::new(),
                        tab_label: None,
                    }],
                },
            )
            .unwrap();
        let compositor = ClientCompositor::new(26);
        let snap =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 28, Instant::now());
        let labels: Vec<_> = snap
            .app
            .workspaces
            .iter()
            .flat_map(|ws| ws.pane_details(&snap.app.terminals))
            .map(|detail| detail.pane_label)
            .collect();
        assert!(
            labels
                .iter()
                .any(|label| label.as_deref() == Some("backend")),
            "renamed pane's manual_label must surface as the sidebar pane name; got {labels:?}"
        );
    }

    // #58: agents in distinct tabs (by wire tab_id) must be grouped into separate client tabs carrying
    // their names, so the sidebar renders tab names (`pane_details` shows tab_label only when >1 tab).
    #[test]
    fn from_model_groups_agents_into_named_tabs() {
        let mut model = ClientSupervisorModel::new("local");
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![WorkspaceSummary {
                        workspace_id: "ws-1".into(),
                        label: "proj".into(),
                        branch: None,
                        focused: true,
                        ..Default::default()
                    }],
                    agents: vec![
                        AgentSummary {
                            agent_id: "a1".into(),
                            workspace_id: "ws-1".into(),
                            label: "claude".into(),
                            status: "idle".into(),
                            focused: true,
                            pane_label: None,
                            tab_id: "t1".into(),
                            tab_label: Some("edit".into()),
                        },
                        AgentSummary {
                            agent_id: "a2".into(),
                            workspace_id: "ws-1".into(),
                            label: "codex".into(),
                            status: "idle".into(),
                            focused: false,
                            pane_label: None,
                            tab_id: "t2".into(),
                            tab_label: Some("logs".into()),
                        },
                    ],
                },
            )
            .unwrap();
        let compositor = ClientCompositor::new(26);
        let snap =
            ClientSidebarSnapshot::from_model(&model, &compositor, 26, 60, 28, Instant::now());
        let ws = snap
            .app
            .workspaces
            .iter()
            .find(|ws| ws.tabs.len() == 2)
            .expect("two distinct tab_ids must build two tabs");
        let tab_names: Vec<_> = ws.tabs.iter().map(|tab| tab.display_name()).collect();
        assert!(
            tab_names.contains(&"edit".to_string()) && tab_names.contains(&"logs".to_string()),
            "each tab keeps its display name; got {tab_names:?}"
        );
        let tab_labels: Vec<_> = ws
            .pane_details(&snap.app.terminals)
            .into_iter()
            .map(|detail| detail.tab_label)
            .collect();
        assert!(
            tab_labels.contains(&"edit".to_string()) && tab_labels.contains(&"logs".to_string()),
            "pane_details must surface each pane's tab name; got {tab_labels:?}"
        );
    }

    // A single-server model whose focused workspace owns an agent, so the collapsed detail section
    // (which shows the SELECTED workspace's panes) is non-empty. Returns the agent id for assertions.
    fn collapsed_model() -> (ClientSupervisorModel, ServerId, String) {
        let mut model = ClientSupervisorModel::new("local");
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![
                        WorkspaceSummary {
                            workspace_id: "main-herdr".into(),
                            label: "herdr".into(),
                            branch: None,
                            focused: true,
                            ..Default::default()
                        },
                        WorkspaceSummary {
                            workspace_id: "ws-2".into(),
                            label: "two".into(),
                            branch: None,
                            focused: false,
                            ..Default::default()
                        },
                    ],
                    agents: vec![AgentSummary {
                        agent_id: "agent-1".into(),
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
        (model, ServerId::main(), "agent-1".into())
    }

    // The compositor's collapsed flag drives `from_model`'s `app.sidebar_collapsed`, which is what
    // gates the SHARED renderer onto its collapsed layout. Toggling flips it both ways.
    #[test]
    fn collapsed_flag_gates_snapshot() {
        let (model, _local, _agent) = collapsed_model();
        let mut compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snap = |c: &ClientCompositor| {
            ClientSidebarSnapshot::from_model(&model, c, 26, host.0, host.1, Instant::now())
        };

        assert!(!snap(&compositor).app.sidebar_collapsed);
        compositor.toggle_sidebar_collapsed();
        assert!(snap(&compositor).app.sidebar_collapsed);
        compositor.toggle_sidebar_collapsed();
        assert!(!snap(&compositor).app.sidebar_collapsed);
    }

    // #9 item 3: collapsing slides the sidebar width from full toward the mini width over several
    // gated ticks, then settles exactly; expanding slides it back. `effective_sidebar_width` is the
    // ONE value both render and hit-test read, so the slide stays geometry-consistent frame to frame.
    #[test]
    fn sidebar_width_slides_on_collapse_and_settles() {
        let mut compositor = ClientCompositor::new(26);
        let host = 80u16;
        assert_eq!(compositor.effective_sidebar_width(host), 26);
        assert!(!compositor.sidebar_width_animating());

        compositor.toggle_sidebar_collapsed();
        assert!(
            compositor.sidebar_width_animating(),
            "collapse starts a slide"
        );
        let mut prev = compositor.effective_sidebar_width(host);
        let mut steps = 0;
        while compositor.sidebar_width_animating() {
            compositor.step_sidebar_width_animation();
            let w = compositor.effective_sidebar_width(host);
            assert!(
                w <= prev,
                "width must shrink monotonically while collapsing"
            );
            prev = w;
            steps += 1;
            assert!(steps < 20, "animation must terminate");
        }
        assert_eq!(compositor.effective_sidebar_width(host), MINI_SIDEBAR_WIDTH);

        compositor.toggle_sidebar_collapsed();
        assert!(
            compositor.sidebar_width_animating(),
            "expand starts a slide"
        );
        while compositor.sidebar_width_animating() {
            compositor.step_sidebar_width_animation();
        }
        assert_eq!(compositor.effective_sidebar_width(host), 26);
    }

    // The collapse/expand toggle is hittable in EXPANDED mode (so the user can collapse), across the
    // FULL width of the bottom row — #9 widened it from a 1×1 cell to a full-width button.
    #[test]
    fn expanded_toggle_rect_hits_toggle_target() {
        let (model, _local, _agent) = collapsed_model();
        let compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snap = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let rect = crate::ui::collapsed_sidebar_toggle_rect(snap.app.view.sidebar_rect);
        assert!(
            rect.width > 1,
            "expanded toggle is a full-width row, not a 1×1 cell"
        );
        // hittable at the LEFT edge, the RIGHT edge, and the middle of the bottom row.
        for x in [rect.x, rect.x + rect.width - 1, rect.x + rect.width / 2] {
            assert_eq!(
                compositor.hit_test(&model, x, rect.y, host.0, host.1),
                Some(SidebarHitTarget::CollapsedSidebarToggle),
                "toggle must be hittable at column {x}"
            );
        }
    }

    // In COLLAPSED mode the toggle rect still hit-tests to the toggle; clicking it (mirrored by the
    // mod.rs dispatch flipping the compositor flag) returns to expanded.
    #[test]
    fn collapsed_toggle_rect_hits_and_clicking_expands() {
        let (model, _local, _agent) = collapsed_model();
        let mut compositor = ClientCompositor::new(26);
        compositor.toggle_sidebar_collapsed();
        let host = (60u16, 28u16);
        let snap = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        assert!(snap.app.sidebar_collapsed);

        let rect = crate::ui::collapsed_sidebar_toggle_rect(snap.app.view.sidebar_rect);
        assert_eq!(
            compositor.hit_test(&model, rect.x, rect.y, host.0, host.1),
            Some(SidebarHitTarget::CollapsedSidebarToggle)
        );

        // The mod.rs dispatch flips the compositor flag on this target.
        compositor.toggle_sidebar_collapsed();
        let snap = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        assert!(!snap.app.sidebar_collapsed);
    }

    // #58.3: harden the collapse/expand toggle against the REAL collapsed geometry. The sibling test
    // above forces width 26 (collapse_progress still 0), so it never exercises the mini strip the user
    // actually clicks. Here we let the slide settle to `MINI_SIDEBAR_WIDTH` and assert the bottom-row
    // expand affordance is hittable across its FULL width — i.e. "click the collapsed » (or anywhere on
    // the bottom row)" resolves to the toggle. The bug was triaged against the pre-#25 server-side code;
    // on this branch the client-side toggle (`collapsed_sidebar_toggle_rect` checked before the
    // collapsed sections, render == hit-test) makes it reliably expandable.
    #[test]
    fn collapsed_mini_toggle_row_is_hittable_full_width() {
        let (model, _local, _agent) = collapsed_model();
        let mut compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);

        compositor.toggle_sidebar_collapsed();
        while compositor.sidebar_width_animating() {
            compositor.step_sidebar_width_animation();
        }
        let width = compositor.effective_sidebar_width(host.0);
        assert_eq!(
            width, MINI_SIDEBAR_WIDTH,
            "collapse settles to the mini width"
        );

        let snap = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            width,
            host.0,
            host.1,
            Instant::now(),
        );
        assert!(snap.app.sidebar_collapsed);

        let rect = crate::ui::collapsed_sidebar_toggle_rect(snap.app.view.sidebar_rect);
        assert!(
            rect.width > 0 && rect.y == host.1 - 1,
            "toggle is the bottom row of the mini strip"
        );
        for x in [rect.x, rect.x + rect.width / 2, rect.x + rect.width - 1] {
            assert_eq!(
                compositor.hit_test(&model, x, rect.y, host.0, host.1),
                Some(SidebarHitTarget::CollapsedSidebarToggle),
                "collapsed mini toggle must be hittable at column {x}"
            );
        }
    }

    // In COLLAPSED mode a workspace-glance row resolves to Workspace for the owning server, and that
    // target focuses the right workspace via `focus_workspace_route` (mirrors the expanded path).
    #[test]
    fn collapsed_workspace_row_hits_workspace_target() {
        let (mut model, local, _agent) = collapsed_model();
        let mut compositor = ClientCompositor::new(26);
        compositor.toggle_sidebar_collapsed();
        let host = (60u16, 28u16);
        let snap = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let (ws_area, _, _) = crate::ui::collapsed_sidebar_sections(snap.app.view.sidebar_rect);
        assert!(ws_area.width > 0 && ws_area.height > 0);

        // Second workspace glance row -> workspace index 1 ("ws-2").
        match compositor.hit_test(&model, ws_area.x, ws_area.y + 1, host.0, host.1) {
            Some(SidebarHitTarget::Workspace {
                server_id,
                workspace_id,
            }) => {
                assert_eq!(server_id, local);
                assert_eq!(workspace_id, "ws-2");
                // Same focus round-trip the expanded path uses.
                assert!(model
                    .focus_workspace_route(&server_id, &workspace_id)
                    .api_request("test")
                    .is_some());
            }
            other => panic!("expected Workspace target, got {other:?}"),
        }
    }

    // In COLLAPSED mode an agent-detail row resolves to Agent for the owning server, and that target
    // focuses the agent via `focus_agent_route`.
    #[test]
    fn collapsed_agent_detail_row_hits_agent_target() {
        let (mut model, local, agent) = collapsed_model();
        let mut compositor = ClientCompositor::new(26);
        compositor.toggle_sidebar_collapsed();
        let host = (60u16, 28u16);
        let snap = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let (_, _, detail_area) = crate::ui::collapsed_sidebar_sections(snap.app.view.sidebar_rect);
        assert!(detail_area.width > 0 && detail_area.height > 1);

        // First agent-detail row of the selected (focused, index 0) workspace.
        match compositor.hit_test(&model, detail_area.x, detail_area.y, host.0, host.1) {
            Some(SidebarHitTarget::Agent {
                server_id,
                agent_id,
            }) => {
                assert_eq!(server_id, local);
                assert_eq!(agent_id, agent);
                assert!(model
                    .focus_agent_route(&server_id, &agent_id)
                    .api_request("test")
                    .is_some());
            }
            other => panic!("expected Agent target, got {other:?}"),
        }
    }

    // #22: a worktree GROUP on the local server — a parent (non-linked) plus one linked child that
    // share a worktree key, so the SHARED grouping renderer (`workspace_parent_group_state`) treats
    // it as a collapsible group.
    fn worktree_grouped_model() -> ClientSupervisorModel {
        let mut model = ClientSupervisorModel::new("local");
        model
            .set_summary(
                &ServerId::main(),
                ServerSummary {
                    workspaces: vec![
                        WorkspaceSummary {
                            workspace_id: "parent".into(),
                            label: "herdr".into(),
                            branch: Some("master".into()),
                            focused: true,
                            worktree_key: Some("repo-key".into()),
                            worktree_is_linked: false,
                            git_repo_key: None,
                            git_is_linked: false,
                        },
                        WorkspaceSummary {
                            workspace_id: "child".into(),
                            label: "herdr".into(),
                            branch: Some("feature".into()),
                            focused: false,
                            worktree_key: Some("repo-key".into()),
                            worktree_is_linked: true,
                            git_repo_key: None,
                            git_is_linked: false,
                        },
                    ],
                    agents: Vec::new(),
                },
            )
            .unwrap();
        model
    }

    fn worktree_parent_card(
        snapshot: &ClientSidebarSnapshot,
    ) -> crate::app::state::WorkspaceCardArea {
        snapshot
            .app
            .view
            .workspace_card_areas
            .iter()
            .find(|card| {
                crate::ui::workspace_parent_group_state(&snapshot.app, card.ws_idx).is_some()
            })
            .cloned()
            .expect("a worktree-parent card")
    }

    // #22: a click in the chevron column (column 0) of a worktree-parent row resolves to the chevron
    // (NOT focus); toggling it flips the client-local collapsed set, and the next snapshot renders
    // the group collapsed. Mirrors the server's `clicking_worktree_parent_chevron_toggles_group_only`.
    #[test]
    fn worktree_parent_chevron_hit_test_resolves_and_toggles_group() {
        let model = worktree_grouped_model();
        let mut compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let parent = worktree_parent_card(&snapshot);
        let (group_key, collapsed) =
            crate::ui::workspace_parent_group_state(&snapshot.app, parent.ws_idx).unwrap();
        assert!(!collapsed, "the group starts expanded");

        let chevron_hit = compositor.hit_test(&model, parent.rect.x, parent.rect.y, host.0, host.1);
        assert_eq!(
            chevron_hit,
            Some(SidebarHitTarget::WorktreeChevron {
                group_key: group_key.clone()
            })
        );

        compositor.toggle_collapsed_space_key(group_key.clone());
        assert!(compositor
            .collapsed_space_keys_for_test()
            .contains(&group_key));
        let collapsed_snap = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        assert_eq!(
            crate::ui::workspace_parent_group_state(&collapsed_snap.app, parent.ws_idx)
                .map(|(_, collapsed)| collapsed),
            Some(true),
            "the group renders collapsed after the toggle"
        );
        // A second toggle expands it again (server's remove-if-present contract).
        compositor.toggle_collapsed_space_key(group_key.clone());
        assert!(!compositor
            .collapsed_space_keys_for_test()
            .contains(&group_key));
    }

    // #22: a click on the parent row BODY (past the chevron column) focuses the workspace and never
    // toggles the group. Mirrors `clicking_worktree_parent_row_focuses_workspace_without_toggling`.
    #[test]
    fn worktree_parent_body_click_focuses_without_toggling() {
        let model = worktree_grouped_model();
        let compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        let parent = worktree_parent_card(&snapshot);
        let body_hit =
            compositor.hit_test(&model, parent.rect.x + 2, parent.rect.y, host.0, host.1);
        match body_hit {
            Some(SidebarHitTarget::Workspace {
                server_id,
                workspace_id,
            }) => {
                assert_eq!(server_id, ServerId::main());
                assert_eq!(workspace_id, "parent");
            }
            other => panic!("expected Workspace focus on a body click, got {other:?}"),
        }
    }

    // #22: a standalone (ungrouped) workspace exposes no chevron — a column-0 click focuses it.
    #[test]
    fn standalone_workspace_has_no_chevron_hit() {
        let model = single_server_two_ws_model();
        let compositor = ClientCompositor::new(26);
        let host = (60u16, 28u16);
        let snapshot = ClientSidebarSnapshot::from_model(
            &model,
            &compositor,
            26,
            host.0,
            host.1,
            Instant::now(),
        );
        for card in &snapshot.app.view.workspace_card_areas {
            let hit = compositor.hit_test(&model, card.rect.x, card.rect.y, host.0, host.1);
            assert!(
                !matches!(hit, Some(SidebarHitTarget::WorktreeChevron { .. })),
                "standalone workspace must not expose a chevron hit region"
            );
        }
    }

    // ---- #45: sidebar shell caching (build_shell / overlay_content_onto_shell) ----

    fn server_summary_with_agents(
        prefix: &str,
        workspaces: usize,
        agents_per: usize,
    ) -> ServerSummary {
        let mut ws = Vec::new();
        let mut agents = Vec::new();
        for w in 0..workspaces {
            let workspace_id = format!("{prefix}-ws-{w}");
            ws.push(WorkspaceSummary {
                workspace_id: workspace_id.clone(),
                label: format!("ws{w}"),
                branch: Some(format!("feature/{prefix}-{w}")),
                focused: w == 0,
                ..Default::default()
            });
            for a in 0..agents_per {
                agents.push(AgentSummary {
                    agent_id: format!("{prefix}-agent-{w}-{a}"),
                    workspace_id: workspace_id.clone(),
                    label: if a % 2 == 0 {
                        "claude".into()
                    } else {
                        "codex".into()
                    },
                    status: match a % 3 {
                        0 => "working",
                        1 => "idle",
                        _ => "blocked",
                    }
                    .into(),
                    focused: w == 0 && a == 0,
                    pane_label: None,
                    tab_id: String::new(),
                    tab_label: None,
                });
            }
        }
        ServerSummary {
            workspaces: ws,
            agents,
        }
    }

    fn model_with_agents(workspaces: usize, agents_per: usize) -> ClientSupervisorModel {
        let mut model = ClientSupervisorModel::new("local");
        model
            .set_summary(
                &ServerId::main(),
                server_summary_with_agents("main", workspaces, agents_per),
            )
            .unwrap();
        model
    }

    /// The production hot path is `build_shell` (cached) + `overlay_content_onto_shell` (per
    /// content frame). It MUST be byte-identical to the old single-shot `compose_frame`, otherwise
    /// caching the shell would subtly change what the user sees.
    #[test]
    fn overlay_onto_built_shell_equals_compose_frame() {
        let model = model_with_agents(4, 4);
        let compositor = ClientCompositor::new(28);
        let content = frame(20, 10, &["alpha", "beta", "gamma"]);
        let now = std::time::Instant::now();

        let direct = compositor.compose_frame(&model, &content, 80, 24, now);
        let shell = compositor.build_shell(&model, 80, 24, now);
        let via_shell = overlay_content_onto_shell(&shell, &content);

        assert_eq!(
            direct, via_shell,
            "build_shell + overlay_content_onto_shell must reproduce compose_frame exactly"
        );
    }

    /// #56 (Seam 1): a hover-less shell + the per-frame hover overlay must be CELL-IDENTICAL to the
    /// old shell that baked the hover into `from_model`. Workspace-card case: hovering a plain
    /// (non-selected/active/dragged) card lifts its bg to `hover_bg`.
    #[test]
    fn hover_overlay_workspace_card_equals_baked_compose() {
        let model = model_with_agents(4, 4);
        let mut compositor = ClientCompositor::new(28);
        let now = std::time::Instant::now();
        let content = frame(20, 10, &["alpha", "beta"]);
        let target = crate::app::state::SidebarHoverTarget::Workspace { ws_idx: 1 };
        compositor.set_hover(Some(target));

        // golden: the OLD path that bakes the hover into the rendered shell.
        let baked = compositor.build_shell_hover_baked(&model, 80, 24, now);
        let golden = overlay_content_onto_shell(&baked, &content);

        // new: a hover-less shell, composed, then the per-frame hover overlay painted on top.
        let shell = compositor.build_shell(&model, 80, 24, now);
        let bare = overlay_content_onto_shell(&shell, &content);
        assert_ne!(
            bare, golden,
            "sanity: hovering ws 1 must actually paint a highlight (else the test is vacuous)"
        );
        let mut overlaid = bare;
        apply_hover_overlay(&mut overlaid, &shell, Some(target), None);
        assert_eq!(
            overlaid, golden,
            "#56: hover-less shell + overlay must equal the baked compose for a workspace card"
        );
    }

    /// #56 (Seam 1): for EVERY sidebar hover target the hover-less shell exposes (workspace cards,
    /// agent rows, the filter label, the new/menu buttons, the scope toggle), painting it via the
    /// overlay must be cell-identical to the old shell that baked that hover — and must actually
    /// change something (no vacuous pass). One cached hover-less shell serves them all.
    #[test]
    fn hover_overlay_matches_baked_for_every_sidebar_target() {
        use crate::app::state::SidebarHoverTarget;
        let model = model_with_agents(4, 4);
        let mut compositor = ClientCompositor::new(28);
        let now = std::time::Instant::now();
        let content = frame(20, 10, &["x"]);

        let shell = compositor.build_shell(&model, 80, 24, now);
        let bare = overlay_content_onto_shell(&shell, &content);

        let mut targets: Vec<SidebarHoverTarget> = Vec::new();
        targets.extend(
            shell
                .hover
                .workspace_cards
                .iter()
                .map(|(i, _)| SidebarHoverTarget::Workspace { ws_idx: *i }),
        );
        targets.extend(
            shell
                .hover
                .agent_rows
                .iter()
                .map(|(i, _)| SidebarHoverTarget::AgentRoute { route_idx: *i }),
        );
        if shell.hover.filter.is_some() {
            targets.push(SidebarHoverTarget::Filter);
        }
        if shell.hover.new_button.is_some() {
            targets.push(SidebarHoverTarget::New);
        }
        if shell.hover.menu_button.is_some() {
            targets.push(SidebarHoverTarget::Menu);
        }
        if shell.hover.scope_toggle.is_some() {
            targets.push(SidebarHoverTarget::ScopeToggle);
        }
        assert!(
            targets.len() >= 4,
            "the test model must expose workspace + agent + affordance targets, got {targets:?}"
        );

        for target in targets {
            compositor.set_hover(Some(target));
            let baked = compositor.build_shell_hover_baked(&model, 80, 24, now);
            let golden = overlay_content_onto_shell(&baked, &content);

            let mut overlaid = overlay_content_onto_shell(&shell, &content);
            apply_hover_overlay(&mut overlaid, &shell, Some(target), None);
            assert_eq!(overlaid, golden, "#56: overlay != baked for {target:?}");
            assert_ne!(
                overlaid, bare,
                "#56: hovering {target:?} must actually paint a highlight"
            );
        }
    }

    /// #56 (Seam 1, open-menu launcher): the global launcher renders with NO row selected in the
    /// cached shell; the overlay lifts whichever row the model selects, cell-identical to the old
    /// selection-baked render — for every row.
    #[test]
    fn hover_overlay_launcher_selection_matches_baked() {
        let mut model = model_with_agents(4, 4);
        model.open_client_global_menu(0, 0);
        let compositor = ClientCompositor::new(28);
        let now = std::time::Instant::now();
        let content = frame(20, 10, &["x"]);
        let row_count = model.client_menu().expect("menu open").items.len();
        assert!(row_count > 1, "launcher should have multiple rows");

        let shell = compositor.build_shell(&model, 80, 24, now);
        let bare = overlay_content_onto_shell(&shell, &content);
        for sel in 0..row_count {
            model.set_client_menu_selected(sel);
            let baked = compositor.build_shell_hover_baked(&model, 80, 24, now);
            let golden = overlay_content_onto_shell(&baked, &content);

            let mut overlaid = overlay_content_onto_shell(&shell, &content);
            apply_hover_overlay(&mut overlaid, &shell, None, Some(sel));
            assert_eq!(
                overlaid, golden,
                "#56: launcher overlay != baked for row {sel}"
            );
            assert_ne!(
                overlaid, bare,
                "#56: launcher row {sel} must paint a highlight"
            );
        }
    }

    /// #56 (Seam 1, open-menu context): a host context menu renders with NO row selected in the
    /// cached shell; the overlay paints the model's selected row (full-row style + "›" marker)
    /// cell-identical to the old selection-baked render — for every row.
    #[test]
    fn hover_overlay_context_menu_selection_matches_baked() {
        let mut model = model_with_agents(4, 4);
        model.open_host_context_menu(ServerId::main(), "local".into(), 0, 0);
        let compositor = ClientCompositor::new(28);
        let now = std::time::Instant::now();
        let content = frame(20, 10, &["x"]);
        let row_count = model.client_menu().expect("menu open").items.len();
        assert!(row_count > 1, "host context menu should have multiple rows");

        let shell = compositor.build_shell(&model, 80, 24, now);
        for sel in 0..row_count {
            model.set_client_menu_selected(sel);
            let baked = compositor.build_shell_hover_baked(&model, 80, 24, now);
            let golden = overlay_content_onto_shell(&baked, &content);

            let mut overlaid = overlay_content_onto_shell(&shell, &content);
            apply_hover_overlay(&mut overlaid, &shell, None, Some(sel));
            assert_eq!(
                overlaid, golden,
                "#56: context-menu overlay != baked for row {sel}"
            );
        }
    }

    /// #56 (Seam 1b, no-rebuild invariant): the cached hover-less shell is reused ACROSS hover
    /// changes — overlaying different hover targets onto ONE long-lived shell matches building a
    /// fresh shell each time. The highlight lives in the overlay, never the shell, so a hover change
    /// never needs the O(hosts×agents) `build_shell` rebuild.
    #[test]
    fn hover_overlay_reuses_one_shell_across_hover_changes() {
        use crate::app::state::SidebarHoverTarget;
        let model = model_with_agents(4, 4);
        let compositor = ClientCompositor::new(28);
        let now = std::time::Instant::now();
        let content = frame(20, 10, &["x"]);
        // Built ONCE — then reused for every hover below (mirrors `shell_cache` across HoverRedraws).
        let cached = compositor.build_shell(&model, 80, 24, now);

        for ws_idx in [1usize, 2usize] {
            let target = SidebarHoverTarget::Workspace { ws_idx };
            let mut reused = overlay_content_onto_shell(&cached, &content);
            apply_hover_overlay(&mut reused, &cached, Some(target), None);

            let fresh = compositor.build_shell(&model, 80, 24, now);
            let mut fresh_overlaid = overlay_content_onto_shell(&fresh, &content);
            apply_hover_overlay(&mut fresh_overlaid, &fresh, Some(target), None);

            assert_eq!(
                reused, fresh_overlaid,
                "#56: the cached hover-less shell must be reusable across hover changes (ws {ws_idx})"
            );
        }
    }

    /// A shell built once and reused across DIFFERENT content frames must match a fresh
    /// `compose_frame` for each — this is exactly what the cache does on a pure content burst.
    #[test]
    fn cached_shell_reused_across_content_frames_matches_fresh_compose() {
        let model = model_with_agents(3, 5);
        let compositor = ClientCompositor::new(26);
        let now = std::time::Instant::now();
        let shell = compositor.build_shell(&model, 80, 24, now);

        for content in [
            frame(20, 10, &["one"]),
            frame(20, 10, &["two", "two-b"]),
            frame(20, 10, &["three", "", "x marks here"]),
        ] {
            let reused = overlay_content_onto_shell(&shell, &content);
            let fresh = compositor.compose_frame(&model, &content, 80, 24, now);
            assert_eq!(
                reused, fresh,
                "reusing the cached shell across content-only changes must match a fresh compose"
            );
        }
    }

    /// #45 regression + measurement. Simulates the attach burst: N agent panes flood content frames
    /// while the sidebar model is unchanged. The OLD path rebuilt the whole sidebar (`from_model` +
    /// full render) per frame; the new path builds the shell once and only re-lays the content.
    /// Asserts the reuse path is dramatically cheaper and prints the derived per-frame fps ceiling.
    #[test]
    fn cached_shell_reuse_is_far_cheaper_than_full_compose() {
        let model = model_with_agents(6, 6); // 36 agents — a heavy fleet
        let compositor = ClientCompositor::new(30);
        let content = frame(160, 48, &["agent output line"]);
        let (w, h) = (200u16, 50u16);
        let now = std::time::Instant::now();

        const ITERS: u32 = 200;
        // Warm up the allocator / TerminalId counter so neither side pays first-touch cost.
        let _ = std::hint::black_box(compositor.compose_frame(&model, &content, w, h, now));

        let full_start = std::time::Instant::now();
        for _ in 0..ITERS {
            std::hint::black_box(compositor.compose_frame(&model, &content, w, h, now));
        }
        let full = full_start.elapsed();

        let shell = compositor.build_shell(&model, w, h, now);
        let reuse_start = std::time::Instant::now();
        for _ in 0..ITERS {
            std::hint::black_box(overlay_content_onto_shell(&shell, &content));
        }
        let reuse = reuse_start.elapsed();

        let full_us = full.as_secs_f64() * 1e6 / ITERS as f64;
        let reuse_us = reuse.as_secs_f64() * 1e6 / ITERS as f64;
        eprintln!(
            "#45 per-content-frame compose: full-rebuild={full_us:.1}us ({:.0} fps ceiling), \
             reused-shell={reuse_us:.1}us ({:.0} fps ceiling), speedup={:.1}x",
            1e6 / full_us.max(f64::MIN_POSITIVE),
            1e6 / reuse_us.max(f64::MIN_POSITIVE),
            full_us / reuse_us.max(f64::MIN_POSITIVE),
        );

        assert!(
            reuse < full / 2,
            "reusing the cached shell must be at least ~2x cheaper than a full rebuild \
             (got reuse={reuse:?}, full={full:?})"
        );
    }

    /// #45 root-cause demonstration: the OLD per-content-frame cost was O(cells + agents) because
    /// `from_model` walks every agent; the NEW reused path is O(cells) only. So as the agent count
    /// grows the full-rebuild cost climbs while the reused-shell cost stays ~flat — which is exactly
    /// the issue's "scales with the number of AGENT panes" symptom, now removed for content frames.
    #[test]
    fn reused_shell_cost_is_flat_in_agent_count_while_rebuild_grows() {
        let compositor = ClientCompositor::new(30);
        let content = frame(160, 48, &["agent output line"]);
        let (w, h) = (200u16, 50u16);
        let now = std::time::Instant::now();
        const ITERS: u32 = 120;

        let measure = |model: &ClientSupervisorModel| {
            let _ = std::hint::black_box(compositor.compose_frame(model, &content, w, h, now));
            let fs = std::time::Instant::now();
            for _ in 0..ITERS {
                std::hint::black_box(compositor.build_shell(model, w, h, now));
            }
            let full = fs.elapsed().as_secs_f64() * 1e6 / ITERS as f64;
            let shell = compositor.build_shell(model, w, h, now);
            let rs = std::time::Instant::now();
            for _ in 0..ITERS {
                std::hint::black_box(overlay_content_onto_shell(&shell, &content));
            }
            let reuse = rs.elapsed().as_secs_f64() * 1e6 / ITERS as f64;
            (full, reuse)
        };

        let mut reuse_costs = Vec::new();
        let mut full_costs = Vec::new();
        for &(wsp, per) in &[(2usize, 4usize), (8, 8), (16, 12)] {
            let model = model_with_agents(wsp, per);
            let (full, reuse) = measure(&model);
            let agents = wsp * per;
            eprintln!(
                "#45 scaling @ {agents:>3} agents: full-rebuild={full:7.1}us, \
                 reused-shell={reuse:7.1}us, speedup={:.1}x",
                full / reuse.max(f64::MIN_POSITIVE)
            );
            full_costs.push(full);
            reuse_costs.push(reuse);
        }

        // The reused-shell cost must NOT scale with agent count the way full-rebuild does: across a
        // 24x agent increase (8 → 192) the reused path should stay within a small band, while the
        // full rebuild climbs. Generous bounds keep this robust under noisy CI scheduling.
        let reuse_lo = reuse_costs.iter().cloned().fold(f64::INFINITY, f64::min);
        let reuse_hi = reuse_costs.iter().cloned().fold(0.0_f64, f64::max);
        assert!(
            reuse_hi < reuse_lo * 3.0,
            "reused-shell cost must stay ~flat in agent count (got {reuse_costs:?}us)"
        );
        assert!(
            *full_costs.last().unwrap() > reuse_costs.last().unwrap() * 1.5,
            "at the highest agent count the full rebuild must clearly exceed the reused path \
             (full={full_costs:?}us, reuse={reuse_costs:?}us)"
        );
    }

    /// #56 regression + measurement (the multi-remote load the PRD calls out). A HOVER change used to
    /// rebuild the whole shell — `build_shell` = `from_model` (O(hosts×agents), a `TerminalState` per
    /// agent) + a full ratatui render — on EVERY mouse move; now it recomposes from the cached
    /// hover-less shell and repaints only the highlight via `apply_hover_overlay`. This measures the
    /// per-hover cost under a heavy 64-agent fleet and asserts the overlay repaint is dramatically
    /// cheaper than the old rebuild — i.e. the O(hosts×agents) cost is OFF the hover path.
    #[test]
    fn hover_overlay_repaint_is_far_cheaper_than_shell_rebuild() {
        use crate::app::state::SidebarHoverTarget;
        let model = model_with_agents(8, 8); // 64 agents — a heavy fleet (the #56 scaling concern)
        let compositor = ClientCompositor::new(30);
        let content = frame(160, 48, &["agent output line"]);
        let (w, h) = (200u16, 50u16);
        let now = std::time::Instant::now();
        const ITERS: u32 = 200;

        // The cached hover-less shell — built once per model change, reused across every hover.
        let shell = compositor.build_shell(&model, w, h, now);
        let targets: Vec<SidebarHoverTarget> = shell
            .hover
            .workspace_cards
            .iter()
            .take(2)
            .map(|(i, _)| SidebarHoverTarget::Workspace { ws_idx: *i })
            .collect();
        assert_eq!(
            targets.len(),
            2,
            "need two hoverable cards to simulate a sweep"
        );

        // Warm up so neither side pays first-touch allocator cost.
        let _ = std::hint::black_box(compositor.build_shell(&model, w, h, now));

        // OLD per-hover cost: rebuild the shell, then compose (the #48 behavior — a hover rebuilt the
        // whole sidebar behind the cheap diff-write).
        let old_start = std::time::Instant::now();
        for _ in 0..ITERS {
            let rebuilt = compositor.build_shell(&model, w, h, now);
            std::hint::black_box(overlay_content_onto_shell(&rebuilt, &content));
        }
        let old = old_start.elapsed();

        // NEW per-hover cost (#56): recompose from the cached shell + repaint the highlight overlay.
        // Alternate the hovered card every iteration to exercise a real cursor sweep.
        let new_start = std::time::Instant::now();
        for i in 0..ITERS {
            let mut frame = overlay_content_onto_shell(&shell, &content);
            apply_hover_overlay(&mut frame, &shell, Some(targets[i as usize % 2]), None);
            std::hint::black_box(frame);
        }
        let new = new_start.elapsed();

        let old_us = old.as_secs_f64() * 1e6 / ITERS as f64;
        let new_us = new.as_secs_f64() * 1e6 / ITERS as f64;
        eprintln!(
            "#56 per-hover repaint @ 64 agents: shell-rebuild(old)={old_us:.1}us ({:.0} fps ceiling), \
             cached+overlay(new)={new_us:.1}us ({:.0} fps ceiling), speedup={:.1}x",
            1e6 / old_us.max(f64::MIN_POSITIVE),
            1e6 / new_us.max(f64::MIN_POSITIVE),
            old_us / new_us.max(f64::MIN_POSITIVE),
        );

        assert!(
            new < old / 2,
            "#56: a hover repaint (cached shell + overlay) must be far cheaper than a shell rebuild \
             (new={new:?}, old={old:?})"
        );
    }

    /// #48 regression + measurement (the INPUT side the #56 redraw fix left behind). A sidebar hover
    /// used to run `hover_test` (→ the O(hosts×agents) `from_model` snapshot, a `TerminalState` per
    /// agent) on EVERY mouse-motion event, so a fast sweep flooding one `Moved` per crossed cell ran
    /// `from_model` dozens of times per frame → <1fps. The fix records the motion position per event
    /// (O(1)) and resolves `hover_test` ONCE per frame at the deferred flush. This measures both costs
    /// under a heavy 64-agent fleet and asserts the per-EVENT cost is now a tiny fraction of a
    /// `from_model`, i.e. the O(hosts×agents) cost is OFF the per-motion-event path.
    #[test]
    fn hover_input_coalescing_keeps_from_model_off_the_per_event_path() {
        let model = model_with_agents(8, 8); // 64 agents — the multi-remote load #48 calls out
        let mut compositor = ClientCompositor::new(30);
        let (w, h) = (200u16, 50u16);
        const ITERS: u32 = 200;

        // warm up the allocator so neither side pays first-touch cost.
        let _ = std::hint::black_box(compositor.hover_test(&model, 1, 5, w, h));

        // OLD per-EVENT cost: resolve the hover inline — every motion event rebuilt `from_model`.
        let old_start = std::time::Instant::now();
        for i in 0..ITERS {
            std::hint::black_box(compositor.hover_test(&model, 1, (i % h as u32) as u16, w, h));
        }
        let old = old_start.elapsed();

        // NEW per-EVENT cost (#48): just record the latest motion position (O(1)); the expensive
        // `hover_test`/`from_model` is deferred to one `resolve_pending_hover` per frame.
        let new_start = std::time::Instant::now();
        for i in 0..ITERS {
            compositor.set_pending_hover_pos((1, (i % h as u32) as u16));
            std::hint::black_box(compositor.has_pending_hover());
        }
        let new = new_start.elapsed();

        let old_us = old.as_secs_f64() * 1e6 / ITERS as f64;
        let new_us = new.as_secs_f64() * 1e6 / ITERS as f64;
        eprintln!(
            "#48 per-EVENT hover cost @ 64 agents: inline hover_test(old)={old_us:.2}us, \
             record-only(new)={new_us:.4}us, speedup={:.0}x  (from_model now runs 1x/frame, not 1x/event)",
            old_us / new_us.max(f64::MIN_POSITIVE),
        );

        assert!(
            new * 10 < old,
            "#48: recording a motion position must be far cheaper than an inline hover_test/from_model \
             (record={new:?}, hover_test={old:?})"
        );
    }
}
