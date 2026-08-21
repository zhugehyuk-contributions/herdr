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
 */

export const HELLO_SEMANTIC_APP_80X24 = "00145018081000000000";
export const HELLO_ANSI_ATTACH_300X100 = "0014fb2c0164081001000001";
export const HELLO_ANSI_ATTACH_65535_NO_CELLPX = "0014fbfffffbffff000001000001";

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
