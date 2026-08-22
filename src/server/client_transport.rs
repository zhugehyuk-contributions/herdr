//! Blocking client socket transport for the headless server.
//!
//! This module owns the thin-client handshake, read loop, and writer loop.
//! It converts socket I/O into [`ServerEvent`] values consumed by
//! `HeadlessServer`.

use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SendError, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use interprocess::local_socket::traits::Stream as _;
use interprocess::TryClone as _;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::ipc::LocalStream;
use crate::protocol::{
    self, AttachScrollDirection, AttachScrollSource, ClientInputEvent, ClientKeybindings,
    ClientLaunchMode, ClientMessage, ClientSurfaceMode, RenderEncoding, ServerMessage,
    MAX_CLIPBOARD_IMAGE_PAYLOAD, MAX_FRAME_SIZE, MAX_GRAPHICS_FRAME_SIZE, PROTOCOL_VERSION,
};

/// Minimum accepted attached client size.
///
/// Narrow observers must be allowed to drive narrow renders, otherwise the
/// server wraps pane content against a wider width and the client sees the
/// right edge clipped.
const MIN_CLIENT_COLS: u16 = 1;
const MIN_CLIENT_ROWS: u16 = 1;

/// How long to wait for a client handshake before closing the connection.
/// Set to 4 seconds (rather than 5) to guarantee the connection is closed
/// within the 5-second deadline, even with OS timer slack, thread scheduling,
/// and cleanup overhead.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(4);

/// Maximum input payload size (bytes) for a single `ClientMessage::Input`.
const MAX_INPUT_PAYLOAD: usize = 1024 * 1024; // 1 MB
/// Maximum structured input events accepted in one client message.
const MAX_INPUT_EVENT_BATCH: usize = 4096;

/// Channels owned by the server side of a client writer thread.
#[derive(Clone, Debug)]
pub(crate) struct ClientWriter {
    /// Reliable control messages such as shutdown, notifications, and clipboard writes.
    pub(crate) control: ClientControlWriter,
    /// Droppable render messages. Capacity is one so slow clients cannot build lag.
    pub(crate) render: ClientRenderWriter,
}

#[cfg(test)]
impl ClientWriter {
    pub(crate) fn test_channel(
        control: std::sync::mpsc::Sender<Vec<u8>>,
        render: std::sync::mpsc::SyncSender<Vec<u8>>,
    ) -> Self {
        Self {
            control: ClientControlWriter {
                target: ClientControlTarget::Channel(control),
            },
            render: ClientRenderWriter {
                target: ClientRenderTarget::Channel(render),
            },
        }
    }
}

#[derive(Debug)]
pub(crate) struct ClientControlWriter {
    target: ClientControlTarget,
}

#[derive(Debug)]
enum ClientControlTarget {
    Queue(Arc<ClientWriterQueue>),
    #[cfg(test)]
    Channel(std::sync::mpsc::Sender<Vec<u8>>),
}

#[derive(Debug)]
pub(crate) struct ClientRenderWriter {
    target: ClientRenderTarget,
}

#[derive(Debug)]
enum ClientRenderTarget {
    Queue(Arc<ClientWriterQueue>),
    #[cfg(test)]
    Channel(std::sync::mpsc::SyncSender<Vec<u8>>),
}

impl Clone for ClientControlWriter {
    fn clone(&self) -> Self {
        match &self.target {
            ClientControlTarget::Queue(queue) => {
                queue.add_sender();
                Self {
                    target: ClientControlTarget::Queue(queue.clone()),
                }
            }
            #[cfg(test)]
            ClientControlTarget::Channel(sender) => Self {
                target: ClientControlTarget::Channel(sender.clone()),
            },
        }
    }
}

impl Drop for ClientControlWriter {
    fn drop(&mut self) {
        match &self.target {
            ClientControlTarget::Queue(queue) => queue.remove_sender(),
            #[cfg(test)]
            ClientControlTarget::Channel(_) => {}
        }
    }
}

impl ClientControlWriter {
    fn queue(queue: Arc<ClientWriterQueue>) -> Self {
        queue.add_sender();
        Self {
            target: ClientControlTarget::Queue(queue),
        }
    }

    pub(crate) fn send(&self, data: Vec<u8>) -> Result<(), SendError<Vec<u8>>> {
        match &self.target {
            ClientControlTarget::Queue(queue) => queue.send_control(data),
            #[cfg(test)]
            ClientControlTarget::Channel(sender) => sender.send(data),
        }
    }
}

impl Clone for ClientRenderWriter {
    fn clone(&self) -> Self {
        match &self.target {
            ClientRenderTarget::Queue(queue) => {
                queue.add_sender();
                Self {
                    target: ClientRenderTarget::Queue(queue.clone()),
                }
            }
            #[cfg(test)]
            ClientRenderTarget::Channel(sender) => Self {
                target: ClientRenderTarget::Channel(sender.clone()),
            },
        }
    }
}

impl Drop for ClientRenderWriter {
    fn drop(&mut self) {
        match &self.target {
            ClientRenderTarget::Queue(queue) => queue.remove_sender(),
            #[cfg(test)]
            ClientRenderTarget::Channel(_) => {}
        }
    }
}

impl ClientRenderWriter {
    fn queue(queue: Arc<ClientWriterQueue>) -> Self {
        queue.add_sender();
        Self {
            target: ClientRenderTarget::Queue(queue),
        }
    }

    pub(crate) fn try_send(&self, data: Vec<u8>) -> Result<(), TrySendError<Vec<u8>>> {
        match &self.target {
            ClientRenderTarget::Queue(queue) => queue.try_send_render(data),
            #[cfg(test)]
            ClientRenderTarget::Channel(sender) => sender.try_send(data),
        }
    }
}

#[derive(Debug)]
struct ClientWriterQueue {
    state: Mutex<ClientWriterQueueState>,
    ready: Condvar,
}

#[derive(Debug, Default)]
struct ClientWriterQueueState {
    control: VecDeque<Vec<u8>>,
    render: Option<Vec<u8>>,
    senders: usize,
    writer_alive: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum ClientWriteItem {
    Control(Vec<u8>),
    Render(Vec<u8>),
}

impl ClientWriterQueue {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(ClientWriterQueueState {
                writer_alive: true,
                ..ClientWriterQueueState::default()
            }),
            ready: Condvar::new(),
        })
    }

    fn add_sender(&self) {
        let mut state = self.lock_state();
        state.senders = state.senders.saturating_add(1);
    }

    fn remove_sender(&self) {
        let mut state = self.lock_state();
        state.senders = state.senders.saturating_sub(1);
        self.ready.notify_one();
    }

    fn send_control(&self, data: Vec<u8>) -> Result<(), SendError<Vec<u8>>> {
        let mut state = self.lock_state();
        if !state.writer_alive {
            return Err(SendError(data));
        }
        state.control.push_back(data);
        self.ready.notify_one();
        Ok(())
    }

    fn try_send_render(&self, data: Vec<u8>) -> Result<(), TrySendError<Vec<u8>>> {
        let mut state = self.lock_state();
        if !state.writer_alive {
            return Err(TrySendError::Disconnected(data));
        }
        if state.render.is_some() {
            return Err(TrySendError::Full(data));
        }
        state.render = Some(data);
        self.ready.notify_one();
        Ok(())
    }

    fn recv(&self) -> Option<ClientWriteItem> {
        let mut state = self.lock_state();
        loop {
            if let Some(data) = state.control.pop_front() {
                return Some(ClientWriteItem::Control(data));
            }
            if let Some(data) = state.render.take() {
                self.ready.notify_one();
                return Some(ClientWriteItem::Render(data));
            }
            if state.senders == 0 {
                return None;
            }
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    fn close_writer(&self) {
        let mut state = self.lock_state();
        state.writer_alive = false;
        self.ready.notify_all();
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, ClientWriterQueueState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Internal event sent from client transport threads to the main event loop.
#[derive(Debug)]
pub(crate) enum ServerEvent {
    /// A new client completed the handshake.
    ClientConnected {
        client_id: u64,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
        surface_mode: ClientSurfaceMode,
        render_encoding: RenderEncoding,
        keybindings: Option<Box<crate::config::LiveKeybindConfig>>,
        direct_attach_requested: bool,
        writer: ClientWriter,
    },
    /// A client sent an input message.
    ClientInput { client_id: u64, data: Vec<u8> },
    /// A client sent structured input events.
    ClientInputEvents {
        client_id: u64,
        events: Vec<crate::protocol::ClientInputEvent>,
    },
    /// A fully decoded interactive paste exceeded the text-input limit.
    ClientPasteRejected {
        client_id: u64,
        size: usize,
        max: usize,
    },
    /// A client sent local clipboard image bytes to paste into a remote pane.
    ClientClipboardImage {
        client_id: u64,
        extension: String,
        data: Vec<u8>,
    },
    /// A client requested direct attach to one terminal.
    ClientAttachTerminal {
        client_id: u64,
        terminal_id: String,
        takeover: bool,
    },
    /// A client requested read-only observation of one terminal.
    ClientObserveTerminal { client_id: u64, target: String },
    /// A client requested writable control of one terminal.
    ClientControlTerminal {
        client_id: u64,
        target: String,
        takeover: bool,
    },
    /// A direct terminal attach client requested scrollback movement.
    ClientAttachScroll {
        client_id: u64,
        source: AttachScrollSource,
        direction: AttachScrollDirection,
        lines: u16,
        column: Option<u16>,
        row: Option<u16>,
        modifiers: u8,
    },
    /// A client sent a resize message.
    ClientResize {
        client_id: u64,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
    },
    /// A client detached gracefully.
    ClientDetach { client_id: u64 },
    /// A client requested the server-rendered settings UI.
    ClientOpenSettings { client_id: u64 },
    /// A client requested the server-rendered keybind help UI.
    ClientOpenKeybindHelp { client_id: u64 },
    /// A latency probe from a client; the server echoes `nonce` back in a `Pong` (issue #13).
    ClientPing { client_id: u64, nonce: u64 },
    /// A client whose frame baseline desynced asks for a full re-baseline frame (v14).
    ClientRequestFullFrame { client_id: u64 },
    /// A client connection was lost.
    ClientDisconnected { client_id: u64 },
    /// A client writer drained its render slot and can accept another render.
    ClientWriterDrained { client_id: u64 },
    /// Ctrl+C or external shutdown signal received.
    QuitSignal,
}

/// Clamp client-reported terminal dimensions to a minimum viable size.
pub(crate) fn clamp_terminal_size(cols: u16, rows: u16) -> (u16, u16) {
    let clamped_cols = cols.max(MIN_CLIENT_COLS);
    let clamped_rows = rows.max(MIN_CLIENT_ROWS);
    (clamped_cols, clamped_rows)
}

fn parse_client_keybindings(
    keybindings: ClientKeybindings,
) -> Result<Option<Box<crate::config::LiveKeybindConfig>>, String> {
    match keybindings {
        ClientKeybindings::Server => Ok(None),
        ClientKeybindings::Local { keys_toml } => {
            let mut config = toml::from_str::<crate::config::Config>(&keys_toml)
                .map_err(|err| format!("invalid client keybindings: {err}"))?;
            config.keys.command.clear();
            Ok(Some(Box::new(crate::config::LiveKeybindConfig {
                prefix: config.prefix_key(),
                keybinds: config.keybinds(),
            })))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputEventLimit {
    WithinLimits,
    TooManyEvents,
    PasteTooLarge { size: usize },
    InputPayloadTooLarge { size: usize },
}

fn input_event_limit(events: &[ClientInputEvent]) -> InputEventLimit {
    let mut expanded_events = 0usize;
    let mut paste_bytes = 0usize;
    let mut input_bytes = 0usize;
    for event in events {
        expanded_events = expanded_events.saturating_add(match event {
            ClientInputEvent::Key { repeat_count, .. } => usize::from((*repeat_count).max(1)),
            _ => 1,
        });
        match event {
            ClientInputEvent::Key {
                repeat_count,
                generated_text,
                source,
                ..
            } => {
                if let Some(text) = generated_text {
                    input_bytes = input_bytes.saturating_add(
                        text.len()
                            .saturating_mul(usize::from((*repeat_count).max(1))),
                    );
                }
                if let crate::protocol::ClientKeySource::Vt { bytes } = source {
                    input_bytes = input_bytes.saturating_add(bytes.len());
                }
            }
            ClientInputEvent::TextCommit(text) => {
                input_bytes = input_bytes.saturating_add(text.len());
            }
            ClientInputEvent::Paste { text } => {
                paste_bytes = paste_bytes.saturating_add(text.len());
            }
            ClientInputEvent::Mouse { .. }
            | ClientInputEvent::FocusGained
            | ClientInputEvent::FocusLost => {}
        }
    }

    if expanded_events > MAX_INPUT_EVENT_BATCH {
        return InputEventLimit::TooManyEvents;
    }

    let payload_bytes = paste_bytes.saturating_add(input_bytes);
    if payload_bytes <= MAX_INPUT_PAYLOAD {
        InputEventLimit::WithinLimits
    } else if input_bytes == 0 {
        InputEventLimit::PasteTooLarge {
            size: payload_bytes,
        }
    } else {
        InputEventLimit::InputPayloadTooLarge {
            size: payload_bytes,
        }
    }
}

#[cfg(windows)]
fn set_client_recv_timeout(
    stream: &LocalStream,
    timeout: Option<Duration>,
    context: &'static str,
    client_id: u64,
) -> io::Result<()> {
    match stream.set_recv_timeout(timeout) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::Unsupported => {
            debug!(client_id, err = %err, context, "client socket receive timeout unavailable");
            Ok(())
        }
        Err(err) => Err(err),
    }
}

#[cfg(not(windows))]
fn set_client_recv_timeout(
    stream: &LocalStream,
    timeout: Option<Duration>,
    _context: &'static str,
    _client_id: u64,
) -> io::Result<()> {
    stream.set_recv_timeout(timeout)
}

/// Handles the client handshake on a blocking thread.
///
/// Reads the wire-ABI prelude, then the `Hello` message, validates the version, sends `Welcome`,
/// and then enters a read loop forwarding messages to the server event channel.
pub(crate) fn handle_client_handshake(
    mut stream: LocalStream,
    client_id: u64,
    server_event_tx: &mpsc::Sender<ServerEvent>,
    should_quit: &Arc<AtomicBool>,
) -> io::Result<()> {
    // Reset to blocking mode — the accept loop sets nonblocking but
    // the handshake thread needs blocking I/O for read_message/write_message.
    stream.set_nonblocking(false)?;

    set_client_recv_timeout(
        &stream,
        Some(HANDSHAKE_TIMEOUT),
        "client handshake read timeout unavailable",
        client_id,
    )?;

    // ---- Wire-ABI gate (M0-a) -------------------------------------------------------------
    //
    // This runs BEFORE the bincode decode below, and that ordering is the whole design. The first
    // value the two forks disagree on is `ClientLaunchMode`, which is a *field of `Hello`*, so a
    // fingerprint carried in the server's `Welcome` would only be compared after this server had
    // already mis-parsed the client's `Hello`. Nothing of an unidentified peer's payload is ever
    // interpreted.
    match protocol::abi::read_peer_handshake_start(&mut stream) {
        Ok(protocol::abi::PeerHandshakeStart::Prelude(peer)) => {
            // Answer with our own identity first, whatever the verdict: a peer that speaks
            // preludes is owed one, including on rejection, so it can name the disagreement too.
            if let Err(err) = protocol::abi::write_prelude(&mut stream) {
                debug!(client_id, err = %err, "failed to write server wire-ABI prelude");
                return Ok(());
            }
            if let protocol::abi::AbiCheck::Rejected(reason) = protocol::abi::check_peer_abi(&peer)
            {
                warn!(client_id, peer = %peer.describe(), "rejecting client on wire-ABI mismatch");
                let welcome = ServerMessage::Welcome {
                    version: PROTOCOL_VERSION,
                    encoding: RenderEncoding::SemanticFrame,
                    error: Some(reason),
                };
                let _ = protocol::write_message(&mut stream, &welcome);
                return Ok(());
            }
        }
        Ok(protocol::abi::PeerHandshakeStart::Legacy(_head)) => {
            // A peer that sent no prelude cannot be identified: an unannotated `Hello` claiming
            // protocol 20 is equally consistent with herdr-mx and with upstream, and those two
            // disagree on `ClientLaunchMode`. Accepting it would trade a loud rejection for a
            // silent mis-parse, so the bytes it sent are never decoded. The reply is a *legacy*
            // `Welcome` (no prelude) because that is the framing the old client can read — the
            // rejection has to be diagnosable, not just correct.
            debug!(client_id, "client sent no wire-ABI prelude; rejecting");
            let welcome = ServerMessage::Welcome {
                version: PROTOCOL_VERSION,
                encoding: RenderEncoding::SemanticFrame,
                error: Some(protocol::abi::legacy_peer_rejection()),
            };
            let _ = protocol::write_message(&mut stream, &welcome);
            return Ok(());
        }
        Err(protocol::FramingError::UnexpectedEof) => {
            debug!(client_id, "client disconnected before the wire-ABI prelude");
            return Ok(());
        }
        Err(err) => {
            debug!(client_id, err = %err, "failed to read client wire-ABI prelude");
            return Ok(());
        }
    }

    // Read the Hello message.
    let hello: ClientMessage = match protocol::read_message(&mut stream, MAX_FRAME_SIZE) {
        Ok(msg) => msg,
        Err(protocol::FramingError::UnexpectedEof) => {
            debug!(client_id, "client disconnected before handshake");
            return Ok(());
        }
        Err(protocol::FramingError::Oversized { claimed, max }) => {
            warn!(client_id, claimed, max, "oversized handshake from client");
            return Ok(());
        }
        Err(protocol::FramingError::Bincode(err)) => {
            // SW3: bytes arrived but couldn't be DECODED — almost always protocol-version skew (e.g.
            // an older client whose Hello layout predates a field added here). Bincode is positional,
            // so the version field can't be read in isolation; instead reply with a version-mismatch
            // Welcome (the Welcome shape is the stable handshake contract: variant 0, version +
            // encoding + error) so the old client exits with a clear reason rather than an abrupt,
            // undiagnosable close. A timeout / I/O error (no Hello sent) falls through to a silent
            // close below — it's not a version problem.
            debug!(client_id, err = %err, "failed to decode client hello; replying with version-mismatch Welcome");
            let welcome = ServerMessage::Welcome {
                version: PROTOCOL_VERSION,
                encoding: RenderEncoding::SemanticFrame,
                error: Some(format!(
                    "incompatible client protocol (server speaks v{PROTOCOL_VERSION}); update herdr"
                )),
            };
            let _ = protocol::write_message(&mut stream, &welcome);
            return Ok(());
        }
        Err(err) => {
            debug!(client_id, err = %err, "failed to read client hello");
            return Ok(());
        }
    };

    let (
        client_cols,
        client_rows,
        cell_width_px,
        cell_height_px,
        render_encoding,
        surface_mode,
        keybindings,
        direct_attach_requested,
    ) = match hello {
        ClientMessage::Hello {
            version,
            cols,
            rows,
            cell_width_px,
            cell_height_px,
            requested_encoding,
            surface_mode,
            keybindings,
            launch_mode,
        } => {
            // Version check.
            match protocol::check_client_version(version) {
                protocol::VersionCheck::Compatible => {}
                protocol::VersionCheck::Incompatible(reason) => {
                    // Send rejection Welcome.
                    let welcome = ServerMessage::Welcome {
                        version: PROTOCOL_VERSION,
                        encoding: RenderEncoding::SemanticFrame,
                        error: Some(reason),
                    };
                    let _ = protocol::write_message(&mut stream, &welcome);
                    return Ok(());
                }
            }

            let keybindings = match parse_client_keybindings(keybindings) {
                Ok(keybindings) => keybindings,
                Err(error) => {
                    let welcome = ServerMessage::Welcome {
                        version: PROTOCOL_VERSION,
                        encoding: RenderEncoding::SemanticFrame,
                        error: Some(error),
                    };
                    let _ = protocol::write_message(&mut stream, &welcome);
                    return Ok(());
                }
            };

            // Clamp size.
            let (clamped_cols, clamped_rows) = clamp_terminal_size(cols, rows);
            (
                clamped_cols,
                clamped_rows,
                cell_width_px,
                cell_height_px,
                requested_encoding,
                surface_mode,
                keybindings,
                launch_mode == ClientLaunchMode::TerminalAttach,
            )
        }
        _ => {
            // First message must be Hello.
            debug!(client_id, "first message was not Hello, closing");
            let welcome = ServerMessage::Welcome {
                version: PROTOCOL_VERSION,
                encoding: RenderEncoding::SemanticFrame,
                error: Some("expected Hello as first message".to_owned()),
            };
            let _ = protocol::write_message(&mut stream, &welcome);
            return Ok(());
        }
    };

    // Send Welcome.
    let welcome = ServerMessage::Welcome {
        version: PROTOCOL_VERSION,
        encoding: render_encoding,
        error: None,
    };
    protocol::write_message(&mut stream, &welcome).map_err(|e| io::Error::other(e.to_string()))?;

    set_client_recv_timeout(
        &stream,
        None,
        "failed to clear client handshake read timeout",
        client_id,
    )?;

    // Create separate channels for reliable control messages and droppable renders.
    let writer_queue = ClientWriterQueue::new();
    let writer = ClientWriter {
        control: ClientControlWriter::queue(writer_queue.clone()),
        render: ClientRenderWriter::queue(writer_queue.clone()),
    };

    // Spawn a writer thread that forwards messages from the channels to the stream.
    let write_stream = stream.try_clone()?;
    let writer_event_tx = server_event_tx.clone();
    std::thread::spawn(move || {
        client_writer_loop(write_stream, client_id, writer_queue, writer_event_tx);
    });

    // Notify the main loop about the new client.
    let _ = server_event_tx.blocking_send(ServerEvent::ClientConnected {
        client_id,
        cols: client_cols,
        rows: client_rows,
        cell_width_px,
        cell_height_px,
        surface_mode,
        render_encoding,
        keybindings,
        direct_attach_requested,
        writer,
    });

    // Enter read loop — read client messages and forward to main loop.
    client_read_loop(stream, client_id, server_event_tx, should_quit)
}

/// The client writer loop — prioritizes control messages over render frames.
fn client_writer_loop(
    mut stream: LocalStream,
    client_id: u64,
    writer_queue: Arc<ClientWriterQueue>,
    server_event_tx: mpsc::Sender<ServerEvent>,
) {
    while let Some(item) = writer_queue.recv() {
        match item {
            ClientWriteItem::Control(data) => {
                if !write_framed_bytes(&mut stream, &data) {
                    break;
                }
            }
            ClientWriteItem::Render(data) => {
                let _ =
                    server_event_tx.blocking_send(ServerEvent::ClientWriterDrained { client_id });
                if !write_framed_bytes(&mut stream, &data) {
                    break;
                }
            }
        }
    }
    writer_queue.close_writer();
    debug!("client writer thread exiting");
}

fn write_framed_bytes(stream: &mut LocalStream, data: &[u8]) -> bool {
    if let Err(err) = stream.write_all(data) {
        debug!(err = %err, "client write failed, closing writer");
        return false;
    }
    if let Err(err) = stream.flush() {
        debug!(err = %err, "client flush failed, closing writer");
        return false;
    }
    true
}

/// The client read loop — reads messages from the client and forwards to the server event channel.
fn client_read_loop(
    mut stream: LocalStream,
    client_id: u64,
    server_event_tx: &mpsc::Sender<ServerEvent>,
    should_quit: &Arc<AtomicBool>,
) -> io::Result<()> {
    while !should_quit.load(Ordering::Acquire) {
        let msg: ClientMessage = match protocol::read_message(&mut stream, MAX_GRAPHICS_FRAME_SIZE)
        {
            Ok(msg) => msg,
            Err(protocol::FramingError::UnexpectedEof) => {
                // Client disconnected.
                let _ =
                    server_event_tx.blocking_send(ServerEvent::ClientDisconnected { client_id });
                break;
            }
            Err(protocol::FramingError::Oversized { claimed, max }) => {
                warn!(
                    client_id,
                    claimed, max, "oversized message from client, closing"
                );
                let _ =
                    server_event_tx.blocking_send(ServerEvent::ClientDisconnected { client_id });
                break;
            }
            Err(err) => {
                debug!(client_id, err = %err, "client read error, closing");
                let _ =
                    server_event_tx.blocking_send(ServerEvent::ClientDisconnected { client_id });
                break;
            }
        };

        let event = match msg {
            ClientMessage::Input { data } => {
                // Validate input size.
                if data.len() > MAX_INPUT_PAYLOAD {
                    if crate::raw_input::is_complete_text_bracketed_paste(&data) {
                        warn!(
                            client_id,
                            size = data.len(),
                            max = MAX_INPUT_PAYLOAD,
                            "oversized bracketed paste from client, rejecting"
                        );
                        ServerEvent::ClientPasteRejected {
                            client_id,
                            size: data.len(),
                            max: MAX_INPUT_PAYLOAD,
                        }
                    } else {
                        warn!(
                            client_id,
                            size = data.len(),
                            "oversized input from client, closing"
                        );
                        let _ = server_event_tx
                            .blocking_send(ServerEvent::ClientDisconnected { client_id });
                        break;
                    }
                } else {
                    ServerEvent::ClientInput { client_id, data }
                }
            }
            ClientMessage::InputEvents { events } => match input_event_limit(&events) {
                InputEventLimit::WithinLimits => {
                    ServerEvent::ClientInputEvents { client_id, events }
                }
                InputEventLimit::TooManyEvents => {
                    warn!(
                        client_id,
                        count = events.len(),
                        "oversized input event batch from client, closing"
                    );
                    let _ = server_event_tx
                        .blocking_send(ServerEvent::ClientDisconnected { client_id });
                    break;
                }
                InputEventLimit::PasteTooLarge { size } => {
                    warn!(
                        client_id,
                        size,
                        max = MAX_INPUT_PAYLOAD,
                        "oversized structured paste from client, rejecting"
                    );
                    ServerEvent::ClientPasteRejected {
                        client_id,
                        size,
                        max: MAX_INPUT_PAYLOAD,
                    }
                }
                InputEventLimit::InputPayloadTooLarge { size } => {
                    warn!(
                        client_id,
                        size,
                        max = MAX_INPUT_PAYLOAD,
                        "oversized structured input payload from client, closing"
                    );
                    let _ = server_event_tx
                        .blocking_send(ServerEvent::ClientDisconnected { client_id });
                    break;
                }
            },
            ClientMessage::ObserveTerminal { target } => {
                ServerEvent::ClientObserveTerminal { client_id, target }
            }
            ClientMessage::ControlTerminal { target, takeover } => {
                ServerEvent::ClientControlTerminal {
                    client_id,
                    target,
                    takeover,
                }
            }
            ClientMessage::ClipboardImage { extension, data } => {
                if data.len() > MAX_CLIPBOARD_IMAGE_PAYLOAD {
                    warn!(
                        client_id,
                        size = data.len(),
                        "oversized clipboard image from client, closing"
                    );
                    let _ = server_event_tx
                        .blocking_send(ServerEvent::ClientDisconnected { client_id });
                    break;
                } else {
                    ServerEvent::ClientClipboardImage {
                        client_id,
                        extension,
                        data,
                    }
                }
            }
            ClientMessage::Resize {
                cols,
                rows,
                cell_width_px,
                cell_height_px,
            } => {
                let (clamped_cols, clamped_rows) = clamp_terminal_size(cols, rows);
                ServerEvent::ClientResize {
                    client_id,
                    cols: clamped_cols,
                    rows: clamped_rows,
                    cell_width_px,
                    cell_height_px,
                }
            }
            ClientMessage::Detach => ServerEvent::ClientDetach { client_id },
            ClientMessage::AttachTerminal {
                terminal_id,
                takeover,
            } => ServerEvent::ClientAttachTerminal {
                client_id,
                terminal_id,
                takeover,
            },
            ClientMessage::AttachScroll {
                source,
                direction,
                lines,
                column,
                row,
                modifiers,
            } => ServerEvent::ClientAttachScroll {
                client_id,
                source,
                direction,
                lines,
                column,
                row,
                modifiers,
            },
            ClientMessage::OpenSettings => ServerEvent::ClientOpenSettings { client_id },
            ClientMessage::OpenKeybindHelp => ServerEvent::ClientOpenKeybindHelp { client_id },
            ClientMessage::Ping { nonce } => ServerEvent::ClientPing { client_id, nonce },
            ClientMessage::RequestFullFrame => ServerEvent::ClientRequestFullFrame { client_id },
            ClientMessage::Hello { .. } => {
                // Duplicate Hello — ignore.
                continue;
            }
        };

        if server_event_tx.blocking_send(event).is_err() {
            break; // Main loop gone.
        }
    }

    debug!(client_id, "client read thread exiting");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use interprocess::local_socket::traits::Listener as _;
    use std::path::PathBuf;

    struct TestSocketPath(PathBuf);

    impl Drop for TestSocketPath {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn unique_test_path(name: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let filename = format!("h{}-{nanos}.sock", std::process::id());
        #[cfg(unix)]
        {
            let _ = name;
            PathBuf::from("/tmp").join(filename)
        }
        #[cfg(windows)]
        {
            std::env::temp_dir().join(format!("herdr-{name}-{filename}"))
        }
    }

    fn local_stream_pair(name: &str) -> (LocalStream, LocalStream, TestSocketPath) {
        let path = unique_test_path(name);
        let _ = std::fs::remove_file(&path);
        let listener = crate::ipc::bind_local_listener(&path).unwrap();
        let client = crate::ipc::connect_local_stream(&path).unwrap();
        let server = listener.accept().unwrap();
        (client, server, TestSocketPath(path))
    }

    fn recv_server_event(receiver: &mut mpsc::Receiver<ServerEvent>, context: &str) -> ServerEvent {
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        loop {
            match receiver.try_recv() {
                Ok(event) => return event,
                Err(mpsc::error::TryRecvError::Empty) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(err) => panic!("{context}: {err}"),
            }
        }
    }

    fn bracketed_paste_with_total_len(total_len: usize) -> Vec<u8> {
        const DELIMITER_BYTES: usize = b"\x1b[200~".len() + b"\x1b[201~".len();
        assert!(total_len >= DELIMITER_BYTES);
        let mut data = Vec::with_capacity(total_len);
        data.extend_from_slice(b"\x1b[200~");
        data.resize(total_len - b"\x1b[201~".len(), b'x');
        data.extend_from_slice(b"\x1b[201~");
        data
    }

    fn test_queue_writer() -> (ClientWriter, Arc<ClientWriterQueue>) {
        let queue = ClientWriterQueue::new();
        (
            ClientWriter {
                control: ClientControlWriter::queue(queue.clone()),
                render: ClientRenderWriter::queue(queue.clone()),
            },
            queue,
        )
    }

    fn frame_server_message(message: &ServerMessage) -> Vec<u8> {
        let mut bytes = Vec::new();
        protocol::write_message(&mut bytes, message).expect("frame server message");
        bytes
    }

    #[test]
    fn client_writer_queue_keeps_render_slot_bounded() {
        let (writer, _queue) = test_queue_writer();
        let first = frame_server_message(&ServerMessage::WindowTitle {
            title: Some("first".into()),
        });
        let second = frame_server_message(&ServerMessage::WindowTitle {
            title: Some("second".into()),
        });

        writer.render.try_send(first).expect("first render fits");
        assert!(matches!(
            writer.render.try_send(second),
            Err(TrySendError::Full(_))
        ));
    }

    #[test]
    fn client_writer_prioritizes_control_and_reports_render_drain() {
        let (mut client_stream, server_stream, _path) = local_stream_pair("client-writer-priority");
        let (writer, queue) = test_queue_writer();
        writer
            .render
            .try_send(frame_server_message(&ServerMessage::WindowTitle {
                title: Some("render".into()),
            }))
            .expect("queue render");
        writer
            .control
            .send(frame_server_message(&ServerMessage::ReloadSoundConfig))
            .expect("queue control");

        let (server_event_tx, mut server_event_rx) = mpsc::channel(4);
        let handle = std::thread::spawn(move || {
            client_writer_loop(server_stream, 9, queue, server_event_tx);
        });

        match protocol::read_message(&mut client_stream, MAX_FRAME_SIZE).expect("read control") {
            ServerMessage::ReloadSoundConfig => {}
            other => panic!("expected control message first, got {other:?}"),
        }
        match protocol::read_message(&mut client_stream, MAX_FRAME_SIZE).expect("read render") {
            ServerMessage::WindowTitle { title } => assert_eq!(title.as_deref(), Some("render")),
            other => panic!("expected render message second, got {other:?}"),
        }
        match server_event_rx
            .blocking_recv()
            .expect("writer drained render slot")
        {
            ServerEvent::ClientWriterDrained { client_id } => assert_eq!(client_id, 9),
            other => panic!("expected writer drained event, got {other:?}"),
        }

        drop(writer);
        handle.join().expect("writer exits after senders drop");
    }

    #[test]
    fn client_writer_exits_when_all_writer_handles_drop() {
        let (_client_stream, server_stream, _path) = local_stream_pair("client-writer-drop");
        let (writer, queue) = test_queue_writer();
        let (server_event_tx, _server_event_rx) = mpsc::channel(4);
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            client_writer_loop(server_stream, 11, queue, server_event_tx);
            let _ = done_tx.send(());
        });

        drop(writer);
        done_rx
            .recv_timeout(Duration::from_millis(100))
            .expect("writer exits without polling after senders drop");
    }

    #[test]
    fn client_writer_clone_keeps_loop_alive_until_final_drop() {
        let (mut client_stream, server_stream, _path) =
            local_stream_pair("client-writer-clone-drop");
        let (writer, queue) = test_queue_writer();
        let cloned_writer = writer.clone();
        let (server_event_tx, _server_event_rx) = mpsc::channel(4);
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            client_writer_loop(server_stream, 12, queue, server_event_tx);
            let _ = done_tx.send(());
        });

        drop(writer);
        cloned_writer
            .control
            .send(frame_server_message(&ServerMessage::ReloadSoundConfig))
            .expect("cloned writer still sends after original drops");
        match protocol::read_message(&mut client_stream, MAX_FRAME_SIZE)
            .expect("read control from cloned writer")
        {
            ServerMessage::ReloadSoundConfig => {}
            other => panic!("expected cloned control message, got {other:?}"),
        }
        assert!(
            done_rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "writer exited while cloned handles were still alive"
        );

        drop(cloned_writer);
        done_rx
            .recv_timeout(Duration::from_millis(100))
            .expect("writer exits after final cloned writer drops");
    }

    #[test]
    fn client_writer_closes_queue_after_socket_write_failure() {
        let (client_stream, server_stream, _path) =
            local_stream_pair("client-writer-socket-failure");
        #[cfg(not(windows))]
        server_stream
            .set_send_timeout(Some(Duration::from_millis(100)))
            .expect("set test send timeout");
        let (writer, queue) = test_queue_writer();
        let (server_event_tx, _server_event_rx) = mpsc::channel(4);
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            client_writer_loop(server_stream, 13, queue, server_event_tx);
            let _ = done_tx.send(());
        });

        drop(client_stream);
        writer
            .control
            .send(vec![b'x'; 1024 * 1024])
            .expect("message is accepted before the writer observes socket failure");
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("writer exits after socket write failure");

        assert!(matches!(writer.control.send(vec![b'y']), Err(SendError(_))));
        assert!(matches!(
            writer.render.try_send(vec![b'z']),
            Err(TrySendError::Disconnected(_))
        ));
    }

    #[test]
    fn clamp_terminal_size_zero_zero() {
        assert_eq!(
            clamp_terminal_size(0, 0),
            (MIN_CLIENT_COLS, MIN_CLIENT_ROWS)
        );
    }

    #[test]
    fn clamp_terminal_size_one_one() {
        assert_eq!(clamp_terminal_size(1, 1), (1, 1));
    }

    #[test]
    fn clamp_terminal_size_preserves_narrow_client_size() {
        assert_eq!(clamp_terminal_size(40, 12), (40, 12));
    }

    #[test]
    fn clamp_terminal_size_valid() {
        assert_eq!(clamp_terminal_size(120, 40), (120, 40));
    }

    #[test]
    fn clamp_terminal_size_exact_minimum() {
        assert_eq!(
            clamp_terminal_size(MIN_CLIENT_COLS, MIN_CLIENT_ROWS),
            (MIN_CLIENT_COLS, MIN_CLIENT_ROWS)
        );
    }

    #[test]
    fn parse_client_keybindings_accepts_local_profile() {
        let keybindings = parse_client_keybindings(ClientKeybindings::Local {
            keys_toml: r#"
[keys]
prefix = "ctrl+a"
new_tab = "prefix+t"

[[keys.command]]
key = "prefix+g"
command = "lazygit"
"#
            .to_owned(),
        })
        .expect("valid client keybindings")
        .expect("local profile");

        assert_eq!(keybindings.prefix.0, crossterm::event::KeyCode::Char('a'));
        assert!(keybindings
            .keybinds
            .new_tab
            .bindings
            .iter()
            .any(|binding| binding.label == "prefix+t"));
        assert!(keybindings.keybinds.custom_commands.is_empty());
    }

    #[test]
    fn parse_client_keybindings_tolerates_disabled_bindings() {
        let keybindings = parse_client_keybindings(ClientKeybindings::Local {
            keys_toml: r#"
[keys]
new_tab = "ctrl+notakey"
"#
            .to_owned(),
        })
        .expect("diagnostic-only client keybindings should be accepted")
        .expect("local profile");

        assert!(keybindings.keybinds.new_tab.bindings.is_empty());
        assert!(keybindings
            .keybinds
            .next_tab
            .bindings
            .iter()
            .any(|binding| binding.label == "prefix+n"));
    }

    // ---- Wire-ABI gate (M0-a) ----------------------------------------------------------
    //
    // The claim under test is an ORDERING claim: the gate runs ahead of the bincode decode. That
    // is only provable by a peer whose payload this fork *cannot* decode — if the decode ran
    // first, the reply would be the decode-failure Welcome ("incompatible client protocol …"),
    // and it is not.

    /// Encodes a bincode varint the way `bincode::config::standard()` does, by hand. The point of
    /// hand-rolling is that these tests must be able to build a message this crate's types cannot
    /// represent — an upstream-shaped `Hello`.
    fn varint(value: u32) -> Vec<u8> {
        if value < 251 {
            vec![value as u8]
        } else if value < 65536 {
            let mut out = vec![251u8];
            out.extend_from_slice(&(value as u16).to_le_bytes());
            out
        } else {
            let mut out = vec![252u8];
            out.extend_from_slice(&value.to_le_bytes());
            out
        }
    }

    fn framed(payload: &[u8]) -> Vec<u8> {
        let mut out = (payload.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(payload);
        out
    }

    /// `ClientMessage::Hello` with the launch mode as a raw varint, so a caller can send
    /// upstream's `TerminalAttach` (2) — a discriminant this fork's `ClientLaunchMode` does not
    /// have, so `bincode` cannot decode it.
    fn hello_bytes_with_launch_mode(launch_mode: u32) -> Vec<u8> {
        let mut payload = varint(0); // ClientMessage::Hello
        payload.extend(varint(PROTOCOL_VERSION));
        payload.extend(varint(100)); // cols
        payload.extend(varint(30)); // rows
        payload.extend(varint(8)); // cell_width_px
        payload.extend(varint(16)); // cell_height_px
        payload.extend(varint(1)); // RenderEncoding::TerminalAnsi
        payload.extend(varint(0)); // ClientSurfaceMode::FullApp
        payload.extend(varint(0)); // ClientKeybindings::Server
        payload.extend(varint(launch_mode));
        framed(&payload)
    }

    fn spawn_handshake(
        server_stream: LocalStream,
        server_event_tx: mpsc::Sender<ServerEvent>,
        should_quit: Arc<AtomicBool>,
    ) -> std::thread::JoinHandle<io::Result<()>> {
        std::thread::spawn(move || {
            handle_client_handshake(server_stream, 7, &server_event_tx, &should_quit)
        })
    }

    /// Reads a legacy (prelude-less) `Welcome` and returns its error string.
    fn read_legacy_welcome_error(stream: &mut LocalStream) -> Option<String> {
        let welcome: ServerMessage =
            protocol::read_message(stream, MAX_FRAME_SIZE).expect("read welcome");
        match welcome {
            ServerMessage::Welcome { error, .. } => error,
            other => panic!("expected Welcome, got {other:?}"),
        }
    }

    /// **The RED case.** A client with upstream's layout — no prelude, and a `launch_mode` this
    /// fork's `ClientLaunchMode` cannot represent — must be turned away *before* its `Hello` is
    /// decoded.
    ///
    /// The discriminator is the error string. If the server had decoded first, the undecodable
    /// discriminant 2 would have taken the `FramingError::Bincode` arm and answered
    /// "incompatible client protocol (server speaks vN); update herdr". Receiving the *prelude*
    /// rejection instead is the proof that no byte of that `Hello` was ever interpreted.
    #[test]
    fn upstream_layout_client_is_rejected_before_its_hello_is_decoded() {
        let (mut client_stream, server_stream, _path) = local_stream_pair("abi-gate-upstream");
        let (server_event_tx, mut server_event_rx) = mpsc::channel(4);
        let should_quit = Arc::new(AtomicBool::new(false));
        let handle = spawn_handshake(server_stream, server_event_tx, should_quit.clone());

        // upstream/master: `AppDirectGraphics` is inserted before `TerminalAttach`, so its
        // `TerminalAttach` is 2 (mobile/.prd/03-blockers.md B1). No prelude, exactly like an
        // upstream binary.
        client_stream
            .write_all(&hello_bytes_with_launch_mode(2))
            .expect("write upstream-shaped hello");
        client_stream.flush().expect("flush");

        let error = read_legacy_welcome_error(&mut client_stream)
            .expect("an unidentified peer must be rejected, not welcomed");
        assert!(
            error.contains("wire-ABI prelude"),
            "the rejection must be the ABI gate's, proving it ran before the decode; got: {error}"
        );
        assert!(
            !error.contains("incompatible client protocol"),
            "this is the decode-failure message: the Hello was decoded after all. got: {error}"
        );
        assert!(
            server_event_rx.try_recv().is_err(),
            "a rejected peer must never reach the server as a connected client"
        );

        drop(client_stream);
        should_quit.store(true, Ordering::Release);
        handle.join().expect("join").expect("handshake result");
    }

    /// The same gate, for a peer whose `Hello` this fork *could* have decoded. Decodability is not
    /// the question the gate asks — identity is — so a perfectly well-formed prelude-less `Hello`
    /// is refused too. Accepting it is what would turn a loud rejection into a silent mis-parse,
    /// because a protocol-20 `Hello` is equally consistent with herdr-mx and with upstream.
    #[test]
    fn a_well_formed_hello_without_a_prelude_is_still_rejected() {
        let (mut client_stream, server_stream, _path) = local_stream_pair("abi-gate-legacy");
        let (server_event_tx, mut server_event_rx) = mpsc::channel(4);
        let should_quit = Arc::new(AtomicBool::new(false));
        let handle = spawn_handshake(server_stream, server_event_tx, should_quit.clone());

        client_stream
            .write_all(&hello_bytes_with_launch_mode(1))
            .expect("write mx-shaped hello");
        client_stream.flush().expect("flush");

        let error = read_legacy_welcome_error(&mut client_stream)
            .expect("a prelude-less client must be rejected");
        assert!(error.contains("wire-ABI prelude"), "{error}");
        // The rejection must be readable by the old client, i.e. framed WITHOUT a prelude in
        // front of it. `read_legacy_welcome_error` above decoded straight from the length prefix,
        // so reaching this line already proves it.
        assert!(server_event_rx.try_recv().is_err());

        drop(client_stream);
        should_quit.store(true, Ordering::Release);
        handle.join().expect("join").expect("handshake result");
    }

    /// A peer that announces the same fork, protocol and epoch but a different byte layout is
    /// rejected on the fingerprint — the case a version range can never see, and the reason the
    /// window is a table of triples rather than `MIN..=CURRENT`.
    #[test]
    fn a_peer_announcing_a_different_layout_is_rejected_on_the_fingerprint() {
        let (mut client_stream, server_stream, _path) = local_stream_pair("abi-gate-fingerprint");
        let (server_event_tx, mut server_event_rx) = mpsc::channel(4);
        let should_quit = Arc::new(AtomicBool::new(false));
        let handle = spawn_handshake(server_stream, server_event_tx, should_quit.clone());

        let mut prelude = protocol::abi::WirePrelude::local().encode();
        prelude[20] ^= 0xff; // first byte of the schema fingerprint
        client_stream.write_all(&prelude).expect("write prelude");
        client_stream
            .write_all(&hello_bytes_with_launch_mode(1))
            .expect("write hello");
        client_stream.flush().expect("flush");

        // A peer that speaks preludes is answered with one, even on rejection.
        match protocol::abi::read_peer_handshake_start(&mut client_stream).expect("server prelude")
        {
            protocol::abi::PeerHandshakeStart::Prelude(peer) => {
                assert_eq!(peer, protocol::abi::WirePrelude::local())
            }
            other => panic!("expected the server's prelude, got {other:?}"),
        }
        let error = read_legacy_welcome_error(&mut client_stream).expect("rejection");
        assert!(
            error.contains("schema fingerprint"),
            "the rejection must name the layout axis; got: {error}"
        );
        assert!(server_event_rx.try_recv().is_err());

        drop(client_stream);
        should_quit.store(true, Ordering::Release);
        handle.join().expect("join").expect("handshake result");
    }

    #[test]
    fn handshake_negotiates_terminal_ansi_encoding() {
        let (mut client_stream, server_stream, _path) = local_stream_pair("client-handshake-ansi");
        let (server_event_tx, mut server_event_rx) = mpsc::channel(4);
        let should_quit = Arc::new(AtomicBool::new(false));
        let handshake_quit = should_quit.clone();
        let handle = std::thread::spawn(move || {
            handle_client_handshake(server_stream, 42, &server_event_tx, &handshake_quit)
        });

        protocol::abi::write_prelude(&mut client_stream).expect("write prelude");
        protocol::write_message(
            &mut client_stream,
            &ClientMessage::Hello {
                version: PROTOCOL_VERSION,
                cols: 100,
                rows: 30,
                cell_width_px: 8,
                cell_height_px: 16,
                requested_encoding: RenderEncoding::TerminalAnsi,
                surface_mode: ClientSurfaceMode::FullApp,
                keybindings: ClientKeybindings::Server,
                launch_mode: ClientLaunchMode::App,
            },
        )
        .expect("write hello");

        let start = protocol::abi::read_peer_handshake_start(&mut client_stream)
            .expect("read server prelude");
        match start {
            protocol::abi::PeerHandshakeStart::Prelude(peer) => assert_eq!(
                protocol::abi::check_peer_abi(&peer),
                protocol::abi::AbiCheck::Accepted
            ),
            other => panic!("server must answer with its wire-ABI prelude, got {other:?}"),
        }
        let welcome: ServerMessage =
            protocol::read_message(&mut client_stream, MAX_FRAME_SIZE).expect("read welcome");
        match welcome {
            ServerMessage::Welcome {
                version,
                encoding,
                error,
            } => {
                assert_eq!(version, PROTOCOL_VERSION);
                assert_eq!(encoding, RenderEncoding::TerminalAnsi);
                assert_eq!(error, None);
            }
            other => panic!("expected Welcome, got {other:?}"),
        }

        match server_event_rx
            .blocking_recv()
            .expect("client connected event")
        {
            ServerEvent::ClientConnected {
                client_id,
                cols,
                rows,
                cell_width_px,
                cell_height_px,
                surface_mode,
                render_encoding,
                keybindings,
                direct_attach_requested,
                writer,
            } => {
                assert_eq!(client_id, 42);
                assert_eq!((cols, rows), (100, 30));
                assert_eq!((cell_width_px, cell_height_px), (8, 16));
                assert_eq!(surface_mode, ClientSurfaceMode::FullApp);
                assert_eq!(render_encoding, RenderEncoding::TerminalAnsi);
                assert!(keybindings.is_none());
                assert!(!direct_attach_requested);
                drop(writer);
            }
            other => panic!("expected ClientConnected, got {other:?}"),
        }

        drop(client_stream);
        should_quit.store(true, Ordering::Release);
        handle
            .join()
            .expect("handshake thread join")
            .expect("handshake thread result");
    }

    #[test]
    fn handshake_marks_terminal_attach_launch_mode() {
        let (mut client_stream, server_stream, _path) =
            local_stream_pair("client-handshake-terminal-attach");
        let (server_event_tx, mut server_event_rx) = mpsc::channel(4);
        let should_quit = Arc::new(AtomicBool::new(false));
        let handshake_quit = should_quit.clone();
        let handle = std::thread::spawn(move || {
            handle_client_handshake(server_stream, 42, &server_event_tx, &handshake_quit)
        });

        protocol::abi::write_prelude(&mut client_stream).expect("write prelude");
        protocol::write_message(
            &mut client_stream,
            &ClientMessage::Hello {
                version: PROTOCOL_VERSION,
                cols: 100,
                rows: 30,
                cell_width_px: 8,
                cell_height_px: 16,
                requested_encoding: RenderEncoding::TerminalAnsi,
                surface_mode: ClientSurfaceMode::FullApp,
                keybindings: ClientKeybindings::Server,
                launch_mode: ClientLaunchMode::TerminalAttach,
            },
        )
        .expect("write hello");

        let start = protocol::abi::read_peer_handshake_start(&mut client_stream)
            .expect("read server prelude");
        match start {
            protocol::abi::PeerHandshakeStart::Prelude(peer) => assert_eq!(
                protocol::abi::check_peer_abi(&peer),
                protocol::abi::AbiCheck::Accepted
            ),
            other => panic!("server must answer with its wire-ABI prelude, got {other:?}"),
        }
        let welcome: ServerMessage =
            protocol::read_message(&mut client_stream, MAX_FRAME_SIZE).expect("read welcome");
        match welcome {
            ServerMessage::Welcome {
                version,
                encoding,
                error,
            } => {
                assert_eq!(version, PROTOCOL_VERSION);
                assert_eq!(encoding, RenderEncoding::TerminalAnsi);
                assert_eq!(error, None);
            }
            other => panic!("expected Welcome, got {other:?}"),
        }

        match server_event_rx
            .blocking_recv()
            .expect("client connected event")
        {
            ServerEvent::ClientConnected {
                direct_attach_requested,
                writer,
                ..
            } => {
                assert!(direct_attach_requested);
                drop(writer);
            }
            other => panic!("expected ClientConnected, got {other:?}"),
        }

        drop(client_stream);
        should_quit.store(true, Ordering::Release);
        handle
            .join()
            .expect("handshake thread join")
            .expect("handshake thread result");
    }

    #[test]
    fn client_read_loop_rejects_oversized_bracketed_paste_without_disconnect() {
        let (mut client_stream, server_stream, _path) = local_stream_pair("client-read-oversized");
        let (server_event_tx, mut server_event_rx) = mpsc::channel(4);
        let should_quit = Arc::new(AtomicBool::new(false));
        let read_quit = should_quit.clone();
        let handle = std::thread::spawn(move || {
            client_read_loop(server_stream, 7, &server_event_tx, &read_quit)
        });

        protocol::write_message(
            &mut client_stream,
            &ClientMessage::Input {
                data: bracketed_paste_with_total_len(MAX_INPUT_PAYLOAD),
            },
        )
        .expect("write maximum-size bracketed paste");

        match recv_server_event(&mut server_event_rx, "maximum-size paste event") {
            ServerEvent::ClientInput { client_id, data } => {
                assert_eq!(client_id, 7);
                assert_eq!(data.len(), MAX_INPUT_PAYLOAD);
            }
            other => panic!("expected maximum-size ClientInput, got {other:?}"),
        }

        protocol::write_message(
            &mut client_stream,
            &ClientMessage::Input {
                data: bracketed_paste_with_total_len(MAX_INPUT_PAYLOAD + 1),
            },
        )
        .expect("write oversized bracketed paste");

        match recv_server_event(&mut server_event_rx, "oversized paste rejection") {
            ServerEvent::ClientPasteRejected {
                client_id,
                size,
                max,
            } => {
                assert_eq!(client_id, 7);
                assert_eq!(size, MAX_INPUT_PAYLOAD + 1);
                assert_eq!(max, MAX_INPUT_PAYLOAD);
            }
            ServerEvent::ClientDisconnected { .. } => {
                panic!("oversized input must be rejected without disconnecting the client")
            }
            other => panic!("expected ClientPasteRejected, got {other:?}"),
        }

        protocol::write_message(
            &mut client_stream,
            &ClientMessage::Input {
                data: b"still connected".to_vec(),
            },
        )
        .expect("write valid input after rejection");

        match recv_server_event(&mut server_event_rx, "valid input after rejection") {
            ServerEvent::ClientInput { client_id, data } => {
                assert_eq!(client_id, 7);
                assert_eq!(data, b"still connected");
            }
            other => panic!("expected ClientInput after rejection, got {other:?}"),
        }

        drop(client_stream);
        should_quit.store(true, Ordering::Release);
        handle
            .join()
            .expect("read thread join")
            .expect("read thread result");
    }

    #[test]
    fn client_read_loop_disconnects_oversized_non_paste_input() {
        let (mut client_stream, server_stream, _path) =
            local_stream_pair("client-read-oversized-non-paste");
        let (server_event_tx, mut server_event_rx) = mpsc::channel(4);
        let should_quit = Arc::new(AtomicBool::new(false));
        let read_quit = should_quit.clone();
        let handle = std::thread::spawn(move || {
            client_read_loop(server_stream, 7, &server_event_tx, &read_quit)
        });

        protocol::write_message(
            &mut client_stream,
            &ClientMessage::Input {
                data: vec![b'x'; MAX_INPUT_PAYLOAD + 1],
            },
        )
        .expect("write oversized non-paste input");

        assert!(matches!(
            recv_server_event(&mut server_event_rx, "oversized non-paste disconnect"),
            ServerEvent::ClientDisconnected { client_id: 7 }
        ));

        drop(client_stream);
        should_quit.store(true, Ordering::Release);
        handle
            .join()
            .expect("read thread join")
            .expect("read thread result");
    }

    #[test]
    fn client_read_loop_disconnects_marker_wrapped_invalid_utf8() {
        let (mut client_stream, server_stream, _path) =
            local_stream_pair("client-read-invalid-utf8-paste");
        let (server_event_tx, mut server_event_rx) = mpsc::channel(4);
        let should_quit = Arc::new(AtomicBool::new(false));
        let read_quit = should_quit.clone();
        let handle = std::thread::spawn(move || {
            client_read_loop(server_stream, 7, &server_event_tx, &read_quit)
        });
        let mut data = bracketed_paste_with_total_len(MAX_INPUT_PAYLOAD + 1);
        data[b"\x1b[200~".len()] = 0xff;

        protocol::write_message(&mut client_stream, &ClientMessage::Input { data })
            .expect("write marker-wrapped invalid UTF-8 input");

        assert!(matches!(
            recv_server_event(&mut server_event_rx, "invalid UTF-8 input disconnect"),
            ServerEvent::ClientDisconnected { client_id: 7 }
        ));

        drop(client_stream);
        should_quit.store(true, Ordering::Release);
        handle
            .join()
            .expect("read thread join")
            .expect("read thread result");
    }

    #[test]
    fn client_read_loop_forwards_input_events() {
        let (mut client_stream, server_stream, _path) = local_stream_pair("client-read-events");
        let (server_event_tx, mut server_event_rx) = mpsc::channel(4);
        let should_quit = Arc::new(AtomicBool::new(false));
        let read_quit = should_quit.clone();
        let handle = std::thread::spawn(move || {
            client_read_loop(server_stream, 7, &server_event_tx, &read_quit)
        });
        let events = vec![
            ClientInputEvent::Key {
                code: crate::protocol::ClientKeyCode::Enter,
                modifiers: 0,
                kind: crate::protocol::ClientKeyKind::Press,

                repeat_count: 1,
                generated_text: None,
                source: crate::protocol::ClientKeySource::Synthesized,
            },
            ClientInputEvent::FocusGained,
        ];

        protocol::write_message(
            &mut client_stream,
            &ClientMessage::InputEvents {
                events: events.clone(),
            },
        )
        .expect("write input events");

        match server_event_rx
            .blocking_recv()
            .expect("client input events event")
        {
            ServerEvent::ClientInputEvents {
                client_id,
                events: actual,
            } => {
                assert_eq!(client_id, 7);
                assert_eq!(actual, events);
            }
            other => panic!("expected ClientInputEvents, got {other:?}"),
        }

        drop(client_stream);
        should_quit.store(true, Ordering::Release);
        handle
            .join()
            .expect("read thread join")
            .expect("read thread result");
    }

    #[test]
    fn client_read_loop_rejects_oversized_input_event_batch() {
        let (mut client_stream, server_stream, _path) =
            local_stream_pair("client-read-oversized-events");
        let (server_event_tx, mut server_event_rx) = mpsc::channel(4);
        let should_quit = Arc::new(AtomicBool::new(false));
        let read_quit = should_quit.clone();
        let handle = std::thread::spawn(move || {
            client_read_loop(server_stream, 7, &server_event_tx, &read_quit)
        });

        protocol::write_message(
            &mut client_stream,
            &ClientMessage::InputEvents {
                events: vec![ClientInputEvent::FocusGained; MAX_INPUT_EVENT_BATCH + 1],
            },
        )
        .expect("write oversized input events");

        match server_event_rx
            .blocking_recv()
            .expect("client disconnected event")
        {
            ServerEvent::ClientDisconnected { client_id } => assert_eq!(client_id, 7),
            other => panic!("expected ClientDisconnected, got {other:?}"),
        }

        drop(client_stream);
        should_quit.store(true, Ordering::Release);
        handle
            .join()
            .expect("read thread join")
            .expect("read thread result");
    }

    #[test]
    fn client_read_loop_rejects_oversized_input_event_paste() {
        let (mut client_stream, server_stream, _path) =
            local_stream_pair("client-read-oversized-paste");
        let (server_event_tx, mut server_event_rx) = mpsc::channel(4);
        let should_quit = Arc::new(AtomicBool::new(false));
        let read_quit = should_quit.clone();
        let handle = std::thread::spawn(move || {
            client_read_loop(server_stream, 7, &server_event_tx, &read_quit)
        });

        let maximum = vec![
            ClientInputEvent::Paste {
                text: "x".repeat(MAX_INPUT_PAYLOAD / 2),
            },
            ClientInputEvent::Paste {
                text: "y".repeat(MAX_INPUT_PAYLOAD - (MAX_INPUT_PAYLOAD / 2)),
            },
        ];
        protocol::write_message(
            &mut client_stream,
            &ClientMessage::InputEvents {
                events: maximum.clone(),
            },
        )
        .expect("write maximum-size structured paste");

        match recv_server_event(&mut server_event_rx, "maximum-size structured paste") {
            ServerEvent::ClientInputEvents { client_id, events } => {
                assert_eq!(client_id, 7);
                assert_eq!(events, maximum);
            }
            other => panic!("expected maximum-size ClientInputEvents, got {other:?}"),
        }

        let oversized = vec![
            ClientInputEvent::FocusGained,
            ClientInputEvent::Paste {
                text: "x".repeat(MAX_INPUT_PAYLOAD / 2),
            },
            ClientInputEvent::Paste {
                text: "y".repeat(MAX_INPUT_PAYLOAD - (MAX_INPUT_PAYLOAD / 2) + 1),
            },
            ClientInputEvent::FocusLost,
            ClientInputEvent::Paste {
                text: "tail".to_owned(),
            },
        ];
        protocol::write_message(
            &mut client_stream,
            &ClientMessage::InputEvents { events: oversized },
        )
        .expect("write oversized structured paste");

        match recv_server_event(&mut server_event_rx, "oversized structured paste rejection") {
            ServerEvent::ClientPasteRejected {
                client_id,
                size,
                max,
            } => {
                assert_eq!(client_id, 7);
                assert_eq!(size, MAX_INPUT_PAYLOAD + 5);
                assert_eq!(max, MAX_INPUT_PAYLOAD);
            }
            other => panic!("expected ClientPasteRejected, got {other:?}"),
        }

        let valid = vec![ClientInputEvent::FocusGained];
        protocol::write_message(
            &mut client_stream,
            &ClientMessage::InputEvents {
                events: valid.clone(),
            },
        )
        .expect("write valid structured input after rejection");

        match recv_server_event(&mut server_event_rx, "structured input after rejection") {
            ServerEvent::ClientInputEvents { client_id, events } => {
                assert_eq!(client_id, 7);
                assert_eq!(events, valid);
            }
            other => panic!("expected ClientInputEvents after rejection, got {other:?}"),
        }

        drop(client_stream);
        should_quit.store(true, Ordering::Release);
        handle
            .join()
            .expect("read thread join")
            .expect("read thread result");
    }

    #[test]
    fn structured_input_limits_charge_grouped_repeats_and_text_payloads() {
        let grouped = ClientInputEvent::Key {
            code: crate::protocol::ClientKeyCode::Char('x'),
            modifiers: 0,
            kind: crate::protocol::ClientKeyKind::Press,
            repeat_count: (MAX_INPUT_EVENT_BATCH + 1) as u16,
            generated_text: None,
            source: crate::protocol::ClientKeySource::Synthesized,
        };
        assert_eq!(
            input_event_limit(&[grouped]),
            InputEventLimit::TooManyEvents
        );

        let repeated_text = ClientInputEvent::Key {
            code: crate::protocol::ClientKeyCode::Char('x'),
            modifiers: 0,
            kind: crate::protocol::ClientKeyKind::Press,
            repeat_count: MAX_INPUT_EVENT_BATCH as u16,
            generated_text: Some("x".repeat((MAX_INPUT_PAYLOAD / MAX_INPUT_EVENT_BATCH) + 1)),
            source: crate::protocol::ClientKeySource::Synthesized,
        };
        assert!(matches!(
            input_event_limit(&[repeated_text]),
            InputEventLimit::InputPayloadTooLarge { size } if size > MAX_INPUT_PAYLOAD
        ));

        let text = ClientInputEvent::TextCommit("x".repeat(MAX_INPUT_PAYLOAD + 1));
        assert_eq!(
            input_event_limit(&[text]),
            InputEventLimit::InputPayloadTooLarge {
                size: MAX_INPUT_PAYLOAD + 1
            }
        );
    }

    #[test]
    fn handshake_timeout_is_within_five_second_deadline() {
        // The handshake timeout must be short enough that
        // the connection is guaranteed to close within 5 seconds even with
        // OS overhead (thread scheduling, timer slack, cleanup).
        assert!(
            HANDSHAKE_TIMEOUT < Duration::from_secs(5),
            "HANDSHAKE_TIMEOUT ({:?}) must be less than 5 seconds to guarantee \
             connection close within the 5-second deadline",
            HANDSHAKE_TIMEOUT
        );
    }
}
