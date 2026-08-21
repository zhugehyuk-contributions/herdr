/**
 * The transport seam: how this codec reaches a herdr server that is not on the local machine.
 *
 * The app never opens `herdr.sock` / `herdr-client.sock` itself. It runs two stdio bridges over
 * ssh (`mobile/.prd/02-architecture.md` §2.1) and speaks the *same* two protocols through their
 * stdin/stdout:
 *
 * | remote command               | what it pumps                         | protocol           |
 * | ---------------------------- | ------------------------------------- | ------------------ |
 * | `herdr remote-api-bridge`    | `crate::api::socket_path()`           | NDJSON             |
 * | `herdr remote-client-bridge` | `server::socket_paths::client_...()`  | `[u32 LE len][..]` |
 *
 * Subcommand names: `src/remote/unix.rs:75-76`. Both are *pure byte pumps* — `bridge_stdio_to_socket`
 * (`src/remote/unix.rs:568-590`) connects the unix socket and copies stdin→socket / socket→stdout,
 * nothing else. Two consequences shape this file:
 *
 *   1. A channel is exactly a **bidirectional byte stream**, so this interface has no concept of
 *      requests, framing or messages. The existing codec (`ServerMessageReader`, `LineAccumulator`)
 *      already handles all of that and is reused unchanged on top.
 *   2. The whole authentication boundary is **ssh**, and no new listener appears on the server. So
 *      there is nothing to authenticate at this layer and no reason to ever dial a TCP port.
 *
 * ## Why this is an interface and not just the ssh2 client
 *
 * On React Native there is no ssh stack, so the app wraps a native module (iOS libssh2/NMSSH,
 * Android sshj — `mobile/.prd/02-architecture.md` §2.4). On Node there is `ssh2`. Both implement
 * *this* interface; everything above it (the codec, the JSON API client, the reconnect policy) is
 * written once and tested against an in-memory fake.
 *
 * That is also why the vocabulary here is deliberately impoverished — `Uint8Array`, callbacks and
 * promises, and nothing else. `Buffer`, `Stream` and `EventEmitter` are all Node types and all
 * absent from Hermes; `src/` is compiled with `"types": []` (`tsconfig.json`) precisely so that a
 * reach for one of them fails the build rather than the phone.
 */
import {
  JsonApiClient,
  JsonApiError,
  JsonApiProtocolError,
  LineAccumulator,
  isJsonApiError,
  parseJsonApiResponse,
  type JsonApiConnect,
  type JsonApiConnection,
} from "./jsonApi.js";
import { FrameReader, type FrameReaderOptions } from "./framing.js";
import { decodeServerMessage, type ServerMessage } from "./messages.js";
import { utf8Encode } from "./utf8.js";
import type { WireError } from "./errors.js";

/**
 * What a channel is for. Not decoration: the kind decides the **remote command** and, more
 * importantly, the **lifetime**, and those two axes are what the host-level contract is about
 * (`mobile/.prd/02-architecture.md` §2.4 — one transport per host, N channels).
 *
 * - {@link HerdrChannelKind.ApiRequest} — `remote-api-bridge`, **one channel per request**. The
 *   API server reads a single line, answers it and returns; `handle_connection` has no loop
 *   (`src/api/server.rs:139-152`), so a reused connection gets silence. Since the bridge is a byte
 *   pump onto that socket, the per-request lifetime propagates all the way out to the ssh channel.
 *   This is the one the mobile PRD wants collapsed (blocker B8) — until then, one exec per call.
 * - {@link HerdrChannelKind.ApiStream} — `remote-api-bridge`, **resident**. The same socket has
 *   exactly one method that does loop: `events.subscribe`, which answers `subscription_started`
 *   and then streams event lines until the peer goes away (`src/api/server.rs:198-215`,
 *   `stream_subscriptions` at `:654`). Same remote command as `ApiRequest`, opposite lifetime —
 *   which is why lifetime, not command, is what this enum encodes.
 * - {@link HerdrChannelKind.ClientStream} — `remote-client-bridge`, **resident**, one per observed
 *   pane. Carries the framed protocol and the `ObserveTerminal` stream.
 */
export const HerdrChannelKind = {
  ApiRequest: "api-request",
  ApiStream: "api-stream",
  ClientStream: "client-stream",
} as const;
export type HerdrChannelKind = (typeof HerdrChannelKind)[keyof typeof HerdrChannelKind];

/** True for the kinds served by `herdr remote-api-bridge` (NDJSON), false for the client bridge. */
export function isApiChannelKind(kind: HerdrChannelKind): boolean {
  return kind === HerdrChannelKind.ApiRequest || kind === HerdrChannelKind.ApiStream;
}

/**
 * The remote subcommand a channel kind has to exec (`src/remote/unix.rs:73-78`).
 *
 * Kept here rather than in the Node implementation because it is protocol knowledge, not Node
 * knowledge: the React Native native module has to send the exact same string.
 */
export function bridgeSubcommand(kind: HerdrChannelKind): string {
  return isApiChannelKind(kind) ? "remote-api-bridge" : "remote-client-bridge";
}

/**
 * Why a channel ended.
 *
 * A stdio bridge has three ways to die and they are not interchangeable, which is the whole reason
 * this is a struct and not a `void` callback: the remote `herdr` exited (an `exitCode`, e.g. the
 * server was not running and could not be spawned), ssh killed it (`signal`), or the local side
 * broke (`error`). `stderr` matters because the bridges report *every* startup failure there and
 * nowhere else — `ensure_remote_server_running` (`src/remote/unix.rs:592-611`) fails with a plain
 * `io::Error`, e.g. the protocol-mismatch message, and the process just exits non-zero.
 */
export interface HerdrChannelClose {
  /** Exit status of the remote `herdr` process, when the transport can observe one. */
  exitCode?: number | undefined;
  /** Signal that killed the remote process, if any. */
  signal?: string | undefined;
  /** Whatever the remote command wrote to stderr. The bridges' only error channel. */
  stderr?: string | undefined;
  /** Set when the channel died locally (socket error, transport torn down) rather than remotely. */
  error?: Error | undefined;
}

/**
 * Callbacks handed to {@link HerdrTransport.openChannel}.
 *
 * They are passed *at open* rather than attached to the returned channel on purpose. The remote
 * side can emit bytes the instant the command starts, and on React Native the delivery path is a
 * `NativeEventEmitter`: any window between "channel exists" and "listener attached" is a window in
 * which frames are dropped on the floor. Passing them in closes that window by construction
 * instead of forcing every implementation to buffer.
 */
export interface HerdrChannelHandlers {
  /** A chunk of remote stdout. Chunk boundaries are meaningless — never assume framing. */
  onData(chunk: Uint8Array): void;
  /** Called exactly once, after which no further `onData` may arrive. */
  onClose(close: HerdrChannelClose): void;
}

/** One exec channel: a bidirectional byte stream to one remote bridge process. */
export interface HerdrChannel {
  readonly kind: HerdrChannelKind;
  /** Writes to the remote command's stdin. */
  write(bytes: Uint8Array): void | Promise<void>;
  /**
   * Ends the channel. Idempotent. The implementation must still deliver
   * {@link HerdrChannelHandlers.onClose} so callers have a single termination path.
   */
  close(): void;
}

/**
 * One host. Not one connection *per channel* — one connection, period.
 *
 * `openChannel` must multiplex onto the transport's single existing ssh connection. herdr's own
 * desktop client makes the same promise by injecting `ControlMaster=auto` / `ControlPersist`
 * (`src/remote/unix.rs:310-316`), and for the same reason: each extra connection is another TCP
 * handshake, another key exchange and another sshd session held open on the server, on a link that
 * is a phone's LTE.
 *
 * ## The implementer's contract
 *
 * Everything below is a requirement on the *implementation*, none of it is expressible in the
 * signatures above, and all of it is stated here rather than in `src/node/sshTransport.ts` because
 * that file is the reference implementation, not the specification — and because a React Native
 * native-module author (iOS libssh2/NMSSH, Android sshj) does not read it. Same reason
 * {@link remoteBridgeCommand} lives in this file.
 *
 * 1. **exec without a pty** — use {@link BRIDGE_EXEC_OPTIONS}. A pty inserts a line discipline
 *    between the bridge and the socket: CR/LF translation and echo rewrite bytes *inside* every
 *    framed payload. The corruption is total, silent, and looks like a codec bug.
 * 2. **Run the command string this package produced** — {@link remoteBridgeCommand}'s output,
 *    verbatim, passed from JS to the native side. Do not rebuild it per platform: byte-identical
 *    output is the only thing keeping `--session` placement, `shell_quote` semantics
 *    (`src/remote/unix.rs:2088-2102`) and the `env` prefix in agreement across three
 *    implementations, of which the Rust one is the arbiter.
 * 3. **Pump stderr into {@link HerdrChannelClose.stderr}** — the bridges' *only* error channel.
 *    `ensure_remote_server_running` (`src/remote/unix.rs:592-611`) writes there and exits, so a
 *    transport that drops stderr turns every startup failure into a bare "closed".
 * 4. **Attach handlers before the channel is observable** — they are arguments to `openChannel`
 *    for this reason. The remote command writes the instant it starts, and a `NativeEventEmitter`
 *    subscribed after the fact loses whatever preceded it.
 * 5. **One connection, N channels** — as above.
 * 6. **`onData` delivers one channel's stdout ordered and exactly once** — this is a byte stream
 *    reassembled by a length-prefixed framer, so a reordered or duplicated delivery does not cost
 *    "an event", it desynchronizes the framer and poisons the reader irrecoverably. Chunk
 *    *boundaries* may be anything; chunk *order* may not, and one channel's bytes must never be
 *    delivered on another's.
 * 7. **The `onData` buffer belongs to the transport and is valid only for that call** — an
 *    implementation may reuse or free it on return, so a consumer that keeps bytes copies them.
 *    This codec does: `FrameReader.push` copies each chunk into its accumulator
 *    (`src/framing.ts`), `LineAccumulator.push` into its own (`src/jsonApi.ts:85-101`), so no
 *    decoded message aliases a transport buffer. The opposite convention — handing ownership to
 *    JS — would force the native side to allocate per chunk, which is the copy this rule avoids.
 * 8. **`write` resolves on hand-off, not on delivery** — resolution (or return, for the `void`
 *    form) means the local send path accepted the bytes. It is not an acknowledgement that the
 *    remote received them; this protocol has no delivery receipt, and the only end-to-end
 *    confirmation is a reply on the same channel.
 * 9. **A write racing a close must not throw** — `close()` is asynchronous on every real
 *    transport (`src/node/sshTransport.ts` ends the stream, `onClose` arrives later), so a write
 *    can legitimately land after the channel is gone. Drop it and let `onClose` report the end:
 *    `ssh2` surfaces it as an `error` event on the stream, never a synchronous throw, and the
 *    in-memory fake counts such writes instead of raising (`test/fakeTransport.ts:27-31`).
 */
export interface HerdrTransport {
  openChannel(kind: HerdrChannelKind, handlers: HerdrChannelHandlers): Promise<HerdrChannel>;
  /** Tears down every open channel and the underlying connection. */
  close(): void | Promise<void>;
}



// ---------------------------------------------------------------------------
// NDJSON over a channel
// ---------------------------------------------------------------------------

const DEFAULT_LINE_TIMEOUT_MS = 15_000;

/** Opaque handle returned by {@link TransportTimer.setTimeout}. */
export type TransportTimerHandle = unknown;

/**
 * Timers, injected rather than assumed.
 *
 * `src/` compiles with `lib: ["ES2020"]` and `types: []` (`tsconfig.json`), and ES2020 declares no
 * timers at all — they are a *host* facility, and the host here is Node, or a browser, or React
 * Native's `JSTimers`. Rather than pull in `@types/node`/`lib.dom` and blunt the gate that keeps
 * this package Hermes-clean, the timer is a value.
 *
 * {@link hostTimer} is the default and simply forwards to `globalThis`, which *is* ES2020. If the
 * host has no timers the calls become no-ops: a request then has no deadline of its own and ends
 * when the channel does. That is a real degradation, so it is stated here rather than hidden — a
 * caller in such a host should pass its own {@link TransportTimer}.
 */
export interface TransportTimer {
  setTimeout(handler: () => void, ms: number): TransportTimerHandle;
  clearTimeout(handle: TransportTimerHandle): void;
}

interface HostTimers {
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** {@link TransportTimer} bound to `globalThis`. */
export const hostTimer: TransportTimer = {
  setTimeout(handler: () => void, ms: number): TransportTimerHandle {
    const host = globalThis as HostTimers;
    return host.setTimeout?.(handler, ms);
  },
  clearTimeout(handle: TransportTimerHandle): void {
    const host = globalThis as HostTimers;
    host.clearTimeout?.(handle);
  },
};

export interface TransportJsonApiOptions {
  /** How long a single request may wait for its response line. Default 15s. */
  timeoutMs?: number;
  /** Defaults to {@link hostTimer}. */
  timer?: TransportTimer;
}

/** What a resident NDJSON consumer can be told about its channel. */
interface NdjsonListeners {
  onLine?: ((line: string) => void) | undefined;
  /**
   * The channel failed: it died remotely, the line decoder rejected the bytes, or a pull timed
   * out. Fires at most once, and never for a close the caller asked for.
   */
  onError?: ((error: Error) => void) | undefined;
  /** The channel ended, from either side. Fires exactly once, with the transport's own detail. */
  onClose?: ((close: HerdrChannelClose) => void) | undefined;
}

/**
 * Reads newline-delimited lines off a channel, with both a pull (`nextLine`) and a push
 * (`onLine`) face because the two API lifetimes need different ones: a request/response call pulls
 * exactly one line, a subscription is pushed lines forever.
 *
 * Lines that arrive before anyone asks are queued, never dropped — see the note on
 * {@link HerdrChannelHandlers} about why bytes can beat the caller. A resident consumer therefore
 * starts in pull mode (`deferLines`), reads its handshake line, and only then switches to push
 * with {@link NdjsonChannel.startPushing}; nothing that arrived in between is lost.
 *
 * Every listener call is isolated. `ingest` is invoked straight from the transport's `onData`,
 * which the Node implementation calls from an `ssh2` `data` event, so a listener that throws would
 * otherwise drop the rest of that chunk's lines *and* send an exception into an EventEmitter.
 * Isolation is not silence: failures are counted.
 */
class NdjsonChannel {
  private readonly lines = new LineAccumulator();
  private readonly queue: string[] = [];
  private listeners: NdjsonListeners = {};
  private channel: HerdrChannel | null = null;
  private failure: Error | null = null;
  private waiter: ((line: string) => void) | null = null;
  private waiterReject: ((error: Error) => void) | null = null;
  private push: ((line: string) => void) | null = null;
  private errorReported = false;
  private closedByCaller = false;
  private callbackFailures = 0;
  private lastCallbackError: unknown;

  static async open(
    transport: HerdrTransport,
    kind: HerdrChannelKind,
    listeners: NdjsonListeners = {},
    deferLines = false,
  ): Promise<NdjsonChannel> {
    const self = new NdjsonChannel();
    self.listeners = listeners;
    self.push = deferLines ? null : listeners.onLine ?? null;
    self.channel = await transport.openChannel(kind, {
      onData: (chunk) => self.ingest(chunk),
      onClose: (close) => self.finish(close),
    });
    return self;
  }

  /** How many times a listener threw. Zero is the number a caller should be able to check. */
  get callbackFailureCount(): number {
    return this.callbackFailures;
  }

  /** Whatever a listener threw most recently. `unknown`, because a throw can be anything. */
  get lastCallbackFailure(): unknown {
    return this.lastCallbackError;
  }

  private ingest(chunk: Uint8Array): void {
    let decoded: string[];
    try {
      decoded = this.lines.push(chunk);
    } catch (error) {
      this.fail(error as Error);
      return;
    }
    for (const line of decoded) {
      this.deliver(line);
    }
  }

  private deliver(line: string): void {
    if (this.push !== null) {
      this.notify(this.push, line);
      return;
    }
    const waiting = this.waiter;
    if (waiting !== null) {
      this.waiter = null;
      this.waiterReject = null;
      waiting(line);
    } else {
      this.queue.push(line);
    }
  }

  /** Calls a listener without letting its failure escape into the transport's event dispatch. */
  private notify<T>(handler: ((value: T) => void) | null | undefined, value: T): void {
    if (handler === null || handler === undefined) {
      return;
    }
    try {
      handler.call(this.listeners, value);
    } catch (error) {
      this.callbackFailures += 1;
      this.lastCallbackError = error;
    }
  }

  private finish(close: HerdrChannelClose): void {
    this.fail(close.error ?? new Error(describeClose("API bridge channel closed", close)));
    this.notify(this.listeners.onClose, close);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const reject = this.waiterReject;
    this.waiter = null;
    this.waiterReject = null;
    reject?.(this.failure);
    // A close the caller asked for is not a failure to report back to it; `onClose` covers that.
    if (!this.errorReported && !this.closedByCaller) {
      this.errorReported = true;
      this.notify(this.listeners.onError, this.failure);
    }
  }

  write(line: string): void | Promise<void> {
    return this.channel?.write(utf8Encode(line));
  }

  nextLine(timeoutMs: number, timer: TransportTimer): Promise<string> {
    const ready = this.queue.shift();
    if (ready !== undefined) {
      return Promise.resolve(ready);
    }
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    return new Promise<string>((resolveLine, rejectLine) => {
      const handle = timer.setTimeout(
        () => this.fail(new Error(`no API response line within ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.waiter = (line) => {
        timer.clearTimeout(handle);
        resolveLine(line);
      };
      this.waiterReject = (error) => {
        timer.clearTimeout(handle);
        rejectLine(error);
      };
    });
  }

  /**
   * Switches from pull to push mode: `first` (the line already consumed to check a handshake) and
   * then everything queued behind it, in arrival order.
   */
  startPushing(first: string): void {
    this.push = this.listeners.onLine ?? null;
    this.notify(this.push, first);
    while (this.queue.length > 0) {
      this.notify(this.push, this.queue.shift() as string);
    }
  }

  close(): void {
    this.closedByCaller = true;
    this.channel?.close();
  }
}

/**
 * Adapts a transport into the {@link JsonApiConnect} that {@link JsonApiClient} already expects.
 *
 * The one-request-one-connection rule (`src/jsonApi.ts` header) survives the move to ssh unchanged,
 * and this is where it becomes one-request-one-*channel*: `JsonApiClient.call` invokes the connect
 * function once per request, so each call gets its own {@link HerdrChannelKind.ApiRequest} exec on
 * the shared connection and closes it in its `finally`. Callers keep writing `api.paneList()` and
 * never learn that a bridge was involved.
 */
export function transportJsonApiConnect(
  transport: HerdrTransport,
  options: TransportJsonApiOptions = {},
): JsonApiConnect {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LINE_TIMEOUT_MS;
  const timer = options.timer ?? hostTimer;
  return async (): Promise<JsonApiConnection> => {
    const ndjson = await NdjsonChannel.open(transport, HerdrChannelKind.ApiRequest);
    return {
      write: (line: string) => ndjson.write(line),
      readLine: () => ndjson.nextLine(timeoutMs, timer),
      close: () => ndjson.close(),
    };
  };
}

/**
 * {@link JsonApiClient} wired to a transport. The whole ssh adaptation of the control plane, in
 * one line, because {@link JsonApiClient} was already transport-agnostic.
 */
export function createTransportJsonApiClient(
  transport: HerdrTransport,
  options: TransportJsonApiOptions = {},
): JsonApiClient {
  return new JsonApiClient(transportJsonApiConnect(transport, options));
}

/**
 * What a subscriber can be told about its subscription. A bare `onLine` function is still accepted
 * everywhere this type is, and means "line handler only".
 */
export interface JsonApiEventStreamHandlers {
  /** Every line the subscription produces, the acknowledgement included. */
  onLine(line: string): void;
  /**
   * The channel died: the ssh channel dropped, the remote `herdr` restarted, the phone lost LTE.
   * Fires at most once, and not for a {@link JsonApiEventStream.close} the subscriber called.
   *
   * Without this a subscriber has no way to learn that its subscription is gone — `onLine` simply
   * stops, which is indistinguishable from a quiet system, and the UI freezes on stale state
   * forever. This is the signal a reconnect is built on.
   */
  onError?(error: Error): void;
  /** The channel ended, from either side, with whatever the transport could observe about why. */
  onClose?(close: HerdrChannelClose): void;
}

export type JsonApiEventStreamListener =
  | ((line: string) => void)
  | JsonApiEventStreamHandlers;

/** `ResponseResult::SubscriptionStarted` (`src/api/schema/response.rs:191`), as it hits the wire. */
const SUBSCRIPTION_STARTED = "subscription_started";

/**
 * Checks the one line that decides whether a subscription exists.
 *
 * `stream_subscriptions` builds every subscription first and answers exactly once before it starts
 * streaming: `SuccessResponse { result: SubscriptionStarted }` if all of them were accepted
 * (`src/api/server.rs:679-686`), or the `ErrorResponse` from `ActiveSubscription::new`
 * (`src/api/subscriptions.rs:114-120`) written as one line before the connection is dropped
 * (`src/api/server.rs:663-676`). The server's own test asserts that shape
 * (`src/api/server.rs:1292`). So the first line is a decidable acknowledgement, and reading it is
 * the difference between a subscription and a handle to nothing.
 */
function assertSubscriptionStarted(id: string, line: string): void {
  const response = parseJsonApiResponse(line);
  if (isJsonApiError(response)) {
    throw new JsonApiError("events.subscribe", response.error.code, response.error.message);
  }
  if (response.id !== id) {
    throw new JsonApiProtocolError(
      `events.subscribe was acknowledged for id ${JSON.stringify(response.id)}, not ` +
        `${JSON.stringify(id)}`,
    );
  }
  if (response.result.type !== SUBSCRIPTION_STARTED) {
    throw new JsonApiProtocolError(
      `events.subscribe expected a \`${SUBSCRIPTION_STARTED}\` acknowledgement, got ` +
        `\`${response.result.type}\``,
    );
  }
}

/**
 * The resident NDJSON channel: `events.subscribe` and nothing else.
 *
 * Separate from {@link transportJsonApiConnect} because the server treats it as a different shape
 * of connection, not because the app does — `stream_subscriptions` (`src/api/server.rs:654`) writes
 * `subscription_started` and then loops, so this channel must be pinned open while every other API
 * call keeps churning through single-use ones.
 */
export class JsonApiEventStream {
  private readonly ndjson: NdjsonChannel;

  private constructor(ndjson: NdjsonChannel) {
    this.ndjson = ndjson;
  }

  /**
   * Opens the channel, sends `events.subscribe`, and **waits for the server to accept it**.
   *
   * Resolving therefore means the subscription exists. It used to mean only that the request had
   * been written, so a rejected subscription — or a bridge that died on the way up — still handed
   * back a live-looking stream that would never produce a line.
   *
   * The acknowledgement is forwarded to `onLine` like any other line, so a subscriber that logs
   * the stream sees exactly what it saw before the check existed.
   */
  static async subscribe(
    transport: HerdrTransport,
    subscriptions: ReadonlyArray<{ type: string } & Record<string, unknown>>,
    listener: JsonApiEventStreamListener,
    id = "ts-events",
    options: TransportJsonApiOptions = {},
  ): Promise<JsonApiEventStream> {
    const handlers: JsonApiEventStreamHandlers =
      typeof listener === "function" ? { onLine: listener } : listener;
    const timeoutMs = options.timeoutMs ?? DEFAULT_LINE_TIMEOUT_MS;
    const timer = options.timer ?? hostTimer;

    // Deferred push: the acknowledgement has to be *read*, and anything the server sends behind it
    // queues meanwhile rather than racing past the handler.
    const ndjson = await NdjsonChannel.open(transport, HerdrChannelKind.ApiStream, handlers, true);

    let acknowledgement: string;
    try {
      await ndjson.write(
        `${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`,
      );
      acknowledgement = await ndjson.nextLine(timeoutMs, timer);
      assertSubscriptionStarted(id, acknowledgement);
    } catch (error) {
      ndjson.close();
      throw error;
    }

    ndjson.startPushing(acknowledgement);
    return new JsonApiEventStream(ndjson);
  }

  /** How many times a subscriber callback threw. Isolated, but never hidden. */
  get callbackFailureCount(): number {
    return this.ndjson.callbackFailureCount;
  }

  /** Whatever a subscriber callback threw most recently. */
  get lastCallbackFailure(): unknown {
    return this.ndjson.lastCallbackFailure;
  }

  close(): void {
    this.ndjson.close();
  }
}

// ---------------------------------------------------------------------------
// The framed client protocol over a channel
// ---------------------------------------------------------------------------

export interface ServerMessageChannelHandlers {
  onMessage(message: ServerMessage): void;
  /**
   * A frame that did not become a message, costing exactly that frame. Two things arrive here and
   * they are deliberately the same thing to a caller:
   *
   * - a variant this codec does not decode (`Notify`, `Compressed`, …) — routine traffic on a real
   *   connection, `UnsupportedVariantError`;
   * - a payload that did not parse — `CorruptError` and friends.
   *
   * Both are recoverable for the identical reason: the length prefix already fixed the frame
   * boundary, so the frames behind them are exactly where they should be. `ServerMessageReader`
   * treats them the same way (`src/stream.ts`), and a corrupt payload used to be routed to
   * {@link ServerMessageChannelHandlers.onError} here — which contradicted `onError`'s own
   * "terminal" contract in both directions: an app that disposed its terminal on `onError` then
   * got `onMessage` and applied ANSI to a dead screen, and an app that reconnected flapped the ssh
   * channel over one skippable frame.
   *
   * Omitting this handler is fine — the drop is still counted in
   * {@link ServerMessageChannel.undecodableCount}. Throwing from it is fine too: the call is
   * isolated (see {@link ServerMessageChannel.callbackFailureCount}).
   */
  onUndecodable?: ((error: WireError) => void) | undefined;
  /**
   * A failure the stream cannot come back from: a framing error, and nothing else. The only one is
   * an oversized length prefix, which desynchronizes the stream with no resync point.
   *
   * Terminal, and it means it — this fires **exactly once**, no matter how many chunks the bridge
   * writes afterwards, and no `onMessage` follows it. `onClose` still reports the channel's own
   * end.
   */
  onError?: ((error: Error) => void) | undefined;
  onClose(close: HerdrChannelClose): void;
}

export interface ServerMessageChannelOptions {
  frameReader?: FrameReaderOptions | undefined;
}

/**
 * `remote-client-bridge` plus the framing/decoding stack: write `ClientMessage` frames in, get
 * decoded `ServerMessage`s out.
 *
 * Resident by contract — one per observed pane, kept open for as long as that pane is on screen.
 *
 * ## Why this de-frames and decodes separately instead of using {@link ServerMessageReader}
 *
 * Not for the reason it once was. `ServerMessageReader.push` used to rethrow on the first
 * undecodable frame, dropping everything already de-framed behind it — fatal on a socket, where
 * `Notify` (an undecoded variant, and normal traffic) routinely shares a TCP segment with the
 * `Terminal` frame after it. `src/stream.ts` now skips and continues, so both layers agree that an
 * undecodable frame costs exactly that frame.
 *
 * What is left is shape. This class is push-shaped: each frame is routed the moment it is decoded
 * (`onMessage` / `onUndecodable` / `onError`), including the frames salvaged out of a poisoned
 * {@link FrameReader}, whereas `push` returns an array and reports the rest out of band. Folding
 * one into the other would buy a dozen lines and cost that per-frame ordering.
 *
 * ## Handler calls are isolated
 *
 * Every handler is invoked through {@link ServerMessageChannel.notify}, so a handler that throws
 * costs its own call and nothing else. Three separate losses used to follow from one throw:
 * the rest of the chunk's frames (already de-framed, so gone for good — the `cf05b11b` bug through
 * the callback door), the terminal `onError` when the throw came from the salvage loop that runs
 * *before* it, and — because `ingest` is wired straight to the transport's `onData`, which the
 * Node implementation calls from an `ssh2` `data` event — an exception escaping into an
 * EventEmitter, which can take the process down. Isolation is not silence:
 * {@link ServerMessageChannel.callbackFailureCount} counts every one.
 */
export class ServerMessageChannel {
  private readonly frames: FrameReader;
  private readonly handlers: ServerMessageChannelHandlers;
  private channel: HerdrChannel | null = null;
  /** Set once a framing error has poisoned {@link FrameReader}; every later chunk is dropped. */
  private framingFailure: WireError | null = null;
  /** Set once the channel has ended, from either side. Same terminal treatment. */
  private closed = false;
  private skipped = 0;
  private lastSkipped: WireError | undefined;
  private callbackFailures = 0;
  private lastCallbackError: unknown;

  private constructor(handlers: ServerMessageChannelHandlers, options: ServerMessageChannelOptions) {
    this.handlers = handlers;
    this.frames = new FrameReader(options.frameReader ?? {});
  }

  static async open(
    transport: HerdrTransport,
    handlers: ServerMessageChannelHandlers,
    options: ServerMessageChannelOptions = {},
  ): Promise<ServerMessageChannel> {
    const self = new ServerMessageChannel(handlers, options);
    self.channel = await transport.openChannel(HerdrChannelKind.ClientStream, {
      onData: (chunk) => self.ingest(chunk),
      onClose: (close) => {
        self.closed = true;
        self.notify(handlers.onClose, close);
      },
    });
    return self;
  }

  /**
   * Frames dropped since this channel opened — undecoded variants and corrupt payloads alike.
   *
   * Always present, handler or not, because "connected, green, and the screen is black" has to be
   * a one-line diagnosis. The concrete way to reach that state is on record: `src/constants.ts:4-9`
   * documents that mx and upstream both report `PROTOCOL_VERSION = 20` while disagreeing on
   * `ServerMessage::Terminal` (13 here, 2 upstream), and `assertWelcomeAccepted`
   * (`src/messages.ts`) compares only versions. Against an upstream server the handshake passes,
   * every terminal frame arrives as a variant this codec calls `Graphics`, and — `onUndecodable`
   * being optional and documented as *not* an error — the failure would otherwise produce no
   * error, no log and no clue. A counter climbing in step with the frame rate names it instantly.
   */
  get undecodableCount(): number {
    return this.skipped;
  }

  /** The most recent dropped frame's error, for a caller that polls instead of subscribing. */
  get lastUndecodable(): WireError | undefined {
    return this.lastSkipped;
  }

  /** How many times one of the handlers threw. Isolated, but never hidden. */
  get callbackFailureCount(): number {
    return this.callbackFailures;
  }

  /** Whatever a handler threw most recently. `unknown`, because a throw can be anything. */
  get lastCallbackFailure(): unknown {
    return this.lastCallbackError;
  }

  private ingest(chunk: Uint8Array): void {
    if (this.framingFailure !== null || this.closed) {
      // Both terminal, and "terminal" has to mean it. A poisoned `FrameReader` rethrows the *same*
      // error object on every later push, salvage included (`src/framing.ts:53-56`), so without
      // this guard each further chunk would re-decode and re-emit the frames already routed below
      // — the same ANSI bytes applied again, i.e. a corrupted screen. `ServerMessageReader` holds
      // the identical property by rethrowing verbatim (`src/stream.ts:78-82`).
      return;
    }

    let payloads: Uint8Array[];
    try {
      payloads = this.frames.push(chunk);
    } catch (error) {
      // Framing errors are terminal: an oversized prefix desynchronizes the stream and
      // `FrameReader` poisons itself (`src/framing.ts:28`). Salvage what came before, report the
      // failure once, then stop — `onClose` remains the signal that the channel itself is gone.
      const wire = error as WireError;
      this.framingFailure = wire;
      for (const payload of (wire.decodedBefore ?? []) as Uint8Array[]) {
        this.decodeOne(payload);
      }
      // Reached even if every salvaged frame's handler threw: `decodeOne` isolates them, so the
      // terminal signal cannot be lost behind the last good bytes.
      this.notify(this.handlers.onError, wire);
      return;
    }
    for (const payload of payloads) {
      this.decodeOne(payload);
    }
  }

  private decodeOne(payload: Uint8Array): void {
    let message: ServerMessage;
    try {
      message = decodeServerMessage(payload);
    } catch (error) {
      // Every decode failure costs one frame and no more, whatever kind it is: the length prefix
      // already told the framer where this frame ended. Only a bad *prefix* is terminal, and that
      // never reaches here — `FrameReader` throws it out of `ingest`.
      const wire = error as WireError;
      this.skipped += 1;
      this.lastSkipped = wire;
      this.notify(this.handlers.onUndecodable, wire);
      return;
    }
    this.notify(this.handlers.onMessage, message);
  }

  /** Calls a handler without letting its failure decide what happens to the other frames. */
  private notify<T>(handler: ((value: T) => void) | undefined, value: T): void {
    if (handler === undefined) {
      return;
    }
    try {
      handler.call(this.handlers, value);
    } catch (error) {
      this.callbackFailures += 1;
      this.lastCallbackError = error;
    }
  }

  /** Sends one already-framed `ClientMessage` (`encodeHelloFrame`, `encodeObserveTerminalFrame`). */
  send(bytes: Uint8Array): void | Promise<void> {
    return this.channel?.write(bytes);
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
  }
}

/** Renders a {@link HerdrChannelClose} into one diagnostic line. */
export function describeClose(prefix: string, close: HerdrChannelClose): string {
  const parts: string[] = [];
  if (close.exitCode !== undefined) parts.push(`exit=${close.exitCode}`);
  if (close.signal !== undefined) parts.push(`signal=${close.signal}`);
  if (close.error !== undefined) parts.push(`error=${close.error.message}`);
  const stderr = close.stderr?.trim();
  if (stderr !== undefined && stderr.length > 0) parts.push(`stderr=${JSON.stringify(stderr)}`);
  return parts.length === 0 ? prefix : `${prefix} (${parts.join(" ")})`;
}

// ---------------------------------------------------------------------------
// The remote command
// ---------------------------------------------------------------------------

/** `src/session.rs:11`. The session flag is omitted for this name, exactly as the Rust side does. */
export const DEFAULT_SESSION_NAME = "default";

/**
 * The non-ssh half of what a transport needs to build its remote command. Deliberately here and
 * not in `src/node/`: the React Native native module has to produce the byte-identical string.
 */
export interface RemoteBridgeCommandOptions {
  /**
   * The remote `herdr` executable. Shell-quoted into the command, so it is taken literally — `~`
   * and `$HOME` are **not** expanded. `ssh` runs a non-interactive shell whose PATH often omits
   * `~/.local/bin`, so an absolute path is the reliable choice.
   */
  herdrBinary?: string;
  /** `herdr --session <name>`. Omitted when absent or {@link DEFAULT_SESSION_NAME}. */
  session?: string;
  /**
   * Environment prepended to the remote command as `env K=V …`.
   *
   * Not `ssh2`'s `ExecOptions.env`: that goes through the SSH `env` request, which sshd drops
   * unless the server's `AcceptEnv` lists the variable (default: `LANG`/`LC_*` only). A literal
   * `env` prefix always works. Chiefly useful for pointing a bridge at a non-default server via
   * `XDG_RUNTIME_DIR` / `HERDR_SOCKET_PATH`, which is how the live test stays off the developer's
   * own daemons.
   */
  env?: Record<string, string>;
}

/**
 * How the bridge command must be exec'd, wherever it is exec'd from.
 *
 * A value rather than a comment because it is protocol knowledge, like {@link remoteBridgeCommand}
 * beside it, and the file that used to hold it — `src/node/sshTransport.ts` — is the one a React
 * Native implementer never opens. The requirement itself: both bridges are pure byte pumps
 * (`bridge_stdio_to_socket`, `src/remote/unix.rs:568-590`), and a pty puts a line discipline in
 * front of them. CR/LF translation and echo then rewrite bytes inside every framed payload, so the
 * failure is total, silent, and looks like a codec bug. The desktop client avoids it with `ssh -T`
 * (`src/remote/unix.rs:288-296`); this is the same instruction in the shape `ssh2` and the native
 * modules take.
 */
export const BRIDGE_EXEC_OPTIONS = { pty: false } as const;

/** POSIX portable environment variable name: `[A-Za-z_][A-Za-z0-9_]*` (IEEE 1003.1, §3.235). */
const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Shell-quotes one word the way `shell_quote` does (`src/remote/unix.rs:2088-2102`): bare when it
 * is entirely `[A-Za-z0-9@%_+=:,./-]`, single-quoted with `'\''` escaping otherwise.
 */
export function shellQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9@%_+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The remote command for one channel kind — a port of `remote_bridge_command`
 * (`src/remote/unix.rs:2050-2063`), plus the optional `env` prefix.
 *
 * `exec` matters: it replaces the login shell with `herdr`, so there is no shell left holding the
 * ssh session open after the bridge exits. The `--session` flag sits *before* the subcommand
 * because `session::configure_from_args` (`src/session.rs:29`) strips it out of `argv` before
 * `main.rs:550-555` looks at `args[1]` for the subcommand name.
 *
 * Env *values* are shell-quoted; env *names* are validated and rejected, because a name that is
 * not a POSIX identifier could not have worked anyway — the remote `env` refuses it — while an
 * unquoted `X$(id)` would be expanded by the remote shell first. This function's output is a
 * string another machine's shell executes, and it is exported API: the caller finding out at the
 * call site beats a bridge that dies with an unexplained non-zero exit.
 *
 * @throws if any `env` key is not `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function remoteBridgeCommand(
  kind: HerdrChannelKind,
  options: RemoteBridgeCommandOptions = {},
): string {
  const parts = ["exec"];
  const env = options.env ?? {};
  const names = Object.keys(env);
  if (names.length > 0) {
    parts.push("env");
    for (const name of names) {
      if (!POSIX_ENV_NAME.test(name)) {
        throw new Error(
          `${JSON.stringify(name)} is not a POSIX environment variable name ` +
            `([A-Za-z_][A-Za-z0-9_]*); it cannot be passed to the remote \`env\``,
        );
      }
      parts.push(`${name}=${shellQuote(env[name] as string)}`);
    }
  }
  parts.push(shellQuote(options.herdrBinary ?? "herdr"));
  const session = options.session;
  if (session !== undefined && session !== DEFAULT_SESSION_NAME) {
    parts.push("--session", shellQuote(session));
  }
  parts.push(bridgeSubcommand(kind));
  return parts.join(" ");
}
