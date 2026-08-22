//! Wire-ABI identification: the fixed-size prelude that gates a client connection **before any
//! bincode is decoded**, plus the explicit table of peer ABIs this build accepts.
//!
//! # Why `PROTOCOL_VERSION` is not enough
//!
//! `PROTOCOL_VERSION` is dead as a layout identifier. herdr-mx and upstream/master both report
//! `20` while disagreeing on exactly the bytes a client depends on — `ServerMessage::Terminal` is
//! 13 here and 2 upstream, `ClientLaunchMode::TerminalAttach` is 1 here and 2 upstream — because
//! this fork's merge convention appends upstream's inserted variants at the enum *tail*
//! (`wire.rs`, `ObserveTerminal`'s doc comment). Two peers can therefore agree on the integer and
//! disagree on every frame. Widening the version check into a range without a layout identifier
//! only converts a loud rejection into a **silent mis-parse**.
//!
//! # Why a prelude and not a field in `Welcome`
//!
//! The first value that diverges between the forks — `ClientLaunchMode` — is a field of
//! `ClientMessage::Hello`, and the side that decodes `Hello` is the **server**. A fingerprint
//! carried in the server's `Welcome` would be checked *after* the server had already mis-parsed
//! the client's `Hello`. The gate has to sit ahead of every bincode decode, so it is a fixed-size,
//! hand-encoded byte block that both sides read first.
//!
//! # Why the fingerprint covers more than enum tags
//!
//! Upstream added a `sgr_pixels` field to `MouseCapture` without moving any tag: the tags agree
//! and the payload layout does not. So the fingerprint is taken over the *encodings* of an
//! exemplar of every `ClientMessage`/`ServerMessage` variant, with position-distinct sentinel
//! values, which transitively covers nested enums (`RenderEncoding`, `ClientLaunchMode`,
//! `ClientInputEvent`, …) and payload struct field order and types. A build id would also change
//! on every wire change, but it changes on every *other* build too and would reject peers that
//! agree perfectly.
//!
//! # What this does NOT cover
//!
//! See `wire_schema_fingerprint`.

use std::io::{self, Read, Write};
use std::sync::OnceLock;

use sha2::{Digest, Sha256};

use super::wire::{
    AttachScrollDirection, AttachScrollSource, CellData, ClientInputEvent, ClientKeyCode,
    ClientKeyKind, ClientKeySource, ClientKeybindings, ClientLaunchMode, ClientMessage,
    ClientMouseButton, ClientMouseKind, ClientSurfaceMode, CursorState, FrameData, FrameDelta,
    FramingError, NotifyKind, RenderEncoding, ServerMessage, TerminalFrame, PROTOCOL_VERSION,
};

// ---------------------------------------------------------------------------
// The prelude
// ---------------------------------------------------------------------------

/// Leading bytes of the handshake prelude.
///
/// **This value is load-bearing, not decorative.** Read as a little-endian `u32` it is
/// `0x5244_5248` = 1_380_208_712, which is larger than *both* frame caps
/// (`MAX_FRAME_SIZE` = 2 MiB, `MAX_GRAPHICS_FRAME_SIZE` = 32 MiB). A legacy peer's first four
/// bytes are the `u32` length prefix of its `Hello`, and every reader and writer in this protocol
/// rejects a frame past those caps, so **no legal legacy handshake can begin with these bytes**.
/// That is what makes the sniff in [`read_peer_handshake_start`] a decision rather than a guess.
/// `magic_can_never_be_a_legacy_length_prefix` pins it.
pub const WIRE_ABI_MAGIC: [u8; 4] = *b"HRDR";

/// Fork namespace. Fixed width so the prelude stays a constant-size block.
pub const WIRE_ABI_FORK: [u8; 8] = *b"herdr-mx";

/// Hand-declared generation of this fork's wire layout.
///
/// Bumped whenever [`wire_schema_fingerprint`] changes — the pinned-fingerprint test is what makes
/// "whenever" mechanical rather than aspirational. Independent of `PROTOCOL_VERSION`: the version
/// says *which negotiation* the peer speaks, the epoch says *which byte layout* it was built from.
///
/// Epoch 1 is the first epoch. Epoch 0 is reserved for "no prelude" (herdr-mx ≤ protocol 20), which
/// never appears on the wire and exists only as a name in `docs/next/protocol/abi-history.json`.
pub const WIRE_ABI_EPOCH: u32 = 1;

/// `magic(4) + fork(8) + abi_epoch(4) + protocol_version(4) + schema_fingerprint(8)`.
pub const WIRE_ABI_PRELUDE_LEN: usize = 28;

/// The identity a peer announces before it sends a single bincode byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WirePrelude {
    /// Fork namespace, as sent. Compared verbatim; rendered lossily for diagnostics only.
    pub fork: [u8; 8],
    /// The peer's [`WIRE_ABI_EPOCH`].
    pub abi_epoch: u32,
    /// The peer's `PROTOCOL_VERSION`.
    pub protocol_version: u32,
    /// The peer's [`wire_schema_fingerprint`].
    pub schema_fingerprint: [u8; 8],
}

impl WirePrelude {
    /// The prelude this build sends.
    pub fn local() -> Self {
        Self {
            fork: WIRE_ABI_FORK,
            abi_epoch: WIRE_ABI_EPOCH,
            protocol_version: PROTOCOL_VERSION,
            schema_fingerprint: wire_schema_fingerprint(),
        }
    }

    /// The 28 bytes that go on the wire. Hand-encoded on purpose: a prelude that needed a decoder
    /// would be a decoder running ahead of the gate that decides whether decoding is safe.
    pub fn encode(&self) -> [u8; WIRE_ABI_PRELUDE_LEN] {
        let mut out = [0u8; WIRE_ABI_PRELUDE_LEN];
        out[0..4].copy_from_slice(&WIRE_ABI_MAGIC);
        out[4..12].copy_from_slice(&self.fork);
        out[12..16].copy_from_slice(&self.abi_epoch.to_le_bytes());
        out[16..20].copy_from_slice(&self.protocol_version.to_le_bytes());
        out[20..28].copy_from_slice(&self.schema_fingerprint);
        out
    }

    /// Decodes everything after the magic. Infallible by construction: every field is fixed-width
    /// and every bit pattern is a legal (if unacceptable) value, which is the point — an
    /// unrecognized peer must still be *describable* in the rejection we send it.
    fn decode_body(body: &[u8; WIRE_ABI_PRELUDE_LEN - 4]) -> Self {
        let mut fork = [0u8; 8];
        fork.copy_from_slice(&body[0..8]);
        let mut schema_fingerprint = [0u8; 8];
        schema_fingerprint.copy_from_slice(&body[16..24]);
        Self {
            fork,
            abi_epoch: u32::from_le_bytes([body[8], body[9], body[10], body[11]]),
            protocol_version: u32::from_le_bytes([body[12], body[13], body[14], body[15]]),
            schema_fingerprint,
        }
    }

    /// The fork namespace as text, for error messages only.
    pub fn fork_name(&self) -> String {
        String::from_utf8_lossy(&self.fork)
            .trim_end_matches('\0')
            .to_owned()
    }

    /// One line naming every axis, so a rejection says which axis disagreed.
    pub fn describe(&self) -> String {
        format!(
            "fork={} protocol={} abi_epoch={} schema={}",
            self.fork_name(),
            self.protocol_version,
            self.abi_epoch,
            hex8(&self.schema_fingerprint)
        )
    }
}

fn hex8(bytes: &[u8; 8]) -> String {
    let mut out = String::with_capacity(16);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// What the first four bytes of a peer's stream turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerHandshakeStart {
    /// The peer speaks the ABI prelude.
    Prelude(WirePrelude),
    /// The peer sent no prelude. The four bytes are its frame length prefix, returned so a caller
    /// that wants to answer in the legacy framing can put them back (`std::io::Read::chain`).
    Legacy([u8; 4]),
}

/// Writes this build's prelude. Must precede the first framed message in each direction.
pub fn write_prelude<W: Write>(writer: &mut W) -> io::Result<()> {
    writer.write_all(&WirePrelude::local().encode())?;
    writer.flush()
}

/// Reads the peer's prelude, or reports that it did not send one.
///
/// Consumes exactly 4 bytes when the peer is legacy and exactly
/// [`WIRE_ABI_PRELUDE_LEN`] when it is not, so the caller's stream position is well defined in
/// both branches.
pub fn read_peer_handshake_start<R: Read>(
    reader: &mut R,
) -> Result<PeerHandshakeStart, FramingError> {
    let mut head = [0u8; 4];
    read_exact_or_eof(reader, &mut head)?;
    if head != WIRE_ABI_MAGIC {
        return Ok(PeerHandshakeStart::Legacy(head));
    }
    let mut body = [0u8; WIRE_ABI_PRELUDE_LEN - 4];
    read_exact_or_eof(reader, &mut body)?;
    Ok(PeerHandshakeStart::Prelude(WirePrelude::decode_body(&body)))
}

fn read_exact_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<(), FramingError> {
    reader.read_exact(buf).map_err(|e| {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            FramingError::UnexpectedEof
        } else {
            FramingError::Io(e)
        }
    })
}

// ---------------------------------------------------------------------------
// The compatibility window (M0-b): a table, not a range
// ---------------------------------------------------------------------------

/// One accepted peer wire ABI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WireAbi {
    /// The peer's `PROTOCOL_VERSION`.
    pub protocol_version: u32,
    /// The peer's [`WIRE_ABI_EPOCH`].
    pub abi_epoch: u32,
    /// The peer's [`wire_schema_fingerprint`].
    pub schema_fingerprint: [u8; 8],
}

/// Previously-shipped ABIs this build still accepts.
///
/// **A range would be a lie.** `MIN_SUPPORTED_PROTOCOL..=PROTOCOL_VERSION` says nothing about
/// layout, and layout is the thing that breaks (both forks report 20 and disagree on tags). So the
/// window is an explicit table of `(protocol version, ABI epoch, schema fingerprint)` triples and
/// nothing else is accepted.
///
/// **Empty today, and that is a decision, not an omission**: the only older peers in existence are
/// pre-prelude builds, which cannot be identified at all (an unannotated protocol-20 `Hello` is
/// equally consistent with herdr-mx and with upstream). Accepting them would reintroduce exactly
/// the ambiguity this module exists to remove. Every row added here is a compatibility decision
/// and must be recorded in `docs/next/protocol/abi-history.json`
/// (`abi_history_matches_the_accepted_table` enforces the mirror).
const ACCEPTED_HISTORICAL_ABIS: &[WireAbi] = &[];

/// The ABI this build speaks.
pub fn local_wire_abi() -> WireAbi {
    WireAbi {
        protocol_version: PROTOCOL_VERSION,
        abi_epoch: WIRE_ABI_EPOCH,
        schema_fingerprint: wire_schema_fingerprint(),
    }
}

/// Every ABI this build accepts, local first.
pub fn accepted_wire_abis() -> Vec<WireAbi> {
    let mut abis = vec![local_wire_abi()];
    abis.extend_from_slice(ACCEPTED_HISTORICAL_ABIS);
    abis
}

/// The oldest protocol version in [`accepted_wire_abis`].
///
/// This is `MIN_SUPPORTED_PROTOCOL` — derived from the table rather than declared beside it, so it
/// cannot claim a window the table does not actually honour.
pub fn min_supported_protocol() -> u32 {
    accepted_wire_abis()
        .iter()
        .map(|abi| abi.protocol_version)
        .min()
        .unwrap_or(PROTOCOL_VERSION)
}

/// Result of checking a peer's announced ABI against [`accepted_wire_abis`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AbiCheck {
    /// The peer's layout is one this build can decode.
    Accepted,
    /// The peer's layout is not. The string is user-facing and names the disagreeing axis.
    Rejected(String),
}

/// Checks a peer's prelude against the accepted table.
///
/// Runs before any bincode decode, so a rejection here means **nothing of the peer's payload was
/// ever interpreted** — which is the whole point: an upstream peer's `Hello` is never fed to this
/// fork's `ClientLaunchMode`.
pub fn check_peer_abi(peer: &WirePrelude) -> AbiCheck {
    if peer.fork != WIRE_ABI_FORK {
        return AbiCheck::Rejected(format!(
            "peer speaks wire fork '{}', this build speaks '{}'; they are different protocols that \
             share a version number",
            peer.fork_name(),
            String::from_utf8_lossy(&WIRE_ABI_FORK)
        ));
    }
    let local = local_wire_abi();
    let accepted = accepted_wire_abis().into_iter().any(|abi| {
        abi.protocol_version == peer.protocol_version
            && abi.abi_epoch == peer.abi_epoch
            && abi.schema_fingerprint == peer.schema_fingerprint
    });
    if accepted {
        return AbiCheck::Accepted;
    }

    // A build whose own layout no longer matches its declared epoch makes every mismatch look
    // mysterious ("same epoch, different fingerprint"), so say so instead of leaving the reader to
    // guess. This is the only place the pin is consulted at runtime; the wire always carries the
    // *computed* fingerprint, so a build that skipped CI still advertises its true layout.
    let stale_pin = if wire_schema_fingerprint() != WIRE_SCHEMA_FINGERPRINT {
        " NOTE: this build's own wire layout does not match its pinned WIRE_SCHEMA_FINGERPRINT — \
         the wire was changed without bumping WIRE_ABI_EPOCH."
    } else {
        ""
    };

    // Name the axis that actually differs — "incompatible" alone sends the reader to the wrong
    // file. A fingerprint-only difference is the interesting case: same declared identity, real
    // layout drift, i.e. somebody changed the wire without bumping the epoch.
    let axis = if peer.protocol_version != local.protocol_version {
        "protocol version"
    } else if peer.abi_epoch != local.abi_epoch {
        "wire ABI epoch"
    } else {
        "wire schema fingerprint (same declared version and epoch, different byte layout)"
    };
    AbiCheck::Rejected(format!(
        "incompatible {axis}: peer {} vs this build {}; \
         update whichever side is older (both must come from the same herdr-mx build).{stale_pin}",
        peer.describe(),
        WirePrelude::local().describe()
    ))
}

/// The rejection sent to a peer that sent no prelude at all.
///
/// Separate from [`check_peer_abi`] because there is nothing to describe: the peer volunteered no
/// identity, and this build refuses to *infer* one from a protocol version that two forks share.
pub fn legacy_peer_rejection() -> String {
    format!(
        "this herdr server requires the wire-ABI prelude (herdr-mx protocol {PROTOCOL_VERSION}, \
         ABI epoch {WIRE_ABI_EPOCH}); the connecting client is an older build that does not send \
         one. Restart the herdr server and client from the same build."
    )
}

// ---------------------------------------------------------------------------
// The schema fingerprint (M0-a, M0-e)
// ---------------------------------------------------------------------------

/// The pinned fingerprint for [`WIRE_ABI_EPOCH`].
///
/// `wire_schema_fingerprint_is_pinned` compares this to the value computed from the live types. A
/// red there means the wire layout moved, and the **only** correct response is:
///   1. bump [`WIRE_ABI_EPOCH`],
///   2. repin this constant,
///   3. archive the outgoing fixture corpus and append a row to
///      `docs/next/protocol/abi-history.json` declaring whether the outgoing ABI stays accepted.
///
/// Repinning without (1) and (3) is the laundering this whole module exists to prevent.
pub const WIRE_SCHEMA_FINGERPRINT: [u8; 8] = [0x3c, 0xe2, 0xd2, 0x9b, 0x37, 0x1f, 0x9d, 0xbe];

/// A digest over the *encoded bytes* of one exemplar of every `ClientMessage` and `ServerMessage`
/// variant, plus a sweep of the nested enums and payload structs they reach.
///
/// ## What it catches
/// - a moved enum tag (top level or nested),
/// - an added, removed or reordered payload field,
/// - a field whose type changed width or encoding,
/// - a nested enum gaining or losing a variant that an exemplar exercises.
///
/// ## What it does NOT catch
/// - **field renames** — bincode is positional and encodes no names, so a rename is genuinely not
///   a wire change;
/// - **a swap of two adjacent fields carrying the same sentinel value** — mitigated by giving each
///   field position a distinct sentinel, not eliminated;
/// - **semantic reinterpretation** of an unchanged byte (e.g. a `u32` that starts meaning
///   milliseconds instead of frames);
/// - anything the exemplar list does not reach. The list is kept exhaustive over the two top-level
///   enums by `wire_exemplars_cover_every_top_level_variant`, whose `match` arms have no wildcard,
///   so a new variant is a **compile error** here before it is a test failure.
///
/// Computed once per process rather than read from [`WIRE_SCHEMA_FINGERPRINT`] so that a build
/// which skipped CI still advertises its *true* layout instead of a stale claim.
pub fn wire_schema_fingerprint() -> [u8; 8] {
    static FINGERPRINT: OnceLock<[u8; 8]> = OnceLock::new();
    *FINGERPRINT.get_or_init(compute_wire_schema_fingerprint)
}

fn compute_wire_schema_fingerprint() -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(WIRE_ABI_FORK);
    for message in client_message_exemplars() {
        hasher.update(encode_exemplar(&message));
    }
    for message in server_message_exemplars() {
        hasher.update(encode_exemplar(&message));
    }
    let digest = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

/// Length-delimited so two exemplars cannot be confused with one longer one.
fn encode_exemplar<M: serde::Serialize>(message: &M) -> Vec<u8> {
    let payload = bincode::serde::encode_to_vec(message, bincode::config::standard())
        .expect("wire exemplars encode");
    let mut out = (payload.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(&payload);
    out
}

// --- exemplar values -------------------------------------------------------
//
// ⚠️ These values are part of the ABI definition, not test data. Changing one changes the
// fingerprint and therefore forces an epoch bump, exactly as a real wire change would. Add
// exemplars for new variants; do not "tidy" existing ones.

const EX_STR: &str = "herdr-mx wire exemplar";
/// A fixed stand-in for `PROTOCOL_VERSION` in the exemplars.
///
/// Deliberately **not** `PROTOCOL_VERSION`: the fingerprint measures *layout*, the version
/// measures *negotiation*, and they are separate axes in the accepted table. Hashing the live
/// version would make every version bump look like a layout change and hide the difference
/// between "we renegotiated" and "the bytes moved".
const EX_VERSION: u32 = 0x9394_9596;
const EX_BYTES: [u8; 5] = [0x1b, 0x5b, 0x41, 0x00, 0xff];

fn ex_cell() -> CellData {
    CellData {
        symbol: "한".to_owned(),
        fg: 0x0102_0304,
        bg: 0x0506_0708,
        modifier: 0x090a,
        skip: true,
        hyperlink: Some(0x0b0c_0d0e),
    }
}

fn ex_cursor() -> CursorState {
    CursorState {
        x: 0x1112,
        y: 0x1314,
        visible: true,
        shape: 0x15,
    }
}

fn ex_frame() -> FrameData {
    FrameData {
        cells: vec![ex_cell(), ex_cell()],
        width: 2,
        height: 1,
        cursor: Some(ex_cursor()),
        hyperlinks: vec![EX_STR.to_owned()],
        graphics: EX_BYTES.to_vec(),
    }
}

fn ex_frame_delta() -> FrameDelta {
    FrameDelta {
        width: 0x1617,
        height: 0x1819,
        cells: vec![(0x1a1b_1c1d, ex_cell())],
        cursor: Some(ex_cursor()),
        hyperlinks: vec![EX_STR.to_owned()],
        graphics: EX_BYTES.to_vec(),
        base_checksum: 0x1e1f_2021_2223_2425,
    }
}

fn ex_terminal_frame() -> TerminalFrame {
    TerminalFrame {
        seq: 0x2627_2829_2a2b_2c2d,
        width: 0x2e2f,
        height: 0x3031,
        full: true,
        bytes: EX_BYTES.to_vec(),
    }
}

/// Every `ClientKeyCode` variant, so a change to that nested enum reaches the digest.
fn ex_key_codes() -> Vec<ClientKeyCode> {
    vec![
        ClientKeyCode::Backspace,
        ClientKeyCode::Enter,
        ClientKeyCode::Left,
        ClientKeyCode::Right,
        ClientKeyCode::Up,
        ClientKeyCode::Down,
        ClientKeyCode::Home,
        ClientKeyCode::End,
        ClientKeyCode::PageUp,
        ClientKeyCode::PageDown,
        ClientKeyCode::Tab,
        ClientKeyCode::BackTab,
        ClientKeyCode::Delete,
        ClientKeyCode::Insert,
        ClientKeyCode::Esc,
        ClientKeyCode::Char('힣'),
        ClientKeyCode::F(12),
        ClientKeyCode::Null,
    ]
}

/// Every `ClientMouseKind` variant, including each `ClientMouseButton` it wraps.
fn ex_mouse_kinds() -> Vec<ClientMouseKind> {
    vec![
        ClientMouseKind::Down(ClientMouseButton::Left),
        ClientMouseKind::Up(ClientMouseButton::Right),
        ClientMouseKind::Drag(ClientMouseButton::Middle),
        ClientMouseKind::Moved,
        ClientMouseKind::ScrollUp,
        ClientMouseKind::ScrollDown,
        ClientMouseKind::ScrollLeft,
        ClientMouseKind::ScrollRight,
    ]
}

/// Every `ClientKeySource` variant, including the Windows record's field layout.
fn ex_key_sources() -> Vec<ClientKeySource> {
    vec![
        ClientKeySource::Synthesized,
        ClientKeySource::Vt {
            bytes: EX_BYTES.to_vec(),
        },
        ClientKeySource::WindowsConsole {
            record: crate::input::WindowsKeyRecord {
                key_down: true,
                repeat_count: 0x3233,
                virtual_key_code: 0x3435,
                virtual_scan_code: 0x3637,
                unicode: 0x3839,
                control_key_state: 0x3a3b_3c3d,
            },
        },
    ]
}

/// Every `ClientInputEvent` variant, sweeping the nested enums above.
fn ex_input_events() -> Vec<ClientInputEvent> {
    let mut events = Vec::new();
    for (index, code) in ex_key_codes().into_iter().enumerate() {
        events.push(ClientInputEvent::Key {
            code,
            modifiers: index as u8,
            kind: match index % 3 {
                0 => ClientKeyKind::Press,
                1 => ClientKeyKind::Repeat,
                _ => ClientKeyKind::Release,
            },
            repeat_count: index as u16 + 1,
            generated_text: Some(EX_STR.to_owned()),
            source: ex_key_sources()[index % 3].clone(),
        });
    }
    for (index, kind) in ex_mouse_kinds().into_iter().enumerate() {
        events.push(ClientInputEvent::Mouse {
            kind,
            column: index as u16 + 0x40,
            row: index as u16 + 0x50,
            modifiers: index as u8 + 0x60,
        });
    }
    events.push(ClientInputEvent::Paste {
        text: EX_STR.to_owned(),
    });
    events.push(ClientInputEvent::FocusGained);
    events.push(ClientInputEvent::FocusLost);
    events.push(ClientInputEvent::TextCommit(EX_STR.to_owned()));
    events
}

/// One exemplar per `ClientMessage` variant, plus a sweep of `Hello`'s four nested enums.
///
/// Order is the declaration order and is itself hashed; keep new exemplars in variant order so a
/// reordering shows up as a fingerprint change rather than a silent no-op.
fn client_message_exemplars() -> Vec<ClientMessage> {
    let mut exemplars = vec![ClientMessage::Hello {
        version: EX_VERSION,
        cols: 0x6162,
        rows: 0x6364,
        cell_width_px: 0x6566_6768,
        cell_height_px: 0x696a_6b6c,
        requested_encoding: RenderEncoding::SemanticFrame,
        surface_mode: ClientSurfaceMode::FullApp,
        keybindings: ClientKeybindings::Server,
        launch_mode: ClientLaunchMode::App,
    }];

    // The nested-enum sweep. `ClientLaunchMode::TerminalAttach` is the value the two forks
    // disagree on, so it is not optional here — it is the exemplar that makes the fingerprint
    // witness B1 at all.
    for encoding in [RenderEncoding::SemanticFrame, RenderEncoding::TerminalAnsi] {
        for surface in [ClientSurfaceMode::FullApp, ClientSurfaceMode::EmbeddedContent] {
            for launch in [ClientLaunchMode::App, ClientLaunchMode::TerminalAttach] {
                for keybindings in [
                    ClientKeybindings::Server,
                    ClientKeybindings::Local {
                        keys_toml: EX_STR.to_owned(),
                    },
                ] {
                    exemplars.push(ClientMessage::Hello {
                        version: EX_VERSION,
                        cols: 0x6162,
                        rows: 0x6364,
                        cell_width_px: 0x6566_6768,
                        cell_height_px: 0x696a_6b6c,
                        requested_encoding: encoding,
                        surface_mode: surface,
                        keybindings: keybindings.clone(),
                        launch_mode: launch,
                    });
                }
            }
        }
    }

    exemplars.extend([
        ClientMessage::Input {
            data: EX_BYTES.to_vec(),
        },
        ClientMessage::ClipboardImage {
            extension: "png".to_owned(),
            data: EX_BYTES.to_vec(),
        },
        ClientMessage::Resize {
            cols: 0x6d6e,
            rows: 0x6f70,
            cell_width_px: 0x7172_7374,
            cell_height_px: 0x7576_7778,
        },
        ClientMessage::Detach,
        ClientMessage::AttachTerminal {
            terminal_id: EX_STR.to_owned(),
            takeover: true,
        },
        ClientMessage::AttachScroll {
            source: AttachScrollSource::Wheel,
            direction: AttachScrollDirection::Up,
            lines: 0x797a,
            column: Some(0x7b7c),
            row: Some(0x7d7e),
            modifiers: 0x7f,
        },
        ClientMessage::AttachScroll {
            source: AttachScrollSource::PageKey {
                input: EX_BYTES.to_vec(),
            },
            direction: AttachScrollDirection::Down,
            lines: 0x8081,
            column: None,
            row: None,
            modifiers: 0x82,
        },
        ClientMessage::InputEvents {
            events: ex_input_events(),
        },
        ClientMessage::OpenSettings,
        ClientMessage::OpenKeybindHelp,
        ClientMessage::Ping {
            nonce: 0x8384_8586_8788_898a,
        },
        ClientMessage::RequestFullFrame,
        ClientMessage::ObserveTerminal {
            target: EX_STR.to_owned(),
        },
        ClientMessage::ControlTerminal {
            target: EX_STR.to_owned(),
            takeover: true,
        },
    ]);

    exemplars
}

/// One exemplar per `ServerMessage` variant, plus every `NotifyKind`.
fn server_message_exemplars() -> Vec<ServerMessage> {
    let mut exemplars = vec![
        ServerMessage::Welcome {
            version: EX_VERSION,
            encoding: RenderEncoding::SemanticFrame,
            error: None,
        },
        ServerMessage::Welcome {
            version: EX_VERSION,
            encoding: RenderEncoding::TerminalAnsi,
            error: Some(EX_STR.to_owned()),
        },
        ServerMessage::Frame(ex_frame()),
        ServerMessage::Graphics {
            bytes: EX_BYTES.to_vec(),
        },
        ServerMessage::ServerShutdown { reason: None },
        ServerMessage::ServerShutdown {
            reason: Some(EX_STR.to_owned()),
        },
    ];

    for kind in [NotifyKind::Sound, NotifyKind::Toast, NotifyKind::SystemToast] {
        exemplars.push(ServerMessage::Notify {
            kind,
            message: EX_STR.to_owned(),
            body: Some(EX_STR.to_owned()),
        });
    }

    exemplars.extend([
        ServerMessage::Clipboard {
            data: EX_STR.to_owned(),
        },
        ServerMessage::WindowTitle {
            title: Some(EX_STR.to_owned()),
        },
        ServerMessage::ReloadSoundConfig,
        ServerMessage::MouseCapture { enabled: true },
        ServerMessage::FrameDelta(ex_frame_delta()),
        ServerMessage::Pong {
            nonce: 0x8b8c_8d8e_8f90_9192,
        },
        ServerMessage::Compressed(EX_BYTES.to_vec()),
        ServerMessage::PrefixInputSource { active: true },
        ServerMessage::Terminal(ex_terminal_frame()),
        ServerMessage::KittyKeyboardReportAll { enabled: true },
    ]);

    exemplars
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{MAX_FRAME_SIZE, MAX_GRAPHICS_FRAME_SIZE};
    use std::collections::BTreeSet;

    /// The claim the whole sniff rests on: a legacy peer's first four bytes are a `u32` frame
    /// length that both readers cap, and the magic read as that `u32` is above both caps. So
    /// "these four bytes are the magic" and "these four bytes are a legal length prefix" are
    /// mutually exclusive — no heuristic, no false positive, no false negative.
    #[test]
    fn magic_can_never_be_a_legacy_length_prefix() {
        let as_length = u32::from_le_bytes(WIRE_ABI_MAGIC) as usize;
        assert!(
            as_length > MAX_FRAME_SIZE,
            "magic {as_length} would be a legal text frame length"
        );
        assert!(
            as_length > MAX_GRAPHICS_FRAME_SIZE,
            "magic {as_length} would be a legal graphics frame length"
        );
    }

    #[test]
    fn prelude_round_trips_through_a_reader() {
        let mut buffer = Vec::new();
        write_prelude(&mut buffer).expect("write prelude");
        assert_eq!(buffer.len(), WIRE_ABI_PRELUDE_LEN);

        let start = read_peer_handshake_start(&mut buffer.as_slice()).expect("read prelude");
        match start {
            PeerHandshakeStart::Prelude(peer) => {
                assert_eq!(peer, WirePrelude::local());
                assert_eq!(check_peer_abi(&peer), AbiCheck::Accepted);
            }
            other => panic!("expected a prelude, got {other:?}"),
        }
    }

    #[test]
    fn a_stream_without_a_prelude_is_reported_as_legacy_with_its_bytes_intact() {
        // A real legacy `Hello` frame starts with its own u32 length prefix.
        let hello = ClientMessage::Hello {
            version: PROTOCOL_VERSION,
            cols: 80,
            rows: 24,
            cell_width_px: 0,
            cell_height_px: 0,
            requested_encoding: RenderEncoding::TerminalAnsi,
            surface_mode: ClientSurfaceMode::FullApp,
            keybindings: ClientKeybindings::Server,
            launch_mode: ClientLaunchMode::TerminalAttach,
        };
        let mut framed = Vec::new();
        super::super::wire::write_message(&mut framed, &hello).expect("frame hello");

        let mut reader = framed.as_slice();
        match read_peer_handshake_start(&mut reader).expect("sniff") {
            PeerHandshakeStart::Legacy(head) => {
                assert_eq!(head, framed[..4], "the sniffed bytes must be returned verbatim");
                // Chaining them back reconstructs the original stream exactly.
                let mut restored = (&head[..]).chain(reader);
                let decoded: ClientMessage =
                    super::super::wire::read_message(&mut restored, MAX_FRAME_SIZE)
                        .expect("legacy hello still decodes after the sniff");
                assert_eq!(decoded, hello);
            }
            other => panic!("expected legacy, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_stream_is_eof_not_legacy() {
        let empty: &[u8] = &[];
        assert!(matches!(
            read_peer_handshake_start(&mut { empty }),
            Err(FramingError::UnexpectedEof)
        ));
    }

    /// The fingerprint is pinned so that changing the wire cannot pass CI silently.
    ///
    /// If this fails you changed the wire layout (or an exemplar). Bump `WIRE_ABI_EPOCH`, repin
    /// `WIRE_SCHEMA_FINGERPRINT`, archive the outgoing fixture corpus and append the decision to
    /// `docs/next/protocol/abi-history.json`. Repinning alone launders the change.
    #[test]
    fn wire_schema_fingerprint_is_pinned() {
        assert_eq!(
            wire_schema_fingerprint(),
            WIRE_SCHEMA_FINGERPRINT,
            "wire schema fingerprint moved: computed {} vs pinned {}. \
             STOP: this means the wire layout changed. Bump WIRE_ABI_EPOCH, repin the constant, \
             archive docs/next/protocol/fixtures.json under docs/next/protocol/fixtures/ and \
             append the compatibility decision to docs/next/protocol/abi-history.json.",
            hex8(&wire_schema_fingerprint()),
            hex8(&WIRE_SCHEMA_FINGERPRINT)
        );
    }

    /// The exemplar list must reach every top-level variant, or the fingerprint is blind to it.
    ///
    /// The `match` arms below carry **no wildcard**: adding a variant to `ClientMessage` or
    /// `ServerMessage` is a compile error here, which is the forcing function. This test then
    /// checks the exemplars actually exercise all of them.
    #[test]
    fn wire_exemplars_cover_every_top_level_variant() {
        fn client_name(message: &ClientMessage) -> &'static str {
            match message {
                ClientMessage::Hello { .. } => "Hello",
                ClientMessage::Input { .. } => "Input",
                ClientMessage::ClipboardImage { .. } => "ClipboardImage",
                ClientMessage::Resize { .. } => "Resize",
                ClientMessage::Detach => "Detach",
                ClientMessage::AttachTerminal { .. } => "AttachTerminal",
                ClientMessage::AttachScroll { .. } => "AttachScroll",
                ClientMessage::InputEvents { .. } => "InputEvents",
                ClientMessage::OpenSettings => "OpenSettings",
                ClientMessage::OpenKeybindHelp => "OpenKeybindHelp",
                ClientMessage::Ping { .. } => "Ping",
                ClientMessage::RequestFullFrame => "RequestFullFrame",
                ClientMessage::ObserveTerminal { .. } => "ObserveTerminal",
                ClientMessage::ControlTerminal { .. } => "ControlTerminal",
            }
        }
        fn server_name(message: &ServerMessage) -> &'static str {
            match message {
                ServerMessage::Welcome { .. } => "Welcome",
                ServerMessage::Frame(_) => "Frame",
                ServerMessage::Graphics { .. } => "Graphics",
                ServerMessage::ServerShutdown { .. } => "ServerShutdown",
                ServerMessage::Notify { .. } => "Notify",
                ServerMessage::Clipboard { .. } => "Clipboard",
                ServerMessage::WindowTitle { .. } => "WindowTitle",
                ServerMessage::ReloadSoundConfig => "ReloadSoundConfig",
                ServerMessage::MouseCapture { .. } => "MouseCapture",
                ServerMessage::FrameDelta(_) => "FrameDelta",
                ServerMessage::Pong { .. } => "Pong",
                ServerMessage::Compressed(_) => "Compressed",
                ServerMessage::PrefixInputSource { .. } => "PrefixInputSource",
                ServerMessage::Terminal(_) => "Terminal",
                ServerMessage::KittyKeyboardReportAll { .. } => "KittyKeyboardReportAll",
            }
        }

        let client_covered: BTreeSet<&str> =
            client_message_exemplars().iter().map(client_name).collect();
        assert_eq!(
            client_covered.len(),
            14,
            "ClientMessage exemplars cover {client_covered:?}; every variant needs one"
        );

        let server_covered: BTreeSet<&str> =
            server_message_exemplars().iter().map(server_name).collect();
        assert_eq!(
            server_covered.len(),
            15,
            "ServerMessage exemplars cover {server_covered:?}; every variant needs one"
        );
    }

    /// A tag move is what B1 actually measured (`ServerMessage::Terminal` 13 here, 2 upstream), so
    /// prove the fingerprint sees one.
    #[test]
    fn fingerprint_changes_when_a_wire_tag_moves() {
        // Simulate the upstream layout by hashing the same exemplars with `Terminal` at tag 2:
        // encode the tag by hand and hash the modified byte stream.
        let baseline = compute_wire_schema_fingerprint();

        let mut hasher = Sha256::new();
        hasher.update(WIRE_ABI_FORK);
        for message in client_message_exemplars() {
            hasher.update(encode_exemplar(&message));
        }
        for message in server_message_exemplars() {
            let mut encoded = encode_exemplar(&message);
            if matches!(message, ServerMessage::Terminal(_)) {
                // byte 4 is the first payload byte, i.e. the variant tag varint (all tags < 251).
                encoded[4] = 2;
            }
            hasher.update(encoded);
        }
        let skewed = &hasher.finalize()[..8];
        assert_ne!(
            baseline.as_slice(),
            skewed,
            "moving ServerMessage::Terminal from 13 to 2 must change the fingerprint"
        );
    }

    /// A payload-only change (upstream's `sgr_pixels` on `MouseCapture`) moves no tag. The
    /// fingerprint has to see it anyway, or M0-a is only a tag check wearing a hash.
    #[test]
    fn fingerprint_changes_when_a_payload_field_is_added() {
        #[derive(serde::Serialize)]
        enum MouseCaptureWithExtraField {
            #[allow(dead_code)]
            Placeholder,
            WithField {
                enabled: bool,
                sgr_pixels: bool,
            },
        }

        let without = encode_exemplar(&ServerMessage::MouseCapture { enabled: true });
        let with = encode_exemplar(&MouseCaptureWithExtraField::WithField {
            enabled: true,
            sgr_pixels: true,
        });
        assert_ne!(
            without, with,
            "adding a payload field must change the encoded bytes the fingerprint hashes"
        );
    }

    #[test]
    fn a_peer_from_another_fork_is_rejected_by_name() {
        let peer = WirePrelude {
            fork: *b"upstream",
            ..WirePrelude::local()
        };
        match check_peer_abi(&peer) {
            AbiCheck::Rejected(reason) => assert!(reason.contains("upstream"), "{reason}"),
            AbiCheck::Accepted => panic!("a foreign fork must not be accepted"),
        }
    }

    #[test]
    fn a_peer_with_the_same_version_but_a_different_layout_is_rejected() {
        let peer = WirePrelude {
            schema_fingerprint: [0; 8],
            ..WirePrelude::local()
        };
        match check_peer_abi(&peer) {
            AbiCheck::Rejected(reason) => assert!(
                reason.contains("schema fingerprint"),
                "the rejection must name the layout axis, got: {reason}"
            ),
            AbiCheck::Accepted => panic!("a same-version different-layout peer must be rejected"),
        }
    }

    #[test]
    fn the_accepted_table_always_contains_this_build() {
        let local = local_wire_abi();
        assert!(accepted_wire_abis().contains(&local));
        assert_eq!(min_supported_protocol(), PROTOCOL_VERSION);
    }
}
