/**
 * Golden wire vectors.
 *
 * PROVENANCE: every hex string below was produced by real `bincode` v2 with
 * `bincode::config::standard()` — not by hand and not by this codec. The generator is checked in
 * at `tools/gen-vectors.rs`; it declares mirrors of the `src/protocol/wire.rs` types with the same
 * variant ordinals and field order (bincode's output depends on nothing else) and prints
 * `payload`/`framed` hex. Run it with the recipe in that file's header to regenerate.
 *
 * The `hello_*` vectors were additionally reconciled against the Rust integration harness
 * `tests/support/mod.rs::client_handshake_with`, which hand-builds the same message:
 * `encode_varint_enum(0, [version, cols, rows, cell_width_px=8, cell_height_px=16,
 * requested_encoding, 0 (FullApp), 0 (Server), launch_mode])`. Its output for
 * `(version=20, cols=80, rows=24, encoding=0, launch=0)` is `00 14 50 18 08 10 00 00 00 00`,
 * byte-identical to `HELLO_SEMANTIC_APP_80X24`.
 *
 * `OBSERVE_TERMINAL_W1_P1` was likewise reconciled against
 * `tests/support/mod.rs::send_observe_terminal(stream, "w1:p1")`, which builds
 * `encode_varint_u32(12) ++ encode_varint_u32(target.len()) ++ target.as_bytes()`. Note
 * `str::len()` is the BYTE length, which is why the UTF-8 vector below is the load-bearing one.
 */

export const HELLO_SEMANTIC_APP_80X24 = "00145018081000000000";
export const HELLO_ANSI_ATTACH_300X100 = "0014fb2c0164081001000001";
export const HELLO_ANSI_ATTACH_65535_NO_CELLPX = "0014fbfffffbffff000001000001";

/** `ClientMessage::ObserveTerminal { target: "w1:p1" }` — tag 0x0c, len 0x05, then the ASCII. */
export const OBSERVE_TERMINAL_W1_P1 = "0c0577313a7031";
/** An empty target still costs the length varint: `0c 00`, never a bare tag. */
export const OBSERVE_TERMINAL_EMPTY = "0c00";
/** "한글:터미널" — 6 chars but 0x10 = 16 bytes; the varint counts bytes. */
export const OBSERVE_TERMINAL_UTF8 = "0c10ed959ceab8803aed84b0ebafb8eb8490";
export const OBSERVE_TERMINAL_UTF8_TEXT = "한글:터미널";
/** 250 × "a": the last length that fits in a single varint byte (0xfa). */
export const OBSERVE_TERMINAL_LEN_250 = "0cfa" + "61".repeat(250);
/** 251 × "a": one byte longer, so the length switches to the 0xfb u16 marker. */
export const OBSERVE_TERMINAL_LEN_251 = "0cfbfb00" + "61".repeat(251);

export const WELCOME_OK_ANSI = "00140100";
export const WELCOME_OK_SEMANTIC = "00140000";
export const WELCOME_ERROR =
  "0014000131636c69656e742076657273696f6e203139206973206f6c646572207468616e" +
  "207365727665722076657273696f6e203230";
export const WELCOME_ERROR_TEXT = "client version 19 is older than server version 20";
export const WELCOME_ERROR_UTF8 = "0014000112eab1b0ebb6803a20ed959ceab88020e29c85";
export const WELCOME_ERROR_UTF8_TEXT = "거부: 한글 ✅";

export const TERMINAL_SMALL_FULL = "0d01641e010a1b5b324a1b5b313b3148";
export const TERMINAL_SEQ_VARINT_U16 = "0dfbfb00fbfb00fbffff0000";
/** seq = 2^32 (needs the 253/u64 marker), 300 payload bytes (needs the 251/u16 length marker). */
export const TERMINAL_SEQ_U64 =
  "0dfd0000000001000000501800fb2c01" + "aa".repeat(300);

/** Bare `u64` values encoded by bincode, for varint boundary checks. */
export const VARINT_U64_VECTORS: ReadonlyArray<readonly [bigint, string]> = [
  [0n, "00"],
  [250n, "fa"],
  [251n, "fbfb00"],
  [65535n, "fbffff"],
  [65536n, "fc00000100"],
  [4294967295n, "fcffffffff"],
  [4294967296n, "fd0000000001000000"],
  [18446744073709551615n, "fdffffffffffffffff"],
];
