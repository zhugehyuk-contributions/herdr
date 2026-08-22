/**
 * The wire-ABI gate (`src/abi.ts`), from the client's side.
 *
 * ## What is actually under test
 *
 * Not "does a mismatch produce an error" — that is easy and was already half-true via
 * `WireLayoutProbe`. The claim is an **ordering** claim: the refusal happens *before any
 * `ServerMessage` is decoded*, so an unidentified peer never gets a frame interpreted. That is why
 * the assertions below are as much about what did **not** happen (`got.messages` empty,
 * `undecodableCount` still 0, nothing written back) as about the error that did.
 *
 * The failure this prevents is on record in `mobile/.prd/03-blockers.md` B1: herdr-mx and
 * upstream/master both shipped `PROTOCOL_VERSION = 20` while disagreeing on
 * `ServerMessage::Terminal` (13 vs 2), so the handshake went green against the wrong peer and every
 * frame afterwards was silently mis-classified — "connected, green, black screen, zero errors".
 */
import { describe, expect, it } from "vitest";

import {
  AbiMismatchError,
  HerdrChannelKind,
  LOCAL_WIRE_ABI,
  PROTOCOL_VERSION,
  RUST_MAX_FRAME_SIZE,
  RUST_MAX_GRAPHICS_FRAME_SIZE,
  ServerMessageChannel,
  WIRE_ABI_EPOCH,
  WIRE_ABI_FORK,
  WIRE_ABI_MAGIC,
  WIRE_ABI_PRELUDE_LEN,
  assertPeerAbiAccepted,
  decodeWirePrelude,
  encodeWirePrelude,
  startsWithWireAbiMagic,
  type ServerMessage,
  type WireError,
} from "../src/index.js";
import { FakeTransport, type FakeChannel } from "./fakeTransport.js";
import { frameHex, fromHex, toHex } from "./helpers.js";
import { TERMINAL_SMALL_FULL, WELCOME_OK_ANSI_V21 } from "./vectors.js";

interface Collected {
  messages: ServerMessage[];
  undecodable: WireError[];
  errors: Error[];
  closes: unknown[];
}

async function openChannel(
  transport: FakeTransport,
  configure?: (channel: FakeChannel) => void,
): Promise<{ channel: ServerMessageChannel; wire: FakeChannel; got: Collected }> {
  const got: Collected = { messages: [], undecodable: [], errors: [], closes: [] };
  transport.onOpen = (fake) => configure?.(fake);
  const channel = await ServerMessageChannel.open(transport, {
    onMessage: (message) => got.messages.push(message),
    onUndecodable: (error) => got.undecodable.push(error),
    onError: (error) => got.errors.push(error),
    onClose: (close) => got.closes.push(close),
  });
  return { channel, wire: transport.last(), got };
}

describe("wire-ABI prelude encoding", () => {
  it("is 28 bytes: magic, fork, epoch, protocol version, fingerprint", () => {
    const bytes = encodeWirePrelude();
    expect(bytes.length).toBe(WIRE_ABI_PRELUDE_LEN);
    expect(startsWithWireAbiMagic(bytes)).toBe(true);
    expect(toHex(bytes.subarray(0, 4))).toBe(toHex(WIRE_ABI_MAGIC));

    const peer = decodeWirePrelude(bytes);
    expect(peer).toEqual({
      fork: WIRE_ABI_FORK,
      abiEpoch: WIRE_ABI_EPOCH,
      protocolVersion: PROTOCOL_VERSION,
      schemaFingerprint: LOCAL_WIRE_ABI.schemaFingerprint,
    });
  });

  /**
   * The property the whole sniff rests on, restated here because it is a *number* fact that is
   * easy to break by "tidying" the magic.
   *
   * A pre-prelude peer's first four bytes are a `u32` LE frame length, and both readers cap that
   * length. The magic read as that `u32` is above both caps, so "this stream opens with a prelude"
   * and "this stream opens with a legal frame" cannot both be true. `src/protocol/abi.rs` pins the
   * same fact on the Rust side.
   */
  it("cannot be confused with a legal frame length prefix", () => {
    const asLength = new DataView(
      WIRE_ABI_MAGIC.buffer,
      WIRE_ABI_MAGIC.byteOffset,
      4,
    ).getUint32(0, true);
    expect(asLength).toBeGreaterThan(RUST_MAX_FRAME_SIZE);
    expect(asLength).toBeGreaterThan(RUST_MAX_GRAPHICS_FRAME_SIZE);
  });

  it("accepts this build and refuses every axis of skew, naming the one that differs", () => {
    expect(() => assertPeerAbiAccepted(decodeWirePrelude(encodeWirePrelude()))).not.toThrow();

    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["wire fork", { fork: "upstream" }],
      ["protocol version", { protocolVersion: PROTOCOL_VERSION - 1 }],
      ["wire ABI epoch", { abiEpoch: WIRE_ABI_EPOCH + 1 }],
      ["schema fingerprint", { schemaFingerprint: "0000000000000000" }],
    ];
    for (const [axis, patch] of cases) {
      const peer = { ...decodeWirePrelude(encodeWirePrelude()), ...patch };
      let thrown: unknown;
      try {
        assertPeerAbiAccepted(peer as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, axis).toBeInstanceOf(AbiMismatchError);
      expect((thrown as AbiMismatchError).message, axis).toContain(axis);
      expect((thrown as AbiMismatchError).code).toBe("abi-mismatch");
    }
  });
});

describe("ServerMessageChannel wire-ABI gate", () => {
  it("announces this client's ABI before the caller sends anything", async () => {
    const transport = new FakeTransport();
    const { wire } = await openChannel(transport);

    expect(wire.kind).toBe(HerdrChannelKind.ClientStream);
    expect(wire.written).toHaveLength(1);
    expect(toHex(wire.written[0] as Uint8Array)).toBe(toHex(encodeWirePrelude()));
    // And it is the *first* thing: everything a caller sends lands behind it.
    expect(wire.clientMessages).toHaveLength(0);
  });

  it("accepts a matching peer and exposes what it announced", async () => {
    const transport = new FakeTransport();
    const { channel, got, wire } = await openChannel(transport);

    wire.emit(fromHex(frameHex(WELCOME_OK_ANSI_V21) + frameHex(TERMINAL_SMALL_FULL)));

    expect(channel.abiMismatch).toBeUndefined();
    expect(channel.peerAbi).toEqual({
      fork: WIRE_ABI_FORK,
      abiEpoch: WIRE_ABI_EPOCH,
      protocolVersion: PROTOCOL_VERSION,
      schemaFingerprint: LOCAL_WIRE_ABI.schemaFingerprint,
    });
    expect(got.messages.map((message) => message.type)).toEqual(["welcome", "terminal"]);
    expect(got.errors).toEqual([]);
  });

  /**
   * **The RED case.** A pre-prelude / upstream server: it answers with a `Welcome` whose version
   * this client would have accepted, and then streams frames. Every byte of that must be refused.
   */
  it("refuses a peer that sends no prelude, before decoding one frame", async () => {
    const transport = new FakeTransport();
    const { channel, got, wire } = await openChannel(transport, (fake) => {
      fake.wireAbiPrelude = null; // a herdr that predates the prelude, or a different fork
    });

    wire.emit(fromHex(frameHex(WELCOME_OK_ANSI_V21) + frameHex(TERMINAL_SMALL_FULL)));

    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toBeInstanceOf(AbiMismatchError);
    expect((got.errors[0] as AbiMismatchError).peer).toBeUndefined();
    expect((got.errors[0] as AbiMismatchError).message).toContain("no herdr-mx wire-ABI prelude");

    // The part that matters: nothing was interpreted. Not one message, not even an "undecodable
    // frame" — the refusal is ahead of the framer, not inside it.
    expect(got.messages).toEqual([]);
    expect(channel.undecodableCount).toBe(0);
    expect(channel.abiMismatch).toBeDefined();
    expect(channel.peerAbi).toBeUndefined();
  });

  it("refuses a peer that announces a different layout, and names the axis", async () => {
    const transport = new FakeTransport();
    const skewed = encodeWirePrelude();
    skewed[20] = (skewed[20] ?? 0) ^ 0xff; // first byte of the schema fingerprint
    const { channel, got, wire } = await openChannel(transport, (fake) => {
      fake.wireAbiPrelude = skewed;
    });

    wire.emit(fromHex(frameHex(WELCOME_OK_ANSI_V21)));

    expect(got.errors).toHaveLength(1);
    const error = got.errors[0] as AbiMismatchError;
    expect(error).toBeInstanceOf(AbiMismatchError);
    expect(error.message).toContain("schema fingerprint");
    expect(error.peer?.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(got.messages).toEqual([]);
    expect(channel.undecodableCount).toBe(0);
  });

  /**
   * A bridge chunk splits wherever the network splits, including in the middle of the prelude.
   * Assuming "the first chunk is the prelude" is the same bug `FrameReader` was written to avoid
   * for length prefixes, so the accumulator is tested at the nastiest boundary: one byte at a time.
   */
  it("tolerates a prelude split across chunks, down to one byte each", async () => {
    const transport = new FakeTransport();
    const { channel, got, wire } = await openChannel(transport, (fake) => {
      fake.wireAbiPrelude = null; // scripted by hand below
    });

    const prelude = encodeWirePrelude();
    for (const byte of prelude) {
      wire.emitRaw(new Uint8Array([byte]));
    }
    expect(got.errors).toEqual([]);
    expect(channel.peerAbi?.protocolVersion).toBe(PROTOCOL_VERSION);

    wire.emitRaw(fromHex(frameHex(WELCOME_OK_ANSI_V21)));
    expect(got.messages.map((message) => message.type)).toEqual(["welcome"]);
  });

  it("handles a prelude that shares a chunk with the first frame", async () => {
    const transport = new FakeTransport();
    const { got, wire } = await openChannel(transport, (fake) => {
      fake.wireAbiPrelude = null;
    });

    const prelude = encodeWirePrelude();
    const frame = fromHex(frameHex(WELCOME_OK_ANSI_V21));
    const together = new Uint8Array(prelude.length + frame.length);
    together.set(prelude, 0);
    together.set(frame, prelude.length);
    wire.emitRaw(together);

    expect(got.errors).toEqual([]);
    expect(got.messages.map((message) => message.type)).toEqual(["welcome"]);
  });

  /**
   * Terminal means terminal. After a refusal the peer keeps talking — a real bridge does not stop
   * because we stopped listening — and none of it may be routed, and nothing may be written back
   * (a `RequestFullFrame` to a peer whose layout we cannot read is noise at best).
   */
  it("stays terminal: later chunks are dropped and nothing is written back", async () => {
    const transport = new FakeTransport();
    const { channel, got, wire } = await openChannel(transport, (fake) => {
      fake.wireAbiPrelude = null;
    });

    wire.emit(fromHex(frameHex(WELCOME_OK_ANSI_V21)));
    wire.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)));
    wire.emit(fromHex("ffffffff00"));

    expect(got.errors).toHaveLength(1);
    expect(got.messages).toEqual([]);
    expect(got.undecodable).toEqual([]);
    expect(channel.fullFrameRequestCount).toBe(0);
    expect(wire.clientMessages).toHaveLength(0);
  });
});
