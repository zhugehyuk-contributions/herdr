//! Generator for the golden vectors in `test/vectors.ts`.
//!
//! This file is NOT part of any cargo target (there is no Cargo.toml under `packages/`, and the
//! herdr crate's `include` list does not reach here) — it is kept next to the codec so the golden
//! bytes stay reproducible instead of being an unverifiable claim.
//!
//! Why a mirror instead of the real crate: bincode's output depends on exactly two things — a
//! variant's ordinal and a struct's field order — so mirroring those reproduces the real bytes
//! without building herdr. Keep the mirrors below in sync with `src/protocol/wire.rs`
//! (`RenderEncoding` :53, `ClientSurfaceMode` :62, `ClientKeybindings` :71, `ClientLaunchMode` :80,
//! `ClientMessage::Hello` :366, `ServerMessage` :797, `TerminalFrame` :771).
//!
//! Run:
//!   mkdir -p /tmp/genvec/src && cp packages/herdr-client-ts/tools/gen-vectors.rs /tmp/genvec/src/main.rs
//!   cat > /tmp/genvec/Cargo.toml <<'EOF'
//!   [package]
//!   name = "genvec"
//!   version = "0.0.0"
//!   edition = "2021"
//!   [dependencies]
//!   bincode = { version = "2", features = ["serde"] }
//!   serde = { version = "1", features = ["derive"] }
//!   EOF
//!   cd /tmp/genvec && cargo run --quiet
#![allow(dead_code)]

use serde::Serialize;

#[derive(Serialize)]
enum RenderEncoding {
    SemanticFrame,
    TerminalAnsi,
}

#[derive(Serialize)]
enum ClientSurfaceMode {
    FullApp,
    EmbeddedContent,
}

#[derive(Serialize)]
enum ClientKeybindings {
    Server,
    Local { keys_toml: String },
}

#[derive(Serialize)]
enum ClientLaunchMode {
    App,
    TerminalAttach,
}

#[derive(Serialize)]
enum ClientMessage {
    Hello {
        version: u32,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
        requested_encoding: RenderEncoding,
        surface_mode: ClientSurfaceMode,
        keybindings: ClientKeybindings,
        launch_mode: ClientLaunchMode,
    },
}

#[derive(Serialize)]
struct TerminalFrame {
    seq: u64,
    width: u16,
    height: u16,
    full: bool,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
enum ServerMessage {
    Welcome {
        version: u32,
        encoding: RenderEncoding,
        error: Option<String>,
    },
    // Filler so `Terminal` lands on the mx wire tag 13. Real names, for the record:
    // Frame, Graphics, ServerShutdown, Notify, Clipboard, WindowTitle, ReloadSoundConfig,
    // MouseCapture, FrameDelta, Pong, Compressed, PrefixInputSource.
    V1,
    V2,
    V3,
    V4,
    V5,
    V6,
    V7,
    V8,
    V9,
    V10,
    V11,
    V12,
    Terminal(TerminalFrame),
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn emit<T: Serialize>(name: &str, value: &T) {
    let payload = bincode::serde::encode_to_vec(value, bincode::config::standard()).unwrap();
    let mut framed = (payload.len() as u32).to_le_bytes().to_vec();
    framed.extend_from_slice(&payload);
    println!("{name}\tpayload={}\tframed={}", hex(&payload), hex(&framed));
}

fn main() {
    emit(
        "HELLO_SEMANTIC_APP_80X24",
        &ClientMessage::Hello {
            version: 20,
            cols: 80,
            rows: 24,
            cell_width_px: 8,
            cell_height_px: 16,
            requested_encoding: RenderEncoding::SemanticFrame,
            surface_mode: ClientSurfaceMode::FullApp,
            keybindings: ClientKeybindings::Server,
            launch_mode: ClientLaunchMode::App,
        },
    );
    emit(
        "HELLO_ANSI_ATTACH_300X100",
        &ClientMessage::Hello {
            version: 20,
            cols: 300,
            rows: 100,
            cell_width_px: 8,
            cell_height_px: 16,
            requested_encoding: RenderEncoding::TerminalAnsi,
            surface_mode: ClientSurfaceMode::FullApp,
            keybindings: ClientKeybindings::Server,
            launch_mode: ClientLaunchMode::TerminalAttach,
        },
    );
    emit(
        "HELLO_ANSI_ATTACH_65535_NO_CELLPX",
        &ClientMessage::Hello {
            version: 20,
            cols: 65535,
            rows: 65535,
            cell_width_px: 0,
            cell_height_px: 0,
            requested_encoding: RenderEncoding::TerminalAnsi,
            surface_mode: ClientSurfaceMode::FullApp,
            keybindings: ClientKeybindings::Server,
            launch_mode: ClientLaunchMode::TerminalAttach,
        },
    );
    emit(
        "WELCOME_OK_ANSI",
        &ServerMessage::Welcome {
            version: 20,
            encoding: RenderEncoding::TerminalAnsi,
            error: None,
        },
    );
    emit(
        "WELCOME_OK_SEMANTIC",
        &ServerMessage::Welcome {
            version: 20,
            encoding: RenderEncoding::SemanticFrame,
            error: None,
        },
    );
    emit(
        "WELCOME_ERROR",
        &ServerMessage::Welcome {
            version: 20,
            encoding: RenderEncoding::SemanticFrame,
            error: Some("client version 19 is older than server version 20".to_string()),
        },
    );
    emit(
        "WELCOME_ERROR_UTF8",
        &ServerMessage::Welcome {
            version: 20,
            encoding: RenderEncoding::SemanticFrame,
            error: Some("\u{ac70}\u{bd80}: \u{d55c}\u{ae00} \u{2705}".to_string()),
        },
    );
    emit(
        "TERMINAL_SMALL_FULL",
        &ServerMessage::Terminal(TerminalFrame {
            seq: 1,
            width: 100,
            height: 30,
            full: true,
            bytes: b"\x1b[2J\x1b[1;1H".to_vec(),
        }),
    );
    emit(
        "TERMINAL_SEQ_VARINT_U16",
        &ServerMessage::Terminal(TerminalFrame {
            seq: 251,
            width: 251,
            height: 65535,
            full: false,
            bytes: vec![],
        }),
    );
    emit(
        "TERMINAL_SEQ_U64",
        &ServerMessage::Terminal(TerminalFrame {
            seq: 4_294_967_296,
            width: 80,
            height: 24,
            full: false,
            bytes: vec![0xaa; 300],
        }),
    );

    for value in [
        0u64,
        250,
        251,
        65535,
        65536,
        4_294_967_295,
        4_294_967_296,
        u64::MAX,
    ] {
        let payload = bincode::serde::encode_to_vec(value, bincode::config::standard()).unwrap();
        println!("VARINT_U64 {value}\t{}", hex(&payload));
    }
}
