//! Integration test for the terminal-ANSI observe stream (the mobile-client render path).
//!
//! Everything else in `tests/` handshakes as `RenderEncoding::SemanticFrame`, so the
//! `TerminalAnsi` + `ObserveTerminal` path had no end-to-end coverage. This test proves the wire
//! contract a non-Rust client depends on: a client that declares `RenderEncoding::TerminalAnsi`
//! and observes a pane receives `ServerMessage::Terminal(TerminalFrame)` frames carrying real
//! ANSI bytes, and observing does not resize the observed pane's PTY.

mod support;

use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use support::{
    cleanup_test_base, client_handshake_with, decode_varint_u32, inflate_compressed_frame,
    read_server_message, register_runtime_dir, register_spawned_herdr_pid, send_observe_terminal,
    unregister_spawned_herdr_pid, wait_for_socket, CLIENT_LAUNCH_MODE_TERMINAL_ATTACH,
    CURRENT_PROTOCOL, RENDER_ENCODING_TERMINAL_ANSI, SERVER_MESSAGE_TERMINAL,
};

const CLIENT_COLS: u16 = 100;
const CLIENT_ROWS: u16 = 30;

fn unique_test_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    PathBuf::from(format!(
        "/tmp/herdr-observe-ansi-{}-{nanos}",
        std::process::id()
    ))
}

struct SpawnedHerdr {
    _master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Drop for SpawnedHerdr {
    fn drop(&mut self) {
        let pid = self.child.process_id();
        let _ = self.child.kill();

        if let Some(pid) = pid {
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                let mut status = 0;
                let result =
                    unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) };
                if result == pid as libc::pid_t || result == -1 {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }

            unregister_spawned_herdr_pid(Some(pid));
        }
    }
}

/// Spawns an XDG-isolated headless server. Mirrors `tests/api_ping.rs::spawn_herdr_with_options`;
/// the spawned pid is registered so cleanup only ever targets this test's own process.
fn spawn_server(config_home: &Path, runtime_dir: &Path, api_socket_path: &Path) -> SpawnedHerdr {
    fs::create_dir_all(config_home.join("herdr")).unwrap();
    fs::create_dir_all(runtime_dir).unwrap();
    register_runtime_dir(runtime_dir);
    fs::write(
        config_home.join("herdr/config.toml"),
        "onboarding = false\n",
    )
    .unwrap();

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();

    let mut cmd = CommandBuilder::new(env!("CARGO_BIN_EXE_herdr"));
    cmd.arg("server");
    cmd.env("XDG_CONFIG_HOME", config_home);
    cmd.env("XDG_RUNTIME_DIR", runtime_dir);
    cmd.env("HERDR_SOCKET_PATH", api_socket_path);
    cmd.env_remove("HERDR_CLIENT_SOCKET_PATH");
    cmd.env("SHELL", "/bin/sh");
    cmd.env_remove("HERDR_ENV");

    let child = pair.slave.spawn_command(cmd).unwrap();
    register_spawned_herdr_pid(child.process_id());

    SpawnedHerdr {
        _master: pair.master,
        child,
    }
}

fn send_request(socket_path: &Path, json: &str) -> serde_json::Value {
    let mut stream = UnixStream::connect(socket_path).expect("connect to API socket");
    stream.write_all(json.as_bytes()).unwrap();
    stream.write_all(b"\n").unwrap();
    stream.flush().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();

    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => panic!("API socket closed before a full line: {buf:?}"),
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                buf.push(byte[0]);
            }
            Err(err) => panic!("failed to read API response: {err}"),
        }
    }

    serde_json::from_slice(&buf).expect("API response should be JSON")
}

/// Runs `stty size` inside the pane and returns the PTY geometry the shell actually sees, as
/// `"<rows>x<cols>"`. This is the ground truth for "did observing resize the pane" — `pane.get`
/// carries no size field (`src/api/schema/panes.rs:398`).
fn pane_pty_size(socket_path: &Path, pane_id: &str, label: &str) -> String {
    let marker = format!("SZ{label}");
    let request = serde_json::json!({
        "id": format!("size_{label}"),
        "method": "pane.send_input",
        "params": {
            "pane_id": pane_id,
            "text": format!("echo {marker}:$(stty size | tr ' ' 'x')"),
            "keys": ["Enter"],
        }
    });
    let sent = send_request(socket_path, &request.to_string());
    assert_eq!(sent["result"]["type"], "ok", "pane.send_input failed: {sent}");

    let waited = send_request(
        socket_path,
        &serde_json::json!({
            "id": format!("size_wait_{label}"),
            "method": "pane.wait_for_output",
            "params": {
                "pane_id": pane_id,
                "source": "recent",
                "lines": 40,
                "match": {"type": "regex", "value": format!("{marker}:[0-9]+x[0-9]+")},
                "timeout_ms": 15000,
            }
        })
        .to_string(),
    );
    assert_eq!(
        waited["result"]["type"], "output_matched",
        "pane never reported its size for {label}: {waited}"
    );

    let line = waited["result"]["matched_line"]
        .as_str()
        .expect("matched_line")
        .to_string();
    let start = line
        .rfind(&format!("{marker}:"))
        .map(|idx| idx + marker.len() + 1)
        .unwrap_or_else(|| panic!("no {marker} marker in {line:?}"));
    line[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == 'x')
        .collect()
}

/// Same measurement, but only once two consecutive readings agree.
///
/// A freshly created pane starts at the server's own PTY size and is resized to its layout rect
/// on the first virtual render (`src/server/headless.rs:4074` — `render_and_stream` passes
/// `resize_panes` while no client is attached). That startup drift (24x80 -> 23x53 here) is
/// client-independent — proven by sampling `stty size` for seconds with no client ever
/// connecting — so the invariance assertion has to start from the settled size, not from a
/// reading that may have raced the initial layout pass.
fn settled_pane_pty_size(socket_path: &Path, pane_id: &str, label: &str) -> String {
    let mut last = pane_pty_size(socket_path, pane_id, &format!("{label}0"));
    for round in 1..8 {
        thread::sleep(Duration::from_millis(250));
        let next = pane_pty_size(socket_path, pane_id, &format!("{label}{round}"));
        if next == last {
            return next;
        }
        last = next;
    }
    panic!("pane PTY size never settled (last reading {last})");
}

#[derive(Debug)]
struct TerminalFrameWire {
    seq: u64,
    width: u16,
    height: u16,
    full: bool,
    bytes: Vec<u8>,
}

/// Decodes `ServerMessage::Terminal(TerminalFrame)` payload bytes (the enum tag is already
/// stripped by `read_server_message`). Field order per `src/protocol/wire.rs:771-782`.
fn decode_terminal_frame(payload: &[u8]) -> Result<TerminalFrameWire, String> {
    let mut offset = 0;
    let (seq, consumed) = decode_varint_u64(payload, offset)?;
    offset += consumed;
    let (width, consumed) = decode_varint_u64(payload, offset)?;
    offset += consumed;
    let (height, consumed) = decode_varint_u64(payload, offset)?;
    offset += consumed;

    if offset >= payload.len() {
        return Err("payload too short for `full` flag".into());
    }
    let full = payload[offset] != 0;
    offset += 1;

    let (len, consumed) = decode_varint_u64(payload, offset)?;
    offset += consumed;
    let len = len as usize;
    if offset + len > payload.len() {
        return Err(format!(
            "payload too short for {len} frame bytes (have {})",
            payload.len() - offset
        ));
    }

    Ok(TerminalFrameWire {
        seq,
        width: width as u16,
        height: height as u16,
        full,
        bytes: payload[offset..offset + len].to_vec(),
    })
}

/// bincode v2 varint decode widened to u64 (tag 253); `support::decode_varint_u32` stops at u32.
fn decode_varint_u64(payload: &[u8], offset: usize) -> Result<(u64, usize), String> {
    if offset >= payload.len() {
        return Err("payload too short for varint".into());
    }
    match payload[offset] {
        253 => {
            if offset + 9 > payload.len() {
                return Err("payload too short for u64 varint".into());
            }
            let v = u64::from_le_bytes(
                payload[offset + 1..offset + 9]
                    .try_into()
                    .map_err(|e: std::array::TryFromSliceError| e.to_string())?,
            );
            Ok((v, 9))
        }
        _ => decode_varint_u32(payload, offset).map(|(v, consumed)| (u64::from(v), consumed)),
    }
}

/// Reads client-stream messages until a `Terminal` frame with a non-empty payload arrives.
fn read_terminal_frame(stream: &mut UnixStream, timeout: Duration) -> TerminalFrameWire {
    stream.set_read_timeout(Some(timeout)).unwrap();
    let deadline = Instant::now() + timeout;
    let mut seen: Vec<u32> = Vec::new();

    while Instant::now() < deadline {
        let (variant, payload) = match read_server_message(stream) {
            Ok(message) => message,
            Err(err) => panic!("client stream ended before a Terminal frame ({err}); variants seen: {seen:?}"),
        };
        let (variant, payload) = inflate_compressed_frame(variant, &payload);
        seen.push(variant);
        if variant != SERVER_MESSAGE_TERMINAL {
            continue;
        }
        let frame = decode_terminal_frame(&payload).expect("decode TerminalFrame");
        if frame.bytes.is_empty() {
            continue;
        }
        return frame;
    }

    panic!("no Terminal frame within {timeout:?}; variants seen: {seen:?}");
}

/// Projects the printable text out of an ANSI stream. `BlitEncoder` emits a cursor move plus an
/// SGR run before *every* cell (see the frame sample in `visualize`), so screen text is never
/// contiguous in the raw bytes — a substring check has to run against this projection.
fn strip_ansi_text(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut idx = 0;
    while idx < bytes.len() {
        let byte = bytes[idx];
        if byte != 0x1b {
            if (0x20..=0x7e).contains(&byte) {
                out.push(byte as char);
            }
            idx += 1;
            continue;
        }

        idx += 1;
        match bytes.get(idx) {
            // CSI: parameters/intermediates until a final byte in 0x40..=0x7e.
            Some(b'[') => {
                idx += 1;
                while idx < bytes.len() && !(0x40..=0x7e).contains(&bytes[idx]) {
                    idx += 1;
                }
                idx += 1;
            }
            // OSC (and other string sequences): until BEL or ST (ESC \).
            Some(b']') | Some(b'P') | Some(b'^') | Some(b'_') => {
                idx += 1;
                while idx < bytes.len() {
                    if bytes[idx] == 0x07 {
                        idx += 1;
                        break;
                    }
                    if bytes[idx] == 0x1b && bytes.get(idx + 1) == Some(&b'\\') {
                        idx += 2;
                        break;
                    }
                    idx += 1;
                }
            }
            Some(_) => idx += 1,
            None => break,
        }
    }
    out
}

fn visualize(bytes: &[u8], limit: usize) -> String {
    let mut out = String::new();
    for byte in bytes.iter().take(limit) {
        match byte {
            0x1b => out.push_str("<ESC>"),
            0x07 => out.push_str("<BEL>"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            0x20..=0x7e => out.push(*byte as char),
            other => out.push_str(&format!("<{other:02x}>")),
        }
    }
    out
}

#[test]
fn observe_terminal_streams_ansi_bytes_without_resizing_pane() {
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");
    let client_socket = runtime_dir.join("herdr-client.sock");

    let spawned = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(15));
    wait_for_socket(&client_socket, Duration::from_secs(15));

    // A pane with a live shell to observe.
    let created = send_request(
        &api_socket,
        &format!(
            r#"{{"id":"ws","method":"workspace.create","params":{{"cwd":"{}","focus":true}}}}"#,
            base.display()
        ),
    );
    assert_eq!(
        created["result"]["type"], "workspace_created",
        "workspace.create failed: {created}"
    );
    let pane_id = created["result"]["root_pane"]["pane_id"]
        .as_str()
        .expect("root pane id")
        .to_string();

    // Put a recognizable string on the observed screen so the ANSI blit has content to carry.
    let marker = "OBSMARKER";
    let echoed = send_request(
        &api_socket,
        &serde_json::json!({
            "id": "marker",
            "method": "pane.send_input",
            "params": {"pane_id": pane_id, "text": format!("echo {marker}"), "keys": ["Enter"]}
        })
        .to_string(),
    );
    assert_eq!(echoed["result"]["type"], "ok", "send_input failed: {echoed}");

    let size_before = settled_pane_pty_size(&api_socket, &pane_id, "BEFORE");

    // Terminal-ANSI observe client: `RenderEncoding::TerminalAnsi` +
    // `ClientLaunchMode::TerminalAttach` + `ClientMessage::ObserveTerminal`.
    let mut stream = UnixStream::connect(&client_socket).expect("connect to client socket");
    let (version, error) = client_handshake_with(
        &mut stream,
        CURRENT_PROTOCOL,
        CLIENT_COLS,
        CLIENT_ROWS,
        RENDER_ENCODING_TERMINAL_ANSI,
        CLIENT_LAUNCH_MODE_TERMINAL_ATTACH,
    )
    .expect("handshake should succeed");
    assert_eq!(version, CURRENT_PROTOCOL);
    assert_eq!(error, None, "server rejected the terminal-ansi handshake");

    send_observe_terminal(&mut stream, &pane_id).expect("send ObserveTerminal");

    let frame = read_terminal_frame(&mut stream, Duration::from_secs(20));

    println!(
        "TerminalFrame seq={} width={} height={} full={} bytes_len={}",
        frame.seq,
        frame.width,
        frame.height,
        frame.full,
        frame.bytes.len()
    );
    println!("first 120 bytes: {}", visualize(&frame.bytes, 120));

    assert!(
        !frame.bytes.is_empty(),
        "terminal frame carried no bytes: {frame:?}"
    );
    assert!(
        frame.bytes.contains(&0x1b),
        "terminal frame carried no ESC sequence: {}",
        visualize(&frame.bytes, 200)
    );
    assert!(frame.seq >= 1, "terminal frame seq should start at 1");
    assert_eq!(
        (frame.width, frame.height),
        (CLIENT_COLS, CLIENT_ROWS),
        "observed frame should be sized to the observing client"
    );

    let rendered = strip_ansi_text(&frame.bytes);
    assert!(
        rendered.contains(marker),
        "observed ANSI stream did not carry the pane's visible text: {}",
        visualize(&frame.bytes, 400)
    );

    // Observing is read-only: the observed pane's PTY keeps its size while we are attached.
    let size_after = pane_pty_size(&api_socket, &pane_id, "AFTER");
    assert_eq!(
        size_before, size_after,
        "observing resized the pane PTY ({size_before} -> {size_after})"
    );

    drop(stream);
    drop(spawned);
    cleanup_test_base(&base);
}
