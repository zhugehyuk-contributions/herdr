/**
 * An in-memory {@link HerdrTransport}. The point of the transport seam, made testable.
 *
 * A fake here is not a convenience — it is the claim under test. If the codec and the JSON API
 * client really are transport-agnostic, then a transport made of arrays and closures must drive
 * them exactly as ssh does, and the ssh implementation contributes nothing but bytes. Every
 * assertion this file enables is one the ssh live suite does not have to make.
 *
 * It also records what the callers *did* — how many channels, of which kinds, in which order —
 * because the interesting contracts (one channel per API request, one connection per host) are
 * about channel bookkeeping, not about bytes.
 */
import {
  HerdrChannelKind,
  type HerdrChannel,
  type HerdrChannelClose,
  type HerdrChannelHandlers,
  type HerdrTransport,
} from "../src/index.js";

/** One end of a fake channel, as seen by the "server" side of the test. */
export class FakeChannel implements HerdrChannel {
  readonly kind: HerdrChannelKind;
  /** Everything the client wrote, in order. */
  readonly written: Uint8Array[] = [];
  /**
   * Writes that landed after the channel was gone. Counted rather than thrown, because that is
   * what a real one does: `ssh2` surfaces a write-after-end as an `error` event on the stream, so
   * a caller racing a dying bridge sees the close, never a synchronous throw.
   */
  writesAfterClose = 0;
  closed = false;

  private readonly handlers: HerdrChannelHandlers;

  constructor(kind: HerdrChannelKind, handlers: HerdrChannelHandlers) {
    this.kind = kind;
    this.handlers = handlers;
  }

  /** Everything written, concatenated and UTF-8 decoded. Convenient for the NDJSON kinds. */
  get writtenText(): string {
    let out = "";
    for (const chunk of this.written) {
      out += new TextDecoder().decode(chunk);
    }
    return out;
  }

  write(bytes: Uint8Array): void {
    if (this.closed) {
      this.writesAfterClose += 1;
      return;
    }
    this.written.push(bytes.slice());
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.handlers.onClose({});
  }

  // --- server side -------------------------------------------------------

  /** Delivers bytes as if the remote bridge had produced them. */
  emit(chunk: Uint8Array): void {
    this.handlers.onData(chunk);
  }

  /** Delivers a UTF-8 line, newline appended. */
  emitLine(line: string): void {
    this.emit(new TextEncoder().encode(`${line}\n`));
  }

  /** Ends the channel from the remote side (process exit, ssh teardown, …). */
  die(close: HerdrChannelClose = {}): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.handlers.onClose(close);
  }
}

export class FakeTransport implements HerdrTransport {
  /** Every channel ever opened, in order. Never pruned — closed ones stay for assertions. */
  readonly channels: FakeChannel[] = [];
  closed = false;

  /** Called for each channel as it opens; the hook is where a test scripts the remote's replies. */
  onOpen: ((channel: FakeChannel) => void) | null = null;

  openChannel(kind: HerdrChannelKind, handlers: HerdrChannelHandlers): Promise<HerdrChannel> {
    if (this.closed) {
      return Promise.reject(new Error("transport is closed"));
    }
    const channel = new FakeChannel(kind, handlers);
    this.channels.push(channel);
    // Resolve on a microtask so callers cannot accidentally depend on a synchronous open — the ssh
    // implementation certainly is not synchronous.
    return Promise.resolve().then(() => {
      this.onOpen?.(channel);
      return channel;
    });
  }

  close(): void {
    this.closed = true;
    for (const channel of this.channels) {
      channel.die({ error: new Error("transport closed") });
    }
  }

  kinds(): HerdrChannelKind[] {
    return this.channels.map((channel) => channel.kind);
  }

  ofKind(kind: HerdrChannelKind): FakeChannel[] {
    return this.channels.filter((channel) => channel.kind === kind);
  }

  /** The most recently opened channel. Throws rather than returning undefined. */
  last(): FakeChannel {
    const channel = this.channels[this.channels.length - 1];
    if (channel === undefined) {
      throw new Error("no channel has been opened");
    }
    return channel;
  }
}
