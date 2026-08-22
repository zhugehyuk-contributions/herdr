/**
 * What `SshHerdrTransport.connect` does with a dial that dies, which is the only part of
 * `src/node/sshTransport.ts` a test can reach without an sshd.
 *
 * `test/live-ssh/sshTransport.live.test.ts` proves the happy path against a real daemon. This
 * proves the *failure* path, and it needs no daemon at all: a `node:net` server that kills the TCP
 * connection before writing an SSH banner is the exact shape a phone with no signal produces, and
 * it is real `ssh2` on this side of it — not a hand-rolled emitter that would only re-state this
 * file's assumptions about ssh2's event sequence back to itself.
 *
 * The sequence being pinned: a connection that dies *after* the socket is established but before
 * the banner emits `error` **twice** — the socket's own failure (`read ECONNRESET`), then
 * `Connection lost before handshake` from ssh2's socket `close` handler
 * (`ssh2/lib/client.js:751` via `:815`). One dial, two events. A `once` listener consumes the
 * first, and the second reaches an `EventEmitter` with no `error` listener, which throws it at the
 * process. That second event is the whole reason `connect`'s guard exists.
 *
 * **Which death is used matters, and this file used to get it wrong.** Resetting the connection
 * from the server's `connection` handler — i.e. the instant the accept completes — races the
 * client's own `connect(2)`, and that race is decided by the kernel, not by ssh2:
 *
 *   - macOS (arm64, node 26.4.0): the client's connect completes first, `net` emits `connect`, and
 *     the RST arrives as `read ECONNRESET`. 100/100 dials.
 *   - Linux (node 24.19.0, arm64 and x64): the RST is folded into the connect itself, which fails
 *     with `connect ECONNRESET`. `net` never emits `connect`, so ssh2 never sets `wasConnected`
 *     (`ssh2/lib/client.js:765`), so the `if (wasConnected && !sawHeader)` at `:751` is false and
 *     `Connection lost before handshake` is **never emitted**. One dial, one event. 100/100 dials.
 *
 * So the two-event sequence was a darwin measurement presented as universal, and on hosted Linux
 * the wait for the second event ran out — invisibly, because every budget in this file was also
 * vitest's default 5000ms `testTimeout`, so the harness always killed the test before its own
 * diagnostic could print. Both halves are fixed below: the dials that must produce two events wait
 * for the client to speak before killing the connection (deterministic on both platforms, 50/50
 * dials each), the budgets form a strict ladder, and every wait that can run out says what it saw.
 */
import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SshHerdrTransport } from "../src/node/index.js";

/**
 * Budget ladder — each number is strictly smaller than the one that bounds it.
 *
 * `READY_TIMEOUT_MS` bounds the dial (ssh2 rejects with its own handshake timeout), then
 * `ABSORB_WINDOW_MS` bounds the wait for the follow-up error, and the harness budget is larger
 * than their sum. Without that ordering a failure arrives as vitest's contentless
 * "Test timed out in 5000ms" instead of the diagnostics below, which is precisely how the Linux
 * divergence documented above stayed unreadable.
 */
const READY_TIMEOUT_MS = 5_000;
const ABSORB_WINDOW_MS = 5_000;
const TEST_TIMEOUT_MS = 20_000;

/**
 * How long a test with no `onSuppressedError` handler stays alive after the rejection, so that a
 * missing guard has time to throw the second event at the process.
 *
 * Measured gap between the two `error` events: 0–1ms on both platforms above, 50 dials each — so
 * this is ~500x headroom rather than a number chosen to feel safe. It is also not a single point of
 * failure: an unhandled `error` is attributed to the whole test file, so an undersized window would
 * degrade to "reported against a later test in this file", not to a miss.
 */
const POST_REJECTION_WINDOW_MS = 500;

/** Accepts TCP and resets immediately — RST vs. the client's `connect(2)`, decided by the kernel. */
let connectResetPort: number;
let connectResetServer: Server;

/** Accepts TCP and resets only once the client has spoken, so the socket is provably established. */
let establishedResetPort: number;
let establishedResetServer: Server;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

beforeAll(async () => {
  // RST rather than FIN on both: it is what a vanished network path produces, and it is what makes
  // ssh2 emit `read ECONNRESET` rather than a clean end. The no-op `error` listeners are for the
  // *server's* half of the reset (EPIPE/ECONNRESET on write-after-reset); an unhandled one would
  // take the run down and be misread as the client-side guard failing.
  connectResetServer = createServer((socket) => {
    socket.on("error", () => {});
    socket.resetAndDestroy();
  });
  establishedResetServer = createServer((socket) => {
    socket.on("error", () => {});
    // The client's SSH identification line. Waiting for it is what makes the two-`error` sequence
    // deterministic across platforms: bytes arrived, therefore the socket reached ESTABLISHED,
    // therefore `net` emitted `connect` and ssh2 set `wasConnected`. Nothing is ever written back,
    // so `sawHeader` stays false and the `close` handler emits the second error.
    socket.once("data", () => socket.resetAndDestroy());
  });
  connectResetPort = await listen(connectResetServer);
  establishedResetPort = await listen(establishedResetServer);
});

afterAll(async () => {
  await new Promise<void>((resolve) => connectResetServer.close(() => resolve()));
  await new Promise<void>((resolve) => establishedResetServer.close(() => resolve()));
});

function dialDead(
  port: number,
  onSuppressedError?: (error: Error) => void,
): Promise<SshHerdrTransport> {
  return SshHerdrTransport.connect({
    ssh: {
      host: "127.0.0.1",
      port,
      username: "nobody",
      password: "nothing",
      readyTimeout: READY_TIMEOUT_MS,
    },
    herdrBinary: "/nonexistent/herdr",
    ...(onSuppressedError === undefined ? {} : { onSuppressedError }),
  });
}

/** The error `connect` rejected with. Resolving is a failure — no banner was ever sent. */
async function rejectionOf(dial: Promise<SshHerdrTransport>): Promise<Error> {
  const settled = await dial.then(
    (transport) => ({ ok: true as const, transport }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (settled.ok) {
    settled.transport.close();
    throw new Error("connect resolved against a listener that never sends an SSH banner");
  }
  expect(settled.error).toBeInstanceOf(Error);
  return settled.error as Error;
}

/**
 * `syscall` is the load-bearing field: `connect` means the socket never reached ESTABLISHED and
 * ssh2 will therefore emit no second error, `read` means it did. That one word is the difference
 * between the two platform behaviours in this file's header.
 */
function describeError(error: Error): string {
  const detail = error as Error & { code?: string; syscall?: string; level?: string };
  const parts = [JSON.stringify(error.message)];
  if (detail.code !== undefined) parts.push(`code=${detail.code}`);
  if (detail.syscall !== undefined) parts.push(`syscall=${detail.syscall}`);
  if (detail.level !== undefined) parts.push(`level=${detail.level}`);
  return parts.join(" ");
}

function diagnose(rejection: Error, suppressed: readonly Error[]): string {
  const absorbed =
    suppressed.length === 0
      ? "none"
      : suppressed.map((error) => describeError(error)).join(" ; ");
  return (
    `rejected with ${describeError(rejection)}` +
    ` | absorbed ${suppressed.length} later error(s): ${absorbed}` +
    ` | ${process.platform}/${process.arch} node ${process.version}`
  );
}

async function until(
  what: string,
  predicate: () => boolean,
  diagnostic: () => string,
): Promise<void> {
  const started = Date.now();
  const deadline = started + ABSORB_WINDOW_MS;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `${what} did not happen within ${ABSORB_WINDOW_MS}ms` +
      ` (waited ${Date.now() - started}ms) — ${diagnostic()}`,
  );
}

describe("SshHerdrTransport.connect on a dial that dies before the handshake", () => {
  it(
    "rejects with the first error and absorbs every later one",
    async () => {
      const suppressed: Error[] = [];
      const rejection = await rejectionOf(
        dialDead(establishedResetPort, (error) => suppressed.push(error)),
      );
      // The second event is emitted from the socket's `close` handler, a tick or so after the
      // rejection; without the guard it lands on an EventEmitter with no `error` listener and takes
      // the process down instead of arriving here.
      await until(
        "the post-rejection error to be absorbed",
        () => suppressed.length > 0,
        () => diagnose(rejection, suppressed),
      );
      expect(
        suppressed.map((error) => error.message),
        diagnose(rejection, suppressed),
      ).toContain("Connection lost before handshake");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "survives the same dial with no handler supplied",
    async () => {
      await rejectionOf(dialDead(establishedResetPort));
      // The handler is optional, the guard is not. This waits out the same window the test above
      // measured the second event arriving in: if the listener were installed only when a handler
      // was supplied, this is the dial that would take the process down.
      await new Promise((resolve) => setTimeout(resolve, POST_REJECTION_WINDOW_MS));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects a dial killed before the socket is established, on either platform's terms",
    async () => {
      const suppressed: Error[] = [];
      const rejection = await rejectionOf(
        dialDead(connectResetPort, (error) => suppressed.push(error)),
      );
      // Deliberately weaker than the test above, and the header says why: how many `error` events
      // this death produces is the kernel's decision (one on Linux, two on macOS), so pinning a
      // count or the `Connection lost before handshake` string here would pin a platform. What is
      // platform-independent is that the dial fails with the reset rather than hanging until
      // `readyTimeout`, and that whatever ssh2 emits afterwards reaches the guard instead of the
      // process — which is what surviving the window below proves.
      expect(rejection.message, diagnose(rejection, suppressed)).toMatch(/ECONNRESET/);
      await new Promise((resolve) => setTimeout(resolve, POST_REJECTION_WINDOW_MS));
    },
    TEST_TIMEOUT_MS,
  );
});
