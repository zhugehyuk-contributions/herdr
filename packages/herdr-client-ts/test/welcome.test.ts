import { describe, expect, it } from "vitest";
import {
  CorruptError,
  EncodingMismatchError,
  HandshakeRejectedError,
  ProtocolVersionMismatchError,
  RenderEncoding,
  assertWelcomeAccepted,
  decodeWelcome,
} from "../src/index.js";
import { fromHex } from "./helpers.js";
import {
  WELCOME_ERROR,
  WELCOME_ERROR_TEXT,
  WELCOME_ERROR_UTF8,
  WELCOME_ERROR_UTF8_TEXT,
  WELCOME_OK_ANSI,
  WELCOME_OK_SEMANTIC,
} from "./vectors.js";

describe("ServerMessage::Welcome decode", () => {
  it("decodes an accepted TerminalAnsi handshake", () => {
    // 00 variant | 14 version=20 | 01 encoding=TerminalAnsi | 00 Option::None
    expect(decodeWelcome(fromHex(WELCOME_OK_ANSI))).toEqual({
      type: "welcome",
      version: 20,
      encoding: RenderEncoding.TerminalAnsi,
      error: null,
    });
  });

  it("decodes an accepted SemanticFrame handshake", () => {
    expect(decodeWelcome(fromHex(WELCOME_OK_SEMANTIC))).toEqual({
      type: "welcome",
      version: 20,
      encoding: RenderEncoding.SemanticFrame,
      error: null,
    });
  });

  it("decodes error: Some(_) including non-ASCII text", () => {
    expect(decodeWelcome(fromHex(WELCOME_ERROR)).error).toBe(WELCOME_ERROR_TEXT);
    expect(decodeWelcome(fromHex(WELCOME_ERROR_UTF8)).error).toBe(WELCOME_ERROR_UTF8_TEXT);
  });

  it("treats a truncated payload as corrupt (the frame said it was complete)", () => {
    expect(() => decodeWelcome(fromHex("001401"))).toThrow(CorruptError);
    expect(() => decodeWelcome(fromHex("0014000105616263"))).toThrow(CorruptError); // len 5, 3 bytes
  });

  it("rejects trailing bytes after the message", () => {
    expect(() => decodeWelcome(fromHex(WELCOME_OK_ANSI + "00"))).toThrow(CorruptError);
  });

  it("rejects an Option tag that is neither 0 nor 1", () => {
    expect(() => decodeWelcome(fromHex("00140102"))).toThrow(CorruptError);
  });

  it("rejects invalid UTF-8 in the error string", () => {
    // Option::Some, length 2, 0xff 0xfe is not valid UTF-8.
    expect(() => decodeWelcome(fromHex("0014000102fffe"))).toThrow(CorruptError);
  });
});

describe("assertWelcomeAccepted", () => {
  const accepted = { type: "welcome" as const, version: 20, encoding: 1, error: null };

  it("passes when the server confirms what we asked for", () => {
    expect(() =>
      assertWelcomeAccepted(accepted, { version: 20, encoding: RenderEncoding.TerminalAnsi }),
    ).not.toThrow();
  });

  it("rejects a downgraded encoding — the whole point of Welcome.encoding", () => {
    const downgraded = decodeWelcome(fromHex(WELCOME_OK_SEMANTIC));
    let thrown: unknown;
    try {
      assertWelcomeAccepted(downgraded, { version: 20, encoding: RenderEncoding.TerminalAnsi });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EncodingMismatchError);
    const mismatch = thrown as EncodingMismatchError;
    expect(mismatch.code).toBe("encoding-mismatch");
    expect(mismatch.requested).toBe(RenderEncoding.TerminalAnsi);
    expect(mismatch.selected).toBe(RenderEncoding.SemanticFrame);
    expect(mismatch.message).toContain("SemanticFrame");
    expect(mismatch.message).toContain("TerminalAnsi");
  });

  it("surfaces a server-side rejection before anything else", () => {
    const rejected = decodeWelcome(fromHex(WELCOME_ERROR));
    let thrown: unknown;
    try {
      assertWelcomeAccepted(rejected, { version: 20, encoding: RenderEncoding.SemanticFrame });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HandshakeRejectedError);
    expect((thrown as HandshakeRejectedError).serverError).toBe(WELCOME_ERROR_TEXT);
  });

  it("rejects a protocol version that is not exactly ours", () => {
    expect(() =>
      assertWelcomeAccepted(
        { ...accepted, version: 19 },
        { version: 20, encoding: RenderEncoding.TerminalAnsi },
      ),
    ).toThrow(ProtocolVersionMismatchError);
  });
});
