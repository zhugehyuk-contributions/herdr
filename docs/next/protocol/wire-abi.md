# Wire ABI: the handshake prelude, the compatibility window, and the repetition policy

herdr-mx only. Implemented in `src/protocol/abi.rs` (Rust) and
`packages/herdr-client-ts/src/abi.ts` (TypeScript); the bytes are published in
[`fixtures.json`](./fixtures.json) and the decisions in [`abi-history.json`](./abi-history.json).

## The problem this replaces

`PROTOCOL_VERSION` died as a layout identifier before anyone noticed. herdr-mx and upstream/master
both shipped `20`, and disagreed on the bytes a client depends on:

| | herdr-mx | upstream/master |
|---|---|---|
| `PROTOCOL_VERSION` | 20 | 20 |
| `ServerMessage::Terminal` | 13 | 2 |
| `ClientLaunchMode::TerminalAttach` | 1 | 2 |
| `Ping` / `Pong` / `RequestFullFrame` | present | absent |

The fork's merge convention is what produces this, on purpose: upstream-inserted variants go to the
**tail** so existing mx wire tags never move (`ObserveTerminal`'s doc comment in
`src/protocol/wire.rs` records the precedent). The convention is right; the consequence is that the
version integer says nothing about the layout.

So the old handshake had a failure mode with no error in it. Two peers agree on `20`, the
`Welcome` is accepted, and then every frame is mis-classified — "connected, green, black screen,
zero errors". Widening the version check into a range (`MIN..=CURRENT`) makes this *more* likely,
not less: it converts a loud rejection into a silent mis-parse. A window is only safe on top of a
layout identifier.

## The gate (M0-a)

A fixed **28-byte prelude**, written by both peers before the first framed message:

```
offset  size  field
0       4     magic              b"HRDR"
4       8     fork namespace     b"herdr-mx"
12      4     abi_epoch          u32 LE
16      4     protocol_version   u32 LE
20      8     schema_fingerprint sha256(exemplar encodings)[..8]
```

Not bincode, not length-prefixed, fixed width: a prelude that needed a decoder would be a decoder
running ahead of the gate that decides whether decoding is safe.

**Why a prelude and not a field in `Welcome`.** The first value the forks disagree on,
`ClientLaunchMode`, is a **field of `ClientMessage::Hello`**, and the side that decodes `Hello` is
the *server*. A fingerprint carried in the server's `Welcome` would be compared only after the
server had already mis-parsed the client's handshake. The gate has to precede every bincode decode,
in both directions.

**Why the magic is unambiguous, not a heuristic.** A pre-prelude peer's first four bytes are the
`u32` LE length prefix of its `Hello`, and every reader in this protocol caps that length
(`MAX_FRAME_SIZE` 2 MiB, `MAX_GRAPHICS_FRAME_SIZE` 32 MiB). `b"HRDR"` read as that `u32` is
1,380,208,712 — above both caps. "This stream opens with a prelude" and "this stream opens with a
legal frame" therefore cannot both be true. Pinned by
`abi::tests::magic_can_never_be_a_legacy_length_prefix` and by
`test/abi.test.ts > cannot be confused with a legal frame length prefix`.

### The fingerprint, and what it does not cover

Tags alone are not enough: upstream added a `sgr_pixels` field to `MouseCapture` without moving any
tag. So the fingerprint is a sha256 prefix over the **encoded bytes** of an exemplar of every
`ClientMessage` and `ServerMessage` variant, with position-distinct sentinel values. That
transitively covers nested enums (`RenderEncoding`, `ClientLaunchMode`, `ClientInputEvent`,
`ClientKeySource`, …) and payload struct field order and types.

It does **not** cover:

- **field renames** — bincode is positional and encodes no names, so a rename is genuinely not a
  wire change;
- **a swap of two adjacent same-typed fields carrying the same sentinel** — mitigated by giving
  each field position a distinct sentinel, not eliminated;
- **semantic reinterpretation** of an unchanged byte (a `u32` that starts meaning milliseconds);
- anything the exemplar list does not reach. Kept exhaustive over the two top-level enums by
  `wire_exemplars_cover_every_top_level_variant`, whose `match` arms have **no wildcard** — a new
  variant is a compile error before it is a test failure.

A build id would also change on every wire change, and on every *other* build too; it would reject
peers that agree perfectly. That is why the identifier is derived from the schema, not the binary.

`PROTOCOL_VERSION` is deliberately **excluded** from the fingerprint (the exemplars use a fixed
sentinel version): the version is the negotiation axis, the fingerprint is the layout axis, and the
accepted table keys on both separately.

## The window (M0-b)

`abi::accepted_wire_abis()` — an explicit table of `(protocol version, ABI epoch, schema
fingerprint)` triples, mirrored in `packages/herdr-client-ts/src/abi.ts` as `ACCEPTED_WIRE_ABIS`.
`MIN_SUPPORTED_PROTOCOL` is *derived* from the table (`abi::min_supported_protocol`) rather than
declared beside it, so it cannot claim a window the table does not honour.

Today the table has exactly one row, and that is a decision rather than an omission: see the
epoch-0 entry in [`abi-history.json`](./abi-history.json).

## Backward compatibility

- **A peer that sends no prelude is rejected, not guessed at.** It cannot be identified — an
  unannotated protocol-20 `Hello` is equally consistent with herdr-mx and with upstream — and
  accepting it is exactly the silent mis-parse the gate exists to remove.
- **The rejection is diagnosable.** The server answers a prelude-less client with a *legacy-framed*
  `ServerMessage::Welcome { error: Some(..) }` (no prelude in front of it), which an old client
  decodes and prints. The client, symmetrically, chains the four sniffed bytes back so an old
  server's own `Welcome.error` reaches the user instead of an unexplained EOF.
- **`PROTOCOL_VERSION` moved 20 → 21** because the handshake's byte stream changed, and 20 must not
  name two different handshakes — that is the same sin this document opens with. The bump also puts
  the common case on an existing, gentler path: `validate_running_server_compatibility`
  (`src/server/autodetect.rs`) compares the running server's reported protocol *before a socket is
  opened* and prints the session-restart guidance.
- **Same-build peers are unaffected.** The desktop TUI, `herdr attach`, the observe/TerminalAnsi
  stream and the JSON API are byte-identical after the first 28 bytes.

## The repetition policy (M0-e)

Freezing the wire is not the goal; making every later change an *explicit ABI event* is. Three
rules, each mechanized:

| rule | mechanism |
|---|---|
| ① existing fixture corpora are preserved, never overwritten | `archived_fixture_corpora_are_immutable` — only the newest entry may point at `fixtures.json`; every earlier one pins its archive's sha256 |
| ② a wire change requires an epoch bump **and** a new corpus | `abi::tests::wire_schema_fingerprint_is_pinned` (layout moved) + `abi_history_records_the_current_abi` (the ledger must carry the new epoch and fingerprint) + `fixtures_are_current` (the corpus must be regenerated) |
| ③ whether an older ABI stays accepted is a recorded decision | `abi_history_mirrors_the_accepted_table` — every ledger row states `accepted_by_current_server` with a reason, and the `true` rows must equal `abi::accepted_wire_abis()` |

### Procedure when the wire changes

1. `wire_schema_fingerprint_is_pinned` goes red. **Classify first.** If an enum ordinal moved during
   an upstream merge, that is a merge-resolution bug — fix the enum order (tail rule), do not
   repin.
2. Otherwise: bump `WIRE_ABI_EPOCH`, repin `WIRE_SCHEMA_FINGERPRINT`.
3. `cp docs/next/protocol/fixtures.json docs/next/protocol/fixtures/protocol-<N>-epoch-<E>.json`,
   mark it frozen in its `$comment`, and record its sha256.
4. Append an entry to `abi-history.json` with the new triple, the new corpus, and an explicit
   `accepted_by_current_server` decision for the **outgoing** ABI.
5. Regenerate: `HERDR_UPDATE_WIRE_FIXTURES=1 just test-one fixtures_are_current`.
6. Update `packages/herdr-client-ts/src/abi.ts` (`WIRE_ABI_EPOCH`, `WIRE_SCHEMA_FINGERPRINT`);
   `test/fixtures.test.ts` fails until the transcription matches the generated corpus.

**Worked example — epoch 1 → 2 (2026-08-22, M6/B6).** `ClientMessage::RetargetTerminal` was appended
at tag 14. No existing tag or payload moved, so this is the *cheapest possible* wire change, and it
still cost every step above: the fingerprint went `3ce2d29b371f9dbe` → `827ef6800c3af3ee` because
the exemplar list grew, `fixtures.json` was archived as `fixtures/protocol-21-epoch-1.json` with its
sha256 pinned, and the ledger gained a row. Two things that example settles:

- **`PROTOCOL_VERSION` did not move**, and that is the design working. The handshake's byte stream
  is identical; only the set of messages a peer may legally send grew. Bumping the version too would
  fold the layout axis back into the negotiation axis, which is the defect this whole mechanism
  exists to undo.
- **The outgoing epoch was *rejected*, and not for the epoch-0 reason.** Epoch 1 identifies itself
  perfectly, and an epoch-1 *client* against this server would in fact be safe — it can never emit
  tag 14. The reverse cannot be: an epoch-2 client sends `RetargetTerminal` on its first pane swipe
  and an epoch-1 server fails the decode. `check_peer_abi` is one table used by both ends, so
  accepting epoch 1 would buy the safe direction at the price of the unsafe one. A tail-only
  addition is therefore **not** automatically window-compatible; without per-capability negotiation
  in `Welcome`, the honest window stays empty.

## Where the tests are

| claim | test |
|---|---|
| an upstream-layout client is refused **before** its `Hello` is decoded | `server::client_transport::tests::upstream_layout_client_is_rejected_before_its_hello_is_decoded` |
| a well-formed prelude-less `Hello` is refused too (identity, not decodability) | `…::a_well_formed_hello_without_a_prelude_is_still_rejected` |
| a same-version, different-layout peer is refused on the fingerprint | `…::a_peer_announcing_a_different_layout_is_rejected_on_the_fingerprint` |
| the client refuses an unidentified server whose `Welcome` would have parsed | `client::tests::a_server_without_a_prelude_is_refused_even_when_its_welcome_would_have_parsed` |
| an old server's rejection reason still reaches the user | `client::tests::a_legacy_servers_rejection_reason_survives_the_gate` |
| `ServerMessage` tags are frozen (M0-c) | `protocol::wire::tests::server_message_wire_tags_preserve_protocol_20_order` |
| the published prelude is the bytes the gate reads | `protocol::wire_fixtures::prelude_vector_is_the_bytes_the_gate_reads` |
| the TS transcription matches the generated corpus | `packages/herdr-client-ts/test/fixtures.test.ts` |
| the TS client refuses, and decodes nothing, on an unidentified peer | `packages/herdr-client-ts/test/abi.test.ts` |
| the whole thing over a real server and a real ssh bridge | `test/live/observeTerminal.live.test.ts`, `test/live-ssh/sshTransport.live.test.ts` |

## Relationship to `WireLayoutProbe`

`packages/herdr-client-ts/src/layoutProbe.ts` was the client-side *inference* — repeated
undecodable tags with no `Terminal` behind them — and its own docs named this gate as the real fix.
It is kept, demoted to a backstop, because the two ask different questions: the prelude checks what
a peer **claims**, the probe checks how a peer **behaves**. Against a plain upstream server the
probe should now never fire, because the prelude refuses that peer first; if it does fire, the
announcement was false.
