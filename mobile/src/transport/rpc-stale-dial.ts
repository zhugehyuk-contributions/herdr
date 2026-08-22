// Ported from orca mobile/src/transport/rpc-stale-dial.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// L5 of mobile/.prd/05-orca-transport.md. **One line differs from orca**: the `ConnectionState`
// import, which orca takes from `./types` (a file the port map grades `drop` — the rest of it is
// the WebSocket/E2EE profile model) and this tree takes from `./connection-state-types`. Everything
// below the import is byte-identical, deliberately: the rule is about a *clock*, not a socket.
//
// The prose below says "React Native keeps its readyState at CONNECTING". Read `readyState` as the
// ssh equivalent named in 05-orca-transport.md's closing paragraph — the child is alive and the
// pipe is open and no bytes are coming — which is the same observation with a different name. What
// makes the rule survive the transport swap is that it never inspects either one: it takes a state
// and an age and returns a verdict.
import type { ConnectionState } from './connection-state-types'

// Why: a dial older than this predates the revival signal, so it was opened over a
// network path that may no longer exist. Younger dials belong to the current
// foreground session — AppState 'active' and a Wi-Fi→cellular change fire back to
// back, and both reach the same nudge, so this also keeps them from churning it.
const STALE_DIAL_AGE_MS = 2_000

// A phone suspended mid-dial resumes still holding that socket, and React Native
// keeps its readyState at CONNECTING because no close event was ever delivered.
// Treating 'connecting'/'handshaking' as progress worth waiting out left the user
// on the rest of the 12s connect budget over a dead path, then a preserved backoff
// delay — up to a further 60s of "Connecting…" against an answering desktop.
export function isStaleForegroundDial(state: ConnectionState, dialAgeMs: number): boolean {
  return (state === 'connecting' || state === 'handshaking') && dialAgeMs >= STALE_DIAL_AGE_MS
}

/** Exported for the M4 receipt, which asserts the constant rather than restating it. */
export { STALE_DIAL_AGE_MS }
