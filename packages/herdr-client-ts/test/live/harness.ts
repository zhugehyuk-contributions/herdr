/**
 * Test-only plumbing for talking to a **real** herdr server from Node.
 *
 * Everything Node-specific lives here so `src/` stays Hermes-clean: the codec under test is handed
 * a socket by this file and never imports a built-in itself.
 *
 * ⚠️ Process safety. The developer running this has long-lived `herdr server` daemons of their own,
 * spawned from the same binary name. Nothing in this file may ever match processes by name —
 * no `pkill`, no `killall`. {@link SpawnedServer.stop} signals exactly one pid: the child this
 * harness itself created. That is also why the server gets its own `XDG_CONFIG_HOME` /
 * `XDG_RUNTIME_DIR` under `/tmp` and never touches `~/.config/herdr`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import {
  JsonApiClient,
  LineAccumulator,
  ServerMessageReader,
  type JsonApiConnection,
  type ServerMessage,
  type TerminalMessage,
  type WireError,
} from "../../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `packages/herdr-client-ts/test/live` -> repo root. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

/**
 * The debug binary built by `cargo build`, never `~/.local/bin/herdr`: the installed one is what
 * the developer's own daemons run, and it may be a different build than this worktree's protocol.
 */
export const SERVER_BINARY = process.env["HERDR_LIVE_BINARY"] ?? join(REPO_ROOT, "target/debug/herdr");

export function serverBinaryExists(): boolean {
  return existsSync(SERVER_BINARY);
}

/**
 * Why the skip is loud: a live test that quietly turns into a no-op is worse than no live test,
 * because the suite still reports green. Set `HERDR_LIVE_REQUIRE=1` in any context where the
 * binary is supposed to exist (CI) and the absence becomes a failure instead.
 */
export function liveSkipReason(): string | null {
  if (serverBinaryExists()) {
    return null;
  }
  const reason =
    `herdr server binary not found at ${SERVER_BINARY} — ` +
    "build it with `cargo build` (or point HERDR_LIVE_BINARY at one) to run the live suite";
  if (process.env["HERDR_LIVE_REQUIRE"] === "1") {
    throw new Error(`HERDR_LIVE_REQUIRE=1 but ${reason}`);
  }
  process.stderr.write(`\n*** SKIPPING LIVE SUITE ***\n${reason}\n\n`);
  return reason;
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface SpawnedServer {
  base: string;
  apiSocket: string;
  clientSocket: string;
  pid: number;
  logPath: string;
  stop: () => Promise<void>;
}

/**
 * Short by necessity: a `sockaddr_un.sun_path` is ~104 bytes on macOS, and the runtime dir has
 * `/runtime/herdr-client.sock` appended to it. A base under the session scratch dir already
 * overflows that (observed: `local socket name length exceeds capacity of sun_path`), so `/tmp` is
 * not laziness — it is the only room available. Mirrors `tests/observe_terminal_ansi.rs:29`.
 */
function uniqueBase(): string {
  return `/tmp/herdr-ts-live-${process.pid}-${Date.now()}`;
}

/**
 * Spawns an XDG-isolated headless server and waits for both sockets.
 *
 * **No PTY.** `tests/observe_terminal_ansi.rs:97` launches the server through `portable_pty`, which
 * suggested a tty was required; it is not. Measured on this tree: with stdio on pipes and stdin on
 * `/dev/null`, both sockets appear in ~500 ms and `agent.list` answers normally. So a plain
 * `child_process.spawn` is enough and no `script -q /dev/null` wrapper is needed — which also keeps
 * the child a direct descendant whose pid we can signal precisely.
 */
export async function spawnServer(): Promise<SpawnedServer> {
  const base = uniqueBase();
  const configHome = join(base, "config");
  const runtimeDir = join(base, "runtime");
  const apiSocket = join(runtimeDir, "herdr.sock");
  const clientSocket = join(runtimeDir, "herdr-client.sock");
  const logPath = join(base, "server.log");

  mkdirSync(join(configHome, "herdr"), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(configHome, "herdr/config.toml"), "onboarding = false\n");

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env["HERDR_CLIENT_SOCKET_PATH"];
  delete env["HERDR_ENV"];
  env["XDG_CONFIG_HOME"] = configHome;
  env["XDG_RUNTIME_DIR"] = runtimeDir;
  env["HERDR_SOCKET_PATH"] = apiSocket;
  env["SHELL"] = "/bin/sh";

  const child: ChildProcess = spawn(SERVER_BINARY, ["server"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });

  let exited: { code: number | null; signal: string | null } | null = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`failed to spawn ${SERVER_BINARY}`);
  }

  const stop = async (): Promise<void> => {
    writeFileSync(logPath, log);
    if (exited === null) {
      // Signal this pid and only this pid.
      child.kill("SIGTERM");
      for (let i = 0; i < 100 && exited === null; i += 1) {
        await delay(20);
      }
      if (exited === null) {
        child.kill("SIGKILL");
        await delay(200);
      }
    }
    rmSync(base, { recursive: true, force: true });
  };

  try {
    await waitForSocket(apiSocket, 15_000, () => exited, () => log);
    await waitForSocket(clientSocket, 15_000, () => exited, () => log);
  } catch (error) {
    await stop();
    throw error;
  }

  return { base, apiSocket, clientSocket, pid, logPath, stop };
}

async function waitForSocket(
  path: string,
  timeoutMs: number,
  exited: () => { code: number | null; signal: string | null } | null,
  log: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    const dead = exited();
    if (dead !== null) {
      throw new Error(
        `server exited (code=${dead.code} signal=${dead.signal}) before ${path} appeared:\n${log()}`,
      );
    }
    await delay(50);
  }
  throw new Error(`${path} never appeared within ${timeoutMs}ms; server output:\n${log()}`);
}

/** Reads whatever the server printed, for failure messages. */
export function readServerLog(server: SpawnedServer): string {
  try {
    return readFileSync(server.logPath, "utf8");
  } catch {
    return "(no log captured)";
  }
}

// ---------------------------------------------------------------------------
// JSON API transport (node:net)
// ---------------------------------------------------------------------------

/**
 * A {@link JsonApiConnection} over a unix socket. One instance per request — see `src/jsonApi.ts`
 * for why the server permits nothing else.
 */
function connectJsonApi(path: string, timeoutMs: number): Promise<JsonApiConnection> {
  return new Promise((resolveConn, rejectConn) => {
    const socket = createConnection({ path });
    const lines = new LineAccumulator();
    const pending: string[] = [];
    let waiter: ((line: string) => void) | null = null;
    let failure: Error | null = null;
    let waiterReject: ((error: Error) => void) | null = null;

    const fail = (error: Error): void => {
      failure = error;
      waiterReject?.(error);
      waiter = null;
      waiterReject = null;
    };

    socket.on("data", (chunk: Buffer) => {
      for (const line of lines.push(new Uint8Array(chunk))) {
        if (waiter !== null) {
          const deliver = waiter;
          waiter = null;
          waiterReject = null;
          deliver(line);
        } else {
          pending.push(line);
        }
      }
    });
    socket.on("error", (error: Error) => fail(error));
    socket.on("close", () => fail(new Error("API socket closed before a complete response line")));

    socket.once("connect", () => {
      resolveConn({
        write: (line: string) => {
          socket.write(line);
        },
        readLine: () =>
          new Promise<string>((resolveLine, rejectLine) => {
            const ready = pending.shift();
            if (ready !== undefined) {
              resolveLine(ready);
              return;
            }
            if (failure !== null) {
              rejectLine(failure);
              return;
            }
            const timer = setTimeout(
              () => fail(new Error(`no API response within ${timeoutMs}ms`)),
              timeoutMs,
            );
            waiter = (line) => {
              clearTimeout(timer);
              resolveLine(line);
            };
            waiterReject = (error) => {
              clearTimeout(timer);
              rejectLine(error);
            };
          }),
        close: () => {
          socket.destroy();
        },
      });
    });
    socket.once("error", rejectConn);
  });
}

export function apiClient(server: SpawnedServer, timeoutMs = 15_000): JsonApiClient {
  return new JsonApiClient(() => connectJsonApi(server.apiSocket, timeoutMs));
}

// ---------------------------------------------------------------------------
// Binary client stream (node:net)
// ---------------------------------------------------------------------------

/**
 * The observing client's end of `herdr-client.sock`, driven by {@link ServerMessageReader}.
 *
 * Frames whose variant this codec does not decode (`Notify`, `Compressed`, …) are expected on a
 * real connection: `decodeServerMessage` throws `UnsupportedVariantError` for them by design. The
 * offending frame has already been consumed, so we salvage `decodedBefore`, record the variant and
 * keep reading — which is the recovery `src/stream.ts` documents, exercised for real here.
 */
export class LiveClientStream {
  readonly messages: ServerMessage[] = [];
  readonly undecodable: string[] = [];
  private readonly socket: Socket;
  private readonly reader = new ServerMessageReader();
  private cursor = 0;
  private wake: (() => void) | null = null;
  private failure: Error | null = null;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.ingest(new Uint8Array(chunk)));
    socket.on("error", (error: Error) => {
      this.failure = error;
      this.wake?.();
    });
    socket.on("close", () => {
      this.failure ??= new Error("client socket closed by the server");
      this.wake?.();
    });
  }

  static connect(server: SpawnedServer): Promise<LiveClientStream> {
    return new Promise((resolveStream, rejectStream) => {
      const socket = createConnection({ path: server.clientSocket });
      socket.once("connect", () => resolveStream(new LiveClientStream(socket)));
      socket.once("error", rejectStream);
    });
  }

  private ingest(chunk: Uint8Array): void {
    try {
      this.messages.push(...this.reader.push(chunk));
    } catch (error) {
      const wire = error as WireError;
      if (wire.code === "unsupported-variant") {
        this.messages.push(...((wire.decodedBefore ?? []) as ServerMessage[]));
        this.undecodable.push(wire.message);
      } else {
        this.failure = error as Error;
      }
    }
    this.wake?.();
  }

  send(bytes: Uint8Array): void {
    this.socket.write(bytes);
  }

  /** Waits for the next message matching `predicate`, consuming everything before it. */
  async next<T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    what: string,
    timeoutMs: number,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.messages.length) {
        const message = this.messages[this.cursor] as ServerMessage;
        this.cursor += 1;
        if (predicate(message)) {
          return message;
        }
      }
      if (this.failure !== null) {
        throw new Error(
          `${what}: stream ended (${this.failure.message}); ` +
            `decoded ${this.messages.length} message(s), undecodable: ${JSON.stringify(this.undecodable)}`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `${what}: nothing matched within ${timeoutMs}ms; ` +
            `decoded ${this.messages.length} message(s) ` +
            `(${this.messages.map((m) => m.type).join(",")}), ` +
            `undecodable: ${JSON.stringify(this.undecodable)}`,
        );
      }
      await new Promise<void>((resolveWake) => {
        const timer = setTimeout(() => {
          this.wake = null;
          resolveWake();
        }, Math.min(remaining, 250));
        this.wake = () => {
          clearTimeout(timer);
          this.wake = null;
          resolveWake();
        };
      });
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

export function isTerminal(message: ServerMessage): message is TerminalMessage {
  return message.type === "terminal";
}

// ---------------------------------------------------------------------------
// ANSI helpers (ports of tests/observe_terminal_ansi.rs:300-358)
// ---------------------------------------------------------------------------

/**
 * Projects printable text out of an ANSI stream. `BlitEncoder` emits a cursor move and an SGR run
 * before nearly every cell, so screen text is never contiguous in the raw bytes and a substring
 * check has to run against this projection.
 */
export function stripAnsiText(bytes: Uint8Array): string {
  let out = "";
  let idx = 0;
  while (idx < bytes.length) {
    const byte = bytes[idx] as number;
    if (byte !== 0x1b) {
      if (byte >= 0x20 && byte <= 0x7e) {
        out += String.fromCharCode(byte);
      }
      idx += 1;
      continue;
    }
    idx += 1;
    const next = bytes[idx];
    if (next === undefined) {
      break;
    }
    if (next === 0x5b) {
      // CSI: parameters/intermediates until a final byte in 0x40..=0x7e.
      idx += 1;
      while (idx < bytes.length && !((bytes[idx] as number) >= 0x40 && (bytes[idx] as number) <= 0x7e)) {
        idx += 1;
      }
      idx += 1;
    } else if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f) {
      // OSC and friends: until BEL or ST (ESC \).
      idx += 1;
      while (idx < bytes.length) {
        if (bytes[idx] === 0x07) {
          idx += 1;
          break;
        }
        if (bytes[idx] === 0x1b && bytes[idx + 1] === 0x5c) {
          idx += 2;
          break;
        }
        idx += 1;
      }
    } else {
      idx += 1;
    }
  }
  return out;
}

/** Renders bytes for a failure message / receipt, with escapes made visible. */
export function visualize(bytes: Uint8Array, limit: number): string {
  let out = "";
  for (const byte of bytes.subarray(0, limit)) {
    if (byte === 0x1b) {
      out += "<ESC>";
    } else if (byte === 0x07) {
      out += "<BEL>";
    } else if (byte === 0x0a) {
      out += "\\n";
    } else if (byte === 0x0d) {
      out += "\\r";
    } else if (byte >= 0x20 && byte <= 0x7e) {
      out += String.fromCharCode(byte);
    } else {
      out += `<${byte.toString(16).padStart(2, "0")}>`;
    }
  }
  return out;
}
