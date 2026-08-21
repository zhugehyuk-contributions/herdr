# `@herdr/client-ts`

Headless **wire codec** for the herdr client protocol, plus the **transport seam** that carries it
to a server over ssh — the pieces the mobile app needs before any UI exists. No UI and no Node
built-ins in the React Native entry point: it turns bytes into messages and back, over a byte
stream somebody else supplies.

The mobile plan ([`mobile/.prd/02-architecture.md`](../../mobile/.prd/02-architecture.md) §2.2)
reduces the app's hand-written bincode surface to exactly three things, and this package is exactly
those three:

| # | Piece | Direction |
|---|---|---|
| 1 | the `[u32 LE length][bincode payload]` envelope, **incrementally** | both |
| 2 | `ClientMessage::Hello` + `ClientMessage::ObserveTerminal` (+ `RequestFullFrame`) encode | client → server |
| 3 | `ServerMessage::Welcome` / `ServerMessage::Terminal` decode | server → client |

Plus one thing the plan implies but does not list: `src/jsonApi.ts`, a client for the *other*
socket — herdr's newline-delimited JSON control API (`herdr.sock`), which is how you find a pane to
observe in the first place. It is transport-agnostic like the rest of `src/` (the caller supplies
the connection), and its reason to be a type at all is that **one request is one connection**:
`handle_connection` (`src/api/server.rs:139-152`) reads a single line, answers, and returns — a
client that reuses the socket gets silence.

## Usage

```ts
import {
  ClientLaunchMode,
  RenderEncoding,
  ServerMessageReader,
  assertWelcomeAccepted,
  encodeHelloFrame,
  encodeObserveTerminalFrame,
} from "@herdr/client-ts";

socket.write(
  encodeHelloFrame({
    cols: 100,
    rows: 30,
    requestedEncoding: RenderEncoding.TerminalAnsi,
    launchMode: ClientLaunchMode.TerminalAttach,
  }),
);

// `onUndecodable` is optional: `Notify`, `Clipboard`, `Pong` and the other variants this codec
// does not decode are skipped, the rest of the chunk still decodes, and `reader.undecodableCount`
// counts them whether or not you subscribe.
const reader = new ServerMessageReader({
  onUndecodable: (error) => console.debug(error.message),
});
let handshaked = false;

socket.on("data", (chunk: Uint8Array) => {
  for (const message of reader.push(chunk)) {
    if (message.type === "welcome") {
      // Throws on rejection, version skew, or a downgraded encoding.
      assertWelcomeAccepted(message, { encoding: RenderEncoding.TerminalAnsi });
      handshaked = true;
      // `Hello` only attaches the connection. Nothing streams until this goes out.
      socket.write(encodeObserveTerminalFrame("w1:p1"));
    } else if (handshaked) {
      terminal.write(message.bytes); // TerminalFrame.bytes -> xterm
    }
  }
});
```

`assertWelcomeAccepted` is not optional politeness. `Hello.requested_encoding` is a *request*;
`Welcome.encoding` is what the server actually chose. A client that skips the check and gets
`SemanticFrame` will read `Frame` payloads as `Terminal` frames.

`push` throws exactly one thing: `OversizedFrameError`, the framing error that leaves the stream
with no resync point (the salvageable messages ride along on `error.decodedBefore`). Everything
else the decoder rejects — an undecoded variant, a corrupt payload — costs that one frame and
nothing behind it, because the length prefix already fixed where the next frame starts.

Both promises hold **even if your `onUndecodable` throws**: diagnostic callbacks are invoked in
isolation, so a logger blowing up cannot abort the decode loop and take the already-de-framed
frames behind it with it. It is isolated, not swallowed — `reader.callbackFailureCount` and
`reader.lastCallbackFailure` say so, next to `undecodableCount` / `lastUndecodable`.

## Transport — how this reaches a server that is not local

`src/transport.ts` is the seam. The app never opens `herdr.sock` / `herdr-client.sock`: it runs two
stdio bridges over ssh and speaks the same two protocols through their stdin/stdout
([`mobile/.prd/02-architecture.md`](../../mobile/.prd/02-architecture.md) §2.1/§2.4).

| channel kind | remote command | protocol | lifetime |
|---|---|---|---|
| `ApiRequest` | `herdr remote-api-bridge` | NDJSON | **one per request** — `handle_connection` answers one line and returns (`src/api/server.rs:139-152`) |
| `ApiStream` | `herdr remote-api-bridge` | NDJSON | resident — `events.subscribe` is the one method that loops (`src/api/server.rs:654`) |
| `ClientStream` | `herdr remote-client-bridge` | `[u32 LE len][…]` | resident, one per observed pane |

Subcommand names: `src/remote/unix.rs:75-76`. Both bridges are pure byte pumps onto a unix socket
(`bridge_stdio_to_socket`, `src/remote/unix.rs:568-590`), so **no new listener appears on the
server and the entire authentication boundary is ssh**. `remoteBridgeCommand()` builds the exact
command, a port of `remote_bridge_command` (`src/remote/unix.rs:2050-2063`) — a React Native native
module must emit the identical string.

A `HerdrTransport` is **one host**: `openChannel` multiplexes onto its single existing connection,
never dials a new one. herdr's own desktop client makes the same promise by injecting
`ControlMaster=auto`/`ControlPersist` (`src/remote/unix.rs:310-316`), and for the same reason —
every extra connection is another key exchange and another sshd session, over LTE.

```ts
import { createTransportJsonApiClient, ServerMessageChannel } from "@herdr/client-ts";
import { SshHerdrTransport } from "@herdr/client-ts/node"; // Node only

const transport = await SshHerdrTransport.connect({
  ssh: { host, username, privateKey },
  herdrBinary: "/home/me/.local/bin/herdr",
});

const api = createTransportJsonApiClient(transport); // one exec channel per call, automatically
const panes = await api.paneList();

const stream = await ServerMessageChannel.open(transport, {
  onMessage: (message) => { /* welcome / terminal */ },
  // One frame lost: an undecoded variant OR a corrupt payload. Optional — `stream.undecodableCount`
  // counts them either way. A corrupt one also triggers screen resynchronization (below).
  onUndecodable: (error) => { /* diagnostics */ },
  // Terminal, and only terminal: a framing error, fired exactly once. Not a corrupt frame.
  onError: (error) => { /* drop the connection and reconnect */ },
  onClose: (close) => { /* close.exitCode / close.stderr — the bridge's only error channel */ },
});
stream.send(encodeHelloFrame({ /* … */ }));
```

`JsonApiEventStream.subscribe()` resolves only once the server has **acknowledged** the
subscription (`subscription_started`, `src/api/server.rs:679-686`); a rejected subscription rejects
the promise instead of handing back a handle that will never produce a line. Pass it
`{ onLine, onError, onClose }` rather than a bare function and the subscriber also learns when the
channel dies — the everyday mobile case (LTE drops, remote `herdr` restarts), and the signal any
resubscribe is built on.

Rules the interface encodes rather than documents:

- **Handlers are passed at open, not attached afterwards.** The remote can emit bytes the instant
  the command starts, and on React Native delivery is a `NativeEventEmitter`; any gap between
  "channel exists" and "listener attached" drops frames.
- **`Uint8Array`, callbacks and promises only.** No `Buffer`, `Stream` or `EventEmitter` — the
  native module has to implement this, and `src/` has to load on Hermes.
- **Handlers may throw.** Every handler call is isolated and counted
  (`callbackFailureCount`), because `onData` is dispatched straight from the transport's event
  source — an escaping exception would cost the rest of that chunk's frames and, on Node, can take
  the process down.
- **Nine more the *implementation* must satisfy** — no pty (`BRIDGE_EXEC_OPTIONS`), the command
  string built here and passed through verbatim, stderr pumped into `close.stderr`, ordered
  exactly-once per-channel delivery, transport-owned `onData` buffers valid only for the call,
  `write` resolving on hand-off rather than delivery, and a write racing a close never throwing.
  They are enumerated on the `HerdrTransport` interface in `src/transport.ts`, which is the file a
  native-module author reads.

`ssh2` is a **devDependency** and lives behind the separate `@herdr/client-ts/node` entry point, so
a Metro bundle of `.` cannot reach it. That is checked mechanically by `test/hermesContract.test.ts`,
which walks the real import graph — *not* by `tsc`, which does not catch it (`types: []` suppresses
only automatic `@types` inclusion; an explicit `import … from "ssh2"` still resolves).

## Design notes

- **Runs on Hermes.** `src/` type-checks with `"types": []` and `"lib": ["ES2020"]`, so a stray
  `Buffer`, `fs` or even `TextDecoder` fails `tsc`. UTF-8 is hand-rolled (`src/utf8.ts`) and
  cross-checked against Node's `TextEncoder`/`TextDecoder` in the tests only.
- **Incremental by default.** `FrameReader` holds partial frames and emits only complete payloads,
  because sockets do not deliver frame boundaries.
- **"Need more bytes" and "these bytes are wrong" are different errors.** A truncated *stream* is
  normal (`FrameReader` just buffers); a message that runs off the end of a *frame whose length
  prefix said it was complete* is `CorruptError`. `IncompleteError` never escapes a whole frame.
- **`seq` is a `bigint`.** `TerminalFrame.seq` is a `u64` and a long-lived stream outruns
  `Number.MAX_SAFE_INTEGER`'s guarantees.
- **The frame ceiling is a rule, not a number.** The server picks the cap per frame — 2 MiB without
  Kitty graphics, 32 MiB with (`src/server/headless.rs:4231-4235`), mirrored by
  `server_frame_size_cap` (`src/client/mod.rs:6483-6491`). `serverFrameSizeCap(kittyGraphicsEnabled)`
  is that same rule; `FrameReader` defaults to its larger arm because graphics are spliced *into*
  `TerminalFrame.bytes` (`src/server/render_stream.rs:109`) and a rejected length prefix cannot be
  resynchronized — the connection flaps. **Any value between the two caps is always wrong.**
- **A lost frame can leave the *screen* wrong even though the *wire* is fine.** `Terminal` is a
  diff stream (`TerminalFrame.full`, `src/protocol/wire.rs:771-780`), so skipping a corrupt frame
  and applying the diffs behind it renders cells the server never sent. The cure is in the protocol:
  `ClientMessage::RequestFullFrame` (tag 11, `src/protocol/wire.rs:462-467`, **mx-only**) makes the
  server drop that client's render baseline so its next `Terminal` is `full: true`.
  `ServerMessageChannel` owns the write end, so it sends the request itself and withholds diffs
  until the full frame lands (`awaitingFullFrame`, `droppedDiffCount`, `fullFrameRequestCount`).
  `ServerMessageReader` cannot send anything, so it only reports (`screenDesynced`) and drops diffs
  when you opt in with `dropDiffsWhileDesynced` — swallowing them without sending the request would
  freeze the screen instead of merely drifting it. Both layers classify a desync with the same
  predicate, `desynchronizesScreen`; an *undecoded variant* is never one.
- **Ordinals live in one file.** `src/constants.ts` — they are *fork-local*; see the warning at the
  top of that file and `mobile/.prd/03-blockers.md` B1.
- **`undecodableCount` is the fork-skew alarm.** B1 is not hypothetical: mx and upstream both
  report `PROTOCOL_VERSION = 20` while disagreeing on `ServerMessage::Terminal` (13 vs 2), and
  `assertWelcomeAccepted` compares only versions. Against a skewed server the handshake is green
  and every terminal frame is silently dropped as an unknown variant. A counter that climbs with
  the frame rate turns "connected, no errors, black screen" into a one-line diagnosis, which is why
  both readers expose it whether or not a handler is attached.

## Not covered (deliberately)

- **Any other `ServerMessage`.** Variants 1–12 raise `UnsupportedVariantError` naming the variant
  rather than being ignored. The one to watch is **`Compressed` (11)**: the server deflates any
  server message over 256 bytes on the *semantic* render path
  (`src/protocol/wire.rs:1096`, applied at `src/server/render_stream.rs:88`). The `TerminalAnsi`
  arm does **not** compress (`render_stream.rs:113-122`), which is why a `TerminalAnsi` client can
  live without an inflater — but a client that ever accepts `SemanticFrame` needs one.
- **Any other `ClientMessage`.** `Input`, `Resize`, `Detach`, `ControlTerminal` (writable control,
  tag 13 — same `target` as `ObserveTerminal` plus a `takeover: bool`) and the rest are not encoded
  here; their tags are not even transcribed. `Hello` + `ObserveTerminal` is exactly enough to open a
  read-only stream, and `RequestFullFrame` is what keeps it correct after a lost frame.
- **Layout identification.** Equal `PROTOCOL_VERSION` does not prove equal wire layout across the
  mx/upstream fork line (B1).
- **Reconnect, backpressure, ANSI interpretation.** The transport *seam* is here (below); the
  reconnect state machine and watchdog that go on top of it are not
  (`mobile/.prd/05-orca-transport.md` L1–L7).
- **An ssh implementation for React Native.** `src/node/` implements the seam with `ssh2`, for Node
  only. The phone needs a native module (iOS libssh2/NMSSH, Android sshj —
  `mobile/.prd/02-architecture.md` §2.4); this package defines the interface it must satisfy and
  the exact remote command it must run, and nothing more.

## Tests

```
pnpm install
pnpm test           # vitest — codec + transport seam, no binary needed
pnpm typecheck      # tsc --noEmit (src, Node-free) + tsconfig.test.json
pnpm test:live      # vitest against a REAL spawned `herdr server` (needs target/debug/herdr)
pnpm test:live:ssh  # ...reached over a REAL ssh connection (additionally needs an sshd)
```

Golden bytes in `test/vectors.ts` come from real `bincode` v2 `config::standard()` output;
`tools/gen-vectors.rs` regenerates them and documents how. `test/fixtures.test.ts` additionally
cross-checks `docs/next/protocol/fixtures.json` when that file is present.

### The live suite (`test/live/`)

Everything above is byte-level: it proves the codec agrees with a *recording*. `pnpm test:live`
proves it agrees with the *program*. It spawns an XDG-isolated `target/debug/herdr server`, calls
`agent.list` / `pane.list` over the JSON API, handshakes on `herdr-client.sock` as
`TerminalAnsi` + `TerminalAttach`, sends `ObserveTerminal`, and decodes real
`ServerMessage::Terminal` frames — the TypeScript sibling of
[`tests/observe_terminal_ansi.rs`](../../tests/observe_terminal_ansi.rs). It also asserts observing
does not resize the observed pane's PTY (measured with `stty size` *inside* the pane, because
`PaneInfo` carries no size field — `src/api/schema/panes.rs:398-430`).

It is excluded from `pnpm test` on purpose (`vitest.live.config.ts` is a separate runner): it
spawns a process and waits on a shell, and the codec gate should need neither. If the binary is
missing it skips **loudly** on stderr; set `HERDR_LIVE_REQUIRE=1` where the binary is supposed to
exist and the skip becomes a failure instead.

No PTY is involved, unlike the Rust test: measured on this tree, the server comes up fine on plain
pipes (both sockets in ~0.5 s), so `child_process.spawn` is enough. That also keeps the server a
direct child whose pid the harness can signal precisely — it never matches processes by name, since
a developer box typically has several unrelated `herdr server` daemons running.

### The ssh suite (`test/live-ssh/`)

`pnpm test:live:ssh` runs the same handshake → `ObserveTerminal` → real-ANSI-frames scenario, but
with **no socket path anywhere in the test**: every byte goes `ssh exec` → `remote-client-bridge` →
the server's socket and back. It also measures the multiplexing contract — 6 channels, 1 connection.

Isolation is total and deliberate: the suite generates its own host key, client key and
`authorized_keys` into a scratch dir and starts **its own `sshd` on a scratch port**. It never reads
the developer's private keys, never writes `~/.ssh`, and (like the unix suite) signals only pids it
spawned. The bridge is pointed at the test's own server through the command's `env` prefix, so it
cannot reach the developer's daemons. Skips loudly when no `sshd` is found; `HERDR_LIVE_SSHD`
overrides the path and `HERDR_LIVE_REQUIRE=1` turns the skip into a failure.
