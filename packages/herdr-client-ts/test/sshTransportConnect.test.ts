/**
 * What `SshHerdrTransport.connect` does with a dial that dies, which is the only part of
 * `src/node/sshTransport.ts` a test can reach without an sshd.
 *
 * `test/live-ssh/sshTransport.live.test.ts` proves the happy path against a real daemon. This
 * proves the *failure* path, and it needs no daemon at all: a `node:net` server that resets the
 * TCP connection before writing an SSH banner is the exact shape a phone with no signal produces,
 * and it is real `ssh2` on this side of it — not a hand-rolled emitter that would only re-state
 * this file's assumptions about ssh2's event sequence back to itself.
 *
 * The sequence being pinned (measured, `ssh2/lib/client.js`): a pre-handshake death emits `error`
 * **twice** — the socket's own failure (`read ECONNRESET`), then `Connection lost before
 * handshake` from the socket's `close` handler. One dial, two events. A `once` listener consumes
 * the first, and the second reaches an `EventEmitter` with no `error` listener, which throws it at
 * the process.
 */
import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SshHerdrTransport } from "../src/node/index.js";

/** A listener that accepts TCP and resets it before the SSH banner. */
let deadPort: number;
let server: Server;

beforeAll(async () => {
  server = createServer((socket) => {
    // RST rather than FIN: it is what a vanished network path produces, and it is what makes
    // ssh2 emit its first `error` (`read ECONNRESET`) before the second one.
    socket.resetAndDestroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  deadPort = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function dialDead(
  onSuppressedError?: (error: Error) => void,
): Promise<SshHerdrTransport> {
  return SshHerdrTransport.connect({
    ssh: {
      host: "127.0.0.1",
      port: deadPort,
      username: "nobody",
      password: "nothing",
      readyTimeout: 5_000,
    },
    herdrBinary: "/nonexistent/herdr",
    ...(onSuppressedError === undefined ? {} : { onSuppressedError }),
  });
}

async function until(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} did not happen within 5000ms`);
}

describe("SshHerdrTransport.connect on a dial that dies before the handshake", () => {
  it("rejects with the first error and absorbs every later one", async () => {
    const suppressed: Error[] = [];
    await expect(dialDead((error) => suppressed.push(error))).rejects.toThrow();
    // The second event is emitted from the socket's `close` handler, one tick or so after the
    // rejection; without the guard it lands on an EventEmitter with no `error` listener and takes
    // the process down instead of arriving here.
    await until("the post-rejection error to be absorbed", () => suppressed.length > 0);
    expect(suppressed.map((error) => error.message)).toContain(
      "Connection lost before handshake",
    );
  });

  it("survives the same dial with no handler supplied", async () => {
    await expect(dialDead()).rejects.toThrow();
    // The handler is optional, the guard is not. This waits out the same window the test above
    // measured the second event arriving in: if the listener were installed only when a handler
    // was supplied, this is the dial that would take the process down.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
});
