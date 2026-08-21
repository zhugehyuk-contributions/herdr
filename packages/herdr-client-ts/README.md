# `@herdr/client-ts`

Headless **wire codec** for the herdr client protocol — the piece the mobile app needs before any
UI exists. No UI, no transport, no Node built-ins: it turns bytes into messages and back, and
nothing else.

The mobile plan ([`mobile/.prd/02-architecture.md`](../../mobile/.prd/02-architecture.md) §2.2)
reduces the app's hand-written bincode surface to exactly three things, and this package is exactly
those three:

| # | Piece | Direction |
|---|---|---|
| 1 | the `[u32 LE length][bincode payload]` envelope, **incrementally** | both |
| 2 | `ClientMessage::Hello` + `ClientMessage::ObserveTerminal` encode | client → server |
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

const reader = new ServerMessageReader();
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
- **Ordinals live in one file.** `src/constants.ts` — they are *fork-local*; see the warning at the
  top of that file and `mobile/.prd/03-blockers.md` B1.

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
  read-only stream.
- **Layout identification.** Equal `PROTOCOL_VERSION` does not prove equal wire layout across the
  mx/upstream fork line (B1).
- **Transport, reconnect, backpressure, ANSI interpretation.**

## Tests

```
pnpm install
pnpm test          # vitest — codec only, no binary needed
pnpm typecheck     # tsc --noEmit (src, Node-free) + tsconfig.test.json
pnpm test:live     # vitest against a REAL spawned `herdr server` (needs target/debug/herdr)
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
