/**
 * Screen resynchronization: what a client does after it loses a frame it cannot decode.
 *
 * ## The problem this file exists for
 *
 * "Skip the frame and keep going" is correct at the **wire** layer and wrong at the **screen**
 * layer, and the two were conflated. The length prefix fixes the frame boundary, so the frames
 * behind a corrupt one are exactly where they should be — that is why an undecodable frame costs
 * exactly that frame (`src/stream.ts`, `src/transport.ts`). But `ServerMessage::Terminal` is not
 * an independent event: `TerminalFrame.full` (`src/protocol/wire.rs:771-780`) says whether the
 * payload is a full redraw or a **diff against the baseline the previous frame left behind**. Skip
 * a corrupt `Terminal` and apply the diffs behind it and the framing stays perfect while the
 * rendered cells are permanently wrong.
 *
 * ## The protocol already has the recovery
 *
 * `ClientMessage::RequestFullFrame` (`src/protocol/wire.rs:462-467`), tag 11, no fields:
 * *"The server resets the per-client render baseline so its next render is a full `Frame`,
 * recovering from a desync without showing wrong cells."* Server side:
 * `src/server/client_transport.rs:873` -> `ServerEvent::ClientRequestFullFrame` ->
 * `src/server/headless.rs:3052` -> `Client::request_full_redraw` (`src/server/clients.rs:149`) ->
 * `ClientRenderState::reset_baseline` (`src/server/render_stream.rs:36`), which on the
 * `TerminalAnsi` arm installs a fresh `BlitEncoder`; `BlitEncoder::encode_inner`
 * (`src/protocol/render_ansi.rs:88-92`) then computes `full = prev.is_none()` -> `true`. So the
 * very next `Terminal` for that client is a full redraw.
 *
 * ⚠️ mx-only: `RequestFullFrame` does not exist in upstream's `ClientMessage`.
 */
import { describe, expect, it } from "vitest";

import {
  ClientMessageTag,
  ServerMessageChannel,
  ServerMessageReader,
  encodeObserveTerminal,
  encodeRequestFullFrame,
  encodeRequestFullFrameFrame,
  type ServerMessage,
  type TerminalMessage,
  type WireError,
} from "../src/index.js";
import { FakeTransport, type FakeChannel } from "./fakeTransport.js";
import { frameHex, fromHex, toHex } from "./helpers.js";
import {
  REQUEST_FULL_FRAME,
  TERMINAL_SMALL_DIFF,
  TERMINAL_SMALL_FULL,
  WELCOME_OK_ANSI,
} from "./vectors.js";

/** A whole frame carrying a `Terminal` (tag 13) whose body stops after `seq`: corrupt, not short. */
const CORRUPT_TERMINAL = frameHex("0d01");

// ---------------------------------------------------------------------------
// The encoder
// ---------------------------------------------------------------------------

describe("ClientMessage::RequestFullFrame encode", () => {
  it("is the tag byte and nothing else", () => {
    const payload = encodeRequestFullFrame();
    expect(toHex(payload)).toBe(REQUEST_FULL_FRAME);
    expect(toHex(payload)).toBe("0b");
    expect(payload.length).toBe(1);
    expect(payload[0]).toBe(ClientMessageTag.RequestFullFrame);
    expect(ClientMessageTag.RequestFullFrame).toBe(11);
  });

  /**
   * The trap, spelled out. Every `ClientMessage` neighbour of tag 11 carries fields, and the one
   * this package already encodes — `ObserveTerminal` (`src/protocol/wire.rs:471-474`) — costs a
   * length varint even for an *empty* string. A `RequestFullFrame` built by copying it and
   * "removing the argument" would still emit `0b 00`, and the server would decode that trailing
   * zero as the start of the next message. Byte count is the assertion, not shape.
   */
  it("appends nothing after the tag, unlike its field-carrying neighbours", () => {
    expect(Array.from(encodeRequestFullFrame().subarray(1))).toEqual([]);
    // The contrast: an empty `ObserveTerminal` target is still two bytes.
    expect(encodeObserveTerminal("").length).toBe(2);
  });

  it("frames as a one-byte payload: 01 00 00 00 0b", () => {
    const framed = encodeRequestFullFrameFrame();
    expect(toHex(framed)).toBe(frameHex(REQUEST_FULL_FRAME));
    expect(toHex(framed)).toBe("010000000b");
    expect(framed.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// ServerMessageChannel: it holds the write end, so it recovers by itself
// ---------------------------------------------------------------------------

interface Collected {
  messages: ServerMessage[];
  undecodable: WireError[];
  errors: Error[];
}

async function openChannel(
  transport: FakeTransport,
): Promise<{ channel: ServerMessageChannel; got: Collected; wire: FakeChannel }> {
  const got: Collected = { messages: [], undecodable: [], errors: [] };
  const channel = await ServerMessageChannel.open(transport, {
    onMessage: (message) => got.messages.push(message),
    onUndecodable: (error) => got.undecodable.push(error),
    onError: (error) => got.errors.push(error),
    onClose: () => {},
  });
  return { channel, got, wire: transport.last() };
}

function terminalSeqs(messages: ServerMessage[]): string[] {
  return messages
    .filter((message): message is TerminalMessage => message.type === "terminal")
    .map((message) => `${message.seq}${message.full ? "F" : "d"}`);
}

describe("ServerMessageChannel screen resynchronization", () => {
  /**
   * The whole contract in one chunk: `[corrupt][diff][full][diff]`.
   *
   * The corrupt frame is skipped (the wire is fine) but the screen baseline is now unknowable, so
   * the diff behind it must NOT reach the renderer — applying it would paint cells computed
   * against a baseline this client never saw. The `full` frame re-establishes the baseline and
   * delivery resumes, diffs included.
   */
  it("drops diffs after a corrupt frame, resumes on the next full frame", async () => {
    const transport = new FakeTransport();
    const { channel, got, wire } = await openChannel(transport);

    wire.emit(
      fromHex(
        CORRUPT_TERMINAL +
          frameHex(TERMINAL_SMALL_DIFF) +
          frameHex(TERMINAL_SMALL_FULL) +
          frameHex(TERMINAL_SMALL_DIFF),
      ),
    );

    // seq 1 is the full frame, seq 2 the diff behind it. The diff *in front* of the full frame is
    // gone, and the one behind it is not.
    expect(terminalSeqs(got.messages)).toEqual(["1F", "2d"]);
    expect(channel.droppedDiffCount).toBe(1);
    expect(channel.awaitingFullFrame).toBe(false);
    expect(got.undecodable.map((error) => error.code)).toEqual(["corrupt"]);
    expect(got.errors).toEqual([]);
  });

  /** The recovery is only real if the bytes actually left. */
  it("writes a RequestFullFrame frame on the channel when it desyncs", async () => {
    const transport = new FakeTransport();
    const { channel, wire } = await openChannel(transport);

    expect(wire.clientMessages).toHaveLength(0);
    wire.emit(fromHex(CORRUPT_TERMINAL));

    expect(wire.clientMessages).toHaveLength(1);
    expect(toHex(wire.clientMessages[0] as Uint8Array)).toBe("010000000b");
    expect(channel.awaitingFullFrame).toBe(true);
    expect(channel.fullFrameRequestCount).toBe(1);
  });

  /**
   * Regression guard for the fix this builds on (`bbedbeb6`). `Notify`, `Compressed`, `Pong` and
   * friends are routine traffic that this codec chooses not to decode — they say nothing about the
   * ANSI baseline, so treating them as a desync would ask the server for a full repaint several
   * times a second and drop every diff in between. Nothing must be written and nothing dropped.
   */
  it("does not resynchronize on an undecoded variant", async () => {
    const transport = new FakeTransport();
    const { channel, got, wire } = await openChannel(transport);

    // Notify (tag 4) in front of a diff, one chunk.
    wire.emit(fromHex(frameHex("04") + frameHex(TERMINAL_SMALL_DIFF)));

    expect(got.undecodable.map((error) => error.code)).toEqual(["unsupported-variant"]);
    expect(terminalSeqs(got.messages)).toEqual(["2d"]);
    expect(channel.awaitingFullFrame).toBe(false);
    expect(channel.droppedDiffCount).toBe(0);
    expect(channel.fullFrameRequestCount).toBe(0);
    expect(wire.clientMessages).toHaveLength(0);
  });

  /**
   * A `Welcome` is not a screen frame, so it must cross a desync untouched — otherwise a
   * handshake that raced a corrupt frame would look like a dead connection.
   */
  it("keeps delivering non-Terminal messages while awaiting the full frame", async () => {
    const transport = new FakeTransport();
    const { channel, got, wire } = await openChannel(transport);

    wire.emit(fromHex(CORRUPT_TERMINAL + frameHex(WELCOME_OK_ANSI) + frameHex(TERMINAL_SMALL_DIFF)));

    expect(got.messages.map((message) => message.type)).toEqual(["welcome"]);
    expect(channel.awaitingFullFrame).toBe(true);
    expect(channel.droppedDiffCount).toBe(1);
  });

  /**
   * Each corrupt frame asks again. The one that arrives while already awaiting could have *been*
   * the full frame the server sent, so a request that only fired on the first corruption would
   * strand the screen forever; the server-side handler is a baseline reset
   * (`src/server/headless.rs:3052`), which is idempotent.
   */
  it("asks again when a second corrupt frame lands during the wait", async () => {
    const transport = new FakeTransport();
    const { channel, wire } = await openChannel(transport);

    wire.emit(fromHex(CORRUPT_TERMINAL));
    wire.emit(fromHex(CORRUPT_TERMINAL));

    expect(channel.fullFrameRequestCount).toBe(2);
    expect(wire.clientMessages.map((bytes) => toHex(bytes))).toEqual([
      "010000000b",
      "010000000b",
    ]);
  });
});

// ---------------------------------------------------------------------------
// ServerMessageReader: no write end, so it reports instead of recovering
// ---------------------------------------------------------------------------

describe("ServerMessageReader screen desync", () => {
  /**
   * Why the two layers differ, in one test.
   *
   * `ServerMessageReader` is pull-shaped: it is handed chunks and hands back messages, and has no
   * way to send `RequestFullFrame`. Dropping diffs on its own would therefore be a promise it
   * cannot keep — with no request on the wire the server has no reason to ever send another full
   * frame, so the screen would freeze instead of merely drifting. It exposes the fact and lets the
   * caller (who owns the socket) do both halves.
   */
  it("reports the desync but keeps delivering diffs by default", () => {
    const reader = new ServerMessageReader();
    const messages = reader.push(
      fromHex(CORRUPT_TERMINAL + frameHex(TERMINAL_SMALL_DIFF) + frameHex(TERMINAL_SMALL_FULL)),
    );

    expect(reader.screenDesynced).toBe(false); // cleared by the full frame in the same chunk
    expect(terminalSeqs(messages)).toEqual(["2d", "1F"]);
    expect(reader.undecodableCount).toBe(1);
    expect(reader.droppedDiffCount).toBe(0);
  });

  it("stays desynced until a full frame arrives", () => {
    const reader = new ServerMessageReader();
    reader.push(fromHex(CORRUPT_TERMINAL + frameHex(TERMINAL_SMALL_DIFF)));
    expect(reader.screenDesynced).toBe(true);

    reader.push(fromHex(frameHex(TERMINAL_SMALL_FULL)));
    expect(reader.screenDesynced).toBe(false);
  });

  /** The opt-in: a caller that *does* send `RequestFullFrame` gets the channel's exact policy. */
  it("drops diffs while desynced when the caller opts in", () => {
    const reader = new ServerMessageReader({ dropDiffsWhileDesynced: true });
    const messages = reader.push(
      fromHex(
        CORRUPT_TERMINAL +
          frameHex(TERMINAL_SMALL_DIFF) +
          frameHex(TERMINAL_SMALL_FULL) +
          frameHex(TERMINAL_SMALL_DIFF),
      ),
    );

    expect(terminalSeqs(messages)).toEqual(["1F", "2d"]);
    expect(reader.droppedDiffCount).toBe(1);
    expect(reader.screenDesynced).toBe(false);
  });

  it("does not desync on an undecoded variant", () => {
    const reader = new ServerMessageReader({ dropDiffsWhileDesynced: true });
    const messages = reader.push(fromHex(frameHex("04") + frameHex(TERMINAL_SMALL_DIFF)));

    expect(reader.screenDesynced).toBe(false);
    expect(terminalSeqs(messages)).toEqual(["2d"]);
    expect(reader.droppedDiffCount).toBe(0);
  });

  it("clears the desync bookkeeping on reset", () => {
    const reader = new ServerMessageReader({ dropDiffsWhileDesynced: true });
    reader.push(fromHex(CORRUPT_TERMINAL + frameHex(TERMINAL_SMALL_DIFF)));
    expect(reader.screenDesynced).toBe(true);
    expect(reader.droppedDiffCount).toBe(1);

    reader.reset();
    expect(reader.screenDesynced).toBe(false);
    expect(reader.droppedDiffCount).toBe(0);
  });
});
