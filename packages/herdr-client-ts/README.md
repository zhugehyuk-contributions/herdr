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
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit (src, Node-free) + tsconfig.test.json
```

Golden bytes in `test/vectors.ts` come from real `bincode` v2 `config::standard()` output;
`tools/gen-vectors.rs` regenerates them and documents how. `test/fixtures.test.ts` additionally
cross-checks `docs/next/protocol/fixtures.json` when that file is present.
