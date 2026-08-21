import { describe, expect, it } from "vitest";
import { CorruptError, decodeServerMessage, decodeTerminal } from "../src/index.js";
import { fromHex, toHex } from "./helpers.js";
import { TERMINAL_SEQ_U64, TERMINAL_SEQ_VARINT_U16, TERMINAL_SMALL_FULL } from "./vectors.js";

describe("ServerMessage::Terminal decode", () => {
  it("decodes a small full redraw", () => {
    // 0d variant 13 | 01 seq=1 | 64 width=100 | 1e height=30 | 01 full=true | 0a len=10 | bytes
    const message = decodeTerminal(fromHex(TERMINAL_SMALL_FULL));
    expect(message.type).toBe("terminal");
    expect(message.seq).toBe(1n);
    expect(message.width).toBe(100);
    expect(message.height).toBe(30);
    expect(message.full).toBe(true);
    expect(toHex(message.bytes)).toBe("1b5b324a1b5b313b3148");
    expect(message.bytes.length).toBe(10);
  });

  it("decodes fields sitting exactly on the 251 varint marker", () => {
    const message = decodeTerminal(fromHex(TERMINAL_SEQ_VARINT_U16));
    expect(message.seq).toBe(251n);
    expect(message.width).toBe(251);
    expect(message.height).toBe(65535);
    expect(message.full).toBe(false);
    expect(message.bytes.length).toBe(0);
  });

  it("keeps a u64 seq exact and reads a multi-byte-length payload", () => {
    const message = decodeTerminal(fromHex(TERMINAL_SEQ_U64));
    expect(message.seq).toBe(4294967296n); // 2^32: past the u32 varint marker
    expect(typeof message.seq).toBe("bigint");
    expect(message.width).toBe(80);
    expect(message.height).toBe(24);
    expect(message.bytes.length).toBe(300);
    expect(message.bytes.every((b) => b === 0xaa)).toBe(true);
  });

  it("survives a seq beyond Number.MAX_SAFE_INTEGER", () => {
    // 0d | fd + u64 LE of 2^64-1 | 50 width | 18 height | 00 full | 00 empty bytes
    const message = decodeTerminal(fromHex("0dfdffffffffffffffff50180000"));
    expect(message.seq).toBe(18446744073709551615n);
  });

  it("decodes a 100 KB frame", () => {
    const payloadBytes = 100_000;
    // 100000 = 0x000186a0 -> varint 252 marker + a0 86 01 00 (LE).
    const header = "0d" + "01" + "fb2c01" + "fb2c01" + "01" + "fc" + "a0860100";
    const message = decodeTerminal(fromHex(header + "5a".repeat(payloadBytes)));
    expect(message.width).toBe(300);
    expect(message.height).toBe(300);
    expect(message.full).toBe(true);
    expect(message.bytes.length).toBe(payloadBytes);
    expect(message.bytes[0]).toBe(0x5a);
    expect(message.bytes[payloadBytes - 1]).toBe(0x5a);
  });

  it("returns a copy, not a view onto the frame buffer", () => {
    const frame = fromHex(TERMINAL_SMALL_FULL);
    const message = decodeTerminal(frame);
    frame[6] = 0x00;
    expect(message.bytes[0]).toBe(0x1b);
  });

  it("rejects a bool byte that is not 0 or 1", () => {
    expect(() => decodeTerminal(fromHex("0d01641e020a1b5b324a1b5b313b3148"))).toThrow(CorruptError);
  });

  it("treats a byte-vector shorter than its declared length as corrupt", () => {
    expect(() => decodeTerminal(fromHex("0d01641e010a1b5b324a"))).toThrow(CorruptError);
  });

  it("rejects a width above u16::MAX", () => {
    // width encoded as 252-marker u32 = 70000, which cannot be a u16 field.
    expect(() => decodeTerminal(fromHex("0d01fc70110100" + "1e010a" + "1b".repeat(10)))).toThrow(
      CorruptError,
    );
  });

  it("dispatches by variant through decodeServerMessage", () => {
    expect(decodeServerMessage(fromHex(TERMINAL_SMALL_FULL)).type).toBe("terminal");
  });

  it("refuses to read a Welcome as a Terminal", () => {
    expect(() => decodeTerminal(fromHex("00140100"))).toThrow(CorruptError);
  });
});
