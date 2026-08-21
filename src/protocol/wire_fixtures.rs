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

use crate::protocol::{
    write_message, CellData, ClientKeybindings, ClientLaunchMode, ClientMessage, ClientSurfaceMode,
    CursorState, FrameData, RenderEncoding, ServerMessage, PROTOCOL_VERSION,
};
use crate::server::render_stream::ClientRenderState;

/// Fixture client geometry. Mirrors `tests/observe_terminal_ansi.rs` so the live integration test
/// and this corpus describe the same client.
const FIXTURE_COLS: u16 = 100;
const FIXTURE_ROWS: u16 = 30;

/// Past this, an inline `framed_hex` stops being reviewable in a diff; the vector carries a
/// prefix + digest instead.
const INLINE_BYTES_LIMIT: usize = 50 * 1024;
/// How much of an oversized `TerminalFrame.bytes` is still inlined, for eyeballing the preamble.
const BYTES_PREFIX_LEN: usize = 512;

fn artifact_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("docs/next/protocol/fixtures.json")
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
        target: "w1:p1".to_owned(),
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
            "fork": "herdr-mx",
            "note": "tags are fork-local; see mobile/.prd/03-blockers.md B1"
        },
        "framing": {
            "layout": "[u32LE payload_len][bincode payload]",
            "bincode": "bincode 2.x `config::standard()` — varint ints, LE, no fixed-width \
                        headers; enum discriminants are varints, `Option` is a 0x00/0x01 tag, \
                        `Vec<u8>`/`String` are varint length + raw bytes.",
            "max_frame_size": crate::protocol::MAX_FRAME_SIZE,
            "source": "src/protocol/wire.rs:1125 (write_message)"
        },
        "enums": {
            "RenderEncoding": ["SemanticFrame", "TerminalAnsi"],
            "ClientLaunchMode": ["App", "TerminalAttach"],
            "ClientMessage": { "ObserveTerminal": observe_terminal_tag },
            "ServerMessage": { "Welcome": welcome_tag, "Terminal": terminal_tag }
        },
        "vectors": [hello_vector(), welcome_vector(), terminal_frame_vector()],
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
        "wire fixture corpus at {} is stale (first difference on line {line_no}):\n  committed: {}\n  generated: {}\nRegenerate with `HERDR_UPDATE_WIRE_FIXTURES=1 just test-one fixtures_are_current`, and re-check the TS codec in mobile/ against the new bytes.",
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
