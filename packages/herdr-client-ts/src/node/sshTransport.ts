/**
 * {@link HerdrTransport} over `ssh2` — the Node reference implementation of the seam.
 *
 * ⚠️ **This file is not part of the React Native bundle and must never become part of it.** It is
 * reachable only through the `@herdr/client-ts/node` export; the `.` export (`src/index.ts`) never
 * imports anything under `src/node/`. Three things hold that line, in descending order of value:
 *
 *   1. `test/hermesContract.test.ts` walks the real import graph from `src/index.ts` and fails on
 *      any `node:*`/`ssh2`/`src/node/` reachability. **This is the only one that actually catches
 *      a leak** — measured, by adding the leak and watching it go red.
 *   2. `ssh2` is a devDependency, so it is not in the graph a Metro build would install.
 *   3. `exports` maps `.` and `./node` separately; Metro resolves only `.`.
 *
 * Notably *not* on that list: the `tsc --noEmit` Hermes project. `types: []` suppresses only the
 * automatic inclusion of `@types/*`; an explicit `import … from "ssh2"` still resolves through
 * `@types/ssh2`, which drags Node's lib in via its own `/// <reference types="node" />`. A leak
 * therefore type-checks clean. Verified 2026-08-22 — do not rely on the compiler here.
 *
 * Its purpose is to be the thing the React Native native module (iOS libssh2/NMSSH, Android sshj —
 * `mobile/.prd/02-architecture.md` §2.4) has to match. Everything protocol-shaped is therefore in
 * `src/transport.ts`, not here; what is left below is genuinely ssh2-specific: authentication, the
 * exec call, and translating a `ClientChannel`'s events into {@link HerdrChannelHandlers}.
 */
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

import type { RemoteBridgeCommandOptions } from "../transport.js";

import {
  BRIDGE_EXEC_OPTIONS,
  DEFAULT_SESSION_NAME,
  remoteBridgeCommand,
  type HerdrChannel,
  type HerdrChannelClose,
  type HerdrChannelHandlers,
  type HerdrChannelKind,
  type HerdrTransport,
} from "../transport.js";

/**
 * Connection + command options. The command half (`herdrBinary`, `session`, `env`) is
 * {@link RemoteBridgeCommandOptions}, which lives in `src/transport.ts` because a React Native
 * native module has to build the identical string; only `ssh` and `execTimeoutMs` are ssh2's.
 */
export interface SshHerdrTransportOptions extends RemoteBridgeCommandOptions {
  /** Passed to `ssh2`'s `Client.connect` verbatim: host, port, username, privateKey, agent, … */
  ssh: ConnectConfig;
  /** How long `openChannel` waits for the remote exec to be accepted. Default 20s. */
  execTimeoutMs?: number;
  /**
   * An `ssh2` `error` event that had nowhere to go — see {@link SshHerdrTransport.connect}, which
   * absorbs every `error` after the one that settled the connect promise.
   *
   * Omitting it is fine: the events are still counted
   * ({@link SshHerdrTransport.suppressedErrorCount}). It exists because on the *rejected* path
   * there is no transport object to read that counter off — `connect` rejects and the instance is
   * dropped — so a caller that dials into a dead network in a loop (the app's reconnect trickle)
   * has this handler as its only way to see the events at all.
   */
  onSuppressedError?: ((error: Error) => void) | undefined;
}

export { DEFAULT_SESSION_NAME };

class SshChannel implements HerdrChannel {
  readonly kind: HerdrChannelKind;
  private readonly stream: ClientChannel;
  private closed = false;

  constructor(kind: HerdrChannelKind, stream: ClientChannel, handlers: HerdrChannelHandlers) {
    this.kind = kind;
    this.stream = stream;

    let stderr = "";
    let exitCode: number | undefined;
    let signal: string | undefined;
    let error: Error | undefined;

    stream.on("data", (chunk: Buffer) => handlers.onData(new Uint8Array(chunk)));
    stream.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    // `exit` is optional per the SSH2 spec, so it is recorded when it arrives and `close` is what
    // actually terminates the channel — never the other way round.
    stream.on("exit", (code: number | null, signalName?: string) => {
      if (code === null) {
        signal = signalName;
      } else {
        exitCode = code;
      }
    });
    stream.on("error", (err: Error) => {
      error ??= err;
    });
    stream.on("close", () => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      const close: HerdrChannelClose = {};
      if (exitCode !== undefined) close.exitCode = exitCode;
      if (signal !== undefined) close.signal = signal;
      if (stderr.length > 0) close.stderr = stderr;
      if (error !== undefined) close.error = error;
      handlers.onClose(close);
    });
  }

  write(bytes: Uint8Array): void {
    this.stream.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  close(): void {
    // EOF first so the remote's stdin pump can shut the socket's write half down cleanly
    // (`bridge_stdio_to_socket`, `src/remote/unix.rs:583-587`), then tear the channel down.
    this.stream.end();
    this.stream.close();
  }
}

/**
 * One ssh connection, N exec channels.
 *
 * The multiplexing contract of `HerdrTransport` is enforced structurally: {@link connect} is the
 * only place a `Client` is created, and {@link openChannel} can do nothing but `exec` on it.
 * {@link connectionCount} exposes the count so a test can assert it rather than trust the prose.
 */
export class SshHerdrTransport implements HerdrTransport {
  private readonly client: Client;
  private readonly options: SshHerdrTransportOptions;
  private connections = 0;
  private channelsOpened = 0;
  private ended = false;
  private suppressed = 0;
  private lastSuppressed: Error | undefined;

  private constructor(client: Client, options: SshHerdrTransportOptions) {
    this.client = client;
    this.options = options;
  }

  /** ssh connections established. One transport is one host, so this must stay at 1. */
  get connectionCount(): number {
    return this.connections;
  }

  /** Exec channels opened over the lifetime of this transport. */
  get channelCount(): number {
    return this.channelsOpened;
  }

  /**
   * `ssh2` `error` events absorbed because nothing was left to report them to — a repeat emit for a
   * connection whose first error already settled {@link SshHerdrTransport.connect}, or any error
   * after the handshake, which has no request to fail.
   *
   * Always present, handler or not, for the same reason {@link SshHerdrTransport.connectionCount}
   * is: "the ssh link is quietly rotten" needs to be readable without a subscription. Note the one
   * case it cannot cover — a *rejected* connect hands the caller no transport, so those events are
   * only visible through {@link SshHerdrTransportOptions.onSuppressedError}.
   */
  get suppressedErrorCount(): number {
    return this.suppressed;
  }

  /** The most recent absorbed error, for a caller that polls the counter above. */
  get lastSuppressedError(): Error | undefined {
    return this.lastSuppressed;
  }

  static connect(options: SshHerdrTransportOptions): Promise<SshHerdrTransport> {
    return new Promise((resolveTransport, rejectTransport) => {
      const client = new Client();
      const transport = new SshHerdrTransport(client, options);
      /**
       * An `error` event on an emitter with no `error` listener is rethrown by `EventEmitter`, i.e.
       * it takes the process down. Both exits from the ready/error race below therefore have to
       * leave a listener behind, because in both of them ssh2 emits `error` more than once:
       *
       *  - after `ready`, every later failure of the connection (nothing left to reject);
       *  - after a pre-handshake death, a *second* event — measured, `read ECONNRESET` and then
       *    `Connection lost before handshake` from the socket's `close` handler
       *    (`ssh2/lib/client.js:753` via `:815`). This is the shape a phone with no signal produces
       *    on every dial, so a reconnect loop hits it repeatedly; `test/sshTransportConnect.test.ts`
       *    reproduces it against real ssh2.
       *
       * Absorbed is not ignored: the first error still settles the promise, and every one after it
       * is counted and offered to {@link SshHerdrTransportOptions.onSuppressedError}.
       */
      const absorb = (error: Error): void => {
        transport.suppressed += 1;
        transport.lastSuppressed = error;
        try {
          options.onSuppressedError?.(error);
        } catch {
          // A handler that throws is isolated here rather than allowed to propagate: this call is
          // inside an 'error' listener, so an escaping exception would recreate the exact crash the
          // listener exists to prevent. The counter above already recorded the event.
        }
      };
      const onEarlyError = (error: Error): void => {
        client.removeListener("ready", onReady);
        client.on("error", absorb);
        rejectTransport(error);
      };
      const onReady = (): void => {
        client.removeListener("error", onEarlyError);
        transport.connections += 1;
        client.on("error", absorb);
        resolveTransport(transport);
      };
      client.once("ready", onReady);
      client.once("error", onEarlyError);
      client.connect(options.ssh);
    });
  }

  openChannel(kind: HerdrChannelKind, handlers: HerdrChannelHandlers): Promise<HerdrChannel> {
    if (this.ended) {
      return Promise.reject(new Error("transport is closed"));
    }
    const command = remoteBridgeCommand(kind, this.options);
    const timeoutMs = this.options.execTimeoutMs ?? 20_000;

    return new Promise((resolveChannel, rejectChannel) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectChannel(new Error(`remote exec did not start within ${timeoutMs}ms: ${command}`));
      }, timeoutMs);

      // The no-pty requirement is the protocol layer's, not this file's: see
      // `BRIDGE_EXEC_OPTIONS` (`src/transport.ts`), which is where a React Native implementer
      // reads it. Restating it here as a literal is how the two would drift.
      this.client.exec(command, BRIDGE_EXEC_OPTIONS, (error, stream) => {
        if (settled) {
          stream?.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          rejectChannel(error);
          return;
        }
        this.channelsOpened += 1;
        resolveChannel(new SshChannel(kind, stream, handlers));
      });
    });
  }

  close(): void {
    this.ended = true;
    this.client.end();
  }
}
