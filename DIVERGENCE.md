# what's different

herdr-mx = upstream [herdr](https://github.com/ogulcancelik/herdr) + the changes on this page. nothing else.

currently tracking: **upstream v0.8.2** (released 2026-08-19; herdr-mx `PROTOCOL_VERSION` 21 + `WIRE_ABI_EPOCH` 3 — upstream is still on 20, and since both forks once shipped `20` with different tags, the layout identity is the `(fork, wire_abi_epoch, schema_fingerprint)` prelude in `src/protocol/abi.rs`, not the version integer; every ABI generation and its compatibility decision is `docs/next/protocol/abi-history.json`). note: `docs/next/CHANGELOG.md` version sections are upstream's release notes preserved verbatim (they may mention upstream features this fork rejects — e.g. sidebar token styling); THIS page is the SSOT for what herdr-mx actually ships. policy: every upstream release is merged within days, mx releases are tagged `v<upstream>-mx.<n>`, and anything on this page is offered upstream when it fits — when a feature lands upstream it leaves this page. when *everything* lands upstream, herdr-mx retires.

## the big one: multi-remote client

upstream herdr attaches to one server at a time (`herdr --remote <host>` per terminal). herdr-mx makes the client a **fleet console**:

- **one sidebar, every machine** — register secondary local or SSH-backed herdr servers; their workspaces and agents appear in the same sidebar as your main session, with combined status summaries (blocked / working / done across hosts at a glance).
- **add-remote that provisions itself** — point it at any ssh host; the host row appears in the sidebar immediately and herdr-mx installs the matching server binary in the background, streaming a multiline stage log under the host banner. transient failures keep retrying with backoff; terminal ones (ssh auth, unknown host, impossible seed) pin a readable error on the row, retryable from the host menu or its status glyph. parsed ssh options (ports, identities, jump hosts) are honored.
- **offline cross-OS seeding, transitively** — the opt-in "fat" build (`just bundle`, `herdr bundle list|pack`) embeds macOS + Linux (x86_64/aarch64, static musl) binaries in one file, so a fresh host of a *different* OS is seeded at exact version parity with no release download on the remote. Cross-platform seeding repacks a fat bundle *for the remote's platform* on the fly (the carried binary becomes the native image; every other platform, including the seeding host's own, rides along compressed), so a mac-seeded linux host can in turn seed another mac offline.
- **per-remote lifecycle** — host context menu (add space / disable / disconnect / rename), per-remote auto-update-to-this-client toggle, live host version+protocol readout, one-click force-reinstall update with a multiline install log.
- **full workspace menu on every host** — the client sidebar's workspace context menu matches the server-rendered one, including the worktree rows: new worktree, open worktree… (picker), delete worktree checkout…, and group expand/collapse — all executed on the owning server over the API.
- **fast over distance** — semantic-frame delta streaming with compression for ~30fps remote panes, last-frame-first switching, accurate per-host ping/throughput in the banner.
- **isolation** — a secondary host going down never touches your main session.

## quality-of-life on top

- **sidebar settings TUI** — configurable agent segments and sidebar lines, applied instantly, with tab names shown in the multi-remote sidebar.
- **fleet-scale rendering** — model updates coalesced to one render per frame, cached sidebar shell, hover painted as a per-frame overlay; the client stays smooth with many remotes attached (upstream's single-remote client never hits these paths).
- **client overlay framework** — unified drag-to-move client menus, keyboard navigation, drag-reorder with preview, collapsed status-only sidebar mode.
- **clipboard image hardening (macOS)** — sandboxed/unreadable screenshot locations warn instead of silently failing; staged image paths paste un-bracketed so they attach; interactive panes spawn as login shells so `~/.zprofile` applies.

## intentionally changed from upstream

| area | upstream | herdr-mx | why |
|---|---|---|---|
| `herdr update` / update channels | herdr.dev manifests | disabled; brew/mise/releases | a stock-herdr download would silently remove multi-remote |
| version string | `0.6.10` | `0.6.10-mx.1` | so bug reports route to the right tracker |
| settings popup | 76×22 base | 96×32 base | room for the sidebar settings TUI |
| windows build | preview beta | unavailable | the multi-remote client doesn't compile on windows yet ([#63](https://github.com/2lab-ai/herdr-mx/issues/63)) |

## not yet re-applied after the v0.6.10 merge

- cline phantom-working guard (#37): upstream's new manifest-based detection defaults cline to "working" again; the mx fix needs a `manifests/cline.toml` override.
- deferred remote refinements from the #60→#62 merge: upstream keepalive (#355), fish-shell remote bootstrap (#396), mise+preview remote seeding.

## deferred / rejected in the v0.8.2 merge

merged 2026-08-22 (`v0.8.0..v0.8.2` = 133 upstream commits, 31 conflicted files). the tail rule
held: `wire_fixtures.json`'s `enums` table is byte-identical across the merge, so every mx wire tag
(`ServerMessage::Terminal` 13, `ClientMessage::ObserveTerminal` 12 / `RetargetTerminal` 14,
`ClientLaunchMode::TerminalAttach` 1) survived. upstream's own additions sit at the tails
(`ClientMessage` 15–17, `ServerMessage` 15–17) and `ClientLaunchMode::AppDirectGraphics`, which
upstream inserted *between* `App` and `TerminalAttach`, was moved to that enum's tail.

per-file resolution decisions (31 conflicted files + the ones that auto-merged wrong) are
[`docs/next/merge-log/upstream-v0.8.2.md`](docs/next/merge-log/upstream-v0.8.2.md) — read it before
the next sync, it names the two failure modes git will not flag for you.

**rejected** (this fork will not carry them):

- **direct (audited local) kitty graphics on the client** — `src/client/direct_graphics.rs`, the
  SGR-1016 pixel-mouse reader in `src/client/input.rs`, and `ClientLaunchMode::AppDirectGraphics`
  negotiation. upstream's own gate (`direct_graphics_profile_allowed`) returns false for remote /
  ssh / tmux clients, i.e. herdr-mx's primary shape, and the arming + response plumbing lives in
  the client loop this fork rewrote. the **server** side merged in and is inert: `GraphicsFile` /
  `GraphicsTransmissionRetired` are accepted and ignored by the mx client, and the mx client never
  asks for `AppDirectGraphics`, so a conforming server never sends them.
- **windows** — upstream v0.8.2 made `src/remote/attach.rs` cross-platform (splitting the host half
  into `host_unix.rs`) and added a windows release matrix row. both rejected: the multi-remote
  bridge is unix-only ([#63](https://github.com/2lab-ai/herdr-mx/issues/63)) and the mx release job
  publishes `fat/` bundles, not per-target archives.
- **upstream's interprocess bridge listener** — `bind_private_local_listener` /
  `prepare_remote_bridge_stream`. the mx bridge's whole worker chain is typed on `UnixStream` and
  it keeps `UnixListener::bind`. upstream's *ownership-checked* socket removal
  (`remove_socket_file_if_owned`) WAS adopted around it — a blind `remove_file` races a successor.
- **managed ssh config keepalives** (#355, already deferred at v0.8.0) and the **sha256 asset
  checksum map** in the update manifest — both live inside code paths the mx seeding/bridge
  rewrite replaced. `RemoteSshConfigPaths` and friends are kept behind `#[allow(dead_code)]` so the
  next merge stays quiet here.
- **`agent_panel_scope` retirement** — upstream deleted the workspace filter and left only a legacy
  deserializer. herdr-mx keeps the live knob: the multi-remote agents panel is a fleet view where
  "current workspace only" is the useful reduction.
- **`[ui.sidebar.agents]` / `[ui.sidebar.spaces]` sample config** in `herdr --default-config` and
  the sidebar-token tests in `src/ui/sidebar.rs` / `src/app/input/sidebar.rs` — the same rejected
  token subsystem as at v0.8.0; mx ships its own sections at those TOML paths.

**adopted** (worth naming because they are not free):

- **`ui.status_indicators` (`dots` | `symbols`)** — additive, and the settings-TUI / `ui/mobile.rs`
  rows that drive it merged cleanly. upstream's `state_dot` → `state_icon` rename came with it; the
  mx spinner (`agent_icon`) still owns the agent rows, so both live in `src/ui/status.rs`.
- **the fallible terminal restore** (`ratatui::try_restore`, `TerminalGuard::restore`). not
  cosmetic: mx's `ratatui::restore()` **panics** when the host terminal is already gone, and it ran
  from `Drop`, so a hung-up PTY aborted the client (`SIGABRT`). upstream's two new
  `client_exits_cleanly_when_terminal_*_hang_up` tests caught it during this merge.
- **compact large terminal redraws** (#2675, `36074530`). upstream rewrote `write_all_cells`
  (`src/protocol/render_ansi.rs:639`) to skip the per-cell cursor move when the next cell is inline
  and to re-emit SGR only on an actual style change. that is the **live** observe encoder, not just
  the fixture one: `src/server/render_stream.rs:101` → `BlitEncoder::encode` →
  `src/protocol/render_ansi.rs:483` → `write_all_cells`, and those bytes become
  `ServerMessage::Terminal` verbatim (`render_stream.rs:114-121`). measured at 100×30 **after** the
  merge: **3,276 bytes live** (`tests/observe_terminal_ansi.rs`, 2 consecutive runs), 3,274 from the
  TS client over both a direct socket and the ssh bridge, 3,292 for the synthesized fixture — against
  **55,925 / 55,921** before. `mobile/.prd/03-blockers.md` **B13** ("18.6 B/cell, ~56 KB per full
  frame") is therefore stale, and so is the "marshal 56 KB across the RN bridge" risk.
- **headless default terminal size 80×24 → 120×40** (#2828). observable: a live pane's PTY is now
  39×93 where it was 23×53. it re-wraps every pane's echoed output, which is what surfaced a
  wrap-brittle assertion in `mobile/test/live/paneInput.live.test.tsx`.
- upstream's non-foreground scroll preservation in `render_and_stream`, folded around mx's
  `ClientSurfaceMode` branch rather than replacing it.

## deferred from the v0.8.0 merge

upstream v0.8.0 features whose wiring lives inside the multi-remote client loop (which herdr-mx
rewrites) — the shared helpers merged in, but the client-loop integration is not yet ported:

- host-drawn cursor mode (`draw_host_cursor` / `repaint_pending` blit semantics) and the
  host-repaint kitty-graphics preservation path (#1628). (the host cell-size query fallback for
  ConPTY/WSL #2146/#2160 WAS ported — it is loop-peripheral.)
- kitty report-all keyboard routing (`ServerMessage::KittyKeyboardReportAll` is accepted and
  ignored by the mx client; version parity makes this safe).
- configurable remote image-paste key (mx client still hardcodes Ctrl+V for the clipboard-image
  bridge).
- sh fallback for remote path discovery on non-POSIX login shells (#1201) — mx keeps its own
  multi-path probe (`remote_path_probe_any_command`); fold upstream's fallback into it later.
- upstream's settings-TUI removal of the experiments section was NOT adopted: the mx settings TUI
  keeps its sidebar + experiments sections (the config knobs still exist upstream; only their TUI
  rows were removed there).
- upstream's sidebar token styling (`[ui.sidebar.spaces]` rows/`row_gap`, `src/config/sidebar.rs`)
  remains rejected; its multi-row card rendering and worktree tree-connector polish (7db744ab)
  are therefore not picked up. (the group-collapse chevron and the `WorkspaceDropTarget`-based
  drag-reorder subsystem WERE adopted — mx's host-reorder rides alongside them.)
- upstream's "static workspace marks" change (no continuous spinner) was NOT adopted: mx restored
  its `spinner_frame`/`agent_icon` and the server/headless animation timer machinery upstream
  removed.
