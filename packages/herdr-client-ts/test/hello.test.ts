import { describe, expect, it } from "vitest";
import {
  ClientLaunchMode,
  ClientSurfaceMode,
  FieldRangeError,
  PROTOCOL_VERSION,
  RenderEncoding,
  encodeHello,
  encodeHelloFrame,
} from "../src/index.js";
import { frameHex, toHex } from "./helpers.js";
import {
  HELLO_ANSI_ATTACH_300X100,
  HELLO_ANSI_ATTACH_65535_NO_CELLPX_V21,
  HELLO_SEMANTIC_APP_80X24,
  HELLO_SEMANTIC_APP_80X24_V21,
} from "./vectors.js";

describe("ClientMessage::Hello encode", () => {
  /**
   * Hand derivation of `HELLO_SEMANTIC_APP_80X24`, matching what
   * `tests/support/mod.rs::client_handshake_with(_, 20, 80, 24, 0, 0)` builds:
   *   00  variant 0            (ClientMessage::Hello)
   *   14  version      = 20
   *   50  cols         = 80
   *   18  rows         = 24
   *   08  cell_width_px  = 8   (the Rust harness hardcodes 8)
   *   10  cell_height_px = 16  (the Rust harness hardcodes 16)
   *   00  requested_encoding = RenderEncoding::SemanticFrame
   *   00  surface_mode       = ClientSurfaceMode::FullApp
   *   00  keybindings        = ClientKeybindings::Server
   *   00  launch_mode        = ClientLaunchMode::App
   */
  it("reproduces the Rust harness handshake byte for byte", () => {
    const payload = encodeHello({
      version: 20,
      cols: 80,
      rows: 24,
      cellWidthPx: 8,
      cellHeightPx: 16,
      requestedEncoding: RenderEncoding.SemanticFrame,
      launchMode: ClientLaunchMode.App,
    });
    expect(toHex(payload)).toBe(HELLO_SEMANTIC_APP_80X24);
    expect(toHex(payload)).toBe("00145018081000000000");
    expect(payload.length).toBe(10);
  });

  it("encodes the mobile handshake (TerminalAnsi + TerminalAttach) with multi-byte cols", () => {
    const payload = encodeHello({
      version: 20,
      cols: 300,
      rows: 100,
      cellWidthPx: 8,
      cellHeightPx: 16,
      requestedEncoding: RenderEncoding.TerminalAnsi,
      launchMode: ClientLaunchMode.TerminalAttach,
    });
    // cols = 300 crosses the 251 marker: fb 2c 01.
    expect(toHex(payload)).toBe(HELLO_ANSI_ATTACH_300X100);
  });

  it("defaults version to PROTOCOL_VERSION and cell pixels to 0", () => {
    const payload = encodeHello({
      cols: 65535,
      rows: 65535,
      requestedEncoding: RenderEncoding.TerminalAnsi,
      launchMode: ClientLaunchMode.TerminalAttach,
    });
    // The default is the CURRENT version, so this vector moves with `src/protocol/wire.rs`; the
    // explicit-version tests above keep the version-20 bytes pinned separately.
    expect(PROTOCOL_VERSION).toBe(21);
    expect(toHex(payload)).toBe(HELLO_ANSI_ATTACH_65535_NO_CELLPX_V21);
  });

  it("defaults surface_mode to FullApp and keybindings to Server", () => {
    const explicit = encodeHello({
      cols: 80,
      rows: 24,
      cellWidthPx: 8,
      cellHeightPx: 16,
      requestedEncoding: RenderEncoding.SemanticFrame,
      launchMode: ClientLaunchMode.App,
      surfaceMode: ClientSurfaceMode.FullApp,
    });
    expect(toHex(explicit)).toBe(HELLO_SEMANTIC_APP_80X24_V21);
  });

  it("frames the payload with a u32 LE length prefix", () => {
    const framed = encodeHelloFrame({
      version: 20,
      cols: 80,
      rows: 24,
      cellWidthPx: 8,
      cellHeightPx: 16,
      requestedEncoding: RenderEncoding.SemanticFrame,
      launchMode: ClientLaunchMode.App,
    });
    expect(toHex(framed)).toBe("0a00000000145018081000000000");
    expect(toHex(framed)).toBe(frameHex(HELLO_SEMANTIC_APP_80X24));
  });

  it("rejects field values that do not fit their Rust type", () => {
    const base = {
      cols: 80,
      rows: 24,
      requestedEncoding: RenderEncoding.TerminalAnsi,
      launchMode: ClientLaunchMode.TerminalAttach,
    } as const;
    expect(() => encodeHello({ ...base, cols: 65536 })).toThrow(FieldRangeError);
    expect(() => encodeHello({ ...base, rows: -1 })).toThrow(FieldRangeError);
    expect(() => encodeHello({ ...base, cols: 80.5 })).toThrow(FieldRangeError);
    expect(() => encodeHello({ ...base, cellWidthPx: 4294967296 })).toThrow(FieldRangeError);
    expect(() => encodeHello({ ...base, version: -1 })).toThrow(FieldRangeError);
  });
});
