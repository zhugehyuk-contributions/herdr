import { describe, expect, it } from "vitest";
import {
  ClientMessageTag,
  encodeObserveTerminal,
  encodeObserveTerminalFrame,
  utf8Encode,
} from "../src/index.js";
import { frameHex, toHex } from "./helpers.js";
import {
  OBSERVE_TERMINAL_EMPTY,
  OBSERVE_TERMINAL_LEN_250,
  OBSERVE_TERMINAL_LEN_251,
  OBSERVE_TERMINAL_UTF8,
  OBSERVE_TERMINAL_UTF8_TEXT,
  OBSERVE_TERMINAL_W1_P1,
} from "./vectors.js";

describe("ClientMessage::ObserveTerminal encode", () => {
  /**
   * Hand derivation of `OBSERVE_TERMINAL_W1_P1`, matching what
   * `tests/support/mod.rs::send_observe_terminal(_, "w1:p1")` builds
   * (`encode_varint_u32(12) ++ encode_varint_u32(target.len()) ++ target.as_bytes()`):
   *   0c              variant 12 (ClientMessage::ObserveTerminal, src/protocol/wire.rs:471)
   *   05              target length = 5 BYTES
   *   77 31 3a 70 31  "w1:p1"
   */
  it("reproduces the Rust harness observe message byte for byte", () => {
    const payload = encodeObserveTerminal("w1:p1");
    expect(toHex(payload)).toBe(OBSERVE_TERMINAL_W1_P1);
    expect(toHex(payload)).toBe("0c0577313a7031");
    expect(payload.length).toBe(7);
    expect(payload[0]).toBe(ClientMessageTag.ObserveTerminal);
    expect(ClientMessageTag.ObserveTerminal).toBe(12);
  });

  /**
   * `ObserveTerminal` has exactly ONE field (`src/protocol/wire.rs:471-474`); its neighbour
   * `ControlTerminal` (`:477-482`) is the same `target` plus `takeover: bool`. Encoding the
   * two-field shape would append a trailing byte the server decodes as the next message.
   */
  it("emits exactly tag + length + bytes, with no trailing takeover flag", () => {
    for (const target of ["", "w1:p1", OBSERVE_TERMINAL_UTF8_TEXT, "a".repeat(251)]) {
      const byteLen = utf8Encode(target).length;
      const lengthVarintBytes = byteLen < 251 ? 1 : 3;
      expect(encodeObserveTerminal(target).length, `target ${JSON.stringify(target)}`).toBe(
        1 + lengthVarintBytes + byteLen,
      );
    }
  });

  it("encodes an empty target as a length varint, not a bare tag", () => {
    const payload = encodeObserveTerminal("");
    expect(toHex(payload)).toBe(OBSERVE_TERMINAL_EMPTY);
    expect(toHex(payload)).toBe("0c00");
  });

  it("counts the target length in UTF-8 bytes, not characters", () => {
    const payload = encodeObserveTerminal(OBSERVE_TERMINAL_UTF8_TEXT);
    expect(toHex(payload)).toBe(OBSERVE_TERMINAL_UTF8);
    // 6 characters, 16 bytes: the length byte is 0x10, and a char-counting encoder would emit 0x06.
    expect(OBSERVE_TERMINAL_UTF8_TEXT.length).toBe(6);
    expect(payload[1]).toBe(16);
    expect(payload.length).toBe(18);
  });

  it("switches the length to the u16 marker at the 251-byte boundary", () => {
    const at250 = encodeObserveTerminal("a".repeat(250));
    expect(toHex(at250)).toBe(OBSERVE_TERMINAL_LEN_250);
    expect(at250[1]).toBe(250); // single-byte varint, still below the 251 marker

    const at251 = encodeObserveTerminal("a".repeat(251));
    expect(toHex(at251)).toBe(OBSERVE_TERMINAL_LEN_251);
    expect(at251[1]).toBe(251); // VARINT_U16_MARKER
    expect(toHex(at251.subarray(0, 4))).toBe("0cfbfb00");
  });

  it("frames the payload with a u32 LE length prefix", () => {
    const framed = encodeObserveTerminalFrame("w1:p1");
    expect(toHex(framed)).toBe("070000000c0577313a7031");
    expect(toHex(framed)).toBe(frameHex(OBSERVE_TERMINAL_W1_P1));
  });
});
