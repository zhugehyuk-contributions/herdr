//! Golden wire-fixture corpus for non-Rust protocol clients (mobile TS codec).
//!
//! A TypeScript client has to hand-decode this fork's bincode wire. Without byte-exact vectors
//! produced by the *real* Rust encoder, every `PROTOCOL_VERSION` bump silently desyncs the two
//! sides and the only signal is a dead app. This module generates
//! `docs/next/protocol/fixtures.json` from the production types/encoders and fails when the
//! committed artifact drifts — same contract as the JSON Schema artifact
//! (`src/api/schema/tests.rs:153`).
//!
//! What is generated here, and by which production path:
//! - enum ordinals: read back out of real bincode encodings, never typed by hand.
//! - `hello_terminal_ansi_attach` / `welcome_ok`: `protocol::write_message`
//!   (`src/protocol/wire.rs:1125`) — the exact `[u32LE len][bincode payload]` framing the server
//!   and client use.
//! - `terminal_frame_first_full`: a *synthesized* `FrameData` pushed through
//!   `ClientRenderState::prepare_frame` (`src/server/render_stream.rs:89`) — the real
//!   `BlitEncoder` + the real `TerminalFrame` assembly. The frame *content* is synthetic on
//!   purpose; see the `nondeterminism` section of the artifact for what a live server's terminal
//!   stream does not reproduce.
//!
//! Unix-only: `render_ansi::repeat_ime_anchor_after_sync` (`src/protocol/render_ansi.rs:518`)
//! emits an extra cursor anchor on non-Windows, so the ANSI bytes are platform-conditional and a
//! Windows-generated artifact would differ.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::protocol::abi::{
    self, WIRE_ABI_EPOCH, WIRE_ABI_FORK, WIRE_ABI_PRELUDE_LEN, WIRE_SCHEMA_FINGERPRINT,
};
use crate::protocol::{
    write_message, CellData, ClientKeybindings, ClientLaunchMode, ClientMessage, ClientSurfaceMode,
    CursorState, FrameData, RenderEncoding, ServerMessage, PROTOCOL_VERSION,
};
use crate::server::render_stream::ClientRenderState;

/// Fixture client geometry. Mirrors `tests/observe_terminal_ansi.rs` so the live integration test
/// and this corpus describe the same client.
const FIXTURE_COLS: u16 = 100;
const FIXTURE_ROWS: u16 = 30;

/// Observe target for the `ObserveTerminal` vector. Non-ASCII on purpose: it makes the vector
/// witness that the bincode `String` length prefix is a BYTE count (16 here) and not a character
/// count (6), which is the boundary a hand-written encoder gets wrong silently.
const FIXTURE_OBSERVE_TARGET: &str = "한글:터미널";

/// Past this, an inline `framed_hex` stops being reviewable in a diff; the vector carries a
/// prefix + digest instead.
const INLINE_BYTES_LIMIT: usize = 50 * 1024;
/// How much of an oversized `TerminalFrame.bytes` is still inlined, for eyeballing the preamble.
const BYTES_PREFIX_LEN: usize = 512;

fn protocol_docs_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("docs/next/protocol")
}

fn artifact_path() -> PathBuf {
    protocol_docs_dir().join("fixtures.json")
}

fn abi_history_path() -> PathBuf {
    protocol_docs_dir().join("abi-history.json")
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// The production framing: `[u32LE payload length][bincode payload]`.
fn framed<M: Serialize>(msg: &M) -> Vec<u8> {
    let mut buf = Vec::new();
    write_message(&mut buf, msg).expect("fixture message should frame");
    buf
}

/// The bincode enum tag of a message, read back out of its own encoding. All tags used here are
/// < 251, i.e. a single varint byte.
fn variant_tag<M: Serialize>(msg: &M) -> u32 {
    let payload = bincode::serde::encode_to_vec(msg, bincode::config::standard())
        .expect("fixture message should encode");
    let first = *payload
        .first()
        .expect("encoded message carries an enum tag");
    assert!(
        first < 251,
        "variant tag {first} is a multi-byte varint; widen variant_tag() before using it"
    );
    u32::from(first)
}

/// A deterministic 100x30 screen with enough variation to exercise the blit encoder's SGR runs:
/// a default-attribute title row, a colored row, and a visible cursor.
fn fixture_frame() -> FrameData {
    fn write_row(frame: &mut FrameData, row: u16, text: &str, fg: u32) {
        for (col, ch) in text.chars().enumerate() {
            let idx = (row as usize) * (frame.width as usize) + col;
            frame.cells[idx] = CellData {
                symbol: ch.to_string(),
                fg,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None,
            };
        }
    }

    let mut frame = FrameData::blank(FIXTURE_COLS, FIXTURE_ROWS);
    write_row(&mut frame, 0, "herdr wire fixture corpus", 0);
    write_row(&mut frame, 1, "colored row (fg set)", 2);
    frame.cursor = Some(CursorState {
        x: 0,
        y: 2,
        visible: true,
        shape: 0,
    });
    frame
}

/// Runs the synthesized frame through the production terminal-ANSI render state and returns the
/// `ServerMessage::Terminal(TerminalFrame)` the server would put on the wire.
fn fixture_terminal_message() -> ServerMessage {
    let mut state = ClientRenderState::new(RenderEncoding::TerminalAnsi);
    let prepared = state
        .prepare_frame(fixture_frame())
        .expect("a fresh terminal-ansi client always renders its first frame");
    prepared.message().clone()
}

/// The wire-ABI prelude — the 28 bytes that precede the `Hello` frame in every direction.
///
/// Pinned here for the same reason the `Hello` bytes are: a non-Rust client (and this repo's own
/// integration tests, which have no lib target to link against) has to reproduce them exactly, and
/// the `schema_fingerprint` field is a sha256 over the production types that nobody can derive by
/// hand. Generated from `WirePrelude::local().encode()`, so it cannot drift from what the server
/// actually reads.
fn wire_abi_prelude_vector() -> Value {
    let bytes = abi::WirePrelude::local().encode();
    json!({
        "name": "wire_abi_prelude",
        "direction": "both",
        "message": "WirePrelude",
        "field_order": ["magic", "fork", "abi_epoch", "protocol_version", "schema_fingerprint"],
        "fields": {
            "magic": String::from_utf8_lossy(&abi::WIRE_ABI_MAGIC),
            "fork": String::from_utf8_lossy(&WIRE_ABI_FORK),
            "abi_epoch": WIRE_ABI_EPOCH,
            "protocol_version": PROTOCOL_VERSION,
            "schema_fingerprint": hex(&WIRE_SCHEMA_FINGERPRINT)
        },
        "framed_hex": hex(&bytes),
        "note": "NOT bincode and NOT length-prefixed: a fixed 28-byte block, magic(4) + fork(8) + \
                 abi_epoch(u32LE) + protocol_version(u32LE) + schema_fingerprint(8), written \
                 before the first framed message by BOTH peers. It sits ahead of every bincode \
                 decode on purpose — the first value the forks disagree on (ClientLaunchMode) is a \
                 FIELD OF Hello, and the side that decodes Hello is the server, so a fingerprint \
                 carried in Welcome would arrive after the mis-parse it was meant to prevent. The \
                 magic reads as u32LE 1380208712, above both frame caps, so it can never collide \
                 with a legacy peer's length prefix (src/protocol/abi.rs). A peer that sends no \
                 prelude is rejected, not guessed at."
    })
}

fn hello_vector() -> Value {
    let hello = ClientMessage::Hello {
        version: PROTOCOL_VERSION,
        cols: FIXTURE_COLS,
        rows: FIXTURE_ROWS,
        cell_width_px: 8,
        cell_height_px: 16,
        requested_encoding: RenderEncoding::TerminalAnsi,
        surface_mode: ClientSurfaceMode::FullApp,
        keybindings: ClientKeybindings::Server,
        launch_mode: ClientLaunchMode::TerminalAttach,
    };

    json!({
        "name": "hello_terminal_ansi_attach",
        "direction": "client_to_server",
        "message": "Hello",
        "field_order": [
            "version", "cols", "rows", "cell_width_px", "cell_height_px",
            "requested_encoding", "surface_mode", "keybindings", "launch_mode"
        ],
        "fields": {
            "version": PROTOCOL_VERSION,
            "cols": FIXTURE_COLS,
            "rows": FIXTURE_ROWS,
            "cell_width_px": 8,
            "cell_height_px": 16,
            "encoding": "TerminalAnsi",
            "surface": "FullApp",
            "keybindings": "Server",
            "launch": "TerminalAttach"
        },
        "framed_hex": hex(&framed(&hello)),
        "note": "`keybindings` is itself an enum: `Server` is a bare tag, `Local { keys_toml }` \
                 carries a string. src/protocol/wire.rs:368"
    })
}

/// The message that actually starts the stream. `Hello` only attaches the connection; without
/// `ObserveTerminal` a client handshakes successfully and then sits there receiving nothing, so a
/// non-Rust client needs its bytes pinned just as much as the handshake's.
///
/// The target deliberately uses a non-ASCII string: the bincode `String` length prefix counts
/// UTF-8 BYTES, and a hand-rolled encoder that counts characters produces a frame the server
/// mis-decodes rather than an obvious error.
fn observe_terminal_vector() -> Value {
    let observe = ClientMessage::ObserveTerminal {
        target: FIXTURE_OBSERVE_TARGET.to_owned(),
    };

    json!({
        "name": "observe_terminal",
        "direction": "client_to_server",
        "message": "ObserveTerminal",
        "field_order": ["target"],
        "fields": {
            "target": FIXTURE_OBSERVE_TARGET,
            "target_utf8_len": FIXTURE_OBSERVE_TARGET.len(),
            "target_char_count": FIXTURE_OBSERVE_TARGET.chars().count()
        },
        "framed_hex": hex(&framed(&observe)),
        "note": "ObserveTerminal carries EXACTLY ONE field (src/protocol/wire.rs:471). Its \
                 neighbour ControlTerminal (src/protocol/wire.rs:477) has the same `target` plus a \
                 `takeover: bool`; encoding that shape here appends a byte the server reads as \
                 garbage. `target` is a bincode String: varint(UTF-8 byte length) + raw bytes — \
                 note target_utf8_len != target_char_count here on purpose."
    })
}

fn welcome_vector() -> Value {
    let welcome = ServerMessage::Welcome {
        version: PROTOCOL_VERSION,
        encoding: RenderEncoding::TerminalAnsi,
        error: None,
    };

    json!({
        "name": "welcome_ok",
        "direction": "server_to_client",
        "message": "Welcome",
        "field_order": ["version", "encoding", "error"],
        "fields": {
            "version": PROTOCOL_VERSION,
            "encoding": "TerminalAnsi",
            "error": null
        },
        "framed_hex": hex(&framed(&welcome)),
        "note": "Welcome carries three fields, not two: the server echoes the encoding it \
                 *selected*, which may differ from the one the client requested \
                 (src/protocol/wire.rs:799). `error: None` encodes as the single Option tag byte \
                 0x00; a rejection is 0x01 + a bincode string."
    })
}

fn terminal_frame_vector() -> Value {
    let message = fixture_terminal_message();
    let ServerMessage::Terminal(frame) = &message else {
        panic!("prepare_frame on a TerminalAnsi client must yield ServerMessage::Terminal");
    };

    let framed_message = framed(&message);
    // Everything ahead of the ANSI payload: the u32LE length prefix, the ServerMessage tag, the
    // TerminalFrame scalars and the `bytes` varint length. Always small, always inlined.
    let header_len = framed_message.len() - frame.bytes.len();

    let mut note = String::from(
        "The frame CONTENT is synthesized (a fixed 100x30 FrameData), but the bytes are produced \
         by the production path: ClientRenderState::prepare_frame -> BlitEncoder \
         (src/server/render_stream.rs:89, src/protocol/render_ansi.rs:68). A live server's frame \
         content is not reproducible - see `nondeterminism`. Terminal messages are NOT \
         deflate-wrapped: compress_server_message is only applied on the semantic-frame branch \
         (src/server/render_stream.rs:88), so a TerminalAnsi client never has to inflate \
         ServerMessage::Compressed for these.",
    );

    let mut vector = json!({
        "name": "terminal_frame_first_full",
        "direction": "server_to_client",
        "message": "Terminal",
        "field_order": ["seq", "width", "height", "full", "bytes"],
        "fields": {
            "seq": frame.seq,
            "width": frame.width,
            "height": frame.height,
            "full": frame.full,
            "bytes_len": frame.bytes.len()
        },
        "framed_header_hex": hex(&framed_message[..header_len]),
        "framed_header_len": header_len,
        "bytes_sha256": sha256_hex(&frame.bytes),
        "synthesized": true
    });

    let object = vector.as_object_mut().expect("vector is an object");
    if frame.bytes.len() > INLINE_BYTES_LIMIT {
        note.push_str(&format!(
            " `framed_hex` is OMITTED here: TerminalFrame.bytes is {} bytes (> {INLINE_BYTES_LIMIT}), \
             so the full frame would be ~{} hex chars and unreviewable in a diff. Verify instead \
             with framed_header_hex (byte-exact framing + scalar fields), bytes_prefix_hex (first \
             {BYTES_PREFIX_LEN} payload bytes) and bytes_sha256 over all {} payload bytes.",
            frame.bytes.len(),
            framed_message.len() * 2,
            frame.bytes.len()
        ));
        object.insert(
            "bytes_prefix_hex".into(),
            json!(hex(&frame.bytes[..BYTES_PREFIX_LEN.min(frame.bytes.len())])),
        );
        object.insert("bytes_prefix_len".into(), json!(BYTES_PREFIX_LEN));
    } else {
        object.insert("framed_hex".into(), json!(hex(&framed_message)));
    }
    object.insert("note".into(), json!(note));

    vector
}

/// What this corpus deliberately does NOT pin. Knowing which halves of the wire are byte-stable
/// is the point of the file: a TS test that asserts on the unstable half will flake forever.
fn nondeterminism() -> Value {
    json!([
        {
            "scope": "ServerMessage::Terminal(TerminalFrame).bytes from a LIVE server",
            "deterministic": "content-dependent, not time-dependent",
            "why": "MEASURED: tests/observe_terminal_ansi.rs run twice back to back produced the \
                    identical first frame (seq=1, width=100, height=30, full=true, \
                    bytes_len=55925, identical 120-byte prefix), so the blit is NOT clock- or \
                    race-dependent. It is a pure function of the observed screen, and the screen \
                    is environment-dependent: PS1/cwd/hostname, terminal theme \
                    (the SGR runs carry resolved colors), pane geometry, and whatever output had \
                    already landed. Change the shell config and every byte after the first CUP \
                    moves.",
            "consequence": "A sha256 pinned against one machine's server is a machine-specific \
                            assertion, not a protocol assertion. In TS assert structure - \
                            decodable field order, full == true on a fresh client's first frame, \
                            width/height equal to the Hello geometry, bytes non-empty and \
                            containing 0x1b - and use this corpus's synthesized frame for the \
                            byte-exact codec test."
        },
        {
            "scope": "TerminalFrame.seq from a LIVE server",
            "deterministic": "1 for a fresh client, then a running counter",
            "why": "seq increments on every committed render for that client \
                    (src/server/render_stream.rs:150). MEASURED as 1 on the first frame in 2/2 \
                    live runs of tests/observe_terminal_ansi.rs, but a client that re-observes on \
                    an already-rendering connection picks up the counter wherever it is.",
            "consequence": "Assert seq >= 1 and strictly increasing, not seq == 1."
        },
        {
            "scope": "TerminalFrame.bytes across platforms",
            "deterministic": "no (unix vs windows)",
            "why": "render_ansi::repeat_ime_anchor_after_sync (src/protocol/render_ansi.rs:518) \
                    is true on unix and false on Windows, so the same FrameData blits to different \
                    bytes. This artifact is generated on unix.",
            "consequence": "Byte-exact TS assertions are valid against unix servers only."
        },
        {
            "scope": "Hello / Welcome framing and enum ordinals",
            "deterministic": "yes",
            "why": "Pure bincode over fixed field values; no clock, no environment, no screen \
                    content.",
            "consequence": "These framed_hex values are safe to assert byte-for-byte."
        }
    ])
}

fn fixture_document() -> Value {
    let render_encodings = [RenderEncoding::SemanticFrame, RenderEncoding::TerminalAnsi];
    let launch_modes = [ClientLaunchMode::App, ClientLaunchMode::TerminalAttach];

    // Ordinals are read back out of real encodings so the table can never drift from the types.
    for (index, encoding) in render_encodings.iter().enumerate() {
        assert_eq!(
            variant_tag(encoding),
            index as u32,
            "RenderEncoding ordinal table is out of order"
        );
    }
    for (index, mode) in launch_modes.iter().enumerate() {
        assert_eq!(
            variant_tag(mode),
            index as u32,
            "ClientLaunchMode ordinal table is out of order"
        );
    }

    let observe_terminal_tag = variant_tag(&ClientMessage::ObserveTerminal {
        target: FIXTURE_OBSERVE_TARGET.to_owned(),
    });
    let welcome_tag = variant_tag(&ServerMessage::Welcome {
        version: PROTOCOL_VERSION,
        encoding: RenderEncoding::TerminalAnsi,
        error: None,
    });
    let terminal_tag = variant_tag(&fixture_terminal_message());

    json!({
        "$comment": "GENERATED by `src/protocol/wire_fixtures.rs`. Do not edit by hand; run \
                     `HERDR_UPDATE_WIRE_FIXTURES=1 just test-one fixtures_are_current`.",
        "protocol_version": PROTOCOL_VERSION,
        "abi": {
            "fork": String::from_utf8_lossy(&WIRE_ABI_FORK),
            "wire_abi_epoch": WIRE_ABI_EPOCH,
            "schema_fingerprint": hex(&WIRE_SCHEMA_FINGERPRINT),
            "prelude_len": WIRE_ABI_PRELUDE_LEN,
            "accepted_peer_abis": abi::accepted_wire_abis()
                .iter()
                .map(|accepted| json!({
                    "protocol_version": accepted.protocol_version,
                    "wire_abi_epoch": accepted.abi_epoch,
                    "schema_fingerprint": hex(&accepted.schema_fingerprint)
                }))
                .collect::<Vec<_>>(),
            "note": "Tags are fork-local; see mobile/.prd/03-blockers.md B1. PROTOCOL_VERSION is \
                     NOT a layout identifier — herdr-mx and upstream both shipped 20 with \
                     different tags — so the layout identity is (fork, wire_abi_epoch, \
                     schema_fingerprint), announced in the `wire_abi_prelude` vector below and \
                     checked before any bincode is decoded. `accepted_peer_abis` is the \
                     compatibility window (M0-b): an explicit table, not a version range. Its \
                     history and the decision behind every row is docs/next/protocol/abi-history.json."
        },
        "framing": {
            "layout": "[u32LE payload_len][bincode payload]",
            "bincode": "bincode 2.x `config::standard()` — varint ints, LE, no fixed-width \
                        headers; enum discriminants are varints, `Option` is a 0x00/0x01 tag, \
                        `Vec<u8>`/`String` are varint length + raw bytes.",
            // The cap is a RULE, not a value: recording one number here taught readers to build a
            // reader that rejects legal frames. Both arms plus the choice, or nothing.
            "max_frame_size": {
                "text": crate::protocol::MAX_FRAME_SIZE,
                "graphics": crate::protocol::MAX_GRAPHICS_FRAME_SIZE,
                "chosen_per_frame": "NOT a single value. The server picks `text` \
                    (MAX_FRAME_SIZE, src/protocol/wire.rs:27) when the frame carries no kitty \
                    graphics and `graphics` (MAX_GRAPHICS_FRAME_SIZE, src/protocol/wire.rs:32) \
                    when it does. Kitty graphics are not a separate message: they are spliced \
                    into the ANSI byte stream by insert_graphics_before_sync_end \
                    (src/server/render_stream.rs:109), so on the TerminalAnsi path they arrive \
                    inside TerminalFrame.bytes. A reader whose ceiling is below `graphics` \
                    therefore rejects a legal frame, and an oversized length prefix cannot be \
                    resynchronized — the connection flaps.",
                "reader_rule": "Mirror the server: server_frame_size_cap(kitty_graphics_enabled) \
                    -> graphics ? MAX_GRAPHICS_FRAME_SIZE : MAX_FRAME_SIZE. A reader that does \
                    not know the peer's graphics setting must use `graphics`. Any value BETWEEN \
                    the two arms is always wrong.",
                "source": "src/server/headless.rs:4231-4235 (server's per-frame choice); \
                    src/client/mod.rs:6483-6491 (server_frame_size_cap, the client-side mirror)"
            },
            "source": "src/protocol/wire.rs:1125 (write_message)"
        },
        "enums": {
            "RenderEncoding": ["SemanticFrame", "TerminalAnsi"],
            "ClientLaunchMode": ["App", "TerminalAttach"],
            "ClientMessage": { "ObserveTerminal": observe_terminal_tag },
            "ServerMessage": { "Welcome": welcome_tag, "Terminal": terminal_tag }
        },
        // Appended, never reordered: `fixtures_decode_back_through_the_rust_codec` and the TS
        // cross-check both address the first three positionally.
        "vectors": [
            hello_vector(),
            welcome_vector(),
            terminal_frame_vector(),
            observe_terminal_vector(),
            wire_abi_prelude_vector()
        ],
        "nondeterminism": nondeterminism(),
        "live_cross_check": {
            "source": "tests/observe_terminal_ansi.rs, 2 consecutive runs on macOS arm64, \
                       2026-08-22",
            "observed": {
                "seq": 1,
                "width": 100,
                "height": 30,
                "full": true,
                "bytes_len": 55925
            },
            "note": "Recorded by hand from the integration test's stdout - this block is \
                     documentation, not a generated assertion, and is the one part of this file \
                     that can go stale. It exists so a reader can see that the synthesized \
                     terminal vector (bytes_len 55921) is the same shape and magnitude as a real \
                     observe stream at the same geometry; the ~4-byte delta is screen content."
        }
    })
}

fn rendered_document() -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(&fixture_document()).expect("fixture document serializes")
    )
}

#[test]
fn fixtures_are_current() {
    let actual = rendered_document();
    let path = artifact_path();

    if std::env::var_os("HERDR_UPDATE_WIRE_FIXTURES").is_some() {
        std::fs::create_dir_all(path.parent().expect("artifact has a parent")).unwrap();
        std::fs::write(&path, &actual).unwrap();
        return;
    }

    let expected = std::fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "failed to read {}; run `HERDR_UPDATE_WIRE_FIXTURES=1 just test-one fixtures_are_current`: {err}",
            path.display()
        )
    });
    if expected == actual {
        return;
    }

    // The corpus embeds multi-KB hex strings, so a raw `assert_eq!` dump is unreadable; point at
    // the first differing line instead.
    let (line_no, committed, generated) = expected
        .lines()
        .zip(actual.lines())
        .enumerate()
        .find(|(_, (a, b))| a != b)
        .map(|(idx, (a, b))| (idx + 1, a.to_owned(), b.to_owned()))
        .unwrap_or_else(|| {
            (
                expected.lines().count().min(actual.lines().count()) + 1,
                "<end of file>".to_owned(),
                "<end of file>".to_owned(),
            )
        });
    panic!(
        "wire fixture corpus at {} is stale (first difference on line {line_no}):\n  committed: {}\n  generated: {}\n\nSTOP AND CLASSIFY BEFORE REGENERATING — this test is the only mechanical witness that this\nfork's wire tags survived an upstream merge.\n  (a) You are merging upstream and an `enums` ordinal MOVED.\n      This is a BUG IN THE MERGE RESOLUTION, not a stale artifact. This fork's contract is:\n      upstream-inserted enum variants go to the TAIL, existing wire tags stay put\n      (see the update-upstream convention and mobile/.prd/03-blockers.md B1).\n      FIX THE ENUM ORDER. Do NOT regenerate — regenerating here launders exactly the\n      regression this corpus exists to catch.\n  (b) You deliberately bumped PROTOCOL_VERSION / changed a payload on purpose.\n      Then regenerate with `HERDR_UPDATE_WIRE_FIXTURES=1 just test-one fixtures_are_current`,\n      and re-check the TS codec in packages/herdr-client-ts against the new bytes.",
        path.display(),
        truncate(&committed),
        truncate(&generated)
    );
}

/// Keeps a diff line readable when it is one of the long hex strings.
fn truncate(line: &str) -> String {
    const LIMIT: usize = 200;
    if line.chars().count() <= LIMIT {
        return line.to_owned();
    }
    let head: String = line.chars().take(LIMIT).collect();
    format!("{head}... ({} chars)", line.chars().count())
}

#[test]
fn fixtures_decode_back_through_the_rust_codec() {
    let document = fixture_document();
    let vectors = document["vectors"].as_array().expect("vectors array");

    let hello_hex = vectors[0]["framed_hex"].as_str().expect("hello framed_hex");
    let hello_bytes = decode_hex(hello_hex);
    let (len, payload) = split_frame(&hello_bytes);
    assert_eq!(
        len,
        payload.len(),
        "hello length prefix disagrees with body"
    );
    let (hello, consumed): (ClientMessage, usize) =
        bincode::serde::decode_from_slice(payload, bincode::config::standard())
            .expect("hello payload decodes as ClientMessage");
    assert_eq!(consumed, payload.len(), "hello payload has trailing bytes");
    match hello {
        ClientMessage::Hello {
            version,
            cols,
            rows,
            requested_encoding,
            launch_mode,
            ..
        } => {
            assert_eq!(version, PROTOCOL_VERSION);
            assert_eq!((cols, rows), (FIXTURE_COLS, FIXTURE_ROWS));
            assert_eq!(requested_encoding, RenderEncoding::TerminalAnsi);
            assert_eq!(launch_mode, ClientLaunchMode::TerminalAttach);
        }
        other => panic!("expected Hello, got {other:?}"),
    }

    // ObserveTerminal: the bytes must decode back to the exact one-field variant, and the recorded
    // caps must still be the constants they claim to mirror.
    let observe = vectors
        .iter()
        .find(|vector| vector["name"] == "observe_terminal")
        .expect("observe_terminal vector");
    let observe_bytes = decode_hex(
        observe["framed_hex"]
            .as_str()
            .expect("observe framed_hex"),
    );
    let (observe_len, payload) = split_frame(&observe_bytes);
    assert_eq!(
        observe_len,
        payload.len(),
        "observe length prefix disagrees with body"
    );
    let (observe_msg, consumed): (ClientMessage, usize) =
        bincode::serde::decode_from_slice(payload, bincode::config::standard())
            .expect("observe payload decodes as ClientMessage");
    assert_eq!(
        consumed,
        payload.len(),
        "observe payload has trailing bytes — ObserveTerminal has exactly one field"
    );
    match observe_msg {
        ClientMessage::ObserveTerminal { target } => {
            assert_eq!(target, FIXTURE_OBSERVE_TARGET);
        }
        other => panic!("expected ObserveTerminal, got {other:?}"),
    }
    assert_eq!(
        observe["fields"]["target_utf8_len"].as_u64(),
        Some(FIXTURE_OBSERVE_TARGET.len() as u64)
    );
    assert_ne!(
        observe["fields"]["target_utf8_len"],
        observe["fields"]["target_char_count"],
        "the observe target must stay non-ASCII or it stops witnessing the byte-vs-char boundary"
    );

    let framing = &document["framing"]["max_frame_size"];
    assert_eq!(
        framing["text"].as_u64(),
        Some(crate::protocol::MAX_FRAME_SIZE as u64)
    );
    assert_eq!(
        framing["graphics"].as_u64(),
        Some(crate::protocol::MAX_GRAPHICS_FRAME_SIZE as u64)
    );
    assert!(
        framing["chosen_per_frame"].is_string() && framing["reader_rule"].is_string(),
        "the framing block must record the CHOICE RULE, not just two numbers"
    );

    let welcome_hex = vectors[1]["framed_hex"]
        .as_str()
        .expect("welcome framed_hex");
    let welcome_bytes = decode_hex(welcome_hex);
    let (_, payload) = split_frame(&welcome_bytes);
    let (welcome, _): (ServerMessage, usize) =
        bincode::serde::decode_from_slice(payload, bincode::config::standard())
            .expect("welcome payload decodes as ServerMessage");
    assert_eq!(
        welcome,
        ServerMessage::Welcome {
            version: PROTOCOL_VERSION,
            encoding: RenderEncoding::TerminalAnsi,
            error: None,
        }
    );

    // The terminal vector pins a digest rather than (necessarily) inline bytes; prove the digest
    // is the digest of what the production render path actually emits.
    let terminal = &vectors[2];
    let ServerMessage::Terminal(frame) = fixture_terminal_message() else {
        panic!("prepare_frame must yield ServerMessage::Terminal");
    };
    assert_eq!(
        terminal["bytes_sha256"].as_str(),
        Some(sha256_hex(&frame.bytes).as_str())
    );
    assert_eq!(
        terminal["fields"]["bytes_len"].as_u64(),
        Some(frame.bytes.len() as u64)
    );
    assert_eq!(terminal["fields"]["full"].as_bool(), Some(true));
    assert_eq!(
        terminal["fields"]["width"].as_u64(),
        Some(u64::from(FIXTURE_COLS))
    );
    assert_eq!(
        terminal["fields"]["height"].as_u64(),
        Some(u64::from(FIXTURE_ROWS))
    );
    assert!(
        frame.bytes.contains(&0x1b),
        "a terminal frame with no ESC byte is not an ANSI blit"
    );

    if let Some(prefix_hex) = terminal["bytes_prefix_hex"].as_str() {
        let prefix = decode_hex(prefix_hex);
        assert_eq!(prefix.as_slice(), &frame.bytes[..prefix.len()]);
    }

    // The inlined header must be a genuine prefix of the real framed message, and its declared
    // length prefix must describe the *whole* frame (header + payload) — this is the byte-exact
    // part a TS decoder can assert against.
    let header = decode_hex(
        terminal["framed_header_hex"]
            .as_str()
            .expect("framed_header_hex"),
    );
    let real_framed = framed(&ServerMessage::Terminal(frame.clone()));
    assert_eq!(header.as_slice(), &real_framed[..header.len()]);
    let (declared_len, _) = split_frame(&header);
    assert_eq!(
        declared_len,
        real_framed.len() - 4,
        "framed_header_hex length prefix must cover the full payload"
    );
    assert_eq!(
        terminal["framed_header_len"].as_u64(),
        Some(header.len() as u64)
    );
    assert_eq!(
        header.last(),
        real_framed.get(header.len() - 1),
        "header must stop exactly at the start of the ANSI payload"
    );
    assert_eq!(
        &real_framed[header.len()..],
        frame.bytes.as_slice(),
        "everything after the header is the raw ANSI payload"
    );
}

// ---------------------------------------------------------------------------
// M0-e: the repetition policy, as tests rather than prose
// ---------------------------------------------------------------------------

/// Reads the append-only ABI ledger.
fn abi_history() -> Value {
    let path = abi_history_path();
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|err| panic!("{} is not valid JSON: {err}", path.display()))
}

fn abi_history_entries() -> Vec<Value> {
    abi_history()["entries"]
        .as_array()
        .expect("abi-history.json has an `entries` array")
        .clone()
}

/// M0-e ①: an existing corpus is preserved, never overwritten.
///
/// Only the newest ABI may point at the live `fixtures.json` (which `fixtures_are_current`
/// regenerates); every earlier one must point at a frozen file whose sha256 is pinned in the
/// ledger. Regenerating over an archive, or forgetting to archive on an epoch bump, is a red here
/// — which is the whole point, because the archived bytes are the only later evidence of what a
/// dropped ABI actually put on the wire.
#[test]
fn archived_fixture_corpora_are_immutable() {
    let entries = abi_history_entries();
    assert!(!entries.is_empty(), "the ABI ledger must not be empty");

    for (index, entry) in entries.iter().enumerate() {
        let is_last = index + 1 == entries.len();
        let fixtures = entry["fixtures"]
            .as_str()
            .expect("every ledger entry names a fixtures artifact");

        if is_last {
            assert_eq!(
                fixtures, "fixtures.json",
                "the newest ABI must point at the live corpus, not an archive"
            );
            assert!(
                entry["fixtures_sha256"].is_null(),
                "the live corpus is pinned by `fixtures_are_current`, not by a sha in the ledger"
            );
            continue;
        }

        assert_ne!(
            fixtures, "fixtures.json",
            "entry {index} is superseded but still points at the live corpus; archive it under \
             docs/next/protocol/fixtures/ before bumping the epoch"
        );
        let path = protocol_docs_dir().join(fixtures);
        let bytes = std::fs::read(&path).unwrap_or_else(|err| {
            panic!(
                "archived corpus {} is missing: {err}. An archived ABI's bytes are not \
                 regenerable — restore it from git rather than deleting the ledger row.",
                path.display()
            )
        });
        let expected = entry["fixtures_sha256"]
            .as_str()
            .expect("an archived corpus must pin its sha256");
        assert_eq!(
            sha256_hex(&bytes),
            expected,
            "archived corpus {} was modified. STOP: archives are frozen. If you regenerated it, \
             restore it from git; if the wire changed, that is a NEW epoch and a NEW file.",
            path.display()
        );
    }
}

/// M0-e ②: a wire change must arrive as a declared ABI event, not as a quiet regeneration.
///
/// `wire_schema_fingerprint_is_pinned` (src/protocol/abi.rs) catches the layout move; this catches
/// the half that a repin alone would skip — the ledger has to name the new epoch, the new
/// fingerprint and a fresh corpus.
#[test]
fn abi_history_records_the_current_abi() {
    let entries = abi_history_entries();
    let current = entries.last().expect("the ledger has a newest entry");

    assert_eq!(
        current["protocol_version"].as_u64(),
        Some(u64::from(PROTOCOL_VERSION)),
        "the newest ledger entry must be this build's PROTOCOL_VERSION"
    );
    assert_eq!(
        current["wire_abi_epoch"].as_u64(),
        Some(u64::from(WIRE_ABI_EPOCH)),
        "the newest ledger entry must be this build's WIRE_ABI_EPOCH"
    );
    assert_eq!(
        current["schema_fingerprint"].as_str(),
        Some(hex(&abi::wire_schema_fingerprint()).as_str()),
        "the newest ledger entry must carry this build's live schema fingerprint. If this is red \
         you changed the wire: bump WIRE_ABI_EPOCH, repin WIRE_SCHEMA_FINGERPRINT, archive the \
         outgoing fixtures.json and APPEND a ledger entry."
    );
    assert_eq!(
        current["accepted_by_current_server"].as_bool(),
        Some(true),
        "a server that does not accept its own ABI cannot accept anything"
    );
}

/// M0-e ③: whether a superseded ABI is still accepted is an explicit, recorded decision.
///
/// The ledger and `abi::accepted_wire_abis()` are two statements of the same policy — one for
/// humans, one the code actually enforces — so they are compared. Dropping an old ABI silently
/// (removing the code row and leaving the ledger claiming it works, or the reverse) is a red.
#[test]
fn abi_history_mirrors_the_accepted_table() {
    let entries = abi_history_entries();

    for (index, entry) in entries.iter().enumerate() {
        assert!(
            entry["accepted_by_current_server"].is_boolean(),
            "ledger entry {index} does not say whether this server still accepts it; silence is \
             not a decision"
        );
        let decision = entry["decision"].as_str().unwrap_or_default();
        assert!(
            decision.len() > 40,
            "ledger entry {index} must record WHY, not just what"
        );
    }

    let declared: Vec<(u64, u64)> = entries
        .iter()
        .filter(|entry| entry["accepted_by_current_server"] == Value::Bool(true))
        .map(|entry| {
            (
                entry["protocol_version"].as_u64().expect("protocol_version"),
                entry["wire_abi_epoch"].as_u64().expect("wire_abi_epoch"),
            )
        })
        .collect();
    let enforced: Vec<(u64, u64)> = abi::accepted_wire_abis()
        .iter()
        .map(|accepted| {
            (
                u64::from(accepted.protocol_version),
                u64::from(accepted.abi_epoch),
            )
        })
        .collect();

    let mut declared_sorted = declared.clone();
    declared_sorted.sort_unstable();
    let mut enforced_sorted = enforced.clone();
    enforced_sorted.sort_unstable();
    assert_eq!(
        declared_sorted, enforced_sorted,
        "docs/next/protocol/abi-history.json claims to accept {declared:?} but \
         abi::accepted_wire_abis() enforces {enforced:?}. The window is a decision record and a \
         code table; they are not allowed to disagree."
    );
}

/// The prelude vector must be the bytes the server actually reads, not a transcription of them.
#[test]
fn prelude_vector_is_the_bytes_the_gate_reads() {
    let document = fixture_document();
    let vector = document["vectors"]
        .as_array()
        .expect("vectors array")
        .iter()
        .find(|vector| vector["name"] == "wire_abi_prelude")
        .expect("wire_abi_prelude vector")
        .clone();

    let bytes = decode_hex(vector["framed_hex"].as_str().expect("prelude framed_hex"));
    assert_eq!(bytes.len(), WIRE_ABI_PRELUDE_LEN);

    // Feed them back through the production reader: the artifact is only useful to a hand-rolled
    // client if the real gate accepts what it publishes.
    match abi::read_peer_handshake_start(&mut bytes.as_slice()).expect("prelude parses") {
        abi::PeerHandshakeStart::Prelude(peer) => {
            assert_eq!(
                abi::check_peer_abi(&peer),
                abi::AbiCheck::Accepted,
                "the published prelude must be one this build accepts"
            );
            assert_eq!(peer.protocol_version, PROTOCOL_VERSION);
            assert_eq!(peer.abi_epoch, WIRE_ABI_EPOCH);
        }
        other => panic!("the published prelude did not parse as one: {other:?}"),
    }
}

fn decode_hex(input: &str) -> Vec<u8> {
    assert!(
        input.len().is_multiple_of(2),
        "hex string has an odd length"
    );
    (0..input.len())
        .step_by(2)
        .map(|idx| u8::from_str_radix(&input[idx..idx + 2], 16).expect("valid hex"))
        .collect()
}

fn split_frame(framed: &[u8]) -> (usize, &[u8]) {
    let (len_bytes, payload) = framed.split_at(4);
    let len = u32::from_le_bytes(len_bytes.try_into().expect("4-byte length prefix")) as usize;
    (len, payload)
}
