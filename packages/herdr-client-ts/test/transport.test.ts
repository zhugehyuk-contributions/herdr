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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BRIDGE_EXEC_OPTIONS,
  ClientLaunchMode,
  HerdrChannelKind,
  JsonApiClient,
  JsonApiError,
  JsonApiEventStream,
  JsonApiProtocolError,
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
  type HerdrChannelClose,
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

  /**
   * One request is one connection (`src/api/server.rs:139-152`), so a reply carrying somebody
   * else's `id` is not a routing mistake this client can recover from — it is evidence that the
   * wire is not what it claims to be (a skewed protocol, a bridge multiplexing two callers). The
   * parser used to normalise a missing or non-string `id` to `""` and nobody compared it, so such
   * a reply was returned as a successful result.
   */
  it("rejects a reply whose id does not echo the request", async () => {
    const transport = new FakeTransport();
    answering(transport, () => ({ id: "ts-99", result: { type: "pane_list", panes: [] } }));
    const api = createTransportJsonApiClient(transport);

    await expect(api.paneList()).rejects.toThrow(JsonApiProtocolError);
    await expect(api.paneList()).rejects.toThrow(/ts-99/);
  });

  it("rejects a result envelope that carries no id at all", async () => {
    const transport = new FakeTransport();
    answering(transport, () => ({ result: { type: "pane_list", panes: [] } }));
    const api = createTransportJsonApiClient(transport);

    await expect(api.paneList()).rejects.toThrow(JsonApiProtocolError);
  });

  /**
   * The one id-less reply that is *not* a correlation failure: a request the server could not
   * parse is answered with `id: ""` by construction (`src/api/server.rs:159-172`, and the encode
   * fallback at `:819`). It belongs to this request — there is no other request on this
   * connection — so the server's message must survive as the `JsonApiError` it is, rather than
   * being replaced by a protocol complaint that throws the diagnosis away.
   */
  it("keeps the server's id-less invalid_request error envelope intact", async () => {
    const transport = new FakeTransport();
    answering(transport, () => ({
      id: "",
      error: { code: "invalid_request", message: "invalid request: unknown variant `bogus.method`" },
    }));
    const api = createTransportJsonApiClient(transport);

    await expect(api.request("bogus.method")).rejects.toThrow(JsonApiError);
    await expect(api.request("bogus.method")).rejects.toThrow(/unknown variant/);
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

/**
 * Scripts the server's half of `events.subscribe`: one reply line, written the moment the request
 * is. `subscribe()` waits for that line before it resolves, so a test that emits it afterwards
 * would simply hang — which is the point of the acknowledgement.
 */
function acknowledging(transport: FakeTransport, reply: (request: unknown) => unknown): void {
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

/** The real acknowledgement (`src/api/server.rs:679-686`). */
function subscriptionStarted(request: unknown): unknown {
  return { id: (request as { id: string }).id, result: { type: "subscription_started" } };
}

describe("JsonApiEventStream", () => {
  it("pins one ApiStream channel open and pushes every line", async () => {
    const transport = new FakeTransport();
    const lines: string[] = [];
    acknowledging(transport, subscriptionStarted);
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

    channel.emitLine(JSON.stringify({ id: "ts-events", result: { type: "pane_updated" } }));

    // Still open after two lines — this is the one API channel that is not single-use.
    expect(channel.closed).toBe(false);
    // The acknowledgement is verified *and* forwarded: a subscriber that logs every line still
    // sees the whole stream, exactly as before it was checked.
    expect(lines.map((line) => (JSON.parse(line) as { result: { type: string } }).result.type)).toEqual([
      "subscription_started",
      "pane_updated",
    ]);

    stream.close();
    expect(channel.closed).toBe(true);
  });

  /**
   * The setup hole: `subscribe()` used to write the request and return, so a *rejected*
   * subscription — a type the server does not know, a filter it will not accept
   * (`ActiveSubscription::new` returns `Err(ErrorResponse)`, `src/api/subscriptions.rs:114-120`,
   * written and the connection dropped, `src/api/server.rs:663-676`) — handed the caller a live
   * stream handle for a subscription that does not exist. It then sat there receiving nothing,
   * which is indistinguishable from a quiet system.
   */
  it("refuses a subscription the server rejected", async () => {
    const transport = new FakeTransport();
    acknowledging(transport, (request) => ({
      id: (request as { id: string }).id,
      error: { code: "invalid_params", message: "unknown subscription type" },
    }));

    await expect(
      JsonApiEventStream.subscribe(transport, [{ type: "nope" }], () => {}),
    ).rejects.toThrow(/unknown subscription type/);
    // …and does not leak the channel it opened.
    expect(transport.last().closed).toBe(true);
  });

  it("refuses a first line that is not the acknowledgement", async () => {
    const transport = new FakeTransport();
    acknowledging(transport, (request) => ({
      id: (request as { id: string }).id,
      result: { type: "pong" },
    }));

    await expect(
      JsonApiEventStream.subscribe(transport, [{ type: "pane.updated" }], () => {}),
    ).rejects.toThrow(JsonApiProtocolError);
  });

  it("fails when the bridge dies before acknowledging", async () => {
    const transport = new FakeTransport();
    transport.onOpen = (channel) => {
      channel.die({ exitCode: 1, stderr: "herdr: no server running\n" });
    };

    await expect(
      JsonApiEventStream.subscribe(transport, [{ type: "pane.updated" }], () => {}),
    ).rejects.toThrow(/no server running/);
  });

  /**
   * The mobile case this whole class exists for. LTE drops, the phone sleeps, the remote `herdr`
   * restarts — the ssh channel dies and the resident subscription with it. `onLine` simply stops
   * firing, so a subscriber that is only handed `onLine` believes it is still subscribed forever
   * and the UI silently freezes on stale panes. The death has to reach the subscriber, with the
   * bridge's own diagnosis (`stderr` is its only error channel, `src/remote/unix.rs:592-611`).
   */
  it("tells the subscriber when the channel dies, with the bridge's diagnosis", async () => {
    const transport = new FakeTransport();
    const lines: string[] = [];
    const errors: Error[] = [];
    const closes: HerdrChannelClose[] = [];
    acknowledging(transport, subscriptionStarted);

    await JsonApiEventStream.subscribe(transport, [{ type: "pane.updated" }], {
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
      onClose: (close) => closes.push(close),
    });

    const channel = transport.last();
    channel.die({ exitCode: 255, stderr: "ssh: connection closed by remote host\n" });

    expect(lines).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/exit=255/);
    expect(errors[0]?.message).toMatch(/connection closed by remote host/);
    expect(closes).toHaveLength(1);
    expect(closes[0]?.exitCode).toBe(255);
  });

  it("does not report an error for a close the subscriber asked for", async () => {
    const transport = new FakeTransport();
    const errors: Error[] = [];
    const closes: HerdrChannelClose[] = [];
    acknowledging(transport, subscriptionStarted);

    const stream = await JsonApiEventStream.subscribe(transport, [{ type: "pane.updated" }], {
      onLine: () => {},
      onError: (error) => errors.push(error),
      onClose: (close) => closes.push(close),
    });

    stream.close();

    expect(errors).toEqual([]);
    expect(closes).toHaveLength(1);
  });

  /**
   * Same isolation rule as the framed channel: `onLine` is called straight out of the transport's
   * `onData` (`src/transport.ts`), which the Node implementation calls from an `ssh2` `data`
   * event, so a subscriber that throws would drop the rest of the chunk's lines and send an
   * exception into an EventEmitter. Counted, not swallowed.
   */
  it("keeps delivering lines when a subscriber throws", async () => {
    const transport = new FakeTransport();
    acknowledging(transport, subscriptionStarted);
    let seen = 0;

    const stream = await JsonApiEventStream.subscribe(transport, [{ type: "pane.updated" }], {
      onLine: () => {
        seen += 1;
        throw new Error("subscriber blew up");
      },
    });

    const channel = transport.last();
    expect(() =>
      channel.emit(
        new TextEncoder().encode(
          `${JSON.stringify({ id: "ts-events", result: { type: "pane_updated" } })}\n` +
            `${JSON.stringify({ id: "ts-events", result: { type: "pane_updated" } })}\n`,
        ),
      ),
    ).not.toThrow();

    expect(seen).toBe(3); // the acknowledgement plus both lines in the chunk
    expect(stream.callbackFailureCount).toBe(3);
    expect((stream.lastCallbackFailure as Error).message).toBe("subscriber blew up");
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
    // the arrangement `ServerMessageReader` used to drop the Terminal from (`src/stream.ts`, fixed
    // there too). Both layers own this property; this one pins it for the push-shaped path.
    wire.emit(fromHex(frameHex("04") + frameHex(TERMINAL_SMALL_FULL)));

    expect(got.undecodable.map((error) => error.code)).toEqual(["unsupported-variant"]);
    expect(got.undecodable[0]?.message).toContain("Notify");
    expect(got.messages.map((message) => message.type)).toEqual(["terminal"]);

    // And the next chunk still decodes: the reader is not poisoned.
    wire.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)));
    expect(got.messages.map((message) => message.type)).toEqual(["terminal", "terminal"]);
    expect(got.errors).toEqual([]);
  });

  /**
   * The contract said `onError` is terminal; the implementation called it for a corrupt *payload*
   * and then carried on decoding the next frame. Both readings of the documented contract broke:
   * an app that tears the terminal down in `onError` got `onMessage` afterwards and applied ANSI
   * to a disposed screen, and an app that reconnects flapped the ssh channel over one skippable
   * frame. A corrupt payload costs exactly that frame — the length prefix already fixed the
   * boundary — so it belongs on `onUndecodable`, exactly as `ServerMessageReader` treats it
   * (`src/stream.ts:102-116`).
   */
  it("routes a corrupt payload to onUndecodable, not to the terminal onError", async () => {
    const transport = new FakeTransport();
    const { got } = await openObserve(transport);

    // `Terminal` (tag 13) whose body stops after `seq`: a whole frame, an unfinished message.
    transport.last().emit(fromHex(frameHex("0d01") + frameHex(TERMINAL_SMALL_FULL)));

    expect(got.undecodable.map((error) => error.code)).toEqual(["corrupt"]);
    expect(got.errors).toEqual([]);
    expect(got.messages.map((message) => message.type)).toEqual(["terminal"]);

    // Not terminal in any sense: the channel keeps working.
    transport.last().emit(fromHex(frameHex(TERMINAL_SMALL_FULL)));
    expect(got.messages).toHaveLength(2);
  });

  /**
   * `cf05b11b` again, through the callback door. `onUndecodable` is a diagnostic sink — a logger,
   * a metrics counter — and the frames behind the skipped one have already been de-framed, so one
   * throw out of it drops every `Terminal` sharing that chunk. The callback is isolated and its
   * failure is counted instead.
   */
  it("keeps routing frames when a diagnostic callback throws", async () => {
    const transport = new FakeTransport();
    const messages: ServerMessage[] = [];
    const channel = await ServerMessageChannel.open(transport, {
      onMessage: (message) => messages.push(message),
      onUndecodable: () => {
        throw new Error("logger blew up");
      },
      onClose: () => {},
    });

    // Notify (undecoded, routine traffic) glued in front of a Terminal, one chunk.
    transport.last().emit(fromHex(frameHex("04") + frameHex(TERMINAL_SMALL_FULL)));

    expect(messages.map((message) => message.type)).toEqual(["terminal"]);
    expect(channel.undecodableCount).toBe(1);
    expect(channel.callbackFailureCount).toBe(1);
    expect((channel.lastCallbackFailure as Error).message).toBe("logger blew up");
  });

  /**
   * The same isolation, one layer up, where the loss is the *error* rather than the data.
   *
   * A framing failure salvages the frames de-framed before it, routes them, and only then reports
   * itself (`src/transport.ts:464-474`). With the salvage loop unguarded, an `onMessage` that
   * throws — a renderer on a disposed screen, say — takes the whole `ingest` call with it and the
   * terminal `oversized` error never reaches `onError`: the app is left with a dead stream and no
   * reason. Worse, the throw does not stop at the callback — `ingest` is wired straight to the
   * transport's `onData` (`src/transport.ts:441-447`), which the Node implementation calls from an
   * `ssh2` `data` event (`src/node/sshTransport.ts:66`), and an exception out of an EventEmitter
   * handler can take the process down.
   */
  it("still reports a framing error when a salvaged frame's onMessage throws", async () => {
    const transport = new FakeTransport();
    const errors: Error[] = [];
    const channel = await ServerMessageChannel.open(transport, {
      onMessage: () => {
        throw new Error("render blew up");
      },
      onError: (error) => errors.push(error),
      onClose: () => {},
    });

    // One Terminal frame (the salvage) glued in front of an oversized prefix, in one chunk.
    expect(() =>
      transport.last().emit(fromHex(frameHex(TERMINAL_SMALL_FULL) + "ffffffff")),
    ).not.toThrow();

    expect(errors.map((error) => (error as WireError).code)).toEqual(["oversized"]);
    expect(channel.callbackFailureCount).toBe(1);
    expect((channel.lastCallbackFailure as Error).message).toBe("render blew up");
  });

  /**
   * The fork-skew smoke alarm, and the reason this counter is not optional.
   *
   * `src/constants.ts:4-9` records that mx and upstream both report `PROTOCOL_VERSION = 20` while
   * disagreeing on `ServerMessage::Terminal` (13 on mx, 2 upstream), and `assertWelcomeAccepted`
   * only compares versions. Point this client at an upstream server and the handshake is green,
   * every terminal frame arrives as tag 2 — `Graphics` in this table — and is dropped as an
   * undecodable variant. With `onUndecodable` optional and documented as "not an error", the
   * result is a black screen with zero errors and zero diagnostics. A counter that is always
   * there turns that into a one-line answer.
   */
  it("counts undecodable frames even with no handler attached", async () => {
    const transport = new FakeTransport();
    const messages: ServerMessage[] = [];
    const errors: Error[] = [];
    const channel = await ServerMessageChannel.open(transport, {
      onMessage: (message) => messages.push(message),
      onError: (error) => errors.push(error),
      onClose: () => {},
    });

    // Two frames tagged 2 — what an upstream server calls `Terminal` and this codec calls
    // `Graphics`. Exactly the shape of a fork-skewed connection.
    transport.last().emit(fromHex(frameHex("02") + frameHex("02")));

    expect(channel.undecodableCount).toBe(2);
    expect(channel.lastUndecodable?.message).toContain("Graphics");
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
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

  /**
   * A poisoned {@link FrameReader} rethrows the *same* error object, `decodedBefore` and all
   * (`src/framing.ts:54-56`), so a caller that salvages on every throw replays those frames once
   * per chunk that follows — and a bridge keeps writing until its channel dies. On a terminal that
   * is the same ANSI bytes applied N times, i.e. a corrupted screen. A framing failure is terminal:
   * salvage once, report once, then nothing. `ServerMessageReader` holds the same property by
   * rethrowing verbatim (`src/stream.ts:78-82`).
   */
  it("salvages the frames before a framing error exactly once, however many chunks follow", async () => {
    const transport = new FakeTransport();
    const { got } = await openObserve(transport);
    const wire = transport.last();

    // One Terminal frame, then an oversized prefix, in ONE chunk: `FrameReader` de-framed the
    // Terminal before it threw, so it is salvage and must reach `onMessage`.
    wire.emit(fromHex(frameHex(TERMINAL_SMALL_FULL) + "ffffffff"));
    expect(got.messages.map((message) => message.type)).toEqual(["terminal"]);
    expect(got.errors.map((error) => (error as WireError).code)).toEqual(["oversized"]);

    // Two more chunks off the still-open socket. Neither may re-deliver the salvage.
    wire.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)));
    wire.emit(fromHex("00"));

    expect(got.messages.map((message) => message.type)).toEqual(["terminal"]);
    expect(got.errors).toHaveLength(1);
    expect(got.undecodable).toEqual([]);
  });

  /**
   * The other terminal state. `close()` over ssh only asks the stream to end; `onClose` arrives
   * when the remote gets round to it (`src/node/sshTransport.ts:82-92`), so bytes can still land
   * in between. They belong to a channel the caller has already retired — routing them would
   * push messages at a pane that is gone.
   */
  it("ignores bytes that arrive after the channel is closed", async () => {
    const transport = new FakeTransport();
    const { channel, got } = await openObserve(transport);
    const wire = transport.last();

    channel.close();
    wire.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)));

    expect(got.messages).toEqual([]);
    expect(got.errors).toEqual([]);
    expect(got.closes).toBe(1);
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

  /**
   * The value is shell-quoted; the *name* was interpolated raw, so `env` could be handed a key
   * the remote shell expands before `env` ever sees it. Today only this package writes those keys,
   * but `remoteBridgeCommand` is exported API and its output is executed by a shell on another
   * machine. A name that is not a POSIX identifier could not have worked anyway — `env` rejects
   * it — so refusing beats quoting: the failure lands at the call site instead of as a mystery
   * bridge exit.
   */
  it("refuses an env name a remote shell would expand", () => {
    const cases = ["X$(id)", "X`id`", "A B", "A;rm -rf /", "1ABC", "", "A-B", "A=B", "$X"];
    for (const name of cases) {
      expect(
        () => remoteBridgeCommand(HerdrChannelKind.ClientStream, { env: { [name]: "1" } }),
        `env name ${JSON.stringify(name)} must be refused`,
      ).toThrow(/environment variable name/);
    }
    // The refusal names the offender, or it is just another mystery.
    expect(() =>
      remoteBridgeCommand(HerdrChannelKind.ClientStream, { env: { "X$(id)": "1" } }),
    ).toThrow(/X\$\(id\)/);
  });

  it("still accepts every name a POSIX shell calls a name", () => {
    expect(
      remoteBridgeCommand(HerdrChannelKind.ApiRequest, {
        env: { XDG_RUNTIME_DIR: "/tmp/x", _private: "1", A1: "2" },
      }),
    ).toBe("exec env XDG_RUNTIME_DIR=/tmp/x _private=1 A1=2 herdr remote-api-bridge");
  });

  /**
   * A pty turns the byte pump into a line discipline: CR/LF translation and echo silently mangle
   * every framed payload, and the failure is total and quiet. The requirement used to live only
   * in a comment in `src/node/sshTransport.ts` — the one file `src/transport.ts:76-81` says a
   * native implementer does not read, because protocol knowledge is supposed to live here. So the
   * exec options are a value in the protocol layer, and the Node implementation consumes that
   * value rather than restating it.
   */
  it("puts the no-pty exec requirement in the protocol layer, and uses it there", () => {
    expect(BRIDGE_EXEC_OPTIONS.pty).toBe(false);

    const sshTransportSource = readFileSync(
      fileURLToPath(new URL("../src/node/sshTransport.ts", import.meta.url)),
      "utf8",
    );
    expect(sshTransportSource).toContain("BRIDGE_EXEC_OPTIONS");
    // …and does not re-declare it locally, which is how the two drift apart.
    expect(sshTransportSource).not.toMatch(/\{\s*pty:\s*false\s*\}/);
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
