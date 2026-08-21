/**
 * The transport seam, exercised end-to-end against {@link FakeTransport}.
 *
 * What is actually being proved here is *substitutability*: the JSON API client and the framed
 * observe flow are driven to completion over a transport made of arrays, using the same public API
 * the ssh implementation is handed. Anything these tests can assert is something the ssh suite
 * does not have to, and something the React Native native module must satisfy too.
 *
 * The bookkeeping assertions (channel counts, kinds, close timing) are the load-bearing ones —
 * `mobile/.prd/02-architecture.md` §2.4's contract is about channel lifetimes, not bytes.
 */
import { describe, expect, it } from "vitest";

import {
  ClientLaunchMode,
  HerdrChannelKind,
  JsonApiClient,
  JsonApiError,
  JsonApiEventStream,
  RenderEncoding,
  ServerMessageChannel,
  assertWelcomeAccepted,
  bridgeSubcommand,
  createTransportJsonApiClient,
  describeClose,
  encodeHelloFrame,
  encodeObserveTerminalFrame,
  isApiChannelKind,
  remoteBridgeCommand,
  shellQuote,
  transportJsonApiConnect,
  type ServerMessage,
  type TerminalMessage,
  type WelcomeMessage,
  type WireError,
} from "../src/index.js";
import { FakeTransport } from "./fakeTransport.js";
import { frameHex, fromHex } from "./helpers.js";
import {
  OBSERVE_TERMINAL_W1_P1,
  TERMINAL_SMALL_FULL,
  WELCOME_OK_ANSI,
} from "./vectors.js";

// ---------------------------------------------------------------------------
// The control plane: JsonApiClient over a transport
// ---------------------------------------------------------------------------

/** Answers every API channel with one canned line, then leaves the channel to the client. */
function answering(transport: FakeTransport, reply: (request: unknown) => unknown): void {
  transport.onOpen = (channel) => {
    const original = channel.write.bind(channel);
    channel.write = (bytes: Uint8Array) => {
      original(bytes);
      const line = channel.writtenText.trim();
      if (line.length > 0) {
        channel.emitLine(JSON.stringify(reply(JSON.parse(line))));
      }
    };
  };
}

describe("JsonApiClient over a transport", () => {
  it("opens exactly one ApiRequest channel per call and closes it", async () => {
    const transport = new FakeTransport();
    answering(transport, (request) => ({
      id: (request as { id: string }).id,
      result: { type: "pane_list", panes: [] },
    }));
    const api = createTransportJsonApiClient(transport);

    await api.paneList();
    await api.agentList();
    await api.request("workspace.list");

    expect(transport.kinds()).toEqual([
      HerdrChannelKind.ApiRequest,
      HerdrChannelKind.ApiRequest,
      HerdrChannelKind.ApiRequest,
    ]);
    expect(transport.channels.map((channel) => channel.closed)).toEqual([true, true, true]);
  });

  /**
   * The multiplexing contract, as a test rather than a comment: three requests, three channels,
   * **one transport**. Mutating the implementation to build a transport per request (or per call
   * to `connect()`) makes `transport.channels` hold one entry and this assertion fail.
   */
  it("multiplexes every request onto one transport", async () => {
    const transport = new FakeTransport();
    answering(transport, (request) => ({
      id: (request as { id: string }).id,
      result: { type: "ok" },
    }));
    const api = new JsonApiClient(transportJsonApiConnect(transport));

    await Promise.all([api.paneList(), api.agentList(), api.request("pane.get", { pane_id: "w1:p1" })]);

    expect(transport.channels).toHaveLength(3);
    expect(new Set(transport.kinds())).toEqual(new Set([HerdrChannelKind.ApiRequest]));
  });

  it("writes exactly the request line the server expects, newline included", async () => {
    const transport = new FakeTransport();
    answering(transport, (request) => ({
      id: (request as { id: string }).id,
      result: { type: "ok" },
    }));
    const api = createTransportJsonApiClient(transport);

    await api.request("pane.send_input", { pane_id: "w1:p1", text: "echo hi", keys: ["Enter"] });

    expect(transport.last().writtenText).toBe(
      `{"id":"ts-1","method":"pane.send_input","params":{"pane_id":"w1:p1","text":"echo hi","keys":["Enter"]}}\n`,
    );
  });

  it("surfaces an error envelope as JsonApiError", async () => {
    const transport = new FakeTransport();
    answering(transport, (request) => ({
      id: (request as { id: string }).id,
      error: { code: "not_found", message: "no such pane" },
    }));
    const api = createTransportJsonApiClient(transport);

    await expect(api.request("pane.get", { pane_id: "w9:p9" })).rejects.toThrow(JsonApiError);
  });

  /**
   * The bridge's only way to report a startup failure is to exit with something on stderr
   * (`ensure_remote_server_running`, `src/remote/unix.rs:592-611`). A caller that gets a bare
   * "closed" has to go find the ssh session's stderr by hand, so the close detail must reach the
   * rejection message.
   */
  it("fails a pending request with the channel's exit status and stderr", async () => {
    const transport = new FakeTransport();
    transport.onOpen = (channel) => {
      channel.die({
        exitCode: 1,
        stderr: "remote herdr server is running with protocol 19, but this bridge needs protocol 20\n",
      });
    };
    const api = createTransportJsonApiClient(transport);

    await expect(api.paneList()).rejects.toThrow(/exit=1.*protocol 19/s);
  });

  it("reassembles a response line delivered one byte at a time", async () => {
    const transport = new FakeTransport();
    transport.onOpen = (channel) => {
      const line = `${JSON.stringify({ id: "ts-1", result: { type: "agent_list", agents: [] } })}\n`;
      for (const byte of new TextEncoder().encode(line)) {
        channel.emit(new Uint8Array([byte]));
      }
    };
    const api = createTransportJsonApiClient(transport);

    await expect(api.agentList()).resolves.toMatchObject({ type: "agent_list" });
  });
});

describe("JsonApiEventStream", () => {
  it("pins one ApiStream channel open and pushes every line", async () => {
    const transport = new FakeTransport();
    const lines: string[] = [];
    const stream = await JsonApiEventStream.subscribe(
      transport,
      [{ type: "pane.updated" }],
      (line) => lines.push(line),
    );

    const channel = transport.last();
    expect(channel.kind).toBe(HerdrChannelKind.ApiStream);
    expect(JSON.parse(channel.writtenText.trim())).toEqual({
      id: "ts-events",
      method: "events.subscribe",
      params: { subscriptions: [{ type: "pane.updated" }] },
    });

    channel.emitLine(JSON.stringify({ id: "ts-events", result: { type: "subscription_started" } }));
    channel.emitLine(JSON.stringify({ id: "ts-events", result: { type: "pane_updated" } }));

    // Still open after two lines — this is the one API channel that is not single-use.
    expect(channel.closed).toBe(false);
    expect(lines.map((line) => (JSON.parse(line) as { result: { type: string } }).result.type)).toEqual([
      "subscription_started",
      "pane_updated",
    ]);

    stream.close();
    expect(channel.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The data plane: the observe flow over a transport
// ---------------------------------------------------------------------------

interface Collected {
  messages: ServerMessage[];
  undecodable: WireError[];
  errors: Error[];
  closes: number;
}

async function openObserve(
  transport: FakeTransport,
): Promise<{ channel: ServerMessageChannel; got: Collected }> {
  const got: Collected = { messages: [], undecodable: [], errors: [], closes: 0 };
  const channel = await ServerMessageChannel.open(transport, {
    onMessage: (message) => got.messages.push(message),
    onUndecodable: (error) => got.undecodable.push(error),
    onError: (error) => got.errors.push(error),
    onClose: () => {
      got.closes += 1;
    },
  });
  return { channel, got };
}

describe("observe flow over a transport", () => {
  it("runs handshake -> ObserveTerminal -> Terminal on one ClientStream channel", async () => {
    const transport = new FakeTransport();
    const { channel, got } = await openObserve(transport);
    const wire = transport.last();
    expect(wire.kind).toBe(HerdrChannelKind.ClientStream);

    channel.send(
      encodeHelloFrame({
        cols: 100,
        rows: 30,
        requestedEncoding: RenderEncoding.TerminalAnsi,
        launchMode: ClientLaunchMode.TerminalAttach,
      }),
    );
    // Welcome, split across two chunks: the transport promises bytes, never frames.
    const welcomeFrame = fromHex(frameHex(WELCOME_OK_ANSI));
    wire.emit(welcomeFrame.subarray(0, 3));
    wire.emit(welcomeFrame.subarray(3));

    const welcome = got.messages[0] as WelcomeMessage;
    expect(welcome.type).toBe("welcome");
    assertWelcomeAccepted(welcome, { encoding: RenderEncoding.TerminalAnsi });

    channel.send(encodeObserveTerminalFrame("w1:p1"));
    expect(Array.from(wire.written[1] as Uint8Array).slice(4)).toEqual(
      Array.from(fromHex(OBSERVE_TERMINAL_W1_P1)),
    );

    wire.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)));
    const terminal = got.messages[1] as TerminalMessage;
    expect(terminal.type).toBe("terminal");
    expect(terminal.bytes.length).toBeGreaterThan(0);
    expect(terminal.bytes.includes(0x1b)).toBe(true);

    expect(transport.channels).toHaveLength(1);
    expect(got.errors).toEqual([]);
  });

  /**
   * `Notify`, `Compressed` and friends arrive on a real connection and are not decoded here. The
   * frame is consumed either way, so the stream must stay in sync — proven by decoding a Terminal
   * frame that arrives in the *same chunk*, after the undecodable one.
   */
  it("reports an undecodable variant and keeps the stream in sync", async () => {
    const transport = new FakeTransport();
    const { got } = await openObserve(transport);
    const wire = transport.last();

    // ServerMessage::Notify (tag 4, undecoded) immediately followed by a Terminal, in ONE chunk —
    // the arrangement that `ServerMessageReader` would have dropped the Terminal from.
    wire.emit(fromHex(frameHex("04") + frameHex(TERMINAL_SMALL_FULL)));

    expect(got.undecodable.map((error) => error.code)).toEqual(["unsupported-variant"]);
    expect(got.undecodable[0]?.message).toContain("Notify");
    expect(got.messages.map((message) => message.type)).toEqual(["terminal"]);

    // And the next chunk still decodes: the reader is not poisoned.
    wire.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)));
    expect(got.messages.map((message) => message.type)).toEqual(["terminal", "terminal"]);
    expect(got.errors).toEqual([]);
  });

  it("forwards a remote-side death, and a caller-side close, as one onClose each", async () => {
    const remote = new FakeTransport();
    const fromRemote = await openObserve(remote);
    remote.last().die({ exitCode: 1, stderr: "bridge failed" });
    expect(fromRemote.got.closes).toBe(1);

    const local = new FakeTransport();
    const fromLocal = await openObserve(local);
    fromLocal.channel.close();
    expect(local.last().closed).toBe(true);
    expect(fromLocal.got.closes).toBe(1);
  });

  /**
   * An oversized length prefix cannot be resynced, so it is an error and not an "undecodable
   * frame": {@link FrameReader} poisons itself and the only recovery is a new connection.
   */
  it("reports a framing error rather than silently stalling", async () => {
    const transport = new FakeTransport();
    const { got } = await openObserve(transport);

    transport.last().emit(fromHex("ffffffff" + "00"));

    expect(got.errors.map((error) => (error as WireError).code)).toEqual(["oversized"]);
    expect(got.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The remote command
// ---------------------------------------------------------------------------

describe("remote bridge command", () => {
  it("maps channel kinds onto the two bridge subcommands (src/remote/unix.rs:75-76)", () => {
    expect(bridgeSubcommand(HerdrChannelKind.ApiRequest)).toBe("remote-api-bridge");
    expect(bridgeSubcommand(HerdrChannelKind.ApiStream)).toBe("remote-api-bridge");
    expect(bridgeSubcommand(HerdrChannelKind.ClientStream)).toBe("remote-client-bridge");
    expect([HerdrChannelKind.ApiRequest, HerdrChannelKind.ApiStream].map(isApiChannelKind)).toEqual([
      true,
      true,
    ]);
    expect(isApiChannelKind(HerdrChannelKind.ClientStream)).toBe(false);
  });

  /** Same expectations as `remote_bridge_command_uses_installed_binary` (`src/remote/unix.rs:3084`). */
  it("matches the Rust builder's output", () => {
    expect(remoteBridgeCommand(HerdrChannelKind.ClientStream, { herdrBinary: "/usr/bin/herdr" })).toBe(
      "exec /usr/bin/herdr remote-client-bridge",
    );
    expect(remoteBridgeCommand(HerdrChannelKind.ApiStream, { herdrBinary: "/usr/bin/herdr" })).toBe(
      "exec /usr/bin/herdr remote-api-bridge",
    );
  });

  it("quotes like shell_quote (src/remote/unix.rs:2088-2102)", () => {
    expect(shellQuote("/usr/bin/herdr")).toBe("/usr/bin/herdr");
    expect(shellQuote("/opt/herdr bin/herdr")).toBe("'/opt/herdr bin/herdr'");
    expect(shellQuote("/opt/herdr's/bin/herdr")).toBe("'/opt/herdr'\\''s/bin/herdr'");
    expect(shellQuote("")).toBe("''");
  });

  it("omits --session for the default session and quotes it otherwise", () => {
    expect(remoteBridgeCommand(HerdrChannelKind.ApiRequest, { session: "default" })).toBe(
      "exec herdr remote-api-bridge",
    );
    expect(remoteBridgeCommand(HerdrChannelKind.ApiRequest, { session: "my work" })).toBe(
      "exec herdr --session 'my work' remote-api-bridge",
    );
  });

  it("prepends env as a literal `env` prefix", () => {
    expect(
      remoteBridgeCommand(HerdrChannelKind.ClientStream, {
        herdrBinary: "/tmp/herdr",
        env: { XDG_RUNTIME_DIR: "/tmp/x y", HERDR_SOCKET_PATH: "/tmp/x y/herdr.sock" },
      }),
    ).toBe(
      "exec env XDG_RUNTIME_DIR='/tmp/x y' HERDR_SOCKET_PATH='/tmp/x y/herdr.sock' " +
        "/tmp/herdr remote-client-bridge",
    );
  });
});

describe("describeClose", () => {
  it("keeps every signal a bridge can give about why it died", () => {
    expect(describeClose("bridge closed", { exitCode: 2, stderr: "  boom\n" })).toBe(
      'bridge closed (exit=2 stderr="boom")',
    );
    expect(describeClose("bridge closed", { signal: "TERM" })).toBe("bridge closed (signal=TERM)");
    expect(describeClose("bridge closed", {})).toBe("bridge closed");
  });
});
