/**
 * The one test that proves this package talks to a real herdr server.
 *
 * Every other test in `test/` is byte-level: golden vectors, fixture cross-checks, hand-driven
 * harnesses. They prove the codec agrees with a recording. This one proves it agrees with the
 * program — a server process spawned here, handshaken with over its actual unix socket, streaming
 * actual ANSI bytes back. It is the TypeScript sibling of `tests/observe_terminal_ansi.rs`.
 *
 * It is deliberately outside the default `vitest run` (see `vitest.live.config.ts`): it spawns a
 * process, waits on a shell, and takes seconds, none of which belongs in the codec gate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ClientLaunchMode,
  PROTOCOL_VERSION,
  RenderEncoding,
  assertWelcomeAccepted,
  encodeHelloFrame,
  encodeObserveTerminalFrame,
  type JsonApiClient,
  type TerminalMessage,
  type WelcomeMessage,
} from "../../src/index.js";
import {
  LiveClientStream,
  apiClient,
  isTerminal,
  liveSkipReason,
  readServerLog,
  spawnServer,
  stripAnsiText,
  visualize,
  type SpawnedServer,
} from "./harness.js";

/** The observing client's own geometry — observed frames should be sized to it, not to the pane. */
const CLIENT_COLS = 100;
const CLIENT_ROWS = 30;

const MARKER = "OBSMARKER";
const SECOND_MARKER = "OBSMARKER2";

const skipReason = liveSkipReason();

describe.skipIf(skipReason !== null)("live: TerminalAnsi observe against a real herdr server", () => {
  let server: SpawnedServer;
  let api: JsonApiClient;
  let paneId: string;
  let sizeBefore: string;
  /** Opened by the handshake test and kept open for the size-invariance test that follows it. */
  let stream: LiveClientStream | null = null;

  beforeAll(async () => {
    server = await spawnServer();
    api = apiClient(server);

    const created = await api.request("workspace.create", { cwd: server.base, focus: true });
    expect(created["type"], `workspace.create failed: ${JSON.stringify(created)}`).toBe(
      "workspace_created",
    );
    const rootPane = created["root_pane"] as { pane_id?: unknown } | undefined;
    expect(typeof rootPane?.pane_id).toBe("string");
    paneId = rootPane?.pane_id as string;

    // Put recognizable text on the observed screen so the ANSI blit has content to carry.
    await sendInput(api, paneId, `echo ${MARKER}`);

    sizeBefore = await settledPanePtySize(api, paneId, "BEFORE");
    process.stdout.write(`[live] server pid=${server.pid} pane=${paneId} size_before=${sizeBefore}\n`);
  }, 120_000);

  afterAll(async () => {
    stream?.close();
    // Signals only the pid this harness spawned. Never a name match.
    await server?.stop();
  });

  it("round-trips agent.list and pane.list over the JSON API (one connection per request)", async () => {
    const agents = await api.agentList();
    expect(agents["type"]).toBe("agent_list");
    expect(Array.isArray(agents["agents"])).toBe(true);

    // A second call on the same client proves the connect-per-request contract: the server closes
    // after one line (`src/api/server.rs:139-152`), so a client that reused the socket would hang.
    const panes = await api.paneList();
    expect(panes["type"]).toBe("pane_list");
    const list = panes["panes"] as Array<Record<string, unknown>>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.map((pane) => pane["pane_id"])).toContain(paneId);

    process.stdout.write(
      `[live] agent.list agents=${JSON.stringify(agents["agents"])} pane.list count=${list.length}\n`,
    );
  }, 60_000);

  it("handshakes as TerminalAnsi and receives Terminal frames carrying real ANSI bytes", async () => {
    stream = await LiveClientStream.connect(server);

    stream.send(
      encodeHelloFrame({
        cols: CLIENT_COLS,
        rows: CLIENT_ROWS,
        requestedEncoding: RenderEncoding.TerminalAnsi,
        launchMode: ClientLaunchMode.TerminalAttach,
      }),
    );

    const welcome = await stream.next<WelcomeMessage>(
      (message): message is WelcomeMessage => message.type === "welcome",
      "Welcome",
      20_000,
    );
    process.stdout.write(
      `[live] Welcome version=${welcome.version} encoding=${welcome.encoding} error=${welcome.error}\n`,
    );
    // Throws HandshakeRejectedError / ProtocolVersionMismatchError / EncodingMismatchError.
    assertWelcomeAccepted(welcome, { encoding: RenderEncoding.TerminalAnsi });
    expect(welcome.version).toBe(PROTOCOL_VERSION);

    // Hello only attaches the connection; this is what starts the stream.
    stream.send(encodeObserveTerminalFrame(paneId));

    const first = await nextNonEmptyTerminal(stream, "first Terminal frame", 30_000);
    process.stdout.write(
      `[live] TerminalFrame#1 seq=${first.seq} width=${first.width} height=${first.height} ` +
        `full=${first.full} bytes_len=${first.bytes.length}\n`,
    );
    process.stdout.write(`[live] first 160 bytes: ${visualize(first.bytes, 160)}\n`);

    expect(first.bytes.length).toBeGreaterThan(0);
    expect(
      first.bytes.includes(0x1b),
      `frame carried no ESC: ${visualize(first.bytes, 200)}`,
    ).toBe(true);
    expect(first.seq >= 1n).toBe(true);
    // The frame is rendered for the observing client's geometry, not the pane's PTY.
    expect([first.width, first.height]).toEqual([CLIENT_COLS, CLIENT_ROWS]);
    expect(
      stripAnsiText(first.bytes),
      `observed ANSI stream did not carry the pane's visible text: ${visualize(first.bytes, 400)}`,
    ).toContain(MARKER);

    // Not a one-shot: new pane output must reach the same open stream in a later frame.
    await sendInput(api, paneId, `echo ${SECOND_MARKER}`);
    const second = await terminalFrameContaining(stream, SECOND_MARKER, 30_000);
    process.stdout.write(
      `[live] TerminalFrame#N seq=${second.seq} width=${second.width} height=${second.height} ` +
        `full=${second.full} bytes_len=${second.bytes.length}\n`,
    );
    expect(second.seq > first.seq).toBe(true);
    expect(second.bytes.includes(0x1b)).toBe(true);
  }, 120_000);

  it("does not resize the observed pane's PTY while attached", async () => {
    expect(
      stream,
      "the observe stream was never opened — the handshake test above must pass first",
    ).not.toBeNull();

    const sizeAfter = await panePtySize(api, paneId, "AFTER");
    process.stdout.write(`[live] pane PTY size before=${sizeBefore} after=${sizeAfter}\n`);
    expect(
      sizeAfter,
      `observing resized the pane PTY (${sizeBefore} -> ${sizeAfter}); server log:\n${readServerLog(server)}`,
    ).toBe(sizeBefore);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function sendInput(api: JsonApiClient, paneId: string, text: string): Promise<void> {
  const sent = await api.request("pane.send_input", { pane_id: paneId, text, keys: ["Enter"] });
  expect(sent["type"], `pane.send_input failed: ${JSON.stringify(sent)}`).toBe("ok");
}

async function nextNonEmptyTerminal(
  stream: LiveClientStream,
  what: string,
  timeoutMs: number,
): Promise<TerminalMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = await stream.next(isTerminal, what, Math.max(deadline - Date.now(), 1));
    if (frame.bytes.length > 0) {
      return frame;
    }
  }
}

async function terminalFrameContaining(
  stream: LiveClientStream,
  needle: string,
  timeoutMs: number,
): Promise<TerminalMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = await stream.next(
      isTerminal,
      `Terminal frame containing ${needle}`,
      Math.max(deadline - Date.now(), 1),
    );
    if (stripAnsiText(frame.bytes).includes(needle)) {
      return frame;
    }
  }
}

/**
 * The PTY geometry the pane's shell actually sees, as `"<rows>x<cols>"`.
 *
 * `pane.get` carries no size field (`src/api/schema/panes.rs:398-430`), so the ground truth has to
 * come from inside the pane. Same trick as `tests/observe_terminal_ansi.rs:136`.
 */
async function panePtySize(api: JsonApiClient, paneId: string, label: string): Promise<string> {
  const marker = `SZ${label}`;
  await sendInput(api, paneId, `echo ${marker}:$(stty size | tr ' ' 'x')`);

  const waited = await api.request("pane.wait_for_output", {
    pane_id: paneId,
    source: "recent",
    lines: 40,
    match: { type: "regex", value: `${marker}:[0-9]+x[0-9]+` },
    timeout_ms: 15_000,
  });
  expect(waited["type"], `pane never reported its size for ${label}: ${JSON.stringify(waited)}`).toBe(
    "output_matched",
  );

  const line = waited["matched_line"] as string;
  const at = line.lastIndexOf(`${marker}:`);
  expect(at, `no ${marker} marker in ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0);
  const size = /^[0-9]+x[0-9]+/.exec(line.slice(at + marker.length + 1));
  expect(size, `malformed size in ${JSON.stringify(line)}`).not.toBeNull();
  return (size as RegExpExecArray)[0];
}

/**
 * The same measurement, but only once two consecutive readings agree.
 *
 * A fresh pane starts at the server's own PTY size and is resized to its layout rect on the first
 * virtual render (`src/server/headless.rs:4074`, which passes `resize_panes` while no client is
 * attached). That startup drift is client-independent, so the invariance assertion has to start
 * from the settled size rather than from a reading that raced the initial layout pass.
 */
async function settledPanePtySize(
  api: JsonApiClient,
  paneId: string,
  label: string,
): Promise<string> {
  let last = await panePtySize(api, paneId, `${label}0`);
  for (let round = 1; round < 8; round += 1) {
    await new Promise((r) => setTimeout(r, 250));
    const next = await panePtySize(api, paneId, `${label}${round}`);
    if (next === last) {
      return next;
    }
    last = next;
  }
  throw new Error(`pane PTY size never settled (last reading ${last})`);
}
