import { describe, expect, it } from "vitest";
import {
  ClientLaunchMode,
  DEFAULT_MAX_FRAME_SIZE,
  FrameReader,
  OversizedFrameError,
  RenderEncoding,
  ServerMessageReader,
  UnsupportedVariantError,
  encodeHello,
  frameMessage,
} from "../src/index.js";
import { frameHex, fromHex, toHex } from "./helpers.js";
import { TERMINAL_SMALL_FULL, WELCOME_OK_ANSI } from "./vectors.js";

const WELCOME_FRAME = fromHex(frameHex(WELCOME_OK_ANSI));
const TERMINAL_FRAME = fromHex(frameHex(TERMINAL_SMALL_FULL));

describe("frameMessage", () => {
  it("prefixes the payload with its length as u32 LE", () => {
    expect(toHex(frameMessage(fromHex("00140100")))).toBe("0400000000140100");
    expect(toHex(frameMessage(new Uint8Array(0)))).toBe("00000000");
    // 300-byte payload -> 2c 01 00 00
    expect(toHex(frameMessage(new Uint8Array(300))).slice(0, 8)).toBe("2c010000");
  });

  it("round-trips through FrameReader", () => {
    const payload = encodeHello({
      cols: 80,
      rows: 24,
      requestedEncoding: RenderEncoding.TerminalAnsi,
      launchMode: ClientLaunchMode.TerminalAttach,
    });
    const [decoded] = new FrameReader().push(frameMessage(payload));
    expect(toHex(decoded!)).toBe(toHex(payload));
  });
});

describe("FrameReader", () => {
  it("emits exactly one frame when fed one byte at a time", () => {
    const reader = new FrameReader();
    const emitted: Uint8Array[] = [];
    for (let i = 0; i < WELCOME_FRAME.length; i += 1) {
      const frames = reader.push(WELCOME_FRAME.subarray(i, i + 1));
      emitted.push(...frames);
      if (i < WELCOME_FRAME.length - 1) {
        expect(frames, `byte ${i} should not complete the frame`).toHaveLength(0);
        expect(reader.hasPartialFrame).toBe(true);
      }
    }
    expect(emitted).toHaveLength(1);
    expect(toHex(emitted[0]!)).toBe(WELCOME_OK_ANSI);
    expect(reader.hasPartialFrame).toBe(false);
    expect(reader.bufferedBytes).toBe(0);
  });

  it("emits both frames when two arrive glued in one chunk", () => {
    const glued = new Uint8Array(WELCOME_FRAME.length + TERMINAL_FRAME.length);
    glued.set(WELCOME_FRAME, 0);
    glued.set(TERMINAL_FRAME, WELCOME_FRAME.length);

    const frames = new FrameReader().push(glued);
    expect(frames).toHaveLength(2);
    expect(toHex(frames[0]!)).toBe(WELCOME_OK_ANSI);
    expect(toHex(frames[1]!)).toBe(TERMINAL_SMALL_FULL);
  });

  it("emits the whole frames in a chunk and holds the trailing partial one", () => {
    const glued = new Uint8Array(WELCOME_FRAME.length + 5);
    glued.set(WELCOME_FRAME, 0);
    glued.set(TERMINAL_FRAME.subarray(0, 5), WELCOME_FRAME.length);

    const reader = new FrameReader();
    expect(reader.push(glued)).toHaveLength(1);
    expect(reader.hasPartialFrame).toBe(true);
    expect(reader.bufferedBytes).toBe(5);

    const rest = reader.push(TERMINAL_FRAME.subarray(5));
    expect(rest).toHaveLength(1);
    expect(toHex(rest[0]!)).toBe(TERMINAL_SMALL_FULL);
    expect(reader.hasPartialFrame).toBe(false);
  });

  it("leaves a truncated stream pending instead of erroring", () => {
    const reader = new FrameReader();
    expect(reader.push(TERMINAL_FRAME.subarray(0, 3))).toHaveLength(0); // partial length prefix
    expect(reader.hasPartialFrame).toBe(true);
    expect(reader.push(TERMINAL_FRAME.subarray(3, 9))).toHaveLength(0); // partial payload
    expect(reader.bufferedBytes).toBe(9);
    expect(reader.push(new Uint8Array(0))).toHaveLength(0); // an empty chunk changes nothing
    expect(reader.hasPartialFrame).toBe(true);
  });

  it("tolerates a zero-length frame", () => {
    const frames = new FrameReader().push(fromHex("00000000"));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.length).toBe(0);
  });

  it("rejects an oversized length prefix and stays poisoned", () => {
    const reader = new FrameReader({ maxFrameSize: 1024 });
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 4096, true);

    let thrown: unknown;
    try {
      reader.push(header);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OversizedFrameError);
    expect((thrown as OversizedFrameError).claimed).toBe(4096);
    expect((thrown as OversizedFrameError).max).toBe(1024);

    // The stream is desynchronized: later pushes must not pretend to resync.
    expect(() => reader.push(WELCOME_FRAME)).toThrow(OversizedFrameError);
    reader.reset();
    expect(reader.push(WELCOME_FRAME)).toHaveLength(1);
  });

  it("hands back frames decoded before the oversized one", () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 9_000_000, true);
    const chunk = new Uint8Array(WELCOME_FRAME.length + 4);
    chunk.set(WELCOME_FRAME, 0);
    chunk.set(header, WELCOME_FRAME.length);

    try {
      new FrameReader().push(chunk);
      expect.unreachable("expected an OversizedFrameError");
    } catch (error) {
      expect(error).toBeInstanceOf(OversizedFrameError);
      expect((error as OversizedFrameError).decodedBefore).toHaveLength(1);
    }
  });

  it("defaults to an 8 MiB ceiling", () => {
    expect(DEFAULT_MAX_FRAME_SIZE).toBe(8 * 1024 * 1024);
  });
});

describe("ServerMessageReader", () => {
  it("decodes messages across chunk boundaries", () => {
    const reader = new ServerMessageReader();
    const stream = new Uint8Array(WELCOME_FRAME.length + TERMINAL_FRAME.length);
    stream.set(WELCOME_FRAME, 0);
    stream.set(TERMINAL_FRAME, WELCOME_FRAME.length);

    const messages = [];
    for (let i = 0; i < stream.length; i += 3) {
      messages.push(...reader.push(stream.subarray(i, i + 3)));
    }
    expect(messages.map((m) => m.type)).toEqual(["welcome", "terminal"]);
    expect(reader.hasPartialFrame).toBe(false);
  });

  it("names an undecodable variant instead of dropping the frame", () => {
    // Variant 11 = ServerMessage::Compressed, which this codec does not inflate.
    const compressed = fromHex(frameHex("0b03aabbcc"));
    const chunk = new Uint8Array(WELCOME_FRAME.length + compressed.length);
    chunk.set(WELCOME_FRAME, 0);
    chunk.set(compressed, WELCOME_FRAME.length);

    const reader = new ServerMessageReader();
    try {
      reader.push(chunk);
      expect.unreachable("expected an UnsupportedVariantError");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedVariantError);
      expect((error as UnsupportedVariantError).variant).toBe(11);
      expect((error as UnsupportedVariantError).variantName).toBe("Compressed");
      expect((error as UnsupportedVariantError).decodedBefore).toHaveLength(1);
    }

    // The bad frame was consumed, so the stream stays in sync.
    expect(reader.push(TERMINAL_FRAME).map((m) => m.type)).toEqual(["terminal"]);
  });
});
