/**
 * The fork-skew alarm: does this connection actually speak *this* wire layout?
 *
 * `src/constants.ts:4-9` records the trap these tests exist for. herdr-mx and upstream/master both
 * report `PROTOCOL_VERSION = 20` and both put `Welcome` at tag 0, so the handshake succeeds against
 * either — while `ServerMessage::Terminal` is 13 here and 2 upstream. Point this client at an
 * upstream server and every terminal frame arrives as a variant this codec's table calls
 * `Graphics`, gets skipped as undecodable, and `onUndecodable` is optional and documented as *not*
 * an error: black screen, zero errors. `undecodableCount` made that *diagnosable*; these tests are
 * about *detecting* it.
 *
 * Both directions matter and the second one is the hard one: a healthy mx server also sends
 * variants this codec does not decode (`Notify`, `Clipboard`, `WindowTitle`, …), so a probe that
 * fires on "some undecodable frames" would condemn every working connection.
 */
import { describe, expect, it } from "vitest";

import {
  ClientLaunchMode,
  DEFAULT_LAYOUT_PROBE_REPEATS,
  LayoutMismatchError,
  RenderEncoding,
  ServerMessageChannel,
  WireLayoutProbe,
  encodeHelloFrame,
  encodeObserveTerminalFrame,
  type ServerMessage,
  type ServerMessageChannelOptions,
  type TransportTimer,
  type TransportTimerHandle,
  type WireError,
} from "../src/index.js";
import { FakeTransport, type FakeChannel } from "./fakeTransport.js";
import { frameHex, fromHex } from "./helpers.js";
import { TERMINAL_SMALL_DIFF, TERMINAL_SMALL_FULL, WELCOME_OK_ANSI } from "./vectors.js";

/** What an upstream server calls `Terminal` and this codec's table calls `Graphics`. */
const UPSTREAM_TERMINAL_TAG = "02";

interface Collected {
  messages: ServerMessage[];
  undecodable: WireError[];
  errors: Error[];
}

/** A hand-cranked {@link TransportTimer}: nothing fires until the test says so. */
class ManualTimer implements TransportTimer {
  private readonly pending = new Map<number, () => void>();
  private next = 1;

  setTimeout(handler: () => void, _ms: number): TransportTimerHandle {
    const handle = this.next;
    this.next += 1;
    this.pending.set(handle, handler);
    return handle;
  }

  clearTimeout(handle: TransportTimerHandle): void {
    this.pending.delete(handle as number);
  }

  get armedCount(): number {
    return this.pending.size;
  }

  /** Fires every armed timer, oldest first. */
  fire(): void {
    for (const handle of [...this.pending.keys()]) {
      const handler = this.pending.get(handle);
      this.pending.delete(handle);
      handler?.();
    }
  }
}

async function openChannel(
  options: ServerMessageChannelOptions = {},
): Promise<{ channel: ServerMessageChannel; wire: FakeChannel; got: Collected }> {
  const transport = new FakeTransport();
  const got: Collected = { messages: [], undecodable: [], errors: [] };
  const channel = await ServerMessageChannel.open(
    transport,
    {
      onMessage: (message) => got.messages.push(message),
      onUndecodable: (error) => got.undecodable.push(error),
      onError: (error) => got.errors.push(error),
      onClose: () => {},
    },
    options,
  );
  return { channel, wire: transport.last(), got };
}

/** Handshake, then the message that actually starts the stream. */
function handshakeAndObserve(channel: ServerMessageChannel, wire: FakeChannel): void {
  channel.send(
    encodeHelloFrame({
      cols: 100,
      rows: 30,
      requestedEncoding: RenderEncoding.TerminalAnsi,
      launchMode: ClientLaunchMode.TerminalAttach,
    }),
  );
  wire.emit(fromHex(frameHex(WELCOME_OK_ANSI)));
  channel.send(encodeObserveTerminalFrame("w1:p1"));
}

function emitTags(wire: FakeChannel, tags: readonly string[]): void {
  wire.emit(fromHex(tags.map((tag) => frameHex(tag)).join("")));
}

describe("wire-layout probe", () => {
  /**
   * The case B1 is about: an upstream server, whose `Terminal` is tag 2. The handshake is green
   * (same version, same `Welcome` tag), then the terminal stream arrives as a variant this codec
   * skips. One actionable error, not N undecodable-variant shrugs.
   */
  it("reports a layout mismatch when the stream is a repeat of one undecoded tag", async () => {
    const { channel, wire, got } = await openChannel();
    handshakeAndObserve(channel, wire);

    emitTags(wire, Array.from({ length: DEFAULT_LAYOUT_PROBE_REPEATS }, () => UPSTREAM_TERMINAL_TAG));

    expect(got.errors).toHaveLength(1);
    const error = got.errors[0] as LayoutMismatchError;
    expect(error).toBeInstanceOf(LayoutMismatchError);
    expect(error.code).toBe("layout-mismatch");
    // The observed tags are the diagnosis: a repeat of tag 2 is what an upstream peer looks like.
    expect(error.observedTags).toEqual([
      { tag: 2, name: "Graphics", count: DEFAULT_LAYOUT_PROBE_REPEATS },
    ]);
    expect(error.dominantTag).toBe(2);
    expect(error.terminalsSeen).toBe(0);
    expect(error.message).toContain("2");
    // Honest about what it is: an inference from traffic shape, not a proof.
    expect(error.message.toLowerCase()).toContain("inferred");
    expect(channel.layoutMismatch).toBe(error);
  });

  /** Terminal, and it means it: the verdict fires once however many skewed frames follow. */
  it("reports the layout mismatch exactly once", async () => {
    const { channel, wire, got } = await openChannel();
    handshakeAndObserve(channel, wire);

    emitTags(wire, Array.from({ length: 40 }, () => UPSTREAM_TERMINAL_TAG));

    expect(got.errors).toHaveLength(1);
    expect(channel.layoutMismatch?.code).toBe("layout-mismatch");
  });

  /**
   * The false-positive test, and the reason the rule counts *repeats of one tag* rather than
   * undecodable frames in total. A healthy mx server sends `Notify` (`src/server/headless.rs:1958`),
   * `WindowTitle` (`:2073`), `Clipboard` (`:2112`), `PrefixInputSource` (`:2120`),
   * `ReloadSoundConfig` (`:2431`) — event-driven, heterogeneous, and none of them a stream.
   */
  it("does not fire on a healthy mx server's mixed routine traffic", async () => {
    const { channel, wire, got } = await openChannel();
    handshakeAndObserve(channel, wire);

    // Notify, Clipboard, WindowTitle, ReloadSoundConfig, Pong, Notify, Clipboard, WindowTitle:
    // eight undecodable frames, well past the repeat threshold in total, no tag repeated enough.
    emitTags(wire, ["04", "05", "06", "07", "0a", "04", "05", "06"]);
    wire.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)));

    expect(channel.undecodableCount).toBe(8);
    expect(channel.layoutMismatch).toBeUndefined();
    expect(got.errors).toEqual([]);
    expect(got.messages.map((message) => message.type)).toEqual(["welcome", "terminal"]);
  });

  /** One below the threshold stays silent, whatever the tag. The boundary is a boundary. */
  it("does not fire one repeat short of the threshold", async () => {
    const { channel, wire, got } = await openChannel();
    handshakeAndObserve(channel, wire);

    emitTags(
      wire,
      Array.from({ length: DEFAULT_LAYOUT_PROBE_REPEATS - 1 }, () => UPSTREAM_TERMINAL_TAG),
    );

    expect(channel.undecodableCount).toBe(DEFAULT_LAYOUT_PROBE_REPEATS - 1);
    expect(channel.layoutMismatch).toBeUndefined();
    expect(got.errors).toEqual([]);
  });

  /**
   * A decoded `Terminal` settles the question the probe was asking: this peer's tag 13 *is* our
   * `Terminal`. Whatever the connection does afterwards is a different problem.
   */
  it("never fires once a Terminal frame has decoded", async () => {
    const { channel, wire, got } = await openChannel();
    handshakeAndObserve(channel, wire);

    wire.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)));
    emitTags(wire, Array.from({ length: 50 }, () => UPSTREAM_TERMINAL_TAG));

    expect(channel.undecodableCount).toBe(50);
    expect(channel.layoutMismatch).toBeUndefined();
    expect(got.errors).toEqual([]);
  });

  /**
   * A `Terminal` *diff* dropped because the screen is desynchronized still proves the layout — it
   * decoded. The probe watches decoding, not delivery, so the withheld frame counts.
   */
  it("counts a withheld Terminal diff as proof of the layout", async () => {
    const { channel, wire, got } = await openChannel();
    handshakeAndObserve(channel, wire);

    // A corrupt frame desyncs the screen, so the diff behind it is decoded and then withheld.
    wire.emit(fromHex(frameHex("0d01")));
    wire.emit(fromHex(frameHex(TERMINAL_SMALL_DIFF)));
    expect(channel.droppedDiffCount).toBe(1);

    emitTags(wire, Array.from({ length: 20 }, () => UPSTREAM_TERMINAL_TAG));

    expect(channel.layoutMismatch).toBeUndefined();
    expect(got.errors).toEqual([]);
  });

  /**
   * Before `ObserveTerminal` the server has not been asked for a stream, so "no Terminal yet" is
   * not evidence of anything. Arming on the message that starts the stream is what keeps the
   * probe's premise true.
   */
  it("stays disarmed until ObserveTerminal is sent", async () => {
    const { channel, wire, got } = await openChannel();
    channel.send(
      encodeHelloFrame({
        cols: 100,
        rows: 30,
        requestedEncoding: RenderEncoding.TerminalAnsi,
        launchMode: ClientLaunchMode.TerminalAttach,
      }),
    );
    wire.emit(fromHex(frameHex(WELCOME_OK_ANSI)));

    emitTags(wire, Array.from({ length: 20 }, () => UPSTREAM_TERMINAL_TAG));
    expect(channel.layoutMismatch).toBeUndefined();
    expect(got.errors).toEqual([]);

    // Armed now — and the frames that arrive after it are the ones that count.
    channel.send(encodeObserveTerminalFrame("w1:p1"));
    emitTags(wire, Array.from({ length: DEFAULT_LAYOUT_PROBE_REPEATS }, () => UPSTREAM_TERMINAL_TAG));
    expect(channel.layoutMismatch?.dominantTag).toBe(2);
  });

  /** The verdict is terminal: no `onMessage` follows it, exactly like a framing failure. */
  it("stops routing frames after the verdict", async () => {
    const { channel, wire, got } = await openChannel();
    handshakeAndObserve(channel, wire);
    emitTags(wire, Array.from({ length: DEFAULT_LAYOUT_PROBE_REPEATS }, () => UPSTREAM_TERMINAL_TAG));
    const before = got.messages.length;

    wire.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)));

    expect(got.messages).toHaveLength(before);
  });
});

/**
 * The deadline arm. Secondary by construction: a skewed peer whose pane is idle may only ever send
 * one frame, which the repeat rule can never reach, so a *time* bound is the only thing that
 * converts it into an answer. It is opt-in because a codec that reads bytes has no business
 * depending on a clock unless its caller asks it to — and because a default deadline would make
 * every slow first render look like a fork.
 */
describe("wire-layout probe deadline", () => {
  it("fires after the first-Terminal deadline when undecodable frames were seen", async () => {
    const timer = new ManualTimer();
    const { channel, wire, got } = await openChannel({ firstTerminalTimeoutMs: 15_000, timer });
    handshakeAndObserve(channel, wire);
    expect(timer.armedCount).toBe(1);

    emitTags(wire, [UPSTREAM_TERMINAL_TAG]);
    timer.fire();

    expect(got.errors).toHaveLength(1);
    expect((got.errors[0] as LayoutMismatchError).observedTags).toEqual([
      { tag: 2, name: "Graphics", count: 1 },
    ]);
  });

  /**
   * The honesty clause. A deadline with *no* undecodable frame behind it says nothing about the
   * layout — the pane may be idle, the target may be wrong, the server may be busy. Blaming the
   * peer's wire format there would be a fabricated diagnosis.
   */
  it("stays silent at the deadline when nothing undecodable arrived", async () => {
    const timer = new ManualTimer();
    const { channel, wire, got } = await openChannel({ firstTerminalTimeoutMs: 15_000, timer });
    handshakeAndObserve(channel, wire);

    timer.fire();

    expect(channel.layoutMismatch).toBeUndefined();
    expect(got.errors).toEqual([]);
  });

  it("disarms the deadline once a Terminal frame decodes", async () => {
    const timer = new ManualTimer();
    const { channel, wire, got } = await openChannel({ firstTerminalTimeoutMs: 15_000, timer });
    handshakeAndObserve(channel, wire);

    wire.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)));
    expect(timer.armedCount).toBe(0);

    emitTags(wire, [UPSTREAM_TERMINAL_TAG]);
    timer.fire();
    expect(channel.layoutMismatch).toBeUndefined();
    expect(got.errors).toEqual([]);
  });

  /** No deadline asked for, no timer touched — the default path never reads a clock. */
  it("arms no timer by default", async () => {
    const timer = new ManualTimer();
    const { channel, wire } = await openChannel({ timer });
    handshakeAndObserve(channel, wire);
    expect(timer.armedCount).toBe(0);
    expect(channel.layoutMismatch).toBeUndefined();
  });
});

/** The rule itself, away from any transport: it is the part that has to be reviewable. */
describe("WireLayoutProbe", () => {
  it("is inert until armed and after a Terminal", () => {
    const probe = new WireLayoutProbe();
    expect(probe.armed).toBe(false);
    probe.arm();
    expect(probe.armed).toBe(true);
    probe.noteTerminal();
    expect(probe.armed).toBe(false);
    // Re-arming a proven-compatible peer is meaningless; a second ObserveTerminal must not undo it.
    probe.arm();
    expect(probe.armed).toBe(false);
  });

  it("takes a caller-chosen repeat threshold", () => {
    const probe = new WireLayoutProbe({ repeats: 2 });
    probe.arm();
    expect(probe.noteUndecodableTag(2)).toBeNull();
    const verdict = probe.noteUndecodableTag(2);
    expect(verdict).toBeInstanceOf(LayoutMismatchError);
    expect(verdict?.observedTags).toEqual([{ tag: 2, name: "Graphics", count: 2 }]);
  });

  it("rejects a repeat threshold that could not detect anything", () => {
    expect(() => new WireLayoutProbe({ repeats: 0 })).toThrow(/repeats/);
    expect(() => new WireLayoutProbe({ repeats: 1.5 })).toThrow(/repeats/);
  });

  it("reports every observed tag, most frequent first", () => {
    const probe = new WireLayoutProbe({ repeats: 3 });
    probe.arm();
    probe.noteUndecodableTag(4);
    probe.noteUndecodableTag(2);
    probe.noteUndecodableTag(2);
    expect(probe.observedTags()).toEqual([
      { tag: 2, name: "Graphics", count: 2 },
      { tag: 4, name: "Notify", count: 1 },
    ]);
  });

  it("names a tag outside this codec's table without inventing one", () => {
    const probe = new WireLayoutProbe({ repeats: 1 });
    probe.arm();
    const verdict = probe.noteUndecodableTag(99);
    expect(verdict?.observedTags).toEqual([{ tag: 99, name: undefined, count: 1 }]);
    expect(verdict?.message).toContain("99");
  });
});
