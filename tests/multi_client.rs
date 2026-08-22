//! Integration tests for multi-client server behavior.

mod support;

use std::collections::VecDeque;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::Value;
use support::{
    cleanup_test_base, register_runtime_dir, register_spawned_herdr_pid,
    unregister_spawned_herdr_pid, CURRENT_PROTOCOL,
};

fn unique_test_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    PathBuf::from(format!(
        "/tmp/herdr-multi-client-test-{}-{nanos}",
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

fn cleanup_spawned_herdr(spawned: SpawnedHerdr, base: PathBuf) {
    drop(spawned);
    cleanup_test_base(&base);
}

fn wait_for_child_exit(child: &mut Box<dyn Child + Send + Sync>) {
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn test_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wait_for_socket(path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() && UnixStream::connect(path).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("socket did not appear at {}", path.display());
}

fn wait_for_file(path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() && UnixStream::connect(path).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("socket did not accept connections at {}", path.display());
}

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
    drop(pair.slave);

    SpawnedHerdr {
        _master: pair.master,
        child,
    }
}

fn spawn_named_server(config_home: &Path, runtime_dir: &Path, session_name: &str) -> SpawnedHerdr {
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
    cmd.arg("--session");
    cmd.arg(session_name);
    cmd.env("XDG_CONFIG_HOME", config_home);
    cmd.env("XDG_RUNTIME_DIR", runtime_dir);
    cmd.env_remove("HERDR_SOCKET_PATH");
    cmd.env_remove("HERDR_CLIENT_SOCKET_PATH");
    cmd.env("SHELL", "/bin/sh");
    cmd.env_remove("HERDR_ENV");

    let child = pair.slave.spawn_command(cmd).unwrap();
    register_spawned_herdr_pid(child.process_id());
    drop(pair.slave);

    SpawnedHerdr {
        _master: pair.master,
        child,
    }
}

fn session_socket_dir(config_home: &Path, session_name: &str) -> PathBuf {
    let app_dir = if cfg!(debug_assertions) {
        "herdr-dev"
    } else {
        "herdr"
    };
    config_home
        .join(app_dir)
        .join("sessions")
        .join(session_name)
}

fn spawn_client_process(
    config_home: &Path,
    runtime_dir: &Path,
    api_socket_path: &Path,
) -> SpawnedHerdr {
    register_runtime_dir(runtime_dir);
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();

    let mut cmd = CommandBuilder::new(env!("CARGO_BIN_EXE_herdr"));
    cmd.arg("client");
    cmd.env("HERDR_DISABLE_SOUND", "1");
    cmd.env("XDG_CONFIG_HOME", config_home);
    cmd.env("XDG_RUNTIME_DIR", runtime_dir);
    cmd.env("HERDR_SOCKET_PATH", api_socket_path);
    cmd.env_remove("HERDR_CLIENT_SOCKET_PATH");
    cmd.env("SHELL", "/bin/sh");
    cmd.env_remove("HERDR_ENV");

    let child = pair.slave.spawn_command(cmd).unwrap();
    register_spawned_herdr_pid(child.process_id());
    drop(pair.slave);

    SpawnedHerdr {
        _master: pair.master,
        child,
    }
}

fn server_log_path(config_home: &Path) -> PathBuf {
    let app_dir = if cfg!(debug_assertions) {
        "herdr-dev"
    } else {
        "herdr"
    };
    config_home.join(app_dir).join("herdr-server.log")
}

fn count_log_occurrences(path: &Path, needle: &str) -> usize {
    fs::read_to_string(path)
        .ok()
        .map(|text| text.lines().filter(|line| line.contains(needle)).count())
        .unwrap_or(0)
}

fn log_tail(path: &Path, lines: usize) -> String {
    let Ok(text) = fs::read_to_string(path) else {
        return format!("could not read {}", path.display());
    };
    let mut tail = VecDeque::with_capacity(lines);
    for line in text.lines() {
        if tail.len() == lines {
            tail.pop_front();
        }
        tail.push_back(line.to_string());
    }
    tail.into_iter().collect::<Vec<_>>().join("\n")
}

fn wait_for_log_occurrence_count(
    path: &Path,
    needle: &str,
    min_count: usize,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if count_log_occurrences(path, needle) >= min_count {
            return true;
        }
        thread::sleep(Duration::from_millis(40));
    }
    false
}

fn ping_socket(socket_path: &Path) -> String {
    let mut stream = UnixStream::connect(socket_path).expect("should connect to API socket");
    writeln!(
        stream,
        "{{\"id\":\"ping\",\"method\":\"ping\",\"params\":{{}}}}"
    )
    .unwrap();

    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader.read_line(&mut response).unwrap();
    response.trim().to_string()
}

fn send_json_request(socket_path: &Path, request: &str) -> Value {
    let mut stream = UnixStream::connect(socket_path).expect("should connect to API socket");
    writeln!(stream, "{request}").unwrap();

    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader.read_line(&mut response).unwrap();

    serde_json::from_str(&response).expect("response should be valid JSON")
}

fn workspace_list(socket_path: &Path) -> Value {
    send_json_request(
        socket_path,
        r#"{"id":"workspace_list","method":"workspace.list","params":{}}"#,
    )
}

fn workspace_count(socket_path: &Path) -> usize {
    workspace_list(socket_path)
        .pointer("/result/workspaces")
        .and_then(Value::as_array)
        .map(Vec::len)
        .expect("workspace.list should return a workspace array")
}

fn wait_for_workspace_count(socket_path: &Path, expected: usize, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if workspace_count(socket_path) == expected {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

fn spawn_pty_output_collector(master: &dyn MasterPty) -> mpsc::Receiver<String> {
    let mut reader = master.try_clone_reader().expect("clone PTY reader");
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    if tx
                        .send(String::from_utf8_lossy(&buf[..n]).into_owned())
                        .is_err()
                    {
                        return;
                    }
                }
                Ok(_) => return,
                Err(_) => return,
            }
        }
    });
    rx
}

fn wait_for_output_containing(
    rx: &mpsc::Receiver<String>,
    needles: &[&str],
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    let mut raw_output = String::new();
    let mut output = String::new();
    while Instant::now() < deadline {
        let slice = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(100));
        match rx.recv_timeout(slice) {
            Ok(chunk) => {
                raw_output.push_str(&chunk);
                output = strip_ansi_for_test(&raw_output);
                if needles.iter().all(|needle| output.contains(needle)) {
                    return true;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
    eprintln!(
        "client PTY output did not contain {needles:?}. Captured output: {}",
        output.escape_debug()
    );
    false
}

fn strip_ansi_for_test(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != 0x1b {
            let ch = input[i..].chars().next().expect("valid UTF-8 char");
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }

        i += 1;
        if i >= bytes.len() {
            break;
        }
        match bytes[i] {
            b'[' => {
                i += 1;
                while i < bytes.len() {
                    let byte = bytes[i];
                    i += 1;
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
            }
            b']' => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            }
            b'P' | b'_' | b'^' | b'X' | b'G' => {
                i += 1;
                while i + 1 < bytes.len() {
                    if bytes[i] == 0x1b && bytes[i + 1] == b'\\' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            }
            _ => {
                i += 1;
            }
        }
    }
    out
}

fn write_sgr_mouse_click(writer: &mut dyn Write, column: u16, row: u16) {
    write!(writer, "\x1b[<0;{column};{row}M").expect("write SGR mouse click");
    writer.flush().expect("flush SGR mouse click");
}

fn create_workspace_and_root_pane(socket_path: &Path, label: &str) -> (String, String) {
    let response = send_json_request(
        socket_path,
        &format!(
            "{{\"id\":\"ws_create\",\"method\":\"workspace.create\",\"params\":{{\"label\":\"{label}\"}}}}"
        ),
    );

    if response.get("error").is_some() {
        panic!("workspace.create failed: {response}");
    }

    let workspace_id = response
        .pointer("/result/workspace/workspace_id")
        .and_then(Value::as_str)
        .expect("workspace.create should return workspace id")
        .to_string();

    let pane_id = response
        .pointer("/result/root_pane/pane_id")
        .and_then(Value::as_str)
        .expect("workspace.create should return root pane id")
        .to_string();

    (workspace_id, pane_id)
}

fn pane_send_input(socket_path: &Path, pane_id: &str, text: &str) {
    let request = format!(
        "{{\"id\":\"send_input\",\"method\":\"pane.send_input\",\"params\":{{\"pane_id\":\"{pane_id}\",\"text\":\"{}\",\"keys\":[\"Enter\"]}}}}",
        text.replace('"', "\\\"")
    );
    let response = send_json_request(socket_path, &request);
    if response.get("error").is_some() {
        panic!("pane.send_input failed: {response}");
    }
}

fn pane_read_recent(socket_path: &Path, pane_id: &str, lines: usize) -> String {
    let response = send_json_request(
        socket_path,
        &format!(
            "{{\"id\":\"pane_read\",\"method\":\"pane.read\",\"params\":{{\"pane_id\":\"{pane_id}\",\"source\":\"recent\",\"lines\":{lines}}}}}"
        ),
    );

    if response.get("error").is_some() {
        panic!("pane.read failed: {response}");
    }

    response
        .pointer("/result/read/text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn pane_read_recent_contains(
    socket_path: &Path,
    pane_id: &str,
    needle: &str,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if pane_read_recent(socket_path, pane_id, 200).contains(needle) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

fn parse_size_after_marker(text: &str, marker: &str) -> Option<(u16, u16)> {
    let mut seen_marker = false;
    for line in text.lines() {
        if !seen_marker {
            if line.contains(marker) {
                seen_marker = true;
            }
            continue;
        }

        let mut parts = line.split_whitespace();
        let Some(rows_raw) = parts.next() else {
            continue;
        };
        let Some(cols_raw) = parts.next() else {
            continue;
        };

        let Ok(rows) = rows_raw.parse::<u16>() else {
            continue;
        };
        let Ok(cols) = cols_raw.parse::<u16>() else {
            continue;
        };

        return Some((rows, cols));
    }

    None
}

fn try_read_pane_tty_size(
    socket_path: &Path,
    pane_id: &str,
    timeout: Duration,
) -> Option<(u16, u16)> {
    let marker = format!(
        "SIZE_MARKER_{}_{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );

    pane_send_input(socket_path, pane_id, &format!("echo {marker}; stty size"));

    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let text = pane_read_recent(socket_path, pane_id, 200);
        if let Some(size) = parse_size_after_marker(&text, &marker) {
            return Some(size);
        }
        thread::sleep(Duration::from_millis(50));
    }

    None
}

fn read_pane_tty_size(socket_path: &Path, pane_id: &str, timeout: Duration) -> (u16, u16) {
    if let Some(size) = try_read_pane_tty_size(socket_path, pane_id, timeout) {
        return size;
    }

    let snapshot = pane_read_recent(socket_path, pane_id, 200);
    panic!(
        "did not observe tty size after marker. pane output:\n{}",
        snapshot
    );
}

// ---------------------------------------------------------------------------
// Minimal bincode v2 varint helpers for protocol tests
// ---------------------------------------------------------------------------

fn encode_varint_u32(v: u32) -> Vec<u8> {
    if v < 251 {
        vec![v as u8]
    } else if v < 65536 {
        let mut buf = vec![251u8];
        buf.extend_from_slice(&(v as u16).to_le_bytes());
        buf
    } else {
        let mut buf = vec![252u8];
        buf.extend_from_slice(&v.to_le_bytes());
        buf
    }
}

fn encode_varint_u16(v: u16) -> Vec<u8> {
    if v < 251 {
        vec![v as u8]
    } else {
        let mut buf = vec![251u8];
        buf.extend_from_slice(&v.to_le_bytes());
        buf
    }
}

fn encode_varint_enum(variant_idx: u32, fields: &[&[u8]]) -> Vec<u8> {
    let mut buf = encode_varint_u32(variant_idx);
    for field in fields {
        buf.extend_from_slice(field);
    }
    buf
}

fn frame_message(payload: &[u8]) -> Vec<u8> {
    let len = payload.len() as u32;
    let mut framed = len.to_le_bytes().to_vec();
    framed.extend_from_slice(payload);
    framed
}

fn decode_varint_u32(payload: &[u8], offset: usize) -> Result<(u32, usize), String> {
    if offset >= payload.len() {
        return Err("payload too short for varint".into());
    }
    let first_byte = payload[offset];
    match first_byte {
        0..=250 => Ok((first_byte as u32, 1)),
        251 => {
            if offset + 3 > payload.len() {
                return Err("payload too short for u16 varint".into());
            }
            let v = u16::from_le_bytes(
                payload[offset + 1..offset + 3]
                    .try_into()
                    .map_err(|e: std::array::TryFromSliceError| e.to_string())?,
            );
            Ok((v as u32, 3))
        }
        252 => {
            if offset + 5 > payload.len() {
                return Err("payload too short for u32 varint".into());
            }
            let v = u32::from_le_bytes(
                payload[offset + 1..offset + 5]
                    .try_into()
                    .map_err(|e: std::array::TryFromSliceError| e.to_string())?,
            );
            Ok((v, 5))
        }
        _ => Err(format!("unsupported varint tag: {first_byte}")),
    }
}

fn is_timeout(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}

fn read_server_variant(stream: &mut UnixStream, timeout: Duration) -> io::Result<u32> {
    stream.set_read_timeout(Some(timeout))?;

    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "zero-length payload",
        ));
    }

    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload)?;

    let (variant, _consumed) = decode_varint_u32(&payload, 0)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(variant)
}

fn client_handshake(
    stream: &mut UnixStream,
    version: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;

    // ClientMessage::Hello = variant 0
    let hello_payload = encode_varint_enum(
        0,
        &[
            &encode_varint_u32(version),
            &encode_varint_u16(cols),
            &encode_varint_u16(rows),
            &encode_varint_u32(8),  // cell_width_px
            &encode_varint_u32(16), // cell_height_px
            &encode_varint_u32(0),  // RenderEncoding::SemanticFrame
            &encode_varint_u32(0),  // ClientSurfaceMode::FullApp
            &encode_varint_u32(0),  // ClientKeybindings::Server
            &encode_varint_u32(0),  // ClientLaunchMode::App
        ],
    );
    // The wire-ABI prelude precedes the Hello frame (`src/protocol/abi.rs`).
    support::send_wire_abi_prelude(stream)?;
    stream
        .write_all(&frame_message(&hello_payload))
        .map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    // The server's prelude, then ServerMessage::Welcome = variant 0
    support::expect_wire_abi_prelude(stream)?;
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).map_err(|e| e.to_string())?;
    let len = u32::from_le_bytes(len_buf) as usize;
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).map_err(|e| e.to_string())?;

    let mut offset = 0;
    let (variant, consumed) = decode_varint_u32(&payload, offset)?;
    offset += consumed;
    if variant != 0 {
        return Err(format!("expected Welcome variant 0, got {variant}"));
    }

    let (_server_version, consumed) = decode_varint_u32(&payload, offset)?;
    offset += consumed;

    let (_encoding, consumed) = decode_varint_u32(&payload, offset)?;
    offset += consumed;

    if offset >= payload.len() {
        return Err("payload too short for Welcome.error option tag".into());
    }
    let option_tag = payload[offset];
    offset += 1;

    if option_tag == 1 {
        let (str_len, consumed) = decode_varint_u32(&payload, offset)?;
        offset += consumed;
        let str_len = str_len as usize;
        if offset + str_len > payload.len() {
            return Err("payload too short for welcome error string".into());
        }
        let err = String::from_utf8(payload[offset..offset + str_len].to_vec())
            .map_err(|e| e.to_string())?;
        return Err(format!("handshake rejected: {err}"));
    }

    Ok(())
}

fn connect_raw_client(client_socket: &Path, cols: u16, rows: u16) -> UnixStream {
    let mut stream = UnixStream::connect(client_socket).expect("should connect to client socket");
    client_handshake(&mut stream, CURRENT_PROTOCOL, cols, rows).expect("handshake should succeed");
    stream
}

fn send_client_input(stream: &mut UnixStream, data: &[u8]) {
    // ClientMessage::Input = variant 1
    let payload = {
        let mut buf = encode_varint_u32(1);
        buf.extend_from_slice(&encode_varint_u32(data.len() as u32));
        buf.extend_from_slice(data);
        buf
    };
    stream.write_all(&frame_message(&payload)).unwrap();
    stream.flush().unwrap();
}

fn send_client_detach(stream: &mut UnixStream) {
    // ClientMessage::Detach = variant 4
    let payload = encode_varint_u32(4);
    stream.write_all(&frame_message(&payload)).unwrap();
    stream.flush().unwrap();
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct FrameWire {
    cells: Vec<CellWire>,
    width: u16,
    height: u16,
    cursor: Option<CursorWire>,
    hyperlinks: Vec<String>,
    graphics: Vec<u8>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct CellWire {
    symbol: String,
    fg: u32,
    bg: u32,
    modifier: u16,
    skip: bool,
    hyperlink: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct CursorWire {
    x: u16,
    y: u16,
    visible: bool,
    shape: u8,
}

fn decode_frame_payload(payload: &[u8]) -> io::Result<FrameWire> {
    bincode::serde::decode_from_slice(payload, bincode::config::standard())
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))
        .and_then(|(frame, consumed): (FrameWire, usize)| {
            if consumed != payload.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "frame payload had trailing bytes: consumed={}, len={}",
                        consumed,
                        payload.len()
                    ),
                ));
            }
            Ok(frame)
        })
}

fn read_server_message_payload(
    stream: &mut UnixStream,
    timeout: Duration,
) -> io::Result<(u32, Vec<u8>)> {
    stream.set_read_timeout(Some(timeout))?;

    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "zero-length payload",
        ));
    }

    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload)?;

    let (variant, consumed) = decode_varint_u32(&payload, 0)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    Ok((variant, payload[consumed..].to_vec()))
}

fn drain_server_messages(stream: &mut UnixStream, max_drain: Duration) {
    let deadline = Instant::now() + max_drain;
    while Instant::now() < deadline {
        match read_server_variant(stream, Duration::from_millis(50)) {
            Ok(_) => {}
            Err(err) if is_timeout(&err) => break,
            Err(_) => break,
        }
    }
}

fn wait_for_frame(stream: &mut UnixStream, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let slice = remaining.min(Duration::from_millis(75));
        match read_server_variant(stream, slice) {
            // Frame (1), FrameDelta (9), or Compressed frame (11) — issue #13.
            Ok(1) | Ok(9) | Ok(11) => return true,
            Ok(_) => {}
            Err(err) if is_timeout(&err) => {}
            Err(_) => return false,
        }
    }
    false
}

fn wait_for_frame_matching_with_snapshots(
    stream: &mut UnixStream,
    timeout: Duration,
    predicate: impl Fn(&FrameWire) -> bool,
) -> io::Result<(bool, Vec<String>)> {
    let deadline = Instant::now() + timeout;
    let mut snapshots = VecDeque::with_capacity(5);
    while Instant::now() < deadline {
        let slice = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(80));
        match read_server_message_payload(stream, slice) {
            Ok((variant, payload)) => {
                // issue #13: inflate deflate-wrapped frames before decoding.
                let (variant, payload) = support::inflate_compressed_frame(variant, &payload);
                if variant == 1 {
                    let frame = decode_frame_payload(&payload)?;
                    if snapshots.len() == 5 {
                        snapshots.pop_front();
                    }
                    snapshots.push_back(frame_text(&frame));
                    if predicate(&frame) {
                        return Ok((true, snapshots.into_iter().collect()));
                    }
                }
            }
            Err(err) if is_timeout(&err) => {}
            Err(err) => return Err(err),
        }
    }

    Ok((false, snapshots.into_iter().collect()))
}

fn frame_text(frame: &FrameWire) -> String {
    if frame.cells.is_empty() {
        return String::new();
    }

    let row_width = frame.width.max(1) as usize;
    let mut full_text = String::new();

    for row in frame.cells.chunks(row_width) {
        for cell in row {
            let _ = (cell.fg, cell.bg, cell.modifier, cell.skip);
            full_text.push_str(&cell.symbol);
        }
        full_text.push('\n');
    }

    let _ = (frame.height, frame.graphics.len());
    if let Some(cursor) = frame.cursor.as_ref() {
        let _ = (cursor.x, cursor.y, cursor.visible, cursor.shape);
    }

    full_text
}

fn frame_contains_text(frame: &FrameWire, needle: &str) -> bool {
    frame_text(frame).contains(needle)
}

#[test]
fn multi_client_allows_multiple_simultaneous_connections() {
    let _lock = test_lock();
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");
    let client_socket = runtime_dir.join("herdr-client.sock");

    let server = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(10));
    wait_for_file(&client_socket, Duration::from_secs(10));

    let mut client_a = connect_raw_client(&client_socket, 120, 40);
    let mut client_b = connect_raw_client(&client_socket, 100, 30);

    assert!(
        wait_for_frame(&mut client_a, Duration::from_secs(2)),
        "client A should receive frames"
    );
    assert!(
        wait_for_frame(&mut client_b, Duration::from_secs(2)),
        "client B should receive frames"
    );

    let ping = ping_socket(&api_socket);
    assert!(
        ping.contains("pong"),
        "server should remain responsive: {ping}"
    );

    cleanup_spawned_herdr(server, base);
}

#[test]
fn multi_client_effective_size_shrinks_when_smaller_client_joins() {
    let _lock = test_lock();
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");
    let client_socket = runtime_dir.join("herdr-client.sock");

    let server = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(10));
    wait_for_file(&client_socket, Duration::from_secs(10));

    let (_workspace_id, pane_id) = create_workspace_and_root_pane(&api_socket, "size-shrink");

    let mut large = connect_raw_client(&client_socket, 120, 40);
    assert!(wait_for_frame(&mut large, Duration::from_secs(2)));
    let large_only_size = read_pane_tty_size(&api_socket, &pane_id, Duration::from_secs(5));

    let mut small = connect_raw_client(&client_socket, 80, 24);
    assert!(wait_for_frame(&mut small, Duration::from_secs(2)));

    let deadline = Instant::now() + Duration::from_secs(8);
    let mut last_seen_size = None;
    let mut size_with_small_client = None;
    while Instant::now() < deadline {
        if let Some(size) =
            try_read_pane_tty_size(&api_socket, &pane_id, Duration::from_millis(400))
        {
            last_seen_size = Some(size);
            if size.0 < large_only_size.0 && size.1 < large_only_size.1 {
                size_with_small_client = Some(size);
                break;
            }
        }
        thread::sleep(Duration::from_millis(60));
    }

    assert!(
        size_with_small_client.is_some(),
        "effective pane size should shrink when smaller client joins: before={large_only_size:?}, last_seen={last_seen_size:?}"
    );

    cleanup_spawned_herdr(server, base);
}

#[test]
fn multi_client_broadcasts_frame_updates_to_all_clients() {
    let _lock = test_lock();
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");
    let client_socket = runtime_dir.join("herdr-client.sock");

    let server = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(10));
    wait_for_file(&client_socket, Duration::from_secs(10));

    let mut client_a = connect_raw_client(&client_socket, 100, 30);
    let mut client_b = connect_raw_client(&client_socket, 100, 30);

    // Ensure we have an active pane that can reflect input changes.
    let (_workspace_id, pane_id) =
        create_workspace_and_root_pane(&api_socket, "broadcast-client-a-to-b");

    // Drain initial frames so we measure the frame caused by new input.
    drain_server_messages(&mut client_a, Duration::from_millis(300));
    drain_server_messages(&mut client_b, Duration::from_millis(300));

    let marker = format!(
        "MB{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    send_client_input(&mut client_a, format!("echo {marker}\n").as_bytes());
    if !pane_read_recent_contains(&api_socket, &pane_id, &marker, Duration::from_secs(5)) {
        panic!(
            "pane output should include client A marker so broadcast reflects a real state change. pane output:\n{}\nserver log tail:\n{}",
            pane_read_recent(&api_socket, &pane_id, 200),
            log_tail(&server_log_path(&config_home), 80)
        );
    }
    let (received, client_b_frames) =
        wait_for_frame_matching_with_snapshots(&mut client_b, Duration::from_secs(10), |frame| {
            frame_contains_text(frame, &marker)
        })
        .expect("frame decoding should succeed");

    assert!(
        received,
        "client B should receive a broadcast frame containing client A marker. pane output:\n{}\nclient B frame snapshots:\n{}\nserver log tail:\n{}",
        pane_read_recent(&api_socket, &pane_id, 200),
        client_b_frames.join("\n--- frame ---\n"),
        log_tail(&server_log_path(&config_home), 80)
    );

    cleanup_spawned_herdr(server, base);
}

#[test]
fn multi_client_disconnect_recalculates_to_next_smallest() {
    let _lock = test_lock();
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");
    let client_socket = runtime_dir.join("herdr-client.sock");

    let server = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(10));
    wait_for_file(&client_socket, Duration::from_secs(10));

    let (_workspace_id, pane_id) =
        create_workspace_and_root_pane(&api_socket, "size-next-smallest");

    let mut c120 = connect_raw_client(&client_socket, 120, 40);
    let mut c100 = connect_raw_client(&client_socket, 100, 30);
    let mut c80 = connect_raw_client(&client_socket, 80, 24);

    assert!(wait_for_frame(&mut c120, Duration::from_secs(2)));
    assert!(wait_for_frame(&mut c100, Duration::from_secs(2)));
    assert!(wait_for_frame(&mut c80, Duration::from_secs(2)));

    let size_with_three = read_pane_tty_size(&api_socket, &pane_id, Duration::from_secs(5));

    drain_server_messages(&mut c100, Duration::from_millis(250));

    // Smallest client disconnects; effective size should increase to the next-smallest.
    send_client_detach(&mut c80);
    drop(c80);

    assert!(
        wait_for_frame(&mut c100, Duration::from_secs(2)),
        "next-smallest client should receive resized-up frame"
    );

    let deadline = Instant::now() + Duration::from_secs(8);
    let mut size_after_smallest_disconnect = None;
    while Instant::now() < deadline {
        let maybe_size = try_read_pane_tty_size(&api_socket, &pane_id, Duration::from_millis(400));
        if let Some(size) = maybe_size {
            if size.0 > size_with_three.0 && size.1 > size_with_three.1 {
                size_after_smallest_disconnect = Some(size);
                break;
            }
        }
        thread::sleep(Duration::from_millis(60));
    }

    assert!(
        size_after_smallest_disconnect.is_some(),
        "effective pane size should increase after smallest disconnects: before={:?}, last_seen={:?}",
        size_with_three,
        try_read_pane_tty_size(&api_socket, &pane_id, Duration::from_millis(300))
    );

    cleanup_spawned_herdr(server, base);
}

#[test]
fn multi_client_smallest_leaving_resizes_up_for_remaining_clients() {
    let _lock = test_lock();
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");
    let client_socket = runtime_dir.join("herdr-client.sock");

    let server = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(10));
    wait_for_file(&client_socket, Duration::from_secs(10));

    let (_workspace_id, pane_id) = create_workspace_and_root_pane(&api_socket, "size-resize-up");

    let mut large = connect_raw_client(&client_socket, 120, 40);
    let mut small = connect_raw_client(&client_socket, 80, 24);

    assert!(wait_for_frame(&mut large, Duration::from_secs(2)));
    assert!(wait_for_frame(&mut small, Duration::from_secs(2)));

    let size_with_small_client = read_pane_tty_size(&api_socket, &pane_id, Duration::from_secs(5));

    drain_server_messages(&mut large, Duration::from_millis(250));

    send_client_detach(&mut small);
    drop(small);

    // Remaining client should receive a new (larger) frame.
    assert!(
        wait_for_frame(&mut large, Duration::from_secs(2)),
        "remaining client should receive resized-up frame"
    );

    let size_after_small_leaves = read_pane_tty_size(&api_socket, &pane_id, Duration::from_secs(5));

    assert!(
        size_after_small_leaves.0 > size_with_small_client.0
            && size_after_small_leaves.1 > size_with_small_client.1,
        "remaining clients should get larger effective pane size after smallest leaves: before={:?}, after={:?}",
        size_with_small_client,
        size_after_small_leaves
    );

    cleanup_spawned_herdr(server, base);
}

#[test]
fn multi_client_client_crash_sigkill_does_not_affect_server() {
    let _lock = test_lock();
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");
    let client_socket = runtime_dir.join("herdr-client.sock");

    let server = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(10));
    wait_for_file(&client_socket, Duration::from_secs(10));

    let mut survivor = connect_raw_client(&client_socket, 100, 30);
    assert!(wait_for_frame(&mut survivor, Duration::from_secs(2)));

    let log_path = server_log_path(&config_home);
    let connected_before = count_log_occurrences(&log_path, "client connected");

    let crashing_client = spawn_client_process(&config_home, &runtime_dir, &api_socket);

    let attached_before_kill = wait_for_log_occurrence_count(
        &log_path,
        "client connected",
        connected_before + 1,
        Duration::from_secs(8),
    );
    assert!(
        attached_before_kill,
        "thin client must complete handshake/attachment before SIGKILL"
    );

    if let Some(pid) = crashing_client.child.process_id() {
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
    let mut crashing_client = crashing_client;
    wait_for_child_exit(&mut crashing_client.child);

    let ping = ping_socket(&api_socket);
    assert!(
        ping.contains("pong"),
        "server should stay healthy after SIGKILLed client: {ping}"
    );

    drain_server_messages(&mut survivor, Duration::from_millis(250));
    send_client_input(&mut survivor, b"echo survivor-still-works\n");
    assert!(
        wait_for_frame(&mut survivor, Duration::from_secs(2)),
        "remaining client should continue receiving frames"
    );

    cleanup_spawned_herdr(server, base);
}

#[test]
fn mixed_local_remote_client_connects_main_and_secondary_streams() {
    let _lock = test_lock();
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");
    let dev_socket_dir = session_socket_dir(&config_home, "dev");
    let dev_api_socket = dev_socket_dir.join("herdr.sock");
    let dev_client_socket = dev_socket_dir.join("herdr-client.sock");

    let main_server = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(10));

    let dev_server = spawn_named_server(&config_home, &runtime_dir, "dev");
    wait_for_socket(&dev_api_socket, Duration::from_secs(10));
    wait_for_file(&dev_client_socket, Duration::from_secs(10));

    let add_remote = send_json_request(
        &api_socket,
        r#"{"id":"remote_add","method":"remote.add","params":{"name":"dev","target":"local:dev"}}"#,
    );
    if add_remote.get("error").is_some() {
        panic!("remote.add failed: {add_remote}");
    }

    let main_log_path = server_log_path(&config_home);
    let dev_log_path = dev_socket_dir.join("herdr-server.log");
    let main_connected_before = count_log_occurrences(&main_log_path, "client connected");
    let dev_connected_before = count_log_occurrences(&dev_log_path, "client connected");

    let client = spawn_client_process(&config_home, &runtime_dir, &api_socket);
    // Drain the client's PTY the way a real terminal does (matching the sibling mixed_* tests). An
    // undrained PTY fills, the client's blocking stdout frame writes never return, and its
    // single-threaded event loop freezes — so the Timer-driven secondary-stream connection asserted
    // below never runs. Bind the receiver so the collector thread stays alive for the whole test.
    let _client_output = spawn_pty_output_collector(client._master.as_ref());
    assert!(
        wait_for_log_occurrence_count(
            &main_log_path,
            "client connected",
            main_connected_before + 1,
            Duration::from_secs(10),
        ),
        "thin client should connect to the main client stream"
    );
    assert!(
        wait_for_log_occurrence_count(
            &dev_log_path,
            "client connected",
            dev_connected_before + 1,
            Duration::from_secs(10),
        ),
        "thin client should connect to the local:dev client stream"
    );

    drop(client);
    drop(dev_server);
    cleanup_spawned_herdr(main_server, base);
}

#[test]
fn mixed_local_remote_client_picker_creates_on_selected_secondary_and_main_survives_secondary_stop()
{
    let _lock = test_lock();
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");
    let client_socket = runtime_dir.join("herdr-client.sock");
    let dev_socket_dir = session_socket_dir(&config_home, "dev");
    let dev_api_socket = dev_socket_dir.join("herdr.sock");
    let dev_client_socket = dev_socket_dir.join("herdr-client.sock");

    let main_server = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(10));
    wait_for_file(&client_socket, Duration::from_secs(10));
    create_workspace_and_root_pane(&api_socket, "main-visible");

    let dev_server = spawn_named_server(&config_home, &runtime_dir, "dev");
    wait_for_socket(&dev_api_socket, Duration::from_secs(10));
    wait_for_file(&dev_client_socket, Duration::from_secs(10));
    create_workspace_and_root_pane(&dev_api_socket, "dev-visible");

    let add_remote = send_json_request(
        &api_socket,
        r#"{"id":"remote_add","method":"remote.add","params":{"name":"dev","target":"local:dev"}}"#,
    );
    if add_remote.get("error").is_some() {
        panic!("remote.add failed: {add_remote}");
    }

    let main_count_before = workspace_count(&api_socket);
    let dev_count_before = workspace_count(&dev_api_socket);

    let main_log_path = server_log_path(&config_home);
    let dev_log_path = dev_socket_dir.join("herdr-server.log");
    let main_connected_before = count_log_occurrences(&main_log_path, "client connected");
    let dev_connected_before = count_log_occurrences(&dev_log_path, "client connected");

    let client = spawn_client_process(&config_home, &runtime_dir, &api_socket);
    let client_output = spawn_pty_output_collector(client._master.as_ref());
    assert!(
        wait_for_log_occurrence_count(
            &main_log_path,
            "client connected",
            main_connected_before + 1,
            Duration::from_secs(10),
        ),
        "thin client should connect to the main client stream"
    );
    assert!(
        wait_for_log_occurrence_count(
            &dev_log_path,
            "client connected",
            dev_connected_before + 1,
            Duration::from_secs(10),
        ),
        "thin client should connect to the local:dev client stream"
    );
    assert!(
        wait_for_output_containing(
            &client_output,
            &["main-visible", "dev-visible"],
            Duration::from_secs(10),
        ),
        "mixed client sidebar should show workspace labels from main and local:dev"
    );

    // 80x24 host: the server sidebar places the footer/`new` affordance at the
    // bottom of the workspace section, y=11 (SGR row 12). Clicking it opens the
    // destination picker, now a FOOTER-ANCHORED ratatui popup that floats over the
    // live content (item 1 / Area 3) — it opens UPWARD from the footer instead of
    // dead-centered. `anchor_area` spans the host top down to the footer row
    // (80x11), so for two destinations the popup is 44x7 at (0,4), inner rect
    // (1,5,42,5), with the "new workspace" header on inner row 0, the " create on"
    // sub-label on inner row 1, and the destination rows starting two lines below —
    // so the second destination ("dev", row index 1) renders at y=8 (SGR row 9),
    // spanning the inner width [1,43).
    let mut client_writer = client._master.take_writer().expect("open PTY writer");
    write_sgr_mouse_click(client_writer.as_mut(), 2, 12);
    // The blit diff (and `strip_ansi_for_test`, which drops cursor-positioning escapes)
    // only preserves contiguously-emitted glyph runs, so assert on the picker's
    // `create` button/sub-label run and the `›`-marked selected destination row.
    assert!(
        wait_for_output_containing(
            &client_output,
            &["create", "› local"],
            Duration::from_secs(5)
        ),
        "clicking new in all-server mode should open the destination picker"
    );
    write_sgr_mouse_click(client_writer.as_mut(), 21, 9);

    assert!(
        wait_for_workspace_count(
            &dev_api_socket,
            dev_count_before + 1,
            Duration::from_secs(10)
        ),
        "choosing dev in the destination picker should create a workspace on local:dev"
    );
    assert_eq!(
        workspace_count(&api_socket),
        main_count_before,
        "choosing dev must not create the new workspace on main"
    );

    drop(dev_server);

    let main_after_dev_stop = send_json_request(
        &api_socket,
        r#"{"id":"main_after_dev_stop","method":"workspace.create","params":{"label":"main-after-dev-stop"}}"#,
    );
    assert!(
        main_after_dev_stop.get("error").is_none(),
        "main API should stay usable after stopping secondary: {main_after_dev_stop}"
    );
    assert!(
        ping_socket(&api_socket).contains("pong"),
        "main server should keep responding after stopping secondary"
    );

    drop(client);
    cleanup_spawned_herdr(main_server, base);
}

#[test]
fn mixed_client_clicking_remote_workspace_focuses_and_displays_remote_content() {
    let _lock = test_lock();
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");
    let client_socket = runtime_dir.join("herdr-client.sock");
    let dev_socket_dir = session_socket_dir(&config_home, "dev");
    let dev_api_socket = dev_socket_dir.join("herdr.sock");
    let dev_client_socket = dev_socket_dir.join("herdr-client.sock");

    let main_server = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(10));
    wait_for_file(&client_socket, Duration::from_secs(10));
    let (_main_workspace_id, main_pane_id) =
        create_workspace_and_root_pane(&api_socket, "main-visible");

    let dev_server = spawn_named_server(&config_home, &runtime_dir, "dev");
    wait_for_socket(&dev_api_socket, Duration::from_secs(10));
    wait_for_file(&dev_client_socket, Duration::from_secs(10));
    let (_dev_workspace_id, dev_pane_id) =
        create_workspace_and_root_pane(&dev_api_socket, "dev-visible");

    let main_marker = format!("MAIN_CLICK_CONTENT_{}", std::process::id());
    let dev_marker = format!("REMOTE_CLICK_CONTENT_{}", std::process::id());
    pane_send_input(
        &api_socket,
        &main_pane_id,
        &format!("printf '{main_marker}\\n'"),
    );
    pane_send_input(
        &dev_api_socket,
        &dev_pane_id,
        &format!("printf '{dev_marker}\\n'"),
    );
    assert!(
        pane_read_recent_contains(
            &api_socket,
            &main_pane_id,
            &main_marker,
            Duration::from_secs(5)
        ),
        "main pane should contain marker before launching mixed client"
    );
    assert!(
        pane_read_recent_contains(
            &dev_api_socket,
            &dev_pane_id,
            &dev_marker,
            Duration::from_secs(5)
        ),
        "remote pane should contain marker before launching mixed client"
    );

    let add_remote = send_json_request(
        &api_socket,
        r#"{"id":"remote_add","method":"remote.add","params":{"name":"dev","target":"local:dev"}}"#,
    );
    if add_remote.get("error").is_some() {
        panic!("remote.add failed: {add_remote}");
    }

    let main_log_path = server_log_path(&config_home);
    let dev_log_path = dev_socket_dir.join("herdr-server.log");
    let main_connected_before = count_log_occurrences(&main_log_path, "client connected");
    let dev_connected_before = count_log_occurrences(&dev_log_path, "client connected");
    let dev_focus_before = count_log_occurrences(&dev_log_path, "client:workspace-focus");

    let client = spawn_client_process(&config_home, &runtime_dir, &api_socket);
    let client_output = spawn_pty_output_collector(client._master.as_ref());
    let mut client_writer = client._master.take_writer().expect("open PTY writer");

    assert!(
        wait_for_log_occurrence_count(
            &main_log_path,
            "client connected",
            main_connected_before + 1,
            Duration::from_secs(10),
        ),
        "thin client should connect to the main client stream"
    );
    assert!(
        wait_for_log_occurrence_count(
            &dev_log_path,
            "client connected",
            dev_connected_before + 1,
            Duration::from_secs(10),
        ),
        "thin client should connect to the local:dev client stream"
    );
    assert!(
        wait_for_output_containing(
            &client_output,
            &["main-visible", "dev-visible", &main_marker],
            Duration::from_secs(10),
        ),
        "mixed client should render main content and both workspace labels before clicking"
    );

    let mut displayed_remote = false;
    for sgr_row in 2..=11 {
        write_sgr_mouse_click(client_writer.as_mut(), 2, sgr_row);
        if wait_for_output_containing(&client_output, &[&dev_marker], Duration::from_millis(400)) {
            displayed_remote = true;
            break;
        }
    }

    assert!(
        displayed_remote,
        "clicking a visible remote workspace row should switch the mixed client content to the remote frame"
    );
    assert!(
        wait_for_log_occurrence_count(
            &dev_log_path,
            "client:workspace-focus",
            dev_focus_before + 1,
            Duration::from_secs(5),
        ),
        "clicking the remote workspace row should route workspace.focus to the remote API"
    );

    drop(client);
    drop(dev_server);
    cleanup_spawned_herdr(main_server, base);
}

#[test]
fn mixed_client_menu_uses_server_launcher_surface() {
    let _lock = test_lock();
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");
    let client_socket = runtime_dir.join("herdr-client.sock");

    let main_server = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(10));
    wait_for_file(&client_socket, Duration::from_secs(10));

    let main_log_path = server_log_path(&config_home);
    let main_connected_before = count_log_occurrences(&main_log_path, "client connected");

    let client = spawn_client_process(&config_home, &runtime_dir, &api_socket);
    let client_output = spawn_pty_output_collector(client._master.as_ref());
    let mut client_writer = client._master.take_writer().expect("open PTY writer");

    assert!(
        wait_for_log_occurrence_count(
            &main_log_path,
            "client connected",
            main_connected_before + 1,
            Duration::from_secs(10),
        ),
        "thin client should connect to the main client stream"
    );
    assert!(
        wait_for_output_containing(&client_output, &["new", "menu"], Duration::from_secs(10)),
        "client-owned footer should render before any secondary remote exists"
    );

    // Footer menu is right-aligned inside the original 26-column sidebar's
    // workspace section.
    write_sgr_mouse_click(client_writer.as_mut(), 24, 12);
    assert!(
        wait_for_output_containing(
            &client_output,
            &[
                "settings",
                "keybinds",
                "reload config",
                "detach",
                "add remote"
            ],
            Duration::from_secs(5)
        ),
        "clicking menu should open the original server launcher menu"
    );

    let list = send_json_request(
        &api_socket,
        r#"{"id":"remote_list","method":"remote.list","params":{}}"#,
    );
    assert_eq!(list["result"]["remotes"].as_array().unwrap().len(), 0);

    drop(client);
    cleanup_spawned_herdr(main_server, base);
}

#[test]
fn multi_client_rapid_connect_disconnect_stress_10_cycles() {
    let _lock = test_lock();
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");
    let client_socket = runtime_dir.join("herdr-client.sock");

    let server = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(10));
    wait_for_file(&client_socket, Duration::from_secs(10));

    for i in 0..10u16 {
        let mut client = connect_raw_client(&client_socket, 80 + i, 24 + (i % 4));
        let _ = wait_for_frame(&mut client, Duration::from_millis(500));
        send_client_detach(&mut client);
        drop(client);
        thread::sleep(Duration::from_millis(40));
    }

    let ping = ping_socket(&api_socket);
    assert!(
        ping.contains("pong"),
        "server should remain healthy after rapid connect/disconnect: {ping}"
    );

    let mut final_client = connect_raw_client(&client_socket, 100, 30);
    assert!(
        wait_for_frame(&mut final_client, Duration::from_secs(2)),
        "new client should still connect and receive frames after stress"
    );

    cleanup_spawned_herdr(server, base);
}

/// End-to-end (issue #11, #2): a full ssh add-remote spec flows through the real `remote.add`
/// API, captures its options, names + dedups off the destination, and round-trips via
/// `remote.list`. `remote.add` is registry-only (no ssh connection), so this is deterministic.
#[test]
fn remote_add_accepts_full_ssh_spec_and_dedups_by_destination_plus_options() {
    let _lock = test_lock();
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let api_socket = runtime_dir.join("herdr.sock");

    let main_server = spawn_server(&config_home, &runtime_dir, &api_socket);
    wait_for_socket(&api_socket, Duration::from_secs(10));

    // Full ssh spec: leading `ssh` stripped, flags captured, destination = last positional.
    let add = send_json_request(
        &api_socket,
        r#"{"id":"a","method":"remote.add","params":{"target":"ssh -L 9000:localhost:9000 -J jump iq-64"}}"#,
    );
    assert!(
        add.get("error").is_none(),
        "remote.add full spec failed: {add}"
    );
    let remote = &add["result"]["remote"];
    assert_eq!(
        remote["name"], "iq-64",
        "name should default to the destination"
    );
    assert_eq!(remote["target"]["type"], "ssh");
    assert_eq!(remote["target"]["target"], "iq-64");
    assert_eq!(
        remote["target"]["args"],
        serde_json::json!(["-L", "9000:localhost:9000", "-J", "jump"]),
        "ssh options must persist"
    );

    // remote.list reflects the persisted spec.
    let list = send_json_request(
        &api_socket,
        r#"{"id":"l","method":"remote.list","params":{}}"#,
    );
    let remotes = list["result"]["remotes"].as_array().unwrap();
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0]["target"]["target"], "iq-64");
    assert_eq!(
        remotes[0]["target"]["args"],
        serde_json::json!(["-L", "9000:localhost:9000", "-J", "jump"])
    );

    // The identical spec is a duplicate target (dedup keys off destination + options).
    let dup = send_json_request(
        &api_socket,
        r#"{"id":"d","method":"remote.add","params":{"target":"ssh -L 9000:localhost:9000 -J jump iq-64"}}"#,
    );
    assert!(
        dup.get("error").is_some(),
        "identical full spec should be rejected: {dup}"
    );

    // A bare host to the same destination is a distinct connection (no options): accepted, and it
    // persists with no `args` key (bare targets stay byte-identical to the legacy on-disk form).
    let bare = send_json_request(
        &api_socket,
        r#"{"id":"b","method":"remote.add","params":{"name":"plain","target":"iq-64"}}"#,
    );
    assert!(bare.get("error").is_none(), "bare host add failed: {bare}");
    assert_eq!(bare["result"]["remote"]["target"]["target"], "iq-64");
    assert_eq!(
        bare["result"]["remote"]["target"]["args"],
        Value::Null,
        "bare target must not serialize an args key"
    );

    cleanup_spawned_herdr(main_server, base);
}
