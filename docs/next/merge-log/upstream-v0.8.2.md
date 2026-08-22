# merge-resolution-log — herdr-mx ← upstream v0.8.2 (2026-08-22)

Base = `346411fa` (upstream at v0.8.0). Ours = `d06d5333` (`feat/mobile-client`, v0.8.0-mx.1 + M0/M1/M6).
Theirs = `v0.8.2` (`9eb52145`). 133 upstream commits. **31** conflicted files (the plan said 27 —
`merge-tree` was run against a different ours-tip; the extra 4 are `src/config/sidebar.rs` (D/U),
`src/ui/settings.rs`, `src/ui/tab_surface.rs`, `tests/support/mod.rs`).

Rule applied everywhere: **fork divergence intent wins; upstream-inserted enum variants move to the tail.**

| file | hunks | resolution | why |
|---|---|---|---|
| `src/protocol/wire.rs` | 4 | union + **tail rule** | `PROTOCOL_VERSION` stays 21 (upstream 20). `ClientLaunchMode::AppDirectGraphics` **moved from upstream's middle position to the tail** so `TerminalAttach` keeps tag 1 — this one auto-merged silently and was caught by reading the diff, not by a conflict. Upstream's 3 `ClientMessage` + 3 `ServerMessage` additions appended after the mx variants (tags 15–17 both sides). `MouseCapture` gained `sgr_pixels` (payload change, tag unmoved) — accepted. |
| `src/protocol/abi.rs` | 0 (compile) | extend exemplars | New variants + `AppDirectGraphics` + both `sgr_pixels` values added to the fingerprint sweep; coverage asserts 15→18 each. `fingerprint_changes_when_a_payload_field_is_added` re-pointed: the "without" shape is now a local type, because the production `MouseCapture` *has* the field. |
| `Cargo.toml` | 1 | union | mx `shlex` + upstream `time` and the wider `tokio` feature set. |
| `Cargo.lock` | 1 | theirs, then `cargo` reconciled | verified by `--locked` on every gate. |
| `.github/workflows/release.yml` | 1 | **ours** + reject windows matrix row | mx publishes `fat/` bundles; windows doesn't build (#63). Upstream's `shell: bash` steps + windows packaging step kept dead to keep the next merge quiet. Upstream's `git add -A` path trim accepted (their website job). |
| `justfile` | 1 | union | mx `bundle`/`deploy-build` + upstream `[windows] build`, `bench-render-scale`, `bench-release-smoke`. |
| `src/config.rs` | 1 | ours + `StatusIndicatorStyle` | `sidebar::{…}` re-export dropped with the module. |
| `src/config/sidebar.rs` | D/U | **stay deleted** | upstream's token-styling module, rejected since v0.8.0. |
| `src/config/model.rs` | 4 | ours + `StatusIndicatorStyle` | kept mx's live `agent_panel_scope` (upstream retired it to a legacy shim); dropped upstream's `sidebar: SidebarConfig` (name-collides with mx's own `SidebarConfig`). |
| `src/main.rs` | 2 | ours + `status_indicators` sample | upstream's `[ui.sidebar.agents|spaces]` sample block rejected — mx ships its own sections at those TOML paths. |
| `src/platform/linux.rs` | 2 | union | upstream's `unix_common` re-exports + `should_query_host_terminal_palette` added; mx's `#[allow(dead_code)]` markers kept. Unused re-exports trimmed here and in `macos.rs`. |
| `src/app/mod.rs` | 4 | union ×3, theirs ×1 | dropped mx's old `sync_terminal_titles()` loop call (upstream moved it to render time); `sync_animation_timer` + `set_immediate_pty_sources` both kept; `agent_panel_scope` + `status_indicators` both applied on config reload; both tests kept. |
| `src/app/terminal_titles.rs` | 2 | theirs, then adapted | took upstream's dirty-set refactor wholesale, then rewrote `terminal_title_sidebar_changed` to a constant `false` (mx's `SidebarAgentField` has no terminal-title token) and dropped its 2 `state.sidebar_agents` tests. |
| `src/app/state.rs` | 2 | union | `agent_panel_scope` + `status_indicators`. |
| `src/app/input/sidebar.rs` | 1 | ours | upstream re-added a drag-reorder test mx already has (moved earlier). `..` added to `DragTarget` patterns for upstream's new `source_id`. |
| `src/client/mod.rs` | 33 | **ours**, then 6 targeted adoptions | the multi-remote client loop is the fork. Adopted from upstream: fallible `restore_terminal_state` + `ratatui::try_restore` + `TerminalGuard::restore` (**a real bug fix — see below**), `MouseCapture{sgr_pixels}` destructure, new `ServerMessage` arms accepted-and-ignored, `initial_terminal_geometry`'s 5-tuple. Rejected: direct-graphics negotiation (`client_launch_mode`'s `AppDirectGraphics` arm and `direct_graphics_profile_*` deleted). |
| `src/client/input.rs`, `input/windows_vti.rs` | auto | **reverted to base** | mx never touched them; upstream's version is entangled with `direct_graphics` + SGR-pixel mouse, both deferred. |
| `src/client/direct_graphics.rs` | new | **deleted** | see above. |
| `src/server/headless.rs` | 4 | union ×3, drop ×1 | scroll preservation wrapped *around* mx's `ClientSurfaceMode` match; `connection.surface_mode` + `direct_graphics`/`pixel_mouse` all set; `read_server_frame` keeps mx's deflate-inflate but takes upstream's graphics cap. |
| `src/server/client_transport.rs` | 1 | union | `RetargetTerminal` arm + upstream's 2 graphics arms. |
| `src/server/terminal_attach.rs` | 1 | **ours** | upstream changed `paste_payload_for_runtime`, a function mx deleted (#59). |
| `src/server/clients.rs` | auto | theirs | `pane_graphics_render_pending` removed upstream; mx's `request_full_redraw` stopped touching it. |
| `src/server/handoff.rs` | auto | ours | mx's 3 extra `SessionSnapshot` fields added to upstream's test initializer. |
| `src/terminal/state.rs` | 1 | union | mx's `hook_report_is_new` + `record_hook_report` split preserved, wrapped in upstream's `unsequenced_selection` bypass so the bypass skips **both** halves (matching upstream skipping its single `accept_hook_report`). |
| `src/remote/attach.rs` (was `unix.rs`) | 15 | **ours**, rename accepted | followed upstream's `unix.rs`→`attach.rs` rename (lowers future conflict), rejected the `host_unix.rs` split (mx's runner is a superset) and the interprocess listener (mx's chain is `UnixStream`-typed). Adopted upstream's ownership-checked `remove_socket_file_if_owned` in `Drop`. Rejected the sha256 asset map + managed-ssh keepalives. |
| `src/remote.rs` | auto | restored ours + rename | upstream made the module cross-platform; mx keeps `#[cfg(unix)] mod attach` and its windows shims. |
| `src/ui/sidebar.rs` | 9 | **ours** ×8, union ×1 | upstream's token-row renderer and its ~900 lines of tests rejected. `state_dot` → upstream's renamed `state_icon(…, status_indicators, …)` at mx's 3 call sites; `agent_icon` (mx spinner) untouched. |
| `src/ui/status.rs` | 1 | **both fns kept** | `agent_icon` (spinner, mx) *and* `state_icon` (upstream's renamed `state_dot`). |
| `src/ui/settings.rs` | 1 | union | mx's sidebar-TUI imports + `StatusIndicatorStyle`. |
| `src/ui/dialogs.rs` | 1 | ours + `render_rename_overlay` | upstream added a test that needs it. |
| `src/ui/tab_surface.rs` | 1 | ours, digest re-recorded | see "characterization" below. |
| `src/workspace.rs` | auto | rewritten | upstream made `split_focused` `#[cfg(test)]`; the snapshot-restore path now uses `split_pane(layout.focused(), …)` + `focus_pane`. |
| `CHANGELOG.md`, `docs/next/CHANGELOG.md` | 1 each | union, upstream section on top | reverse-chronological: 0.8.2 (08-19) above 0.8.0-mx.1 (08-14). |
| `README.md` | 3 | **ours** | mx branding + doc list. |
| `docs/next/api/herdr-api.schema.json` | 1 | ours (`protocol: 21`) | |
| `tests/api_ping.rs`, `tests/support/mod.rs` | 1 each | **ours** | protocol 21 + the wire-ABI prelude helpers. |

## things that did NOT arrive as conflicts and still needed a decision

- `ClientLaunchMode::AppDirectGraphics` **auto-merged into the middle of the enum.** This is the exact
  silent mid-insert the tail rule exists for, and git did not flag it. Found by diffing the enum
  orderings base/theirs/merged programmatically. Anyone doing the next merge: **diff every wire enum's
  ordering, do not trust the conflict list.**
- Upstream's windows release-matrix row auto-merged; rejected.
- `pane_graphics_render_pending`, `split_focused`, `paste_payload_for_runtime`, `state_dot`,
  `sync_terminal_titles`'s signature: all upstream API changes that auto-merged on one side of a
  call/definition pair. The compiler found each.

## test fallout, classified

Baseline (`feat/mobile-client`, same machine, same command): **3613 run, 7 failed**.
Merged: **3890 run (+277 upstream tests), 7 failed** — the same 7.

Seven NEW failures appeared and were each classified before being touched:

1. `client_exits_cleanly_when_terminal_hangs_up` + `…_and_transport_hang_up` — **OUR REGRESSION.**
   Taking "ours" on the client restore hunk kept `ratatui::restore()`, which *panics* when the host
   terminal is gone, from inside `Drop` → `SIGABRT`. Upstream v0.8.2 fixed exactly this with
   `try_restore` + a fallible `restore_terminal_state`. Adopted; both pass.
2–4. `pane_graphics_tests::{cold_redraw_advances…, direct_frame_during_internal_redraw…,
   hidden_large_direct_frame…}` — **upstream tests vs. fork encoder.** They call `read_server_frame`,
   which asserts a full `Frame`; mx's #13 delta encoder answers with `FrameDelta`, which carries the
   same `graphics` bytes. Added `read_server_frame_graphics` (accepts either) and used it at the 5
   graphics-only assertions.
5. `ui::tab_surface::desktop_full_app_semantic_frame_is_characterized` — **expected upstream render
   change.** Verified before re-recording by dumping all 20 rows on both trees: exactly one row
   differs, the tab bar, only in label padding (upstream #2570 centered tab labels). Mobile twin
   unchanged. Digest re-recorded with that evidence in the comment.
6. `multi_client::non_foreground_client_render_preserves_agent_panel_scroll` — **upstream test,
   upstream geometry.** Its `agent-16/10/11` constants encode upstream's sidebar row count; mx's
   segments sidebar shows 5 rows per page where upstream shows 8. Measured this build (19/15/16) and
   substituted, assertion unchanged.
7. `mobile/test/live/paneInput.live.test.tsx` (2 tests) — **fork test brittleness, exposed by
   upstream #2828.** Headless default terminal went 80×24 → 120×40, so a live pane's PTY is now
   39×93 (was 23×53) and the echoed command wraps differently: `M3ANSWER:` stopped being split
   across the wrap and the pre-input guard `includes("M3ANSWER:")` self-tripped. Tightened to
   `M3ANSWER:y` (the printf *output*), mirroring the AFTER assertion. Baseline was 14/14 green, so
   this was correctly treated as new.

## silent-drop hunt

Real mx client ↔ real mx server, isolated XDG dirs, `HERDR_LOG=debug`, socket path kept short enough
for `sun_path`. Handshake succeeded (`version=21`, epoch-3 prelude). 71 log lines across
`herdr-server.log` / `herdr-client.log` / stdout; **zero** matches for
`decode|framing|oversized|unexpected|unknown|mismatch|drop|skip|inflate|desync|invalid|reject|incompat|WARN|ERROR`.
Corroborated by the fork's own detector: the TS live-ssh run prints `layout probe: undecodable=0
verdict=none` and `suppressedErrors=0`.
