// Ported from orca mobile/src/transport/types.ts:54-60 and mobile/src/transport/connection-health.ts:33-42.
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Only the two types `StatusDot` consumes. Their homes in orca are `types.ts` (whose rest is the
// WebSocket/E2EE profile model — port map §2.3 grades that whole family `drop`) and
// `connection-health.ts` (graded `port`, scheduled for M4 stage 8 as L6). Re-declaring the types is
// the mitigation the port map prescribes for exactly this case (§6 risk 1, "이식하는 타입만
// 재정의한다"), and it keeps a stage-2 presentational component off a stage-8 dependency.
//
// The `ConnectionState` members survive the transport swap unchanged: ssh has a dial
// (`connecting`), a herdr `Hello`/`Welcome` exchange (`handshaking`), a live channel (`connected`),
// a retry loop (`reconnecting`), and `Permission denied (publickey)` (`auth-failed`).

/** Verbatim from orca. */
export type ConnectionState =
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'auth-failed'

/**
 * The discriminator of orca's `ConnectionVerdict` only. The full union carries `label`/`hint`/
 * `reason` strings that L6 produces from ssh failure modes, which do not exist yet; a structural
 * `{ kind }` lets the dot escalate today and widens without a change here when L6 lands.
 */
export type ConnectionVerdictKind = 'normal' | 'warning' | 'unreachable' | 'auth-failed'
