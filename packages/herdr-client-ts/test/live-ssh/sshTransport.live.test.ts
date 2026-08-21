/**
 * The ssh path, end to end, against a real herdr server.
 *
 * `test/live/observeTerminal.live.test.ts` proves the codec agrees with the program over a unix
 * socket. This proves the same scenario survives the transport the app actually uses: nothing here
 * opens a socket path. Every byte goes `ssh exec` -> `herdr remote-{api,client}-bridge` ->
 * `bridge_stdio_to_socket` (`src/remote/unix.rs:568-590`) -> the server's socket, and back.
 *
 * That end-to-end claim is the point, but the *contract* assertions are what the fake transport
 * could not make: one ssh connection carrying every channel, one channel per API request, and the
 * resident client-stream channel living alongside them.
 *
 * Isolation: an sshd generated for this test (`sshHarness.ts` — no developer key, no `~/.ssh`), a
 * herdr server with its own `XDG_*` (`../live/harness.ts`), and the bridge pointed at that server
 * through the command's `env` prefix. Nothing here can reach the developer's own daemons.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ClientLaunchMode,
  HerdrChannelKind,
  PROTOCOL_VERSION,
  RenderEncoding,
  ServerMessageChannel,
  assertWelcomeAccepted,
  createTransportJsonApiClient,
  describeClose,
  encodeHelloFrame,
  encodeObserveTerminalFrame,
  type JsonApiClient,
  type ServerMessage,
  type TerminalMessage,
  type WelcomeMessage,
} from "../../src/index.js";
import { SshHerdrTransport } from "../../src/node/index.js";
import {
  SERVER_BINARY,
  serverBinaryExists,
  spawnServer,
  stripAnsiText,
  visualize,
  type SpawnedServer,
} from "../live/harness.js";
import { findSshd, spawnScratchSshd, type ScratchSshd } from "./sshHarness.js";
import { readFileSync } from "node:fs";

const CLIENT_COLS = 100;
const CLIENT_ROWS = 30;
const MARKER = "SSHMARKER";

/**
 * Loud, like `liveSkipReason` in the unix harness and for the same reason: a live test that
 * quietly becomes a no-op still reports green. `HERDR_LIVE_REQUIRE=1` turns absence into failure.
 */
function sshLiveSkipReason(): string | null {
  const reasons: string[] = [];
  if (!serverBinaryExists()) {
    reasons.push(`herdr server binary not found at ${SERVER_BINARY} — build it with \`cargo build\``);
  }
  if (findSshd() === null) {
    reasons.push("no sshd binary found (set HERDR_LIVE_SSHD to one)");
  }
  if (reasons.length === 0) {
    return null;
  }
  const reason = reasons.join("; ");
  if (process.env["HERDR_LIVE_REQUIRE"] === "1") {
    throw new Error(`HERDR_LIVE_REQUIRE=1 but ${reason}`);
  }
  process.stderr.write(`\n*** SKIPPING LIVE SSH SUITE ***\n${reason}\n\n`);
  return reason;
}

const skipReason = sshLiveSkipReason();

describe.skipIf(skipReason !== null)("live: herdr over an ssh transport", () => {
  let server: SpawnedServer;
  let sshd: ScratchSshd;
  let transport: SshHerdrTransport;
  let api: JsonApiClient;
  let paneId: string;

  beforeAll(async () => {
    server = await spawnServer();
    sshd = await spawnScratchSshd(findSshd() as string, server.base);

    transport = await SshHerdrTransport.connect({
      ssh: {
        host: "127.0.0.1",
        port: sshd.port,
        username: sshd.username,
        privateKey: readFileSync(sshd.privateKeyPath),
      },
      // Absolute, because ssh's non-interactive PATH is not the developer's.
      herdrBinary: SERVER_BINARY,
      // Points the bridge at THIS server. Without it the bridge would resolve the default socket
      // paths — i.e. the developer's own daemon.
      env: {
        XDG_CONFIG_HOME: `${server.base}/config`,
        XDG_RUNTIME_DIR: `${server.base}/runtime`,
        HERDR_SOCKET_PATH: server.apiSocket,
      },
    });
    api = createTransportJsonApiClient(transport);

    const created = await api.request("workspace.create", { cwd: server.base, focus: true });
    expect(created["type"], `workspace.create failed: ${JSON.stringify(created)}`).toBe(
      "workspace_created",
    );
    paneId = (created["root_pane"] as { pane_id: string }).pane_id;
    await sendInput(api, paneId, `echo ${MARKER}`);

    process.stdout.write(
      `[ssh] server pid=${server.pid} sshd pid=${sshd.pid} port=${sshd.port} pane=${paneId}\n`,
    );
  }, 120_000);

  afterAll(async () => {
    transport?.close();
    await sshd?.stop();
    await server?.stop();
  });

  it("round-trips the JSON API through remote-api-bridge, one exec channel per request", async () => {
    const before = transport.channelCount;

    const agents = await api.agentList();
    expect(agents["type"]).toBe("agent_list");
    const panes = await api.paneList();
    expect(panes["type"]).toBe("pane_list");
    expect((panes["panes"] as Array<Record<string, unknown>>).map((p) => p["pane_id"])).toContain(
      paneId,
    );

    // Two requests, two channels. The API server answers one line per connection and returns
    // (`src/api/server.rs:139-152`), so a reused channel would have hung on the second call.
    expect(transport.channelCount - before).toBe(2);
    process.stdout.write(
      `[ssh] api ok; connections=${transport.connectionCount} channels=${transport.channelCount}\n`,
    );
  }, 60_000);

  it("streams real ANSI Terminal frames through remote-client-bridge", async () => {
    const messages: ServerMessage[] = [];
    const undecodable: string[] = [];
    let closed: string | null = null;
    let wake: (() => void) | null = null;
    const bump = (): void => {
      const fire = wake;
      wake = null;
      fire?.();
    };

    const stream = await ServerMessageChannel.open(transport, {
      onMessage: (message) => {
        messages.push(message);
        bump();
      },
      onUndecodable: (error) => {
        undecodable.push(error.message);
      },
      onError: (error) => {
        closed ??= error.message;
        bump();
      },
      onClose: (close) => {
        closed ??= describeClose("client bridge closed", close);
        bump();
      },
    });

    let cursor = 0;
    const next = async <T extends ServerMessage>(
      predicate: (message: ServerMessage) => message is T,
      what: string,
      timeoutMs: number,
    ): Promise<T> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        while (cursor < messages.length) {
          const message = messages[cursor] as ServerMessage;
          cursor += 1;
          if (predicate(message)) {
            return message;
          }
        }
        if (closed !== null) {
          throw new Error(`${what}: ${closed}; undecodable=${JSON.stringify(undecodable)}`);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `${what}: nothing matched within ${timeoutMs}ms (decoded ` +
              `${messages.map((m) => m.type).join(",")}; undecodable=${JSON.stringify(undecodable)})`,
          );
        }
        await new Promise<void>((resolveWake) => {
          const timer = setTimeout(() => {
            wake = null;
            resolveWake();
          }, Math.min(remaining, 250));
          wake = () => {
            clearTimeout(timer);
            resolveWake();
          };
        });
      }
    };

    await stream.send(
      encodeHelloFrame({
        cols: CLIENT_COLS,
        rows: CLIENT_ROWS,
        requestedEncoding: RenderEncoding.TerminalAnsi,
        launchMode: ClientLaunchMode.TerminalAttach,
      }),
    );

    const welcome = await next<WelcomeMessage>(
      (message): message is WelcomeMessage => message.type === "welcome",
      "Welcome over ssh",
      30_000,
    );
    process.stdout.write(
      `[ssh] Welcome version=${welcome.version} encoding=${welcome.encoding} error=${welcome.error}\n`,
    );
    assertWelcomeAccepted(welcome, { encoding: RenderEncoding.TerminalAnsi });
    expect(welcome.version).toBe(PROTOCOL_VERSION);

    await stream.send(encodeObserveTerminalFrame(paneId));

    const deadline = Date.now() + 45_000;
    let frame: TerminalMessage;
    for (;;) {
      frame = await next<TerminalMessage>(
        (message): message is TerminalMessage => message.type === "terminal",
        `Terminal frame containing ${MARKER}`,
        Math.max(deadline - Date.now(), 1),
      );
      if (stripAnsiText(frame.bytes).includes(MARKER)) {
        break;
      }
    }
    process.stdout.write(
      `[ssh] TerminalFrame seq=${frame.seq} ${frame.width}x${frame.height} full=${frame.full} ` +
        `bytes=${frame.bytes.length}\n[ssh] first 120 bytes: ${visualize(frame.bytes, 120)}\n`,
    );

    expect(frame.bytes.includes(0x1b)).toBe(true);
    expect([frame.width, frame.height]).toEqual([CLIENT_COLS, CLIENT_ROWS]);

    // The pane keeps producing into the SAME resident channel — not a one-shot exec.
    await sendInput(api, paneId, `echo ${MARKER}2`);
    const second = await next<TerminalMessage>(
      (message): message is TerminalMessage => message.type === "terminal",
      "a later Terminal frame",
      45_000,
    );
    expect(second.seq > frame.seq).toBe(true);

    stream.close();
  }, 120_000);

  /**
   * The multiplexing contract of `mobile/.prd/02-architecture.md` §2.4, measured.
   *
   * Mutation check: make `openChannel` build its own `Client` per call and this goes from 1 to
   * `channelCount`. The channel count itself is asserted to be large so the "1" is not trivially
   * true — one connection carrying one channel would prove nothing.
   */
  it("carried every channel on a single ssh connection", () => {
    process.stdout.write(
      `[ssh] final connections=${transport.connectionCount} channels=${transport.channelCount}\n`,
    );
    expect(transport.channelCount).toBeGreaterThanOrEqual(6);
    expect(transport.connectionCount).toBe(1);
  });

  it("names the right remote command for each channel kind", () => {
    // Guards the mapping the whole suite silently depends on (`src/remote/unix.rs:75-76`).
    expect(HerdrChannelKind.ClientStream).toBe("client-stream");
    expect(HerdrChannelKind.ApiRequest).toBe("api-request");
  });
});

async function sendInput(api: JsonApiClient, paneId: string, text: string): Promise<void> {
  const sent = await api.request("pane.send_input", { pane_id: paneId, text, keys: ["Enter"] });
  expect(sent["type"], `pane.send_input failed: ${JSON.stringify(sent)}`).toBe("ok");
}
