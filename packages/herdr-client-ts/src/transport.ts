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
  LineAccumulator,
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

/**
 * Reads newline-delimited lines off a channel, with both a pull (`nextLine`) and a push
 * (`onLine`) face because the two API lifetimes need different ones: a request/response call pulls
 * exactly one line, a subscription is pushed lines forever.
 *
 * Lines that arrive before anyone asks are queued, never dropped — see the note on
 * {@link HerdrChannelHandlers} about why bytes can beat the caller.
 */
class NdjsonChannel {
  private readonly lines = new LineAccumulator();
  private readonly queue: string[] = [];
  private channel: HerdrChannel | null = null;
  private failure: Error | null = null;
  private waiter: ((line: string) => void) | null = null;
  private waiterReject: ((error: Error) => void) | null = null;
  private push: ((line: string) => void) | null = null;

  static async open(
    transport: HerdrTransport,
    kind: HerdrChannelKind,
    onLine?: (line: string) => void,
  ): Promise<NdjsonChannel> {
    const self = new NdjsonChannel();
    self.push = onLine ?? null;
    self.channel = await transport.openChannel(kind, {
      onData: (chunk) => self.ingest(chunk),
      onClose: (close) => self.finish(close),
    });
    return self;
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
      if (this.push !== null) {
        this.push(line);
        continue;
      }
      const deliver = this.waiter;
      if (deliver !== null) {
        this.waiter = null;
        this.waiterReject = null;
        deliver(line);
      } else {
        this.queue.push(line);
      }
    }
  }

  private finish(close: HerdrChannelClose): void {
    this.fail(close.error ?? new Error(describeClose("API bridge channel closed", close)));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const reject = this.waiterReject;
    this.waiter = null;
    this.waiterReject = null;
    reject?.(this.failure);
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

  close(): void {
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
   * Opens the channel and sends the `events.subscribe` request. Returns as soon as the request is
   * written; the first line the server sends back is the `subscription_started` acknowledgement,
   * delivered through `onLine` like any other.
   */
  static async subscribe(
    transport: HerdrTransport,
    subscriptions: ReadonlyArray<{ type: string } & Record<string, unknown>>,
    onLine: (line: string) => void,
    id = "ts-events",
  ): Promise<JsonApiEventStream> {
    const ndjson = await NdjsonChannel.open(transport, HerdrChannelKind.ApiStream, onLine);
    await ndjson.write(
      `${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`,
    );
    return new JsonApiEventStream(ndjson);
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
   * A frame this codec deliberately does not decode (`Notify`, `Compressed`, …). Expected traffic
   * on a real connection, not an error: `decodeServerMessage` throws `UnsupportedVariantError`, the
   * frame has already been consumed, and the stream stays in sync. Omit this and such frames are
   * dropped silently, which is the documented recovery in `src/stream.ts`.
   */
  onUndecodable?: ((error: WireError) => void) | undefined;
  /** A frame that broke the stream, or the channel ending. Terminal either way. */
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
 */
export class ServerMessageChannel {
  private readonly frames: FrameReader;
  private readonly handlers: ServerMessageChannelHandlers;
  private channel: HerdrChannel | null = null;

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
      onClose: (close) => handlers.onClose(close),
    });
    return self;
  }

  private ingest(chunk: Uint8Array): void {
    let payloads: Uint8Array[];
    try {
      payloads = this.frames.push(chunk);
    } catch (error) {
      // Framing errors are terminal: an oversized prefix desynchronizes the stream and
      // `FrameReader` poisons itself (`src/framing.ts:28`). Salvage what came before, then stop.
      const wire = error as WireError;
      for (const payload of (wire.decodedBefore ?? []) as Uint8Array[]) {
        this.decodeOne(payload);
      }
      this.handlers.onError?.(wire);
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
      const wire = error as WireError;
      if (wire.code === "unsupported-variant") {
        this.handlers.onUndecodable?.(wire);
      } else {
        this.handlers.onError?.(wire);
      }
      return;
    }
    this.handlers.onMessage(message);
  }

  /** Sends one already-framed `ClientMessage` (`encodeHelloFrame`, `encodeObserveTerminalFrame`). */
  send(bytes: Uint8Array): void | Promise<void> {
    return this.channel?.write(bytes);
  }

  close(): void {
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
