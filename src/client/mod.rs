//! Thin client mode — connects to the server's client socket.
//!
//! The client:
//! - Connects to `herdr-client.sock`, sends Hello with terminal size and protocol version
//! - Sets up the real terminal (raw mode, mouse capture, keyboard enhancements)
//! - Receives Frame messages and blits them to the terminal (diff against last frame)
//! - Reads stdin events (keystrokes, mouse, paste) and sends them as ClientMessage::Input
//! - Detects terminal resize and sends ClientMessage::Resize
//! - Restores terminal on exit (normal or error)
//! - Handles ServerShutdown gracefully (clean exit, informative message to stderr)
//! - Handles server unreachable (clear error screen, not blank/hang)
//! - Forwards OSC 52 clipboard writes from server to its own stdout
//! - Displays sound/toast notifications forwarded from server

mod compositor;
mod input;
mod supervisor;

use std::collections::{HashMap, HashSet};
use std::io::{self, Write as _};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste,
    EnableFocusChange, EnableMouseCapture,
};
#[cfg(unix)]
use crossterm::event::{
    KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
#[cfg(not(windows))]
use crossterm::event::{PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags};
use crossterm::execute;
use interprocess::local_socket::traits::Stream as _;
use interprocess::TryClone as _;
use tracing::{debug, info, warn};

use crate::ipc::LocalStream;
use crate::protocol::render_ansi;
use crate::protocol::{
    self, ClientKeybindings, ClientLaunchMode, ClientMessage, ClientSurfaceMode, NotifyKind,
    RenderEncoding, ServerMessage, MAX_FRAME_SIZE, MAX_GRAPHICS_FRAME_SIZE, PROTOCOL_VERSION,
};
#[cfg(unix)]
use crate::protocol::{AttachScrollDirection, AttachScrollSource, MAX_CLIPBOARD_IMAGE_PAYLOAD};
use crate::server::socket_paths::client_socket_path;

static RECEIVED_KITTY_GRAPHICS_IDS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
const CLIENT_SUPERVISOR_REFRESH_INTERVAL: Duration = Duration::from_secs(2);
// item 6 (Area 6): the focused-remote summary poll cadence. The active remote polls at 400ms
// (vs the 2s background cadence) so a focus or in-flight change reconciles within one round-trip.
const CLIENT_FOCUSED_SUMMARY_REFRESH_INTERVAL: Duration = Duration::from_millis(400);
const CLIENT_SUPERVISOR_API_TIMEOUT: Duration = Duration::from_secs(2);
const CLIENT_60FPS_FRAME_BUDGET: Duration = Duration::from_micros(16_667);
// item 5: the single client animation cadence. 80ms / step 8 advances exactly one visible
// spinner frame per interval (`spinner_frame` maps `tick/8`), i.e. ~12.5 fps. SSH remotes use
// the SAME cadence (the recompose is local; link speed only affects the encoded diff).
const CLIENT_ANIMATION_INTERVAL: Duration = Duration::from_millis(80);
const CLIENT_ANIMATION_TICK_STEP: u32 = 8;
// #61: how long a host's terminal update outcome banner line stays up before the Timer housekeeping
// clears it. Success auto-dismisses fairly quickly (the new version is already in the menu readout);
// failure lingers longer so the user can actually read what went wrong before it fades.
const HOST_UPDATE_OUTCOME_TTL: Duration = Duration::from_secs(6);
const HOST_UPDATE_FAILURE_TTL: Duration = Duration::from_secs(12);
// Idle ceiling for bringing up an ssh remote bridge: the maximum time a SINGLE provisioning stage
// (connect / detect / seed / install / verify / server-start) may run without emitting progress
// before we give up. The deadline RESETS on every `RemoteProvisionStage` the worker reports, so a
// legitimately-progressing fresh-host install (which can take minutes overall) is never killed,
// while a stuck/unreachable/auth-prompting host still fails within one idle window (issue #32). The
// ssh `ConnectTimeout` bounds the unreachable case to ~10s inside the first stage.
const ADD_REMOTE_BRIDGE_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

// ---------------------------------------------------------------------------
// Client state
// ---------------------------------------------------------------------------

// #73: the v0.7.1 merge kept this definition but dropped its construction/consumer from the
// client loop (present on merge parent 58b9fec:840,990). Allow dead_code until the wiring is
// re-ported; remove the allow with #73.
#[allow(dead_code)]
struct ClientLoopConfig {
    sound_config: crate::config::SoundConfig,
    mouse_scroll_lines: usize,
    redraw_on_focus_gained: bool,
    kitty_graphics_enabled: bool,
    mouse_capture_active: bool,
    #[cfg(unix)]
    remote_image_paste_key: Option<(crossterm::event::KeyCode, crossterm::event::KeyModifiers)>,
}

/// State tracking for the thin client.
struct ClientState {
    /// Stateful semantic-frame encoder used when the server sends FrameData.
    blit_encoder: render_ansi::BlitEncoder,
    /// Client-side frame timing stats for render FPS diagnostics.
    frame_stats: ClientFrameStats,
    /// Whether host mouse capture is currently active.
    mouse_capture_active: bool,
    /// The terminal size we reported to the server in our last Hello/Resize.
    reported_size: (u16, u16),
    /// The outer terminal size owned by the client compositor.
    host_size: (u16, u16),
    /// Last known host cell size in pixels, used for secondary handshakes.
    cell_size_px: (u32, u32),
    /// Client-local sound playback config, refreshed on server request.
    sound_config: crate::config::SoundConfig,
    /// Whether this client may write Kitty graphics bytes to its host terminal.
    kitty_graphics_enabled: bool,
    /// Direct attach prefix escape state. None for full-app clients.
    attach_escape: Option<AttachEscapeState>,
    /// Rows scrolled for one direct-attach wheel notch.
    #[cfg(unix)]
    mouse_scroll_lines: usize,
    /// Local-client shortcut that sends a clipboard image to a remote Herdr session.
    /// #73: the v0.7.1 merge dropped the readers (the upstream #59 image-paste bridging,
    /// 58b9fec:1119,1237). Allow dead_code until re-ported; remove the allow with #73.
    #[allow(dead_code)]
    #[cfg(unix)]
    remote_image_paste_key: Option<(crossterm::event::KeyCode, crossterm::event::KeyModifiers)>,
    /// Whether outer focus gain should force a full host-terminal redraw.
    redraw_on_focus_gained: bool,
    #[cfg(windows)]
    pending_cursor_reveal: Option<PendingCursorReveal>,
    /// Client-owned sidebar/frame compositor used for mixed-server sessions.
    compositor: Option<compositor::ClientCompositor>,
    /// Runtime multi-server summary state used by the client-owned sidebar.
    supervisor_model: Option<supervisor::ClientSupervisorModel>,
    /// Last time the client refreshed sidebar summaries through API polling.
    last_supervisor_summary_refresh: Instant,
    /// Last semantic frame received from each connected server stream.
    frame_cache: HashMap<supervisor::ServerId, protocol::FrameData>,
    /// #45: cached sidebar shell — the expensive `from_model` + full ratatui sidebar render. Rebuilt
    /// only when the sidebar model/view/size changes: every `request_full_redraw` drops it, the
    /// model/timer/animation paths (`render_cached_composited_frame`) rebuild it, and a host resize
    /// is caught by `ComposedShell::matches_dims`. A pure content-output frame reuses it and only
    /// re-lays the content region, removing the per-content-frame full-sidebar rebuild that throttled
    /// attach to <1fps when many agent TUIs flooded the client with content frames (#45).
    shell_cache: Option<compositor::ComposedShell>,
    /// #45: kill switch for the sidebar shell cache, read once from `HERDR_DISABLE_SHELL_CACHE`.
    /// When set, every content frame rebuilds the shell (the pre-#45 behavior) — a safety valve to
    /// disable the optimization in the field without redeploying, and the A/B knob used to confirm
    /// the speedup. Off (cache enabled) by default.
    shell_cache_disabled: bool,
    /// issue #13: per-server cumulative downstream bytes (fed by reader threads).
    rx_counters: RxByteCounters,
    /// issue #13: last sampled (bytes, instant) per server, for deriving the banner bytes/sec rate.
    server_rx_sample: HashMap<supervisor::ServerId, (u64, Instant)>,
    /// issue #13: last time the downstream-rate sampler ran.
    last_rx_sample_at: Instant,
    /// issue #13: monotonic nonce for stream latency probes.
    ping_nonce: u64,
    /// issue #13: outstanding ping per server (nonce + send time) awaiting a Pong.
    pending_pings: HashMap<supervisor::ServerId, (u64, Instant)>,
    /// issue #13: last time stream latency probes were sent.
    last_ping_at: Instant,
    /// Servers with active summary-event subscription workers.
    summary_subscription_server_ids: HashSet<supervisor::ServerId>,
    /// Secondary servers with a summary refresh already running off the UI loop.
    pending_summary_refresh_server_ids: HashSet<supervisor::ServerId>,
    /// #42: whether a main-server supervisor refresh (registry + ui-settings + main summary) is
    /// already running off the UI loop. Coalesces a connect-storm of refresh triggers into one
    /// in-flight worker so the render thread issues O(1), not O(N-remotes), background refreshes.
    pending_main_refresh: bool,
    /// Secondary servers with a client-stream connection attempt running off the UI loop.
    pending_secondary_connect_server_ids: HashSet<supervisor::ServerId>,
    /// Whether an add-remote submission is running off the UI loop.
    pending_add_remote: bool,
    /// SSH bridges owned by this client for secondary servers.
    ssh_bridges: HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
    /// Backoff state for secondary servers that should be reconnected.
    secondary_retries: HashMap<supervisor::ServerId, SecondaryRetryState>,
    /// #43: secondaries the user manually disconnected (host context-menu "disconnect") WITHOUT
    /// disabling them in the registry. The retry sweeps filter these out so the stream stays down
    /// until an explicit "reconnect" (which removes the entry) — that is what makes Disconnect a
    /// distinct, non-persistent action from Disable.
    manually_disconnected: HashSet<supervisor::ServerId>,
    /// Hosts whose provisioning failed TERMINALLY (auth, unknown host, impossible seed/version —
    /// see [`classify_provision_failure`]): the retry sweep stops for them and the failure stays
    /// on the banner until an explicit retry (context-menu reconnect / status-glyph click).
    provision_failed: HashSet<supervisor::ServerId>,
    /// One-shot approvals (issue #12): the next retry for these hosts may RESTART an incompatible
    /// no-handoff remote server. Set by the explicit retry-after-restart-confirm affordance,
    /// consumed by the next spawned attempt.
    retry_restart_incompatible: HashSet<supervisor::ServerId>,
    /// #44: hosts with a one-click "update" (reinstall the local herdr via the add-remote
    /// provisioning flow) running off the UI loop. Guards against double-spawn from a repeated
    /// menu click while the worker is in flight; cleared when `UpdateRemoteFinished` arrives.
    pending_update_remote: HashSet<supervisor::ServerId>,
    /// #61: when each host's TERMINAL update outcome banner line (✓ updated / ✗ failed) expires.
    /// The model holds the outcome text (no clock); this loop-side map drives the timed clear in the
    /// Timer housekeeping (`expire_host_update_outcomes`). Keyed by `ServerId`.
    update_outcome_expiry: HashMap<supervisor::ServerId, Instant>,
    /// #61: hosts whose last update FAILED, excluded from the AUTO-update sweep so a remote the local
    /// build can't seed (or any other hard failure) is not re-attempted every ~14s forever. Cleared
    /// on a successful update or a deliberate auto-update re-toggle; the manual menu `update` always
    /// works regardless (this only gates the automatic path).
    auto_update_suppressed: HashSet<supervisor::ServerId>,
    /// item 5: last time the client advanced the sidebar animation tick (80ms cadence).
    last_animation_tick: Instant,
    /// #48: a sidebar hover changed the highlighted row but its render is DEFERRED (latest-wins
    /// coalescing). The select loop flushes it within one frame budget via `next_select_deadline`,
    /// so a fast motion sweep that floods one `Moved` per crossed row renders at most once per
    /// frame instead of once per event. Cleared by every composited frame (`flush_composited_frame`).
    pending_hover_render: bool,
    /// many-remotes: a fleet-scale model update (a connect storm or the 400ms/2s summary-refresh
    /// cadence firing across N connected remotes) coalesces its full rebuild to ONE per frame instead
    /// of one per event. Each summary/connection event still APPLIES its model mutation immediately
    /// (cheap), but the expensive `build_shell`/`from_model` (O(hosts×agents)) is deferred and run at
    /// most once per frame budget (latest-wins) — so the UI stays responsive no matter the fleet size
    /// instead of dropping to ~1fps while N events each forced a serial rebuild. Flushed by the Timer.
    pending_full_render: bool,
    /// #48: when the last composited frame was flushed. Anchors the hover-render frame-budget clamp
    /// in `next_select_deadline` so deferred hover repaints are capped at ~60fps.
    last_composited_render_at: Instant,
    /// item 6 (Area 6): last time each connected secondary's summary refresh was STARTED. Drives
    /// the adaptive cadence in `due_secondary_summary_refreshes` (400ms active / 2s background)
    /// and is recorded on start and on completion so a slow SSH fetch does not stack.
    last_summary_refresh: HashMap<supervisor::ServerId, Instant>,
}

#[derive(Debug, Clone, Copy)]
struct SecondaryRetryState {
    attempt: usize,
    next_retry_at: Instant,
}

struct SecondaryConnectionAttempt {
    stream: LocalStream,
    bridge: Option<crate::remote::RemoteBridge>,
}

#[derive(Clone)]
struct ServerWriteHandle {
    tx: std::sync::mpsc::Sender<ClientMessage>,
}

/// #45: rolling window over which `accumulate_window` aggregates per-frame timing into one summary.
const FRAME_STATS_WINDOW: Duration = Duration::from_millis(1000);

#[derive(Debug, Default)]
struct ClientFrameStats {
    last_render_duration: Option<Duration>,
    last_render_fps: Option<f64>,
    // #45: rolling ~1s window accumulating the split frame-budget breakdown so a single summary
    // line reports the sustained render fps during a burst (used to confirm attach holds ≥30fps).
    window_started_at: Option<Instant>,
    window_frames: u32,
    window_total: Duration,
    window_compose: Duration,
    window_rebuilds: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ClientFrameSample {
    render_duration: Duration,
    render_fps: f64,
    missed_sixty_fps_budget: bool,
}

/// #45: one closed frame-budget window — the sustained render fps over [`FRAME_STATS_WINDOW`] plus
/// the average per-frame breakdown and how many of those frames rebuilt the sidebar shell.
struct ClientFrameWindowSummary {
    frames: u32,
    elapsed: Duration,
    fps: f64,
    avg_total_ms: f64,
    avg_compose_ms: f64,
    rebuilds: u32,
}

impl ClientFrameStats {
    fn record_render_duration(&mut self, render_duration: Duration) -> ClientFrameSample {
        let render_fps = fps_for_frame_duration(render_duration);
        let sample = ClientFrameSample {
            render_duration,
            render_fps,
            missed_sixty_fps_budget: render_duration > CLIENT_60FPS_FRAME_BUDGET,
        };
        self.last_render_duration = Some(render_duration);
        self.last_render_fps = Some(render_fps);
        sample
    }

    /// #45: fold one frame's timing into the current window; return a summary (and reset the window)
    /// once the window has spanned [`FRAME_STATS_WINDOW`]. Returns `None` mid-window.
    fn accumulate_window(
        &mut self,
        now: Instant,
        total: Duration,
        compose: Duration,
        shell_rebuilt: bool,
    ) -> Option<ClientFrameWindowSummary> {
        let started = *self.window_started_at.get_or_insert(now);
        self.window_frames += 1;
        self.window_total += total;
        self.window_compose += compose;
        if shell_rebuilt {
            self.window_rebuilds += 1;
        }

        let elapsed = now.duration_since(started);
        if elapsed < FRAME_STATS_WINDOW {
            return None;
        }

        let frames = self.window_frames.max(1);
        let summary = ClientFrameWindowSummary {
            frames: self.window_frames,
            elapsed,
            fps: self.window_frames as f64 / elapsed.as_secs_f64().max(f64::MIN_POSITIVE),
            avg_total_ms: self.window_total.as_secs_f64() * 1000.0 / frames as f64,
            avg_compose_ms: self.window_compose.as_secs_f64() * 1000.0 / frames as f64,
            rebuilds: self.window_rebuilds,
        };
        self.window_started_at = Some(now);
        self.window_frames = 0;
        self.window_total = Duration::ZERO;
        self.window_compose = Duration::ZERO;
        self.window_rebuilds = 0;
        Some(summary)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClientRenderPlan {
    surface_mode: ClientSurfaceMode,
    requested_encoding: RenderEncoding,
    server_size: (u16, u16),
    use_client_compositor: bool,
}

#[derive(Debug, Default)]
#[cfg(windows)]
struct AttachEscapeState;

#[derive(Debug, Default)]
#[cfg(unix)]
struct AttachEscapeState {
    pending_prefix: bool,
}

#[derive(Debug)]
#[cfg(unix)]
enum AttachInputAction {
    Forward(Vec<u8>),
    Scroll {
        source: AttachScrollSource,
        direction: AttachScrollDirection,
        lines: u16,
        column: Option<u16>,
        row: Option<u16>,
        modifiers: u8,
    },
    Detach,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ClientApiRefreshPolicy {
    Immediate,
    Deferred,
    // item 6 (Area 6): fire a targeted single-server refresh for the focused server only (not
    // the whole fleet) so a focus reconciles within one round-trip.
    ImmediateFocused,
}

#[derive(Debug, Clone, PartialEq)]
enum ClientInputDispatch {
    Forward(Vec<u8>),
    ServerControl {
        server_id: supervisor::ServerId,
        message: ClientMessage,
    },
    ApiRequest {
        server_id: supervisor::ServerId,
        refresh: ClientApiRefreshPolicy,
        request: Box<crate::api::schema::Request>,
    },
    AddRemote(supervisor::AddRemoteDraft),
    // item 3 (Area 5): toggle / delete a remote off the UI loop against ServerId::main().
    SetRemoteEnabled {
        remote_id: String,
        enabled: bool,
    },
    // #61: persist a remote's per-remote auto-update flag off the UI loop against ServerId::main().
    SetRemoteAutoUpdate {
        remote_id: String,
        auto_update: bool,
    },
    /// C4/C6: re-point a remote at another session (`None` = its default) off the UI loop against
    /// `ServerId::main()`. On success the apply handler REBUILDS the bridge (teardown + immediate
    /// reconnect) so the far side is re-attached with the new `herdr --session <name>`.
    SetRemoteSession {
        server_id: supervisor::ServerId,
        remote_id: String,
        session: Option<String>,
    },
    DeleteRemote {
        remote_id: String,
    },
    // #43: drop / restore a secondary's live stream WITHOUT touching the registry `disabled` flag.
    // A `DisconnectRemote` tears the stream down and marks the host manually-disconnected so the
    // retry sweeps leave it down (that is what makes Disconnect != Disable); `ReconnectRemote`
    // clears the mark and schedules an immediate reconnect.
    DisconnectRemote {
        server_id: supervisor::ServerId,
    },
    ReconnectRemote {
        server_id: supervisor::ServerId,
    },
    // #44: reinstall the LOCAL client's herdr onto this remote by reusing the add-remote
    // provisioning flow (no internet download). Spawns the update worker off the UI loop.
    UpdateRemote {
        server_id: supervisor::ServerId,
    },
    /// Worktree-menu parity: the "open worktree…" picker opened in its loading state; fetch the
    /// workspace's `worktree.list` from the owning server off the UI loop and fill the picker.
    FetchWorktreeList {
        server_id: supervisor::ServerId,
        workspace_id: String,
    },
    /// C4: the session picker opened in its loading state; fetch `session.list` from the OWNING
    /// server off the UI loop and fill the picker.
    FetchSessionList {
        server_id: supervisor::ServerId,
        remote_id: String,
    },
    /// Worktree-menu parity: flip the group's client-local collapsed state — the same set the
    /// sidebar chevron toggles; handled where `&mut compositor` is in scope.
    ToggleWorktreeGroup {
        group_key: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    DetachAll,
    Redraw,
    /// #48: a sidebar hover changed the highlighted row — a presentation-only change of a couple of
    /// cells, NOT a model/view mutation. Distinguished from [`Redraw`] so the main loop takes the
    /// lightweight `request_hover_redraw` path (rebuild the shell so the new highlight is painted by
    /// the one render source of truth, but PRESERVE the blit-encoder diff baseline so only the ~2
    /// changed rows are written — never a full-screen repaint) instead of the `request_full_redraw`
    /// sledgehammer a genuine model change needs.
    HoverRedraw,
    Consumed,
}

/// item 3 (Area 5): map a `RemoteManageOutcome` from the model into the client input dispatch.
/// `OpenAddRemote` maps to `Redraw` because the model already switched overlay state.
fn dispatch_for_remote_manage_outcome(
    outcome: supervisor::RemoteManageOutcome,
) -> ClientInputDispatch {
    match outcome {
        supervisor::RemoteManageOutcome::Redraw
        | supervisor::RemoteManageOutcome::OpenAddRemote => ClientInputDispatch::Redraw,
        supervisor::RemoteManageOutcome::SetEnabled { remote_id, enabled } => {
            ClientInputDispatch::SetRemoteEnabled { remote_id, enabled }
        }
        supervisor::RemoteManageOutcome::Delete { remote_id } => {
            ClientInputDispatch::DeleteRemote { remote_id }
        }
    }
}

/// #47: map a `ClientMenuOutcome` into the client input dispatch — the single handler for all three
/// menus. The overlay-opening launcher rows (`add remote` / `manage remotes`) and the workspace
/// rename/close rows already opened their follow-on overlay inside `select_client_menu_item` and
/// report `Redraw`; the rest already closed the menu and carry the context to route. `Settings` /
/// `Keybinds` activate the main server then open the matching server surface; `ReloadConfig` /
/// `Detach` reuse the existing dispatches; the host rows reuse the add-space ApiRequest (same
/// Immediate refresh the New button uses) / `SetRemoteEnabled` / Disconnect-Reconnect / Update paths.
fn dispatch_for_client_menu_outcome(
    model: &mut supervisor::ClientSupervisorModel,
    outcome: supervisor::ClientMenuOutcome,
) -> ClientInputDispatch {
    match outcome {
        supervisor::ClientMenuOutcome::Redraw => ClientInputDispatch::Redraw,
        supervisor::ClientMenuOutcome::Settings => {
            model.activate_main_server();
            ClientInputDispatch::ServerControl {
                server_id: supervisor::ServerId::main(),
                message: ClientMessage::OpenSettings,
            }
        }
        supervisor::ClientMenuOutcome::Keybinds => {
            model.activate_main_server();
            ClientInputDispatch::ServerControl {
                server_id: supervisor::ServerId::main(),
                message: ClientMessage::OpenKeybindHelp,
            }
        }
        supervisor::ClientMenuOutcome::ReloadConfig => ClientInputDispatch::ApiRequest {
            server_id: supervisor::ServerId::main(),
            refresh: ClientApiRefreshPolicy::Immediate,
            request: Box::new(crate::api::schema::Request {
                id: "client:reload-config".into(),
                method: crate::api::schema::Method::ServerReloadConfig(
                    crate::api::schema::EmptyParams::default(),
                ),
            }),
        },
        supervisor::ClientMenuOutcome::Detach => ClientInputDispatch::DetachAll,
        supervisor::ClientMenuOutcome::HostAddSpace(server_id) => model
            .route_for_server(&server_id)
            .api_request("client:workspace-create")
            .map(|(server_id, request)| ClientInputDispatch::ApiRequest {
                server_id,
                refresh: ClientApiRefreshPolicy::Immediate,
                request: Box::new(request),
            })
            .unwrap_or(ClientInputDispatch::Redraw),
        supervisor::ClientMenuOutcome::HostToggleEnabled { remote_id, enabled } => {
            ClientInputDispatch::SetRemoteEnabled { remote_id, enabled }
        }
        supervisor::ClientMenuOutcome::HostToggleAutoUpdate {
            remote_id,
            auto_update,
        } => ClientInputDispatch::SetRemoteAutoUpdate {
            remote_id,
            auto_update,
        },
        supervisor::ClientMenuOutcome::HostDisconnect(server_id) => {
            ClientInputDispatch::DisconnectRemote { server_id }
        }
        supervisor::ClientMenuOutcome::HostReconnect(server_id) => {
            ClientInputDispatch::ReconnectRemote { server_id }
        }
        // #44: reinstall the local herdr onto this remote by reusing the add-remote provisioning
        // flow (no internet download). The worker is spawned in the loop where the bridge map and
        // event channel are in scope.
        supervisor::ClientMenuOutcome::HostUpdate(server_id) => {
            ClientInputDispatch::UpdateRemote { server_id }
        }
        supervisor::ClientMenuOutcome::FetchWorktreeList {
            server_id,
            workspace_id,
        } => ClientInputDispatch::FetchWorktreeList {
            server_id,
            workspace_id,
        },
        supervisor::ClientMenuOutcome::ToggleWorktreeGroup { group_key } => {
            ClientInputDispatch::ToggleWorktreeGroup { group_key }
        }
        // C4: the session picker is open in its loading state; fetch the REMOTE host's session
        // list off the UI loop (the worker is spawned in the loop, where the bridge map lives).
        supervisor::ClientMenuOutcome::FetchSessionList {
            server_id,
            remote_id,
        } => ClientInputDispatch::FetchSessionList {
            server_id,
            remote_id,
        },
    }
}

/// C5: map a `SessionPickerOutcome` into a dispatch. `OpenNewSession` already promoted the picker
/// into the new-session input inside the model, so it just repaints (mirroring the menu's
/// overlay-opening rows); `Select` becomes the `remote.set_session` round-trip.
fn dispatch_for_session_picker_outcome(
    outcome: supervisor::SessionPickerOutcome,
) -> ClientInputDispatch {
    match outcome {
        supervisor::SessionPickerOutcome::Redraw
        | supervisor::SessionPickerOutcome::OpenNewSession => ClientInputDispatch::Redraw,
        supervisor::SessionPickerOutcome::Select {
            server_id,
            remote_id,
            session,
        } => ClientInputDispatch::SetRemoteSession {
            server_id,
            remote_id,
            session,
        },
    }
}

/// C6: map a `NewSessionOutcome` into a dispatch — the same `remote.set_session` round-trip a
/// picked row takes, so a typed name and a listed one land on ONE apply path.
fn dispatch_for_new_session_outcome(outcome: supervisor::NewSessionOutcome) -> ClientInputDispatch {
    match outcome {
        supervisor::NewSessionOutcome::Redraw => ClientInputDispatch::Redraw,
        supervisor::NewSessionOutcome::Submit {
            server_id,
            remote_id,
            session,
        } => ClientInputDispatch::SetRemoteSession {
            server_id,
            remote_id,
            session,
        },
    }
}

impl AttachEscapeState {
    #[cfg(unix)]
    fn filter_input(
        &mut self,
        data: Vec<u8>,
        viewport_rows: u16,
        mouse_scroll_lines: usize,
    ) -> AttachInputAction {
        const PREFIX: u8 = 0x02; // Ctrl+B

        let mut output = Vec::with_capacity(data.len());
        for byte in data {
            if self.pending_prefix {
                self.pending_prefix = false;
                match byte {
                    b'q' => return AttachInputAction::Detach,
                    PREFIX => output.push(PREFIX),
                    other => {
                        output.push(PREFIX);
                        output.push(other);
                    }
                }
                continue;
            }

            if byte == PREFIX {
                self.pending_prefix = true;
            } else {
                output.push(byte);
            }
        }

        if output.is_empty() {
            AttachInputAction::None
        } else if let Some(action) =
            attach_scroll_action(&output, viewport_rows, mouse_scroll_lines)
        {
            action
        } else {
            AttachInputAction::Forward(output)
        }
    }
}

#[cfg(unix)]
fn attach_scroll_action(
    data: &[u8],
    viewport_rows: u16,
    mouse_scroll_lines: usize,
) -> Option<AttachInputAction> {
    let mut events = crate::raw_input::parse_raw_input_bytes_sync(data);
    if events.len() != 1 {
        return None;
    }

    match events.pop()? {
        crate::raw_input::RawInputEvent::Mouse(mouse) => {
            let direction = match mouse.kind {
                MouseEventKind::ScrollUp => AttachScrollDirection::Up,
                MouseEventKind::ScrollDown => AttachScrollDirection::Down,
                _ => return Some(AttachInputAction::None),
            };
            Some(AttachInputAction::Scroll {
                source: AttachScrollSource::Wheel,
                direction,
                lines: mouse_scroll_lines.max(1).min(u16::MAX as usize) as u16,
                column: Some(mouse.column),
                row: Some(mouse.row),
                modifiers: mouse.modifiers.bits(),
            })
        }
        crate::raw_input::RawInputEvent::Key(key)
            if key.modifiers.is_empty()
                && matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) =>
        {
            let direction = match key.code {
                KeyCode::PageUp => AttachScrollDirection::Up,
                KeyCode::PageDown => AttachScrollDirection::Down,
                _ => return None,
            };
            Some(AttachInputAction::Scroll {
                source: AttachScrollSource::PageKey {
                    input: data.to_vec(),
                },
                direction,
                lines: viewport_rows.saturating_sub(1).max(1),
                column: None,
                row: None,
                modifiers: KeyModifiers::empty().bits(),
            })
        }
        crate::raw_input::RawInputEvent::Key(key)
            if key.modifiers.is_empty()
                && key.kind == KeyEventKind::Release
                && matches!(key.code, KeyCode::PageUp | KeyCode::PageDown) =>
        {
            Some(AttachInputAction::None)
        }
        _ => None,
    }
}

fn dispatch_composited_input(
    data: Vec<u8>,
    compositor: &mut compositor::ClientCompositor,
    model: &mut supervisor::ClientSupervisorModel,
    host_size: (u16, u16),
) -> ClientInputDispatch {
    // An open overlay OWNS the keyboard. This was a hand-written `||` chain over nine overlays and
    // silently missed the two new ones, so their keystrokes fell through to the focused pane (the
    // user's shell ran `demo` as a command). `client_overlay_open` is an exhaustive match on the
    // overlay state, so a new variant cannot be forgotten here again.
    if model.any_overlay_open() {
        return dispatch_client_overlay_input(data, compositor, model, host_size);
    }

    let events = crate::raw_input::parse_raw_input_bytes_sync(&data);
    if let [crate::raw_input::RawInputEvent::Mouse(mouse)] = events.as_slice() {
        return dispatch_composited_mouse_input(data, compositor, model, host_size, mouse);
    }

    // #24: client-side sidebar keyboard navigation. Before forwarding a key to the focused remote
    // terminal, check whether it matches a configured sidebar-nav binding and, if so, route it to
    // the SAME client action the mouse path uses. Only a single bare Key event is considered; any
    // multi-event/paste/unmatched input falls through to Forward so terminal input is preserved.
    if let [crate::raw_input::RawInputEvent::Key(key)] = events.as_slice() {
        if let Some(dispatch) = dispatch_composited_key_input(key.clone(), &data, compositor, model) {
            return dispatch;
        }
    }

    // #31 (multi-event): a single stdin read can coalesce several mouse reports (e.g. motion spam
    // under ?1003h). The single-event arm above misses those, so they would forward the raw HOST
    // column to the remote. Re-encode each content-area mouse event with the sidebar-translated
    // column instead. Only all-mouse buffers take this path — buffers that also carry non-mouse
    // bytes keep the raw-forward path below, since those bytes can't be reconstructed from the
    // parsed events.
    if events.len() > 1
        && events
            .iter()
            .all(|event| matches!(event, crate::raw_input::RawInputEvent::Mouse(_)))
    {
        // #71: subtract the collapse-aware origin (mini width while collapsed / mid-slide), the
        // SAME value render + hit_test + content_size read — the resting `sidebar_width()` here
        // forwarded collapsed-mode content clicks offset by (expanded − mini) columns.
        let sidebar_width = compositor.effective_sidebar_width(host_size.0);
        let mut forwarded = Vec::new();
        for event in &events {
            let crate::raw_input::RawInputEvent::Mouse(mouse) = event else {
                continue;
            };
            // Drop coalesced sidebar-area events rather than forward them with a bogus column;
            // precise per-event sidebar handling would need byte spans the parser doesn't expose.
            if mouse.column < sidebar_width {
                continue;
            }
            if let ClientInputDispatch::Forward(bytes) =
                translate_content_mouse_input(Vec::new(), mouse, sidebar_width)
            {
                forwarded.extend_from_slice(&bytes);
            }
        }
        return if forwarded.is_empty() {
            ClientInputDispatch::Consumed
        } else {
            ClientInputDispatch::Forward(forwarded)
        };
    }

    ClientInputDispatch::Forward(data)
}

/// #24/#30: route a single keypress to a client-side sidebar-navigation action, mirroring the
/// server's gating (`src/app/input/navigate.rs`). Returns `None` for any key that is NOT a
/// configured sidebar-nav binding so the caller forwards it to the focused remote terminal.
///
/// Gating mirrors the server's two-stage `Mode::Prefix` state machine: the configured prefix key
/// (a modified chord, e.g. `ctrl+b`) arms `compositor.prefix_armed`; only WHILE armed is the next
/// key matched against the configured prefix-mode bindings (next/prev workspace+agent, new/rename/
/// close workspace, sidebar collapse, agent-scope). Direct (modified-chord) bindings still fire
/// without the prefix, exactly as the server's `terminal_direct_navigation_action` does. Bare,
/// unmodified keys are never intercepted unless prefix-armed, so normal typing reaches the agent.
///
/// #30: the client only re-implements the *sidebar* subset of prefix actions. The prefix key is
/// therefore buffered (not forwarded) on arm, and an armed follow-up the client does NOT handle is
/// replayed to the active server as `prefix-bytes ++ key-bytes`, so the server's own prefix state
/// machine runs everything else (new tab/split/close-pane/zoom/resize/pane-focus/tab-switch/detach
/// /help/settings/navigate/custom commands). Only `Press`/`Repeat` arms or resolves the prefix; a
/// `Release` (e.g. the prefix key's own release under a CSI-u keyboard protocol) must not disarm.
fn dispatch_composited_key_input(
    key: crate::input::TerminalKey,
    data: &[u8],
    compositor: &mut compositor::ClientCompositor,
    model: &mut supervisor::ClientSupervisorModel,
) -> Option<ClientInputDispatch> {
    let (keybinds, prefix) = client_navigation_keybinds();
    let is_press = matches!(
        key.kind,
        crossterm::event::KeyEventKind::Press | crossterm::event::KeyEventKind::Repeat
    );

    if compositor.prefix_armed() {
        // A release while armed (the prefix key's own release, etc.) must NOT cancel prefix mode
        // before the follow-up press arrives; swallow it and stay armed.
        if !is_press {
            return Some(ClientInputDispatch::Consumed);
        }
        let prefix_bytes = compositor.take_prefix_pending_bytes();
        compositor.disarm_prefix();
        let key_event = key.as_key_event();
        // Esc / the prefix key itself just leaves prefix mode, swallowed (mirrors the server).
        if key_event.code == crossterm::event::KeyCode::Esc
            || crate::config::terminal_key_matches_combo(&key, prefix)
        {
            return Some(ClientInputDispatch::Redraw);
        }
        // A client-rendered-sidebar action is handled locally and swallowed — the server never
        // entered prefix mode (we never forwarded the prefix key).
        if let Some(dispatch) =
            sidebar_action_dispatch(&keybinds, key, compositor, model, ActionTrigger::Prefix)
        {
            return Some(dispatch);
        }
        // Everything else is owned by the server's prefix state machine. Replay the buffered prefix
        // key + this key to the active server so it runs the action (#30).
        let mut forwarded = prefix_bytes.unwrap_or_default();
        forwarded.extend_from_slice(data);
        return Some(ClientInputDispatch::Forward(forwarded));
    }

    // Not armed: a press of the configured prefix key arms prefix mode, buffering its raw bytes
    // (swallowed for now — replayed to the server later only if the follow-up isn't a client
    // sidebar action). Other keys fire only on a DIRECT (modified-chord) sidebar-nav binding;
    // everything else returns None so the caller forwards it to the terminal.
    if is_press && crate::config::terminal_key_matches_combo(&key, prefix) {
        compositor.arm_prefix(data.to_vec());
        return Some(ClientInputDispatch::Redraw);
    }

    if is_press {
        sidebar_action_dispatch(&keybinds, key, compositor, model, ActionTrigger::Direct)
    } else {
        None
    }
}

/// #24: whether to match the configured prefix-mode side of a binding (`prefix+x`, only checked
/// while the prefix is armed) or the direct side (a modified chord like `alt+a`, checked always).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActionTrigger {
    Direct,
    Prefix,
}

/// #24: resolve the client's effective keybindings (and the prefix combo). The client renders the
/// sidebar with the SAME shared code as the server, and its sidebar-nav keys come from the same
/// config the server reads; the client reuses `Config::keybinds()` / `Config::prefix_key()` (the
/// identical resolution the server uses) rather than inventing a parallel binding source. Computed
/// per keypress (keypresses are rare), so no caching is needed and a live config reload is
/// naturally picked up on the next key.
fn client_navigation_keybinds() -> (crate::config::Keybinds, (KeyCode, KeyModifiers)) {
    let config = crate::config::Config::load().config;
    (config.keybinds(), config.prefix_key())
}

/// #24: match `key` against the sidebar-nav bindings for the given trigger side and, if it matches,
/// perform the SAME client action the mouse path performs. Returns `None` when no sidebar-nav
/// binding matches (so the key is forwarded / consumed by the caller). Bindings and actions are a
/// strict subset of the server's `navigate.rs` map — the workspace-tree / pane / tab actions that
/// have no client-rendered-sidebar equivalent are intentionally NOT bound here.
fn sidebar_action_dispatch(
    keybinds: &crate::config::Keybinds,
    key: crate::input::TerminalKey,
    compositor: &mut compositor::ClientCompositor,
    model: &mut supervisor::ClientSupervisorModel,
    trigger: ActionTrigger,
) -> Option<ClientInputDispatch> {
    let matches = |binding: &crate::config::ActionKeybinds| match trigger {
        ActionTrigger::Direct => binding.matches_direct_key(&key),
        ActionTrigger::Prefix => binding.matches_prefix_key(&key),
    };

    // next/prev workspace + agent: step the aggregated list and route the focus exactly like the
    // mouse workspace/agent-click path (FocusRoute -> ApiRequest, crossing servers as needed).
    if matches(&keybinds.next_workspace) {
        return Some(step_workspace_focus(model, 1));
    }
    if matches(&keybinds.previous_workspace) {
        return Some(step_workspace_focus(model, -1));
    }
    if matches(&keybinds.next_agent) {
        return Some(step_agent_focus(model, 1));
    }
    if matches(&keybinds.previous_agent) {
        return Some(step_agent_focus(model, -1));
    }

    // new workspace: open the same picker the New button / `SidebarHitTarget::New` path opens.
    if matches(&keybinds.new_workspace) || matches(&keybinds.workspace_picker) {
        return Some(open_new_workspace_picker_dispatch(model));
    }

    // rename / close the focused workspace: open the #23 overlays (the existing overlay key-gate
    // then handles typing/confirm), reusing the supervisor opener methods the context menu uses.
    if matches(&keybinds.rename_workspace) {
        return Some(open_focused_workspace_overlay(
            model,
            FocusedWorkspaceOverlay::Rename,
        ));
    }
    if matches(&keybinds.close_workspace) {
        return Some(open_focused_workspace_overlay(
            model,
            FocusedWorkspaceOverlay::Close,
        ));
    }

    // toggle sidebar collapse (#25) / agent-scope (#20): client-local compositor flips, no server
    // round-trip — the SAME methods the mouse toggles call.
    if matches(&keybinds.toggle_sidebar) {
        compositor.toggle_sidebar_collapsed();
        // #58: do NOT redraw at the pre-toggle width here — that wasted a full O(hosts×agents)
        // build_shell showing the unchanged sidebar before the slide. The collapse now settles in one
        // gated tick (SIDEBAR_COLLAPSE_ANIM_STEP == 1.0) which renders the FINAL width and emits the
        // content resize, so a single rebuild does the whole transition.
        return Some(ClientInputDispatch::Consumed);
    }

    None
}

/// #24: enumerate the aggregated workspace rows (across servers, in render order), find the focused
/// one, step ±1 with wraparound, and route the focus through `focus_workspace_route` -> ApiRequest
/// exactly like the mouse workspace-click path (including switching the active server across a
/// host boundary, handled inside `focus_workspace_route`). Placeholder rows (`workspace_id == None`)
/// are skipped so a step always lands on a real, focusable workspace.
fn step_workspace_focus(
    model: &mut supervisor::ClientSupervisorModel,
    delta: isize,
) -> ClientInputDispatch {
    // Build `targets` and locate the focused entry in a SINGLE pass so the focus index is recorded
    // against the FILTERED target list. (Seeding `current` from `.position()` over the unfiltered
    // `workspace_rows()` skewed the step by the number of placeholder rows (`workspace_id == None`)
    // preceding the focused workspace.) Each connected server independently reports a `focused`
    // workspace, so several rows can be focused at once; anchor the step on the row owned by the
    // ACTIVE server (the workspace the user is actually on), falling back to the first focused row.
    // This matches the active-server tie-break the sidebar snapshot uses for the same ambiguity.
    let active_server = model.active_server_id().clone();
    let mut targets: Vec<(supervisor::ServerId, String)> = Vec::new();
    let mut focused_index = None;
    let mut active_focused_index = None;
    for row in model.workspace_rows() {
        if let Some(workspace_id) = row.workspace_id {
            if row.focused {
                if focused_index.is_none() {
                    focused_index = Some(targets.len());
                }
                if active_focused_index.is_none() && row.server_id == active_server {
                    active_focused_index = Some(targets.len());
                }
            }
            targets.push((row.server_id, workspace_id));
        }
    }
    let current = active_focused_index.or(focused_index);
    let Some((server_id, workspace_id)) = step_focus_target(&targets, current, delta) else {
        return ClientInputDispatch::Consumed;
    };

    let refresh = focus_refresh_policy(model.active_server_id(), &server_id);
    model
        .focus_workspace_route(&server_id, &workspace_id)
        .api_request("client:workspace-focus")
        .map(|request| ClientInputDispatch::ApiRequest {
            server_id,
            refresh,
            request: Box::new(request),
        })
        .unwrap_or(ClientInputDispatch::Consumed)
}

/// #24: agent sibling of `step_workspace_focus`. Flattens `agent_groups()` (across servers, in
/// render order) into `(server_id, agent_id)` rows, steps ±1 with wraparound from the focused
/// agent, and routes through `focus_agent_route` -> ApiRequest like the mouse agent-click path.
fn step_agent_focus(
    model: &mut supervisor::ClientSupervisorModel,
    delta: isize,
) -> ClientInputDispatch {
    // Each connected server independently reports a `focused` agent, so several rows can be focused
    // at once. Anchor the step on the agent owned by the ACTIVE server (the one the user is on),
    // falling back to the first focused row — mirroring `step_workspace_focus`. (Without the
    // tie-break the anchor was whichever server reported last, so next/prev stepped from the wrong
    // agent when more than one server was connected.)
    let active_server = model.active_server_id().clone();
    let mut targets: Vec<(supervisor::ServerId, String)> = Vec::new();
    let mut focused_index = None;
    let mut active_focused_index = None;
    for group in model.agent_groups() {
        for agent in group.agents {
            if agent.focused {
                if focused_index.is_none() {
                    focused_index = Some(targets.len());
                }
                if active_focused_index.is_none() && group.server_id == active_server {
                    active_focused_index = Some(targets.len());
                }
            }
            targets.push((group.server_id.clone(), agent.agent_id));
        }
    }
    let current = active_focused_index.or(focused_index);

    let Some((server_id, agent_id)) = step_focus_target(&targets, current, delta) else {
        return ClientInputDispatch::Consumed;
    };

    let refresh = focus_refresh_policy(model.active_server_id(), &server_id);
    model
        .focus_agent_route(&server_id, &agent_id)
        .api_request("client:agent-focus")
        .map(|request| ClientInputDispatch::ApiRequest {
            server_id,
            refresh,
            request: Box::new(request),
        })
        .unwrap_or(ClientInputDispatch::Consumed)
}

/// #24: pick the `delta`-step neighbour (with wraparound) of `current` in `targets`. When nothing
/// is currently focused, a forward step lands on the first entry and a backward step on the last.
fn step_focus_target<T: Clone>(targets: &[T], current: Option<usize>, delta: isize) -> Option<T> {
    if targets.is_empty() {
        return None;
    }
    let len = targets.len() as isize;
    let base = match current {
        Some(idx) => idx as isize,
        // No focus yet: stepping forward starts at 0, backward at the last entry.
        None => {
            if delta >= 0 {
                -1
            } else {
                0
            }
        }
    };
    let next = ((base + delta) % len + len) % len;
    targets.get(next as usize).cloned()
}

/// #24: open the new-workspace picker the SAME way the New button does, mapping a single-destination
/// route straight to a create request and a multi-destination route to the picker overlay (Redraw).
fn open_new_workspace_picker_dispatch(
    model: &mut supervisor::ClientSupervisorModel,
) -> ClientInputDispatch {
    match model.open_new_workspace_picker() {
        route @ supervisor::NewWorkspaceRoute::CreateOn(_) => route
            .api_request("client:workspace-create")
            .map(|(server_id, request)| ClientInputDispatch::ApiRequest {
                server_id,
                refresh: ClientApiRefreshPolicy::Immediate,
                request: Box::new(request),
            })
            .unwrap_or(ClientInputDispatch::Consumed),
        supervisor::NewWorkspaceRoute::PickDestination(_) => ClientInputDispatch::Redraw,
        supervisor::NewWorkspaceRoute::Unavailable { .. } => ClientInputDispatch::Consumed,
    }
}

/// #24: which #23 overlay to open for the focused workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FocusedWorkspaceOverlay {
    Rename,
    Close,
}

/// #24: open the rename / confirm-close overlay (#23) for the currently focused workspace. The
/// supervisor's `open_rename_workspace` / `open_confirm_close_workspace` openers read the workspace
/// context menu, so this first opens that menu for the focused row (the SAME state a right-click
/// produces) and then promotes it to the requested overlay. The existing overlay key-gate then
/// handles typing / confirmation.
fn open_focused_workspace_overlay(
    model: &mut supervisor::ClientSupervisorModel,
    overlay: FocusedWorkspaceOverlay,
) -> ClientInputDispatch {
    let Some((server_id, workspace_id)) = model
        .workspace_rows()
        .into_iter()
        .find(|row| row.focused && row.workspace_id.is_some())
        .and_then(|row| row.workspace_id.map(|id| (row.server_id, id)))
    else {
        return ClientInputDispatch::Consumed;
    };
    let label = model
        .workspace_label(&server_id, &workspace_id)
        .unwrap_or_else(|| workspace_id.clone());
    // #24/#33: keyboard-opened (no cursor); the menu is immediately promoted to rename/close below
    // and never shown, so the anchor (and the group-collapse readout) is irrelevant — use (0, 0).
    model.open_workspace_context_menu(server_id, workspace_id, label, None, 0, 0);
    match overlay {
        FocusedWorkspaceOverlay::Rename => model.open_rename_workspace(),
        FocusedWorkspaceOverlay::Close => model.open_confirm_close_workspace(),
    }
    ClientInputDispatch::Redraw
}

/// Whether a dispatch is an actionable COMMAND the event loop must handle, vs. a presentation-only
/// outcome (`Redraw`/`HoverRedraw`/`Consumed`) that the input batcher can coalesce. EVERY host- and
/// workspace-menu action and server command MUST be listed here — one that is missing falls through
/// to the repaint-promotion and is silently dropped before it ever reaches the loop. That is exactly
/// how the host-menu `update` (`UpdateRemote`) did nothing from #44 until #61: it was produced and had
/// a loop handler, but was absent from this gate. Extracted as a named predicate so the routing set is
/// asserted by a unit test and a new menu action can't regress the same way.
fn dispatch_requires_loop_handling(dispatch: &ClientInputDispatch) -> bool {
    matches!(
        dispatch,
        ClientInputDispatch::AddRemote(_)
            | ClientInputDispatch::SetRemoteEnabled { .. }
            | ClientInputDispatch::SetRemoteAutoUpdate { .. }
            | ClientInputDispatch::SetRemoteSession { .. }
            | ClientInputDispatch::DeleteRemote { .. }
            | ClientInputDispatch::DisconnectRemote { .. }
            | ClientInputDispatch::ReconnectRemote { .. }
            | ClientInputDispatch::UpdateRemote { .. }
            | ClientInputDispatch::FetchWorktreeList { .. }
            | ClientInputDispatch::FetchSessionList { .. }
            | ClientInputDispatch::ToggleWorktreeGroup { .. }
            | ClientInputDispatch::ApiRequest { .. }
            | ClientInputDispatch::ServerControl { .. }
            | ClientInputDispatch::Resize { .. }
            | ClientInputDispatch::DetachAll
    )
}

fn dispatch_client_overlay_input(
    data: Vec<u8>,
    compositor: &mut compositor::ClientCompositor,
    model: &mut supervisor::ClientSupervisorModel,
    host_size: (u16, u16),
) -> ClientInputDispatch {
    let events = crate::raw_input::parse_raw_input_bytes_sync(&data);
    if events.is_empty() {
        return ClientInputDispatch::Consumed;
    }

    let mut dispatch = ClientInputDispatch::Consumed;
    for event in events {
        let next = match event {
            crate::raw_input::RawInputEvent::Key(key) if model.add_remote_form().is_some() => {
                match model.handle_add_remote_key(key) {
                    supervisor::AddRemoteFormOutcome::Redraw => ClientInputDispatch::Redraw,
                    supervisor::AddRemoteFormOutcome::Submit(draft) => {
                        ClientInputDispatch::AddRemote(draft)
                    }
                }
            }
            crate::raw_input::RawInputEvent::Paste(text) if model.add_remote_form().is_some() => {
                match model.append_add_remote_paste(&text) {
                    supervisor::AddRemoteFormOutcome::Redraw => ClientInputDispatch::Redraw,
                    supervisor::AddRemoteFormOutcome::Submit(draft) => {
                        ClientInputDispatch::AddRemote(draft)
                    }
                }
            }
            // #47: the one client menu (launcher / workspace / host) — a single key handler. Delegates
            // to `handle_client_menu_key` and maps its outcome through the SAME helper the mouse path
            // uses.
            crate::raw_input::RawInputEvent::Key(key) if model.client_menu().is_some() => {
                let outcome = model.handle_client_menu_key(key);
                dispatch_for_client_menu_outcome(model, outcome)
            }
            crate::raw_input::RawInputEvent::Key(key) if model.new_workspace_picker().is_some() => {
                dispatch_new_workspace_picker_key(model, key)
            }
            crate::raw_input::RawInputEvent::Key(key)
                if model.remote_manage_overlay().is_some() =>
            {
                dispatch_for_remote_manage_outcome(model.handle_remote_manage_key(key))
            }
            crate::raw_input::RawInputEvent::Key(key)
                if model.rename_workspace_form().is_some() =>
            {
                dispatch_for_rename_workspace_outcome(model.handle_rename_workspace_key(key))
            }
            crate::raw_input::RawInputEvent::Paste(text)
                if model.rename_workspace_form().is_some() =>
            {
                dispatch_for_rename_workspace_outcome(model.append_rename_workspace_paste(&text))
            }
            crate::raw_input::RawInputEvent::Key(key)
                if model.confirm_close_workspace().is_some() =>
            {
                dispatch_for_confirm_close_outcome(model.handle_confirm_close_workspace_key(key))
            }
            crate::raw_input::RawInputEvent::Key(key) if model.new_worktree_form().is_some() => {
                dispatch_for_new_worktree_outcome(model.handle_new_worktree_key(key))
            }
            crate::raw_input::RawInputEvent::Paste(text) if model.new_worktree_form().is_some() => {
                dispatch_for_new_worktree_outcome(model.append_new_worktree_paste(&text))
            }
            crate::raw_input::RawInputEvent::Key(key)
                if model.confirm_delete_worktree().is_some() =>
            {
                dispatch_for_confirm_delete_worktree_outcome(
                    model.handle_confirm_delete_worktree_key(key),
                )
            }
            crate::raw_input::RawInputEvent::Key(key) if model.worktree_picker().is_some() => {
                dispatch_for_worktree_picker_outcome(model.handle_worktree_picker_key(key))
            }
            // C5/C6: the session picker and its new-session input, routed exactly like the worktree
            // picker / rename form they mirror. The picker is listed FIRST because activating its
            // last row swaps the overlay to the input within one key press.
            crate::raw_input::RawInputEvent::Key(key) if model.session_picker().is_some() => {
                dispatch_for_session_picker_outcome(model.handle_session_picker_key(key))
            }
            crate::raw_input::RawInputEvent::Key(key) if model.new_session_form().is_some() => {
                dispatch_for_new_session_outcome(model.handle_new_session_key(key))
            }
            crate::raw_input::RawInputEvent::Paste(text) if model.new_session_form().is_some() => {
                dispatch_for_new_session_outcome(model.append_new_session_paste(&text))
            }
            crate::raw_input::RawInputEvent::Mouse(mouse) => {
                dispatch_composited_mouse_input(data.clone(), compositor, model, host_size, &mouse)
            }
            _ => ClientInputDispatch::Consumed,
        };

        if dispatch_requires_loop_handling(&next) {
            dispatch = next;
            break;
        }
        // Promote a repaint over the `Consumed` default. `Redraw` (a model/view change) wins over
        // `HoverRedraw` (#56: a presentation-only menu-selection move → recompose from the cached
        // shell + overlay, no rebuild) when both occur for one input batch.
        match next {
            ClientInputDispatch::Redraw => dispatch = ClientInputDispatch::Redraw,
            ClientInputDispatch::HoverRedraw
                if !matches!(dispatch, ClientInputDispatch::Redraw) =>
            {
                dispatch = ClientInputDispatch::HoverRedraw;
            }
            _ => {}
        }
    }
    dispatch
}

/// item 1: keyboard navigation for the composited new-workspace destination picker. ↑/k and ↓/j
/// move the highlight, Enter confirms the highlighted destination, Esc closes the picker.
fn dispatch_new_workspace_picker_key(
    model: &mut supervisor::ClientSupervisorModel,
    key: crate::input::TerminalKey,
) -> ClientInputDispatch {
    if !matches!(
        key.kind,
        crossterm::event::KeyEventKind::Press | crossterm::event::KeyEventKind::Repeat
    ) {
        return ClientInputDispatch::Consumed;
    }

    match key.code {
        KeyCode::Esc => {
            model.close_new_workspace_picker();
            ClientInputDispatch::Redraw
        }
        KeyCode::Up | KeyCode::Char('k') => {
            model.move_new_workspace_picker_prev();
            ClientInputDispatch::Redraw
        }
        KeyCode::Down | KeyCode::Char('j') => {
            model.move_new_workspace_picker_next();
            ClientInputDispatch::Redraw
        }
        KeyCode::Enter => accept_new_workspace_picker_dispatch(model),
        _ => ClientInputDispatch::Consumed,
    }
}

/// item 1: resolve the highlighted picker destination into a create-workspace API request, reusing
/// the same `NewWorkspaceRoute::api_request` mapping the mouse destination-row path uses. Shared by
/// the picker Enter key and the confirm button.
fn accept_new_workspace_picker_dispatch(
    model: &mut supervisor::ClientSupervisorModel,
) -> ClientInputDispatch {
    model
        .accept_new_workspace_picker()
        .api_request("client:workspace-create")
        .map(|(server_id, request)| ClientInputDispatch::ApiRequest {
            server_id,
            refresh: ClientApiRefreshPolicy::Immediate,
            request: Box::new(request),
        })
        .unwrap_or(ClientInputDispatch::Consumed)
}

fn dispatch_composited_mouse_input(
    data: Vec<u8>,
    compositor: &mut compositor::ClientCompositor,
    model: &mut supervisor::ClientSupervisorModel,
    host_size: (u16, u16),
    mouse: &MouseEvent,
) -> ClientInputDispatch {
    // #47: dragging ANY open overlay's top border repositions it. Handle it FIRST, ahead of every
    // other handler (menu select, form buttons, sidebar) — for ALL overlays (the three menus + the
    // add-remote / picker / manage / rename / confirm forms), one mechanism. A press anywhere but the
    // top border returns `None` and falls through to the normal handling below.
    if let Some(changed) = compositor.handle_overlay_drag(model, mouse, host_size.0, host_size.1) {
        return if changed {
            ClientInputDispatch::Redraw
        } else {
            ClientInputDispatch::Consumed
        };
    }

    // #46/#47: an open client menu (launcher / workspace / host) is MODAL — it renders topmost, so it
    // must be topmost in the EVENT pipeline too. Route every mouse event to it FIRST, ahead of the
    // sidebar motion/resize/scroll/reorder handlers below (which otherwise highlight rows UNDER the
    // menu on hover, wheel-scroll the sidebar beneath it, and let a divider-column click start a
    // resize instead of selecting). Now covers ALL three menus — the launcher used to have its own
    // ad-hoc hover arm and a non-modal click path, the gap #46 left.
    if model.client_menu_open() {
        return dispatch_open_client_menu_mouse(compositor, model, host_size, mouse);
    }

    // item 7 (Area 4): handle motion BEFORE resize/scroll/hit_test. The `hit_test` dispatch below
    // early-returns `Consumed` for any non-`Down(Left)` kind, so without this top-of-fn arm a
    // `Moved` over a sidebar row would never reach `hover_test`. Intercept only when over the
    // sidebar OR a hover is currently set (so leaving the sidebar clears it); otherwise fall
    // through so a content `Moved` still forwards its bytes via `translate_content_mouse_input`.
    // The `Redraw` arm recomposes locally (commit 3d47acd: no supervisor request, no server I/O).
    if matches!(mouse.kind, MouseEventKind::Moved) {
        // #71: gate hover interception on the collapse-aware width so content motion in the
        // mini↔expanded gap still forwards to the pane instead of being eaten as sidebar hover.
        let sidebar_width = compositor.effective_sidebar_width(host_size.0);
        if mouse.column < sidebar_width
            || compositor.hover().is_some()
            || compositor.has_pending_hover()
        {
            // #48: a hover change is presentation-only — a couple of highlighted cells, not a
            // model/view mutation. RECORD the latest motion position and defer the resolve to the
            // per-frame flush (latest-wins) instead of running `hover_test` here: resolving per
            // motion event rebuilt the O(hosts×agents) `from_model` snapshot every event, dropping a
            // fast sidebar sweep to <1fps (issue #48). `recompose_composited_frame` calls
            // `resolve_pending_hover` ONCE per frame. Still intercept while a hover is set OR pending
            // so a sweep that leaves the sidebar still resolves to `None` and clears the highlight.
            compositor.set_pending_hover_pos((mouse.column, mouse.row));
            return ClientInputDispatch::HoverRedraw;
        }
    }

    // #23: a right-click (Down, MouseButton::Right) over a workspace card opens the client-rendered
    // context menu anchored at that row, capturing the workspace's current label for the rename
    // prefill / close-confirm text. Resolved through the SAME `hit_test` the left-click path uses.
    if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Right)) {
        match compositor.hit_test(model, mouse.column, mouse.row, host_size.0, host_size.1) {
            Some(compositor::SidebarHitTarget::Workspace {
                server_id,
                workspace_id,
            }) => {
                let label = model
                    .workspace_label(&server_id, &workspace_id)
                    .unwrap_or_else(|| workspace_id.clone());
                // The expand/collapse row needs the group's CLIENT-LOCAL collapsed state, which
                // the compositor owns — capture it at open time so the baked label matches.
                let group_collapsed = model
                    .workspace_worktree_group(&server_id, &workspace_id)
                    .filter(|(_, is_linked, has_children)| !is_linked && *has_children)
                    .map(|(group_key, _, _)| compositor.space_key_is_collapsed(&group_key));
                model.open_workspace_context_menu(
                    server_id,
                    workspace_id,
                    label,
                    group_collapsed,
                    mouse.column,
                    mouse.row,
                );
                return ClientInputDispatch::Redraw;
            }
            // #43: a right-click on a host banner (its status glyph included) opens the host
            // context menu (add-space / enable-disable / disconnect-reconnect), anchored at the
            // cursor. The display name is captured so the menu's sub-header needs no second lookup.
            Some(
                compositor::SidebarHitTarget::HostBanner { server_id }
                | compositor::SidebarHitTarget::HostBannerGlyph { server_id },
            ) => {
                let display_name = model
                    .server_display_name(&server_id)
                    .unwrap_or_else(|| server_id.registry_id().to_string());
                model.open_host_context_menu(server_id, display_name, mouse.column, mouse.row);
                return ClientInputDispatch::Redraw;
            }
            _ => {}
        }
    }

    if let Some(outcome) = compositor.handle_sidebar_resize_mouse(
        mouse,
        host_size.0,
        host_size.1,
        model.ui_settings(),
        Instant::now(),
    ) {
        // #26: the outcome decides resize vs redraw — a drag or a double-click reset changes the
        // content width (resize the remote PTY); beginning/ending a drag only redraws.
        return match outcome {
            compositor::SidebarResizeOutcome::Resized(cols, rows) => {
                ClientInputDispatch::Resize { cols, rows }
            }
            compositor::SidebarResizeOutcome::Redraw => ClientInputDispatch::Redraw,
        };
    }

    // #16: the spaces↔agents section divider re-splits the sidebar locally (no content resize), so
    // it is checked after the width divider (which wins at the shared corner column) and always
    // redraws rather than resizing the remote PTY.
    if compositor
        .handle_sidebar_section_divider_mouse(model, mouse, host_size.0, host_size.1)
        .is_some()
    {
        return ClientInputDispatch::Redraw;
    }

    // #21: scrollbar track-click + thumb-drag (client-local). Runs before the wheel handler and
    // hit_test so a press on the scrollbar column scrolls instead of focusing the card beneath it.
    if let Some(changed) =
        compositor.handle_sidebar_scrollbar_mouse(model, mouse, host_size.0, host_size.1)
    {
        return if changed {
            ClientInputDispatch::Redraw
        } else {
            ClientInputDispatch::Consumed
        };
    }

    if let Some(changed) =
        compositor.handle_sidebar_scroll_mouse(model, mouse, host_size.0, host_size.1)
    {
        return if changed {
            ClientInputDispatch::Redraw
        } else {
            ClientInputDispatch::Consumed
        };
    }

    // #19: workspace drag-to-reorder. `Drag`/`Up` over the sidebar are otherwise swallowed by the
    // sidebar-width guard below, so the tracker runs before `hit_test` (which only acts on
    // `Down(Left)` anyway). The `Down` that arms the press is recorded in the Workspace hit arm
    // below, where the click still focuses-on-down.
    match compositor.handle_workspace_reorder_mouse(model, mouse, host_size.0, host_size.1) {
        compositor::WorkspaceReorderOutcome::Dragging => return ClientInputDispatch::Redraw,
        compositor::WorkspaceReorderOutcome::Commit {
            server_id,
            workspace_id,
            insert_index,
        } => {
            return ClientInputDispatch::ApiRequest {
                server_id,
                // Reorder changes persisted server state; refresh the fleet so the new order shows.
                refresh: ClientApiRefreshPolicy::Immediate,
                request: Box::new(crate::api::schema::Request {
                    id: "client:workspace-reorder".into(),
                    method: crate::api::schema::Method::WorkspaceReorder(
                        crate::api::schema::WorkspaceReorderParams {
                            workspace_id,
                            insert_index,
                        },
                    ),
                }),
            };
        }
        // Cancelled only fires after an actual drag (plain clicks return Ignored), so the prior
        // Dragging frames painted a drop indicator. Redraw to clear it — Consumed schedules no frame.
        compositor::WorkspaceReorderOutcome::Cancelled => return ClientInputDispatch::Redraw,
        compositor::WorkspaceReorderOutcome::Ignored => {}
    }

    // #19 (host half): host drag-to-reorder. Runs alongside the workspace tracker, before
    // hit_test, for the same reason (Drag/Up over the sidebar are otherwise swallowed). The
    // commit is CLIENT-LOCAL: host order is client-owned, so it mutates the model and redraws
    // with no server round-trip (contrast with workspace.reorder above).
    match compositor.handle_host_reorder_mouse(model, mouse, host_size.0, host_size.1) {
        compositor::HostReorderOutcome::Dragging => return ClientInputDispatch::Redraw,
        compositor::HostReorderOutcome::Commit {
            source_server_id,
            insert_index,
        } => {
            model.reorder_server(&source_server_id, insert_index);
            return ClientInputDispatch::Redraw;
        }
        // Cancelled only fires after an actual drag (plain clicks return Ignored), so the prior
        // Dragging frames painted a host drop indicator. Redraw to clear it — Consumed schedules none.
        compositor::HostReorderOutcome::Cancelled => return ClientInputDispatch::Redraw,
        compositor::HostReorderOutcome::Ignored => {}
    }

    if let Some(target) =
        compositor.hit_test(model, mouse.column, mouse.row, host_size.0, host_size.1)
    {
        // #20: the scope toggle mutates client-local compositor state (no server round-trip), so it
        // is handled here where `&mut compositor` is in scope rather than in the model-only
        // `dispatch_sidebar_hit_target`.
        if matches!(target, compositor::SidebarHitTarget::AgentScopeToggle) {
            return if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
                compositor.toggle_agent_panel_scope();
                ClientInputDispatch::Redraw
            } else {
                ClientInputDispatch::Consumed
            };
        }
        // #25: the collapse/expand toggle mutates client-local compositor state (no server round-
        // trip), so it is handled here where `&mut compositor` is in scope (like the scope toggle).
        if matches!(target, compositor::SidebarHitTarget::CollapsedSidebarToggle) {
            return if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
                compositor.toggle_sidebar_collapsed();
                // #58: defer the render to the single collapse tick (which renders the FINAL width +
                // emits the resize) instead of redrawing the pre-toggle width first — that wasted a
                // full build_shell per collapse on the UI loop.
                ClientInputDispatch::Consumed
            } else {
                ClientInputDispatch::Consumed
            };
        }
        // #22: a chevron click toggles the worktree group's collapsed state in the client-local set
        // (no server round-trip — the aggregated view's collapse is a per-client display concern).
        // Handled here where `&mut compositor` is in scope (like the scope / collapse toggles).
        if let compositor::SidebarHitTarget::WorktreeChevron { group_key } = &target {
            return if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
                compositor.toggle_collapsed_space_key(group_key.clone());
                ClientInputDispatch::Redraw
            } else {
                ClientInputDispatch::Consumed
            };
        }
        // #19: arm a drag-reorder on a workspace down-press. The click still focuses-on-down via
        // `dispatch_sidebar_hit_target` below; a subsequent drag promotes the press to a reorder.
        if let compositor::SidebarHitTarget::Workspace {
            server_id,
            workspace_id,
        } = &target
        {
            // #41: only arm a drag-reorder on a space the client can actually move. A worktree-
            // grouped space is regrouped under its parent on render, so a storage reorder would be a
            // visual no-op — arming it painted a drop indicator that "did nothing" on release. Skip
            // the press for grouped spaces (matching the monolithic `worktree_space().is_none()`
            // guard); the click still focuses-on-down via `dispatch_sidebar_hit_target` below.
            if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left))
                && model.workspace_is_reorderable(server_id, workspace_id)
            {
                compositor.begin_workspace_press(
                    server_id.clone(),
                    workspace_id.clone(),
                    mouse.column,
                    mouse.row,
                );
            }
        }
        // #19 (host half): arm a host drag-reorder on a host-banner down-press. A subsequent drag
        // promotes it to a reorder (committed client-locally); a plain click just consumes (the
        // banner is the host's drag handle). Mirrors the workspace press above.
        if let compositor::SidebarHitTarget::HostBanner { server_id } = &target {
            if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
                compositor.begin_host_press(server_id.clone(), mouse.column, mouse.row);
            }
        }
        return dispatch_sidebar_hit_target(target, model, mouse);
    }

    // #71: consume/translate against the collapse-aware origin — the resting width consumed every
    // click in the (mini..expanded) column gap and offset every forwarded content click while the
    // sidebar was collapsed or mid-slide.
    let sidebar_width = compositor.effective_sidebar_width(host_size.0);
    if mouse.column < sidebar_width {
        return ClientInputDispatch::Consumed;
    }

    translate_content_mouse_input(data, mouse, sidebar_width)
}

/// #46/#47: mouse handling for the one OPEN client menu (launcher / workspace / host). Called from
/// the top of `dispatch_composited_mouse_input` before any sidebar handler, so the modal menu owns
/// the whole host rect. Motion highlights the hovered row (the sidebar hover path never knew about
/// the menu, so hover used to highlight NOTHING on it); a left-press on a row selects it; any other
/// press dismisses the menu and is CONSUMED (it must NOT leak to the pane underneath). Geometry comes
/// from the SAME `hit_test` the open render uses, so hover/select line up with the painted rows. This
/// is ONE handler for all three menus — the launcher gets the same modal treatment as the two
/// context menus (its old ad-hoc hover/click paths are gone).
fn dispatch_open_client_menu_mouse(
    compositor: &mut compositor::ClientCompositor,
    model: &mut supervisor::ClientSupervisorModel,
    host_size: (u16, u16),
    mouse: &MouseEvent,
) -> ClientInputDispatch {
    // #47: top-border drag-to-move is handled at the top of `dispatch_composited_mouse_input` (for
    // ALL overlays, before this menu-modal path), so a title-row press never reaches here.
    let target = compositor.hit_test(model, mouse.column, mouse.row, host_size.0, host_size.1);
    match mouse.kind {
        MouseEventKind::Moved => match target {
            Some(compositor::SidebarHitTarget::ClientMenuRow { index }) => {
                if model.client_menu().map(|m| m.selected) == Some(index) {
                    ClientInputDispatch::Consumed
                } else {
                    model.set_client_menu_selected(index);
                    // #56: moving the highlighted menu row is a presentation-only change of a couple
                    // of cells — route it to the lightweight `HoverRedraw` path (recompose from the
                    // cached hover-less shell + repaint the selected row via the overlay) instead of
                    // the `Redraw` sledgehammer that rebuilt the whole shell behind the menu (#55).
                    ClientInputDispatch::HoverRedraw
                }
            }
            // Motion off the rows leaves the highlight where it is — a hover OUTSIDE the menu does
            // not dismiss it (only a press does).
            _ => ClientInputDispatch::Consumed,
        },
        MouseEventKind::Down(MouseButton::Left) => match target {
            Some(row_target @ compositor::SidebarHitTarget::ClientMenuRow { .. }) => {
                dispatch_sidebar_hit_target(row_target, model, mouse)
            }
            // A left-press that misses every row is an outside-click → dismiss + consume (never
            // forward to the pane beneath, which the old `None` fall-through did for content clicks).
            _ => {
                model.close_client_overlay();
                ClientInputDispatch::Redraw
            }
        },
        // C4: "해당 세션 이름에서 우클릭하면" — a right/middle press on the session ROW ACTIVATES it
        // (the same path the left-click arm takes) instead of dismissing. Keyed off the row's BAKED
        // action, not its index, so adding menu rows can't move the exception onto another row.
        // Every other row keeps the dismiss-on-right-click behaviour.
        MouseEventKind::Down(_) => {
            if let Some(compositor::SidebarHitTarget::ClientMenuRow { index }) = target {
                if client_menu_row_opens_session_picker(model, index) {
                    model.set_client_menu_selected(index);
                    let outcome = model.select_client_menu_item(index);
                    return dispatch_for_client_menu_outcome(model, outcome);
                }
            }
            model.close_client_overlay();
            ClientInputDispatch::Redraw
        }
        // Drags / wheel / button-ups over the open menu are swallowed (the modal owns the rect).
        _ => ClientInputDispatch::Consumed,
    }
}

/// C4: whether menu row `index` is the one whose baked action opens the session picker — the only
/// row a right-click ACTIVATES rather than dismissing on.
fn client_menu_row_opens_session_picker(
    model: &supervisor::ClientSupervisorModel,
    index: usize,
) -> bool {
    model.client_menu().is_some_and(|menu| {
        menu.items.get(index).is_some_and(|item| {
            item.selectable
                && matches!(item.action, supervisor::ClientMenuAction::OpenSessionPicker)
        })
    })
}

/// item 6 (Area 6): the refresh policy for a focus dispatch. A focus that switches the active
/// server returns `ImmediateFocused` (fire a targeted single-server fetch so the new server
/// reconciles within one round-trip). A focus that stays on the already-active server returns
/// `Deferred` — the active remote's 400ms fast poll already covers it, so an extra immediate
/// fetch would be redundant SSH load. `current_active` is read BEFORE the focus route mutates it.
fn focus_refresh_policy(
    current_active: &supervisor::ServerId,
    target_server: &supervisor::ServerId,
) -> ClientApiRefreshPolicy {
    if current_active == target_server {
        ClientApiRefreshPolicy::Deferred
    } else {
        ClientApiRefreshPolicy::ImmediateFocused
    }
}

fn dispatch_sidebar_hit_target(
    target: compositor::SidebarHitTarget,
    model: &mut supervisor::ClientSupervisorModel,
    mouse: &MouseEvent,
) -> ClientInputDispatch {
    if !matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
        return ClientInputDispatch::Consumed;
    }

    match target {
        compositor::SidebarHitTarget::Filter => {
            model.cycle_filter();
            ClientInputDispatch::Redraw
        }
        compositor::SidebarHitTarget::Workspace {
            server_id,
            workspace_id,
        } => {
            // item 6 (Area 6): focusing a row that SWITCHES the active server fires a targeted
            // single-server fetch (`ImmediateFocused`) so the new server reconciles within one
            // round-trip. Re-focusing within the already-active server needs no extra immediate
            // fetch — the active remote's 400ms fast poll already covers it — so it carries the
            // `Deferred` (no-refresh) policy.
            let refresh = focus_refresh_policy(model.active_server_id(), &server_id);
            model
                .focus_workspace_route(&server_id, &workspace_id)
                .api_request("client:workspace-focus")
                .map(|request| ClientInputDispatch::ApiRequest {
                    server_id,
                    refresh,
                    request: Box::new(request),
                })
                .unwrap_or(ClientInputDispatch::Consumed)
        }
        compositor::SidebarHitTarget::Agent {
            server_id,
            agent_id,
        } => {
            let refresh = focus_refresh_policy(model.active_server_id(), &server_id);
            model
                .focus_agent_route(&server_id, &agent_id)
                .api_request("client:agent-focus")
                .map(|request| ClientInputDispatch::ApiRequest {
                    server_id,
                    refresh,
                    request: Box::new(request),
                })
                .unwrap_or(ClientInputDispatch::Consumed)
        }
        compositor::SidebarHitTarget::New => match model.open_new_workspace_picker() {
            route @ supervisor::NewWorkspaceRoute::CreateOn(_) => route
                .api_request("client:workspace-create")
                .map(|(server_id, request)| ClientInputDispatch::ApiRequest {
                    server_id,
                    refresh: ClientApiRefreshPolicy::Immediate,
                    request: Box::new(request),
                })
                .unwrap_or(ClientInputDispatch::Consumed),
            supervisor::NewWorkspaceRoute::PickDestination(_) => ClientInputDispatch::Redraw,
            supervisor::NewWorkspaceRoute::Unavailable { .. } => ClientInputDispatch::Consumed,
        },
        compositor::SidebarHitTarget::NewWorkspaceDestination { server_id } => model
            .choose_new_workspace_destination(&server_id)
            .api_request("client:workspace-create")
            .map(|(server_id, request)| ClientInputDispatch::ApiRequest {
                server_id,
                refresh: ClientApiRefreshPolicy::Immediate,
                request: Box::new(request),
            })
            .unwrap_or(ClientInputDispatch::Consumed),
        // #47: a click on a row of the open client menu selects AND activates it, through the SAME
        // `select_client_menu_item` + outcome dispatch the keyboard Enter path uses. Reached from the
        // modal mouse handler (`dispatch_open_client_menu_mouse`).
        compositor::SidebarHitTarget::ClientMenuRow { index } => {
            model.set_client_menu_selected(index);
            let outcome = model.select_client_menu_item(index);
            dispatch_for_client_menu_outcome(model, outcome)
        }
        // #47: the sidebar "menu" button opens the global launcher menu, anchored at the clicked cell
        // so the popup floats from the button (clamped to screen). It is modal once open.
        compositor::SidebarHitTarget::Menu => {
            model.open_client_global_menu(mouse.column, mouse.row);
            ClientInputDispatch::Redraw
        }
        // #20: handled earlier in `dispatch_composited_mouse_input` (needs `&mut compositor`); this
        // arm only keeps the match exhaustive and is not reached in practice.
        compositor::SidebarHitTarget::AgentScopeToggle => ClientInputDispatch::Consumed,
        // #25: handled earlier in `dispatch_composited_mouse_input` (needs `&mut compositor`); this
        // arm only keeps the match exhaustive and is not reached in practice.
        compositor::SidebarHitTarget::CollapsedSidebarToggle => ClientInputDispatch::Consumed,
        // #22: handled earlier in `dispatch_composited_mouse_input` (needs `&mut compositor`); this
        // arm only keeps the match exhaustive and is not reached in practice.
        compositor::SidebarHitTarget::WorktreeChevron { .. } => ClientInputDispatch::Consumed,
        // #19 (host half): a host-banner press arms a host drag-reorder in
        // `dispatch_composited_mouse_input` (needs `&mut compositor`); the click itself focuses the
        // host's first workspace there too. This arm only keeps the match exhaustive.
        compositor::SidebarHitTarget::HostBanner { .. } => ClientInputDispatch::Consumed,
        // A left-press on the banner's status glyph RETRIES a down host (the affordance the
        // provisioning-failure sub-line points at); on a connected host it behaves like the
        // plain banner (consume).
        compositor::SidebarHitTarget::HostBannerGlyph { server_id } => {
            if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left))
                && model.server_is_reconnectable(&server_id)
            {
                ClientInputDispatch::ReconnectRemote { server_id }
            } else {
                ClientInputDispatch::Consumed
            }
        }
        // item 1: composited-modal action buttons.
        compositor::SidebarHitTarget::AddRemoteSubmit => {
            // re-run the SAME empty-target validation as the Enter key by replaying an Enter
            // through `handle_add_remote_key`; an empty target yields the inline error (Redraw),
            // a valid target yields the submit draft.
            match model.handle_add_remote_key(enter_key()) {
                supervisor::AddRemoteFormOutcome::Redraw => ClientInputDispatch::Redraw,
                supervisor::AddRemoteFormOutcome::Submit(draft) => {
                    ClientInputDispatch::AddRemote(draft)
                }
            }
        }
        compositor::SidebarHitTarget::AddRemoteCancel => {
            model.close_client_overlay();
            ClientInputDispatch::Redraw
        }
        compositor::SidebarHitTarget::NewWorkspacePickerConfirm => {
            accept_new_workspace_picker_dispatch(model)
        }
        compositor::SidebarHitTarget::NewWorkspacePickerCancel => {
            model.close_new_workspace_picker();
            ClientInputDispatch::Redraw
        }
        // item 3 (Area 5): manage-overlay mouse targets. A row click selects it (toggle/delete are
        // keyboard-driven); `add` jumps to the add-remote form; the confirm popup buttons confirm
        // or cancel the two-step delete.
        compositor::SidebarHitTarget::RemoteManageRow { index } => {
            model.set_remote_manage_selected(index);
            ClientInputDispatch::Redraw
        }
        compositor::SidebarHitTarget::RemoteManageAdd => {
            model.open_add_remote_form();
            ClientInputDispatch::Redraw
        }
        compositor::SidebarHitTarget::RemoteManageConfirmDelete => {
            dispatch_for_remote_manage_outcome(model.confirm_remote_manage_delete())
        }
        compositor::SidebarHitTarget::RemoteManageCancelDelete => {
            model.cancel_remote_manage_delete();
            ClientInputDispatch::Redraw
        }
        // #23: the rename submit/cancel and confirm close/cancel buttons replay the SAME paths the
        // keys use. (The workspace menu ROW itself is now `ClientMenuRow`, handled above.)
        compositor::SidebarHitTarget::RenameWorkspaceSubmit => {
            // replay an Enter through the rename key handler so the BUTTON re-runs the exact same
            // empty-label validation / submit path as the Enter KEY (mirrors AddRemoteSubmit).
            dispatch_for_rename_workspace_outcome(model.handle_rename_workspace_key(enter_key()))
        }
        compositor::SidebarHitTarget::RenameWorkspaceCancel => {
            model.close_client_overlay();
            ClientInputDispatch::Redraw
        }
        compositor::SidebarHitTarget::ConfirmCloseWorkspaceConfirm => {
            dispatch_for_confirm_close_outcome(model.accept_confirm_close_workspace())
        }
        compositor::SidebarHitTarget::ConfirmCloseWorkspaceCancel => {
            model.close_client_overlay();
            ClientInputDispatch::Redraw
        }
        // C5: "클릭해서 선택할수 있고" — a click on a picker row runs the SAME
        // `select_session_picker_row` path the Enter key takes (including the trailing
        // `new session…` row, which promotes into the C6 input).
        compositor::SidebarHitTarget::SessionPickerRow { index } => {
            model.set_session_picker_selected(index);
            dispatch_for_session_picker_outcome(model.select_session_picker_row(index))
        }
        // C6: the new-session buttons replay the SAME paths the keys use — the submit button
        // re-runs the exact validation of the Enter KEY (mirrors RenameWorkspaceSubmit).
        compositor::SidebarHitTarget::NewSessionSubmit => {
            dispatch_for_new_session_outcome(model.handle_new_session_key(enter_key()))
        }
        compositor::SidebarHitTarget::NewSessionCancel => {
            model.close_client_overlay();
            ClientInputDispatch::Redraw
        }
    }
}

/// item 1: a synthetic Enter key-press, used so the add-remote submit BUTTON re-runs the exact
/// same validation/submit path as the Enter KEY in `handle_add_remote_key`.
fn enter_key() -> crate::input::TerminalKey {
    crate::input::TerminalKey::new(KeyCode::Enter, KeyModifiers::empty())
}

/// #23: map a `RenameWorkspaceOutcome` into a dispatch. `Submit` becomes a `workspace.rename`
/// round-trip to the OWNING server with an `Immediate` refresh so the renamed row reconciles on
/// the next summary; `Redraw` just repaints. Mirrors `dispatch_for_remote_manage_outcome`.
fn dispatch_for_rename_workspace_outcome(
    outcome: supervisor::RenameWorkspaceOutcome,
) -> ClientInputDispatch {
    match outcome {
        supervisor::RenameWorkspaceOutcome::Redraw => ClientInputDispatch::Redraw,
        supervisor::RenameWorkspaceOutcome::Submit {
            server_id,
            workspace_id,
            label,
        } => ClientInputDispatch::ApiRequest {
            server_id,
            refresh: ClientApiRefreshPolicy::Immediate,
            request: Box::new(crate::api::schema::Request {
                id: "client:workspace-rename".into(),
                method: crate::api::schema::Method::WorkspaceRename(
                    crate::api::schema::WorkspaceRenameParams {
                        workspace_id,
                        label,
                    },
                ),
            }),
        },
    }
}

/// #23: map a `ConfirmCloseOutcome` into a dispatch. `Confirm` becomes a `workspace.close`
/// round-trip to the OWNING server with an `Immediate` refresh so the closed row disappears on the
/// next summary; `Redraw` just repaints.
fn dispatch_for_confirm_close_outcome(
    outcome: supervisor::ConfirmCloseOutcome,
) -> ClientInputDispatch {
    match outcome {
        supervisor::ConfirmCloseOutcome::Redraw => ClientInputDispatch::Redraw,
        supervisor::ConfirmCloseOutcome::Confirm {
            server_id,
            workspace_id,
        } => ClientInputDispatch::ApiRequest {
            server_id,
            refresh: ClientApiRefreshPolicy::Immediate,
            request: Box::new(crate::api::schema::Request {
                id: "client:workspace-close".into(),
                method: crate::api::schema::Method::WorkspaceClose(
                    crate::api::schema::WorkspaceTarget { workspace_id },
                ),
            }),
        },
    }
}

/// Worktree-menu parity: map a `NewWorktreeOutcome` into a dispatch. `Submit` becomes a
/// `worktree.create` round-trip to the OWNING server (focus the new space) with an `Immediate`
/// refresh so the new row appears on the next summary.
fn dispatch_for_new_worktree_outcome(
    outcome: supervisor::NewWorktreeOutcome,
) -> ClientInputDispatch {
    match outcome {
        supervisor::NewWorktreeOutcome::Redraw => ClientInputDispatch::Redraw,
        supervisor::NewWorktreeOutcome::Submit {
            server_id,
            workspace_id,
            branch,
        } => ClientInputDispatch::ApiRequest {
            server_id,
            refresh: ClientApiRefreshPolicy::Immediate,
            request: Box::new(crate::api::schema::Request {
                id: "client:worktree-create".into(),
                method: crate::api::schema::Method::WorktreeCreate(
                    crate::api::schema::WorktreeCreateParams {
                        workspace_id: Some(workspace_id),
                        branch: Some(branch),
                        focus: true,
                        ..Default::default()
                    },
                ),
            }),
        },
    }
}

/// Worktree-menu parity: map a `ConfirmDeleteWorktreeOutcome` into a `worktree.remove`
/// round-trip to the OWNING server (closes the space and deletes the linked checkout).
fn dispatch_for_confirm_delete_worktree_outcome(
    outcome: supervisor::ConfirmDeleteWorktreeOutcome,
) -> ClientInputDispatch {
    match outcome {
        supervisor::ConfirmDeleteWorktreeOutcome::Redraw => ClientInputDispatch::Redraw,
        supervisor::ConfirmDeleteWorktreeOutcome::Confirm {
            server_id,
            workspace_id,
        } => ClientInputDispatch::ApiRequest {
            server_id,
            refresh: ClientApiRefreshPolicy::Immediate,
            request: Box::new(crate::api::schema::Request {
                id: "client:worktree-remove".into(),
                method: crate::api::schema::Method::WorktreeRemove(
                    crate::api::schema::WorktreeRemoveParams {
                        workspace_id,
                        force: false,
                    },
                ),
            }),
        },
    }
}

/// Worktree-menu parity: map a `WorktreePickerOutcome` into a `worktree.open` round-trip to the
/// OWNING server (opens the picked checkout as a space and focuses it).
fn dispatch_for_worktree_picker_outcome(
    outcome: supervisor::WorktreePickerOutcome,
) -> ClientInputDispatch {
    match outcome {
        supervisor::WorktreePickerOutcome::Redraw => ClientInputDispatch::Redraw,
        supervisor::WorktreePickerOutcome::Open {
            server_id,
            workspace_id,
            path,
        } => ClientInputDispatch::ApiRequest {
            server_id,
            refresh: ClientApiRefreshPolicy::Immediate,
            request: Box::new(crate::api::schema::Request {
                id: "client:worktree-open".into(),
                method: crate::api::schema::Method::WorktreeOpen(
                    crate::api::schema::WorktreeOpenParams {
                        workspace_id: Some(workspace_id),
                        path: Some(path),
                        focus: true,
                        ..Default::default()
                    },
                ),
            }),
        },
    }
}

fn translate_content_mouse_input(
    original: Vec<u8>,
    mouse: &MouseEvent,
    sidebar_width: u16,
) -> ClientInputDispatch {
    let Some(column) = mouse.column.checked_sub(sidebar_width) else {
        return ClientInputDispatch::Consumed;
    };

    let encoded = match mouse.kind {
        MouseEventKind::ScrollUp
        | MouseEventKind::ScrollDown
        | MouseEventKind::ScrollLeft
        | MouseEventKind::ScrollRight => crate::input::encode_mouse_scroll(
            mouse.kind,
            column,
            mouse.row,
            mouse.modifiers,
            crate::input::MouseProtocolEncoding::Sgr,
        ),
        MouseEventKind::Down(_) | MouseEventKind::Up(_) | MouseEventKind::Drag(_) => {
            crate::input::encode_mouse_button(
                mouse.kind,
                column,
                mouse.row,
                mouse.modifiers,
                crate::input::MouseProtocolEncoding::Sgr,
            )
        }
        // #31: re-encode buttonless motion with the content-translated column too (SGR motion).
        // Forwarding `original` here leaked the host column (off by the sidebar width) to apps
        // using any-event mouse tracking (?1003h).
        MouseEventKind::Moved => crate::input::encode_mouse_button(
            mouse.kind,
            column,
            mouse.row,
            mouse.modifiers,
            crate::input::MouseProtocolEncoding::Sgr,
        ),
    };

    ClientInputDispatch::Forward(encoded.unwrap_or(original))
}

impl ClientState {
    fn request_full_redraw(&mut self) {
        self.blit_encoder = render_ansi::BlitEncoder::new();
        // #45: a full repaint is requested precisely when the sidebar model/view changed too (every
        // such event handler calls this). Drop the cached shell so the next compose rebuilds it —
        // otherwise a reused content frame would paint a stale sidebar over fresh model state.
        self.shell_cache = None;
        #[cfg(windows)]
        {
            self.pending_cursor_reveal = None;
        }
    }

    /// #56: the lightweight redraw for a HOVER / open-menu-selection change (a presentation-only
    /// highlight of a couple of cells). It preserves BOTH the cached shell AND the blit diff
    /// baseline:
    ///
    /// - The shell is rendered hover-less (#56), so it stays valid across hover changes — the
    ///   highlight is painted per-frame by `apply_hover_overlay`, not baked into the shell. Keeping
    ///   the cache means a hover NEVER triggers the O(hosts×agents) `build_shell` rebuild that made
    ///   hover lag scale with the fleet (the #48 fix still rebuilt the shell; #56 removes that).
    /// - The blit encoder is NOT reset, so the next frame writes only the ~2 changed rows to the
    ///   terminal instead of re-encoding + flushing the whole screen (the original #48 win).
    ///
    /// All it does is mark a coalesced repaint pending (latest-wins): the actual recompose is
    /// deferred to the frame-budget deadline and flushed by
    /// `recompose_composited_frame(state, /*rebuild=*/false)` — content + hover overlay from the SAME
    /// cached hover-less shell. It deliberately touches NEITHER cache (that is the whole point).
    fn request_hover_redraw(&mut self) {
        self.pending_hover_render = true;
    }

    #[cfg(windows)]
    fn update_pending_cursor_reveal(&mut self, reveal: Option<Vec<u8>>) {
        const CURSOR_REVEAL_DEBOUNCE: Duration = Duration::from_millis(90);
        self.pending_cursor_reveal = reveal.map(|bytes| PendingCursorReveal {
            due_at: Instant::now() + CURSOR_REVEAL_DEBOUNCE,
            bytes,
        });
    }

    #[cfg(windows)]
    fn flush_pending_cursor_reveal_if_due(&mut self) {
        let Some(pending) = &self.pending_cursor_reveal else {
            return;
        };
        if pending.due_at > Instant::now() {
            return;
        }

        let pending = self
            .pending_cursor_reveal
            .take()
            .expect("pending cursor reveal");
        let mut stdout = io::stdout();
        let _ = stdout.write_all(&pending.bytes);
        let _ = stdout.flush();
    }
}

fn client_render_plan(
    supervisor_model: Option<&supervisor::ClientSupervisorModel>,
    requested_encoding: RenderEncoding,
    host_size: (u16, u16),
) -> ClientRenderPlan {
    let use_client_compositor = supervisor_model.is_some();
    if use_client_compositor {
        let compositor = compositor::ClientCompositor::default();
        return ClientRenderPlan {
            surface_mode: ClientSurfaceMode::EmbeddedContent,
            requested_encoding: RenderEncoding::SemanticFrame,
            server_size: compositor.content_size(host_size.0, host_size.1),
            use_client_compositor,
        };
    }

    ClientRenderPlan {
        surface_mode: ClientSurfaceMode::FullApp,
        requested_encoding,
        server_size: host_size,
        use_client_compositor: false,
    }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/// Errors that can occur during client operation.
#[derive(Debug)]
pub enum ClientError {
    /// Could not connect to the server's client socket.
    ConnectionFailed(io::Error),
    /// Server rejected our handshake.
    HandshakeRejected { version: u32, error: String },
    /// Server shut down.
    ServerShutdown { reason: Option<String> },
    /// Lost connection to the server.
    ConnectionLost(io::Error),
    /// Protocol error (framing, deserialization).
    Protocol(protocol::FramingError),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::ConnectionFailed(err) => {
                write!(f, "failed to connect to server: {err}")?;
                let path = client_socket_path();
                write!(
                    f,
                    "\nIs herdr server running? Start it with `herdr server`."
                )?;
                write!(f, "\nSocket path: {}", path.display())
            }
            ClientError::HandshakeRejected { version, error } => {
                write!(f, "server rejected handshake (version {version}): {error}")
            }
            ClientError::ServerShutdown { reason } => {
                match reason.as_deref() {
                    Some("detached") => {
                        if let Ok(reattach_command) =
                            std::env::var(crate::remote::REATTACH_COMMAND_ENV_VAR)
                        {
                            write!(f, "detached from remote server")?;
                            write!(f, "\nRun `{reattach_command}` to reattach")?;
                        } else {
                            write!(f, "detached from server")?;
                            write!(
                                f,
                                "\nRun `{}` to reattach",
                                crate::session::local_attach_command()
                            )?;
                        }
                    }
                    _ => {
                        write!(f, "server shut down")?;
                        if let Some(reason) = reason {
                            write!(f, ": {reason}")?;
                        }
                    }
                }
                Ok(())
            }
            ClientError::ConnectionLost(err) => {
                write!(f, "lost connection to server: {err}")
            }
            ClientError::Protocol(err) => {
                write!(f, "protocol error: {err}")
            }
        }
    }
}

impl std::error::Error for ClientError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ClientError::ConnectionFailed(err) => Some(err),
            ClientError::ConnectionLost(err) => Some(err),
            ClientError::Protocol(err) => Some(err),
            _ => None,
        }
    }
}

impl From<protocol::FramingError> for ClientError {
    fn from(err: protocol::FramingError) -> Self {
        ClientError::Protocol(err)
    }
}

// ---------------------------------------------------------------------------
// Terminal setup / restore
// ---------------------------------------------------------------------------

/// Sets up the terminal for client mode (raw mode, optional mouse, keyboard enhancements).
///
/// Returns a guard that restores the terminal when dropped.
fn setup_terminal(mouse_capture: bool) -> io::Result<TerminalGuard> {
    setup_terminal_with_capabilities(true, mouse_capture)
}

/// Sets up a direct attach terminal.
///
/// Direct attach forwards stdin to the attached PTY. It enables mouse capture
/// so wheel events can drive the attached viewport or be forwarded to child
/// programs that requested mouse input.
fn setup_direct_attach_terminal() -> io::Result<TerminalGuard> {
    setup_terminal_with_capabilities(false, true)
}

fn setup_terminal_with_capabilities(
    enable_client_protocols: bool,
    mouse_capture: bool,
) -> io::Result<TerminalGuard> {
    ratatui::init();

    if enable_client_protocols {
        if mouse_capture {
            set_mouse_capture(true)?;
        } else {
            set_mouse_capture(false)?;
        }
        execute!(io::stdout(), EnableBracketedPaste, EnableFocusChange)?;
        push_keyboard_enhancement_flags()?;
    } else if mouse_capture {
        set_mouse_capture(true)?;
    } else {
        set_mouse_capture(false)?;
    }

    let modify_other_keys_mode = enable_client_protocols
        .then(crate::input::host_modify_other_keys_mode)
        .flatten();
    if let Some(mode) = modify_other_keys_mode {
        io::stdout().write_all(mode.set_sequence())?;
        io::stdout().flush()?;
    }

    Ok(TerminalGuard {
        reset_modify_other_keys: modify_other_keys_mode.is_some(),
    })
}

/// Guard that restores the terminal when dropped.
struct TerminalGuard {
    reset_modify_other_keys: bool,
}

fn write_terminal_restore_postlude(writer: &mut impl io::Write) -> io::Result<()> {
    // Restore a visible cursor and reset DECSCUSR back to the terminal default.
    writer.write_all(b"\x1b[?25h\x1b[0 q")?;
    writer.flush()
}

/// Process-wide mirror of the host mouse-capture state, shared with the stdin reader so it can
/// drop SGR mouse sequences whenever capture is off (upstream aa0768b, adapted to the mx client).
fn host_mouse_capture_flag() -> std::sync::Arc<std::sync::atomic::AtomicBool> {
    static FLAG: std::sync::OnceLock<std::sync::Arc<std::sync::atomic::AtomicBool>> =
        std::sync::OnceLock::new();
    FLAG.get_or_init(|| std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)))
        .clone()
}

fn set_mouse_capture(enabled: bool) -> io::Result<()> {
    host_mouse_capture_flag().store(enabled, std::sync::atomic::Ordering::Release);
    if enabled {
        execute!(io::stdout(), EnableMouseCapture)
    } else {
        match execute!(io::stdout(), DisableMouseCapture) {
            Ok(()) => Ok(()),
            #[cfg(windows)]
            Err(err) if err.to_string() == "Initial console modes not set" => Ok(()),
            Err(err) => Err(err),
        }
    }
}

fn desired_mouse_capture(server_enabled: bool, client_compositor_enabled: bool) -> bool {
    server_enabled || client_compositor_enabled
}

fn restore_terminal_state(reset_modify_other_keys: bool) {
    let _ = clear_received_kitty_graphics(&mut io::stdout());

    // Reset modifyOtherKeys if we enabled it.
    if reset_modify_other_keys {
        let _ = io::stdout().write_all(b"\x1b[>4;0m");
        let _ = io::stdout().flush();
    }

    let _ = pop_keyboard_enhancement_flags();
    let _ = execute!(
        io::stdout(),
        DisableFocusChange,
        DisableBracketedPaste,
        DisableMouseCapture
    );
    ratatui::restore();
    let _ = write_terminal_restore_postlude(&mut io::stdout());
}

#[cfg(not(windows))]
fn push_keyboard_enhancement_flags() -> io::Result<()> {
    execute!(
        io::stdout(),
        PushKeyboardEnhancementFlags(crate::input::ime_compatible_keyboard_enhancement_flags())
    )
}

#[cfg(windows)]
fn push_keyboard_enhancement_flags() -> io::Result<()> {
    Ok(())
}

#[cfg(not(windows))]
fn pop_keyboard_enhancement_flags() -> io::Result<()> {
    execute!(io::stdout(), PopKeyboardEnhancementFlags)
}

#[cfg(windows)]
fn pop_keyboard_enhancement_flags() -> io::Result<()> {
    Ok(())
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore_terminal_state(self.reset_modify_other_keys);
    }
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

fn requested_render_encoding() -> RenderEncoding {
    match std::env::var("HERDR_RENDER_ENCODING").ok().as_deref() {
        Some("terminal-ansi" | "terminal_ansi" | "ansi") => RenderEncoding::TerminalAnsi,
        _ => RenderEncoding::SemanticFrame,
    }
}

fn requested_keybindings() -> ClientKeybindings {
    match std::env::var(crate::remote::REMOTE_KEYBINDINGS_ENV_VAR)
        .ok()
        .as_deref()
    {
        Some("local") => crate::config::Config::load()
            .config
            .local_keybindings_profile_toml()
            .map(|keys_toml| ClientKeybindings::Local { keys_toml })
            .unwrap_or(ClientKeybindings::Server),
        _ => ClientKeybindings::Server,
    }
}

#[cfg(windows)]
fn set_handshake_recv_timeout(
    stream: &LocalStream,
    timeout: Option<Duration>,
    context: &'static str,
) -> Result<(), ClientError> {
    match stream.set_recv_timeout(timeout) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::Unsupported => {
            debug!(err = %err, context, "client socket receive timeout unavailable");
            Ok(())
        }
        Err(err) => Err(ClientError::ConnectionFailed(err)),
    }
}

#[cfg(not(windows))]
fn set_handshake_recv_timeout(
    stream: &LocalStream,
    timeout: Option<Duration>,
    _context: &'static str,
) -> Result<(), ClientError> {
    stream
        .set_recv_timeout(timeout)
        .map_err(ClientError::ConnectionFailed)
}

/// Performs the client→server handshake.
///
/// Sends Hello with the terminal size and protocol version, reads the Welcome
/// response. Returns Ok(()) on success, or an error if the server rejects us.
fn do_handshake(
    stream: &mut LocalStream,
    cols: u16,
    rows: u16,
    cell_width_px: u32,
    cell_height_px: u32,
    requested_encoding: RenderEncoding,
    surface_mode: ClientSurfaceMode,
    keybindings: ClientKeybindings,
    direct_attach_requested: bool,
) -> Result<RenderEncoding, ClientError> {
    stream
        .set_nonblocking(false)
        .map_err(ClientError::ConnectionFailed)?;

    // Send Hello.
    let launch_mode = if direct_attach_requested {
        ClientLaunchMode::TerminalAttach
    } else {
        ClientLaunchMode::App
    };
    let hello = build_hello_message(
        cols,
        rows,
        cell_width_px,
        cell_height_px,
        requested_encoding,
        surface_mode,
        keybindings,
        launch_mode,
    );
    protocol::write_message(stream, &hello)
        .map_err(|e| ClientError::ConnectionFailed(io::Error::other(e.to_string())))?;

    // Read Welcome.
    set_handshake_recv_timeout(
        stream,
        Some(Duration::from_secs(5)),
        "client handshake read timeout unavailable",
    )?;
    let welcome: ServerMessage = protocol::read_message(stream, MAX_FRAME_SIZE)?;
    set_handshake_recv_timeout(
        stream,
        None,
        "failed to clear client handshake read timeout",
    )?;

    match welcome {
        ServerMessage::Welcome {
            version,
            encoding,
            error,
        } => {
            if let Some(error) = error {
                return Err(ClientError::HandshakeRejected { version, error });
            }
            info!(version, ?encoding, "handshake succeeded");
            Ok(encoding)
        }
        _ => Err(ClientError::Protocol(protocol::FramingError::Io(
            io::Error::new(io::ErrorKind::InvalidData, "expected Welcome message"),
        ))),
    }
}

fn build_hello_message(
    cols: u16,
    rows: u16,
    cell_width_px: u32,
    cell_height_px: u32,
    requested_encoding: RenderEncoding,
    surface_mode: ClientSurfaceMode,
    keybindings: ClientKeybindings,
    launch_mode: ClientLaunchMode,
) -> ClientMessage {
    ClientMessage::Hello {
        version: PROTOCOL_VERSION,
        cols,
        rows,
        cell_width_px,
        cell_height_px,
        requested_encoding,
        surface_mode,
        keybindings,
        launch_mode,
    }
}

// ---------------------------------------------------------------------------
// Client event loop
// ---------------------------------------------------------------------------

/// Internal events for the client event loop.
enum ClientLoopEvent {
    /// Raw input bytes from stdin.
    #[cfg(unix)]
    StdinInput(Vec<u8>),
    /// Structured input events from platforms without Unix-style stdin bytes.
    #[cfg(windows)]
    StdinEvents(Vec<crate::protocol::ClientInputEvent>),
    /// Terminal resize detected.
    Resize(u16, u16, u32, u32),
    /// Server message received.
    ServerMessage {
        server_id: supervisor::ServerId,
        message: ServerMessage,
    },
    /// A subscribed sidebar-summary event arrived from one managed server.
    SupervisorSummaryChanged(supervisor::ServerId),
    /// A secondary server summary refresh completed off the UI loop.
    SupervisorSummaryFetched {
        server_id: supervisor::ServerId,
        result: Result<supervisor::ServerSummary, supervisor::ConnectionState>,
        elapsed: Duration,
    },
    /// A sidebar-summary subscription worker ended and should be eligible to restart.
    SupervisorSummarySubscriptionEnded(supervisor::ServerId),
    /// A sidebar API request completed off the UI loop.
    SupervisorApiRequestFinished {
        server_id: supervisor::ServerId,
        refresh: ClientApiRefreshPolicy,
        result: Result<(), String>,
        elapsed: Duration,
    },
    /// A secondary server client stream connection attempt completed off the UI loop.
    SecondaryConnectionAttemptFinished {
        server_id: supervisor::ServerId,
        attempt: usize,
        result: Result<SecondaryConnectionAttempt, ClientError>,
        elapsed: Duration,
    },
    /// Add-remote registration (parse + duplicate check + `remote.add` against the local main
    /// socket) completed off the UI loop. On Ok the host row is added to the sidebar immediately
    /// (state `Connecting`) and the retry sweep provisions the bridge with live per-host progress
    /// sub-lines — the form closes right away instead of blocking on the install.
    AddRemoteFinished {
        result: Result<crate::remote_registry::RemoteDefinitionSnapshot, String>,
        elapsed: Duration,
    },
    /// #44: a provisioning stage of an in-flight one-click "update" (reinstall the local herdr onto
    /// a remote via the add-remote flow). Server_id-keyed so the banner sub-line targets the right
    /// host's banner.
    UpdateRemoteProgress {
        server_id: supervisor::ServerId,
        message: String,
    },
    /// #44: a one-click "update" completed off the UI loop. On Ok the client tears the stream down +
    /// schedules an immediate reconnect (so it dials back up on the now-matching protocol) and
    /// re-fetches runtime status; on Err it clears the progress line and surfaces a message.
    UpdateRemoteFinished {
        server_id: supervisor::ServerId,
        result: Result<(), String>,
        elapsed: Duration,
    },
    /// #44: a remote's runtime version/protocol was (re-)fetched off the UI loop. Applied via
    /// `set_remote_runtime_info` so the host context-menu version readout and its mismatch flag
    /// reflect the freshly-installed binary after a one-click update.
    SupervisorRuntimeStatusFetched {
        server_id: supervisor::ServerId,
        version: Option<String>,
        protocol: Option<u32>,
    },
    /// Worktree-menu parity: a `worktree.list` fetch for the open picker completed off the UI
    /// loop. Filled into the picker via `fill_worktree_picker` (stale results are ignored there).
    WorktreeListFetched {
        server_id: supervisor::ServerId,
        workspace_id: String,
        result: Result<Vec<supervisor::WorktreePickerItem>, String>,
    },
    /// C4: a `session.list` fetch for the open session picker completed off the UI loop. Filled via
    /// `fill_session_picker` (stale results are ignored there); an Err lands on the picker's error
    /// line and leaves its `new session…` row usable.
    SessionListFetched {
        server_id: supervisor::ServerId,
        result: Result<Vec<supervisor::SessionPickerItem>, String>,
    },
    /// item 3 (Area 5): a remote-management `remote.set_enabled`/`remote.remove` request finished
    /// off the UI loop. The handler branches on `action` to apply teardown / reconnect.
    RemoteManageRequestFinished {
        action: RemoteManageAction,
        remote_id: String,
        result: Result<(), String>,
        elapsed: Duration,
    },
    /// Server reader thread exited (connection lost).
    ServerDisconnected(supervisor::ServerId),
    /// #42: the main-server supervisor refresh (registry + ui-settings + main summary) completed on
    /// a worker thread. Applied on the loop thread so the four blocking local round-trips never run
    /// on the render/event-loop thread (which froze the UI once per connecting remote).
    MainSupervisorRefreshed {
        result: Result<supervisor::MainSupervisorSnapshot, String>,
        elapsed: Duration,
    },
    /// #42: the one-time cold-start hydrate of the main-server supervisor model completed on a
    /// worker thread. The cold-start bootstrap now paints a minimal main-only model immediately
    /// (no blocking round-trips before the first frame); this event carries the fully-hydrated
    /// model (registry + summary + ui-settings, with the same `remote.list`-failure degrade the
    /// inline bootstrap used) to swap in once it arrives. A one-shot wholesale replace is safe here
    /// because the minimal model carries no overlay/optimistic state the user could have set in the
    /// sub-frame gap before hydrate lands.
    MainSupervisorBootstrapped(Box<supervisor::ClientSupervisorModel>),
    /// Timer tick.
    Timer,
}

struct SummarySubscriptionEndGuard {
    server_id: supervisor::ServerId,
    event_tx: tokio::sync::mpsc::Sender<ClientLoopEvent>,
}

impl Drop for SummarySubscriptionEndGuard {
    fn drop(&mut self) {
        let _ = self
            .event_tx
            .blocking_send(ClientLoopEvent::SupervisorSummarySubscriptionEnded(
                self.server_id.clone(),
            ));
    }
}

struct ClientLoopOptions {
    host_size: (u16, u16),
    reported_size: (u16, u16),
    cell_size_px: (u32, u32),
    sound_config: crate::config::SoundConfig,
    mouse_scroll_lines: usize,
    redraw_on_focus_gained: bool,
    kitty_graphics_enabled: bool,
    mouse_capture_active: bool,
    negotiated_encoding: RenderEncoding,
    attach_escape: Option<AttachEscapeState>,
    compositor: Option<compositor::ClientCompositor>,
    supervisor_model: Option<supervisor::ClientSupervisorModel>,
    secondary_streams: Vec<(supervisor::ServerId, LocalStream)>,
    ssh_bridges: HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
}

/// Runs the thin client: connects to the server, performs the handshake,
/// and enters the main event loop.
///
/// This is the entry point called from `main.rs` when running in client mode.
pub fn run_client() -> io::Result<()> {
    run_client_with_mode(
        requested_render_encoding(),
        None,
        None,
        "connecting to server",
    )
}

/// Runs a direct terminal attach client.
#[cfg(unix)]
pub fn run_terminal_attach(terminal_id: String, takeover: bool) -> io::Result<()> {
    run_client_with_mode(
        RenderEncoding::TerminalAnsi,
        Some((terminal_id, takeover)),
        Some(AttachEscapeState::default()),
        "attaching to terminal",
    )
}

/// Direct terminal attach is Unix raw-byte input only until Windows gets a semantic attach path.
#[cfg(windows)]
pub fn run_terminal_attach(_terminal_id: String, _takeover: bool) -> io::Result<()> {
    debug_assert!(!crate::platform::capabilities().direct_terminal_attach);
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "direct terminal attach is not supported on Windows yet",
    ))
}

fn run_client_with_mode(
    requested_encoding: RenderEncoding,
    attach_request: Option<(String, bool)>,
    attach_escape: Option<AttachEscapeState>,
    log_message: &'static str,
) -> io::Result<()> {
    init_logging();

    let loaded_config = crate::config::Config::load();
    let mouse_capture = loaded_config.config.ui.mouse_capture;
    let mouse_scroll_lines = loaded_config.config.ui.mouse_scroll_lines();
    let redraw_on_focus_gained = loaded_config.config.ui.redraw_on_focus_gained;
    let sound_config = loaded_config.config.ui.sound;
    let direct_attach_requested = attach_request.is_some();
    let kitty_graphics_enabled =
        loaded_config.config.experimental.kitty_graphics && !direct_attach_requested;

    let socket_path = client_socket_path();
    crate::logging::startup("client");
    info!(path = %socket_path.display(), "{log_message}");

    // Get the terminal geometry before handshake (before raw mode).
    let (cols, rows, cell_width_px, cell_height_px) =
        initial_terminal_geometry(kitty_graphics_enabled);

    let mut supervisor_model = {
        let mut api = crate::api::client::ApiClient::local();
        match bootstrap_client_supervisor_model(direct_attach_requested, &mut api) {
            Ok(model) => model,
            Err(err) => {
                warn!(err = %err, "failed to bootstrap client supervisor from main API");
                None
            }
        }
    };
    if let Some(model) = &supervisor_model {
        debug!(
            secondary_servers = model.secondary_connection_plans().len(),
            workspace_rows = model.workspace_rows().len(),
            "client supervisor bootstrapped"
        );
    }

    let render_plan =
        client_render_plan(supervisor_model.as_ref(), requested_encoding, (cols, rows));

    // Try to connect to the server.
    let mut stream = match crate::ipc::connect_local_stream(&socket_path) {
        Ok(s) => s,
        Err(err) => {
            // Server unreachable — show clear error and exit.
            let client_err = ClientError::ConnectionFailed(err);
            eprintln!("herdr: {client_err}");
            std::process::exit(1);
        }
    };

    // Perform handshake while the stream is still in blocking mode.
    let negotiated_encoding = match do_handshake(
        &mut stream,
        render_plan.server_size.0,
        render_plan.server_size.1,
        cell_width_px,
        cell_height_px,
        render_plan.requested_encoding,
        render_plan.surface_mode,
        requested_keybindings(),
        direct_attach_requested,
    ) {
        Ok(encoding) => encoding,
        Err(err) => {
            eprintln!("herdr: {err}");
            std::process::exit(1);
        }
    };

    let mut ssh_bridges = HashMap::new();
    let secondary_streams = if render_plan.use_client_compositor {
        supervisor_model
            .as_mut()
            .map(|model| {
                connect_secondary_client_streams(
                    model,
                    render_plan.server_size,
                    cell_width_px,
                    cell_height_px,
                    &mut ssh_bridges,
                )
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    if let Some((terminal_id, takeover)) = attach_request {
        let attach = ClientMessage::AttachTerminal {
            terminal_id,
            takeover,
        };
        if let Err(err) = write_to_server(&mut stream, &attach) {
            eprintln!("herdr: failed to request terminal attach: {err}");
            std::process::exit(1);
        }
    }

    // Now set up the terminal. This must happen AFTER the handshake succeeds,
    // so we don't leave the terminal in raw mode if the server rejects us.
    let direct_attach = attach_escape.is_some();
    let client_compositor_enabled = render_plan.use_client_compositor;
    let terminal_guard = if direct_attach {
        setup_direct_attach_terminal()
    } else {
        setup_terminal(desired_mouse_capture(
            mouse_capture,
            client_compositor_enabled,
        ))
    }
    .map_err(|err| {
        eprintln!("herdr: failed to set up terminal: {err}");
        err
    })?;

    // Install a panic hook to restore the terminal on panic (same as monolithic).
    let panic_resets_modify_other_keys = terminal_guard.reset_modify_other_keys;
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal_state(panic_resets_modify_other_keys);
        original_hook(info);
    }));

    // Create the tokio runtime.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(io::Error::other)?;

    let should_quit = Arc::new(AtomicBool::new(false));

    // ctrlc's "termination" feature also catches SIGTERM/SIGHUP so direct
    // termination signals still run the quit path and TerminalGuard::Drop.
    let quit_flag = should_quit.clone();
    if let Err(err) = ctrlc::set_handler(move || {
        quit_flag.store(true, Ordering::Release);
    }) {
        warn!(%err, "failed to install termination handler; terminal restore relies on TerminalGuard::Drop and the panic hook");
    }

    let result = rt.block_on(async {
        let client_compositor = render_plan
            .use_client_compositor
            .then(compositor::ClientCompositor::default);
        run_client_loop(
            stream,
            should_quit,
            ClientLoopOptions {
                host_size: (cols, rows),
                reported_size: render_plan.server_size,
                cell_size_px: (cell_width_px, cell_height_px),
                sound_config,
                mouse_scroll_lines,
                redraw_on_focus_gained,
                kitty_graphics_enabled,
                mouse_capture_active: desired_mouse_capture(
                    mouse_capture,
                    client_compositor_enabled,
                ),
                negotiated_encoding,
                attach_escape,
                compositor: client_compositor,
                supervisor_model: supervisor_model.take(),
                secondary_streams,
                ssh_bridges,
            },
        )
        .await
    });

    // Restore the terminal before printing any final status message.
    drop(terminal_guard);

    if let Err(err) = result {
        eprintln!("herdr: {err}");
        rt.shutdown_timeout(Duration::from_millis(100));
        crate::logging::shutdown("client");

        if matches!(
            err,
            ClientError::ServerShutdown {
                reason: Some(reason)
            } if reason == "detached"
        ) {
            return Ok(());
        }

        std::process::exit(1);
    }

    rt.shutdown_timeout(Duration::from_millis(100));
    crate::logging::shutdown("client");
    Ok(())
}

fn bootstrap_supervisor_for_client(
    direct_attach_requested: bool,
    _api: &mut impl supervisor::SupervisorApi,
) -> Result<Option<supervisor::ClientSupervisorModel>, String> {
    if direct_attach_requested {
        return Ok(None);
    }

    // #42: paint-first. Build a minimal main-only model with ZERO blocking round-trips so the
    // sidebar paints on the very first frame. The registry/summary/ui-settings hydrate off the UI
    // thread via the one-shot `MainSupervisorBootstrapped` worker kicked off in `run_client_loop`
    // (`spawn_main_supervisor_bootstrap`), then the 2s `MainSupervisorRefreshed` cadence keeps it
    // fresh. On a cold/busy local server nothing blocks the first paint anymore.
    Ok(Some(supervisor::ClientSupervisorModel::new(
        main_display_name_for_client(),
    )))
}

fn bootstrap_client_supervisor_model(
    direct_attach_requested: bool,
    api: &mut impl supervisor::SupervisorApi,
) -> Result<Option<supervisor::ClientSupervisorModel>, String> {
    bootstrap_supervisor_for_client(direct_attach_requested, api)
}

fn main_display_name_for_client() -> String {
    std::env::var(crate::remote::MAIN_DISPLAY_NAME_ENV_VAR)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "local".to_string())
}

fn api_target_for_supervisor_server(
    model: &supervisor::ClientSupervisorModel,
    server_id: &supervisor::ServerId,
    ssh_bridges: &HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
) -> Option<crate::api::client::ConnectionTarget> {
    let target = model.server_connection_target(server_id)?;
    api_target_for_supervisor_target(server_id, &target, ssh_bridges)
}

fn api_target_for_supervisor_target(
    server_id: &supervisor::ServerId,
    target: &supervisor::ServerConnectionTarget,
    ssh_bridges: &HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
) -> Option<crate::api::client::ConnectionTarget> {
    match target {
        supervisor::ServerConnectionTarget::Ssh { .. } => {
            ssh_bridges.get(server_id).map(|bridge| {
                crate::api::client::ConnectionTarget::SocketPath(
                    bridge.api_socket_path().to_path_buf(),
                )
            })
        }
        _ => api_target_for_connection_target(target),
    }
}

fn api_target_for_connection_target(
    target: &supervisor::ServerConnectionTarget,
) -> Option<crate::api::client::ConnectionTarget> {
    match target {
        supervisor::ServerConnectionTarget::Main => {
            Some(crate::api::client::ConnectionTarget::LocalSession(None))
        }
        supervisor::ServerConnectionTarget::LocalSession(session) => Some(
            crate::api::client::ConnectionTarget::LocalSession(session.clone()),
        ),
        supervisor::ServerConnectionTarget::Ssh { .. } => None,
    }
}

fn client_socket_path_for_connection_target(
    target: &supervisor::ServerConnectionTarget,
) -> Option<std::path::PathBuf> {
    match target {
        supervisor::ServerConnectionTarget::Main => Some(client_socket_path()),
        supervisor::ServerConnectionTarget::LocalSession(session) => {
            Some(crate::session::client_socket_path_for(session.as_deref()))
        }
        supervisor::ServerConnectionTarget::Ssh { .. } => None,
    }
}

#[cfg(test)]
fn client_socket_path_for_supervisor_server(
    model: &supervisor::ClientSupervisorModel,
    server_id: &supervisor::ServerId,
    ssh_bridges: &HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
) -> Option<std::path::PathBuf> {
    let target = model.server_connection_target(server_id)?;
    match target {
        supervisor::ServerConnectionTarget::Ssh { .. } => ssh_bridges
            .get(server_id)
            .map(|bridge| bridge.client_socket_path().to_path_buf()),
        _ => client_socket_path_for_connection_target(&target),
    }
}

fn connect_secondary_client_streams(
    model: &mut supervisor::ClientSupervisorModel,
    _server_size: (u16, u16),
    _cell_width_px: u32,
    _cell_height_px: u32,
    _ssh_bridges: &mut HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
) -> Vec<(supervisor::ServerId, LocalStream)> {
    for plan in model.secondary_connection_plans() {
        let _ =
            model.set_connection_state(&plan.server_id, supervisor::ConnectionState::Connecting);
    }
    Vec::new()
}

fn connect_secondary_client_stream_for_plan_detached(
    plan: supervisor::SecondaryConnectionPlan,
    server_size: (u16, u16),
    cell_width_px: u32,
    cell_height_px: u32,
    existing_ssh_client_socket: Option<std::path::PathBuf>,
    restart_incompatible: bool,
    on_progress: &dyn Fn(crate::remote::RemoteProvisionStage),
) -> Result<SecondaryConnectionAttempt, ClientError> {
    let socket_path = match &plan.target {
        supervisor::ServerConnectionTarget::Ssh {
            destination,
            options,
            session,
        } => {
            if let Some(path) = existing_ssh_client_socket {
                path
            } else {
                let ssh_target =
                    crate::remote::SshTarget::new(destination.clone(), options.clone());
                // C1/C4: the remote-side session this host is pinned to. `None` = the remote's
                // default, which is exactly what `start_ssh_remote_bridge` falls back to.
                let session_name = session.clone();
                // Provisioning rides the retry sweep (the non-modal add-remote flow): stages are
                // forwarded to the host's banner sub-lines, and the whole bring-up is bounded by
                // the per-stage idle window so a stuck host fails instead of hanging the retry.
                // `restart_incompatible` is the one-shot user approval from an explicit
                // retry-after-restart-confirm (issue #12); plain reconnects never restart an
                // incompatible server. A reconnect never force-reinstalls — only "update" does.
                let bridge = run_remote_op_with_progress(
                    ADD_REMOTE_BRIDGE_IDLE_TIMEOUT,
                    on_progress,
                    move |sink| {
                        crate::remote::start_ssh_remote_bridge(
                            ssh_target,
                            restart_incompatible,
                            false,
                            session_name.as_deref(),
                            sink,
                        )
                    },
                )
                .map_err(|err| ClientError::ConnectionFailed(remote_op_error_io(err)))?;
                let socket_path = bridge.client_socket_path().to_path_buf();
                return connect_secondary_client_stream(
                    &socket_path,
                    server_size,
                    cell_width_px,
                    cell_height_px,
                    plan.keybindings,
                )
                .map(|stream| SecondaryConnectionAttempt {
                    stream,
                    bridge: Some(bridge),
                });
            }
        }
        _ => client_socket_path_for_connection_target(&plan.target).ok_or_else(|| {
            ClientError::ConnectionFailed(io::Error::new(
                io::ErrorKind::InvalidInput,
                "secondary server has no client socket target",
            ))
        })?,
    };

    connect_secondary_client_stream(
        &socket_path,
        server_size,
        cell_width_px,
        cell_height_px,
        plan.keybindings,
    )
    .map(|stream| SecondaryConnectionAttempt {
        stream,
        bridge: None,
    })
}

fn connect_secondary_client_stream(
    socket_path: &std::path::Path,
    server_size: (u16, u16),
    cell_width_px: u32,
    cell_height_px: u32,
    keybindings: crate::remote_registry::RemoteKeybindingsSnapshot,
) -> Result<LocalStream, ClientError> {
    let mut stream =
        crate::ipc::connect_local_stream(socket_path).map_err(ClientError::ConnectionFailed)?;
    do_handshake(
        &mut stream,
        server_size.0,
        server_size.1,
        cell_width_px,
        cell_height_px,
        RenderEncoding::SemanticFrame,
        ClientSurfaceMode::EmbeddedContent,
        client_keybindings_from_snapshot(keybindings),
        false,
    )?;
    Ok(stream)
}

fn attach_secondary_client_stream(
    server_id: supervisor::ServerId,
    stream: LocalStream,
    rx_bytes: Arc<std::sync::atomic::AtomicU64>,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
    should_quit: &Arc<AtomicBool>,
    server_writes: &mut HashMap<supervisor::ServerId, ServerWriteHandle>,
    max_frame_size: usize,
) -> Result<(), ClientError> {
    let read_stream = stream.try_clone().map_err(ClientError::ConnectionFailed)?;
    let read_tx = event_tx.clone();
    let read_quit = should_quit.clone();
    let reader_server_id = server_id.clone();
    std::thread::spawn(move || {
        server_reader_thread(
            reader_server_id,
            read_stream,
            rx_bytes,
            read_tx,
            &read_quit,
            max_frame_size,
        );
    });
    stream
        .set_nonblocking(false)
        .map_err(ClientError::ConnectionFailed)?;
    let write_handle = spawn_server_writer(server_id.clone(), stream, event_tx.clone());
    server_writes.insert(server_id, write_handle);
    Ok(())
}

fn spawn_server_writer(
    server_id: supervisor::ServerId,
    mut stream: LocalStream,
    event_tx: tokio::sync::mpsc::Sender<ClientLoopEvent>,
) -> ServerWriteHandle {
    let (tx, rx) = std::sync::mpsc::channel::<ClientMessage>();
    std::thread::spawn(move || {
        while let Ok(message) = rx.recv() {
            if let Err(err) = write_to_server(&mut stream, &message) {
                warn!(
                    server_id = ?server_id,
                    err = %err,
                    "server writer failed"
                );
                let _ = event_tx.blocking_send(ClientLoopEvent::ServerDisconnected(server_id));
                return;
            }
        }
    });
    ServerWriteHandle { tx }
}

fn connection_state_from_client_error(err: &ClientError) -> supervisor::ConnectionState {
    match err {
        ClientError::HandshakeRejected { version, .. } => {
            supervisor::ConnectionState::ProtocolMismatch {
                server_protocol: Some(*version),
                client_protocol: PROTOCOL_VERSION,
            }
        }
        _ => supervisor::ConnectionState::Disconnected,
    }
}

fn client_keybindings_from_snapshot(
    keybindings: crate::remote_registry::RemoteKeybindingsSnapshot,
) -> ClientKeybindings {
    match keybindings {
        crate::remote_registry::RemoteKeybindingsSnapshot::Server => ClientKeybindings::Server,
        crate::remote_registry::RemoteKeybindingsSnapshot::Local => crate::config::Config::load()
            .config
            .local_keybindings_profile_toml()
            .map(|keys_toml| ClientKeybindings::Local { keys_toml })
            .unwrap_or(ClientKeybindings::Server),
    }
}

#[cfg(test)]
fn send_client_supervisor_request(
    model: &supervisor::ClientSupervisorModel,
    server_id: &supervisor::ServerId,
    request: crate::api::schema::Request,
    ssh_bridges: &HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
) -> Result<(), String> {
    let target = api_target_for_supervisor_server(model, server_id, ssh_bridges)
        .ok_or_else(|| format!("no API target for server {server_id:?}"))?;
    send_client_supervisor_request_to_target(target, request)
}

fn send_client_supervisor_request_to_target(
    target: crate::api::client::ConnectionTarget,
    request: crate::api::schema::Request,
) -> Result<(), String> {
    let api = crate::api::client::ApiClient::for_target(target);
    let value = api
        .request_value_with_timeout(&request, CLIENT_SUPERVISOR_API_TIMEOUT)
        .map_err(|err| err.to_string())?;
    crate::api::client::parse_response_value(value)
        .map(|_| ())
        .map_err(|err| err.to_string())
}

fn spawn_client_supervisor_request(
    model: &supervisor::ClientSupervisorModel,
    server_id: supervisor::ServerId,
    refresh: ClientApiRefreshPolicy,
    request: crate::api::schema::Request,
    ssh_bridges: &HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) -> Result<(), String> {
    let target = api_target_for_supervisor_server(model, &server_id, ssh_bridges)
        .ok_or_else(|| format!("no API target for server {server_id:?}"))?;
    let event_tx = event_tx.clone();
    std::thread::spawn(move || {
        let started_at = Instant::now();
        let result = send_client_supervisor_request_to_target(target, request);
        let elapsed = started_at.elapsed();
        let _ = event_tx.blocking_send(ClientLoopEvent::SupervisorApiRequestFinished {
            server_id,
            refresh,
            result,
            elapsed,
        });
    });
    Ok(())
}

fn fps_for_frame_duration(duration: Duration) -> f64 {
    if duration.is_zero() {
        f64::INFINITY
    } else {
        1.0 / duration.as_secs_f64()
    }
}

fn submit_remote_add_to_main_api(
    api: &mut impl supervisor::SupervisorApi,
    draft: supervisor::AddRemoteDraft,
) -> Result<crate::remote_registry::RemoteDefinitionSnapshot, String> {
    let response = api
        .request(crate::api::schema::Request {
            id: "client:remote-add".into(),
            method: crate::api::schema::Method::RemoteAdd(crate::api::schema::RemoteAddParams {
                name: draft.name,
                target: draft.target,
                // C1: the form's optional session field; `None` (an empty field) = the remote's
                // default session. Validated server-side by `normalize_session`.
                session: draft.session,
                keybindings: draft.keybindings,
            }),
        })
        .map_err(|err| add_remote_error_message(&err))?;
    match response.result {
        crate::api::schema::ResponseResult::RemoteAdded { remote } => Ok(remote),
        other => Err(format!("remote.add returned unexpected result: {other:?}")),
    }
}

fn add_remote_error_message(error: &str) -> String {
    match error {
        "remote target already exists" => "remote already added".to_string(),
        "remote name already exists" => "name already used".to_string(),
        other => map_remote_bridge_error(other),
    }
}

/// Map raw ssh/bridge failures into short, actionable dialog text. The add-remote worker can fail
/// for very different reasons (host unreachable, ssh auth, missing/old herdr); a bare io error
/// string is not helpful in the small dialog status row.
fn map_remote_bridge_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("timed out") {
        "timed out reaching host — check the address and your ssh access".to_string()
    } else if lower.contains("connection refused")
        || lower.contains("could not resolve")
        || lower.contains("name or service not known")
        || lower.contains("no route to host")
    {
        "cannot reach host over ssh — check the address".to_string()
    } else if lower.contains("permission denied") || lower.contains("authentication") {
        "ssh authentication failed — set up key access to this host".to_string()
    } else if lower.contains("does not support live-handoff") || lower.contains("protocol") {
        "remote herdr is incompatible and can't be upgraded in place — update it and retry"
            .to_string()
    } else {
        error.to_string()
    }
}

fn summary_refresh_subscription_request(id: impl Into<String>) -> crate::api::schema::Request {
    use crate::api::schema::Subscription;

    crate::api::schema::Request {
        id: id.into(),
        method: crate::api::schema::Method::EventsSubscribe(
            crate::api::schema::EventsSubscribeParams {
                subscriptions: vec![
                    Subscription::WorkspaceCreated {},
                    Subscription::WorkspaceUpdated {},
                    Subscription::WorkspaceRenamed {},
                    Subscription::WorkspaceClosed {},
                    Subscription::WorkspaceFocused {},
                    Subscription::TabCreated {},
                    Subscription::TabClosed {},
                    Subscription::TabFocused {},
                    Subscription::TabRenamed {},
                    Subscription::PaneCreated {},
                    Subscription::PaneClosed {},
                    Subscription::PaneFocused {},
                    Subscription::PaneExited {},
                    Subscription::PaneAgentDetected {},
                    Subscription::PaneAgentStatusChanged {
                        pane_id: None,
                        agent_status: None,
                    },
                ],
            },
        ),
    }
}

fn start_missing_supervisor_summary_subscriptions(
    model: &supervisor::ClientSupervisorModel,
    subscribed_server_ids: &mut HashSet<supervisor::ServerId>,
    ssh_bridges: &HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
    should_quit: &Arc<AtomicBool>,
) {
    for plan in model.summary_subscription_plans() {
        let Some(target) =
            api_target_for_supervisor_target(&plan.server_id, &plan.target, ssh_bridges)
        else {
            continue;
        };
        if !subscribed_server_ids.insert(plan.server_id.clone()) {
            continue;
        }
        spawn_supervisor_summary_subscription(plan.server_id, target, event_tx, should_quit);
    }
}

fn spawn_supervisor_summary_subscription(
    server_id: supervisor::ServerId,
    target: crate::api::client::ConnectionTarget,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
    should_quit: &Arc<AtomicBool>,
) {
    let event_tx = event_tx.clone();
    let should_quit = should_quit.clone();
    std::thread::spawn(move || {
        let changed_event_tx = event_tx.clone();
        let _end_guard = SummarySubscriptionEndGuard {
            server_id: server_id.clone(),
            event_tx,
        };
        let client = crate::api::client::ApiClient::for_target(target);
        let request = summary_refresh_subscription_request(format!("client:summary:{server_id:?}"));
        let (ack, mut stream) =
            match client.subscribe_value(&request, Some(CLIENT_SUPERVISOR_API_TIMEOUT)) {
                Ok(value) => value,
                Err(err) => {
                    warn!(
                        server_id = ?server_id,
                        err = %err,
                        "failed to subscribe to supervisor summary events"
                    );
                    return;
                }
            };
        if let Err(err) = crate::api::client::parse_response_value(ack) {
            warn!(
                server_id = ?server_id,
                err = %err,
                "supervisor summary subscription was rejected"
            );
            return;
        }

        while !should_quit.load(Ordering::Acquire) {
            match stream.next_value() {
                Ok(Some(_event)) => {
                    if changed_event_tx
                        .blocking_send(ClientLoopEvent::SupervisorSummaryChanged(server_id.clone()))
                        .is_err()
                    {
                        return;
                    }
                }
                Ok(None) => return,
                Err(err) if api_client_error_is_timeout(&err) => continue,
                Err(err) => {
                    warn!(
                        server_id = ?server_id,
                        err = %err,
                        "supervisor summary subscription ended"
                    );
                    return;
                }
            }
        }
    });
}

fn api_client_error_is_timeout(err: &crate::api::client::ApiClientError) -> bool {
    matches!(
        err,
        crate::api::client::ApiClientError::Io(io_err)
            if matches!(
                io_err.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            )
    )
}

/// item 3 (Area 5): the kind of registry mutation a manage request performs. Carried back in
/// `RemoteManageRequestFinished` so the handler can branch teardown vs. reconnect.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RemoteManageAction {
    SetEnabled { enabled: bool },
    // #61: persist the per-remote auto-update flag (no connection side-effect — unlike SetEnabled).
    SetAutoUpdate { auto_update: bool },
    // C4/C6: re-point the remote at another session (`None` = its default). Unlike SetAutoUpdate this
    // DOES have a connection side-effect: the bridge must be rebuilt with the new `--session`, so the
    // apply handler tears the stream down and immediately reconnects.
    SetSession { session: Option<String> },
    Delete,
}

/// item 3 (Area 5): build the `remote.set_enabled`/`remote.remove` request for a manage action.
/// Short user-facing verb for a failed manage request, used on the host banner's outcome sub-line.
fn remote_manage_action_label(action: &RemoteManageAction) -> &'static str {
    match action {
        RemoteManageAction::SetEnabled { enabled: true } => "enable",
        RemoteManageAction::SetEnabled { enabled: false } => "disable",
        RemoteManageAction::SetAutoUpdate { .. } => "auto-update toggle",
        RemoteManageAction::SetSession { .. } => "session switch",
        RemoteManageAction::Delete => "remove",
    }
}

fn remote_manage_request(
    action: &RemoteManageAction,
    remote_id: &str,
) -> crate::api::schema::Request {
    let method = match action {
        RemoteManageAction::SetEnabled { enabled } => crate::api::schema::Method::RemoteSetEnabled(
            crate::api::schema::RemoteSetEnabledParams {
                remote_id: remote_id.to_string(),
                enabled: *enabled,
            },
        ),
        RemoteManageAction::SetAutoUpdate { auto_update } => {
            crate::api::schema::Method::RemoteSetAutoUpdate(
                crate::api::schema::RemoteSetAutoUpdateParams {
                    remote_id: remote_id.to_string(),
                    auto_update: *auto_update,
                },
            )
        }
        RemoteManageAction::SetSession { session } => crate::api::schema::Method::RemoteSetSession(
            crate::api::schema::RemoteSetSessionParams {
                remote_id: remote_id.to_string(),
                session: session.clone(),
            },
        ),
        RemoteManageAction::Delete => {
            crate::api::schema::Method::RemoteRemove(crate::api::schema::RemoteRemoveParams {
                remote_id: remote_id.to_string(),
            })
        }
    };
    crate::api::schema::Request {
        id: "client:remote-manage".into(),
        method,
    }
}

/// item 3 (Area 5): spawn the `remote.set_enabled`/`remote.remove` request off the UI loop against
/// `ServerId::main()` (the local socket — no SSH bridge needed), then emit
/// `RemoteManageRequestFinished`. Modeled on `spawn_client_add_remote_submission`; it does NOT
/// reuse `spawn_client_supervisor_request` (which emits the unrelated `SupervisorApiRequestFinished`
/// and discards the response body), because the manage handler must branch on `action`.
fn spawn_client_remote_manage_request(
    model: &supervisor::ClientSupervisorModel,
    action: RemoteManageAction,
    remote_id: String,
    ssh_bridges: &HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) {
    let main_id = supervisor::ServerId::main();
    let target = api_target_for_supervisor_server(model, &main_id, ssh_bridges);
    let request = remote_manage_request(&action, &remote_id);
    let event_tx = event_tx.clone();
    std::thread::spawn(move || {
        let started_at = Instant::now();
        let result = match target {
            Some(target) => send_client_supervisor_request_to_target(target, request),
            None => Err("no API target for main server".to_string()),
        };
        let elapsed = started_at.elapsed();
        let _ = event_tx.blocking_send(ClientLoopEvent::RemoteManageRequestFinished {
            action,
            remote_id,
            result,
            elapsed,
        });
    });
}

/// #44: reinstall the LOCAL client's herdr onto a connected remote by reusing the add-remote
/// provisioning flow (NOT an internet download). Modeled on `spawn_client_add_remote_submission`,
/// but server_id-keyed so the banner sub-line targets the right host. Worker steps:
///   1. PRE-FLIGHT seed check — if this build can't seed the remote's platform without a download,
///      post a truthful `UpdateRemoteFinished(Err)` and return WITHOUT attempting an install.
///   2. Run the SAME provisioning `add-remote` uses (`start_ssh_remote_bridge` with
///      `restart_incompatible = true`, bounded by `run_remote_op_with_progress`), forwarding each
///      stage as a server_id-keyed `UpdateRemoteProgress`.
///   3. On success, post `UpdateRemoteFinished(Ok)`; the loop then reconnects on the new protocol
///      and re-fetches runtime status so the version/mismatch readout clears.
///
/// #44/#61: resolve a remote's ssh target, show an initial progress line, and spawn the reinstall
/// worker off the UI loop (the `pending_update_remote` guard collapses double-fires). Shared by the
/// manual menu `update` and #61's auto-update sweep, so both honour the same seed pre-flight (no
/// internet download) and surface progress identically. A non-ssh (local) host has nothing to
/// reinstall over ssh, so it gets a truthful one-liner instead. Clears any stale terminal outcome so
/// a fresh run's spinner is not masked by a lingering "✓/✗" from a previous update.
fn spawn_remote_update_for(
    state: &mut ClientState,
    server_id: &supervisor::ServerId,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) {
    let ssh_target = state.supervisor_model.as_ref().and_then(|model| {
        model
            .server_ssh_target(server_id)
            .map(|(destination, options)| crate::remote::SshTarget::new(destination, options))
    });
    match ssh_target {
        Some(ssh_target) => {
            if let Some(model) = &mut state.supervisor_model {
                model.clear_update_outcome(server_id);
                model.set_update_progress(server_id, Some("starting update…".to_string()));
            }
            state.update_outcome_expiry.remove(server_id);
            spawn_client_update_remote(
                server_id.clone(),
                ssh_target,
                event_tx,
                &mut state.pending_update_remote,
            );
        }
        None => {
            if let Some(model) = &mut state.supervisor_model {
                model.set_update_progress(
                    server_id,
                    Some("update is only available for ssh remotes".to_string()),
                );
            }
        }
    }
}

/// #61: with per-remote auto-update enabled, push THIS client's build onto every connected secondary
/// found at a protocol mismatch — the SAME flow as the manual menu `update` (visible progress, the
/// Part-2 completion signal, the seed pre-flight with no internet fallback). The candidate set is
/// re-evaluated whenever a runtime status lands (every summary refresh re-probes the protocol), so a
/// host updated out-of-band, or a flag toggled on, is picked up within a cadence tick. Guards: skip a
/// host already updating (`pending_update_remote`) and one still showing a terminal outcome
/// (`update_outcome_expiry`) — the latter avoids re-firing during the post-update reconnect window
/// before the new (matching) protocol lands.
fn auto_update_mismatched_remotes(
    state: &mut ClientState,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) {
    let candidates = match &state.supervisor_model {
        Some(model) => model.auto_update_candidates(),
        None => return,
    };
    for server_id in candidates {
        if state.pending_update_remote.contains(&server_id)
            || state.update_outcome_expiry.contains_key(&server_id)
            || state.auto_update_suppressed.contains(&server_id)
        {
            continue;
        }
        spawn_remote_update_for(state, &server_id, event_tx);
    }
}

fn spawn_client_update_remote(
    server_id: supervisor::ServerId,
    ssh_target: crate::remote::SshTarget,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
    pending_update_remote: &mut HashSet<supervisor::ServerId>,
) {
    if !pending_update_remote.insert(server_id.clone()) {
        return;
    }
    let event_tx = event_tx.clone();
    std::thread::spawn(move || {
        let started_at = Instant::now();
        let result = run_client_update_remote(&server_id, ssh_target, &event_tx);
        let elapsed = started_at.elapsed();
        let _ = event_tx.blocking_send(ClientLoopEvent::UpdateRemoteFinished {
            server_id,
            result,
            elapsed,
        });
    });
}

/// #44: the off-loop body of [`spawn_client_update_remote`]. PRE-FLIGHT seed check first (no install
/// attempt on an unbuildable platform → no internet download), then the bounded add-remote-style
/// provisioning. Returns `Ok(())` on a successful reinstall, `Err(message)` otherwise.
fn run_client_update_remote(
    server_id: &supervisor::ServerId,
    ssh_target: crate::remote::SshTarget,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) -> Result<(), String> {
    // (1) Truthful pre-flight: refuse (no download) when this build can't seed the remote platform.
    crate::remote::preflight_remote_update_seed(&ssh_target)?;

    // (2) Forward each provisioning stage to this host's banner sub-line.
    let progress_tx = event_tx.clone();
    let progress_server_id = server_id.clone();
    let on_progress = move |stage: crate::remote::RemoteProvisionStage| {
        let _ = progress_tx.blocking_send(ClientLoopEvent::UpdateRemoteProgress {
            server_id: progress_server_id.clone(),
            message: stage.label(),
        });
    };
    // Same provisioning the add-remote path uses; `restart_incompatible = true` so an incompatible
    // server is restarted onto the freshly-installed binary instead of blocking on a y/N prompt.
    let bridge =
        run_remote_op_with_progress(ADD_REMOTE_BRIDGE_IDLE_TIMEOUT, &on_progress, move |sink| {
            // #61: the "update" button FORCES a reinstall — reseed the current build even when the
            // remote reports the same version (a dev rebuild at the same version but a newer commit
            // is otherwise treated as already-installed and skipped), then live-hand-off onto it.
            crate::remote::start_ssh_remote_bridge(ssh_target, true, true, None, sink)
        })
        .map_err(|err| {
            let io_err = remote_op_error_io(err);
            match crate::remote::restart_confirm_needed(&io_err) {
                Some(confirm) => confirm.to_string(),
                None => map_remote_bridge_error(&io_err.to_string()),
            }
        })?;
    // The reinstall is done; drop the throwaway bridge. The loop schedules a fresh reconnect so the
    // live stream comes back up on the now-matching protocol (and re-fetches runtime status).
    drop(bridge);
    Ok(())
}

/// Worktree-menu parity: fetch `worktree.list` for the open picker from the OWNING server, off
/// the UI loop. The target is resolved while we're on the loop (model + bridge map in scope);
/// the round-trip runs on a worker thread and lands as `WorktreeListFetched`.
fn spawn_worktree_list_fetch(
    state: &mut ClientState,
    server_id: supervisor::ServerId,
    workspace_id: String,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) {
    let target = state
        .supervisor_model
        .as_ref()
        .and_then(|model| api_target_for_supervisor_server(model, &server_id, &state.ssh_bridges));
    let event_tx = event_tx.clone();
    std::thread::spawn(move || {
        let result = match target {
            Some(target) => fetch_worktree_picker_items(target, &workspace_id),
            None => Err("server is not reachable".to_string()),
        };
        let _ = event_tx.blocking_send(ClientLoopEvent::WorktreeListFetched {
            server_id,
            workspace_id,
            result,
        });
    });
}

/// The blocking body of [`spawn_worktree_list_fetch`]: one `worktree.list` round-trip, mapped to
/// picker rows (bare checkouts dropped — they can't be opened as a space).
fn fetch_worktree_picker_items(
    target: crate::api::client::ConnectionTarget,
    workspace_id: &str,
) -> Result<Vec<supervisor::WorktreePickerItem>, String> {
    let mut api = crate::api::client::ApiClient::for_target(target);
    let response = supervisor::SupervisorApi::request(
        &mut api,
        crate::api::schema::Request {
            id: "client:worktree-list".into(),
            method: crate::api::schema::Method::WorktreeList(
                crate::api::schema::WorktreeListParams {
                    workspace_id: Some(workspace_id.to_string()),
                    cwd: None,
                },
            ),
        },
    )?;
    match response.result {
        crate::api::schema::ResponseResult::WorktreeList { worktrees, .. } => Ok(worktrees
            .into_iter()
            .filter(|worktree| !worktree.is_bare)
            .map(|worktree| supervisor::WorktreePickerItem {
                label: if worktree.label.is_empty() {
                    worktree
                        .branch
                        .clone()
                        .unwrap_or_else(|| worktree.path.clone())
                } else {
                    worktree.label.clone()
                },
                path: worktree.path,
                open_workspace_id: worktree.open_workspace_id,
            })
            .collect()),
        other => Err(format!(
            "worktree.list returned unexpected result: {other:?}"
        )),
    }
}

/// C4: fetch `session.list` for the open picker from the OWNING server, off the UI loop. The api
/// target resolves to that host's socket (an ssh remote's LIVE bridge api socket), which is exactly
/// what makes the answer the REMOTE host's session list rather than this machine's.
fn spawn_session_list_fetch(
    state: &mut ClientState,
    server_id: supervisor::ServerId,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) {
    let target = state
        .supervisor_model
        .as_ref()
        .and_then(|model| api_target_for_supervisor_server(model, &server_id, &state.ssh_bridges));
    let event_tx = event_tx.clone();
    std::thread::spawn(move || {
        let result = match target {
            Some(target) => fetch_session_picker_items(target),
            None => Err("server is not reachable".to_string()),
        };
        let _ = event_tx.blocking_send(ClientLoopEvent::SessionListFetched { server_id, result });
    });
}

/// The blocking body of [`spawn_session_list_fetch`]: one `session.list` round-trip mapped to
/// picker rows. `is_current` is left false — the MODEL owns which row is current (`fill_session_picker`).
/// An old remote without the method answers with the standard unknown-method error, which lands on
/// the picker's error line and leaves the `new session…` row usable (C6).
fn fetch_session_picker_items(
    target: crate::api::client::ConnectionTarget,
) -> Result<Vec<supervisor::SessionPickerItem>, String> {
    let mut api = crate::api::client::ApiClient::for_target(target);
    let response = supervisor::SupervisorApi::request(
        &mut api,
        crate::api::schema::Request {
            id: "client:session-list".into(),
            method: crate::api::schema::Method::SessionList(
                crate::api::schema::EmptyParams::default(),
            ),
        },
    )?;
    match response.result {
        crate::api::schema::ResponseResult::SessionList { sessions } => Ok(sessions
            .into_iter()
            .map(|session| supervisor::SessionPickerItem {
                // The registry stores the default session as an ABSENT session, so it must map back
                // to `None` here — never to the literal "default".
                name: (!session.default).then(|| session.name.clone()),
                label: session.name,
                running: session.running,
                is_current: false,
            })
            .collect()),
        other => Err(format!(
            "session.list returned unexpected result: {other:?}"
        )),
    }
}

fn spawn_client_add_remote_submission(
    draft: supervisor::AddRemoteDraft,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
    pending_add_remote: &mut bool,
) {
    if *pending_add_remote {
        return;
    }
    *pending_add_remote = true;
    let event_tx = event_tx.clone();
    std::thread::spawn(move || {
        let started_at = Instant::now();
        let result = prepare_client_add_remote_submission(draft);
        let elapsed = started_at.elapsed();
        let _ = event_tx.blocking_send(ClientLoopEvent::AddRemoteFinished { result, elapsed });
    });
}

/// Outcome of a bounded remote op (see [`run_ssh_bridge_with_progress`]). Preserves the underlying
/// `io::Error` so callers can downcast typed signals (e.g. [`crate::remote::RestartConfirmNeeded`]).
#[derive(Debug)]
enum RemoteOpError {
    /// No progress for a whole idle window. `stage` names the last reported stage, so the message
    /// can say *what* stalled (e.g. "while installing") instead of always blaming the connect.
    TimedOut {
        idle: Duration,
        stage: Option<String>,
    },
    WorkerGone,
    Failed(io::Error),
}

/// How a failed secondary connection/provisioning attempt should be handled by the retry sweep.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProvisionFailureDisposition {
    /// Transient (network blips, timeouts, refused): keep the backoff retry running.
    Retry,
    /// Terminal (ssh auth, unknown host, impossible version/seed): stop retrying, surface the
    /// error on the host banner, and wait for an explicit retry (context-menu reconnect or a
    /// click on the banner's status glyph).
    Stop,
    /// Terminal like [`Self::Stop`], but the remote runs an incompatible server that can't
    /// live-handoff (issue #12): an explicit retry is allowed to restart that server.
    StopNeedsRestartConfirm,
}

/// Classify a failed secondary connection attempt. Protocol mismatches are handled by the caller
/// (they stop the retry and may trigger #61 auto-update); everything else is judged by the error
/// text: provably-unrecoverable conditions stop the sweep, anything ambiguous keeps retrying with
/// the conservative backoff (the pre-existing behaviour for plain reconnects).
fn classify_provision_failure(err: &ClientError) -> ProvisionFailureDisposition {
    if let ClientError::ConnectionFailed(io_err) = err {
        if crate::remote::restart_confirm_needed(io_err).is_some() {
            return ProvisionFailureDisposition::StopNeedsRestartConfirm;
        }
    }
    let text = err.to_string().to_ascii_lowercase();
    const TERMINAL_MARKERS: &[&str] = &[
        // ssh says the host itself is wrong or refuses us — retrying can't fix these.
        "permission denied",
        "too many authentication failures",
        "host key verification failed",
        "could not resolve hostname",
        "name or service not known",
        "nodename nor servname",
        // remote/unix.rs install verdicts: the binary/seed situation can't improve on its own.
        "not version",
        "can't be upgraded in place",
        "cannot seed remotes",
        "release manifest",
        "not executable on the remote host",
        "does not support the remote-bridge subcommands",
        "did not respond to --version",
        "installation cancelled",
    ];
    if TERMINAL_MARKERS.iter().any(|marker| text.contains(marker)) {
        ProvisionFailureDisposition::Stop
    } else {
        ProvisionFailureDisposition::Retry
    }
}

/// Run a blocking remote op on a helper thread, bounded by an *idle* timeout that resets every time
/// `op` reports a [`RemoteProvisionStage`]. This lets a slow-but-progressing fresh-host install run
/// as long as it keeps advancing, while a stuck/unreachable/auth-prompting host still fails within
/// one idle window. Reported stages are forwarded to `on_progress` (the dialog's live line); `op`
/// receives a [`ProgressSink`] it must call as it advances (issue #32).
fn run_remote_op_with_progress<T, F>(
    idle_timeout: Duration,
    on_progress: &dyn Fn(crate::remote::RemoteProvisionStage),
    op: F,
) -> Result<T, RemoteOpError>
where
    T: Send + 'static,
    F: FnOnce(&crate::remote::ProgressSink) -> io::Result<T> + Send + 'static,
{
    enum Msg<T> {
        Progress(crate::remote::RemoteProvisionStage),
        Done(io::Result<T>),
    }
    let (tx, rx) = std::sync::mpsc::channel::<Msg<T>>();
    let progress_tx = tx.clone();
    std::thread::spawn(move || {
        let sink = move |stage| {
            let _ = progress_tx.send(Msg::Progress(stage));
        };
        let result = op(&sink);
        let _ = tx.send(Msg::Done(result));
    });

    let mut last_stage: Option<String> = None;
    loop {
        match rx.recv_timeout(idle_timeout) {
            Ok(Msg::Progress(stage)) => {
                last_stage = Some(stage.label());
                on_progress(stage);
            }
            Ok(Msg::Done(Ok(value))) => return Ok(value),
            Ok(Msg::Done(Err(err))) => return Err(RemoteOpError::Failed(err)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return Err(RemoteOpError::TimedOut {
                    idle: idle_timeout,
                    stage: last_stage,
                })
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(RemoteOpError::WorkerGone)
            }
        }
    }
}

/// Collapse a bounded remote op failure into an `io::Error`, preserving a typed
/// [`crate::remote::RestartConfirmNeeded`] payload (callers downcast it for the retry-with-restart
/// affordance). Timeout/worker-gone keep the old dialog wording so logs stay greppable.
fn remote_op_error_io(err: RemoteOpError) -> io::Error {
    match err {
        RemoteOpError::TimedOut { idle, stage } => {
            let doing = stage.unwrap_or_else(|| "connecting to the remote host".to_string());
            io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "failed to start ssh remote bridge: no progress for {}s while {doing}",
                    idle.as_secs()
                ),
            )
        }
        RemoteOpError::WorkerGone => io::Error::other(
            "failed to start ssh remote bridge: remote connection worker exited unexpectedly",
        ),
        RemoteOpError::Failed(err) => err,
    }
}

/// Register the draft with the local main server's registry — parse + duplicate check +
/// `remote.add`. NO bridge provisioning happens here: on success the host row is inserted into
/// the sidebar immediately and the retry sweep brings the connection up with live per-host
/// progress (so the add-remote form never blocks on a slow install).
fn prepare_client_add_remote_submission(
    draft: supervisor::AddRemoteDraft,
) -> Result<crate::remote_registry::RemoteDefinitionSnapshot, String> {
    preflight_add_remote_target(&draft)?;

    let mut main_api = crate::api::client::ApiClient::local();
    submit_remote_add_to_main_api(&mut main_api, draft)
}

/// C1: resolve the draft's `(target, session)` through the SAME registry helper the server's
/// `remote.add` uses, then run the local duplicate check on the RESOLVED target.
///
/// The fold must happen BEFORE the duplicate check because a LOCAL remote's dedup key INCLUDES its
/// session: `localhost` + session `work` is the target `local:work`, not `local:default`. Checking
/// the unfolded target judged every session-pinned local remote a duplicate of this client's own
/// `local:default` main server and rejected it with "remote already added" — the request never
/// reached the API. Sharing `resolve_target_and_session` is what stops the two verdicts drifting
/// again. An invalid session name is rejected here with the exact message the server would return,
/// rather than reaching the API.
fn preflight_add_remote_target(
    draft: &supervisor::AddRemoteDraft,
) -> Result<crate::remote_registry::RemoteTargetSnapshot, String> {
    let (target, _session) =
        crate::remote_registry::resolve_target_and_session(&draft.target, draft.session.clone())
            .map_err(|err| err.message().to_string())?;
    reject_duplicate_main_target(&target)?;
    Ok(target)
}

fn reject_duplicate_main_target(
    target: &crate::remote_registry::RemoteTargetSnapshot,
) -> Result<(), String> {
    let Some(main_target) = main_server_target_snapshot() else {
        return Ok(());
    };
    if main_target.canonical_key() == target.canonical_key() {
        return Err("remote already added".to_string());
    }
    Ok(())
}

fn main_server_target_snapshot() -> Option<crate::remote_registry::RemoteTargetSnapshot> {
    if let Ok(target) = std::env::var(crate::remote::MAIN_REMOTE_TARGET_ENV_VAR) {
        return crate::remote_registry::RemoteTargetSnapshot::parse(&target).ok();
    }

    Some(crate::remote_registry::RemoteTargetSnapshot::Local {
        session: crate::session::active_name(),
    })
}

/// #42: spawn the LOCAL main/registry/ui-settings/summary refresh OFF the UI loop. The render/
/// event-loop thread used to make four blocking Unix-socket round-trips here, re-fired once per
/// connecting remote — an O(N-remotes) freeze. Now a single worker thread fetches the snapshot and
/// posts `MainSupervisorRefreshed`, applied back on the loop. `pending_main_refresh` coalesces a
/// burst of triggers into one in-flight worker (the result handler clears it).
fn spawn_main_supervisor_refresh(
    pending_main_refresh: &mut bool,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) {
    if *pending_main_refresh {
        return;
    }
    *pending_main_refresh = true;
    let event_tx = event_tx.clone();
    std::thread::spawn(move || {
        let started_at = Instant::now();
        let mut api = crate::api::client::ApiClient::local();
        let result = supervisor::fetch_main_supervisor_snapshot(&mut api);
        let _ = event_tx.blocking_send(ClientLoopEvent::MainSupervisorRefreshed {
            result,
            elapsed: started_at.elapsed(),
        });
    });
}

/// #42: one-shot cold-start hydrate. The paint-first bootstrap (`bootstrap_supervisor_for_client`)
/// returns a minimal main-only model so the first frame renders with no blocking round-trips; this
/// worker then runs the full `bootstrap_from_main_api` (registry + summary + ui-settings, degrading
/// gracefully if the server lacks `remote.list`) off the UI thread and posts the hydrated model to
/// swap in. Fire-and-forget: a failed hydrate simply leaves the safe minimal model in place.
fn spawn_main_supervisor_bootstrap(event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>) {
    let event_tx = event_tx.clone();
    std::thread::spawn(move || {
        let mut api = crate::api::client::ApiClient::local();
        match supervisor::bootstrap_from_main_api(&mut api, main_display_name_for_client()) {
            Ok(model) => {
                let _ = event_tx
                    .blocking_send(ClientLoopEvent::MainSupervisorBootstrapped(Box::new(model)));
            }
            Err(err) => warn!(
                err = %err,
                "cold-start supervisor hydrate failed off the UI thread; keeping the minimal \
                 paint-first model (the 2s refresh will retry)"
            ),
        }
    });
}

fn refresh_client_supervisor_summaries(
    model: &mut supervisor::ClientSupervisorModel,
    pending_main_refresh: &mut bool,
    ssh_bridges: &HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
    pending_summary_refresh_server_ids: &mut HashSet<supervisor::ServerId>,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) {
    // #42: the main-server refresh is now async (posts `MainSupervisorRefreshed`); the #36
    // frame_cache prune moved into that result handler, after the registry sync actually lands.
    spawn_main_supervisor_refresh(pending_main_refresh, event_tx);
    let immediate_results = start_secondary_supervisor_summary_refreshes(
        model,
        ssh_bridges,
        pending_summary_refresh_server_ids,
        event_tx,
    );
    model.apply_secondary_summary_results(immediate_results);
}

fn start_secondary_supervisor_summary_refreshes(
    model: &supervisor::ClientSupervisorModel,
    ssh_bridges: &HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
    pending_summary_refresh_server_ids: &mut HashSet<supervisor::ServerId>,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) -> Vec<(
    supervisor::ServerId,
    Result<supervisor::ServerSummary, supervisor::ConnectionState>,
)> {
    let mut immediate_results = Vec::new();
    for plan in model.secondary_connection_plans() {
        if pending_summary_refresh_server_ids.contains(&plan.server_id) {
            continue;
        }
        let Some(target) =
            api_target_for_supervisor_target(&plan.server_id, &plan.target, ssh_bridges)
        else {
            immediate_results.push((plan.server_id, Err(supervisor::ConnectionState::Connecting)));
            continue;
        };
        let server_id = plan.server_id;
        pending_summary_refresh_server_ids.insert(server_id.clone());
        let event_tx = event_tx.clone();
        std::thread::spawn(move || {
            fetch_and_post_secondary_summary(target, server_id, &event_tx);
        });
    }
    immediate_results
}

/// item 6 (Area 6): a targeted single-server summary fetch. Mirrors the per-plan body of
/// `start_secondary_supervisor_summary_refreshes` for exactly ONE server id, so a focus / connect
/// / event-push refreshes only the changed server (not the whole fleet).
///
/// The contract fixes the `model` param as a SHARED `&ClientSupervisorModel`, but the local main
/// refresh requires `&mut self`. So the **main-server id is a no-op here**: the local main refresh
/// is owned by each caller (which already holds `&mut state.supervisor_model`). The Timer path
/// never passes main — `due_secondary_summary_refreshes` filters it out. Secondary ids dedupe via
/// `pending` and spawn the fetch off the UI loop (NO blocking SSH/API call on the loop).
fn start_single_secondary_summary_refresh(
    model: &supervisor::ClientSupervisorModel,
    server_id: &supervisor::ServerId,
    ssh_bridges: &HashMap<supervisor::ServerId, crate::remote::RemoteBridge>,
    pending: &mut HashSet<supervisor::ServerId>,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) {
    // Main-server id: no SSH fetch. The caller performs the local `&mut`
    // `refresh_main_summary_from_api` (D1 signature constraint).
    if *server_id == supervisor::ServerId::main() {
        return;
    }
    // Dedupe: a refresh for this server is already running off the UI loop.
    if pending.contains(server_id) {
        return;
    }
    let Some(target) = model.server_connection_target(server_id) else {
        return;
    };
    let Some(api_target) = api_target_for_supervisor_target(server_id, &target, ssh_bridges) else {
        // The SSH bridge is not up yet; the connect/retry path owns bringing it up and the next
        // tick re-attempts. Do nothing this call.
        return;
    };
    pending.insert(server_id.clone());
    let server_id = server_id.clone();
    let event_tx = event_tx.clone();
    std::thread::spawn(move || {
        fetch_and_post_secondary_summary(api_target, server_id, &event_tx);
    });
}

/// #61: fetch a secondary's summary AND its runtime version/protocol over one api connection, then
/// post BOTH back to the loop — the runtime status (so the host context-menu version readout
/// reflects this LIVE host; the summary fetch's Ping used to capture it then throw it away) and the
/// summary itself. Shared by the whole-fleet refresh and the single-server refresh so the populate
/// wiring lives in exactly one place. The runtime status is posted FIRST so the version is recorded
/// before any mismatch-driven `ConnectionState::ProtocolMismatch` lands from the summary result.
fn fetch_and_post_secondary_summary(
    target: crate::api::client::ConnectionTarget,
    server_id: supervisor::ServerId,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) {
    let started_at = Instant::now();
    let (runtime, result) = supervisor::fetch_server_summary_with_runtime_status(target);
    let elapsed = started_at.elapsed();
    if let Some(runtime) = runtime {
        let _ = event_tx.blocking_send(ClientLoopEvent::SupervisorRuntimeStatusFetched {
            server_id: server_id.clone(),
            version: runtime.version,
            protocol: runtime.protocol,
        });
    }
    let _ = event_tx.blocking_send(ClientLoopEvent::SupervisorSummaryFetched {
        server_id,
        result,
        elapsed,
    });
}

fn supervisor_summary_refresh_due(now: Instant, last_refresh: Instant) -> bool {
    now.duration_since(last_refresh) >= CLIENT_SUPERVISOR_REFRESH_INTERVAL
}

/// item 6 (Area 6): the adaptive secondary refresh schedule. Returns the connected secondary ids
/// whose per-server cadence is due at `now`. The active remote uses the fast 400ms cadence; all
/// other connected secondaries use the 2s background cadence. Main is ALWAYS excluded (the local
/// main refresh is owned by the 2s gate / the `&mut` callers). A server with no recorded
/// `last_summary_refresh` is treated as due immediately (a baseline at least one interval in the
/// past). This is a pure helper so the cadence is unit-testable and the Timer body issues no
/// inline blocking call.
fn due_secondary_summary_refreshes(state: &ClientState, now: Instant) -> Vec<supervisor::ServerId> {
    let Some(model) = state.supervisor_model.as_ref() else {
        return Vec::new();
    };
    let active = model.active_server_id();
    model
        .summary_subscription_plans()
        .into_iter()
        .map(|plan| plan.server_id)
        .filter(|server_id| *server_id != supervisor::ServerId::main())
        .filter(|server_id| {
            let interval = if server_id == active {
                CLIENT_FOCUSED_SUMMARY_REFRESH_INTERVAL
            } else {
                CLIENT_SUPERVISOR_REFRESH_INTERVAL
            };
            match state.last_summary_refresh.get(server_id) {
                Some(last) => now.duration_since(*last) >= interval,
                None => true,
            }
        })
        .collect()
}

/// item 5: the select-loop wakeup deadline. With nothing animating we keep the existing 100ms
/// housekeeping cadence (idle behavior unchanged, zero recompose). While animating we wake at
/// whichever is sooner: the 100ms housekeeping tick or the next 80ms animation step. Kept on
/// std `Instant` for unit-testability; the call site converts to `tokio::time::Instant`.
fn next_select_deadline(
    now: Instant,
    last_animation_tick: Instant,
    wants_animation: bool,
    pending_hover_render: bool,
    last_composited_render_at: Instant,
) -> Instant {
    let housekeeping = now + Duration::from_millis(100);
    let mut deadline = if wants_animation {
        housekeeping.min(last_animation_tick + CLIENT_ANIMATION_INTERVAL)
    } else {
        housekeeping
    };
    // #48: a sidebar hover defers its render (latest-wins coalescing) instead of repainting per
    // motion event. Wake within one frame budget of the last composited frame to flush the pending
    // hover highlight — capped at 60fps so a fast motion sweep that floods one `Moved` per crossed
    // row renders at most once per frame, never once per event. `.max(now)` keeps the deadline in
    // the present (not the past) when more than a budget has already elapsed → flush next tick.
    if pending_hover_render {
        let hover_deadline = (last_composited_render_at + CLIENT_60FPS_FRAME_BUDGET).max(now);
        deadline = deadline.min(hover_deadline);
    }
    deadline
}

/// item 5: whether the gated animation step should advance the tick this Timer event. True only
/// when something is animating AND at least one full 80ms interval has elapsed since the last
/// advance — the `last_animation_tick` guard coalesces sub-80ms Timer storms to <=1 tick.
fn should_advance_animation(
    wants_animation: bool,
    now: Instant,
    last_animation_tick: Instant,
) -> bool {
    wants_animation && now.duration_since(last_animation_tick) >= CLIENT_ANIMATION_INTERVAL
}

/// item 5: working-since map upkeep, run in the event loop BEFORE compose (keeps render pure).
/// Reads the cached model only; performs NO I/O. Inserts `now` for every currently-Working
/// `(server_id, agent_id)` not already tracked (first-working-start preserved across composes),
/// and drops any tracked key that is no longer Working so the map stays bounded.
fn prune_and_seed_working_since(
    compositor: &mut compositor::ClientCompositor,
    model: &supervisor::ClientSupervisorModel,
    now: Instant,
) {
    let mut working_keys = std::collections::HashSet::new();
    for group in model.agent_groups() {
        for agent in &group.agents {
            if agent.status == "working" {
                let key = (group.server_id.clone(), agent.agent_id.clone());
                working_keys.insert(key.clone());
                compositor.seed_working_since(key, now);
            }
        }
    }
    compositor.retain_working_since(|key| working_keys.contains(key));
}

fn secondary_retry_delay(attempt: usize) -> Duration {
    match attempt {
        0 => Duration::from_secs(1),
        1 => Duration::from_secs(2),
        2 => Duration::from_secs(5),
        _ => Duration::from_secs(15),
    }
}

/// item 3 (Area 5): apply the result of a finished `remote.set_enabled`/`remote.remove` request.
/// The registry refresh rides the synchronous-against-local-main path inside
/// `refresh_client_supervisor_summaries` (LOCAL socket, no SSH RTT — the same call
/// `AddRemoteFinished` makes), so it stays on the loop without violating the off-UI-loop SSH rule;
/// the off-thread part (`3d47acd`) was only the `set_enabled`/`remove` request itself. On error it
/// clears `pending`. On success it refreshes the registry and then:
/// - re-enable → explicit `Connecting` (so the now-ungated plans pick it up next tick),
/// - disable-while-connected → teardown like `ServerDisconnected` + `Disconnected`,
/// - delete → `remove_secondary` + teardown.
fn apply_remote_manage_request_finished(
    state: &mut ClientState,
    server_writes: &mut HashMap<supervisor::ServerId, ServerWriteHandle>,
    action: RemoteManageAction,
    remote_id: &str,
    result: Result<(), String>,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) {
    let server_id = supervisor::ServerId::secondary(remote_id);
    if let Err(err) = result {
        warn!(remote_id = %remote_id, err = %err, "remote-manage request failed");
        if let Some(model) = &mut state.supervisor_model {
            model.clear_remote_manage_pending(remote_id);
            // A rejected registry mutation used to be swallowed here — only a log line, nothing
            // where the user is looking. (A `remote.set_session` refused with
            // `duplicate_remote_target` closed the picker and changed nothing, silently.) Surface it
            // on the host banner's outcome sub-line, the same channel `update` uses for
            // "✗ update failed", and expire it on the same timer.
            model.set_update_progress(&server_id, None);
            model.set_update_outcome(
                &server_id,
                crate::app::state::HostUpdateOutcome {
                    message: format!("✗ {} failed: {err}", remote_manage_action_label(&action)),
                    success: false,
                },
            );
            // C6: a failed session switch typed into the new-session input keeps THAT overlay open
            // with the reason inline, instead of closing as if it had worked.
            if matches!(action, RemoteManageAction::SetSession { .. }) {
                model.fail_new_session(remote_id, err);
            }
        }
        state
            .update_outcome_expiry
            .insert(server_id.clone(), Instant::now() + HOST_UPDATE_OUTCOME_TTL);
        return;
    }

    match action {
        RemoteManageAction::SetEnabled { enabled: true } => {
            if let Some(model) = &mut state.supervisor_model {
                refresh_client_supervisor_summaries(
                    model,
                    &mut state.pending_main_refresh,
                    &state.ssh_bridges,
                    &mut state.pending_summary_refresh_server_ids,
                    event_tx,
                );
                // re-enable MUST explicitly yield `Connecting` so the now-ungated
                // `unconnected_secondary_server_ids()` picks it up next tick
                // (`sync_remote_registry` never re-applies connection_state).
                let _ =
                    model.set_connection_state(&server_id, supervisor::ConnectionState::Connecting);
                model.clear_remote_manage_pending(remote_id);
            }
        }
        RemoteManageAction::SetEnabled { enabled: false } => {
            if let Some(model) = &mut state.supervisor_model {
                refresh_client_supervisor_summaries(
                    model,
                    &mut state.pending_main_refresh,
                    &state.ssh_bridges,
                    &mut state.pending_summary_refresh_server_ids,
                    event_tx,
                );
            }
            teardown_secondary_connection(state, server_writes, &server_id);
            if let Some(model) = &mut state.supervisor_model {
                let _ = model
                    .set_connection_state(&server_id, supervisor::ConnectionState::Disconnected);
                model.clear_remote_manage_pending(remote_id);
            }
        }
        RemoteManageAction::SetAutoUpdate { .. } => {
            // #61: a deliberate toggle is fresh intent — lift any post-failure auto-update suppression
            // so turning it back on (or off→on) re-attempts a previously-failed host.
            state.auto_update_suppressed.remove(&server_id);
            // No connection side-effect — just re-sync the registry (so the host-menu toggle label
            // reflects the persisted flag) and then sweep: if auto-update was just turned ON for an
            // already-mismatched host, push the update now instead of waiting for the next
            // runtime-status tick to notice.
            if let Some(model) = &mut state.supervisor_model {
                refresh_client_supervisor_summaries(
                    model,
                    &mut state.pending_main_refresh,
                    &state.ssh_bridges,
                    &mut state.pending_summary_refresh_server_ids,
                    event_tx,
                );
                model.clear_remote_manage_pending(remote_id);
            }
            auto_update_mismatched_remotes(state, event_tx);
        }
        // C4/C6: the session is part of the CONNECTION identity — the bridge is `herdr --session
        // <name>` on the far side — so a persisted change only takes effect once the bridge is
        // rebuilt. Reuse the exact `DisconnectRemote` teardown + `ReconnectRemote` reconnect bodies,
        // but WITHOUT the `manually_disconnected` mark: the user asked to switch sessions, not to
        // park the host down, so the retry sweep must dial it straight back up.
        RemoteManageAction::SetSession { .. } => {
            // C6: the new-session overlay stayed open across the round-trip so a rejection could be
            // shown inline; the switch landed, so close it now.
            if let Some(model) = &mut state.supervisor_model {
                model.finish_new_session(remote_id);
            }
            teardown_secondary_connection(state, server_writes, &server_id);
            state.manually_disconnected.remove(&server_id);
            state.provision_failed.remove(&server_id);
            if let Some(model) = &mut state.supervisor_model {
                // Re-sync the registry first, so the rebuilt connection plan (and the host menu's
                // session readout) carry the session that was just persisted.
                refresh_client_supervisor_summaries(
                    model,
                    &mut state.pending_main_refresh,
                    &state.ssh_bridges,
                    &mut state.pending_summary_refresh_server_ids,
                    event_tx,
                );
                let _ =
                    model.set_connection_state(&server_id, supervisor::ConnectionState::Connecting);
                model.set_update_progress(&server_id, None);
                model.clear_update_outcome(&server_id);
                model.clear_remote_manage_pending(remote_id);
            }
            state.update_outcome_expiry.remove(&server_id);
            schedule_secondary_retry(state, server_id, 0, Instant::now());
        }
        RemoteManageAction::Delete => {
            teardown_secondary_connection(state, server_writes, &server_id);
            if let Some(model) = &mut state.supervisor_model {
                model.remove_secondary(&server_id);
                refresh_client_supervisor_summaries(
                    model,
                    &mut state.pending_main_refresh,
                    &state.ssh_bridges,
                    &mut state.pending_summary_refresh_server_ids,
                    event_tx,
                );
                model.clear_remote_manage_pending(remote_id);
            }
        }
    }
}

/// item 3 (Area 5): tear down a secondary's stream/bridge/poll state exactly like the
/// `ServerDisconnected` handler does (remove from `server_writes`, `frame_cache`,
/// `summary_subscription_server_ids`, `pending_summary_refresh_server_ids`,
/// `pending_secondary_connect_server_ids`, `ssh_bridges`). Unlike `ServerDisconnected` it does NOT
/// schedule a retry — the caller (disable / delete) wants the remote to stay down (the gated
/// producers exclude a disabled remote; a deleted remote is gone). Does NOT touch the model
/// `connection_state` (the caller sets it).
fn teardown_secondary_connection(
    state: &mut ClientState,
    server_writes: &mut HashMap<supervisor::ServerId, ServerWriteHandle>,
    server_id: &supervisor::ServerId,
) {
    server_writes.remove(server_id);
    state.frame_cache.remove(server_id);
    state.summary_subscription_server_ids.remove(server_id);
    state.pending_summary_refresh_server_ids.remove(server_id);
    state.pending_secondary_connect_server_ids.remove(server_id);
    state.ssh_bridges.remove(server_id);
    state.secondary_retries.remove(server_id);
    // Drop any in-flight ping nonce so a torn-down server leaves no stale entry behind.
    state.pending_pings.remove(server_id);
}

/// #44: apply a one-click `UpdateRemoteFinished` to the client state. Always clears the host's
/// banner progress line. On Ok, tears the (now stale-protocol) stream down and schedules an
/// attempt-0 (shortest backoff) reconnect so the live stream comes back up on the freshly-installed,
/// now-matching protocol; on Err, leaves a truthful message on the progress line so the failure is
/// visible (and NEVER triggers an internet download — the worker pre-flighted that away). Extracted
/// so the Ok/Err branches are unit-testable without the full event loop.
fn apply_update_remote_finished(
    state: &mut ClientState,
    server_writes: &mut HashMap<supervisor::ServerId, ServerWriteHandle>,
    server_id: &supervisor::ServerId,
    result: Result<(), String>,
    now: Instant,
) {
    match result {
        Ok(()) => {
            if let Some(model) = &mut state.supervisor_model {
                model.set_update_progress(server_id, None);
                // #61: positive, observable "done" signal in place of the vanished spinner. Starts
                // version-less; the post-update reconnect's runtime-status fetch enriches it to
                // "✓ updated to vX.Y.Z" via `enrich_update_success_with_version`.
                model.set_update_outcome(
                    server_id,
                    crate::app::state::HostUpdateOutcome {
                        message: "✓ update complete".to_string(),
                        success: true,
                    },
                );
                let _ =
                    model.set_connection_state(server_id, supervisor::ConnectionState::Connecting);
            }
            state
                .update_outcome_expiry
                .insert(server_id.clone(), now + HOST_UPDATE_OUTCOME_TTL);
            // #61: a success clears any prior auto-update suppression for this host (it is now on the
            // matching protocol, so it is not a candidate anyway — but keep the set tidy).
            state.auto_update_suppressed.remove(server_id);
            // Drop the stale-protocol stream and dial it back up on the new binary at the shortest
            // (attempt-0) backoff — same as #43's "reconnect" path.
            teardown_secondary_connection(state, server_writes, server_id);
            state.manually_disconnected.remove(server_id);
            schedule_secondary_retry(state, server_id.clone(), 0, now);
        }
        Err(message) => {
            if let Some(model) = &mut state.supervisor_model {
                // #61: clear the spinner and surface a clear, lingering failure instead of leaving a
                // stale "installing…"-looking progress line frozen on the banner (the old behaviour).
                model.set_update_progress(server_id, None);
                model.set_update_outcome(
                    server_id,
                    crate::app::state::HostUpdateOutcome {
                        message: format!("✗ update failed: {message}"),
                        success: false,
                    },
                );
            }
            state
                .update_outcome_expiry
                .insert(server_id.clone(), now + HOST_UPDATE_FAILURE_TTL);
            // #61: suppress AUTO-update retries for this host — a failed update (e.g. the local build
            // can't seed its platform) would otherwise re-fire every cadence once the outcome line
            // expires. The manual menu `update` still works; a deliberate auto-update re-toggle (or a
            // later success) clears this.
            state.auto_update_suppressed.insert(server_id.clone());
        }
    }
}

/// #61: clear any host update-outcome banner line whose display window has elapsed at `now`. The
/// model holds the outcome text (no clock); this loop-side sweep removes it after the per-outcome TTL
/// recorded in `update_outcome_expiry` (success vs failure). Returns whether anything was cleared, so
/// the Timer can trigger exactly one repaint when a line actually leaves.
fn expire_host_update_outcomes(state: &mut ClientState, now: Instant) -> bool {
    if state.update_outcome_expiry.is_empty() {
        return false;
    }
    let expired: Vec<supervisor::ServerId> = state
        .update_outcome_expiry
        .iter()
        .filter(|(_, deadline)| now >= **deadline)
        .map(|(id, _)| id.clone())
        .collect();
    if expired.is_empty() {
        return false;
    }
    for id in &expired {
        state.update_outcome_expiry.remove(id);
        if let Some(model) = &mut state.supervisor_model {
            model.clear_update_outcome(id);
        }
    }
    true
}

/// #44: re-fetch a remote's runtime version/protocol off the UI loop and post it back via
/// `SupervisorRuntimeStatusFetched` so the host context-menu readout clears its mismatch flag after
/// an update. Establishes its own short-lived ssh bridge from the host's ssh target (the live
/// stream is being torn down + reconnected, so its api bridge isn't available). No-op for non-ssh
/// hosts or when the host is gone. Fire-and-forget: a failed fetch simply leaves the stale readout.
fn refetch_secondary_runtime_status(
    state: &mut ClientState,
    server_id: &supervisor::ServerId,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) {
    let Some(ssh_target) = state.supervisor_model.as_ref().and_then(|model| {
        model
            .server_ssh_target(server_id)
            .map(|(destination, options)| crate::remote::SshTarget::new(destination, options))
    }) else {
        return;
    };
    // C1/C4: probe the session this host is actually pinned to — a throwaway bridge on the wrong
    // session would spin up (and report) the remote's DEFAULT session instead.
    let session_name = state
        .supervisor_model
        .as_ref()
        .and_then(|model| model.server_session(server_id));
    let server_id = server_id.clone();
    let event_tx = event_tx.clone();
    std::thread::spawn(move || {
        let bridge = match crate::remote::start_ssh_remote_bridge(
            ssh_target,
            false,
            false, // status-only refetch: never reinstall
            session_name.as_deref(),
            &crate::remote::ignore_progress,
        ) {
            Ok(bridge) => bridge,
            Err(err) => {
                warn!(err = %err, "post-update runtime status refetch failed to start ssh bridge");
                return;
            }
        };
        let mut api = crate::api::client::ApiClient::for_target(
            crate::api::client::ConnectionTarget::SocketPath(
                bridge.api_socket_path().to_path_buf(),
            ),
        );
        match supervisor::request_runtime_status(&mut api) {
            Ok(status) => {
                let _ = event_tx.blocking_send(ClientLoopEvent::SupervisorRuntimeStatusFetched {
                    server_id,
                    version: status.version,
                    protocol: status.protocol,
                });
            }
            Err(err) => warn!(err = %err, "post-update runtime status refetch failed"),
        }
        drop(bridge);
    });
}

fn schedule_secondary_retry(
    state: &mut ClientState,
    server_id: supervisor::ServerId,
    attempt: usize,
    now: Instant,
) {
    state.secondary_retries.insert(
        server_id,
        SecondaryRetryState {
            attempt,
            next_retry_at: now + secondary_retry_delay(attempt),
        },
    );
}

fn schedule_missing_secondary_stream_retries(
    state: &mut ClientState,
    server_writes: &HashMap<supervisor::ServerId, ServerWriteHandle>,
    now: Instant,
) {
    let Some(model) = &state.supervisor_model else {
        return;
    };
    let connected_streams: HashSet<_> = server_writes.keys().cloned().collect();
    let retry_server_ids = model
        .secondary_server_ids_missing_client_stream(&connected_streams)
        .into_iter()
        .chain(model.unconnected_secondary_server_ids());
    for server_id in retry_server_ids {
        // #43: a manually-disconnected host stays down — never re-enqueue its stream retry, or the
        // next tick would silently reconnect it (collapsing Disconnect into a no-op). A host whose
        // provisioning failed TERMINALLY likewise stays down until an explicit retry clears the
        // mark (re-enqueueing it here would undo the stop-on-terminal-failure classification).
        if state.manually_disconnected.contains(&server_id)
            || state.provision_failed.contains(&server_id)
        {
            continue;
        }
        state
            .secondary_retries
            .entry(server_id.clone())
            .or_insert_with(|| SecondaryRetryState {
                attempt: 0,
                next_retry_at: now,
            });
    }
}

fn handle_server_write_failure(
    state: &mut ClientState,
    server_writes: &mut HashMap<supervisor::ServerId, ServerWriteHandle>,
    server_id: supervisor::ServerId,
    error: io::Error,
    now: Instant,
) -> Result<(), ClientError> {
    if server_id == supervisor::ServerId::main() {
        return Err(ClientError::ConnectionLost(error));
    }

    warn!(
        server_id = ?server_id,
        err = %error,
        "secondary server write failed; marking it disconnected"
    );
    server_writes.remove(&server_id);
    // #36: DON'T drop the last frame on an involuntary disconnect. Keep `frame_cache` so a switch to
    // this (now greyed) host paints its last screen — selectable/copyable — instead of a blank, and
    // so reconnect can transition from the cached frame to live without a blank flash. The retained
    // summaries keep the host's individual space rows listed (greyed) rather than collapsing to one
    // placeholder. A voluntary disable/delete still clears the cache via `teardown_secondary_connection`.
    state.summary_subscription_server_ids.remove(&server_id);
    state.pending_summary_refresh_server_ids.remove(&server_id);
    state
        .pending_secondary_connect_server_ids
        .remove(&server_id);
    state.ssh_bridges.remove(&server_id);
    // Drop any in-flight ping nonce for the failed server (its Pong will never arrive).
    state.pending_pings.remove(&server_id);
    if let Some(model) = &mut state.supervisor_model {
        let _ = model.set_connection_state(&server_id, supervisor::ConnectionState::Disconnected);
    }
    schedule_secondary_retry(state, server_id, 0, now);
    state.request_full_redraw();
    Ok(())
}

fn retry_due_secondary_connections(
    state: &mut ClientState,
    now: Instant,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
    server_writes: &mut HashMap<supervisor::ServerId, ServerWriteHandle>,
) {
    let due: Vec<(supervisor::ServerId, usize)> = state
        .secondary_retries
        .iter()
        .filter(|(_, retry)| retry.next_retry_at <= now)
        .map(|(server_id, retry)| (server_id.clone(), retry.attempt))
        .collect();

    for (server_id, attempt) in due {
        // #43: a manually-disconnected host must not be reconnected by the retry sweep — nor a
        // host stopped on a terminal provisioning failure. Drop any stale retry entry and skip it
        // so it stays down until an explicit "reconnect"/retry.
        if state.manually_disconnected.contains(&server_id)
            || state.provision_failed.contains(&server_id)
        {
            state.secondary_retries.remove(&server_id);
            continue;
        }
        if server_writes.contains_key(&server_id) {
            state.secondary_retries.remove(&server_id);
            continue;
        }
        if state
            .pending_secondary_connect_server_ids
            .contains(&server_id)
        {
            continue;
        }

        let plan = state.supervisor_model.as_ref().and_then(|model| {
            model
                .secondary_connection_plans()
                .into_iter()
                .find(|plan| plan.server_id == server_id)
        });
        let Some(plan) = plan else {
            state.secondary_retries.remove(&server_id);
            continue;
        };

        let existing_ssh_client_socket = state
            .ssh_bridges
            .get(&server_id)
            .map(|bridge| bridge.client_socket_path().to_path_buf());
        state
            .pending_secondary_connect_server_ids
            .insert(server_id.clone());
        // One-shot approval from an explicit retry after a restart-confirm failure (issue #12):
        // this attempt may restart an incompatible no-handoff remote server. Consumed here so a
        // later background retry can never restart a server without a fresh approval.
        let restart_incompatible = state.retry_restart_incompatible.remove(&server_id);
        spawn_secondary_connection_retry(
            server_id.clone(),
            attempt,
            plan,
            state.reported_size,
            state.cell_size_px.0,
            state.cell_size_px.1,
            existing_ssh_client_socket,
            restart_incompatible,
            event_tx,
        );
        if let Some(model) = &mut state.supervisor_model {
            let _ = model.set_connection_state(&server_id, supervisor::ConnectionState::Connecting);
            // A fresh attempt owns the banner sub-lines: drop the previous attempt's stage log and
            // any terminal failure outcome so this run's progress is never masked by stale lines.
            model.set_update_progress(&server_id, None);
            model.clear_update_outcome(&server_id);
        }
        state.update_outcome_expiry.remove(&server_id);
        state.request_full_redraw();
    }
}

fn spawn_secondary_connection_retry(
    server_id: supervisor::ServerId,
    attempt: usize,
    plan: supervisor::SecondaryConnectionPlan,
    server_size: (u16, u16),
    cell_width_px: u32,
    cell_height_px: u32,
    existing_ssh_client_socket: Option<std::path::PathBuf>,
    restart_incompatible: bool,
    event_tx: &tokio::sync::mpsc::Sender<ClientLoopEvent>,
) {
    let event_tx = event_tx.clone();
    std::thread::spawn(move || {
        let started_at = Instant::now();
        // Forward each provisioning stage to the host's banner sub-lines (the same per-host feed
        // the one-click "update" uses), so a fresh-host install during add-remote/reconnect reads
        // as forward motion in the sidebar instead of a silent "connecting…" (issue #32).
        let progress_tx = event_tx.clone();
        let progress_server_id = server_id.clone();
        let on_progress = move |stage: crate::remote::RemoteProvisionStage| {
            let _ = progress_tx.blocking_send(ClientLoopEvent::UpdateRemoteProgress {
                server_id: progress_server_id.clone(),
                message: stage.label(),
            });
        };
        let result = connect_secondary_client_stream_for_plan_detached(
            plan,
            server_size,
            cell_width_px,
            cell_height_px,
            existing_ssh_client_socket,
            restart_incompatible,
            &on_progress,
        );
        let elapsed = started_at.elapsed();
        let _ = event_tx.blocking_send(ClientLoopEvent::SecondaryConnectionAttemptFinished {
            server_id,
            attempt,
            result,
            elapsed,
        });
    });
}

fn select_composited_render_frame<'a>(
    frames: &'a HashMap<supervisor::ServerId, protocol::FrameData>,
    active_server_id: &supervisor::ServerId,
    _incoming_server_id: &supervisor::ServerId,
) -> Option<&'a protocol::FrameData> {
    frames.get(active_server_id)
}

fn render_cached_composited_frame(state: &mut ClientState) {
    // #45: every caller here is a model/view/timer/animation change, so force a fresh hover-less
    // shell and repopulate the cache the following pure content frames reuse.
    recompose_composited_frame(state, true);
}

/// many-remotes: request a full (model-change) render, COALESCED to at most one per frame budget.
/// A fleet-scale event storm — a connect storm of N remotes, or the 400ms/2s summary-refresh cadence
/// firing across every connected remote — used to run one full `build_shell`/`from_model`
/// (O(hosts×agents)) rebuild PER event, serially, so the UI dropped to ~1fps while the storm drained.
/// The model mutation has already been applied by the caller (cheap); here we only gate the expensive
/// RENDER: if a full frame budget has elapsed since the last flushed frame, render now; otherwise mark
/// it pending and let the Timer flush ONE rebuild at the next frame boundary (latest-wins, applying
/// every mutation that landed in between). So render cost is bounded to one rebuild per frame
/// regardless of how many remotes flood updates — the UI stays responsive at any fleet size.
fn request_composited_render(state: &mut ClientState) {
    if state.last_composited_render_at.elapsed() >= CLIENT_60FPS_FRAME_BUDGET {
        render_cached_composited_frame(state);
    } else {
        state.pending_full_render = true;
    }
}

/// #56: compose the cached shell + live content + the per-frame hover overlay, then flush.
///
/// `rebuild = true` forces a fresh hover-less shell (a genuine model/view/size change). A
/// hover/menu-selection repaint passes `false`: the cached hover-less shell is still valid (the
/// highlight was never baked into it), so we skip the expensive `build_shell` and just re-lay the
/// content + repaint the highlight via [`compositor::apply_hover_overlay`] (#48/#55/#56).
fn recompose_composited_frame(state: &mut ClientState, rebuild: bool) {
    // item 5: take &mut access to the compositor so we can refresh the working-since map before
    // the immutable compose borrow — keeps the live duration timer fresh on every compose, not
    // just animation ticks (render itself stays pure; the map upkeep performs no I/O).
    let now = Instant::now();
    let host = state.host_size;
    if let (Some(compositor), Some(model)) =
        (state.compositor.as_mut(), state.supervisor_model.as_ref())
    {
        // #48: resolve the latest deferred sidebar motion into the hover target ONCE per composed
        // frame — runs the expensive `hover_test`/`from_model` a single time per frame, not once per
        // motion event (the <1fps hover flood). A no-op when no motion is pending.
        compositor.resolve_pending_hover(model, host.0, host.1);
        prune_and_seed_working_since(compositor, model, now);
    }

    // Response-first switching (issue #13): paint the target server's last-known frame instantly.
    // If we have never received a frame for it, fall back to a blank content frame so the switch
    // still repaints the new shell at once instead of holding the previous server's screen.
    let active_frame = {
        let Some(model) = state.supervisor_model.as_ref() else {
            return;
        };
        let active_server_id = model.active_server_id().clone();
        state
            .frame_cache
            .get(&active_server_id)
            .cloned()
            .unwrap_or_else(|| protocol::FrameData::blank(state.host_size.0, state.host_size.1))
    };

    let compose_started = Instant::now();
    let shell_rebuilt = if let (Some(comp), Some(model)) =
        (state.compositor.as_ref(), state.supervisor_model.as_ref())
    {
        ensure_shell_cache(
            comp,
            model,
            &mut state.shell_cache,
            state.host_size,
            rebuild,
            now,
        )
    } else {
        return;
    };
    // #56: the live hover target + open-menu selection paint the highlight overlay (the shell itself
    // is hover-less). Read them before the immutable shell borrow below.
    let hover = state.compositor.as_ref().and_then(|comp| comp.hover());
    let menu_selected = state
        .supervisor_model
        .as_ref()
        .and_then(|model| model.client_menu().map(|menu| menu.selected));
    let Some(frame_data) = state.shell_cache.as_ref().map(|shell| {
        let mut frame = compositor::overlay_content_onto_shell(shell, &active_frame);
        compositor::apply_hover_overlay(&mut frame, shell, hover, menu_selected);
        frame
    }) else {
        return;
    };
    let compose_elapsed = compose_started.elapsed();
    flush_composited_frame(state, frame_data, compose_elapsed, shell_rebuilt);
}

/// Cache a server's freshly-received full frame and, if it is the active server, composite + flush
/// it. Shared by the `Frame` and (reconstructed) `FrameDelta` paths (issue #13).
fn render_incoming_server_frame(
    state: &mut ClientState,
    server_id: &supervisor::ServerId,
    mut frame_data: protocol::FrameData,
) {
    let mut compose_elapsed = Duration::ZERO;
    let mut shell_rebuilt = false;
    if let (Some(comp), Some(model)) = (&state.compositor, &state.supervisor_model) {
        let active_server_id = model.active_server_id().clone();
        // #15 (part b): always keep the per-server frame cache fresh (so a later focus switch can
        // paint the latest frame instantly), but only the ACTIVE server's frame is composed +
        // encoded + flushed. A background server's content frame changes nothing the user can see —
        // the sidebar is summary-driven and the content area shows only the active server — so
        // decoding/encoding it was pure waste and let a fast background remote back up the event
        // loop one stale frame at a time. Mirror the `Terminal` handler's active-server early-skip.
        state.frame_cache.insert(server_id.clone(), frame_data);
        if &active_server_id != server_id {
            return;
        }
        let Some(active_frame) =
            select_composited_render_frame(&state.frame_cache, &active_server_id, server_id)
        else {
            return;
        };
        // #45: a pure content-output frame — the sidebar model is unchanged since the last compose,
        // so reuse the cached shell (rebuild = false) and only re-lay the content region. A host
        // resize (dims mismatch) or any model change (which dropped the cache via
        // `request_full_redraw`) transparently forces a rebuild. This is the hot path that
        // previously rebuilt the entire sidebar (`from_model` + full sidebar render) on EVERY
        // content frame and throttled attach to <1fps as agent TUIs flooded content frames (#45).
        let compose_started = Instant::now();
        shell_rebuilt = ensure_shell_cache(
            comp,
            model,
            &mut state.shell_cache,
            state.host_size,
            state.shell_cache_disabled,
            compose_started,
        );
        let shell = state
            .shell_cache
            .as_ref()
            .expect("ensure_shell_cache populates the cache");
        frame_data = compositor::overlay_content_onto_shell(shell, active_frame);
        // #56: paint the current hover/selection highlight onto the composited frame (like the
        // cursor) so it survives a content-only repaint — a busy workspace streaming content keeps
        // the hovered row highlighted without rebuilding the shell.
        compositor::apply_hover_overlay(
            &mut frame_data,
            shell,
            comp.hover(),
            model.client_menu().map(|menu| menu.selected),
        );
        compose_elapsed = compose_started.elapsed();
    }
    flush_composited_frame(state, frame_data, compose_elapsed, shell_rebuilt);
}

/// #45: ensure `shell_cache` holds a sidebar shell valid for the current model/view and host size,
/// running the expensive rebuild (`from_model` + full sidebar render) only when forced (`rebuild`)
/// or when the cached shell was laid out for different host dimensions (a resize). Returns whether
/// a rebuild happened, for the frame-budget breakdown. Takes the compositor/model/cache as disjoint
/// borrows so the hot content-frame path can call it while still holding a borrow of `frame_cache`.
fn ensure_shell_cache(
    compositor: &compositor::ClientCompositor,
    model: &supervisor::ClientSupervisorModel,
    shell_cache: &mut Option<compositor::ComposedShell>,
    host_size: (u16, u16),
    rebuild: bool,
    now: Instant,
) -> bool {
    let (host_width, host_height) = host_size;
    let fresh = rebuild
        || !shell_cache
            .as_ref()
            .is_some_and(|shell| shell.matches_dims(host_width, host_height));
    if fresh {
        *shell_cache = Some(compositor.build_shell(model, host_width, host_height, now));
    }
    fresh
}

/// #45: encode, write and flush a composited client frame, recording the split frame-budget
/// breakdown (compose / encode / flush). Shared tail of the cached-redraw and incoming-frame paths.
fn flush_composited_frame(
    state: &mut ClientState,
    frame_data: protocol::FrameData,
    compose_elapsed: Duration,
    shell_rebuilt: bool,
) {
    let encode_started = Instant::now();
    #[cfg(windows)]
    let encoded = state
        .blit_encoder
        .encode_with_deferred_cursor_reveal(&frame_data, false);
    #[cfg(not(windows))]
    let encoded = state.blit_encoder.encode(&frame_data, false);
    #[cfg(windows)]
    let deferred_cursor_reveal = encoded.deferred_cursor_reveal.clone();
    let encode_elapsed = encode_started.elapsed();
    let graphics = if state.kitty_graphics_enabled {
        frame_data.graphics.as_slice()
    } else {
        &[]
    };
    let flush_started = Instant::now();
    let mut stdout = io::stdout();
    let _ = write_encoded_frame_with_graphics(&mut stdout, &encoded.bytes, graphics);
    let _ = stdout.flush();
    let flush_elapsed = flush_started.elapsed();
    state.blit_encoder.commit(frame_data, encoded);
    #[cfg(windows)]
    state.update_pending_cursor_reveal(deferred_cursor_reveal);
    // #48: any composited frame we flush already reflects the compositor's current hover, so a
    // deferred hover repaint is no longer outstanding. Stamp the time so the hover-render clamp in
    // `next_select_deadline` paces the NEXT deferred repaint off this frame (capping it at ~60fps).
    state.pending_hover_render = false;
    // many-remotes: this frame also reflects every model mutation applied so far, so a deferred
    // fleet-update full render is satisfied too — clear it so the Timer won't redundantly re-render.
    state.pending_full_render = false;
    state.last_composited_render_at = Instant::now();
    record_client_frame_sample_split(
        state,
        compose_elapsed,
        encode_elapsed,
        flush_elapsed,
        shell_rebuilt,
    );
}

/// How often the downstream-throughput sampler converts cumulative byte counters into a
/// bytes/sec rate for the host banner (issue #13). ~1s gives a steady, readable number.
const RX_RATE_SAMPLE_INTERVAL: Duration = Duration::from_millis(1000);

/// Cadence for stream latency probes (issue #13). A Ping over the persistent stream measures true
/// round-trip time without the per-request bridge-connection / remote-process-spawn cost.
const SERVER_PING_INTERVAL: Duration = Duration::from_millis(1000);

/// Derive each server's recent downstream bytes/sec from the cumulative reader counters and push
/// it into the supervisor model for the host banner. Rate-limited to [`RX_RATE_SAMPLE_INTERVAL`].
fn sample_download_rates(state: &mut ClientState, now: Instant) {
    if now.duration_since(state.last_rx_sample_at) < RX_RATE_SAMPLE_INTERVAL {
        return;
    }
    state.last_rx_sample_at = now;

    let snapshot = state.rx_counters.snapshot();
    let mut rates: Vec<(supervisor::ServerId, u64)> = Vec::new();
    for (server_id, bytes) in snapshot {
        if let Some((prev_bytes, prev_at)) = state.server_rx_sample.get(&server_id) {
            let dt = now.duration_since(*prev_at).as_secs_f64();
            if dt > 0.0 {
                let delta = bytes.saturating_sub(*prev_bytes);
                rates.push((server_id.clone(), (delta as f64 / dt) as u64));
            }
        }
        state.server_rx_sample.insert(server_id, (bytes, now));
    }

    if let Some(model) = state.supervisor_model.as_mut() {
        for (server_id, rate) in rates {
            model.set_server_download_bps(&server_id, rate);
        }
    }
}

/// #45: record one composited frame's split timing (compose / encode / flush) and, once per ~1s
/// window of active rendering, emit a frame-budget summary (fps, average breakdown, and how many
/// frames rebuilt the sidebar shell vs reused it). The split moves the timer to BEFORE compose —
/// the old budget log started its timer after `compose_frame`, hiding the `from_model` cost that
/// was the actual hot spot (#45). The periodic summary is the signal used to confirm attach holds
/// ≥30fps. Both lines log at debug (run with `HERDR_LOG=herdr=debug` to observe); idle windows with
/// no rendered frames emit nothing.
fn record_client_frame_sample_split(
    state: &mut ClientState,
    compose_elapsed: Duration,
    encode_elapsed: Duration,
    flush_elapsed: Duration,
    shell_rebuilt: bool,
) {
    let total = compose_elapsed + encode_elapsed + flush_elapsed;
    let now = Instant::now();
    let sample = state.frame_stats.record_render_duration(total);
    if sample.missed_sixty_fps_budget {
        debug!(
            total_ms = total.as_secs_f64() * 1000.0,
            compose_ms = compose_elapsed.as_secs_f64() * 1000.0,
            encode_ms = encode_elapsed.as_secs_f64() * 1000.0,
            flush_ms = flush_elapsed.as_secs_f64() * 1000.0,
            shell_rebuilt,
            render_fps = sample.render_fps,
            frame_budget_fps = fps_for_frame_duration(CLIENT_60FPS_FRAME_BUDGET),
            "client frame render missed 60fps budget"
        );
    }
    if let Some(summary) =
        state
            .frame_stats
            .accumulate_window(now, total, compose_elapsed, shell_rebuilt)
    {
        debug!(
            frames = summary.frames,
            window_ms = summary.elapsed.as_secs_f64() * 1000.0,
            fps = summary.fps,
            avg_total_ms = summary.avg_total_ms,
            avg_compose_ms = summary.avg_compose_ms,
            shell_rebuilds = summary.rebuilds,
            "client frame-budget window summary"
        );
    }
}

/// The main client event loop.
///
/// Uses a threaded architecture:
/// - stdin reader thread → sends raw input bytes to main loop
/// - resize poller thread → sends resize events to main loop
/// - server reader thread → reads ServerMessages and sends to main loop
/// - main loop: coordinates input, output, and server communication
async fn run_client_loop(
    stream: LocalStream,
    should_quit: Arc<AtomicBool>,
    options: ClientLoopOptions,
) -> Result<(), ClientError> {
    let ClientLoopOptions {
        host_size,
        reported_size,
        cell_size_px,
        sound_config,
        mouse_scroll_lines,
        redraw_on_focus_gained,
        kitty_graphics_enabled,
        mouse_capture_active,
        negotiated_encoding,
        attach_escape,
        compositor,
        supervisor_model,
        secondary_streams,
        ssh_bridges,
    } = options;
    #[cfg(windows)]
    let _ = mouse_scroll_lines;

    let mut state = ClientState {
        blit_encoder: render_ansi::BlitEncoder::new(),
        frame_stats: ClientFrameStats::default(),
        mouse_capture_active,
        reported_size,
        host_size,
        cell_size_px,
        sound_config,
        kitty_graphics_enabled,
        attach_escape,
        #[cfg(unix)]
        mouse_scroll_lines,
        redraw_on_focus_gained,
        #[cfg(windows)]
        pending_cursor_reveal: None,
        compositor,
        supervisor_model,
        last_supervisor_summary_refresh: Instant::now(),
        frame_cache: HashMap::new(),
        shell_cache: None,
        shell_cache_disabled: std::env::var_os("HERDR_DISABLE_SHELL_CACHE").is_some(),
        rx_counters: RxByteCounters::default(),
        server_rx_sample: HashMap::new(),
        last_rx_sample_at: Instant::now(),
        ping_nonce: 0,
        pending_pings: HashMap::new(),
        last_ping_at: Instant::now(),
        summary_subscription_server_ids: HashSet::new(),
        pending_summary_refresh_server_ids: HashSet::new(),
        pending_main_refresh: false,
        pending_secondary_connect_server_ids: HashSet::new(),
        pending_add_remote: false,
        ssh_bridges,
        secondary_retries: HashMap::new(),
        manually_disconnected: HashSet::new(),
        provision_failed: HashSet::new(),
        retry_restart_incompatible: HashSet::new(),
        pending_update_remote: HashSet::new(),
        update_outcome_expiry: HashMap::new(),
        auto_update_suppressed: HashSet::new(),
        last_animation_tick: Instant::now(),
        pending_hover_render: false,
        pending_full_render: false,
        last_composited_render_at: Instant::now(),
        last_summary_refresh: HashMap::new(),
        #[cfg(unix)]
        remote_image_paste_key: None,
    };
    debug!(?negotiated_encoding, "client render encoding active");

    // Channel for events from the stdin, resize, and server reader threads.
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<ClientLoopEvent>(256);

    // #42: kick off the one-shot cold-start hydrate off the UI thread. `bootstrap_supervisor_for_client`
    // painted a minimal main-only model so the first frame is already up; this fetches the full
    // registry/summary/ui-settings and posts `MainSupervisorBootstrapped` to swap it in. Skipped in
    // direct-attach mode (no client-owned supervisor model to hydrate).
    if state.supervisor_model.is_some() {
        spawn_main_supervisor_bootstrap(&event_tx);
    }

    let host_color_query_sent = state.attach_escape.is_none() && should_query_host_terminal_theme();

    // Terminals behind ConPTY report no pixel size through the ioctl, so ask the
    // host terminal directly instead of falling back to an assumed cell size.
    let will_query_host_cell_size = state.attach_escape.is_none()
        && host_cell_size_query_required(state.kitty_graphics_enabled);
    // Cell size reported by the host terminal, packed as width<<32 | height.
    // Zero means the host has not reported one.
    let reported_cell_size = Arc::new(AtomicU64::new(0));

    // Spawn the stdin reader thread.
    let stdin_quit = should_quit.clone();
    let stdin_tx = event_tx.clone();
    let stdin_mouse_capture_active = host_mouse_capture_flag();
    std::thread::spawn(move || {
        input::stdin_reader_loop(
            stdin_tx,
            &stdin_quit,
            host_color_query_sent,
            will_query_host_cell_size,
            stdin_mouse_capture_active,
        );
    });

    if host_color_query_sent {
        query_host_terminal_theme();
    }

    if will_query_host_cell_size {
        query_host_cell_size();
    }


    // Spawn the resize poller thread.
    let resize_quit = should_quit.clone();
    let resize_tx = event_tx.clone();
    let resize_cell_size = reported_cell_size.clone();
    std::thread::spawn(move || {
        resize_poll_loop(
            resize_tx,
            host_size.0,
            host_size.1,
            cell_size_px.0,
            cell_size_px.1,
            kitty_graphics_enabled,
            &resize_cell_size,
            &resize_quit,
        );
    });

    // Spawn the server reader thread (blocking reads from the socket).
    // Clone the stream's file descriptor so we can read from a blocking stream.
    let server_read_quit = should_quit.clone();
    let server_read_tx = event_tx.clone();
    let main_server_id = supervisor::ServerId::main();
    let read_stream = stream.try_clone().map_err(ClientError::ConnectionFailed)?;
    let main_rx = state.rx_counters.counter(&main_server_id);
    // The same framing cap must apply to every server's reader (main AND secondaries) or a >2 MB
    // graphics frame from a secondary would fail framing and flap the connection. `usize` is
    // `Copy`, so each reader thread captures its own copy.
    let max_frame_size = server_frame_size_cap(kitty_graphics_enabled);
    std::thread::spawn(move || {
        server_reader_thread(
            main_server_id,
            read_stream,
            main_rx,
            server_read_tx,
            &server_read_quit,
            max_frame_size,
        );
    });

    let mut server_writes = HashMap::new();
    stream
        .set_nonblocking(false)
        .map_err(ClientError::ConnectionFailed)?;
    server_writes.insert(
        supervisor::ServerId::main(),
        spawn_server_writer(supervisor::ServerId::main(), stream, event_tx.clone()),
    );

    for (server_id, stream) in secondary_streams {
        let read_stream = stream.try_clone().map_err(ClientError::ConnectionFailed)?;
        let secondary_read_tx = event_tx.clone();
        let secondary_read_quit = should_quit.clone();
        let reader_server_id = server_id.clone();
        let secondary_rx = state.rx_counters.counter(&reader_server_id);
        std::thread::spawn(move || {
            server_reader_thread(
                reader_server_id,
                read_stream,
                secondary_rx,
                secondary_read_tx,
                &secondary_read_quit,
                max_frame_size,
            );
        });
        stream
            .set_nonblocking(false)
            .map_err(ClientError::ConnectionFailed)?;
        let write_handle = spawn_server_writer(server_id.clone(), stream, event_tx.clone());
        server_writes.insert(server_id, write_handle);
    }

    schedule_missing_secondary_stream_retries(&mut state, &server_writes, Instant::now());
    retry_due_secondary_connections(&mut state, Instant::now(), &event_tx, &mut server_writes);

    if let Some(model) = &state.supervisor_model {
        start_missing_supervisor_summary_subscriptions(
            model,
            &mut state.summary_subscription_server_ids,
            &state.ssh_bridges,
            &event_tx,
            &should_quit,
        );
    }

    // Main event loop.
    // This (foreground) client owns the prefix ASCII input-source switch; a no-op on non-macOS.
    let mut prefix_input_source = crate::platform::RealPrefixInputSource::default();
    while !should_quit.load(Ordering::Acquire) {
        // item 5: wake sooner (80ms) when the sidebar is animating, else keep the 100ms
        // housekeeping cadence (idle behavior unchanged). The gate reads the cached model only
        // and performs no I/O; real input still pre-empts the deadline via `event_rx.recv()`.
        let wants_animation = state.compositor.is_some()
            && (state
                .supervisor_model
                .as_ref()
                .is_some_and(compositor::sidebar_wants_animation)
                // #9: keep the 80ms wake alive while the collapse/expand width is mid-slide.
                || state
                    .compositor
                    .as_ref()
                    .is_some_and(compositor::ClientCompositor::sidebar_width_animating));
        let deadline = next_select_deadline(
            Instant::now(),
            state.last_animation_tick,
            wants_animation,
            // many-remotes: a deferred FULL render (coalesced fleet-update storm) wakes within one
            // frame budget too, exactly like a deferred hover repaint — so the storm flushes at ~60fps.
            state.pending_hover_render || state.pending_full_render,
            state.last_composited_render_at,
        );
        let event = tokio::select! {
            ev = event_rx.recv() => ev.unwrap_or(ClientLoopEvent::Timer),
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => ClientLoopEvent::Timer,
        };

        match event {
            #[cfg(unix)]
            ClientLoopEvent::StdinInput(data) => {
                let data = if let Some(attach_escape) = &mut state.attach_escape {
                    match attach_escape.filter_input(
                        data,
                        state.reported_size.1,
                        state.mouse_scroll_lines,
                    ) {
                        AttachInputAction::Forward(data) => data,
                        AttachInputAction::Scroll {
                            source,
                            direction,
                            lines,
                            column,
                            row,
                            modifiers,
                        } => {
                            let msg = ClientMessage::AttachScroll {
                                source,
                                direction,
                                lines,
                                column,
                                row,
                                modifiers,
                            };
                            if let Err(e) = queue_to_server_id(
                                &server_writes,
                                &supervisor::ServerId::main(),
                                msg,
                            ) {
                                return Err(ClientError::ConnectionLost(e));
                            }
                            continue;
                        }
                        AttachInputAction::Detach => {
                            let _ = queue_to_server_id(
                                &server_writes,
                                &supervisor::ServerId::main(),
                                ClientMessage::Detach,
                            );
                            return Ok(());
                        }
                        AttachInputAction::None => continue,
                    }
                } else {
                    let events = crate::raw_input::parse_raw_input_bytes_sync(&data);
                    if crate::raw_input::events_require_host_surface_redraw(
                        &events,
                        state.redraw_on_focus_gained,
                    ) {
                        state.request_full_redraw();
                    }
                    if let Some((width_px, height_px)) = reported_cell_size_from_events(&events) {
                        store_reported_cell_size(&reported_cell_size, width_px, height_px);
                    }
                    if let (Some(compositor), Some(model)) =
                        (&mut state.compositor, &mut state.supervisor_model)
                    {
                        match dispatch_composited_input(data, compositor, model, state.host_size) {
                            ClientInputDispatch::Forward(data) => data,
                            ClientInputDispatch::ServerControl { server_id, message } => {
                                if let Err(e) =
                                    queue_to_server_id(&server_writes, &server_id, message)
                                {
                                    handle_server_write_failure(
                                        &mut state,
                                        &mut server_writes,
                                        server_id,
                                        e,
                                        Instant::now(),
                                    )?;
                                }
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            ClientInputDispatch::ApiRequest {
                                server_id,
                                refresh,
                                request,
                            } => {
                                if let Err(err) = spawn_client_supervisor_request(
                                    model,
                                    server_id.clone(),
                                    refresh,
                                    *request,
                                    &state.ssh_bridges,
                                    &event_tx,
                                ) {
                                    warn!(
                                        server_id = ?server_id,
                                        err = %err,
                                        "failed to start client sidebar request"
                                    );
                                }
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            ClientInputDispatch::AddRemote(draft) => {
                                model.set_add_remote_in_progress();
                                spawn_client_add_remote_submission(
                                    draft,
                                    &event_tx,
                                    &mut state.pending_add_remote,
                                );
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            // item 3 (Area 5): the model already set `overlay.pending` for this
                            // remote when it emitted the outcome (blocking re-issue while in
                            // flight). Spawn the registry mutation off the UI loop against the
                            // local main socket; the `RemoteManageRequestFinished` handler applies
                            // the registry refresh + teardown/reconnect.
                            ClientInputDispatch::SetRemoteEnabled { remote_id, enabled } => {
                                spawn_client_remote_manage_request(
                                    model,
                                    RemoteManageAction::SetEnabled { enabled },
                                    remote_id,
                                    &state.ssh_bridges,
                                    &event_tx,
                                );
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            // #61: persist the per-remote auto-update flag (no teardown/reconnect —
                            // the apply handler just refreshes the registry and, when newly enabled
                            // for an already-mismatched host, kicks the auto-update sweep).
                            ClientInputDispatch::SetRemoteAutoUpdate {
                                remote_id,
                                auto_update,
                            } => {
                                spawn_client_remote_manage_request(
                                    model,
                                    RemoteManageAction::SetAutoUpdate { auto_update },
                                    remote_id,
                                    &state.ssh_bridges,
                                    &event_tx,
                                );
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            // C4/C6: persist the new session, then (in the apply handler) rebuild
                            // the bridge so the far side is re-attached with the new `--session`.
                            ClientInputDispatch::SetRemoteSession {
                                server_id: _,
                                remote_id,
                                session,
                            } => {
                                spawn_client_remote_manage_request(
                                    model,
                                    RemoteManageAction::SetSession { session },
                                    remote_id,
                                    &state.ssh_bridges,
                                    &event_tx,
                                );
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            ClientInputDispatch::DeleteRemote { remote_id } => {
                                spawn_client_remote_manage_request(
                                    model,
                                    RemoteManageAction::Delete,
                                    remote_id,
                                    &state.ssh_bridges,
                                    &event_tx,
                                );
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            // #43: drop the live stream WITHOUT disabling the remote in the registry.
                            // Tear the connection down (like a voluntary disable, no retry scheduled),
                            // mark the host manually-disconnected so the retry sweeps leave it down,
                            // and mark the model Disconnected (greyed, summaries retained).
                            ClientInputDispatch::DisconnectRemote { server_id } => {
                                teardown_secondary_connection(
                                    &mut state,
                                    &mut server_writes,
                                    &server_id,
                                );
                                state.manually_disconnected.insert(server_id.clone());
                                if let Some(model) = &mut state.supervisor_model {
                                    let _ = model.set_connection_state(
                                        &server_id,
                                        supervisor::ConnectionState::Disconnected,
                                    );
                                }
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            // #43: restore a manually-disconnected stream — clear the mark and
                            // schedule an immediate (0-backoff) reconnect; the retry sweep then dials
                            // it back up. Mark the model Connecting so the banner reflects the attempt.
                            // Doubles as the explicit RETRY for a terminal provisioning failure: the
                            // failed mark and the pinned failure outcome are cleared so the fresh
                            // attempt's progress owns the banner sub-lines again.
                            ClientInputDispatch::ReconnectRemote { server_id } => {
                                state.manually_disconnected.remove(&server_id);
                                state.provision_failed.remove(&server_id);
                                if let Some(model) = &mut state.supervisor_model {
                                    let _ = model.set_connection_state(
                                        &server_id,
                                        supervisor::ConnectionState::Connecting,
                                    );
                                    model.set_update_progress(&server_id, None);
                                    model.clear_update_outcome(&server_id);
                                }
                                state.update_outcome_expiry.remove(&server_id);
                                schedule_secondary_retry(&mut state, server_id, 0, Instant::now());
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            // #44: reinstall the local herdr onto this remote by reusing the
                            // add-remote provisioning flow (no internet download). Resolve the ssh
                            // target from the model, show an initial progress line, and spawn the
                            // worker off the UI loop (the pending guard collapses double-clicks).
                            ClientInputDispatch::UpdateRemote { server_id } => {
                                spawn_remote_update_for(&mut state, &server_id, &event_tx);
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            // Worktree-menu parity: fetch the workspace's worktree.list from the
                            // OWNING server off the UI loop; the result lands as
                            // `WorktreeListFetched` and fills the open picker.
                            ClientInputDispatch::FetchWorktreeList {
                                server_id,
                                workspace_id,
                            } => {
                                spawn_worktree_list_fetch(
                                    &mut state,
                                    server_id,
                                    workspace_id,
                                    &event_tx,
                                );
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            // C4: fetch the REMOTE host's session list off the UI loop; the result
                            // lands as `SessionListFetched` and fills the open picker.
                            ClientInputDispatch::FetchSessionList {
                                server_id,
                                remote_id: _,
                            } => {
                                spawn_session_list_fetch(&mut state, server_id, &event_tx);
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            // Worktree-menu parity: the menu's expand/collapse row flips the SAME
                            // client-local set the sidebar chevron toggles.
                            ClientInputDispatch::ToggleWorktreeGroup { group_key } => {
                                if let Some(compositor) = &mut state.compositor {
                                    compositor.toggle_collapsed_space_key(group_key);
                                }
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            ClientInputDispatch::Resize { cols, rows } => {
                                state.reported_size = (cols, rows);
                                let msg = ClientMessage::Resize {
                                    cols,
                                    rows,
                                    cell_width_px: state.cell_size_px.0,
                                    cell_height_px: state.cell_size_px.1,
                                };
                                let mut write_failures = Vec::new();
                                for (server_id, handle) in server_writes.iter() {
                                    if let Err(e) = queue_to_server(handle, msg.clone()) {
                                        write_failures.push((server_id.clone(), e));
                                    }
                                }
                                for (server_id, error) in write_failures {
                                    handle_server_write_failure(
                                        &mut state,
                                        &mut server_writes,
                                        server_id,
                                        error,
                                        Instant::now(),
                                    )?;
                                }
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            ClientInputDispatch::DetachAll => {
                                let detach = ClientMessage::Detach;
                                for handle in server_writes.values() {
                                    let _ = queue_to_server(handle, detach.clone());
                                }
                                return Ok(());
                            }
                            ClientInputDispatch::Redraw => {
                                state.request_full_redraw();
                                render_cached_composited_frame(&mut state);
                                continue;
                            }
                            ClientInputDispatch::HoverRedraw => {
                                // #48/#56: a sidebar hover OR an open-menu selection change is
                                // presentation-only. #56: KEEP both the cached hover-less shell (no
                                // `build_shell` rebuild — the highlight is painted by the overlay) AND
                                // the blit baseline (only the changed rows are written, no full-screen
                                // repaint). The render is DEFERRED (latest-wins): a fast motion sweep
                                // floods one `Moved` per crossed row, so instead of repainting per
                                // event we mark a render pending and let `next_select_deadline` flush
                                // it within one frame budget — at most one repaint per frame.
                                state.request_hover_redraw();
                                continue;
                            }
                            ClientInputDispatch::Consumed => continue,
                        }
                    } else {
                        data
                    }
                };
                if should_bridge_clipboard_image_paste(&data) {
                    if let Some(image) = crate::platform::read_clipboard_image() {
                        if image.bytes.len() > MAX_CLIPBOARD_IMAGE_PAYLOAD {
                            warn!(
                                bytes = image.bytes.len(),
                                max = MAX_CLIPBOARD_IMAGE_PAYLOAD,
                                "local clipboard image is too large to bridge"
                            );
                            continue;
                        }
                        info!(
                            bytes = image.bytes.len(),
                            extension = image.extension,
                            "bridging local clipboard image paste to remote server"
                        );
                        let msg = ClientMessage::ClipboardImage {
                            extension: image.extension.to_owned(),
                            data: image.bytes,
                        };
                        let server_id = active_server_id(&state);
                        if let Err(e) = queue_to_server_id(&server_writes, &server_id, msg) {
                            handle_server_write_failure(
                                &mut state,
                                &mut server_writes,
                                server_id,
                                e,
                                Instant::now(),
                            )?;
                            render_cached_composited_frame(&mut state);
                        }
                        continue;
                    }
                    info!(
                        "clipboard image paste trigger received, but local clipboard has no image"
                    );
                    // #59: a screenshot tool like macshot copies a file URL pointing into its OWN
                    // sandboxed container, which macOS won't let herdr (or the agent) read — so the
                    // image silently falls back to a dead path. Detect that and warn the user instead
                    // of letting an inaccessible URL paste into the prompt.
                    if let Some(path) = crate::platform::clipboard_image_file_if_unreadable() {
                        warn!(
                            path = %path,
                            "clipboard image file is unreadable (sandboxed container?); cannot attach"
                        );
                        let _ = crate::platform::show_desktop_notification(
                            "herdr: image can't be attached",
                            Some(
                                "The copied image lives in a sandboxed/unreadable location (e.g. a \
                                 screenshot-tool container). Copy the image itself (⌘⇧⌃4) or use a \
                                 tool that puts image data on the clipboard.",
                            ),
                        );
                    }
                }
                let msg = ClientMessage::Input { data };
                let server_id = active_server_id(&state);
                if let Err(e) = queue_to_server_id(&server_writes, &server_id, msg) {
                    handle_server_write_failure(
                        &mut state,
                        &mut server_writes,
                        server_id,
                        e,
                        Instant::now(),
                    )?;
                    render_cached_composited_frame(&mut state);
                }
            }
            #[cfg(windows)]
            ClientLoopEvent::StdinEvents(events) => {
                if state.attach_escape.is_some() {
                    continue;
                }
                let raw_events = events
                    .iter()
                    .map(crate::protocol::ClientInputEvent::to_raw_input_event)
                    .collect::<Vec<_>>();
                if crate::raw_input::events_require_host_surface_redraw(
                    &raw_events,
                    state.redraw_on_focus_gained,
                ) {
                    state.request_repaint();
                }
                let msg = ClientMessage::InputEvents { events };
                if let Err(e) = write_to_server(&mut write_stream, &msg) {
                    return Err(ClientError::ConnectionLost(e));
                }
            }
            ClientLoopEvent::Resize(new_cols, new_rows, cell_width_px, cell_height_px) => {
                state.host_size = (new_cols, new_rows);
                state.cell_size_px = (cell_width_px, cell_height_px);
                state.reported_size = state
                    .compositor
                    .as_ref()
                    .map(|compositor| compositor.content_size(new_cols, new_rows))
                    .unwrap_or((new_cols, new_rows));
                let msg = ClientMessage::Resize {
                    cols: state.reported_size.0,
                    rows: state.reported_size.1,
                    cell_width_px,
                    cell_height_px,
                };
                if state.compositor.is_some() {
                    let mut write_failures = Vec::new();
                    for (server_id, handle) in server_writes.iter() {
                        if let Err(e) = queue_to_server(handle, msg.clone()) {
                            write_failures.push((server_id.clone(), e));
                        }
                    }
                    for (server_id, error) in write_failures {
                        handle_server_write_failure(
                            &mut state,
                            &mut server_writes,
                            server_id,
                            error,
                            Instant::now(),
                        )?;
                    }
                } else {
                    let server_id = active_server_id(&state);
                    if let Err(e) = queue_to_server_id(&server_writes, &server_id, msg) {
                        handle_server_write_failure(
                            &mut state,
                            &mut server_writes,
                            server_id,
                            e,
                            Instant::now(),
                        )?;
                    }
                }
            }
            ClientLoopEvent::ServerMessage { server_id, message } => {
                match protocol::decompress_server_message(message) {
                    ServerMessage::Frame(frame_data) => {
                        render_incoming_server_frame(&mut state, &server_id, frame_data);
                    }
                    ServerMessage::PrefixInputSource { active } => {
                        use crate::platform::PrefixInputSource as _;
                        if active {
                            prefix_input_source.switch_to_ascii();
                        } else {
                            prefix_input_source.restore();
                        }
                    }
                    ServerMessage::Pong { nonce } => {
                        // issue #13: true round-trip latency over the persistent stream (no per-ping
                        // connection/process-spawn overhead). Only the matching outstanding nonce counts.
                        if let Some((pending_nonce, sent_at)) =
                            state.pending_pings.remove(&server_id)
                        {
                            if pending_nonce == nonce {
                                if let Some(model) = &mut state.supervisor_model {
                                    let rtt =
                                        sent_at.elapsed().as_millis().min(u32::MAX as u128) as u32;
                                    model.record_server_ping(&server_id, rtt);
                                    state.request_full_redraw();
                                }
                            }
                        }
                    }
                    ServerMessage::Compressed(_) => {
                        // The inner frame failed to inflate (corruption / over the decompression
                        // cap), so we lost whatever it carried. Don't sit on a now-stale baseline:
                        // ask the server to re-baseline with a full frame (v14).
                        debug!(server_id = ?server_id, "failed to inflate a compressed server frame; requesting full re-baseline frame");
                        if let Some(handle) = server_writes.get(&server_id) {
                            let _ = queue_to_server(handle, ClientMessage::RequestFullFrame);
                        }
                    }
                    ServerMessage::FrameDelta(delta) => {
                        // issue #13: reconstruct the full frame from this server's cached baseline.
                        // The delta's `base_checksum` pins the exact baseline the server built it
                        // against; if our cached frame hashes differently (a dropped/failed prior
                        // frame) we must NOT apply onto it — that would silently render wrong cells.
                        // Drop and ask the server to re-baseline with a full frame (v14).
                        let reconstructed = state.frame_cache.get(&server_id).and_then(|prev| {
                            (protocol::frame_checksum(prev) == delta.base_checksum)
                                .then(|| prev.with_delta(&delta))
                                .flatten()
                        });
                        match reconstructed {
                            Some(full) => {
                                render_incoming_server_frame(&mut state, &server_id, full)
                            }
                            None => {
                                debug!(
                                    server_id = ?server_id,
                                    "frame delta baseline desynced or missing; requesting full re-baseline frame"
                                );
                                if let Some(handle) = server_writes.get(&server_id) {
                                    let _ =
                                        queue_to_server(handle, ClientMessage::RequestFullFrame);
                                }
                            }
                        }
                    }
                    ServerMessage::Terminal(frame) => {
                        if server_id != active_server_id(&state) {
                            continue;
                        }
                        if state.kitty_graphics_enabled
                            && contains_kitty_graphics_bytes(&frame.bytes)
                        {
                            record_received_kitty_graphics(&frame.bytes);
                        }
                        let mut stdout = io::stdout();
                        let _ = stdout.write_all(&frame.bytes);
                        let _ = stdout.flush();
                    }
                    ServerMessage::Graphics { bytes } => {
                        if server_id != active_server_id(&state) {
                            continue;
                        }
                        if state.kitty_graphics_enabled {
                            record_received_kitty_graphics(&bytes);
                            let mut stdout = io::stdout();
                            let _ = stdout.write_all(&bytes);
                            let _ = stdout.flush();
                        }
                    }
                    ServerMessage::ServerShutdown { reason } => {
                        if server_id != supervisor::ServerId::main() {
                            server_writes.remove(&server_id);
                            // #36: keep the last frame so the greyed host shows its final screen.
                            state.summary_subscription_server_ids.remove(&server_id);
                            state.pending_summary_refresh_server_ids.remove(&server_id);
                            state
                                .pending_secondary_connect_server_ids
                                .remove(&server_id);
                            state.ssh_bridges.remove(&server_id);
                            if let Some(model) = &mut state.supervisor_model {
                                let _ = model.set_connection_state(
                                    &server_id,
                                    supervisor::ConnectionState::Disconnected,
                                );
                                state.request_full_redraw();
                            }
                            schedule_secondary_retry(&mut state, server_id, 0, Instant::now());
                            render_cached_composited_frame(&mut state);
                            continue;
                        }
                        return Err(ClientError::ServerShutdown { reason });
                    }
                    ServerMessage::Notify {
                        kind,
                        message,
                        body,
                    } => {
                        handle_notify(kind, &message, body.as_deref(), &state.sound_config);
                    }
                    ServerMessage::Clipboard { data } => {
                        forward_clipboard(&data);
                        let _ = io::stdout().flush();
                    }
                    ServerMessage::WindowTitle { title } => {
                        if server_id != active_server_id(&state) {
                            continue;
                        }
                        let mut stdout = io::stdout();
                        match title.as_deref() {
                            Some(title) => {
                                let _ = write!(stdout, "\x1b]0;{title}\x07");
                            }
                            None => {
                                let _ = stdout.write_all(b"\x1b]0;\x07");
                            }
                        }
                        let _ = stdout.flush();
                    }
                    ServerMessage::ReloadSoundConfig => {
                        reload_local_client_config(
                            &mut state.sound_config,
                            &mut state.redraw_on_focus_gained,
                        );
                        // #58: a config reload may have changed the server-side sidebar settings
                        // (pane/tab/space rows), which the client renders from the server-pushed
                        // UiSettings. Re-fetch them off the UI loop NOW instead of waiting up to ~2s
                        // for the next supervisor poll, so settings changes apply (near-)instantly.
                        spawn_main_supervisor_refresh(&mut state.pending_main_refresh, &event_tx);
                    }
                    ServerMessage::MouseCapture { enabled } => {
                        if server_id != active_server_id(&state) {
                            continue;
                        }
                        let desired = desired_mouse_capture(enabled, state.compositor.is_some());
                        if desired != state.mouse_capture_active {
                            set_mouse_capture(desired).map_err(ClientError::ConnectionFailed)?;
                            state.mouse_capture_active = desired;
                        }
                    }
                    ServerMessage::KittyKeyboardReportAll { .. } => {
                        // Upstream v0.8.0 kitty report-all keyboard routing; not yet ported to the
                        // multi-remote client input path (deferred - see DIVERGENCE.md).
                    }
                    ServerMessage::Welcome { .. } => {
                        debug!("received unexpected Welcome in main loop");
                    }
                }
            }
            ClientLoopEvent::SupervisorSummaryChanged(server_id) => {
                debug!(
                    server_id = ?server_id,
                    "supervisor summary event requested refresh"
                );
                // item 6 (Area 6): targeted event-push — refresh ONLY the changed server, not the
                // whole fleet. A main id refreshes locally (`&mut`); a secondary id spawns a single
                // off-loop fetch (the helper is a no-op on a main id).
                let now = Instant::now();
                if let Some(model) = &mut state.supervisor_model {
                    if server_id == supervisor::ServerId::main() {
                        if let Err(err) = model.refresh_main_summary_from_api(
                            &mut crate::api::client::ApiClient::local(),
                        ) {
                            warn!(err = %err, "failed to refresh changed main summary");
                        }
                    } else {
                        start_single_secondary_summary_refresh(
                            model,
                            &server_id,
                            &state.ssh_bridges,
                            &mut state.pending_summary_refresh_server_ids,
                            &event_tx,
                        );
                    }
                    state.last_summary_refresh.insert(server_id.clone(), now);
                    state.request_full_redraw();
                }
                schedule_missing_secondary_stream_retries(
                    &mut state,
                    &server_writes,
                    Instant::now(),
                );
                if let Some(model) = &state.supervisor_model {
                    start_missing_supervisor_summary_subscriptions(
                        model,
                        &mut state.summary_subscription_server_ids,
                        &state.ssh_bridges,
                        &event_tx,
                        &should_quit,
                    );
                }
                request_composited_render(&mut state);
            }
            ClientLoopEvent::SupervisorSummaryFetched {
                server_id,
                result,
                elapsed,
            } => {
                state.pending_summary_refresh_server_ids.remove(&server_id);
                // item 6 (Area 6): track the last successful poll for both the fast (active) and
                // slow (background) cadence classes so `due_secondary_summary_refreshes` measures
                // from the latest completion too (not only from the start recorded by the Timer).
                state
                    .last_summary_refresh
                    .insert(server_id.clone(), Instant::now());
                if elapsed > CLIENT_60FPS_FRAME_BUDGET {
                    debug!(
                        server_id = ?server_id,
                        elapsed_ms = elapsed.as_secs_f64() * 1000.0,
                        frame_budget_fps = fps_for_frame_duration(CLIENT_60FPS_FRAME_BUDGET),
                        "secondary supervisor summary completed off UI thread"
                    );
                }
                if let Some(model) = &mut state.supervisor_model {
                    model.apply_secondary_summary_results([(server_id.clone(), result)]);
                    state.request_full_redraw();
                }
                schedule_missing_secondary_stream_retries(
                    &mut state,
                    &server_writes,
                    Instant::now(),
                );
                if let Some(model) = &state.supervisor_model {
                    start_missing_supervisor_summary_subscriptions(
                        model,
                        &mut state.summary_subscription_server_ids,
                        &state.ssh_bridges,
                        &event_tx,
                        &should_quit,
                    );
                }
                request_composited_render(&mut state);
            }
            ClientLoopEvent::SupervisorSummarySubscriptionEnded(server_id) => {
                state.summary_subscription_server_ids.remove(&server_id);
            }
            ClientLoopEvent::SupervisorApiRequestFinished {
                server_id,
                refresh,
                result,
                elapsed,
            } => {
                if elapsed > CLIENT_60FPS_FRAME_BUDGET {
                    debug!(
                        server_id = ?server_id,
                        elapsed_ms = elapsed.as_secs_f64() * 1000.0,
                        frame_budget_fps = fps_for_frame_duration(CLIENT_60FPS_FRAME_BUDGET),
                        "client sidebar API request completed off UI thread"
                    );
                }
                match result {
                    Ok(()) => {
                        if refresh == ClientApiRefreshPolicy::Immediate {
                            let now = Instant::now();
                            if let Some(model) = &mut state.supervisor_model {
                                refresh_client_supervisor_summaries(
                                    model,
                                    &mut state.pending_main_refresh,
                                    &state.ssh_bridges,
                                    &mut state.pending_summary_refresh_server_ids,
                                    &event_tx,
                                );
                                state.last_supervisor_summary_refresh = now;
                                state.request_full_redraw();
                            }
                            schedule_missing_secondary_stream_retries(
                                &mut state,
                                &server_writes,
                                now,
                            );
                            if let Some(model) = &state.supervisor_model {
                                start_missing_supervisor_summary_subscriptions(
                                    model,
                                    &mut state.summary_subscription_server_ids,
                                    &state.ssh_bridges,
                                    &event_tx,
                                    &should_quit,
                                );
                            }
                        } else if refresh == ClientApiRefreshPolicy::ImmediateFocused {
                            // item 6 (Area 6): targeted single-server fetch for the focused server
                            // ONLY (not the whole fleet). A focused main workspace produces
                            // server_id == main, so the local `&mut` refresh path is reachable.
                            let now = Instant::now();
                            if let Some(model) = &mut state.supervisor_model {
                                if server_id == supervisor::ServerId::main() {
                                    if let Err(err) = model.refresh_main_summary_from_api(
                                        &mut crate::api::client::ApiClient::local(),
                                    ) {
                                        warn!(err = %err, "failed to refresh focused main summary");
                                    }
                                } else {
                                    start_single_secondary_summary_refresh(
                                        model,
                                        &server_id,
                                        &state.ssh_bridges,
                                        &mut state.pending_summary_refresh_server_ids,
                                        &event_tx,
                                    );
                                }
                                state.request_full_redraw();
                            }
                            state.last_summary_refresh.insert(server_id.clone(), now);
                        }
                    }
                    Err(err) => {
                        warn!(
                            server_id = ?server_id,
                            err = %err,
                            "failed to route client sidebar request"
                        );
                        // item 6 (Area 6): reconcile the optimistic highlight back to summary
                        // truth on the next refresh when the focus request itself failed.
                        if let Some(model) = &mut state.supervisor_model {
                            model.clear_optimistic_focus_on_failure(&server_id);
                        }
                    }
                }
                state.request_full_redraw();
                request_composited_render(&mut state);
            }
            ClientLoopEvent::SecondaryConnectionAttemptFinished {
                server_id,
                attempt,
                result,
                elapsed,
            } => {
                state
                    .pending_secondary_connect_server_ids
                    .remove(&server_id);
                if elapsed > CLIENT_60FPS_FRAME_BUDGET {
                    debug!(
                        server_id = ?server_id,
                        elapsed_ms = elapsed.as_secs_f64() * 1000.0,
                        frame_budget_fps = fps_for_frame_duration(CLIENT_60FPS_FRAME_BUDGET),
                        "secondary client connection attempt completed off UI thread"
                    );
                }
                match result {
                    Ok(connection) => {
                        if let Some(bridge) = connection.bridge {
                            state.ssh_bridges.insert(server_id.clone(), bridge);
                        }
                        let rx_bytes = state.rx_counters.counter(&server_id);
                        let max_frame_size = server_frame_size_cap(state.kitty_graphics_enabled);
                        if let Err(err) = attach_secondary_client_stream(
                            server_id.clone(),
                            connection.stream,
                            rx_bytes,
                            &event_tx,
                            &should_quit,
                            &mut server_writes,
                            max_frame_size,
                        ) {
                            let next_attempt = attempt.saturating_add(1);
                            schedule_secondary_retry(
                                &mut state,
                                server_id.clone(),
                                next_attempt,
                                Instant::now(),
                            );
                            if let Some(model) = &mut state.supervisor_model {
                                let _ = model.set_connection_state(
                                    &server_id,
                                    connection_state_from_client_error(&err),
                                );
                            }
                            warn!(
                                server_id = ?server_id,
                                err = %err,
                                "failed to attach retried secondary client stream"
                            );
                            state.request_full_redraw();
                            request_composited_render(&mut state);
                            continue;
                        }

                        state.secondary_retries.remove(&server_id);
                        state.provision_failed.remove(&server_id);
                        state.retry_restart_incompatible.remove(&server_id);
                        state.update_outcome_expiry.remove(&server_id);
                        let now = Instant::now();
                        if let Some(model) = &mut state.supervisor_model {
                            let _ = model.set_connection_state(
                                &server_id,
                                supervisor::ConnectionState::Connected,
                            );
                            // The connection is up: the provisioning stage log and any stale
                            // failure outcome have served their purpose — drop the sub-lines.
                            model.set_update_progress(&server_id, None);
                            model.clear_update_outcome(&server_id);
                            // item 6 (Area 6): prioritize the just-connected server. Neither
                            // `set_connection_state(.., Connected)` nor anything here sets
                            // `active_server_id`, so key off the handler's explicit `server_id`
                            // (NOT `active_server_id()`). Its summary is put in flight FIRST; the
                            // dedupe guard then prevents the whole-fleet fan-out below from
                            // double-spawning it.
                            start_single_secondary_summary_refresh(
                                model,
                                &server_id,
                                &state.ssh_bridges,
                                &mut state.pending_summary_refresh_server_ids,
                                &event_tx,
                            );
                            state.last_summary_refresh.insert(server_id.clone(), now);
                            refresh_client_supervisor_summaries(
                                model,
                                &mut state.pending_main_refresh,
                                &state.ssh_bridges,
                                &mut state.pending_summary_refresh_server_ids,
                                &event_tx,
                            );
                            start_missing_supervisor_summary_subscriptions(
                                model,
                                &mut state.summary_subscription_server_ids,
                                &state.ssh_bridges,
                                &event_tx,
                                &should_quit,
                            );
                            state.last_supervisor_summary_refresh = now;
                        }
                    }
                    Err(err) => {
                        let connection_state = connection_state_from_client_error(&err);
                        if matches!(
                            connection_state,
                            supervisor::ConnectionState::ProtocolMismatch { .. }
                        ) {
                            state.secondary_retries.remove(&server_id);
                        } else {
                            match classify_provision_failure(&err) {
                                ProvisionFailureDisposition::Retry => {
                                    let next_attempt = attempt.saturating_add(1);
                                    let delay = secondary_retry_delay(next_attempt);
                                    schedule_secondary_retry(
                                        &mut state,
                                        server_id.clone(),
                                        next_attempt,
                                        Instant::now(),
                                    );
                                    // Leave the failure visible between attempts: the stage log
                                    // keeps the history and this transient line says what failed
                                    // and that the sweep is still on it.
                                    if let Some(model) = &mut state.supervisor_model {
                                        model.set_update_progress(
                                            &server_id,
                                            Some(format!(
                                                "✗ {} — retrying in {}s",
                                                map_remote_bridge_error(&err.to_string()),
                                                delay.as_secs()
                                            )),
                                        );
                                    }
                                }
                                disposition @ (ProvisionFailureDisposition::Stop
                                | ProvisionFailureDisposition::StopNeedsRestartConfirm) => {
                                    // Terminal: retrying cannot fix this (ssh auth, unknown host,
                                    // impossible seed/version, or a server restart that needs
                                    // explicit approval). Stop the sweep and pin a persistent,
                                    // multiline failure on the banner; an explicit retry (context
                                    // menu / status glyph) clears it and starts fresh.
                                    state.secondary_retries.remove(&server_id);
                                    state.provision_failed.insert(server_id.clone());
                                    let retry_hint = if disposition
                                        == ProvisionFailureDisposition::StopNeedsRestartConfirm
                                    {
                                        state.retry_restart_incompatible.insert(server_id.clone());
                                        "retry restarts the remote server (live panes interrupted)"
                                    } else {
                                        "fix the cause, then retry from the host menu or its status glyph"
                                    };
                                    if let Some(model) = &mut state.supervisor_model {
                                        model.set_update_progress(&server_id, None);
                                        model.set_update_outcome(
                                            &server_id,
                                            crate::app::state::HostUpdateOutcome {
                                                success: false,
                                                message: format!(
                                                    "✗ {}\n  {retry_hint}",
                                                    map_remote_bridge_error(&err.to_string())
                                                ),
                                            },
                                        );
                                    }
                                    // No expiry: a terminal provisioning failure stays visible
                                    // until an explicit retry clears it.
                                    state.update_outcome_expiry.remove(&server_id);
                                }
                            }
                        }
                        state.ssh_bridges.remove(&server_id);
                        if let Some(model) = &mut state.supervisor_model {
                            let _ = model.set_connection_state(&server_id, connection_state);
                        }
                        warn!(
                            server_id = ?server_id,
                            err = %err,
                            "failed to retry secondary client connection"
                        );
                    }
                }
                state.request_full_redraw();
                request_composited_render(&mut state);
            }
            ClientLoopEvent::AddRemoteFinished { result, elapsed } => {
                state.pending_add_remote = false;
                if elapsed > CLIENT_60FPS_FRAME_BUDGET {
                    debug!(
                        elapsed_ms = elapsed.as_secs_f64() * 1000.0,
                        frame_budget_fps = fps_for_frame_duration(CLIENT_60FPS_FRAME_BUDGET),
                        "client add-remote registration completed off UI thread"
                    );
                }
                match result {
                    Ok(remote) => {
                        // Registration succeeded: close the form NOW and insert the host row in
                        // `Connecting` state — provisioning (install/bridge) happens in the retry
                        // sweep with live progress sub-lines under the banner, so the user is never
                        // stuck in a modal waiting for a slow install (and a failure surfaces on
                        // the row itself, retryable via the context menu or the status glyph).
                        let server_id = state.supervisor_model.as_mut().map(|model| {
                            model.finish_add_remote();
                            let server_id = model.add_secondary_with_state(
                                remote,
                                supervisor::ConnectionState::Connecting,
                            );
                            model.set_update_progress(
                                &server_id,
                                Some("waiting to connect…".to_string()),
                            );
                            server_id
                        });
                        if let Some(server_id) = server_id {
                            schedule_secondary_retry(&mut state, server_id, 0, Instant::now());
                        }
                    }
                    Err(err) => {
                        warn!(err = %err, "failed to register client remote");
                        if let Some(model) = &mut state.supervisor_model {
                            model.set_add_remote_error(err);
                        }
                    }
                }
                state.request_full_redraw();
                render_cached_composited_frame(&mut state);
            }
            // Worktree-menu parity: fill the open "open worktree…" picker (stale/closed pickers
            // ignore the result inside `fill_worktree_picker`).
            ClientLoopEvent::WorktreeListFetched {
                server_id,
                workspace_id,
                result,
            } => {
                if let Some(model) = &mut state.supervisor_model {
                    model.fill_worktree_picker(&server_id, &workspace_id, result);
                }
                state.request_full_redraw();
                render_cached_composited_frame(&mut state);
            }
            // C4: fill the open session picker (stale/closed pickers ignore the result inside
            // `fill_session_picker`).
            ClientLoopEvent::SessionListFetched { server_id, result } => {
                if let Some(model) = &mut state.supervisor_model {
                    model.fill_session_picker(&server_id, result);
                }
                state.request_full_redraw();
                render_cached_composited_frame(&mut state);
            }
            // #44: a one-click update reported a provisioning stage — refresh that host's banner
            // sub-line (ignored once the model is gone). Server_id-keyed so the right banner updates.
            ClientLoopEvent::UpdateRemoteProgress { server_id, message } => {
                if let Some(model) = &mut state.supervisor_model {
                    // #61: fresh progress means a NEW update is underway — drop any prior terminal
                    // outcome so a lingering "✗ update failed"/"✓ updated" line (which the renderer
                    // draws in preference to the spinner) can't mask this run's live progress.
                    model.clear_update_outcome(&server_id);
                    model.set_update_progress(&server_id, Some(message));
                }
                state.update_outcome_expiry.remove(&server_id);
                state.request_full_redraw();
                render_cached_composited_frame(&mut state);
            }
            // #44: a one-click update finished. Clear the progress line, and on success tear the
            // stream down + schedule an immediate reconnect (so it dials back up on the now-matching
            // protocol) and re-fetch runtime status; on failure, surface a truthful message.
            ClientLoopEvent::UpdateRemoteFinished {
                server_id,
                result,
                elapsed,
            } => {
                state.pending_update_remote.remove(&server_id);
                if elapsed > CLIENT_60FPS_FRAME_BUDGET {
                    debug!(
                        elapsed_ms = elapsed.as_secs_f64() * 1000.0,
                        frame_budget_fps = fps_for_frame_duration(CLIENT_60FPS_FRAME_BUDGET),
                        "client update-remote submission completed off UI thread"
                    );
                }
                let succeeded = result.is_ok();
                apply_update_remote_finished(
                    &mut state,
                    &mut server_writes,
                    &server_id,
                    result,
                    Instant::now(),
                );
                // Only re-fetch the version/protocol on success — a failed update left the old
                // binary in place (the readout is still accurate).
                if succeeded {
                    refetch_secondary_runtime_status(&mut state, &server_id, &event_tx);
                }
                state.request_full_redraw();
                render_cached_composited_frame(&mut state);
            }
            ClientLoopEvent::SupervisorRuntimeStatusFetched {
                server_id,
                version,
                protocol,
            } => {
                let mut enriched = false;
                if let Some(model) = &mut state.supervisor_model {
                    // #61: if this host is showing a "✓ update complete" outcome, fold in the
                    // freshly-installed version now that we know it. Gated on a live success outcome,
                    // so routine version fetches for un-updated hosts never pop a toast.
                    if let Some(version) = version.as_deref() {
                        enriched = model.enrich_update_success_with_version(&server_id, version);
                    }
                    model.set_remote_runtime_info(&server_id, version, protocol);
                    state.request_full_redraw();
                }
                if enriched {
                    // Re-arm the display timer so the enriched "updated to vX.Y.Z" line shows for its
                    // full window rather than expiring on the original (version-less) deadline.
                    state
                        .update_outcome_expiry
                        .insert(server_id.clone(), Instant::now() + HOST_UPDATE_OUTCOME_TTL);
                }
                // #61: this is the freshest read of the remote's protocol — if it mismatches and the
                // remote has auto-update enabled, push this client's build onto it now.
                auto_update_mismatched_remotes(&mut state, &event_tx);
                // #61: this now fires on EVERY summary refresh (the version readout populate path),
                // not just once after an update — so the render MUST coalesce like the summary
                // handler, or a fleet of remotes flooding the 400ms/2s cadence would drop the UI to
                // ~1fps with one full rebuild per event. The runtime status is posted right before
                // its paired summary event, so a coalesced (latest-wins) render flushes both.
                request_composited_render(&mut state);
            }
            ClientLoopEvent::RemoteManageRequestFinished {
                action,
                remote_id,
                result,
                elapsed,
            } => {
                if elapsed > CLIENT_60FPS_FRAME_BUDGET {
                    debug!(
                        elapsed_ms = elapsed.as_secs_f64() * 1000.0,
                        frame_budget_fps = fps_for_frame_duration(CLIENT_60FPS_FRAME_BUDGET),
                        "client remote-manage request completed off UI thread"
                    );
                }
                apply_remote_manage_request_finished(
                    &mut state,
                    &mut server_writes,
                    action,
                    &remote_id,
                    result,
                    &event_tx,
                );
                state.request_full_redraw();
                render_cached_composited_frame(&mut state);
            }
            ClientLoopEvent::ServerDisconnected(server_id) => {
                if server_id == supervisor::ServerId::main() {
                    return Err(ClientError::ConnectionLost(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "server closed connection",
                    )));
                }
                server_writes.remove(&server_id);
                // #36: preserve the last frame on involuntary disconnect (see handle_server_write_failure).
                state.summary_subscription_server_ids.remove(&server_id);
                state.pending_summary_refresh_server_ids.remove(&server_id);
                state
                    .pending_secondary_connect_server_ids
                    .remove(&server_id);
                state.ssh_bridges.remove(&server_id);
                // Drop any in-flight ping nonce so the disconnected server leaves no stale entry.
                state.pending_pings.remove(&server_id);
                if let Some(model) = &mut state.supervisor_model {
                    let _ = model.set_connection_state(
                        &server_id,
                        supervisor::ConnectionState::Disconnected,
                    );
                    state.request_full_redraw();
                }
                schedule_secondary_retry(&mut state, server_id, 0, Instant::now());
                render_cached_composited_frame(&mut state);
            }
            ClientLoopEvent::MainSupervisorRefreshed { result, elapsed } => {
                // #42: apply the off-loop main-server refresh on the loop thread. Clearing the
                // pending flag re-arms the next trigger.
                state.pending_main_refresh = false;
                match result {
                    Ok(snapshot) => {
                        if let Some(model) = &mut state.supervisor_model {
                            model.apply_main_supervisor_snapshot(snapshot);
                        }
                        // #36: prune the retained frame_cache for any remote the registry sync just
                        // dropped (an externally-removed remote is never torn down here). Separate
                        // immutable-model borrow so it composes with the &mut frame_cache.
                        if let Some(model) = &state.supervisor_model {
                            state
                                .frame_cache
                                .retain(|server_id, _| model.contains_server(server_id));
                        }
                        state.request_full_redraw();
                        render_cached_composited_frame(&mut state);
                    }
                    Err(err) => {
                        warn!(
                            err = %err,
                            elapsed_ms = elapsed.as_millis(),
                            "main supervisor refresh failed off the UI loop",
                        );
                    }
                }
            }
            ClientLoopEvent::MainSupervisorBootstrapped(model) => {
                // #42: the off-loop cold-start hydrate landed — swap the minimal paint-first model
                // for the fully-hydrated one. A one-time wholesale replace is safe: at cold start
                // the minimal model carries no overlay/optimistic state, and `active_server_id`
                // defaults to main in both. The periodic `MainSupervisorRefreshed` cadence (and its
                // surgical apply) takes over from here.
                state.supervisor_model = Some(*model);
                // #36: prune any retained frame_cache for a server the hydrated registry doesn't
                // know (separate immutable-model borrow so it composes with &mut frame_cache).
                if let Some(model) = &state.supervisor_model {
                    state
                        .frame_cache
                        .retain(|server_id, _| model.contains_server(server_id));
                }
                state.request_full_redraw();
                render_cached_composited_frame(&mut state);
            }
            ClientLoopEvent::Timer => {
                // Check if we should quit.
                let now = Instant::now();
                // #61: drop any host update-outcome banner line whose display window has elapsed, then
                // force a rebuild this tick so the cleared sub-line actually leaves the screen.
                if expire_host_update_outcomes(&mut state, now) {
                    state.request_full_redraw();
                    state.pending_full_render = true;
                }
                // #48/#56: flush a deferred (coalesced) hover / menu-selection repaint. The
                // HoverRedraw dispatch only marks this pending (it preserves the cached shell AND the
                // blit baseline); the actual recompose + diff-write happens here, gated by the
                // frame-budget deadline `next_select_deadline` set — so a motion-event flood collapses
                // to at most one repaint per frame (latest-wins). #56: this recomposes from the SAME
                // cached hover-less shell (`rebuild = false`) and repaints the highlight via the
                // overlay — NO `build_shell` rebuild — so hover stays smooth no matter the fleet size.
                // The render reads the compositor's current hover, so intermediate positions are
                // simply skipped. `flush_composited_frame` clears the flag.
                if state.pending_full_render {
                    // many-remotes: flush the deferred (coalesced) full rebuild for a fleet-scale
                    // model-update storm — ONE `build_shell`/`from_model` here applies every summary/
                    // connection mutation that landed since the last frame, instead of one rebuild per
                    // event. A full render supersedes a deferred hover repaint. Clear BEFORE rendering
                    // so an early-return can't leave the flag set and busy-spin the deadline.
                    state.pending_full_render = false;
                    state.pending_hover_render = false;
                    render_cached_composited_frame(&mut state);
                } else if state.pending_hover_render {
                    // Clear BEFORE rendering: `flush_composited_frame` clears it on the normal path,
                    // but clearing here too keeps a `recompose_composited_frame` early-return
                    // (model/compositor absent) from leaving the flag set — which would busy-spin the
                    // frame-budget-clamped deadline. Defensive; that path is unreachable today.
                    state.pending_hover_render = false;
                    recompose_composited_frame(&mut state, false);
                }
                sample_download_rates(&mut state, now);
                // issue #13: probe each connected server's latency over its persistent stream.
                if now.duration_since(state.last_ping_at) >= SERVER_PING_INTERVAL {
                    state.last_ping_at = now;
                    for (server_id, handle) in &server_writes {
                        state.ping_nonce = state.ping_nonce.wrapping_add(1);
                        let nonce = state.ping_nonce;
                        if queue_to_server(handle, ClientMessage::Ping { nonce }).is_ok() {
                            state.pending_pings.insert(server_id.clone(), (nonce, now));
                        }
                    }
                }
                retry_due_secondary_connections(&mut state, now, &event_tx, &mut server_writes);

                // item 6 (Area 6): adaptive secondary cadence (400ms active / 2s background). Each
                // due secondary fetch goes through the spawn helper (off the UI loop); we record
                // `last_summary_refresh[id]` on START so a slow SSH fetch does not stack (the
                // `pending_summary_refresh_server_ids` guard also prevents duplicate workers). The
                // Timer body issues NO inline blocking secondary API call.
                let due = due_secondary_summary_refreshes(&state, now);
                if !due.is_empty() {
                    if let Some(model) = &state.supervisor_model {
                        for server_id in &due {
                            start_single_secondary_summary_refresh(
                                model,
                                server_id,
                                &state.ssh_bridges,
                                &mut state.pending_summary_refresh_server_ids,
                                &event_tx,
                            );
                            state.last_summary_refresh.insert(server_id.clone(), now);
                        }
                    }
                }

                let mut did_local_refresh = false;
                if supervisor_summary_refresh_due(now, state.last_supervisor_summary_refresh) {
                    // #42: the 2s gate now SPAWNS the local main/registry/ui-settings refresh off
                    // the UI loop (posts MainSupervisorRefreshed) instead of blocking the loop on
                    // four Unix-socket round-trips. The per-secondary `due` loop above remains the
                    // single source of secondary cadence (no fan-out here).
                    if state.supervisor_model.is_some() {
                        spawn_main_supervisor_refresh(&mut state.pending_main_refresh, &event_tx);
                        state.last_supervisor_summary_refresh = now;
                    }
                    schedule_missing_secondary_stream_retries(&mut state, &server_writes, now);
                    if let Some(model) = &state.supervisor_model {
                        start_missing_supervisor_summary_subscriptions(
                            model,
                            &mut state.summary_subscription_server_ids,
                            &state.ssh_bridges,
                            &event_tx,
                            &should_quit,
                        );
                    }
                    did_local_refresh = true;
                }
                if !due.is_empty() || did_local_refresh {
                    render_cached_composited_frame(&mut state);
                }

                // item 5: gated, fully-local animation step. Advances the single client
                // animation tick at the 80ms cadence and recomposes via the blit diff (NOT a
                // full redraw). It calls ONLY advance_animation_tick + prune_and_seed_working_since
                // (map only) + render_cached_composited_frame — never any SSH/API I/O (commit
                // 3d47acd). When nothing is animating, `wants` is false and the tick never
                // advances (zero idle recompose).
                let wants = state.compositor.is_some()
                    && (state
                        .supervisor_model
                        .as_ref()
                        .is_some_and(compositor::sidebar_wants_animation)
                        // #9: also tick while the collapse/expand width is sliding.
                        || state
                            .compositor
                            .as_ref()
                            .is_some_and(compositor::ClientCompositor::sidebar_width_animating));
                if should_advance_animation(wants, now, state.last_animation_tick) {
                    if let (Some(c), Some(m)) =
                        (state.compositor.as_mut(), state.supervisor_model.as_ref())
                    {
                        c.advance_animation_tick(CLIENT_ANIMATION_TICK_STEP);
                        // #9: advance the collapse/expand width slide one step (no-op once settled).
                        c.step_sidebar_width_animation();
                        prune_and_seed_working_since(c, m, now);
                    }
                    state.last_animation_tick = now;
                    // #46 (item 2): the collapse/expand slide changes the content region width every
                    // tick, so resize the server-rendered content to match — otherwise the reclaimed
                    // columns stay blank and the server keeps rendering at the pre-collapse width
                    // (collapse used to ONLY flip state + redraw, never resizing). Emit only when the
                    // content size actually changed, so the slide costs ≤4 resizes over ~320ms — no
                    // #17-style resize storm. Mirrors the `ClientInputDispatch::Resize` send path.
                    let (host_cols, host_rows) = state.host_size;
                    let content = state
                        .compositor
                        .as_ref()
                        .map(|c| c.content_size(host_cols, host_rows));
                    if let Some(content) = content {
                        if content != state.reported_size {
                            state.reported_size = content;
                            let msg = ClientMessage::Resize {
                                cols: content.0,
                                rows: content.1,
                                cell_width_px: state.cell_size_px.0,
                                cell_height_px: state.cell_size_px.1,
                            };
                            let mut write_failures = Vec::new();
                            for (server_id, handle) in server_writes.iter() {
                                if let Err(e) = queue_to_server(handle, msg.clone()) {
                                    write_failures.push((server_id.clone(), e));
                                }
                            }
                            for (server_id, error) in write_failures {
                                handle_server_write_failure(
                                    &mut state,
                                    &mut server_writes,
                                    server_id,
                                    error,
                                    now,
                                )?;
                            }
                        }
                    }
                    render_cached_composited_frame(&mut state);
                }
                #[cfg(windows)]
                state.flush_pending_cursor_reveal_if_due();
            }
        }
    }

    // Clean exit (Ctrl+C). Send Detach before closing.
    let detach = ClientMessage::Detach;
    for handle in server_writes.values() {
        let _ = queue_to_server(handle, detach.clone());
    }
    let _ = io::stdout().flush();

    Ok(())
}

// ---------------------------------------------------------------------------
// Per-server downstream byte counters (issue #13 host-banner throughput)
// ---------------------------------------------------------------------------

/// Shared cumulative downstream byte counters keyed by server, fed by the reader threads and
/// sampled on the UI loop to derive a bytes/sec rate for the host banner.
#[derive(Clone, Default)]
struct RxByteCounters(
    Arc<std::sync::Mutex<HashMap<supervisor::ServerId, Arc<std::sync::atomic::AtomicU64>>>>,
);

impl RxByteCounters {
    /// The (get-or-create) cumulative byte counter for one server.
    fn counter(&self, server_id: &supervisor::ServerId) -> Arc<std::sync::atomic::AtomicU64> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(server_id.clone())
            .or_default()
            .clone()
    }

    /// Snapshot of cumulative bytes received per server.
    fn snapshot(&self) -> Vec<(supervisor::ServerId, u64)> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(id, bytes)| (id.clone(), bytes.load(std::sync::atomic::Ordering::Relaxed)))
            .collect()
    }
}

/// A `Read` wrapper that tallies bytes into a shared counter, so the reader thread can report
/// downstream throughput without changing the framing/protocol layer.
struct CountingReader<R> {
    inner: R,
    counter: Arc<std::sync::atomic::AtomicU64>,
}

impl<R: io::Read> io::Read for CountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.counter
            .fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
        Ok(n)
    }
}

// ---------------------------------------------------------------------------
// Server reader thread
// ---------------------------------------------------------------------------

/// Blocking thread that reads ServerMessages from the server and sends them
/// to the main event loop.
/// Framing cap for a server reader thread. Graphics frames embed image bytes that can exceed
/// `MAX_FRAME_SIZE`, so every reader (main and secondary) must use the larger cap when kitty
/// graphics are enabled — otherwise a large graphics frame fails framing and flaps the connection.
fn server_frame_size_cap(kitty_graphics_enabled: bool) -> usize {
    if kitty_graphics_enabled {
        MAX_GRAPHICS_FRAME_SIZE
    } else {
        MAX_FRAME_SIZE
    }
}

fn server_reader_thread(
    server_id: supervisor::ServerId,
    stream: LocalStream,
    rx_bytes: Arc<std::sync::atomic::AtomicU64>,
    event_tx: tokio::sync::mpsc::Sender<ClientLoopEvent>,
    should_quit: &Arc<AtomicBool>,
    max_frame_size: usize,
) {
    // Ensure the read stream is in blocking mode to avoid WouldBlock errors
    // from read_exact inside read_message. The stream should already be
    // blocking after handshake, but we enforce it here as a safety measure.
    if stream.set_nonblocking(false).is_err() {
        // If we can't set blocking mode, the stream is likely broken.
        let _ = event_tx.blocking_send(ClientLoopEvent::ServerDisconnected(server_id));
        return;
    }
    // Tally every downstream byte (issue #13) without touching the framing layer.
    let mut stream = CountingReader {
        inner: stream,
        counter: rx_bytes,
    };

    loop {
        if should_quit.load(Ordering::Acquire) {
            break;
        }

        match protocol::read_message(&mut stream, max_frame_size) {
            Ok(msg) => {
                if event_tx
                    .blocking_send(ClientLoopEvent::ServerMessage {
                        server_id: server_id.clone(),
                        message: msg,
                    })
                    .is_err()
                {
                    break; // Main loop gone.
                }
            }
            Err(protocol::FramingError::UnexpectedEof) => {
                // Server closed connection.
                let _ = event_tx.blocking_send(ClientLoopEvent::ServerDisconnected(server_id));
                break;
            }
            Err(protocol::FramingError::Io(err)) if err.kind() == io::ErrorKind::WouldBlock => {
                // Should not happen with blocking mode, but handle gracefully
                // in case the stream was set nonblocking by another clone.
                std::thread::sleep(Duration::from_millis(1));
                continue;
            }
            Err(err) => {
                warn!(err = %err, "server read error");
                let _ = event_tx.blocking_send(ClientLoopEvent::ServerDisconnected(server_id));
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Write helper
// ---------------------------------------------------------------------------

/// Writes a message to the server stream (blocking).
fn write_to_server(stream: &mut LocalStream, msg: &ClientMessage) -> io::Result<()> {
    protocol::write_message(stream, msg).map_err(|e| io::Error::other(e.to_string()))
}

fn active_server_id(state: &ClientState) -> supervisor::ServerId {
    state
        .supervisor_model
        .as_ref()
        .map(|model| model.active_server_id().clone())
        .unwrap_or_else(supervisor::ServerId::main)
}

fn queue_to_server(handle: &ServerWriteHandle, msg: ClientMessage) -> io::Result<()> {
    handle
        .tx
        .send(msg)
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "server writer stopped"))
}

fn queue_to_server_id(
    server_writes: &HashMap<supervisor::ServerId, ServerWriteHandle>,
    server_id: &supervisor::ServerId,
    msg: ClientMessage,
) -> io::Result<()> {
    let Some(handle) = server_writes.get(server_id) else {
        return Err(io::Error::new(
            io::ErrorKind::NotConnected,
            format!("server stream {server_id:?} is not connected"),
        ));
    };
    queue_to_server(handle, msg)
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

fn reload_local_client_config(
    sound_config: &mut crate::config::SoundConfig,
    redraw_on_focus_gained: &mut bool,
) {
    match crate::config::load_live_config() {
        Ok(loaded) => {
            for diagnostic in loaded.config.ui.sound.diagnostics() {
                warn!(diagnostic = %diagnostic, "local sound config diagnostic");
            }
            *sound_config = loaded.config.ui.sound;
            *redraw_on_focus_gained = loaded.config.ui.redraw_on_focus_gained;
            debug!("reloaded local client config");
        }
        Err(diagnostics) => {
            warn!(diagnostics = ?diagnostics, "failed to reload local client config; keeping current client config");
        }
    }
}

fn handle_notify(
    kind: NotifyKind,
    message: &str,
    body: Option<&str>,
    sound_config: &crate::config::SoundConfig,
) {
    handle_notify_with_notifiers(
        kind,
        message,
        body,
        sound_config,
        crate::terminal_notify::show_notification,
        crate::platform::show_desktop_notification,
    );
}

fn handle_notify_with_notifiers(
    kind: NotifyKind,
    message: &str,
    body: Option<&str>,
    sound_config: &crate::config::SoundConfig,
    mut show_terminal_notification: impl FnMut(&str, Option<&str>) -> io::Result<bool>,
    mut show_system_notification: impl FnMut(&str, Option<&str>) -> io::Result<bool>,
) {
    match kind {
        NotifyKind::Sound => {
            let Some(sound) = sound_from_notify_message(message) else {
                warn!(
                    message = message,
                    "received unknown sound notification from server"
                );
                return;
            };
            if sound_config.enabled {
                crate::sound::play(sound, sound_config);
            }
        }
        NotifyKind::Toast => {
            debug!(
                message = message,
                "received terminal toast notification from server"
            );
            if let Err(err) = show_terminal_notification(message, body) {
                warn!(err = %err, "failed to emit terminal notification");
            }
        }
        NotifyKind::SystemToast => {
            debug!(
                message = message,
                "received system toast notification from server"
            );
            if let Err(err) = show_system_notification(message, body) {
                warn!(err = %err, "failed to emit system notification");
            }
        }
    }
}

fn sound_from_notify_message(message: &str) -> Option<crate::sound::Sound> {
    match message {
        "agent done" => Some(crate::sound::Sound::Done),
        "agent attention" => Some(crate::sound::Sound::Request),
        _ => None,
    }
}

#[cfg(unix)]
fn should_bridge_clipboard_image_paste(data: &[u8]) -> bool {
    if data == b"\x1b[200~\x1b[201~" {
        return true;
    }

    let events = crate::raw_input::parse_raw_input_bytes_sync(data);
    matches!(
        events.as_slice(),
        [crate::raw_input::RawInputEvent::Key(key)]
            if key.kind == crossterm::event::KeyEventKind::Press
                && key.modifiers == crossterm::event::KeyModifiers::CONTROL
                && matches!(key.code, crossterm::event::KeyCode::Char('v' | 'V'))
    )
}

// ---------------------------------------------------------------------------
// Clipboard forwarding
// ---------------------------------------------------------------------------

/// Decode a clipboard payload forwarded by the server.
fn decode_clipboard_payload(data: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

/// Forwards a clipboard write from the server to the local client clipboard.
fn forward_clipboard(data: &str) {
    let Some(bytes) = decode_clipboard_payload(data) else {
        warn!("received invalid clipboard payload from server");
        return;
    };

    crate::selection::write_osc52_bytes(&bytes);
}

// ---------------------------------------------------------------------------
// Frame output
// ---------------------------------------------------------------------------

fn write_encoded_frame_with_graphics(
    mut writer: impl io::Write,
    encoded: &[u8],
    graphics: &[u8],
) -> io::Result<()> {
    if graphics.is_empty() {
        return writer.write_all(encoded);
    }

    let insertion = render_ansi::final_sync_output_end(encoded).unwrap_or(encoded.len());

    writer.write_all(&encoded[..insertion])?;
    record_received_kitty_graphics(graphics);
    writer.write_all(b"\x1b7")?;
    writer.write_all(graphics)?;
    writer.write_all(b"\x1b8")?;
    writer.write_all(&encoded[insertion..])
}

fn contains_kitty_graphics_bytes(bytes: &[u8]) -> bool {
    bytes.windows(3).any(|window| window == b"\x1b_G")
}

fn record_received_kitty_graphics(bytes: &[u8]) {
    let ids = kitty_graphics_image_ids(bytes);
    if ids.is_empty() {
        return;
    }
    let set = RECEIVED_KITTY_GRAPHICS_IDS.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(mut set) = set.lock() {
        set.extend(ids);
    }
}

fn clear_received_kitty_graphics(mut writer: impl io::Write) -> io::Result<()> {
    let Some(set) = RECEIVED_KITTY_GRAPHICS_IDS.get() else {
        return Ok(());
    };
    let Ok(mut set) = set.lock() else {
        return Ok(());
    };
    for id in set.drain() {
        write!(writer, "\x1b_Ga=d,d=I,i={id},q=2;\x1b\\")?;
    }
    writer.flush()
}

fn kitty_graphics_image_ids(bytes: &[u8]) -> Vec<u32> {
    let mut ids = Vec::new();
    let mut index = 0usize;
    while let Some(start) = find_subslice(&bytes[index..], b"\x1b_G") {
        let command_start = index + start + 3;
        let Some(end) = find_subslice(&bytes[command_start..], b"\x1b\\") else {
            break;
        };
        let command = &bytes[command_start..command_start + end];
        if let Some(id) = kitty_graphics_command_image_id(command) {
            ids.push(id);
        }
        index = command_start + end + 2;
    }
    ids
}

fn kitty_graphics_command_image_id(command: &[u8]) -> Option<u32> {
    let header_end = command
        .iter()
        .position(|byte| *byte == b';')
        .unwrap_or(command.len());
    for part in command[..header_end].split(|byte| *byte == b',') {
        let Some(value) = part.strip_prefix(b"i=") else {
            continue;
        };
        let text = std::str::from_utf8(value).ok()?;
        if let Ok(id) = text.parse::<u32>() {
            return Some(id);
        }
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ---------------------------------------------------------------------------
// Resize polling
// ---------------------------------------------------------------------------

/// Cell size assumed when neither the terminal size ioctl nor the host
/// terminal reports pixel dimensions.
const DEFAULT_CELL_WIDTH_PX: u32 = 8;
const DEFAULT_CELL_HEIGHT_PX: u32 = 16;

/// Cell size derived from the terminal size ioctl, if it reports pixels.
fn ioctl_cell_size() -> Option<(u32, u32)> {
    let size = crossterm::terminal::window_size().ok()?;
    if size.columns == 0 || size.rows == 0 || size.width == 0 || size.height == 0 {
        return None;
    }
    Some((
        (size.width as u32 / size.columns as u32).max(1),
        (size.height as u32 / size.rows as u32).max(1),
    ))
}

/// Cell size used when the ioctl reports no pixels.
fn cell_size_fallback(reported: u64) -> (u32, u32) {
    unpack_cell_size(reported).unwrap_or((DEFAULT_CELL_WIDTH_PX, DEFAULT_CELL_HEIGHT_PX))
}

#[cfg(any(unix, test))]
fn pack_cell_size(width_px: u32, height_px: u32) -> u64 {
    (u64::from(width_px) << 32) | u64::from(height_px)
}

fn unpack_cell_size(packed: u64) -> Option<(u32, u32)> {
    let width_px = (packed >> 32) as u32;
    let height_px = (packed & u64::from(u32::MAX)) as u32;
    (width_px > 0 && height_px > 0).then_some((width_px, height_px))
}

fn current_terminal_geometry(
    kitty_graphics_enabled: bool,
    reported_cell_size: &AtomicU64,
) -> (u16, u16, u32, u32) {
    let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));
    if !kitty_graphics_enabled {
        return (cols, rows, 0, 0);
    }
    let (cell_width_px, cell_height_px) = ioctl_cell_size()
        .unwrap_or_else(|| cell_size_fallback(reported_cell_size.load(Ordering::Acquire)));
    (cols, rows, cell_width_px, cell_height_px)
}

/// Reads the terminal geometry before the handshake, before any host cell
/// size report can exist.
fn initial_terminal_geometry(kitty_graphics_enabled: bool) -> (u16, u16, u32, u32) {
    current_terminal_geometry(kitty_graphics_enabled, &AtomicU64::new(0))
}

/// Reports polled changes and signalled resizes that return to the same size.
fn resize_report_required(
    signalled: bool,
    new_size: (u16, u16, u32, u32),
    last_size: (u16, u16, u32, u32),
) -> bool {
    signalled || new_size != last_size
}

/// Watches the terminal size and sends resize events when it changes.
///
/// The baseline cell size must match what the handshake sent to the server:
/// reading a fresh one here would race the host cell size reply and could
/// swallow the first change.
fn resize_poll_loop(
    resize_tx: tokio::sync::mpsc::Sender<ClientLoopEvent>,
    initial_cols: u16,
    initial_rows: u16,
    initial_cell_width: u32,
    initial_cell_height: u32,
    kitty_graphics_enabled: bool,
    reported_cell_size: &AtomicU64,
    should_quit: &Arc<AtomicBool>,
) {
    crate::platform::watch_terminal_resize_signal();
    let mut last_size = (
        initial_cols,
        initial_rows,
        initial_cell_width,
        initial_cell_height,
    );
    while !should_quit.load(Ordering::Acquire) {
        std::thread::sleep(Duration::from_millis(100));
        let signalled = crate::platform::take_terminal_resize_signal();
        let new_size = current_terminal_geometry(kitty_graphics_enabled, reported_cell_size);
        if resize_report_required(signalled, new_size, last_size) {
            last_size = new_size;
            if resize_tx
                .blocking_send(ClientLoopEvent::Resize(
                    new_size.0, new_size.1, new_size.2, new_size.3,
                ))
                .is_err()
            {
                break; // Main loop gone.
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/// Initialize logging for the client process.
fn query_host_terminal_theme() {
    let _ = write_host_terminal_theme_query(io::stdout());
}

fn should_query_host_terminal_theme() -> bool {
    !cfg!(windows)
}

fn write_host_terminal_theme_query(mut writer: impl io::Write) -> io::Result<()> {
    let query = crate::terminal_theme::host_terminal_theme_query_sequence();
    writer.write_all(query.as_bytes())?;
    writer.flush()
}

/// XTWINOPS request for the host terminal cell size in pixels.
const HOST_CELL_SIZE_QUERY: &[u8] = b"\x1b[16t";

fn query_host_cell_size() {
    let _ = write_host_cell_size_query(io::stdout());
}

fn should_query_host_cell_size() -> bool {
    !cfg!(windows)
}

/// Only pane graphics need pixel dimensions, and only when the ioctl cannot
/// provide them.
fn host_cell_size_query_required(kitty_graphics_enabled: bool) -> bool {
    kitty_graphics_enabled && should_query_host_cell_size() && ioctl_cell_size().is_none()
}

fn write_host_cell_size_query(mut writer: impl io::Write) -> io::Result<()> {
    writer.write_all(HOST_CELL_SIZE_QUERY)?;
    writer.flush()
}

#[cfg(any(unix, test))]
fn store_reported_cell_size(reported_cell_size: &AtomicU64, width_px: u32, height_px: u32) {
    let packed = pack_cell_size(width_px, height_px);
    if reported_cell_size.swap(packed, Ordering::AcqRel) != packed {
        debug!(width_px, height_px, "host terminal reported cell size");
    }
}

#[cfg(any(unix, test))]
fn reported_cell_size_from_events(
    events: &[crate::raw_input::RawInputEvent],
) -> Option<(u32, u32)> {
    events.iter().rev().find_map(|event| match event {
        crate::raw_input::RawInputEvent::HostCellSizeReport {
            width_px,
            height_px,
        } => Some((*width_px, *height_px)),
        _ => None,
    })
}

fn init_logging() {
    crate::logging::init_file_logging("herdr-client.log");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::{Mutex, OnceLock};

    #[test]
    fn run_remote_op_with_progress_returns_fast_success() {
        let value =
            run_remote_op_with_progress(Duration::from_secs(5), &|_| {}, |_sink| Ok(7u32)).unwrap();
        assert_eq!(value, 7);
    }

    #[test]
    fn run_remote_op_with_progress_surfaces_inner_error() {
        let result: Result<(), RemoteOpError> =
            run_remote_op_with_progress(Duration::from_secs(5), &|_| {}, |_sink| {
                Err(io::Error::other("boom"))
            });
        match result {
            Err(RemoteOpError::Failed(err)) => assert_eq!(err.to_string(), "boom"),
            other => panic!("expected Failed(boom), got {other:?}"),
        }
    }

    #[test]
    fn run_remote_op_with_progress_fails_when_op_stalls_without_progress() {
        // The core anti-hang guarantee: an op that makes no progress for a whole idle window yields
        // a timeout error, not a wedge.
        let result: Result<(), RemoteOpError> =
            run_remote_op_with_progress(Duration::from_millis(50), &|_| {}, |_sink| {
                std::thread::sleep(Duration::from_secs(30));
                Ok(())
            });
        assert!(
            matches!(result, Err(RemoteOpError::TimedOut { .. })),
            "stalled op must time out, got {result:?}"
        );
    }

    #[test]
    fn classify_provision_failure_turns_restart_signal_into_confirm_stop() {
        let signal = crate::remote::RestartConfirmNeeded {
            destination: "macmini".to_string(),
            version: Some("0.5.10".to_string()),
            protocol: Some(6),
        };
        let err = ClientError::ConnectionFailed(io::Error::other(signal));
        assert_eq!(
            classify_provision_failure(&err),
            ProvisionFailureDisposition::StopNeedsRestartConfirm
        );
    }

    #[test]
    fn classify_provision_failure_stops_on_terminal_errors() {
        // Retrying cannot fix ssh auth, an unknown hostname, or an impossible seed/version.
        for terminal in [
            "Permission denied (publickey,password).",
            "ssh: Could not resolve hostname nope: nodename nor servname provided",
            "Host key verification failed.",
            "installed remote herdr at \"$HOME/.local/bin/herdr\", but it reports `herdr 0.6.9`, not version 0.6.10-mx.1",
            "this mx-channel build (0.6.10-mx.1) cannot seed remotes from the herdr.dev release manifest",
            "remote herdr is incompatible and can't be upgraded in place — update it and retry",
        ] {
            let err = ClientError::ConnectionFailed(io::Error::other(terminal));
            assert_eq!(
                classify_provision_failure(&err),
                ProvisionFailureDisposition::Stop,
                "expected terminal stop for {terminal:?}"
            );
        }
    }

    #[test]
    fn classify_provision_failure_retries_transient_errors() {
        // Network blips keep the conservative backoff retry running (pre-existing behaviour).
        for transient in [
            "ssh: connect to host x port 22: Connection refused",
            "ssh: connect to host claude-m3max port 22: Operation timed out",
            "failed to start ssh remote bridge: no progress for 90s while installing herdr on the remote…",
            "ssh bridge exited with exit status: 255",
            "weird novel failure",
        ] {
            let err = ClientError::ConnectionFailed(io::Error::other(transient));
            assert_eq!(
                classify_provision_failure(&err),
                ProvisionFailureDisposition::Retry,
                "expected retry for {transient:?}"
            );
        }
    }

    #[test]
    fn maps_common_bridge_failures_to_actionable_text() {
        assert!(map_remote_bridge_error(
            "operation timed out after 90s connecting to the remote host"
        )
        .contains("timed out"));
        assert!(
            map_remote_bridge_error("ssh: connect to host x port 22: Connection refused")
                .contains("cannot reach host")
        );
        assert!(
            map_remote_bridge_error("Permission denied (publickey,password).")
                .contains("authentication failed")
        );
        assert!(
            map_remote_bridge_error("ssh: Could not resolve hostname nope")
                .contains("cannot reach host")
        );
        // An unmatched error passes through verbatim so we never hide unexpected detail.
        assert_eq!(
            map_remote_bridge_error("weird novel failure"),
            "weird novel failure"
        );
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn resize_signal_reports_even_when_polled_size_is_unchanged() {
        let size = (120, 40, 8, 16);
        assert!(resize_report_required(true, size, size));
        assert!(!resize_report_required(false, size, size));
        assert!(resize_report_required(false, (120, 41, 8, 16), size));
        assert!(resize_report_required(false, (120, 40, 9, 18), size));
    }

    fn restore_env_var(key: &str, value: Option<OsString>) {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            restore_env_var(self.key, self.previous.clone());
        }
    }

    fn test_remote_definition(
        id: &str,
        name: &str,
    ) -> crate::remote_registry::RemoteDefinitionSnapshot {
        crate::remote_registry::RemoteDefinitionSnapshot {
            id: id.into(),
            name: name.into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some(id.into()),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        }
    }

    fn test_client_state_with_model(model: supervisor::ClientSupervisorModel) -> ClientState {
        ClientState {
            blit_encoder: render_ansi::BlitEncoder::new(),
            remote_image_paste_key: None,
            frame_stats: ClientFrameStats::default(),
            mouse_capture_active: false,
            reported_size: (80, 24),
            host_size: (80, 24),
            cell_size_px: (0, 0),
            sound_config: crate::config::SoundConfig::default(),
            kitty_graphics_enabled: false,
            attach_escape: None,
            mouse_scroll_lines: 3,
            redraw_on_focus_gained: false,
            compositor: None,
            supervisor_model: Some(model),
            last_supervisor_summary_refresh: Instant::now(),
            frame_cache: HashMap::new(),
            shell_cache: None,
            shell_cache_disabled: false,
            rx_counters: RxByteCounters::default(),
            server_rx_sample: HashMap::new(),
            last_rx_sample_at: Instant::now(),
            ping_nonce: 0,
            pending_pings: HashMap::new(),
            last_ping_at: Instant::now(),
            summary_subscription_server_ids: HashSet::new(),
            pending_summary_refresh_server_ids: HashSet::new(),
            pending_main_refresh: false,
            pending_secondary_connect_server_ids: HashSet::new(),
            pending_add_remote: false,
            ssh_bridges: HashMap::new(),
            secondary_retries: HashMap::new(),
            manually_disconnected: HashSet::new(),
            provision_failed: HashSet::new(),
            retry_restart_incompatible: HashSet::new(),
            pending_update_remote: HashSet::new(),
            update_outcome_expiry: HashMap::new(),
            auto_update_suppressed: HashSet::new(),
            last_animation_tick: Instant::now(),
            pending_hover_render: false,
            pending_full_render: false,
            last_composited_render_at: Instant::now(),
            last_summary_refresh: HashMap::new(),
        }
    }

    /// many-remotes: a burst of fleet-scale model updates (a connect storm, or the 400ms/2s summary-
    /// refresh cadence firing across N connected remotes) within ONE frame budget must NOT run a full
    /// `build_shell`/`from_model` (O(hosts×agents)) rebuild per event — that serial rebuild flood is
    /// the ~1fps lag. They coalesce to a SINGLE deferred render the Timer flushes (latest-wins), so
    /// render cost is bounded to one rebuild per frame regardless of remote count.
    #[test]
    fn request_composited_render_coalesces_a_fleet_update_storm_within_a_frame() {
        let model = supervisor::ClientSupervisorModel::new("local");
        let mut state = test_client_state_with_model(model);
        // a frame was just flushed; 50 remotes then flood model updates in the same frame budget.
        state.last_composited_render_at = Instant::now();
        state.pending_full_render = false;
        for _ in 0..50 {
            request_composited_render(&mut state);
        }
        assert!(
            state.pending_full_render,
            "50 fleet updates inside one frame budget coalesce to ONE deferred render, not 50 rebuilds"
        );
    }

    /// #45: any model/view change funnels through `request_full_redraw`, which must drop the cached
    /// sidebar shell so the next compose rebuilds it. A reused content frame on a stale cache would
    /// otherwise paint an out-of-date sidebar over fresh model state.
    #[test]
    fn request_full_redraw_drops_cached_shell() {
        let model = supervisor::ClientSupervisorModel::new("local");
        let mut state = test_client_state_with_model(model);
        let compositor = compositor::ClientCompositor::default();
        let shell = {
            let model = state.supervisor_model.as_ref().expect("model present");
            compositor.build_shell(model, 80, 24, Instant::now())
        };
        state.shell_cache = Some(shell);
        assert!(state.shell_cache.is_some());

        state.request_full_redraw();

        assert!(
            state.shell_cache.is_none(),
            "request_full_redraw must drop the cached shell so the sidebar can't go stale (#45)"
        );
    }

    /// #48: helper — commit a baseline frame into a state's blit encoder, then report whether
    /// re-encoding a one-cell-changed frame is a full repaint (`true`) or a diff (`false`). A diff
    /// proves the blit baseline survived; a full write proves it was reset.
    fn next_encode_is_full_after(
        state: &mut ClientState,
        reset: impl FnOnce(&mut ClientState),
    ) -> bool {
        let baseline = protocol::FrameData::blank(80, 24);
        let encoded = state.blit_encoder.encode(&baseline, false);
        state.blit_encoder.commit(baseline.clone(), encoded);
        reset(state);
        let mut next = baseline.clone();
        next.cells[0].symbol = "X".into();
        state.blit_encoder.encode(&next, false).full
    }

    /// #56 (Seam 2): a hover / open-menu-selection change is presentation-only and must PRESERVE both
    /// caches — the cached hover-less shell (so no `build_shell` rebuild: the highlight is painted by
    /// the per-frame overlay, never baked) AND the blit-encoder diff baseline (so only the changed
    /// rows are written, not the whole screen). The #48 fix still dropped the shell (rebuilding it on
    /// every hover, which #56 removes so hover stays smooth no matter how many remotes are connected).
    #[test]
    fn request_hover_redraw_keeps_shell_and_blit_baseline() {
        let model = supervisor::ClientSupervisorModel::new("local");
        let mut state = test_client_state_with_model(model);
        let compositor = compositor::ClientCompositor::default();
        let shell = {
            let model = state.supervisor_model.as_ref().expect("model present");
            compositor.build_shell(model, 80, 24, Instant::now())
        };
        state.shell_cache = Some(shell);

        let next_is_full = next_encode_is_full_after(&mut state, |s| s.request_hover_redraw());

        assert!(
            state.shell_cache.is_some(),
            "#56: hover redraw must KEEP the cached hover-less shell (no O(hosts×agents) rebuild)"
        );
        assert!(
            !next_is_full,
            "#56: hover redraw must PRESERVE the blit diff baseline (no full-screen repaint)"
        );
    }

    /// Counterpart locking the contrast: a genuine model change (`request_full_redraw`) DOES reset
    /// the blit baseline, so the following frame is a full repaint. This is what a hover must NOT do.
    #[test]
    fn request_full_redraw_resets_blit_baseline() {
        let model = supervisor::ClientSupervisorModel::new("local");
        let mut state = test_client_state_with_model(model);

        let next_is_full = next_encode_is_full_after(&mut state, |s| s.request_full_redraw());

        assert!(
            next_is_full,
            "request_full_redraw must reset the blit baseline so the next frame is a full repaint"
        );
    }

    struct EnvVarsRemovedGuard {
        previous: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvVarsRemovedGuard {
        fn new(keys: &[&'static str]) -> Self {
            let previous: Vec<_> = keys
                .iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect();
            for key in keys {
                std::env::remove_var(key);
            }
            Self { previous }
        }
    }

    impl Drop for EnvVarsRemovedGuard {
        fn drop(&mut self) {
            for (key, value) in self.previous.clone() {
                restore_env_var(key, value);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn clipboard_image_paste_bridge_triggers_on_ctrl_v_and_empty_paste() {
        assert!(should_bridge_clipboard_image_paste(&[0x16]));
        assert!(should_bridge_clipboard_image_paste(b"\x1b[118;5u"));
        assert!(should_bridge_clipboard_image_paste(b"\x1b[200~\x1b[201~"));
        assert!(!should_bridge_clipboard_image_paste(
            b"\x1b[200~text\x1b[201~"
        ));
        assert!(!should_bridge_clipboard_image_paste(b"v"));
    }

    #[test]
    fn graphics_bytes_are_written_inside_synchronized_blit_with_saved_cursor() {
        let mut output = Vec::new();
        write_encoded_frame_with_graphics(
            &mut output,
            b"\x1b[?2026htext\x1b[?2026lcursor",
            b"graphics",
        )
        .unwrap();

        assert_eq!(
            output,
            b"\x1b[?2026htext\x1b7graphics\x1b8\x1b[?2026lcursor"
        );
    }

    #[test]
    fn empty_graphics_writes_only_blit_frame() {
        let mut output = Vec::new();
        write_encoded_frame_with_graphics(&mut output, b"text", b"").unwrap();

        assert_eq!(output, b"text");
    }

    #[test]
    fn terminal_frame_kitty_detection_matches_apc_prefix() {
        assert!(contains_kitty_graphics_bytes(b"text\x1b_Ga=p;\x1b\\"));
        assert!(!contains_kitty_graphics_bytes(b"text\x1b[?2026h"));
    }

    #[test]
    fn kitty_graphics_image_id_parser_tracks_herdr_ids_only() {
        let ids = kitty_graphics_image_ids(
            b"text\x1b_Ga=t,t=d,f=32,s=1,v=1,i=10023,q=2;AAAA\x1b\\\x1b_Ga=p,i=10023,p=7;\x1b\\",
        );
        assert_eq!(ids, vec![10023, 10023]);
    }

    #[test]
    fn kitty_graphics_cleanup_deletes_tracked_images_not_all_images() {
        record_received_kitty_graphics(b"\x1b_Ga=t,i=123,q=2;AAAA\x1b\\");
        let mut output = Vec::new();
        clear_received_kitty_graphics(&mut output).unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("a=d,d=I,i=123"));
        assert!(!text.contains("d=A"));
    }

    #[test]
    fn write_host_terminal_theme_query_emits_osc_queries() {
        let mut output = Vec::new();
        write_host_terminal_theme_query(&mut output).unwrap();
        assert_eq!(
            output,
            crate::terminal_theme::host_terminal_theme_query_sequence().as_bytes()
        );
    }

    #[test]
    fn host_terminal_theme_query_is_disabled_on_windows() {
        assert_eq!(should_query_host_terminal_theme(), !cfg!(windows));
    }

    #[test]
    fn terminal_restore_postlude_restores_visible_default_cursor() {
        let mut output = Vec::new();
        write_terminal_restore_postlude(&mut output).unwrap();
        assert_eq!(output, b"\x1b[?25h\x1b[0 q");
    }

    #[cfg(unix)]
    #[test]
    fn attach_escape_detaches_on_prefix_q() {
        let mut escape = AttachEscapeState::default();
        assert!(matches!(
            escape.filter_input(vec![0x02], 24, 3),
            AttachInputAction::None
        ));
        assert!(matches!(
            escape.filter_input(vec![b'q'], 24, 3),
            AttachInputAction::Detach
        ));
    }

    #[cfg(unix)]
    #[test]
    fn attach_escape_sends_literal_prefix_on_double_prefix() {
        let mut escape = AttachEscapeState::default();
        assert!(matches!(
            escape.filter_input(vec![0x02], 24, 3),
            AttachInputAction::None
        ));
        match escape.filter_input(vec![0x02], 24, 3) {
            AttachInputAction::Forward(bytes) => assert_eq!(bytes, vec![0x02]),
            other => panic!("expected forwarded prefix, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn attach_escape_forwards_prefix_before_non_escape_key() {
        let mut escape = AttachEscapeState::default();
        assert!(matches!(
            escape.filter_input(vec![b'a', 0x02], 24, 3),
            AttachInputAction::Forward(bytes) if bytes == b"a"
        ));
        match escape.filter_input(vec![b'x'], 24, 3) {
            AttachInputAction::Forward(bytes) => assert_eq!(bytes, vec![0x02, b'x']),
            other => panic!("expected forwarded bytes, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn attach_escape_turns_wheel_into_scroll_action() {
        let mut escape = AttachEscapeState::default();
        match escape.filter_input(b"\x1b[<64;11;6M".to_vec(), 24, 7) {
            AttachInputAction::Scroll {
                source,
                direction,
                lines,
                column,
                row,
                ..
            } => {
                assert_eq!(source, AttachScrollSource::Wheel);
                assert_eq!(direction, AttachScrollDirection::Up);
                assert_eq!(lines, 7);
                assert_eq!(column, Some(10));
                assert_eq!(row, Some(5));
            }
            other => panic!("expected scroll action, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn attach_escape_swallows_non_wheel_mouse_reports() {
        let mut escape = AttachEscapeState::default();
        assert!(matches!(
            escape.filter_input(b"\x1b[<0;11;6M".to_vec(), 24, 7),
            AttachInputAction::None
        ));
    }

    #[cfg(unix)]
    #[test]
    fn attach_escape_turns_plain_page_keys_into_scroll_actions() {
        let mut escape = AttachEscapeState::default();
        match escape.filter_input(b"\x1b[5~".to_vec(), 12, 3) {
            AttachInputAction::Scroll {
                source,
                direction,
                lines,
                ..
            } => {
                assert_eq!(
                    source,
                    AttachScrollSource::PageKey {
                        input: b"\x1b[5~".to_vec()
                    }
                );
                assert_eq!(direction, AttachScrollDirection::Up);
                assert_eq!(lines, 11);
            }
            other => panic!("expected page-up scroll action, got {other:?}"),
        }

        match escape.filter_input(b"\x1b[6~".to_vec(), 12, 3) {
            AttachInputAction::Scroll {
                source,
                direction,
                lines,
                ..
            } => {
                assert_eq!(
                    source,
                    AttachScrollSource::PageKey {
                        input: b"\x1b[6~".to_vec()
                    }
                );
                assert_eq!(direction, AttachScrollDirection::Down);
                assert_eq!(lines, 11);
            }
            other => panic!("expected page-down scroll action, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn attach_escape_forwards_modified_page_key() {
        let mut escape = AttachEscapeState::default();
        match escape.filter_input(b"\x1b[5;5~".to_vec(), 12, 3) {
            AttachInputAction::Forward(bytes) => assert_eq!(bytes, b"\x1b[5;5~"),
            other => panic!("expected modified page key to forward, got {other:?}"),
        }
    }

    #[test]
    fn client_error_display_connection_failed() {
        let err = ClientError::ConnectionFailed(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            "connection refused",
        ));
        let msg = err.to_string();
        assert!(
            msg.contains("failed to connect to server"),
            "should mention connection failure: {msg}"
        );
        assert!(
            msg.contains("herdr server"),
            "should suggest starting server: {msg}"
        );
    }

    #[test]
    fn client_error_display_handshake_rejected() {
        let err = ClientError::HandshakeRejected {
            version: 1,
            error: "incompatible".into(),
        };
        let msg = err.to_string();
        assert!(
            msg.contains("rejected handshake"),
            "should mention rejection: {msg}"
        );
        assert!(msg.contains("incompatible"), "should include error: {msg}");
    }

    #[test]
    fn client_error_display_server_shutdown() {
        let err = ClientError::ServerShutdown {
            reason: Some("maintenance".into()),
        };
        let msg = err.to_string();
        assert!(
            msg.contains("server shut down"),
            "should mention shutdown: {msg}"
        );
        assert!(msg.contains("maintenance"), "should include reason: {msg}");
    }

    #[test]
    fn client_error_display_server_shutdown_no_reason() {
        let err = ClientError::ServerShutdown { reason: None };
        let msg = err.to_string();
        assert!(
            msg.contains("server shut down"),
            "should mention shutdown: {msg}"
        );
    }

    #[test]
    fn client_error_display_detached_default_session_reattach_hint() {
        let _guard = env_lock().lock().unwrap();
        let _env = EnvVarsRemovedGuard::new(&[
            crate::remote::REATTACH_COMMAND_ENV_VAR,
            crate::session::SESSION_ENV_VAR,
        ]);
        let err = ClientError::ServerShutdown {
            reason: Some("detached".into()),
        };
        let msg = err.to_string();
        assert!(
            msg.contains("Run `herdr` to reattach"),
            "should suggest default reattach command: {msg}"
        );
    }

    #[test]
    fn client_error_display_detached_named_session_reattach_hint() {
        let _guard = env_lock().lock().unwrap();
        let _remote_env = EnvVarsRemovedGuard::new(&[crate::remote::REATTACH_COMMAND_ENV_VAR]);
        let _session_env = EnvVarGuard::set(crate::session::SESSION_ENV_VAR, "work");
        let err = ClientError::ServerShutdown {
            reason: Some("detached".into()),
        };
        let msg = err.to_string();
        assert!(
            msg.contains("Run `herdr session attach work` to reattach"),
            "should suggest named session reattach command: {msg}"
        );
    }

    #[test]
    fn client_error_display_detached_remote_reattach_hint_takes_precedence() {
        let _guard = env_lock().lock().unwrap();
        let _remote_env = EnvVarGuard::set(
            crate::remote::REATTACH_COMMAND_ENV_VAR,
            "herdr --remote host --session work",
        );
        let _session_env = EnvVarGuard::set(crate::session::SESSION_ENV_VAR, "work");
        let err = ClientError::ServerShutdown {
            reason: Some("detached".into()),
        };
        let msg = err.to_string();
        assert!(
            msg.contains("Run `herdr --remote host --session work` to reattach"),
            "should prefer remote reattach command: {msg}"
        );
    }

    #[test]
    fn client_error_display_connection_lost() {
        let err =
            ClientError::ConnectionLost(io::Error::new(io::ErrorKind::BrokenPipe, "broken pipe"));
        let msg = err.to_string();
        assert!(
            msg.contains("lost connection to server"),
            "should mention lost connection: {msg}"
        );
    }

    #[test]
    fn hello_message_uses_requested_surface_mode() {
        let hello = build_hello_message(
            80,
            24,
            0,
            0,
            RenderEncoding::SemanticFrame,
            ClientSurfaceMode::EmbeddedContent,
            ClientKeybindings::Server,
            ClientLaunchMode::App,
        );

        match hello {
            ClientMessage::Hello { surface_mode, .. } => {
                assert_eq!(surface_mode, ClientSurfaceMode::EmbeddedContent);
            }
            other => panic!("expected hello, got {other:?}"),
        }
    }

    #[test]
    fn sound_from_notify_message_maps_done() {
        assert_eq!(
            sound_from_notify_message("agent done"),
            Some(crate::sound::Sound::Done)
        );
    }

    #[test]
    fn sound_from_notify_message_maps_attention() {
        assert_eq!(
            sound_from_notify_message("agent attention"),
            Some(crate::sound::Sound::Request)
        );
    }

    #[test]
    fn sound_from_notify_message_rejects_unknown_payloads() {
        assert_eq!(sound_from_notify_message("toast"), None);
    }

    #[test]
    fn reload_local_client_config_refreshes_redraw_on_focus_gained() {
        let _guard = crate::config::test_config_env_lock().lock().unwrap();
        let path = std::env::temp_dir().join(format!(
            "herdr-client-config-reload-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, "[ui]\nredraw_on_focus_gained = false\n").unwrap();
        let path_string = path.to_string_lossy().to_string();
        let _env = EnvVarGuard::set(crate::config::CONFIG_PATH_ENV_VAR, &path_string);
        let mut sound_config = crate::config::SoundConfig::default();
        let mut redraw_on_focus_gained = true;

        reload_local_client_config(&mut sound_config, &mut redraw_on_focus_gained);

        assert!(!redraw_on_focus_gained);
        let _ = std::fs::remove_file(path);
    }

    #[derive(Default)]
    struct BootstrapApi {
        requests: Vec<&'static str>,
        remotes: Vec<crate::remote_registry::RemoteDefinitionSnapshot>,
    }

    impl supervisor::SupervisorApi for BootstrapApi {
        fn request(
            &mut self,
            request: crate::api::schema::Request,
        ) -> Result<crate::api::schema::SuccessResponse, String> {
            let result = match request.method {
                crate::api::schema::Method::RemoteList(_) => {
                    self.requests.push("remote.list");
                    crate::api::schema::ResponseResult::RemoteList {
                        remotes: self.remotes.clone(),
                    }
                }
                crate::api::schema::Method::WorkspaceList(_) => {
                    self.requests.push("workspace.list");
                    crate::api::schema::ResponseResult::WorkspaceList {
                        workspaces: Vec::new(),
                    }
                }
                crate::api::schema::Method::AgentList(_) => {
                    self.requests.push("agent.list");
                    crate::api::schema::ResponseResult::AgentList { agents: Vec::new() }
                }
                crate::api::schema::Method::ServerUiSettings(_) => {
                    self.requests.push("server.ui_settings");
                    crate::api::schema::ResponseResult::UiSettings {
                        settings: crate::api::schema::UiSettingsInfo::default(),
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

    #[derive(Default)]
    struct RemoteAddApi {
        captured: Option<crate::api::schema::RemoteAddParams>,
    }

    impl supervisor::SupervisorApi for RemoteAddApi {
        fn request(
            &mut self,
            request: crate::api::schema::Request,
        ) -> Result<crate::api::schema::SuccessResponse, String> {
            match request.method {
                crate::api::schema::Method::RemoteAdd(params) => {
                    self.captured = Some(params);
                    Ok(crate::api::schema::SuccessResponse {
                        id: request.id,
                        result: crate::api::schema::ResponseResult::RemoteAdded {
                            remote: crate::remote_registry::RemoteDefinitionSnapshot {
                                id: "remote-1".into(),
                                name: "dev".into(),
                                target: crate::remote_registry::RemoteTargetSnapshot::Local {
                                    session: Some("dev".into()),
                                },
                                session: None,
                                keybindings:
                                    crate::remote_registry::RemoteKeybindingsSnapshot::Local,
                                disabled: false,
                                auto_update: false,
                            },
                        },
                    })
                }
                other => Err(format!("unexpected method: {other:?}")),
            }
        }
    }

    #[test]
    fn submit_remote_add_to_main_api_builds_remote_add_request() {
        let mut api = RemoteAddApi::default();

        let remote = submit_remote_add_to_main_api(
            &mut api,
            supervisor::AddRemoteDraft {
                target: "local:dev".into(),
                name: Some("dev".into()),
                // C1: the form's session field must reach `remote.add` — this used to be a
                // hard-coded `None` placeholder, which silently dropped the user's input.
                session: Some("work".into()),
                keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            },
        )
        .unwrap();

        assert_eq!(remote.id, "remote-1");
        assert_eq!(
            api.captured,
            Some(crate::api::schema::RemoteAddParams {
                name: Some("dev".into()),
                target: "local:dev".into(),
                session: Some("work".into()),
                keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            })
        );

        // …and an empty session field (draft `None`) still means the remote's default session.
        let mut api = RemoteAddApi::default();
        submit_remote_add_to_main_api(
            &mut api,
            supervisor::AddRemoteDraft {
                target: "local:dev".into(),
                name: Some("dev".into()),
                session: None,
                keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            },
        )
        .unwrap();
        assert_eq!(api.captured.and_then(|params| params.session), None);
    }

    #[test]
    fn add_remote_error_message_maps_registry_duplicates_for_modal() {
        assert_eq!(
            add_remote_error_message("remote target already exists"),
            "remote already added"
        );
        assert_eq!(
            add_remote_error_message("remote name already exists"),
            "name already used"
        );
        // An error that matches no bridge-failure heuristic passes through verbatim.
        assert_eq!(
            add_remote_error_message("some unmapped failure"),
            "some unmapped failure"
        );
    }

    #[test]
    fn add_remote_target_rejects_active_local_session_as_duplicate_main() {
        let _guard = env_lock().lock().unwrap();
        let _session_env = EnvVarGuard::set(crate::session::SESSION_ENV_VAR, "dev");
        let _remote_env = EnvVarsRemovedGuard::new(&[crate::remote::MAIN_REMOTE_TARGET_ENV_VAR]);

        let target = crate::remote_registry::RemoteTargetSnapshot::Local {
            session: Some("dev".into()),
        };

        assert_eq!(
            reject_duplicate_main_target(&target),
            Err("remote already added".to_string())
        );
    }

    /// C1 regression harness: a draft with just a target + optional session.
    fn session_draft(target: &str, session: Option<&str>) -> supervisor::AddRemoteDraft {
        supervisor::AddRemoteDraft {
            target: target.into(),
            name: None,
            session: session.map(str::to_string),
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
        }
    }

    #[test]
    fn add_remote_preflight_accepts_a_local_target_pinned_to_another_session() {
        // RED before the fold moved into the shared helper: the pre-flight compared the UNFOLDED
        // `localhost` (= `local:default`) against this client's own default-session main server and
        // rejected the add with "remote already added", so `remote.add` was never sent and the
        // registry stayed empty. `localhost` + session `work` IS `local:work` — a different host.
        let _guard = env_lock().lock().unwrap();
        let _session_env = EnvVarsRemovedGuard::new(&[crate::session::SESSION_ENV_VAR]);
        let _remote_env = EnvVarsRemovedGuard::new(&[crate::remote::MAIN_REMOTE_TARGET_ENV_VAR]);

        assert_eq!(
            preflight_add_remote_target(&session_draft("localhost", Some("work"))),
            Ok(crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("work".into())
            })
        );
    }

    #[test]
    fn add_remote_preflight_still_rejects_a_local_target_on_the_main_session() {
        // The duplicate rule this slice must NOT weaken: same target, no session => still the main
        // server, still rejected.
        let _guard = env_lock().lock().unwrap();
        let _session_env = EnvVarsRemovedGuard::new(&[crate::session::SESSION_ENV_VAR]);
        let _remote_env = EnvVarsRemovedGuard::new(&[crate::remote::MAIN_REMOTE_TARGET_ENV_VAR]);

        assert_eq!(
            preflight_add_remote_target(&session_draft("localhost", None)),
            Err("remote already added".to_string())
        );
        // …and an explicit "default"/blank session normalizes to the same verdict.
        assert_eq!(
            preflight_add_remote_target(&session_draft("localhost", Some("default"))),
            Err("remote already added".to_string())
        );
        assert_eq!(
            preflight_add_remote_target(&session_draft("localhost", Some("   "))),
            Err("remote already added".to_string())
        );
    }

    #[test]
    fn add_remote_preflight_accepts_a_session_spelled_into_the_local_target() {
        // `local:work` with no session field keeps working (that spelling IS the session).
        let _guard = env_lock().lock().unwrap();
        let _session_env = EnvVarsRemovedGuard::new(&[crate::session::SESSION_ENV_VAR]);
        let _remote_env = EnvVarsRemovedGuard::new(&[crate::remote::MAIN_REMOTE_TARGET_ENV_VAR]);

        assert_eq!(
            preflight_add_remote_target(&session_draft("local:work", None)),
            Ok(crate::remote_registry::RemoteTargetSnapshot::Local {
                session: Some("work".into())
            })
        );
    }

    #[test]
    fn add_remote_preflight_leaves_ssh_targets_untouched_by_the_session() {
        // An ssh remote's session rides the DEFINITION, never the target — so the dedup key (and
        // therefore this verdict) must be identical with and without a session.
        let _guard = env_lock().lock().unwrap();
        let _session_env = EnvVarsRemovedGuard::new(&[crate::session::SESSION_ENV_VAR]);
        let _remote_env = EnvVarsRemovedGuard::new(&[crate::remote::MAIN_REMOTE_TARGET_ENV_VAR]);

        let expected = crate::remote_registry::RemoteTargetSnapshot::Ssh {
            target: "user@dev".into(),
            args: Vec::new(),
        };
        assert_eq!(
            preflight_add_remote_target(&session_draft("user@dev", Some("work"))),
            Ok(expected.clone())
        );
        assert_eq!(
            preflight_add_remote_target(&session_draft("user@dev", None)),
            Ok(expected)
        );
    }

    #[test]
    fn add_remote_preflight_rejects_an_invalid_session_name_before_the_api() {
        // The same message the server's `invalid_session_name` error carries, surfaced without a
        // round-trip (and never as a silent success).
        let _guard = env_lock().lock().unwrap();
        let _session_env = EnvVarsRemovedGuard::new(&[crate::session::SESSION_ENV_VAR]);
        let _remote_env = EnvVarsRemovedGuard::new(&[crate::remote::MAIN_REMOTE_TARGET_ENV_VAR]);

        assert_eq!(
            preflight_add_remote_target(&session_draft("user@dev", Some("bad name!"))),
            Err("session name is invalid".to_string())
        );
        assert_eq!(
            preflight_add_remote_target(&session_draft("localhost", Some(".."))),
            Err("session name is invalid".to_string())
        );
    }

    #[test]
    fn add_remote_target_rejects_main_remote_target_from_launch_env() {
        let _guard = env_lock().lock().unwrap();
        let _remote_env = EnvVarGuard::set(crate::remote::MAIN_REMOTE_TARGET_ENV_VAR, "iq-64");

        let target = crate::remote_registry::RemoteTargetSnapshot::Ssh {
            target: "iq-64".into(),
            args: Vec::new(),
        };

        assert_eq!(
            reject_duplicate_main_target(&target),
            Err("remote already added".to_string())
        );
    }

    #[test]
    fn summary_refresh_subscription_request_covers_sidebar_summary_events() {
        let request = summary_refresh_subscription_request("client:summary-events");

        assert_eq!(request.id, "client:summary-events");
        let crate::api::schema::Method::EventsSubscribe(params) = request.method else {
            panic!("expected events.subscribe request");
        };
        assert_eq!(
            params.subscriptions,
            vec![
                crate::api::schema::Subscription::WorkspaceCreated {},
                crate::api::schema::Subscription::WorkspaceUpdated {},
                crate::api::schema::Subscription::WorkspaceRenamed {},
                crate::api::schema::Subscription::WorkspaceClosed {},
                crate::api::schema::Subscription::WorkspaceFocused {},
                crate::api::schema::Subscription::TabCreated {},
                crate::api::schema::Subscription::TabClosed {},
                crate::api::schema::Subscription::TabFocused {},
                crate::api::schema::Subscription::TabRenamed {},
                crate::api::schema::Subscription::PaneCreated {},
                crate::api::schema::Subscription::PaneClosed {},
                crate::api::schema::Subscription::PaneFocused {},
                crate::api::schema::Subscription::PaneExited {},
                crate::api::schema::Subscription::PaneAgentDetected {},
                crate::api::schema::Subscription::PaneAgentStatusChanged {
                    pane_id: None,
                    agent_status: None,
                },
            ]
        );
    }

    #[test]
    fn full_app_client_bootstrap_is_paint_first_without_blocking_api_calls() {
        // #42: cold-start must paint immediately. The bootstrap builds a minimal main-only model
        // with ZERO blocking round-trips; the registry/summary/ui-settings hydrate off the UI
        // thread via the one-shot `MainSupervisorBootstrapped` worker started in `run_client_loop`.
        let mut api = BootstrapApi::default();

        let model = bootstrap_supervisor_for_client(false, &mut api)
            .unwrap()
            .expect("full app client should bootstrap a minimal supervisor model");

        assert!(
            api.requests.is_empty(),
            "paint-first bootstrap must not block on any API round-trip, got {:?}",
            api.requests
        );
        assert!(model.secondary_connection_plans().is_empty());
        // the client-owned global menu (add remote / manage remotes) is available immediately,
        // even before the registry hydrates — guards the old degrade-to-empty-registry behaviour.
        assert!(model.client_global_menu_items().contains(&"add remote"));
        assert!(model.client_global_menu_items().contains(&"manage remotes"));
    }

    #[test]
    fn remote_launch_display_name_labels_main_filter() {
        let _guard = env_lock().lock().unwrap();
        let _display_env = EnvVarGuard::set(crate::remote::MAIN_DISPLAY_NAME_ENV_VAR, "iq-64");
        let mut api = BootstrapApi::default();

        let mut model = bootstrap_supervisor_for_client(false, &mut api)
            .unwrap()
            .expect("remote client should bootstrap supervisor");
        model.cycle_filter();

        assert_eq!(model.filter_label(), "iq-64");
    }

    #[test]
    fn client_bootstrap_defers_registry_and_secondaries_to_async_hydrate() {
        // #42: even with remotes registered on the server, the paint-first bootstrap pulls nothing
        // synchronously — the registry (and thus the secondary connection plans) arrive only once
        // the off-loop `MainSupervisorBootstrapped` worker applies the fully-hydrated model.
        let mut api = BootstrapApi {
            remotes: vec![test_remote_definition("remote-dev", "dev")],
            ..BootstrapApi::default()
        };

        let model = bootstrap_client_supervisor_model(false, &mut api)
            .unwrap()
            .expect("full app client should bootstrap a minimal supervisor model");

        assert!(
            api.requests.is_empty(),
            "paint-first bootstrap must not block on any API round-trip, got {:?}",
            api.requests
        );
        assert!(model.secondary_connection_plans().is_empty());
    }

    #[test]
    fn direct_attach_client_skips_supervisor_bootstrap() {
        let mut api = BootstrapApi::default();

        let model = bootstrap_supervisor_for_client(true, &mut api).unwrap();

        assert!(model.is_none());
        assert!(api.requests.is_empty());
    }

    #[test]
    fn client_render_plan_uses_embedded_content_when_supervisor_is_available() {
        let model = supervisor::ClientSupervisorModel::new("local");

        let plan = client_render_plan(Some(&model), RenderEncoding::TerminalAnsi, (80, 24));

        assert_eq!(plan.surface_mode, ClientSurfaceMode::EmbeddedContent);
        assert_eq!(plan.requested_encoding, RenderEncoding::SemanticFrame);
        assert_eq!(
            plan.server_size,
            (80 - compositor::DEFAULT_SIDEBAR_WIDTH, 24)
        );
        assert!(plan.use_client_compositor);
    }

    #[test]
    fn client_render_plan_uses_full_app_when_supervisor_is_unavailable() {
        let plan = client_render_plan(None, RenderEncoding::TerminalAnsi, (80, 24));

        assert_eq!(plan.surface_mode, ClientSurfaceMode::FullApp);
        assert_eq!(plan.requested_encoding, RenderEncoding::TerminalAnsi);
        assert_eq!(plan.server_size, (80, 24));
        assert!(!plan.use_client_compositor);
    }

    #[test]
    fn client_render_plan_uses_embedded_content_with_secondary_servers() {
        let mut model = supervisor::ClientSupervisorModel::new("local");
        model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
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

        let plan = client_render_plan(Some(&model), RenderEncoding::TerminalAnsi, (80, 24));

        assert_eq!(plan.surface_mode, ClientSurfaceMode::EmbeddedContent);
        assert_eq!(plan.requested_encoding, RenderEncoding::SemanticFrame);
        assert_eq!(
            plan.server_size,
            (80 - compositor::DEFAULT_SIDEBAR_WIDTH, 24)
        );
        assert!(plan.use_client_compositor);
    }

    fn mixed_remote_model() -> (supervisor::ClientSupervisorModel, supervisor::ServerId) {
        let mut model = supervisor::ClientSupervisorModel::new("local");
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
                &supervisor::ServerId::main(),
                supervisor::ServerSummary {
                    workspaces: vec![supervisor::WorkspaceSummary {
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
                supervisor::ServerSummary {
                    workspaces: vec![supervisor::WorkspaceSummary {
                        workspace_id: "remote-api".into(),
                        label: "api".into(),
                        branch: Some("feature/api".into()),
                        focused: false,
                        ..Default::default()
                    }],
                    agents: vec![supervisor::AgentSummary {
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

    // ----- #23: workspace context menu mouse round-trips ----------------------------------------

    fn down(button: MouseButton, row: u16) -> MouseEvent {
        MouseEvent {
            kind: MouseEventKind::Down(button),
            column: 1,
            row,
            modifiers: KeyModifiers::empty(),
        }
    }

    #[test]
    fn workspace_card_right_click_opens_context_menu() {
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let row = (0..host.1)
            .find(|row| {
                matches!(
                    compositor.hit_test(&model, 1, *row, host.0, host.1),
                    Some(compositor::SidebarHitTarget::Workspace { server_id, workspace_id })
                        if server_id == remote_id && workspace_id == "remote-api"
                )
            })
            .expect("remote workspace card row");

        let dispatch = dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &down(MouseButton::Right, row),
        );
        assert!(matches!(dispatch, ClientInputDispatch::Redraw));
        let menu = model
            .client_menu()
            .expect("right-click opened the context menu");
        assert_eq!(
            menu.kind,
            supervisor::ClientMenuKind::Workspace {
                server_id: remote_id.clone(),
                workspace_id: "remote-api".into(),
                label: "api".into(),
            },
            "captured the target + current label"
        );
    }

    #[test]
    fn open_context_menu_dismisses_on_outside_press() {
        // #46 (item 6): with a context menu open, a press that misses every row dismisses it and is
        // consumed. The old code had NO outside-click dismiss — the menu stayed open, and a press in
        // the content area even leaked through to the pane beneath.
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let row = (0..host.1)
            .find(|row| {
                matches!(
                    compositor.hit_test(&model, 1, *row, host.0, host.1),
                    Some(compositor::SidebarHitTarget::Workspace { server_id, workspace_id })
                        if server_id == remote_id && workspace_id == "remote-api"
                )
            })
            .expect("remote workspace card row");
        dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &down(MouseButton::Right, row),
        );
        assert!(model.client_menu().is_some(), "right-click opened the menu");

        // The far-right column is outside the 34-wide cursor-anchored popup, so `hit_test` is `None`
        // there while the menu is open — a genuine outside-click.
        let outside_col = host.0 - 1;
        assert!(
            compositor
                .hit_test(&model, outside_col, row, host.0, host.1)
                .is_none(),
            "the chosen point must be outside the open menu"
        );
        let press_outside = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: outside_col,
            row,
            modifiers: KeyModifiers::empty(),
        };
        let dispatch = dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &press_outside,
        );
        assert!(matches!(dispatch, ClientInputDispatch::Redraw));
        assert!(
            model.client_menu().is_none(),
            "an outside press dismissed the menu"
        );
    }

    // #71: with the sidebar COLLAPSED (mini strip), a content click must translate against the
    // collapse-aware origin (mini width), not the resting expanded width — the old gates consumed
    // clicks in the (mini..expanded) gap as "sidebar" and forwarded the rest offset left by
    // (expanded − mini) columns.
    #[test]
    fn collapsed_content_click_forwards_with_mini_origin() {
        let (mut model, _remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        compositor.toggle_sidebar_collapsed();
        while compositor.sidebar_width_animating() {
            compositor.step_sidebar_width_animation();
        }
        let mini = compositor.effective_sidebar_width(host.0);
        assert!(mini < 26, "collapse must settle below the resting width");

        // A click between the mini strip and the old expanded edge is CONTENT, not sidebar.
        let click = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 10,
            row: 5,
            modifiers: KeyModifiers::empty(),
        };
        let dispatch =
            dispatch_composited_mouse_input(Vec::new(), &mut compositor, &mut model, host, &click);
        let expected = crate::input::encode_mouse_button(
            click.kind,
            click.column - mini,
            click.row,
            click.modifiers,
            crate::input::MouseProtocolEncoding::Sgr,
        )
        .expect("sgr encoding for a left press");
        match dispatch {
            ClientInputDispatch::Forward(bytes) => assert_eq!(
                bytes, expected,
                "collapsed content click must forward translated by the MINI origin"
            ),
            other => panic!("collapsed content click must forward, got {other:?}"),
        }

        // Expanded behavior is unchanged: the same flow translates by the resting width again.
        compositor.toggle_sidebar_collapsed();
        while compositor.sidebar_width_animating() {
            compositor.step_sidebar_width_animation();
        }
        let expanded = compositor.effective_sidebar_width(host.0);
        assert_eq!(expanded, 26);
        let click = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 30,
            row: 5,
            modifiers: KeyModifiers::empty(),
        };
        let dispatch =
            dispatch_composited_mouse_input(Vec::new(), &mut compositor, &mut model, host, &click);
        let expected = crate::input::encode_mouse_button(
            click.kind,
            click.column - expanded,
            click.row,
            click.modifiers,
            crate::input::MouseProtocolEncoding::Sgr,
        )
        .expect("sgr encoding for a left press");
        match dispatch {
            ClientInputDispatch::Forward(bytes) => assert_eq!(bytes, expected),
            other => panic!("expanded content click must forward, got {other:?}"),
        }
    }

    #[test]
    fn open_context_menu_hover_tracks_highlight() {
        // #46 (item 5): motion over a menu row moves the highlight. The sidebar hover path never
        // knew about the open menu, so hovering the menu used to highlight NOTHING on it.
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let row = (0..host.1)
            .find(|row| {
                matches!(
                    compositor.hit_test(&model, 1, *row, host.0, host.1),
                    Some(compositor::SidebarHitTarget::Workspace { server_id, workspace_id })
                        if server_id == remote_id && workspace_id == "remote-api"
                )
            })
            .expect("remote workspace card row");
        dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &down(MouseButton::Right, row),
        );
        assert_eq!(
            model.client_menu().unwrap().selected,
            0,
            "menu opens on the first row"
        );

        // Find the painted rect of menu row index 1 and move the cursor onto it.
        let (col, hover_row) = (0..host.0)
            .flat_map(|c| (0..host.1).map(move |r| (c, r)))
            .find(|&(c, r)| {
                matches!(
                    compositor.hit_test(&model, c, r, host.0, host.1),
                    Some(compositor::SidebarHitTarget::ClientMenuRow { index: 1 })
                )
            })
            .expect("menu row 1 position");
        let moved = MouseEvent {
            kind: MouseEventKind::Moved,
            column: col,
            row: hover_row,
            modifiers: KeyModifiers::empty(),
        };
        let dispatch =
            dispatch_composited_mouse_input(Vec::new(), &mut compositor, &mut model, host, &moved);
        // #56: a menu-selection move is presentation-only — HoverRedraw (recompose from the cached
        // hover-less shell + overlay the selected row), not the shell-rebuilding Redraw it once was.
        assert!(matches!(dispatch, ClientInputDispatch::HoverRedraw));
        assert_eq!(
            model.client_menu().unwrap().selected,
            1,
            "hover moved the highlight to row 1"
        );
    }

    #[test]
    fn context_menu_rename_then_submit_yields_workspace_rename_request() {
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let row = (0..host.1)
            .find(|row| {
                matches!(
                    compositor.hit_test(&model, 1, *row, host.0, host.1),
                    Some(compositor::SidebarHitTarget::Workspace { server_id, workspace_id })
                        if server_id == remote_id && workspace_id == "remote-api"
                )
            })
            .expect("remote workspace card row");
        dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &down(MouseButton::Right, row),
        );

        // click the "rename" row (index 0) -> rename overlay opens prefilled.
        let rename_hit = dispatch_sidebar_hit_target(
            compositor::SidebarHitTarget::ClientMenuRow { index: 0 },
            &mut model,
            &down(MouseButton::Left, 1),
        );
        assert!(matches!(rename_hit, ClientInputDispatch::Redraw));
        assert!(model.rename_workspace_form().is_some());

        // submit via the button -> workspace.rename ApiRequest to the OWNING server.
        let submit = dispatch_sidebar_hit_target(
            compositor::SidebarHitTarget::RenameWorkspaceSubmit,
            &mut model,
            &down(MouseButton::Left, 1),
        );
        match submit {
            ClientInputDispatch::ApiRequest {
                server_id,
                request,
                refresh,
            } => {
                assert_eq!(server_id, remote_id);
                assert_eq!(refresh, ClientApiRefreshPolicy::Immediate);
                match request.method {
                    crate::api::schema::Method::WorkspaceRename(params) => {
                        assert_eq!(params.workspace_id, "remote-api");
                        assert_eq!(params.label, "api");
                    }
                    other => panic!("expected WorkspaceRename, got {other:?}"),
                }
            }
            other => panic!("expected ApiRequest, got {other:?}"),
        }
    }

    #[test]
    fn context_menu_close_confirm_yields_workspace_close_request() {
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let row = (0..host.1)
            .find(|row| {
                matches!(
                    compositor.hit_test(&model, 1, *row, host.0, host.1),
                    Some(compositor::SidebarHitTarget::Workspace { server_id, workspace_id })
                        if server_id == remote_id && workspace_id == "remote-api"
                )
            })
            .expect("remote workspace card row");
        dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &down(MouseButton::Right, row),
        );

        // click the "close" row (index 1) -> confirm overlay opens.
        dispatch_sidebar_hit_target(
            compositor::SidebarHitTarget::ClientMenuRow { index: 1 },
            &mut model,
            &down(MouseButton::Left, 1),
        );
        assert!(model.confirm_close_workspace().is_some());

        // confirm -> workspace.close ApiRequest to the OWNING server.
        let confirm = dispatch_sidebar_hit_target(
            compositor::SidebarHitTarget::ConfirmCloseWorkspaceConfirm,
            &mut model,
            &down(MouseButton::Left, 1),
        );
        match confirm {
            ClientInputDispatch::ApiRequest {
                server_id,
                request,
                refresh,
            } => {
                assert_eq!(server_id, remote_id);
                assert_eq!(refresh, ClientApiRefreshPolicy::Immediate);
                match request.method {
                    crate::api::schema::Method::WorkspaceClose(target) => {
                        assert_eq!(target.workspace_id, "remote-api");
                    }
                    other => panic!("expected WorkspaceClose, got {other:?}"),
                }
            }
            other => panic!("expected ApiRequest, got {other:?}"),
        }
    }

    #[test]
    fn context_menu_close_cancel_dismisses_without_request() {
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let row = (0..host.1)
            .find(|row| {
                matches!(
                    compositor.hit_test(&model, 1, *row, host.0, host.1),
                    Some(compositor::SidebarHitTarget::Workspace { server_id, workspace_id })
                        if server_id == remote_id && workspace_id == "remote-api"
                )
            })
            .expect("remote workspace card row");
        dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &down(MouseButton::Right, row),
        );
        dispatch_sidebar_hit_target(
            compositor::SidebarHitTarget::ClientMenuRow { index: 1 },
            &mut model,
            &down(MouseButton::Left, 1),
        );
        let cancel = dispatch_sidebar_hit_target(
            compositor::SidebarHitTarget::ConfirmCloseWorkspaceCancel,
            &mut model,
            &down(MouseButton::Left, 1),
        );
        assert!(matches!(cancel, ClientInputDispatch::Redraw));
        assert!(model.confirm_close_workspace().is_none());
    }

    // ----- #43: host context menu dispatch ------------------------------------------------------

    /// Find the visible banner row for `remote_id` by scanning hit_test for its `HostBanner`.
    fn host_banner_row(
        compositor: &compositor::ClientCompositor,
        model: &supervisor::ClientSupervisorModel,
        remote_id: &supervisor::ServerId,
        host: (u16, u16),
    ) -> u16 {
        (0..host.1)
            .find(|row| {
                matches!(
                    compositor.hit_test(model, 1, *row, host.0, host.1),
                    Some(compositor::SidebarHitTarget::HostBanner { server_id })
                        if server_id == *remote_id
                )
            })
            .expect("remote host banner row")
    }

    #[test]
    fn host_menu_add_space_yields_workspace_create_on_that_host() {
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let row = host_banner_row(&compositor, &model, &remote_id, host);

        // Right-click the banner opens the host menu anchored at that row.
        let opened = dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &down(MouseButton::Right, row),
        );
        assert!(matches!(opened, ClientInputDispatch::Redraw));
        assert!(model.client_menu().is_some());

        // #44/C3: click "add new space" (row 2, after the version + session readouts) ->
        // WorkspaceCreate ApiRequest on that host; overlay closes.
        let dispatch = dispatch_sidebar_hit_target(
            compositor::SidebarHitTarget::ClientMenuRow { index: 2 },
            &mut model,
            &down(MouseButton::Left, 1),
        );
        match dispatch {
            ClientInputDispatch::ApiRequest {
                server_id,
                request,
                refresh,
            } => {
                assert_eq!(server_id, remote_id);
                assert_eq!(refresh, ClientApiRefreshPolicy::Immediate);
                assert!(matches!(
                    request.method,
                    crate::api::schema::Method::WorkspaceCreate(_)
                ));
            }
            other => panic!("expected WorkspaceCreate ApiRequest, got {other:?}"),
        }
        assert!(model.client_menu().is_none(), "overlay closed");
    }

    #[test]
    fn host_menu_toggle_yields_set_remote_enabled() {
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let row = host_banner_row(&compositor, &model, &remote_id, host);
        dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &down(MouseButton::Right, row),
        );

        // #44/C3: click "disable" (row 3) -> SetRemoteEnabled{ registry_id, enabled:false };
        // overlay closes.
        let dispatch = dispatch_sidebar_hit_target(
            compositor::SidebarHitTarget::ClientMenuRow { index: 3 },
            &mut model,
            &down(MouseButton::Left, 1),
        );
        match dispatch {
            ClientInputDispatch::SetRemoteEnabled { remote_id, enabled } => {
                assert_eq!(remote_id, "remote-x", "addresses the registry id");
                assert!(!enabled, "an enabled host disables");
            }
            other => panic!("expected SetRemoteEnabled, got {other:?}"),
        }
        assert!(model.client_menu().is_none(), "overlay closed");
    }

    #[test]
    fn host_menu_disconnect_yields_disconnect_dispatch_not_disable() {
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let row = host_banner_row(&compositor, &model, &remote_id, host);
        dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &down(MouseButton::Right, row),
        );

        // #44/C3: click "disconnect" (row 4) -> DisconnectRemote{server_id}, NOT SetRemoteEnabled
        // (so it drops the live stream WITHOUT disabling the registry entry); overlay closes.
        let dispatch = dispatch_sidebar_hit_target(
            compositor::SidebarHitTarget::ClientMenuRow { index: 4 },
            &mut model,
            &down(MouseButton::Left, 1),
        );
        assert!(
            !matches!(dispatch, ClientInputDispatch::SetRemoteEnabled { .. }),
            "disconnect must not disable the remote: {dispatch:?}"
        );
        match dispatch {
            ClientInputDispatch::DisconnectRemote { server_id } => {
                assert_eq!(server_id, remote_id);
            }
            other => panic!("expected DisconnectRemote, got {other:?}"),
        }
        assert!(model.client_menu().is_none(), "overlay closed");
    }

    /// C4/C5/C6: open the host menu on the remote and drive its session row. Returns the model +
    /// compositor + host size so a test can keep clicking through the follow-on overlays.
    fn host_menu_open_on_remote() -> (
        supervisor::ClientSupervisorModel,
        compositor::ClientCompositor,
        supervisor::ServerId,
        (u16, u16),
    ) {
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let row = host_banner_row(&compositor, &model, &remote_id, host);
        dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &down(MouseButton::Right, row),
        );
        assert!(model.client_menu().is_some(), "host menu open");
        (model, compositor, remote_id, host)
    }

    /// The screen row of client-menu row `index`, resolved through the SAME hit_test the renderer's
    /// geometry feeds — so a synthesized press lands where the row is painted.
    fn client_menu_row_screen_row(
        compositor: &compositor::ClientCompositor,
        model: &supervisor::ClientSupervisorModel,
        host: (u16, u16),
        index: usize,
    ) -> (u16, u16) {
        for y in 0..host.1 {
            for x in 0..host.0 {
                if matches!(
                    compositor.hit_test(model, x, y, host.0, host.1),
                    Some(compositor::SidebarHitTarget::ClientMenuRow { index: hit }) if hit == index
                ) {
                    return (x, y);
                }
            }
        }
        panic!("client menu row {index} is not on screen");
    }

    #[test]
    fn right_click_activates_the_session_row_but_dismisses_on_any_other() {
        // C4 literal wording ("해당 세션 이름에서 우클릭하면 현재 세션 리스트 출력"): the session
        // readout is the ONE row a right-click activates instead of dismissing the menu.
        let (mut model, mut compositor, _remote_id, host) = host_menu_open_on_remote();
        let (col, row) = client_menu_row_screen_row(&compositor, &model, host, 1);
        let dispatch = dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Right),
                column: col,
                row,
                modifiers: KeyModifiers::empty(),
            },
        );
        assert!(
            matches!(dispatch, ClientInputDispatch::FetchSessionList { .. }),
            "a right-click on the session row opens the picker: {dispatch:?}"
        );
        assert!(model.session_picker().is_some(), "picker replaced the menu");

        // Every OTHER row keeps today's dismiss-on-right-click behaviour.
        let (mut model, mut compositor, _remote_id, host) = host_menu_open_on_remote();
        let (col, row) = client_menu_row_screen_row(&compositor, &model, host, 2);
        let dispatch = dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Right),
                column: col,
                row,
                modifiers: KeyModifiers::empty(),
            },
        );
        assert!(matches!(dispatch, ClientInputDispatch::Redraw));
        assert!(model.client_menu().is_none(), "the menu was dismissed");
        assert!(model.session_picker().is_none());
    }

    #[test]
    fn clicking_a_session_picker_row_switches_the_session() {
        // C5: a click on a listed row resolves through hit_test to `SessionPickerRow` and yields the
        // `remote.set_session` dispatch — the same one Enter produces.
        let (mut model, mut compositor, remote_id, host) = host_menu_open_on_remote();
        dispatch_sidebar_hit_target(
            compositor::SidebarHitTarget::ClientMenuRow { index: 1 },
            &mut model,
            &down(MouseButton::Left, 1),
        );
        model.fill_session_picker(
            &remote_id,
            Ok(vec![
                supervisor::SessionPickerItem {
                    name: None,
                    label: "default".into(),
                    running: true,
                    is_current: false,
                },
                supervisor::SessionPickerItem {
                    name: Some("work".into()),
                    label: "work".into(),
                    running: false,
                    is_current: false,
                },
            ]),
        );

        // Row 1 ("work") is hittable at the position the renderer paints it.
        let mut hit = None;
        'outer: for y in 0..host.1 {
            for x in 0..host.0 {
                if let Some(compositor::SidebarHitTarget::SessionPickerRow { index: 1 }) =
                    compositor.hit_test(&model, x, y, host.0, host.1)
                {
                    hit = Some((x, y));
                    break 'outer;
                }
            }
        }
        let (col, row) = hit.expect("session picker row 1 is on screen");
        let dispatch = dispatch_composited_mouse_input(
            Vec::new(),
            &mut compositor,
            &mut model,
            host,
            &MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: col,
                row,
                modifiers: KeyModifiers::empty(),
            },
        );
        match dispatch {
            ClientInputDispatch::SetRemoteSession {
                server_id,
                remote_id: registry_id,
                session,
            } => {
                assert_eq!(server_id, remote_id);
                assert_eq!(registry_id, "remote-x");
                assert_eq!(session.as_deref(), Some("work"));
            }
            other => panic!("expected SetRemoteSession, got {other:?}"),
        }
    }

    #[test]
    fn set_remote_session_rebuilds_the_bridge_instead_of_parking_the_host() {
        // C4/C6: the session is part of the connection identity, so a successful `remote.set_session`
        // must tear the stream down AND schedule an immediate reconnect — never leave the host in
        // `manually_disconnected` (which is what a plain Disconnect does).
        let (model, remote_id) = mixed_remote_model();
        let mut state = test_client_state_with_model(model);
        let mut server_writes: HashMap<supervisor::ServerId, ServerWriteHandle> = HashMap::new();
        let (event_tx, _event_rx) = tokio::sync::mpsc::channel(8);
        state.manually_disconnected.insert(remote_id.clone());

        apply_remote_manage_request_finished(
            &mut state,
            &mut server_writes,
            RemoteManageAction::SetSession {
                session: Some("work".into()),
            },
            "remote-x",
            Ok(()),
            &event_tx,
        );

        assert!(
            !state.manually_disconnected.contains(&remote_id),
            "a session switch must not park the host down"
        );
        assert!(
            state.secondary_retries.contains_key(&remote_id),
            "an immediate reconnect is scheduled so the bridge is rebuilt with the new --session"
        );
        let server = state
            .supervisor_model
            .as_ref()
            .unwrap()
            .server_for_test(&remote_id)
            .unwrap();
        assert_eq!(
            server.connection_state,
            supervisor::ConnectionState::Connecting
        );
    }

    #[test]
    fn update_remote_finished_clears_progress_and_reconnects() {
        let (model, remote_id) = mixed_remote_model();
        let mut state = test_client_state_with_model(model);
        let mut server_writes: HashMap<supervisor::ServerId, ServerWriteHandle> = HashMap::new();
        let now = Instant::now();

        // Seed an in-flight update: progress line set, and a manually-disconnected mark that the
        // successful finish must clear so the reconnect actually sweeps it back up.
        if let Some(model) = &mut state.supervisor_model {
            model.set_update_progress(&remote_id, Some("installing herdr on the remote…".into()));
        }
        state.manually_disconnected.insert(remote_id.clone());
        state.pending_update_remote.insert(remote_id.clone());

        // Ok: clears progress, drops the manual-disconnect mark, schedules an immediate reconnect.
        apply_update_remote_finished(&mut state, &mut server_writes, &remote_id, Ok(()), now);
        assert_eq!(
            state
                .supervisor_model
                .as_ref()
                .unwrap()
                .update_progress_for(&remote_id),
            None,
            "Ok finish clears the host's update progress line"
        );
        assert!(
            !state.manually_disconnected.contains(&remote_id),
            "Ok finish clears the manual-disconnect mark so the retry can reconnect"
        );
        let retry = state
            .secondary_retries
            .get(&remote_id)
            .expect("Ok finish schedules a reconnect");
        assert_eq!(
            retry.attempt, 0,
            "reconnect is scheduled at attempt 0 (shortest backoff)"
        );
        assert!(
            retry.next_retry_at <= now + secondary_retry_delay(0),
            "reconnect is scheduled at the attempt-0 (shortest) backoff"
        );
        // #61: Ok finish posts a positive, observable "done" outcome and arms its display timer (so
        // completion is no longer inferred from the spinner merely vanishing).
        let outcome = state
            .supervisor_model
            .as_ref()
            .unwrap()
            .update_outcome_for(&remote_id)
            .expect("Ok finish shows a success outcome");
        assert!(outcome.success);
        assert_eq!(outcome.message, "✓ update complete");
        assert!(
            state.update_outcome_expiry.contains_key(&remote_id),
            "Ok finish arms the outcome display timer"
        );
        assert!(
            !state.auto_update_suppressed.contains(&remote_id),
            "Ok finish leaves no auto-update suppression"
        );

        // Err: clears the spinner but leaves a truthful message; no reconnect scheduled, no download.
        let (model2, remote2) = mixed_remote_model();
        let mut state2 = test_client_state_with_model(model2);
        let mut server_writes2: HashMap<supervisor::ServerId, ServerWriteHandle> = HashMap::new();
        if let Some(model) = &mut state2.supervisor_model {
            model.set_update_progress(&remote2, Some("starting update…".into()));
        }
        apply_update_remote_finished(
            &mut state2,
            &mut server_writes2,
            &remote2,
            Err(
                "this herdr build has no binary for linux-aarch64; build/seed it instead of \
                 downloading"
                    .to_string(),
            ),
            now,
        );
        // #61: the failure now surfaces as a terminal OUTCOME (✗), not a frozen progress spinner —
        // the spinner/progress line is cleared and the truthful message is carried by the outcome.
        let outcome = state2
            .supervisor_model
            .as_ref()
            .unwrap()
            .update_outcome_for(&remote2)
            .expect("Err finish shows a failure outcome");
        assert!(!outcome.success);
        assert!(
            outcome.message.contains("no binary"),
            "Err finish surfaces a truthful (no-download) failure message: {}",
            outcome.message
        );
        assert_eq!(
            state2
                .supervisor_model
                .as_ref()
                .unwrap()
                .update_progress_for(&remote2),
            None,
            "Err finish clears the in-flight spinner (no stale 'installing…' line left frozen)"
        );
        assert!(
            state2.update_outcome_expiry.contains_key(&remote2),
            "Err finish arms the (longer) failure display timer"
        );
        assert!(
            state2.auto_update_suppressed.contains(&remote2),
            "Err finish suppresses auto-update retries for this host"
        );
        assert!(
            !state2.secondary_retries.contains_key(&remote2),
            "Err finish does not schedule a reconnect"
        );
    }

    #[test]
    fn expire_host_update_outcomes_clears_only_elapsed_lines() {
        let (model, remote_id) = mixed_remote_model();
        let mut state = test_client_state_with_model(model);
        if let Some(model) = &mut state.supervisor_model {
            model.set_update_outcome(
                &remote_id,
                crate::app::state::HostUpdateOutcome {
                    message: "✓ update complete".into(),
                    success: true,
                },
            );
        }
        let now = Instant::now();
        // Not yet due → nothing cleared.
        state
            .update_outcome_expiry
            .insert(remote_id.clone(), now + Duration::from_secs(5));
        assert!(!expire_host_update_outcomes(&mut state, now));
        assert!(state
            .supervisor_model
            .as_ref()
            .unwrap()
            .update_outcome_for(&remote_id)
            .is_some());

        // Past its deadline → cleared from BOTH the loop-side timer map and the model.
        state
            .update_outcome_expiry
            .insert(remote_id.clone(), now - Duration::from_secs(1));
        assert!(expire_host_update_outcomes(&mut state, now));
        assert!(!state.update_outcome_expiry.contains_key(&remote_id));
        assert!(state
            .supervisor_model
            .as_ref()
            .unwrap()
            .update_outcome_for(&remote_id)
            .is_none());
        // Idempotent once empty.
        assert!(!expire_host_update_outcomes(&mut state, now));
    }

    #[test]
    fn remote_manage_request_builds_set_auto_update() {
        // #61: the auto-update toggle routes through a `remote.set_auto_update` request carrying the
        // remote id and the desired flag.
        let request = remote_manage_request(
            &RemoteManageAction::SetAutoUpdate { auto_update: true },
            "remote-7",
        );
        match request.method {
            crate::api::schema::Method::RemoteSetAutoUpdate(params) => {
                assert_eq!(params.remote_id, "remote-7");
                assert!(params.auto_update);
            }
            _ => panic!("expected a remote.set_auto_update method"),
        }

        // The host-menu outcome maps to the off-loop SetRemoteAutoUpdate dispatch verbatim.
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let dispatch = dispatch_for_client_menu_outcome(
            &mut model,
            supervisor::ClientMenuOutcome::HostToggleAutoUpdate {
                remote_id: "remote-7".into(),
                auto_update: false,
            },
        );
        assert!(matches!(
            dispatch,
            ClientInputDispatch::SetRemoteAutoUpdate { remote_id, auto_update: false } if remote_id == "remote-7"
        ));
    }

    #[test]
    fn auto_update_sweep_skips_pending_and_outcome_guarded_hosts() {
        // An ssh remote with auto-update ON at a protocol mismatch IS a candidate…
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let remote = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-au".into(),
            name: "au".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Ssh {
                target: "au-host".into(),
                args: Vec::new(),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: true,
        });
        model.set_remote_runtime_info(
            &remote,
            Some("0.5.0".into()),
            Some(PROTOCOL_VERSION.wrapping_add(1)),
        );
        assert_eq!(model.auto_update_candidates(), vec![remote.clone()]);

        let mut state = test_client_state_with_model(model);
        let (event_tx, _event_rx) = tokio::sync::mpsc::channel(8);

        // …but the sweep does NOT spawn a second update while one is already in flight.
        state.pending_update_remote.insert(remote.clone());
        auto_update_mismatched_remotes(&mut state, &event_tx);
        assert_eq!(
            state.pending_update_remote.len(),
            1,
            "a host already updating is not re-spawned"
        );
        state.pending_update_remote.remove(&remote);

        // …nor while a terminal outcome is still on screen (the post-update reconnect window), so it
        // never re-fires before the freshly-installed (matching) protocol lands.
        state
            .update_outcome_expiry
            .insert(remote.clone(), Instant::now() + Duration::from_secs(5));
        auto_update_mismatched_remotes(&mut state, &event_tx);
        assert!(
            state.pending_update_remote.is_empty(),
            "an outcome-guarded host is not re-updated"
        );
        state.update_outcome_expiry.remove(&remote);

        // …nor after a prior failure suppressed it (no endless ~14s retry on an un-seedable host).
        state.auto_update_suppressed.insert(remote.clone());
        auto_update_mismatched_remotes(&mut state, &event_tx);
        assert!(
            state.pending_update_remote.is_empty(),
            "a failure-suppressed host is not auto-retried"
        );
    }

    #[test]
    fn every_host_menu_command_dispatch_routes_to_the_loop() {
        // #61 regression: the host-menu "update" (UpdateRemote) was DROPPED before the loop because
        // it was missing from the input-batcher's actionable gate — produced and handled, but never
        // routed, so clicking "update" did nothing from #44 onward. Every host-menu action that maps
        // to a command MUST route; presentation-only outcomes must NOT (they coalesce to a repaint).
        let sid = supervisor::ServerId::secondary("remote-1");
        let commands = [
            ClientInputDispatch::UpdateRemote {
                server_id: sid.clone(),
            },
            ClientInputDispatch::DisconnectRemote {
                server_id: sid.clone(),
            },
            ClientInputDispatch::ReconnectRemote {
                server_id: sid.clone(),
            },
            ClientInputDispatch::SetRemoteEnabled {
                remote_id: "remote-1".into(),
                enabled: false,
            },
            ClientInputDispatch::SetRemoteAutoUpdate {
                remote_id: "remote-1".into(),
                auto_update: true,
            },
            ClientInputDispatch::DeleteRemote {
                remote_id: "remote-1".into(),
            },
        ];
        for dispatch in &commands {
            assert!(
                dispatch_requires_loop_handling(dispatch),
                "a host-menu command must route to the loop, not be coalesced into a repaint"
            );
        }
        // Presentation-only outcomes are coalesced, never broken out as a command.
        assert!(!dispatch_requires_loop_handling(
            &ClientInputDispatch::Redraw
        ));
        assert!(!dispatch_requires_loop_handling(
            &ClientInputDispatch::HoverRedraw
        ));
        assert!(!dispatch_requires_loop_handling(
            &ClientInputDispatch::Consumed
        ));
    }

    fn mixed_remote_model_with_many_workspaces(
        main_count: usize,
        remote_count: usize,
    ) -> (supervisor::ClientSupervisorModel, supervisor::ServerId) {
        let mut model = supervisor::ClientSupervisorModel::new("local");
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

        let main_workspaces = (0..main_count)
            .map(|idx| supervisor::WorkspaceSummary {
                workspace_id: format!("main-{idx}"),
                label: format!("main-{idx}"),
                branch: None,
                focused: idx == 0,
                worktree_key: None,
                worktree_is_linked: false,
                git_repo_key: None,
                git_is_linked: false,
            })
            .collect();
        model
            .set_summary(
                &supervisor::ServerId::main(),
                supervisor::ServerSummary {
                    workspaces: main_workspaces,
                    agents: Vec::new(),
                },
            )
            .unwrap();

        let remote_workspaces = (0..remote_count)
            .map(|idx| supervisor::WorkspaceSummary {
                workspace_id: format!("remote-{idx}"),
                label: format!("remote-{idx}"),
                branch: None,
                focused: false,
                worktree_key: None,
                worktree_is_linked: false,
                git_repo_key: None,
                git_is_linked: false,
            })
            .collect();
        model
            .set_summary(
                &remote_id,
                supervisor::ServerSummary {
                    workspaces: remote_workspaces,
                    agents: Vec::new(),
                },
            )
            .unwrap();

        (model, remote_id)
    }

    #[test]
    fn composited_input_clicking_filter_cycles_sidebar_filter_without_forwarding() {
        let (mut model, _) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);

        let dispatch = dispatch_composited_input(
            b"\x1b[<0;24;1M".to_vec(),
            &mut compositor,
            &mut model,
            (60, 16),
        );

        assert_eq!(dispatch, ClientInputDispatch::Redraw);
        assert_eq!(
            model.filter(),
            &supervisor::ServerFilter::Server(supervisor::ServerId::main())
        );
    }

    #[test]
    fn composited_input_clicking_workspace_returns_owner_api_request() {
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        // item 2 (C3): the host banner adds a row above the remote group, so render at a taller
        // sidebar and scan the full height for the remote workspace row (render == hit_test).
        let host_size = (60, 24);
        let row = (0..host_size.1)
            .find(|row| {
                matches!(
                    compositor.hit_test(&model, 1, *row, host_size.0, host_size.1),
                    Some(compositor::SidebarHitTarget::Workspace {
                        server_id,
                        workspace_id,
                    }) if server_id == remote_id && workspace_id == "remote-api"
                )
            })
            .expect("remote workspace row should be hit-testable");

        let dispatch = dispatch_composited_input(
            format!("\x1b[<0;2;{}M", row + 1).into_bytes(),
            &mut compositor,
            &mut model,
            host_size,
        );

        assert_eq!(
            dispatch,
            ClientInputDispatch::ApiRequest {
                server_id: remote_id.clone(),
                refresh: ClientApiRefreshPolicy::ImmediateFocused,
                request: Box::new(crate::api::schema::Request {
                    id: "client:workspace-focus".into(),
                    method: crate::api::schema::Method::WorkspaceFocus(
                        crate::api::schema::WorkspaceTarget {
                            workspace_id: "remote-api".into(),
                        },
                    ),
                }),
            }
        );
        assert_eq!(model.active_server_id(), &remote_id);
    }

    #[test]
    fn composited_input_scrolls_workspace_list_before_clicking_remote_workspace() {
        let (mut model, remote_id) = mixed_remote_model_with_many_workspaces(8, 2);
        let mut compositor = compositor::ClientCompositor::new(26);
        let host_size = (60, 12);

        assert!(
            (0..host_size.1).all(|row| {
                !matches!(
                    compositor.hit_test(&model, 1, row, host_size.0, host_size.1),
                    Some(compositor::SidebarHitTarget::Workspace {
                        server_id,
                        workspace_id: _,
                    }) if server_id == remote_id
                )
            }),
            "remote workspaces should start below the visible workspace viewport"
        );

        // item 2 (C3): the host banner adds a row to the list, so scroll until the first remote
        // workspace row becomes hit-testable (a few extra scroll steps over the item-4 count).
        let mut row = None;
        for _ in 0..16 {
            row = (0..host_size.1).find(|row| {
                matches!(
                    compositor.hit_test(&model, 1, *row, host_size.0, host_size.1),
                    Some(compositor::SidebarHitTarget::Workspace {
                        server_id,
                        workspace_id,
                    }) if server_id == remote_id && workspace_id == "remote-0"
                )
            });
            if row.is_some() {
                break;
            }
            assert_eq!(
                dispatch_composited_input(
                    b"\x1b[<65;2;3M".to_vec(),
                    &mut compositor,
                    &mut model,
                    host_size,
                ),
                ClientInputDispatch::Redraw
            );
        }
        let row = row.expect("scrolling should reveal the first remote workspace row");

        let dispatch = dispatch_composited_input(
            format!("\x1b[<0;2;{}M", row + 1).into_bytes(),
            &mut compositor,
            &mut model,
            host_size,
        );

        assert_eq!(
            dispatch,
            ClientInputDispatch::ApiRequest {
                server_id: remote_id.clone(),
                refresh: ClientApiRefreshPolicy::ImmediateFocused,
                request: Box::new(crate::api::schema::Request {
                    id: "client:workspace-focus".into(),
                    method: crate::api::schema::Method::WorkspaceFocus(
                        crate::api::schema::WorkspaceTarget {
                            workspace_id: "remote-0".into(),
                        },
                    ),
                }),
            }
        );
        assert_eq!(model.active_server_id(), &remote_id);
    }

    #[test]
    fn composited_input_clicking_agent_returns_owner_api_request() {
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);

        let dispatch = dispatch_composited_input(
            b"\x1b[<0;2;12M".to_vec(),
            &mut compositor,
            &mut model,
            (60, 16),
        );

        assert_eq!(
            dispatch,
            ClientInputDispatch::ApiRequest {
                server_id: remote_id.clone(),
                refresh: ClientApiRefreshPolicy::ImmediateFocused,
                request: Box::new(crate::api::schema::Request {
                    id: "client:agent-focus".into(),
                    method: crate::api::schema::Method::AgentFocus(
                        crate::api::schema::AgentTarget {
                            target: "remote-agent".into(),
                        },
                    ),
                }),
            }
        );
        assert_eq!(model.active_server_id(), &remote_id);
    }

    // ---------------------------------------------------------------------------
    // #24: client-side sidebar keyboard-navigation tests. These drive raw key bytes through
    // `dispatch_composited_input` and assert the SAME client actions the mouse path produces.
    // Each writes a temp config that enables the (default-unset) sidebar-nav bindings and points
    // `Config::load()` at it via `CONFIG_PATH_ENV_VAR`, guarded by the shared config env lock so
    // the bindings the interception layer resolves are deterministic.
    // ---------------------------------------------------------------------------

    /// #24: run `body` with `Config::load()` pointed at a temp config containing `keys_toml`.
    fn with_client_keys_config<T>(keys_toml: &str, body: impl FnOnce() -> T) -> T {
        let _guard = crate::config::test_config_env_lock().lock().unwrap();
        let path = std::env::temp_dir().join(format!(
            "herdr-client-keys-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, keys_toml).unwrap();
        let _env = EnvVarGuard::set(crate::config::CONFIG_PATH_ENV_VAR, path.to_str().unwrap());
        let result = body();
        std::fs::remove_file(&path).ok();
        result
    }

    /// #24: feed a single bare char keypress (no modifiers) through the composited input path.
    fn press_char(
        c: char,
        compositor: &mut compositor::ClientCompositor,
        model: &mut supervisor::ClientSupervisorModel,
    ) -> ClientInputDispatch {
        dispatch_composited_input(c.to_string().into_bytes(), compositor, model, (60, 16))
    }

    // A next-workspace key (bound direct to `alt+n`) routed through `dispatch_composited_input`
    // yields an ApiRequest focusing the NEXT workspace in the aggregated list — which crosses the
    // server boundary from main to the remote, switching the active server.
    #[test]
    fn next_workspace_key_focuses_next_workspace_across_server_boundary() {
        with_client_keys_config("[keys]\nnext_workspace = \"alt+n\"\n", || {
            let (mut model, remote_id) = mixed_remote_model();
            let mut compositor = compositor::ClientCompositor::new(26);
            assert_eq!(model.active_server_id(), &supervisor::ServerId::main());

            let dispatch =
                dispatch_composited_input(b"\x1bn".to_vec(), &mut compositor, &mut model, (60, 16));

            assert_eq!(
                dispatch,
                ClientInputDispatch::ApiRequest {
                    server_id: remote_id.clone(),
                    refresh: ClientApiRefreshPolicy::ImmediateFocused,
                    request: Box::new(crate::api::schema::Request {
                        id: "client:workspace-focus".into(),
                        method: crate::api::schema::Method::WorkspaceFocus(
                            crate::api::schema::WorkspaceTarget {
                                workspace_id: "remote-api".into(),
                            },
                        ),
                    }),
                }
            );
            assert_eq!(model.active_server_id(), &remote_id);
        });
    }

    // prev-workspace symmetric: from the first (main) workspace, stepping back wraps to the last
    // (remote) workspace, crossing the server boundary.
    #[test]
    fn prev_workspace_key_wraps_to_last_workspace() {
        with_client_keys_config("[keys]\nprevious_workspace = \"alt+p\"\n", || {
            let (mut model, remote_id) = mixed_remote_model();
            let mut compositor = compositor::ClientCompositor::new(26);

            let dispatch =
                dispatch_composited_input(b"\x1bp".to_vec(), &mut compositor, &mut model, (60, 16));

            assert_eq!(
                dispatch,
                ClientInputDispatch::ApiRequest {
                    server_id: remote_id.clone(),
                    refresh: ClientApiRefreshPolicy::ImmediateFocused,
                    request: Box::new(crate::api::schema::Request {
                        id: "client:workspace-focus".into(),
                        method: crate::api::schema::Method::WorkspaceFocus(
                            crate::api::schema::WorkspaceTarget {
                                workspace_id: "remote-api".into(),
                            },
                        ),
                    }),
                }
            );
            assert_eq!(model.active_server_id(), &remote_id);
        });
    }

    // #24: each connected server independently reports a focused workspace, so several rows are
    // focused at once. Stepping must anchor on the ACTIVE server's focused row — not the first or
    // last focused row in the aggregated list. The active server here is the MIDDLE of three, which
    // distinguishes active-anchoring (→ next server) from first-anchoring or last-anchoring.
    #[test]
    fn step_workspace_focus_anchors_on_active_server() {
        let secondary =
            |id: &str, session: &str| crate::remote_registry::RemoteDefinitionSnapshot {
                id: id.into(),
                name: id.into(),
                target: crate::remote_registry::RemoteTargetSnapshot::Local {
                    session: Some(session.into()),
                },
                session: None,
                keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
                disabled: false,
                auto_update: false,
            };
        let focused_ws = |id: &str| supervisor::WorkspaceSummary {
            workspace_id: id.into(),
            label: id.into(),
            branch: None,
            focused: true,
            ..Default::default()
        };
        let summary = |ws: &str| supervisor::ServerSummary {
            workspaces: vec![focused_ws(ws)],
            agents: Vec::new(),
        };

        let mut model = supervisor::ClientSupervisorModel::new("local");
        let mid = model.add_secondary(secondary("remote-b", "b"));
        let last = model.add_secondary(secondary("remote-c", "c"));
        // visible order is [main, remote-b, remote-c]; every server has one focused workspace.
        model
            .set_summary(&supervisor::ServerId::main(), summary("main-ws"))
            .unwrap();
        model.set_summary(&mid, summary("mid-ws")).unwrap();
        model.set_summary(&last, summary("last-ws")).unwrap();

        // Make the MIDDLE server active. All three rows stay focused (each from its own summary).
        model.focus_workspace_route(&mid, "mid-ws");
        assert_eq!(model.active_server_id(), &mid);

        // Forward step anchors on the active (middle) server's row → the NEXT server's workspace.
        // (First-anchoring would step from main → mid; last-anchoring would wrap last → main.)
        match step_workspace_focus(&mut model, 1) {
            ClientInputDispatch::ApiRequest {
                server_id, request, ..
            } => {
                assert_eq!(server_id, last);
                match &request.method {
                    crate::api::schema::Method::WorkspaceFocus(target) => {
                        assert_eq!(target.workspace_id, "last-ws");
                    }
                    other => panic!("expected WorkspaceFocus, got {other:?}"),
                }
            }
            other => panic!("expected ApiRequest, got {other:?}"),
        }
    }

    // A new-workspace key opens the picker (multi-destination → Redraw, picker overlay set).
    #[test]
    fn new_workspace_key_opens_picker() {
        with_client_keys_config("[keys]\nnew_workspace = \"alt+m\"\n", || {
            let (mut model, _) = mixed_remote_model();
            let mut compositor = compositor::ClientCompositor::new(26);
            assert!(model.new_workspace_picker().is_none());

            let dispatch =
                dispatch_composited_input(b"\x1bm".to_vec(), &mut compositor, &mut model, (60, 16));

            assert_eq!(dispatch, ClientInputDispatch::Redraw);
            assert!(model.new_workspace_picker().is_some());
        });
    }

    // A rename key opens the #23 rename overlay for the focused workspace.
    #[test]
    fn rename_workspace_key_opens_rename_overlay_for_focused_workspace() {
        with_client_keys_config("[keys]\nrename_workspace = \"alt+r\"\n", || {
            let (mut model, _) = mixed_remote_model();
            let mut compositor = compositor::ClientCompositor::new(26);
            assert!(model.rename_workspace_form().is_none());

            let dispatch =
                dispatch_composited_input(b"\x1br".to_vec(), &mut compositor, &mut model, (60, 16));

            assert_eq!(dispatch, ClientInputDispatch::Redraw);
            let form = model
                .rename_workspace_form()
                .expect("rename overlay should be open");
            // main-herdr is the focused workspace in the fixture.
            assert_eq!(form.workspace_id, "main-herdr");
        });
    }

    // A close key opens the #23 confirm-close overlay for the focused workspace.
    #[test]
    fn close_workspace_key_opens_confirm_close_overlay_for_focused_workspace() {
        with_client_keys_config("[keys]\nclose_workspace = \"alt+d\"\n", || {
            let (mut model, _) = mixed_remote_model();
            let mut compositor = compositor::ClientCompositor::new(26);
            assert!(model.confirm_close_workspace().is_none());

            let dispatch =
                dispatch_composited_input(b"\x1bd".to_vec(), &mut compositor, &mut model, (60, 16));

            assert_eq!(dispatch, ClientInputDispatch::Redraw);
            let confirm = model
                .confirm_close_workspace()
                .expect("confirm-close overlay should be open");
            assert_eq!(confirm.workspace_id, "main-herdr");
        });
    }

    // A collapse-toggle key flips `from_model`'s `app.sidebar_collapsed`; a scope-toggle key flips
    // the agent-panel scope. Both are client-local compositor flips with no server traffic. #58: the
    // collapse toggle now returns `Consumed` (not `Redraw`) — the single collapse tick renders the
    // final width, so the toggle skips a wasted pre-toggle-width repaint.
    #[test]
    fn collapse_toggle_key_flips_sidebar_collapsed() {
        with_client_keys_config("[keys]\ntoggle_sidebar = \"alt+b\"\n", || {
            let (mut model, _) = mixed_remote_model();
            let mut compositor = compositor::ClientCompositor::new(26);
            assert!(!compositor.sidebar_collapsed_for_test());

            let dispatch =
                dispatch_composited_input(b"\x1bb".to_vec(), &mut compositor, &mut model, (60, 16));
            assert_eq!(dispatch, ClientInputDispatch::Consumed);
            assert!(compositor.sidebar_collapsed_for_test());
        });
    }

    // #9 item 1: the DEFAULT two-step `prefix+b` collapse path (ctrl+b THEN b) must flip the CLIENT
    // compositor's collapse state in client-compositor mode — never forwarded to the server's dead
    // `AppState.sidebar_collapsed`. The only prior collapse test rebinds `toggle_sidebar` to a direct
    // `alt+b` chord, so the shipped default prefix path was untested end-to-end. Feeds raw bytes
    // (0x02 then 'b') and asserts the flip BOTH directions with nothing Forwarded to the server.
    #[test]
    fn prefix_b_collapse_toggles_sidebar_in_both_directions() {
        with_client_keys_config(
            "[keys]\nprefix = \"ctrl+b\"\ntoggle_sidebar = \"prefix+b\"\n",
            || {
                let (mut model, _) = mixed_remote_model();
                let mut compositor = compositor::ClientCompositor::new(26);
                assert!(!compositor.sidebar_collapsed_for_test());

                // ctrl+b (0x02) arms prefix mode: swallowed (Redraw), nothing forwarded yet.
                assert_eq!(
                    dispatch_composited_input(vec![0x02], &mut compositor, &mut model, (60, 16)),
                    ClientInputDispatch::Redraw
                );
                assert!(compositor.prefix_armed());

                // 'b' resolves the prefix-mode collapse: flips the CLIENT flag, disarms prefix, and
                // is NOT forwarded to the server. #58: the collapse toggle returns `Consumed` (never a
                // Forward) — the single collapse tick repaints the final width, no pre-toggle redraw.
                assert_eq!(
                    press_char('b', &mut compositor, &mut model),
                    ClientInputDispatch::Consumed
                );
                assert!(!compositor.prefix_armed());
                assert!(compositor.sidebar_collapsed_for_test());

                // ctrl+b then b again expands — flips back the other direction.
                assert_eq!(
                    dispatch_composited_input(vec![0x02], &mut compositor, &mut model, (60, 16)),
                    ClientInputDispatch::Redraw
                );
                assert_eq!(
                    press_char('b', &mut compositor, &mut model),
                    ClientInputDispatch::Consumed
                );
                assert!(!compositor.sidebar_collapsed_for_test());
            },
        );
    }

    // SAFETY: a normal/unbound key (a plain letter, NOT in prefix mode) is NOT intercepted — it is
    // Forwarded unchanged so terminal/agent input is preserved.
    #[test]
    fn unbound_plain_key_is_forwarded_not_intercepted() {
        with_client_keys_config("[keys]\nnext_workspace = \"alt+n\"\n", || {
            let (mut model, _) = mixed_remote_model();
            let mut compositor = compositor::ClientCompositor::new(26);

            // 'x' matches no sidebar-nav binding and the prefix is not armed: Forward.
            assert_eq!(
                press_char('x', &mut compositor, &mut model),
                ClientInputDispatch::Forward(b"x".to_vec())
            );
            // Even a bare 'n' (the RHS of the alt+n direct binding) is NOT intercepted without
            // the alt modifier — the direct chord requires its modifier.
            assert_eq!(
                press_char('n', &mut compositor, &mut model),
                ClientInputDispatch::Forward(b"n".to_vec())
            );
        });
    }

    // Prefix-mode gating: with a prefix-bound next-workspace (`prefix+n`), a bare 'n' is Forwarded
    // when prefix is NOT armed, and intercepted only AFTER the prefix key (ctrl+b) arms the mode.
    #[test]
    fn prefix_bound_key_intercepted_only_while_prefix_armed() {
        with_client_keys_config(
            "[keys]\nprefix = \"ctrl+b\"\nnext_workspace = \"prefix+n\"\n",
            || {
                let (mut model, remote_id) = mixed_remote_model();
                let mut compositor = compositor::ClientCompositor::new(26);

                // Not armed: a bare 'n' is forwarded to the terminal (never hijacked).
                assert_eq!(
                    press_char('n', &mut compositor, &mut model),
                    ClientInputDispatch::Forward(b"n".to_vec())
                );
                assert!(!compositor.prefix_armed());

                // Press the prefix key (ctrl+b == 0x02): arms prefix mode, swallowed (Redraw).
                assert_eq!(
                    dispatch_composited_input(vec![0x02], &mut compositor, &mut model, (60, 16),),
                    ClientInputDispatch::Redraw
                );
                assert!(compositor.prefix_armed());

                // Now 'n' resolves the prefix-mode next-workspace action and disarms prefix mode.
                let dispatch = press_char('n', &mut compositor, &mut model);
                assert!(!compositor.prefix_armed());
                assert_eq!(
                    dispatch,
                    ClientInputDispatch::ApiRequest {
                        server_id: remote_id.clone(),
                        refresh: ClientApiRefreshPolicy::ImmediateFocused,
                        request: Box::new(crate::api::schema::Request {
                            id: "client:workspace-focus".into(),
                            method: crate::api::schema::Method::WorkspaceFocus(
                                crate::api::schema::WorkspaceTarget {
                                    workspace_id: "remote-api".into(),
                                },
                            ),
                        }),
                    }
                );
            },
        );
    }

    // #30: in client-compositor mode the prefix key must still reach the server for any prefix
    // action the client does NOT re-implement. `c` (new_tab = prefix+c) is not a sidebar-nav
    // binding, so `ctrl+b` then `c` must forward the buffered prefix byte + `c` to the active
    // server (so the server's prefix state machine runs new-tab) — not silently swallow it.
    #[test]
    fn prefix_then_unhandled_key_forwards_prefix_and_key_to_server() {
        with_client_keys_config("[keys]\nprefix = \"ctrl+b\"\n", || {
            let (mut model, _remote_id) = mixed_remote_model();
            let mut compositor = compositor::ClientCompositor::new(26);

            // ctrl+b (0x02) arms prefix mode and is swallowed (not forwarded yet).
            assert_eq!(
                dispatch_composited_input(vec![0x02], &mut compositor, &mut model, (60, 16)),
                ClientInputDispatch::Redraw
            );
            assert!(compositor.prefix_armed());

            // 'c' is not a client sidebar-nav binding → replay prefix + key to the server.
            assert_eq!(
                press_char('c', &mut compositor, &mut model),
                ClientInputDispatch::Forward(vec![0x02, b'c'])
            );
            assert!(!compositor.prefix_armed());
        });
    }

    // #30: detach (prefix+q) is not a client sidebar action, so it must reach the server too
    // (previously it was eaten, leaving `ctrl+b q` dead in mixed sessions).
    #[test]
    fn prefix_then_detach_forwards_to_server() {
        with_client_keys_config(
            "[keys]\nprefix = \"ctrl+b\"\ndetach = \"prefix+q\"\n",
            || {
                let (mut model, _remote_id) = mixed_remote_model();
                let mut compositor = compositor::ClientCompositor::new(26);
                assert_eq!(
                    dispatch_composited_input(vec![0x02], &mut compositor, &mut model, (60, 16)),
                    ClientInputDispatch::Redraw
                );
                assert_eq!(
                    press_char('q', &mut compositor, &mut model),
                    ClientInputDispatch::Forward(vec![0x02, b'q'])
                );
                assert!(!compositor.prefix_armed());
            },
        );
    }

    // item 6 (Area 6): the focus dispatch emits ImmediateFocused (a server-switching focus), not
    // the old Deferred. This is the render==hit_test-style consistency check for this item: the
    // policy the dispatch emits matches the policy the handler acts on.
    #[test]
    fn focus_dispatch_uses_immediate_focused_policy() {
        let (mut model, remote_id) = mixed_remote_model();
        let mouse = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        };

        let workspace_dispatch = dispatch_sidebar_hit_target(
            compositor::SidebarHitTarget::Workspace {
                server_id: remote_id.clone(),
                workspace_id: "remote-api".into(),
            },
            &mut model,
            &mouse,
        );
        assert!(matches!(
            workspace_dispatch,
            ClientInputDispatch::ApiRequest {
                refresh: ClientApiRefreshPolicy::ImmediateFocused,
                ..
            }
        ));

        // A second model so the agent focus is also a server switch (active starts at main).
        let (mut model, remote_id) = mixed_remote_model();
        let agent_dispatch = dispatch_sidebar_hit_target(
            compositor::SidebarHitTarget::Agent {
                server_id: remote_id.clone(),
                agent_id: "remote-agent".into(),
            },
            &mut model,
            &mouse,
        );
        assert!(matches!(
            agent_dispatch,
            ClientInputDispatch::ApiRequest {
                refresh: ClientApiRefreshPolicy::ImmediateFocused,
                ..
            }
        ));
    }

    #[test]
    fn single_secondary_summary_refresh_dedupes_pending() {
        let (model, remote_id) = mixed_remote_model();
        let ssh_bridges = HashMap::new();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);
        let mut pending = HashSet::new();
        pending.insert(remote_id.clone());

        start_single_secondary_summary_refresh(
            &model,
            &remote_id,
            &ssh_bridges,
            &mut pending,
            &event_tx,
        );

        // Already pending: no second worker spawned, pending unchanged, nothing queued.
        assert_eq!(pending.len(), 1);
        assert!(pending.contains(&remote_id));
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn single_secondary_summary_refresh_skips_main_id() {
        let (model, _remote_id) = mixed_remote_model();
        let ssh_bridges = HashMap::new();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);
        let mut pending = HashSet::new();

        start_single_secondary_summary_refresh(
            &model,
            &supervisor::ServerId::main(),
            &ssh_bridges,
            &mut pending,
            &event_tx,
        );

        // Main id is a no-op inside the helper: nothing spawned, pending stays empty.
        assert!(pending.is_empty());
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn single_secondary_summary_refresh_targets_one_server() {
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let id_a = model.add_secondary(test_remote_definition("a", "a"));
        let id_b = model.add_secondary(test_remote_definition("b", "b"));
        let ssh_bridges = HashMap::new();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);
        let mut pending = HashSet::new();

        start_single_secondary_summary_refresh(
            &model,
            &id_b,
            &ssh_bridges,
            &mut pending,
            &event_tx,
        );

        // Only id_b is in flight (a single id in, a single fetch out — targeted, not fleet).
        assert!(pending.contains(&id_b));
        assert!(!pending.contains(&id_a));
        assert_eq!(pending.len(), 1);

        // The worker thread enqueues exactly one SupervisorSummaryFetched for id_b.
        let event = event_rx.blocking_recv().unwrap();
        match event {
            ClientLoopEvent::SupervisorSummaryFetched { server_id, .. } => {
                assert_eq!(server_id, id_b);
            }
            _ => panic!("expected a single SupervisorSummaryFetched for id_b"),
        }
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn due_secondary_summary_refreshes_uses_fast_cadence_for_active() {
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let active = model.add_secondary(test_remote_definition("active", "active"));
        let background = model.add_secondary(test_remote_definition("bg", "bg"));
        model.set_active_server(active.clone()).unwrap();
        let mut state = test_client_state_with_model(model);

        let now = Instant::now();
        let stale = now - Duration::from_millis(500);
        state.last_summary_refresh.insert(active.clone(), stale);
        state.last_summary_refresh.insert(background.clone(), stale);

        let due = due_secondary_summary_refreshes(&state, now);
        // Active remote (500ms old) is due at the 400ms fast cadence; the background remote
        // (500ms old) is NOT due at the 2s background cadence.
        assert!(due.contains(&active));
        assert!(!due.contains(&background));
    }

    #[test]
    fn due_secondary_summary_refreshes_returns_background_after_slow_interval() {
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let active = model.add_secondary(test_remote_definition("active", "active"));
        let background = model.add_secondary(test_remote_definition("bg", "bg"));
        model.set_active_server(active.clone()).unwrap();
        let mut state = test_client_state_with_model(model);

        let now = Instant::now();
        // Background just past the 2s background interval; active just refreshed (not yet due).
        state
            .last_summary_refresh
            .insert(active.clone(), now - Duration::from_millis(10));
        state.last_summary_refresh.insert(
            background.clone(),
            now - CLIENT_SUPERVISOR_REFRESH_INTERVAL - Duration::from_millis(1),
        );

        let due = due_secondary_summary_refreshes(&state, now);
        assert!(due.contains(&background));
        assert!(!due.contains(&active));
        // Main never appears in the result.
        assert!(!due.contains(&supervisor::ServerId::main()));
    }

    #[test]
    fn timer_issues_no_inline_blocking_secondary_fetch() {
        // Structural guard: feeding due secondaries into the spawn helper enqueues a background
        // SupervisorSummaryFetched (worker thread) and returns within the 60fps budget — proving
        // no synchronous SSH call is on the loop.
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(test_remote_definition("slow", "slow"));
        let mut state = test_client_state_with_model(model);
        // Force the secondary due immediately (no prior refresh).
        let now = Instant::now();
        let ssh_bridges = HashMap::new();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);

        let due = due_secondary_summary_refreshes(&state, now);
        assert!(due.contains(&remote_id));

        let started_at = Instant::now();
        if let Some(model) = &state.supervisor_model {
            for server_id in &due {
                start_single_secondary_summary_refresh(
                    model,
                    server_id,
                    &ssh_bridges,
                    &mut state.pending_summary_refresh_server_ids,
                    &event_tx,
                );
                state.last_summary_refresh.insert(server_id.clone(), now);
            }
        }
        let elapsed = started_at.elapsed();

        assert!(
            elapsed <= CLIENT_60FPS_FRAME_BUDGET,
            "the Timer's secondary fan-out blocked the UI thread for {elapsed:?}, about {:.1} fps",
            fps_for_frame_duration(elapsed)
        );
        assert!(state
            .pending_summary_refresh_server_ids
            .contains(&remote_id));
        // The fetch happens on the worker thread (off the loop): the event arrives later.
        let event = event_rx.blocking_recv().unwrap();
        assert!(matches!(
            event,
            ClientLoopEvent::SupervisorSummaryFetched { server_id, .. } if server_id == remote_id
        ));
    }

    #[test]
    fn supervisor_summary_changed_refreshes_only_that_server() {
        // The SupervisorSummaryChanged handler routes a secondary id through the single-server
        // helper (the targeted event-push), never the whole-fleet refresh — so only the changed
        // server lands in `pending`. Two secondaries; only the changed one is fetched.
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let changed = model.add_secondary(test_remote_definition("changed", "changed"));
        let other = model.add_secondary(test_remote_definition("other", "other"));
        let ssh_bridges = HashMap::new();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);
        let mut pending = HashSet::new();

        // Mirror the handler's secondary branch exactly.
        start_single_secondary_summary_refresh(
            &model,
            &changed,
            &ssh_bridges,
            &mut pending,
            &event_tx,
        );

        assert!(pending.contains(&changed));
        assert!(!pending.contains(&other));
        assert!(!pending.contains(&supervisor::ServerId::main()));

        let event = event_rx.blocking_recv().unwrap();
        assert!(matches!(
            event,
            ClientLoopEvent::SupervisorSummaryFetched { server_id, .. } if server_id == changed
        ));
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn connect_prioritizes_connected_server_refresh() {
        // On connect, the just-connected server's summary is put in flight by the handler's
        // EXPLICIT server_id (connecting does NOT change active_server_id, which stays at main).
        // So prioritization keys off the connected id, not active_server_id().
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let connected = model.add_secondary(test_remote_definition("connected", "connected"));
        // active_server_id remains main after a connect (set_connection_state(.., Connected) does
        // not touch it) — assert that so the test pins the contract's "not active_server_id" rule.
        assert_eq!(model.active_server_id(), &supervisor::ServerId::main());
        let ssh_bridges = HashMap::new();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);
        let mut pending = HashSet::new();

        // Mirror the connect handler's prioritized single-server fetch.
        start_single_secondary_summary_refresh(
            &model,
            &connected,
            &ssh_bridges,
            &mut pending,
            &event_tx,
        );

        assert!(pending.contains(&connected));
        let event = event_rx.blocking_recv().unwrap();
        assert!(matches!(
            event,
            ClientLoopEvent::SupervisorSummaryFetched { server_id, .. } if server_id == connected
        ));
    }

    #[test]
    fn composited_input_translates_content_mouse_to_embedded_viewport() {
        let (mut model, _) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);

        let dispatch = dispatch_composited_input(
            b"\x1b[<0;28;3M".to_vec(),
            &mut compositor,
            &mut model,
            (60, 16),
        );

        assert_eq!(
            dispatch,
            ClientInputDispatch::Forward(b"\x1b[<0;2;3M".to_vec())
        );
    }

    // item 7 (Area 4): an SGR no-button motion report (`\x1b[<35;col;rowM`, drag-bit set, button
    // code 3) parses to `MouseEventKind::Moved`. Builds the 1-based escape over a 0-based (col,row).
    fn moved_bytes(col: u16, row: u16) -> Vec<u8> {
        format!("\x1b[<35;{};{}M", col + 1, row + 1).into_bytes()
    }

    // find the first sidebar row that hit-tests to the remote workspace (render == hit_test).
    fn remote_workspace_row(
        compositor: &compositor::ClientCompositor,
        model: &supervisor::ClientSupervisorModel,
        remote_id: &supervisor::ServerId,
        host: (u16, u16),
    ) -> u16 {
        (0..host.1)
            .find(|row| {
                matches!(
                    compositor.hit_test(model, 1, *row, host.0, host.1),
                    Some(compositor::SidebarHitTarget::Workspace { server_id, .. })
                        if server_id == *remote_id
                )
            })
            .expect("remote workspace row should be hit-testable")
    }

    #[test]
    fn composited_moved_records_pending_hover_and_resolves_once_per_frame() {
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let row = remote_workspace_row(&compositor, &model, &remote_id, host);

        // #48: a motion over the row RECORDS a pending hover and asks for a (deferred) HoverRedraw —
        // it does NOT resolve `hover_test` inline (resolving per motion event rebuilt the
        // O(hosts×agents) `from_model` snapshot every event, the <1fps hover flood).
        assert_eq!(
            dispatch_composited_input(moved_bytes(1, row), &mut compositor, &mut model, host),
            ClientInputDispatch::HoverRedraw
        );
        assert!(
            compositor.has_pending_hover(),
            "motion records a pending hover"
        );
        assert_eq!(
            compositor.hover(),
            None,
            "hover is resolved at the per-frame flush, not inline"
        );

        // the per-frame flush resolves it ONCE; the hover lands on the workspace row.
        assert!(
            compositor.resolve_pending_hover(&model, host.0, host.1),
            "first resolve changes the hover from None"
        );
        assert!(matches!(
            compositor.hover(),
            Some(crate::app::state::SidebarHoverTarget::Workspace { .. })
        ));
        assert!(
            !compositor.has_pending_hover(),
            "resolve consumes the pending position"
        );

        // a second identical motion records the same position again; resolving it is a no-op
        // (latest-wins coalescing — a same-row sweep produces no visible change).
        assert_eq!(
            dispatch_composited_input(moved_bytes(1, row), &mut compositor, &mut model, host),
            ClientInputDispatch::HoverRedraw
        );
        assert!(
            !compositor.resolve_pending_hover(&model, host.0, host.1),
            "an unchanged hover resolves to no change"
        );
    }

    #[test]
    fn composited_moved_off_sidebar_clears_hover_once() {
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);
        let row = remote_workspace_row(&compositor, &model, &remote_id, host);

        // establish a sidebar hover (record on motion, resolve at the per-frame flush).
        assert_eq!(
            dispatch_composited_input(moved_bytes(1, row), &mut compositor, &mut model, host),
            ClientInputDispatch::HoverRedraw
        );
        assert!(compositor.resolve_pending_hover(&model, host.0, host.1));
        assert!(compositor.hover().is_some());
        // motion into the content area is still intercepted (a hover is set) → records a pending
        // hover; resolving it clears the highlight (a content position hover-tests to None). #48:
        // clearing the highlight is still a presentation-only change.
        assert_eq!(
            dispatch_composited_input(moved_bytes(40, 3), &mut compositor, &mut model, host),
            ClientInputDispatch::HoverRedraw
        );
        assert!(
            compositor.resolve_pending_hover(&model, host.0, host.1),
            "leaving the sidebar resolves the hover to None — a change"
        );
        assert_eq!(compositor.hover(), None);
        // #31: a second content motion (no prior hover) falls through to
        // translate_content_mouse_input, which must re-encode the Moved event with the column
        // translated into content space (host col 40 − sidebar width 26 = content col 14) — not
        // forward the original host-coordinate bytes.
        assert_eq!(
            dispatch_composited_input(moved_bytes(40, 3), &mut compositor, &mut model, host),
            ClientInputDispatch::Forward(moved_bytes(14, 3))
        );
    }

    #[test]
    fn hover_never_produces_server_traffic() {
        // a client Moved over a workspace OR agent row only ever returns Redraw/Consumed —
        // never ApiRequest/ServerControl/AddRemote/SetRemoteEnabled/DeleteRemote.
        let (mut model, remote_id) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 24u16);

        let no_traffic = |dispatch: &ClientInputDispatch| {
            !matches!(
                dispatch,
                ClientInputDispatch::ApiRequest { .. }
                    | ClientInputDispatch::ServerControl { .. }
                    | ClientInputDispatch::AddRemote(_)
                    | ClientInputDispatch::SetRemoteEnabled { .. }
                    | ClientInputDispatch::SetRemoteAutoUpdate { .. }
                    | ClientInputDispatch::DeleteRemote { .. }
                    | ClientInputDispatch::Forward(_)
            )
        };

        // sweep every sidebar row with a motion; none may produce traffic.
        let _ = remote_workspace_row(&compositor, &model, &remote_id, host);
        for row in 0..host.1 {
            let dispatch =
                dispatch_composited_input(moved_bytes(1, row), &mut compositor, &mut model, host);
            assert!(
                no_traffic(&dispatch),
                "hover motion produced traffic {dispatch:?} at row {row}"
            );
            assert!(
                matches!(
                    dispatch,
                    ClientInputDispatch::HoverRedraw
                        | ClientInputDispatch::Redraw
                        | ClientInputDispatch::Consumed
                ),
                "hover motion produced non-hover dispatch {dispatch:?} at row {row}"
            );
        }
        assert_eq!(model.active_server_id(), &supervisor::ServerId::main());
    }

    #[test]
    fn composited_input_clicking_new_with_single_destination_returns_create_request() {
        let (mut model, _) = mixed_remote_model();
        model.set_filter(supervisor::ServerFilter::Server(
            supervisor::ServerId::main(),
        ));
        let mut compositor = compositor::ClientCompositor::new(26);

        let dispatch = dispatch_composited_input(
            b"\x1b[<0;2;8M".to_vec(),
            &mut compositor,
            &mut model,
            (60, 16),
        );

        assert_eq!(
            dispatch,
            ClientInputDispatch::ApiRequest {
                server_id: supervisor::ServerId::main(),
                refresh: ClientApiRefreshPolicy::Immediate,
                request: Box::new(crate::api::schema::Request {
                    id: "client:workspace-create".into(),
                    method: crate::api::schema::Method::WorkspaceCreate(
                        crate::api::schema::WorkspaceCreateParams {
                            cwd: None,
                            focus: true,
                            label: None,
                            env: Default::default(),
                        },
                    ),
                }),
            }
        );
    }

    #[test]
    fn composited_input_clicking_new_with_multiple_destinations_opens_picker() {
        let (mut model, _) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);

        let dispatch = dispatch_composited_input(
            b"\x1b[<0;2;8M".to_vec(),
            &mut compositor,
            &mut model,
            (60, 16),
        );

        assert_eq!(dispatch, ClientInputDispatch::Redraw);
        assert_eq!(
            model
                .new_workspace_picker_destinations()
                .map(|items| items.len()),
            Some(2)
        );
    }

    /// SGR mouse-down (button left) at 0-based `(col, row)`. The SGR protocol uses 1-based coords.
    fn sgr_left_down(col: u16, row: u16) -> Vec<u8> {
        format!("\x1b[<0;{};{}M", col + 1, row + 1).into_bytes()
    }

    #[test]
    fn composited_input_clicking_picker_destination_returns_create_request() {
        let (mut model, remote_id) = mixed_remote_model();
        model.open_new_workspace_picker();
        let mut compositor = compositor::ClientCompositor::new(26);

        // item 1: click the FOOTER-ANCHORED remote destination row (index 1), using the same
        // shared geometry + anchor_area the renderer/hit-test use (the popup floats over the live
        // content at the sidebar footer, not centered).
        let anchor = compositor.overlay_anchor_area(&model, 60, 20);
        let inner = crate::ui::new_workspace_picker_inner_rect(anchor, 2).expect("modal fits");
        let row1 = crate::ui::new_workspace_picker_row_rect(inner, 1);
        assert!(row1.y > 0);

        let dispatch = dispatch_composited_input(
            sgr_left_down(row1.x, row1.y),
            &mut compositor,
            &mut model,
            (60, 20),
        );

        assert_eq!(
            dispatch,
            ClientInputDispatch::ApiRequest {
                server_id: remote_id.clone(),
                refresh: ClientApiRefreshPolicy::Immediate,
                request: Box::new(crate::api::schema::Request {
                    id: "client:workspace-create".into(),
                    method: crate::api::schema::Method::WorkspaceCreate(
                        crate::api::schema::WorkspaceCreateParams {
                            cwd: None,
                            focus: true,
                            label: None,
                            env: Default::default(),
                        },
                    ),
                }),
            }
        );
        assert_eq!(model.active_server_id(), &remote_id);
        assert_eq!(model.new_workspace_picker_destinations(), None);
    }

    #[test]
    fn composited_input_picker_keyboard_navigates_and_confirms() {
        let (mut model, remote_id) = mixed_remote_model();
        model.open_new_workspace_picker();
        let mut compositor = compositor::ClientCompositor::new(26);

        // ↓ moves the highlight onto the remote (index 1).
        let nav =
            dispatch_composited_input(b"\x1b[B".to_vec(), &mut compositor, &mut model, (60, 16));
        assert_eq!(nav, ClientInputDispatch::Redraw);
        assert_eq!(model.new_workspace_picker().map(|p| p.selected), Some(1));

        // Enter confirms the highlighted destination → create on the remote.
        let confirm =
            dispatch_composited_input(b"\r".to_vec(), &mut compositor, &mut model, (60, 16));
        assert_eq!(
            confirm,
            ClientInputDispatch::ApiRequest {
                server_id: remote_id.clone(),
                refresh: ClientApiRefreshPolicy::Immediate,
                request: Box::new(crate::api::schema::Request {
                    id: "client:workspace-create".into(),
                    method: crate::api::schema::Method::WorkspaceCreate(
                        crate::api::schema::WorkspaceCreateParams {
                            cwd: None,
                            focus: true,
                            label: None,
                            env: Default::default(),
                        },
                    ),
                }),
            }
        );
        assert_eq!(model.active_server_id(), &remote_id);
        assert_eq!(model.new_workspace_picker(), None);
    }

    #[test]
    fn composited_input_picker_esc_closes() {
        let (mut model, _) = mixed_remote_model();
        model.open_new_workspace_picker();
        let mut compositor = compositor::ClientCompositor::new(26);

        let dispatch =
            dispatch_composited_input(b"\x1b".to_vec(), &mut compositor, &mut model, (60, 16));

        assert_eq!(dispatch, ClientInputDispatch::Redraw);
        assert_eq!(model.new_workspace_picker(), None);
    }

    /// D1 harness: open the host menu on the remote, then promote its session row into the picker.
    fn model_with_session_picker_open() -> (supervisor::ClientSupervisorModel, supervisor::ServerId)
    {
        let (mut model, remote_id) = mixed_remote_model();
        model.open_host_context_menu(remote_id.clone(), "x".into(), 0, 0);
        // Row 1 is the `session <name>` readout (C3).
        model.select_client_menu_item(1);
        assert!(model.session_picker().is_some(), "picker open");
        (model, remote_id)
    }

    #[test]
    fn session_picker_owns_the_keyboard_instead_of_the_pane() {
        // REGRESSION (D1): the overlay-ownership gate was a hand-written `||` chain that omitted the
        // session overlays, so every keystroke was FORWARDED to the focused pane — ↓/Esc did nothing
        // and typing a session name ran it as a shell command. Assert the overlay consumes the key.
        let (mut model, _remote_id) = model_with_session_picker_open();
        model.fill_session_picker(
            &_remote_id,
            Ok(vec![
                supervisor::SessionPickerItem {
                    name: None,
                    label: "default".into(),
                    running: true,
                    is_current: false,
                },
                supervisor::SessionPickerItem {
                    name: Some("work".into()),
                    label: "work".into(),
                    running: true,
                    is_current: false,
                },
            ]),
        );
        let mut compositor = compositor::ClientCompositor::new(26);

        // ↓ moves the highlight and is NOT forwarded.
        let before = model.session_picker().unwrap().selected;
        let dispatch =
            dispatch_composited_input(b"\x1b[B".to_vec(), &mut compositor, &mut model, (60, 16));
        assert_eq!(dispatch, ClientInputDispatch::Redraw);
        assert!(
            !matches!(dispatch, ClientInputDispatch::Forward(_)),
            "a picker keystroke must never reach the pane"
        );
        assert_eq!(model.session_picker().unwrap().selected, before + 1);

        // Esc closes it and is NOT forwarded.
        let dispatch =
            dispatch_composited_input(b"\x1b".to_vec(), &mut compositor, &mut model, (60, 16));
        assert_eq!(dispatch, ClientInputDispatch::Redraw);
        assert!(model.session_picker().is_none(), "esc closes the picker");
    }

    #[test]
    fn new_session_form_owns_the_keyboard_instead_of_the_pane() {
        // REGRESSION (D1): typing `demo` into this overlay used to leak to the shell
        // (`zsh: command not found: demo`) because the gate did not know the overlay existed.
        let (mut model, _remote_id) = model_with_session_picker_open();
        model.fill_session_picker(&_remote_id, Ok(Vec::new()));
        // The only row is the trailing `+ new session…`.
        model.select_session_picker_row(0);
        assert!(model.new_session_form().is_some());
        let mut compositor = compositor::ClientCompositor::new(26);

        for ch in b"demo" {
            let dispatch =
                dispatch_composited_input(vec![*ch], &mut compositor, &mut model, (60, 16));
            assert_eq!(dispatch, ClientInputDispatch::Redraw);
            assert!(
                !matches!(dispatch, ClientInputDispatch::Forward(_)),
                "a new-session keystroke must never reach the pane"
            );
        }
        assert_eq!(
            model.new_session_form().map(|form| form.name.as_str()),
            Some("demo"),
            "the typed name lands in the field, not in the user's shell"
        );
    }

    #[test]
    fn failed_set_session_surfaces_a_message_and_keeps_the_pinned_session() {
        // REGRESSION (D2): a server-rejected `remote.set_session` (e.g. duplicate_remote_target) was
        // swallowed — the picker closed, nothing changed, no message anywhere.
        let (model, remote_id) = mixed_remote_model();
        let mut state = test_client_state_with_model(model);
        let mut server_writes: HashMap<supervisor::ServerId, ServerWriteHandle> = HashMap::new();
        let (event_tx, _event_rx) = tokio::sync::mpsc::channel(8);
        let before = state
            .supervisor_model
            .as_ref()
            .and_then(|model| model.server_session(&remote_id));

        apply_remote_manage_request_finished(
            &mut state,
            &mut server_writes,
            RemoteManageAction::SetSession {
                session: Some("work".into()),
            },
            "remote-x",
            Err("remote target already exists".to_string()),
            &event_tx,
        );

        let model = state.supervisor_model.as_ref().unwrap();
        let outcome = model
            .update_outcome_for(&remote_id)
            .expect("a rejected session switch is surfaced on the host banner");
        assert!(!outcome.success);
        assert!(
            outcome.message.contains("session switch")
                && outcome.message.contains("remote target already exists"),
            "the banner carries the server's reason: {}",
            outcome.message
        );
        // …and the pinned session is untouched, with no teardown/reconnect scheduled.
        assert_eq!(model.server_session(&remote_id), before);
        assert!(!state.secondary_retries.contains_key(&remote_id));
    }

    #[test]
    fn composited_input_clicking_menu_opens_client_global_menu() {
        let (mut model, _) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);

        let dispatch = dispatch_composited_input(
            b"\x1b[<0;24;8M".to_vec(),
            &mut compositor,
            &mut model,
            (60, 16),
        );

        assert_eq!(dispatch, ClientInputDispatch::Redraw);
        assert_eq!(model.client_menu().map(|m| m.selected), Some(0));
    }

    #[test]
    fn composited_moved_over_open_global_menu_moves_highlight() {
        // item 7 / #56: motion over the open client menu moves the highlight to the hovered row
        // (mirrors the monolithic host) and repaints; identical motion coalesces; motion off the menu
        // leaves the highlight put. The menu stays open throughout (motion never activates or closes
        // it). #56: a selection-only move is now `HoverRedraw` (recompose from the cached hover-less
        // shell + overlay the selected row), NOT `Redraw` (which rebuilt the whole shell behind it).
        let (mut model, _) = mixed_remote_model();
        model.open_client_global_menu(0, 0);
        assert_eq!(model.client_menu().map(|m| m.selected), Some(0));
        let mut compositor = compositor::ClientCompositor::new(26);
        let host = (60u16, 16u16);

        // motion onto menu row index 1 moves the highlight 0 → 1 and repaints (launcher keeps its
        // original `global_menu_rect` dropdown geometry, so row i sits at y = rect.y + 1 + i).
        assert_eq!(
            dispatch_composited_input(moved_bytes(21, 2), &mut compositor, &mut model, host),
            ClientInputDispatch::HoverRedraw
        );
        assert_eq!(model.client_menu().map(|m| m.selected), Some(1));
        // a second identical motion is coalesced (no change) → Consumed.
        assert_eq!(
            dispatch_composited_input(moved_bytes(21, 2), &mut compositor, &mut model, host),
            ClientInputDispatch::Consumed
        );
        // motion onto row index 2 moves the highlight 1 → 2.
        assert_eq!(
            dispatch_composited_input(moved_bytes(21, 3), &mut compositor, &mut model, host),
            ClientInputDispatch::HoverRedraw
        );
        assert_eq!(model.client_menu().map(|m| m.selected), Some(2));
        // motion off the menu (far-left column) leaves the highlight put → Consumed.
        assert_eq!(
            dispatch_composited_input(moved_bytes(1, 2), &mut compositor, &mut model, host),
            ClientInputDispatch::Consumed
        );
        assert_eq!(model.client_menu().map(|m| m.selected), Some(2));
    }

    #[test]
    fn composited_input_clicking_client_global_menu_dispatches_server_actions() {
        let (mut model, _) = mixed_remote_model();
        model.open_client_global_menu(0, 0);
        let mut compositor = compositor::ClientCompositor::new(26);

        // The launcher keeps its original `global_menu_rect` dropdown geometry, so row i sits at
        // SGR row (rect.y + 1 + i + 1): settings idx0 → SGR row 2, keybinds idx1 → 3, reload idx2 → 4…
        let settings = dispatch_composited_input(
            b"\x1b[<0;22;2M".to_vec(),
            &mut compositor,
            &mut model,
            (60, 16),
        );

        assert_eq!(
            settings,
            ClientInputDispatch::ServerControl {
                server_id: supervisor::ServerId::main(),
                message: ClientMessage::OpenSettings,
            }
        );

        model.open_client_global_menu(0, 0);
        let keybinds = dispatch_composited_input(
            b"\x1b[<0;22;3M".to_vec(),
            &mut compositor,
            &mut model,
            (60, 16),
        );

        assert_eq!(
            keybinds,
            ClientInputDispatch::ServerControl {
                server_id: supervisor::ServerId::main(),
                message: ClientMessage::OpenKeybindHelp,
            }
        );

        model.open_client_global_menu(0, 0);
        let reload = dispatch_composited_input(
            b"\x1b[<0;22;4M".to_vec(),
            &mut compositor,
            &mut model,
            (60, 16),
        );

        assert_eq!(
            reload,
            ClientInputDispatch::ApiRequest {
                server_id: supervisor::ServerId::main(),
                refresh: ClientApiRefreshPolicy::Immediate,
                request: Box::new(crate::api::schema::Request {
                    id: "client:reload-config".into(),
                    method: crate::api::schema::Method::ServerReloadConfig(
                        crate::api::schema::EmptyParams::default(),
                    ),
                }),
            }
        );

        model.open_client_global_menu(0, 0);
        let detach = dispatch_composited_input(
            b"\x1b[<0;22;5M".to_vec(),
            &mut compositor,
            &mut model,
            (60, 16),
        );

        assert_eq!(detach, ClientInputDispatch::DetachAll);
    }

    #[test]
    fn composited_global_menu_settings_targets_and_activates_main_when_remote_is_active() {
        let (mut model, remote_id) = mixed_remote_model();
        model
            .focus_workspace_route(&remote_id, "remote-api")
            .api_request("client:workspace-focus")
            .unwrap();
        assert_eq!(model.active_server_id(), &remote_id);

        model.open_client_global_menu(0, 0);
        let mut compositor = compositor::ClientCompositor::new(26);
        // settings (idx0) sits at the launcher's first dropdown row → SGR row 2.
        let dispatch = dispatch_composited_input(
            b"\x1b[<0;22;2M".to_vec(),
            &mut compositor,
            &mut model,
            (60, 16),
        );

        assert_eq!(
            dispatch,
            ClientInputDispatch::ServerControl {
                server_id: supervisor::ServerId::main(),
                message: ClientMessage::OpenSettings,
            }
        );
        assert_eq!(model.active_server_id(), &supervisor::ServerId::main());
    }

    #[test]
    fn composited_input_dragging_sidebar_divider_resizes_content() {
        let (mut model, _) = mixed_remote_model();
        let mut compositor = compositor::ClientCompositor::new(26);

        assert_eq!(
            dispatch_composited_input(
                b"\x1b[<0;26;5M".to_vec(),
                &mut compositor,
                &mut model,
                (80, 24),
            ),
            ClientInputDispatch::Redraw
        );
        assert_eq!(
            dispatch_composited_input(
                b"\x1b[<32;31;5M".to_vec(),
                &mut compositor,
                &mut model,
                (80, 24),
            ),
            ClientInputDispatch::Resize { cols: 49, rows: 24 }
        );
        assert_eq!(compositor.sidebar_width(), 31);
    }

    #[test]
    fn composited_client_keeps_mouse_capture_enabled_for_sidebar() {
        assert!(desired_mouse_capture(false, true));
        assert!(desired_mouse_capture(true, true));
        assert!(desired_mouse_capture(true, false));
        assert!(!desired_mouse_capture(false, false));
    }

    #[test]
    fn composited_input_add_remote_form_submits_draft() {
        let (mut model, _) = mixed_remote_model();
        model.open_add_remote_form();
        let mut compositor = compositor::ClientCompositor::new(12);

        assert_eq!(
            dispatch_composited_input(b"local:dev".to_vec(), &mut compositor, &mut model, (24, 8)),
            ClientInputDispatch::Redraw
        );
        assert_eq!(
            dispatch_composited_input(b"\tdev".to_vec(), &mut compositor, &mut model, (24, 8)),
            ClientInputDispatch::Redraw
        );

        let dispatch =
            dispatch_composited_input(b"\r".to_vec(), &mut compositor, &mut model, (24, 8));

        assert_eq!(
            dispatch,
            ClientInputDispatch::AddRemote(supervisor::AddRemoteDraft {
                target: "local:dev".into(),
                name: Some("dev".into()),
                session: None,
                keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            })
        );
    }

    #[test]
    fn api_target_for_supervisor_server_maps_main_and_local_secondary() {
        let (model, remote_id) = mixed_remote_model();

        assert_eq!(
            api_target_for_supervisor_server(
                &model,
                &supervisor::ServerId::main(),
                &HashMap::new()
            ),
            Some(crate::api::client::ConnectionTarget::LocalSession(None))
        );
        assert_eq!(
            api_target_for_supervisor_server(&model, &remote_id, &HashMap::new()),
            Some(crate::api::client::ConnectionTarget::LocalSession(Some(
                "x".into()
            )))
        );
    }

    #[test]
    fn supervisor_targets_map_ssh_secondary_through_bridge_sockets() {
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-prod".into(),
            name: "prod".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Ssh {
                target: "prod.example.com".into(),
                args: Vec::new(),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        let api_socket = std::path::PathBuf::from("/tmp/herdr-prod-api.sock");
        let client_socket = std::path::PathBuf::from("/tmp/herdr-prod-client.sock");
        let bridge = crate::remote::RemoteBridge::from_socket_paths_for_test(
            client_socket.clone(),
            api_socket.clone(),
        );
        let ssh_bridges = HashMap::from([(remote_id.clone(), bridge)]);

        assert_eq!(
            api_target_for_supervisor_server(&model, &remote_id, &ssh_bridges),
            Some(crate::api::client::ConnectionTarget::SocketPath(api_socket))
        );
        assert_eq!(
            client_socket_path_for_supervisor_server(&model, &remote_id, &ssh_bridges),
            Some(client_socket)
        );
    }

    #[test]
    fn client_supervisor_request_allows_ssh_bridge_latency() {
        let socket_dir = std::env::temp_dir().join(format!(
            "herdr-delayed-api-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&socket_dir).unwrap();
        let api_socket = socket_dir.join("api.sock");
        let client_socket = socket_dir.join("client.sock");
        let listener = std::os::unix::net::UnixListener::bind(&api_socket).unwrap();

        let api_thread = std::thread::spawn(move || {
            let (mut stream, _addr) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            std::io::BufRead::read_line(&mut reader, &mut request_line).unwrap();
            assert!(request_line.contains("\"ping\""));
            std::thread::sleep(Duration::from_millis(750));
            let _ = writeln!(
                stream,
                "{{\"id\":\"delayed\",\"result\":{{\"type\":\"pong\",\"version\":\"0.6.4\",\"protocol\":{}}}}}",
                PROTOCOL_VERSION
            );
        });

        let mut model = supervisor::ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-prod".into(),
            name: "prod".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Ssh {
                target: "prod.example.com".into(),
                args: Vec::new(),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        let bridge =
            crate::remote::RemoteBridge::from_socket_paths_for_test(client_socket, api_socket);
        let ssh_bridges = HashMap::from([(remote_id.clone(), bridge)]);
        let request = crate::api::schema::Request {
            id: "delayed".into(),
            method: crate::api::schema::Method::Ping(crate::api::schema::PingParams::default()),
        };

        let result = send_client_supervisor_request(&model, &remote_id, request, &ssh_bridges);

        api_thread.join().unwrap();
        std::fs::remove_dir_all(&socket_dir).unwrap();
        assert!(
            result.is_ok(),
            "SSH bridge API requests should tolerate sub-second remote latency: {result:?}"
        );
    }

    #[test]
    fn secondary_summary_refresh_returns_within_sixty_fps_budget_when_remote_is_slow() {
        let socket_dir = std::path::PathBuf::from("/tmp").join(format!(
            "hsum-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&socket_dir).unwrap();
        let api_socket = socket_dir.join("api.sock");
        let client_socket = socket_dir.join("client.sock");
        let listener = std::os::unix::net::UnixListener::bind(&api_socket).unwrap();

        let api_thread = std::thread::spawn(move || {
            let (mut stream, _addr) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            std::io::BufRead::read_line(&mut reader, &mut request_line).unwrap();
            assert!(request_line.contains("\"ping\""));
            std::thread::sleep(Duration::from_millis(750));
            let _ = writeln!(
                stream,
                "{{\"id\":\"client-supervisor:status\",\"result\":{{\"type\":\"pong\",\"version\":\"0.6.4\",\"protocol\":{}}}}}",
                PROTOCOL_VERSION
            );
        });

        let mut model = supervisor::ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-prod".into(),
            name: "prod".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Ssh {
                target: "prod.example.com".into(),
                args: Vec::new(),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        let bridge =
            crate::remote::RemoteBridge::from_socket_paths_for_test(client_socket, api_socket);
        let ssh_bridges = HashMap::from([(remote_id.clone(), bridge)]);
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);
        let mut pending = HashSet::new();

        let started_at = Instant::now();
        start_secondary_supervisor_summary_refreshes(&model, &ssh_bridges, &mut pending, &event_tx);
        let elapsed = started_at.elapsed();

        assert!(
            elapsed <= CLIENT_60FPS_FRAME_BUDGET,
            "starting a slow remote summary refresh blocked the UI thread for {elapsed:?}, about {:.1} fps",
            fps_for_frame_duration(elapsed)
        );
        assert!(pending.contains(&remote_id));
        assert!(event_rx.try_recv().is_err());

        // #61: the worker now surfaces the runtime version/protocol captured from the same Ping the
        // summary fetch already issues (previously discarded) — posted FIRST, then the summary result.
        let first = event_rx.blocking_recv().unwrap();
        match first {
            ClientLoopEvent::SupervisorRuntimeStatusFetched {
                server_id,
                version,
                protocol,
            } => {
                assert_eq!(server_id, remote_id);
                assert_eq!(version.as_deref(), Some("0.6.4"));
                assert_eq!(protocol, Some(PROTOCOL_VERSION));
            }
            _ => panic!("expected the runtime-status result first"),
        }
        let second = event_rx.blocking_recv().unwrap();
        match second {
            ClientLoopEvent::SupervisorSummaryFetched { server_id, .. } => {
                assert_eq!(server_id, remote_id);
            }
            _ => panic!("expected the async summary result"),
        }

        api_thread.join().unwrap();
        std::fs::remove_dir_all(&socket_dir).unwrap();
    }

    #[test]
    fn client_supervisor_api_request_returns_within_sixty_fps_budget_when_remote_is_slow() {
        let socket_dir = std::path::PathBuf::from("/tmp").join(format!(
            "hact-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&socket_dir).unwrap();
        let api_socket = socket_dir.join("api.sock");
        let client_socket = socket_dir.join("client.sock");
        let listener = std::os::unix::net::UnixListener::bind(&api_socket).unwrap();

        let api_thread = std::thread::spawn(move || {
            let (mut stream, _addr) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            std::io::BufRead::read_line(&mut reader, &mut request_line).unwrap();
            assert!(request_line.contains("\"workspace.focus\""));
            std::thread::sleep(Duration::from_millis(750));
            let _ = writeln!(
                stream,
                "{{\"id\":\"client:workspace-focus\",\"result\":{{\"type\":\"ok\"}}}}"
            );
        });

        let mut model = supervisor::ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(crate::remote_registry::RemoteDefinitionSnapshot {
            id: "remote-prod".into(),
            name: "prod".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Ssh {
                target: "prod.example.com".into(),
                args: Vec::new(),
            },
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        });
        let bridge =
            crate::remote::RemoteBridge::from_socket_paths_for_test(client_socket, api_socket);
        let ssh_bridges = HashMap::from([(remote_id.clone(), bridge)]);
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);
        let request = crate::api::schema::Request {
            id: "client:workspace-focus".into(),
            method: crate::api::schema::Method::WorkspaceFocus(
                crate::api::schema::WorkspaceTarget {
                    workspace_id: "remote-api".into(),
                },
            ),
        };

        let started_at = Instant::now();
        let result = spawn_client_supervisor_request(
            &model,
            remote_id.clone(),
            ClientApiRefreshPolicy::Deferred,
            request,
            &ssh_bridges,
            &event_tx,
        );
        let elapsed = started_at.elapsed();

        assert!(result.is_ok());
        assert!(
            elapsed <= CLIENT_60FPS_FRAME_BUDGET,
            "starting a slow remote API action blocked the UI thread for {elapsed:?}, about {:.1} fps",
            fps_for_frame_duration(elapsed)
        );
        assert!(event_rx.try_recv().is_err());

        let event = event_rx.blocking_recv().unwrap();
        match event {
            ClientLoopEvent::SupervisorApiRequestFinished {
                server_id, result, ..
            } => {
                assert_eq!(server_id, remote_id);
                assert!(result.is_ok());
            }
            _ => panic!("expected async API result"),
        }

        api_thread.join().unwrap();
        std::fs::remove_dir_all(&socket_dir).unwrap();
    }

    #[test]
    fn secondary_connection_retry_returns_within_sixty_fps_budget_when_handshake_is_slow() {
        let _guard = env_lock().lock().unwrap();
        let config_home = std::path::PathBuf::from("/tmp").join(format!(
            "hcfg-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let _config_env = EnvVarGuard::set("XDG_CONFIG_HOME", config_home.to_str().unwrap());
        let client_socket = crate::session::client_socket_path_for(Some("slow"));
        std::fs::create_dir_all(client_socket.parent().unwrap()).unwrap();
        let listener = std::os::unix::net::UnixListener::bind(&client_socket).unwrap();

        let server_thread = std::thread::spawn(move || {
            let (mut stream, _addr) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(750));
            protocol::write_message(
                &mut stream,
                &ServerMessage::Welcome {
                    version: PROTOCOL_VERSION,
                    encoding: RenderEncoding::SemanticFrame,
                    error: None,
                },
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(250));
        });

        let mut model = supervisor::ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(test_remote_definition("slow", "slow"));
        let mut state = test_client_state_with_model(model);
        let now = Instant::now();
        state.secondary_retries.insert(
            remote_id.clone(),
            SecondaryRetryState {
                attempt: 0,
                next_retry_at: now,
            },
        );
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);
        let should_quit = Arc::new(AtomicBool::new(false));
        let mut server_writes = HashMap::new();

        let started_at = Instant::now();
        retry_due_secondary_connections(&mut state, now, &event_tx, &mut server_writes);
        let elapsed = started_at.elapsed();

        assert!(
            elapsed <= CLIENT_60FPS_FRAME_BUDGET,
            "starting a slow secondary reconnect blocked the UI thread for {elapsed:?}, about {:.1} fps",
            fps_for_frame_duration(elapsed)
        );
        assert!(state
            .pending_secondary_connect_server_ids
            .contains(&remote_id));
        assert!(event_rx.try_recv().is_err());

        let event = event_rx.blocking_recv().unwrap();
        match event {
            ClientLoopEvent::SecondaryConnectionAttemptFinished {
                server_id, result, ..
            } => {
                assert_eq!(server_id, remote_id);
                if let Err(err) = &result {
                    panic!(
                        "secondary reconnect should complete after the delayed handshake: {err:?}"
                    );
                }
            }
            _ => panic!("expected async secondary connection result"),
        }

        should_quit.store(true, Ordering::Release);
        server_thread.join().unwrap();
        std::fs::remove_file(client_socket).ok();
        std::fs::remove_dir_all(config_home).ok();
    }

    #[test]
    fn add_remote_submission_returns_within_sixty_fps_budget_when_remote_is_slow() {
        let _guard = env_lock().lock().unwrap();
        let config_home = std::path::PathBuf::from("/tmp").join(format!(
            "hadd-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let _config_env = EnvVarGuard::set("XDG_CONFIG_HOME", config_home.to_str().unwrap());
        let _session_env = EnvVarsRemovedGuard::new(&[
            crate::session::SESSION_ENV_VAR,
            crate::api::SOCKET_PATH_ENV_VAR,
            crate::server::socket_paths::CLIENT_SOCKET_PATH_ENV_VAR,
        ]);
        let main_api_socket = crate::api::socket_path();
        std::fs::create_dir_all(main_api_socket.parent().unwrap()).unwrap();
        let main_api_listener = std::os::unix::net::UnixListener::bind(&main_api_socket).unwrap();

        // The registration worker only talks to the LOCAL main API (`remote.add`) — provisioning
        // happens later in the retry sweep — so a slow registry response is the only thing that
        // could block. Delay it past a frame budget to prove the spawn itself never blocks.
        let main_api_thread = std::thread::spawn(move || {
            let (mut stream, _addr) = main_api_listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            std::io::BufRead::read_line(&mut reader, &mut request_line).unwrap();
            assert!(request_line.contains("\"remote.add\""));
            std::thread::sleep(Duration::from_millis(250));
            let _ = writeln!(
                stream,
                "{{\"id\":\"client:remote-add\",\"result\":{{\"type\":\"remote_added\",\"remote\":{{\"id\":\"remote-slowadd\",\"name\":\"slowadd\",\"target\":{{\"type\":\"local\",\"session\":\"slowadd\"}},\"keybindings\":\"local\"}}}}}}"
            );
        });

        let draft = supervisor::AddRemoteDraft {
            target: "local:slowadd".into(),
            name: Some("slowadd".into()),
            session: None,
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
        };
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);
        let mut pending_add_remote = false;

        let started_at = Instant::now();
        spawn_client_add_remote_submission(draft, &event_tx, &mut pending_add_remote);
        let elapsed = started_at.elapsed();

        assert!(pending_add_remote);
        assert!(
            elapsed <= CLIENT_60FPS_FRAME_BUDGET,
            "starting a slow add-remote submission blocked the UI thread for {elapsed:?}, about {:.1} fps",
            fps_for_frame_duration(elapsed)
        );
        assert!(event_rx.try_recv().is_err());

        let event = event_rx.blocking_recv().unwrap();
        match event {
            ClientLoopEvent::AddRemoteFinished { result, .. } => {
                let remote = result.expect("registration should succeed");
                assert_eq!(remote.id, "remote-slowadd");
            }
            _ => panic!("expected async add-remote result"),
        }

        main_api_thread.join().unwrap();
        std::fs::remove_dir_all(config_home).ok();
    }

    #[test]
    fn progress_runner_resets_idle_timeout_on_each_stage() {
        use crate::remote::RemoteProvisionStage;
        use std::sync::{Arc, Mutex};

        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_cb = seen.clone();
        let on_progress = move |stage: RemoteProvisionStage| seen_cb.lock().unwrap().push(stage);

        // Three stages, each spaced 150ms apart — under the 400ms idle window, but the ~450ms total
        // exceeds it, so this only succeeds because each progress event resets the deadline.
        //
        // The window is deliberately ~2.7x the per-stage gap (not the old 2x of 40ms/80ms): under
        // load a CI runner's `sleep(gap)` can overrun by well over the gap itself, and a too-tight
        // window then fires a spurious idle timeout before the next stage lands (a macOS-CI flake).
        // Keep `gap < window < 3*gap` so the reset is still exercised, with a large absolute margin.
        let result: Result<u32, RemoteOpError> =
            run_remote_op_with_progress(Duration::from_millis(400), &on_progress, |sink| {
                for stage in [
                    RemoteProvisionStage::Connecting,
                    RemoteProvisionStage::Installing,
                    RemoteProvisionStage::Verifying,
                ] {
                    std::thread::sleep(Duration::from_millis(150));
                    sink(stage);
                }
                Ok(42)
            });

        assert_eq!(result.unwrap(), 42);
        assert_eq!(
            seen.lock().unwrap().len(),
            3,
            "all stages forwarded to the UI"
        );
    }

    #[test]
    fn progress_runner_times_out_naming_the_last_stage() {
        use crate::remote::RemoteProvisionStage;

        let result: Result<u32, RemoteOpError> =
            run_remote_op_with_progress(Duration::from_millis(60), &|_| {}, |sink| {
                sink(RemoteProvisionStage::Installing);
                std::thread::sleep(Duration::from_millis(400)); // stall past the idle window
                Ok(0)
            });

        match result {
            Err(RemoteOpError::TimedOut { stage, .. }) => assert_eq!(
                stage.as_deref(),
                Some("installing herdr on the remote…"),
                "the timeout should blame the stalled stage, not the connect"
            ),
            other => panic!("expected idle timeout, got {other:?}"),
        }

        // And that timeout maps to a truthful, stage-named error message.
        let io_err = remote_op_error_io(RemoteOpError::TimedOut {
            idle: Duration::from_secs(90),
            stage: Some("installing herdr on the remote…".to_string()),
        });
        let msg = io_err.to_string();
        assert!(msg.contains("installing herdr on the remote"), "got: {msg}");
        assert!(msg.contains("no progress for 90s"), "got: {msg}");
    }

    #[test]
    fn server_writer_queue_returns_within_sixty_fps_budget_when_socket_write_is_slow() {
        let socket_path = std::path::PathBuf::from("/tmp").join(format!(
            "herdr-writer-budget-{}-{}.sock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_file(&socket_path);
        let listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
        // Accept and hold the server end without ever reading, so the kernel socket buffer fills and
        // a large client write blocks the writer thread (the condition this test exercises).
        let accept_thread = std::thread::spawn(move || listener.accept().map(|(stream, _)| stream));
        let client_stream = crate::ipc::connect_local_stream(&socket_path).unwrap();
        let server_stream = accept_thread.join().unwrap().unwrap();
        let (event_tx, _event_rx) = tokio::sync::mpsc::channel(8);
        let handle = spawn_server_writer(supervisor::ServerId::main(), client_stream, event_tx);
        let large_message = ClientMessage::ClipboardImage {
            extension: "png".into(),
            data: vec![7; MAX_CLIPBOARD_IMAGE_PAYLOAD],
        };

        queue_to_server(&handle, large_message).unwrap();
        std::thread::sleep(Duration::from_millis(20));

        let started_at = Instant::now();
        queue_to_server(
            &handle,
            ClientMessage::Input {
                data: b"x".to_vec(),
            },
        )
        .unwrap();
        let elapsed = started_at.elapsed();

        assert!(
            elapsed <= CLIENT_60FPS_FRAME_BUDGET,
            "queueing while a server writer is blocked took {elapsed:?}, about {:.1} fps",
            fps_for_frame_duration(elapsed)
        );
        drop(server_stream);
        let _ = std::fs::remove_file(&socket_path);
    }

    #[test]
    fn startup_secondary_connects_return_within_sixty_fps_budget_when_handshake_is_slow() {
        let _guard = env_lock().lock().unwrap();
        let config_home = std::path::PathBuf::from("/tmp").join(format!(
            "hstart-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let _config_env = EnvVarGuard::set("XDG_CONFIG_HOME", config_home.to_str().unwrap());
        let client_socket = crate::session::client_socket_path_for(Some("slowstart"));
        std::fs::create_dir_all(client_socket.parent().unwrap()).unwrap();
        let listener = std::os::unix::net::UnixListener::bind(&client_socket).unwrap();

        listener.set_nonblocking(true).unwrap();
        let server_thread = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(100);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _addr)) => {
                        std::thread::sleep(Duration::from_millis(750));
                        protocol::write_message(
                            &mut stream,
                            &ServerMessage::Welcome {
                                version: PROTOCOL_VERSION,
                                encoding: RenderEncoding::SemanticFrame,
                                error: None,
                            },
                        )
                        .unwrap();
                        std::thread::sleep(Duration::from_millis(250));
                        return;
                    }
                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(err) => panic!("startup secondary listener failed: {err}"),
                }
            }
        });

        let mut model = supervisor::ClientSupervisorModel::new("local");
        model.add_secondary(test_remote_definition("slowstart", "slowstart"));
        let mut ssh_bridges = HashMap::new();

        let started_at = Instant::now();
        let streams =
            connect_secondary_client_streams(&mut model, (80, 24), 0, 0, &mut ssh_bridges);
        let elapsed = started_at.elapsed();

        assert!(streams.is_empty());
        assert!(
            elapsed <= CLIENT_60FPS_FRAME_BUDGET,
            "startup secondary connection blocked for {elapsed:?}, about {:.1} fps",
            fps_for_frame_duration(elapsed)
        );

        drop(streams);
        server_thread.join().unwrap();
        std::fs::remove_file(client_socket).ok();
        std::fs::remove_dir_all(config_home).ok();
    }

    #[test]
    fn frame_stats_calculate_render_fps_from_frame_duration() {
        let mut stats = ClientFrameStats::default();
        let sample = stats.record_render_duration(Duration::from_micros(16_667));

        assert!((sample.render_fps - 60.0).abs() < 0.1);
        assert_eq!(sample.render_duration, Duration::from_micros(16_667));
        assert!(!sample.missed_sixty_fps_budget);

        let slow = stats.record_render_duration(Duration::from_millis(25));
        assert!(slow.render_fps < 60.0);
        assert!(slow.missed_sixty_fps_budget);
    }

    #[test]
    fn frame_stats_use_stable_fps_for_zero_duration_frames() {
        let mut stats = ClientFrameStats::default();
        let sample = stats.record_render_duration(Duration::ZERO);

        assert_eq!(sample.render_fps, f64::INFINITY);
        assert!(!sample.missed_sixty_fps_budget);
    }

    #[test]
    fn supervisor_summary_refresh_due_uses_two_second_interval() {
        let start = Instant::now();

        assert!(!supervisor_summary_refresh_due(
            start + Duration::from_millis(1999),
            start
        ));
        assert!(supervisor_summary_refresh_due(
            start + Duration::from_secs(2),
            start
        ));
    }

    #[test]
    fn secondary_retry_delay_uses_conservative_backoff_schedule() {
        assert_eq!(secondary_retry_delay(0), Duration::from_secs(1));
        assert_eq!(secondary_retry_delay(1), Duration::from_secs(2));
        assert_eq!(secondary_retry_delay(2), Duration::from_secs(5));
        assert_eq!(secondary_retry_delay(3), Duration::from_secs(15));
        assert_eq!(secondary_retry_delay(8), Duration::from_secs(15));
    }

    #[test]
    fn client_socket_path_for_connection_target_maps_local_sessions_only() {
        let named = client_socket_path_for_connection_target(
            &supervisor::ServerConnectionTarget::LocalSession(Some("work".into())),
        )
        .unwrap();
        assert!(named.ends_with("sessions/work/herdr-client.sock"));

        let default =
            client_socket_path_for_connection_target(&supervisor::ServerConnectionTarget::Main)
                .unwrap();
        assert!(default.ends_with("herdr-client.sock"));

        assert_eq!(
            client_socket_path_for_connection_target(&supervisor::ServerConnectionTarget::Ssh {
                destination: "host".into(),
                options: Vec::new(),
                session: None,
            }),
            None
        );
    }

    fn test_frame(width: u16) -> protocol::FrameData {
        protocol::FrameData {
            cells: Vec::new(),
            width,
            height: 1,
            cursor: None,
            hyperlinks: Vec::new(),
            graphics: Vec::new(),
        }
    }

    #[test]
    fn select_composited_render_frame_requires_active_server_cache() {
        let main = supervisor::ServerId::main();
        let remote = supervisor::ServerId::secondary("remote-x");
        let mut frames = std::collections::HashMap::new();
        frames.insert(main.clone(), test_frame(10));
        frames.insert(remote.clone(), test_frame(20));

        assert_eq!(
            select_composited_render_frame(&frames, &remote, &main)
                .unwrap()
                .width,
            20
        );

        let missing = supervisor::ServerId::secondary("missing");
        assert_eq!(
            select_composited_render_frame(&frames, &missing, &main),
            None
        );
    }

    #[test]
    fn background_server_frame_is_cached_but_not_rendered() {
        // #15 (part b): a frame from a NON-active server updates the cache (so a later focus switch
        // can paint it instantly) but must NOT trigger a compose/encode/flush — only the active
        // server renders. `frame_stats.last_render_duration` is the render observable.
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(test_remote_definition("remote-x", "x"));
        model
            .set_active_server(supervisor::ServerId::main())
            .unwrap();
        let mut state = test_client_state_with_model(model);
        state.compositor = Some(compositor::ClientCompositor::new(26));

        // Background (remote) frame: cached, but no render.
        render_incoming_server_frame(&mut state, &remote_id, test_frame(20));
        assert!(
            state.frame_cache.contains_key(&remote_id),
            "background frame must still be cached for instant switch"
        );
        assert!(
            state.frame_stats.last_render_duration.is_none(),
            "a background server's frame must not be composed/encoded/flushed"
        );

        // Active (main) frame: cached AND rendered.
        let main = supervisor::ServerId::main();
        render_incoming_server_frame(&mut state, &main, test_frame(30));
        assert!(state.frame_cache.contains_key(&main));
        assert!(
            state.frame_stats.last_render_duration.is_some(),
            "the active server's frame renders"
        );
    }

    #[test]
    fn secondary_write_failure_disconnects_server_without_failing_client() {
        let now = Instant::now();
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(test_remote_definition("remote-x", "x"));
        model.set_active_server(remote_id.clone()).unwrap();
        let mut state = test_client_state_with_model(model);
        state.frame_cache.insert(remote_id.clone(), test_frame(8));
        state
            .summary_subscription_server_ids
            .insert(remote_id.clone());
        let mut server_writes = HashMap::new();

        let result = handle_server_write_failure(
            &mut state,
            &mut server_writes,
            remote_id.clone(),
            io::Error::new(io::ErrorKind::BrokenPipe, "secondary closed"),
            now,
        );

        assert!(result.is_ok());
        // #36: the last frame is PRESERVED across an involuntary disconnect (so the greyed host can
        // still paint its last screen / be copied, and reconnect has no blank flash).
        assert!(state.frame_cache.contains_key(&remote_id));
        assert!(!state.summary_subscription_server_ids.contains(&remote_id));
        assert_eq!(
            state.supervisor_model.as_ref().unwrap().active_server_id(),
            &supervisor::ServerId::main()
        );
        assert_eq!(
            state
                .secondary_retries
                .get(&remote_id)
                .map(|retry| retry.next_retry_at),
            Some(now + secondary_retry_delay(0))
        );
    }

    #[test]
    fn main_write_failure_still_fails_client() {
        let mut state =
            test_client_state_with_model(supervisor::ClientSupervisorModel::new("local"));
        let mut server_writes = HashMap::new();

        let result = handle_server_write_failure(
            &mut state,
            &mut server_writes,
            supervisor::ServerId::main(),
            io::Error::new(io::ErrorKind::BrokenPipe, "main closed"),
            Instant::now(),
        );

        assert!(matches!(result, Err(ClientError::ConnectionLost(_))));
        assert!(state.secondary_retries.is_empty());
    }

    #[test]
    fn schedule_missing_secondary_stream_retries_includes_new_connecting_servers() {
        let now = Instant::now();
        let mut model = supervisor::ClientSupervisorModel::new("local");
        model.sync_remote_registry(vec![test_remote_definition("remote-x", "x")]);
        let remote_id = supervisor::ServerId::secondary("remote-x");
        let mut state = test_client_state_with_model(model);
        let server_writes = HashMap::new();

        schedule_missing_secondary_stream_retries(&mut state, &server_writes, now);

        assert_eq!(
            state
                .secondary_retries
                .get(&remote_id)
                .map(|retry| retry.next_retry_at),
            Some(now)
        );
    }

    #[test]
    fn schedule_missing_secondary_stream_retries_includes_connected_server_without_stream() {
        let now = Instant::now();
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(test_remote_definition("remote-x", "x"));
        let mut state = test_client_state_with_model(model);
        let server_writes = HashMap::new();

        schedule_missing_secondary_stream_retries(&mut state, &server_writes, now);

        assert_eq!(
            state
                .secondary_retries
                .get(&remote_id)
                .map(|retry| retry.next_retry_at),
            Some(now)
        );
    }

    #[test]
    fn summary_subscription_end_guard_sends_ended_event_on_drop() {
        let server_id = supervisor::ServerId::secondary("remote-x");
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);

        drop(SummarySubscriptionEndGuard {
            server_id: server_id.clone(),
            event_tx: tx,
        });

        let event = rx.blocking_recv().expect("subscription ended event");
        assert!(matches!(
            event,
            ClientLoopEvent::SupervisorSummarySubscriptionEnded(id) if id == server_id
        ));
    }

    #[test]
    fn toast_notify_from_server_is_emitted_even_when_attach_config_was_off() {
        let sound_config = crate::config::SoundConfig::default();
        let mut emitted = None;

        handle_notify_with_notifiers(
            NotifyKind::Toast,
            "pi finished",
            Some("workspace 1"),
            &sound_config,
            |title, body| {
                emitted = Some((title.to_string(), body.map(str::to_string)));
                Ok(true)
            },
            |_, _| Ok(false),
        );

        assert_eq!(
            emitted,
            Some(("pi finished".to_string(), Some("workspace 1".to_string())))
        );
    }

    #[test]
    fn system_toast_notify_from_server_uses_system_notifier() {
        let sound_config = crate::config::SoundConfig::default();
        let mut emitted = None;

        handle_notify_with_notifiers(
            NotifyKind::SystemToast,
            "pi finished",
            Some("workspace 1"),
            &sound_config,
            |_, _| Ok(false),
            |title, body| {
                emitted = Some((title.to_string(), body.map(str::to_string)));
                Ok(true)
            },
        );

        assert_eq!(
            emitted,
            Some(("pi finished".to_string(), Some("workspace 1".to_string())))
        );
    }

    #[test]
    fn system_toast_notify_preserves_colon_in_title() {
        let sound_config = crate::config::SoundConfig::default();
        let mut emitted = None;

        handle_notify_with_notifiers(
            NotifyKind::SystemToast,
            "build: failed",
            Some("api workspace"),
            &sound_config,
            |_, _| Ok(false),
            |title, body| {
                emitted = Some((title.to_string(), body.map(str::to_string)));
                Ok(true)
            },
        );

        assert_eq!(
            emitted,
            Some((
                "build: failed".to_string(),
                Some("api workspace".to_string())
            ))
        );
    }

    #[test]
    fn decode_clipboard_payload_decodes_base64() {
        assert_eq!(decode_clipboard_payload("dGVzdA=="), Some(b"test".to_vec()));
    }

    #[test]
    fn decode_clipboard_payload_rejects_invalid_base64() {
        assert_eq!(decode_clipboard_payload("not-base64!!!"), None);
    }

    #[test]
    fn forward_clipboard_uses_local_clipboard_path() {
        unsafe {
            std::env::set_var("SSH_CONNECTION", "1 2 3 4");
        }
        forward_clipboard("dGVzdA==");
        unsafe {
            std::env::remove_var("SSH_CONNECTION");
        }
    }

    // --- item 5: client agent animation --------------------------------------------------

    /// Mixed model with one main workspace and one remote workspace whose single agent has the
    /// given `status`. Both servers connect by default, so a "working" agent makes
    /// `sidebar_wants_animation` true.
    fn animation_model(status: &str) -> (supervisor::ClientSupervisorModel, supervisor::ServerId) {
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let remote_id = model.add_secondary(test_remote_definition("remote-x", "x"));
        model
            .set_summary(
                &supervisor::ServerId::main(),
                supervisor::ServerSummary {
                    workspaces: vec![supervisor::WorkspaceSummary {
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
                supervisor::ServerSummary {
                    workspaces: vec![supervisor::WorkspaceSummary {
                        workspace_id: "remote-api".into(),
                        label: "api".into(),
                        branch: Some("feature/api".into()),
                        focused: false,
                        ..Default::default()
                    }],
                    agents: vec![supervisor::AgentSummary {
                        agent_id: "remote-agent".into(),
                        workspace_id: "remote-api".into(),
                        label: "claude".into(),
                        status: status.into(),
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
    fn client_animation_cadence_matches_visible_step_rate() {
        // Cadence is fixed by the contract: 80ms / step 8.
        assert_eq!(CLIENT_ANIMATION_INTERVAL, Duration::from_millis(80));
        assert_eq!(CLIENT_ANIMATION_TICK_STEP, 8);

        // `spinner_frame` maps SPINNERS[(tick/8) % len], so step 8 advances exactly one visible
        // spinner frame per interval. Visible-step period = INTERVAL / (STEP / 8) = 80ms / 1.
        let visible_steps_per_interval = CLIENT_ANIMATION_TICK_STEP / 8;
        assert_eq!(visible_steps_per_interval, 1);
        let visible_step_period = CLIENT_ANIMATION_INTERVAL / visible_steps_per_interval;
        assert_eq!(visible_step_period, Duration::from_millis(80));

        // Within the 64..=128ms band bounded by the server (16ms * 8 = 128ms visible period)
        // and headless (128ms / (8/8) = 128ms visible period).
        assert!(visible_step_period >= Duration::from_millis(64));
        assert!(visible_step_period <= Duration::from_millis(128));
    }

    #[test]
    fn next_select_deadline_picks_min_when_active() {
        let now = Instant::now();
        let last = now - Duration::from_millis(30);

        // Active: min(now + 100ms housekeeping, last + 80ms animation). last + 80ms = now + 50ms
        // is sooner, so it wins. (No hover render pending → hover clamp is inert.)
        let active = next_select_deadline(now, last, true, false, now);
        assert_eq!(active, last + CLIENT_ANIMATION_INTERVAL);
        assert_eq!(active, now + Duration::from_millis(50));

        // Inactive: always the 100ms housekeeping deadline (idle behavior unchanged).
        let idle = next_select_deadline(now, last, false, false, now);
        assert_eq!(idle, now + Duration::from_millis(100));

        // Active but the animation deadline is further out than housekeeping → housekeeping
        // wins. last + 80ms must exceed now + 100ms, i.e. last is >20ms in the future.
        let far_last = now + Duration::from_millis(50);
        let active_far = next_select_deadline(now, far_last, true, false, now);
        assert_eq!(active_far, now + Duration::from_millis(100));
        assert!(far_last + CLIENT_ANIMATION_INTERVAL > now + Duration::from_millis(100));
    }

    /// #48: a pending hover render clamps the select deadline to within one frame budget of the
    /// last composited frame, so the deferred (latest-wins) hover highlight flushes at ≤60fps —
    /// never the 100ms housekeeping latency, and never once-per-motion-event.
    #[test]
    fn next_select_deadline_clamps_to_frame_budget_for_pending_hover() {
        let now = Instant::now();
        let last_anim = now - Duration::from_millis(30);

        // Last composited frame was a full budget ago → flush on the very next tick (≈ now), not at
        // the 100ms housekeeping deadline.
        let stale = now - CLIENT_60FPS_FRAME_BUDGET;
        let due = next_select_deadline(now, last_anim, false, true, stale);
        assert_eq!(
            due, now,
            "an overdue pending hover must flush immediately (clamped to now)"
        );

        // Mid-budget: deadline rides last_render + one frame budget, well under 100ms housekeeping.
        let recent = now - Duration::from_millis(5);
        let soon = next_select_deadline(now, last_anim, false, true, recent);
        assert_eq!(soon, recent + CLIENT_60FPS_FRAME_BUDGET);
        assert!(soon < now + Duration::from_millis(100));

        // No hover pending → the clamp is inert (idle/animation behavior unchanged).
        let inert = next_select_deadline(now, last_anim, false, false, stale);
        assert_eq!(inert, now + Duration::from_millis(100));
    }

    #[test]
    fn prune_and_seed_working_since_inserts_then_removes() {
        let (model, remote_id) = animation_model("working");
        let mut compositor = compositor::ClientCompositor::new(26);
        let key = (remote_id.clone(), "remote-agent".to_string());

        // First upkeep with a working agent inserts a start instant.
        let t0 = Instant::now();
        prune_and_seed_working_since(&mut compositor, &model, t0);
        assert_eq!(compositor.working_since_len(), 1);
        assert_eq!(compositor.working_since_at(&key), Some(t0));

        // A second upkeep with a LATER `now` must NOT overwrite the preserved start time.
        let t1 = t0 + Duration::from_secs(5);
        prune_and_seed_working_since(&mut compositor, &model, t1);
        assert_eq!(compositor.working_since_len(), 1);
        assert_eq!(
            compositor.working_since_at(&key),
            Some(t0),
            "an already-working key must not be re-seeded to a later instant"
        );

        // After the agent leaves Working, the key is pruned.
        let (idle_model, _) = animation_model("idle");
        prune_and_seed_working_since(&mut compositor, &idle_model, t1);
        assert_eq!(compositor.working_since_len(), 0);
        assert_eq!(compositor.working_since_at(&key), None);
    }

    #[test]
    fn two_timers_within_interval_advance_tick_once() {
        let t0 = Instant::now();
        // First Timer at t0: at least one interval since `last` → advance.
        assert!(should_advance_animation(
            true,
            t0,
            t0 - CLIENT_ANIMATION_INTERVAL
        ));
        // Second Timer 40ms later (< 80ms since the just-recorded t0) → no advance (coalesced).
        assert!(!should_advance_animation(
            true,
            t0 + Duration::from_millis(40),
            t0
        ));
        // A Timer a full interval later → advance again.
        assert!(should_advance_animation(
            true,
            t0 + CLIENT_ANIMATION_INTERVAL,
            t0
        ));
    }

    #[test]
    fn no_tick_advance_when_idle() {
        // With no working agent — and the host banner animation forced Static so the banner does
        // not gate animation (item 2/C3) — the gate is false, so the animation step never runs
        // regardless of elapsed time → the tick stays put.
        let (mut idle_model, _) = animation_model("idle");
        let mut ui_settings = idle_model.ui_settings().clone();
        ui_settings.sidebar_host.animation = crate::config::HostBannerAnimation::Static;
        idle_model.set_ui_settings(ui_settings);
        assert!(!compositor::sidebar_wants_animation(&idle_model));
        let wants = compositor::sidebar_wants_animation(&idle_model);
        let t0 = Instant::now();
        assert!(!should_advance_animation(
            wants,
            t0 + Duration::from_secs(10),
            t0
        ));

        // And driving the compositor with no advance leaves the tick unchanged.
        let mut compositor = compositor::ClientCompositor::new(26);
        assert_eq!(compositor.animation_tick(), 0);
        prune_and_seed_working_since(&mut compositor, &idle_model, t0);
        assert_eq!(compositor.animation_tick(), 0);
        assert_eq!(compositor.working_since_len(), 0);
    }

    #[test]
    fn animation_step_performs_no_io() {
        // Replicate the exact component sequence of the Timer animation step and assert it
        // touches NONE of the off-UI-loop pending sets that the SSH/API helpers populate
        // (commit 3d47acd: no SSH/API I/O on the UI loop).
        let (model, _) = animation_model("working");
        let mut state = test_client_state_with_model(model);
        state.compositor = Some(compositor::ClientCompositor::new(26));

        assert!(state.pending_summary_refresh_server_ids.is_empty());
        assert!(state.pending_secondary_connect_server_ids.is_empty());
        assert!(state.summary_subscription_server_ids.is_empty());

        let now = Instant::now();
        let wants = state.compositor.is_some()
            && state
                .supervisor_model
                .as_ref()
                .is_some_and(compositor::sidebar_wants_animation);
        assert!(wants);
        if should_advance_animation(
            wants,
            now,
            state.last_animation_tick - CLIENT_ANIMATION_INTERVAL,
        ) {
            if let (Some(c), Some(m)) = (state.compositor.as_mut(), state.supervisor_model.as_ref())
            {
                c.advance_animation_tick(CLIENT_ANIMATION_TICK_STEP);
                prune_and_seed_working_since(c, m, now);
            }
            render_cached_composited_frame(&mut state);
        }

        // The tick advanced and the working-since map was seeded...
        assert_eq!(
            state.compositor.as_ref().unwrap().animation_tick(),
            CLIENT_ANIMATION_TICK_STEP
        );
        // ...but no SSH/API refresh or connect work was scheduled.
        assert!(state.pending_summary_refresh_server_ids.is_empty());
        assert!(state.pending_secondary_connect_server_ids.is_empty());
        assert!(state.summary_subscription_server_ids.is_empty());
    }

    // ----- item 3 (Area 5): manage loop wiring (off-UI-loop) --------------------------------

    /// §D: a disabled secondary with a DUE retry entry (as `ServerDisconnected`'s unconditional
    /// `schedule_secondary_retry` would leave) is dropped by `retry_due_secondary_connections`
    /// before any reconnect, because the gated `secondary_connection_plans()` yields no plan.
    #[test]
    fn disabled_server_retry_entry_dropped_before_reconnect() {
        let mut model = supervisor::ClientSupervisorModel::new("local");
        // a single DISABLED secondary.
        model.sync_remote_registry(vec![{
            let mut def = test_remote_definition("r1", "alpha");
            def.disabled = true;
            def
        }]);
        let server_id = supervisor::ServerId::secondary("r1");

        let mut state = test_client_state_with_model(model);
        let now = Instant::now();
        state.secondary_retries.insert(
            server_id.clone(),
            SecondaryRetryState {
                attempt: 0,
                next_retry_at: now,
            },
        );

        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);
        let mut server_writes = HashMap::new();
        retry_due_secondary_connections(&mut state, now, &event_tx, &mut server_writes);

        // the gated plan yields nothing → the entry is removed, no connect attempt is spawned.
        assert!(!state.secondary_retries.contains_key(&server_id));
        assert!(!state
            .pending_secondary_connect_server_ids
            .contains(&server_id));
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn provision_failed_host_retry_entry_dropped_until_explicit_retry() {
        let mut model = supervisor::ClientSupervisorModel::new("local");
        model.sync_remote_registry(vec![test_remote_definition("r1", "alpha")]);
        let server_id = supervisor::ServerId::secondary("r1");

        let mut state = test_client_state_with_model(model);
        // A terminal provisioning failure (e.g. ssh auth) marked the host stopped.
        state.provision_failed.insert(server_id.clone());
        let now = Instant::now();
        state.secondary_retries.insert(
            server_id.clone(),
            SecondaryRetryState {
                attempt: 0,
                next_retry_at: now,
            },
        );

        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);
        let mut server_writes = HashMap::new();
        retry_due_secondary_connections(&mut state, now, &event_tx, &mut server_writes);

        // The sweep drops the entry and spawns nothing: a terminal failure stays down.
        assert!(!state.secondary_retries.contains_key(&server_id));
        assert!(!state
            .pending_secondary_connect_server_ids
            .contains(&server_id));
        assert!(event_rx.try_recv().is_err());

        // …and the periodic missing-stream sweep must not silently re-enqueue it either.
        schedule_missing_secondary_stream_retries(&mut state, &server_writes, now);
        assert!(
            !state.secondary_retries.contains_key(&server_id),
            "provision-failed host must not be re-enqueued by the background sweep"
        );
    }

    #[test]
    fn host_banner_glyph_click_retries_only_reconnectable_hosts() {
        let mut model = supervisor::ClientSupervisorModel::new("local");
        model.sync_remote_registry(vec![test_remote_definition("r1", "alpha")]);
        let server_id = supervisor::ServerId::secondary("r1");
        let _ = model.set_connection_state(&server_id, supervisor::ConnectionState::Disconnected);
        assert!(model.server_is_reconnectable(&server_id));

        let down = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 0,
            row: 0,
            modifiers: crossterm::event::KeyModifiers::empty(),
        };
        // A glyph press on the DOWN host dispatches the reconnect/retry.
        assert_eq!(
            dispatch_sidebar_hit_target(
                compositor::SidebarHitTarget::HostBannerGlyph {
                    server_id: server_id.clone(),
                },
                &mut model,
                &down,
            ),
            ClientInputDispatch::ReconnectRemote {
                server_id: server_id.clone(),
            }
        );

        // On a CONNECTED host the glyph behaves like the plain banner (consume, no retry).
        let _ = model.set_connection_state(&server_id, supervisor::ConnectionState::Connected);
        assert_eq!(
            dispatch_sidebar_hit_target(
                compositor::SidebarHitTarget::HostBannerGlyph { server_id },
                &mut model,
                &down,
            ),
            ClientInputDispatch::Consumed
        );
    }

    /// §G: `SetRemoteEnabled`/`DeleteRemote` dispatch targets `ServerId::main()` off the UI loop —
    /// the spawn helper returns within the frame budget and does not block on the API call.
    #[test]
    fn set_enabled_dispatch_spawns_main_request() {
        let _guard = env_lock().lock().unwrap();
        // point the local socket at a guaranteed-missing path so the spawned thread fails fast.
        let _sock = EnvVarGuard::set(
            crate::api::SOCKET_PATH_ENV_VAR,
            "/tmp/herdr-nonexistent-manage-test.sock",
        );
        let (model, _) = mixed_remote_model();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);

        let started = Instant::now();
        spawn_client_remote_manage_request(
            &model,
            RemoteManageAction::SetEnabled { enabled: false },
            "remote-x".into(),
            &HashMap::new(),
            &event_tx,
        );
        let elapsed = started.elapsed();
        // the spawn helper returns essentially immediately — the API round-trip happens on the
        // spawned thread, NOT inline on the UI loop (no blocking synchronous API call here).
        assert!(
            elapsed <= CLIENT_60FPS_FRAME_BUDGET,
            "spawning a manage request blocked the UI thread for {elapsed:?}"
        );

        // the request DOES complete off-thread and emits the finished event addressed to remote-x.
        let event = event_rx.blocking_recv().unwrap();
        match event {
            ClientLoopEvent::RemoteManageRequestFinished {
                action, remote_id, ..
            } => {
                assert_eq!(action, RemoteManageAction::SetEnabled { enabled: false });
                assert_eq!(remote_id, "remote-x");
            }
            _ => panic!("expected RemoteManageRequestFinished"),
        }
    }

    /// §G: building the manage request targets the right API method.
    #[test]
    fn remote_manage_request_builds_set_enabled_and_remove() {
        let set = remote_manage_request(&RemoteManageAction::SetEnabled { enabled: true }, "r1");
        match set.method {
            crate::api::schema::Method::RemoteSetEnabled(params) => {
                assert_eq!(params.remote_id, "r1");
                assert!(params.enabled);
            }
            other => panic!("expected remote.set_enabled, got {other:?}"),
        }
        let del = remote_manage_request(&RemoteManageAction::Delete, "r1");
        match del.method {
            crate::api::schema::Method::RemoteRemove(params) => {
                assert_eq!(params.remote_id, "r1");
            }
            other => panic!("expected remote.remove, got {other:?}"),
        }
    }

    /// §G: the re-enable handler sets the server `connection_state == Connecting` so the gated
    /// plans pick it up on the next tick (`sync_remote_registry` never re-applies state).
    #[test]
    fn re_enable_yields_connecting() {
        let _guard = env_lock().lock().unwrap();
        let _sock = EnvVarGuard::set(
            crate::api::SOCKET_PATH_ENV_VAR,
            "/tmp/herdr-nonexistent-manage-test.sock",
        );
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let server_id = model.add_secondary({
            let mut def = test_remote_definition("r1", "alpha");
            def.disabled = true;
            def
        });
        model
            .set_connection_state(&server_id, supervisor::ConnectionState::Disconnected)
            .unwrap();
        let mut state = test_client_state_with_model(model);
        let (event_tx, _rx) = tokio::sync::mpsc::channel(8);
        let mut server_writes = HashMap::new();

        apply_remote_manage_request_finished(
            &mut state,
            &mut server_writes,
            RemoteManageAction::SetEnabled { enabled: true },
            "r1",
            Ok(()),
            &event_tx,
        );

        let server = state
            .supervisor_model
            .as_ref()
            .unwrap()
            .server_for_test(&server_id)
            .unwrap();
        assert_eq!(
            server.connection_state,
            supervisor::ConnectionState::Connecting
        );
    }

    /// §G: disabling a currently-connected remote tears down its stream/bridge/subscription state
    /// and sets `Disconnected`.
    #[test]
    fn disable_while_connected_tears_down() {
        let _guard = env_lock().lock().unwrap();
        let _sock = EnvVarGuard::set(
            crate::api::SOCKET_PATH_ENV_VAR,
            "/tmp/herdr-nonexistent-manage-test.sock",
        );
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let server_id = model.add_secondary(test_remote_definition("r1", "alpha"));
        model
            .set_connection_state(&server_id, supervisor::ConnectionState::Connected)
            .unwrap();
        let mut state = test_client_state_with_model(model);
        // seed live stream/bridge/subscription/pending state for the server.
        state
            .summary_subscription_server_ids
            .insert(server_id.clone());
        state
            .pending_summary_refresh_server_ids
            .insert(server_id.clone());
        state
            .pending_secondary_connect_server_ids
            .insert(server_id.clone());
        let (event_tx, _rx) = tokio::sync::mpsc::channel(8);
        let mut server_writes = HashMap::new();

        apply_remote_manage_request_finished(
            &mut state,
            &mut server_writes,
            RemoteManageAction::SetEnabled { enabled: false },
            "r1",
            Ok(()),
            &event_tx,
        );

        assert!(!state.summary_subscription_server_ids.contains(&server_id));
        assert!(!state
            .pending_summary_refresh_server_ids
            .contains(&server_id));
        assert!(!state
            .pending_secondary_connect_server_ids
            .contains(&server_id));
        assert!(!state.ssh_bridges.contains_key(&server_id));
        let server = state
            .supervisor_model
            .as_ref()
            .unwrap()
            .server_for_test(&server_id)
            .unwrap();
        assert_eq!(
            server.connection_state,
            supervisor::ConnectionState::Disconnected
        );
    }

    /// §G: deleting a remote removes the secondary from the model, tears down, and clears the
    /// overlay confirm/pending markers.
    #[test]
    fn delete_removes_secondary_and_clears_overlay() {
        let _guard = env_lock().lock().unwrap();
        let _sock = EnvVarGuard::set(
            crate::api::SOCKET_PATH_ENV_VAR,
            "/tmp/herdr-nonexistent-manage-test.sock",
        );
        let mut model = supervisor::ClientSupervisorModel::new("local");
        let server_id = model.add_secondary(test_remote_definition("r1", "alpha"));
        model.open_remote_manage_overlay();
        // enter delete-confirm + mark pending for r1 (as the dispatch would).
        model.begin_remote_manage_delete();
        assert_eq!(
            model
                .remote_manage_overlay()
                .unwrap()
                .confirm_delete
                .as_deref(),
            Some("r1")
        );
        let mut state = test_client_state_with_model(model);
        let (event_tx, _rx) = tokio::sync::mpsc::channel(8);
        let mut server_writes = HashMap::new();

        apply_remote_manage_request_finished(
            &mut state,
            &mut server_writes,
            RemoteManageAction::Delete,
            "r1",
            Ok(()),
            &event_tx,
        );

        let model = state.supervisor_model.as_ref().unwrap();
        assert!(
            model.server_for_test(&server_id).is_none(),
            "secondary removed from model"
        );
        let overlay = model.remote_manage_overlay().unwrap();
        assert!(overlay.confirm_delete.is_none());
        assert!(overlay.pending.is_none());
    }
}
