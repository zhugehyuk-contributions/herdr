// Rewritten for herdr, from orca mobile/src/transport/protocol-compat.ts:18-42 and
// mobile/src/transport/protocol-version.ts:19-20
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// X6 = blocker B1. The failure orca names is precise: "버전 불일치가 원인불명 재연결 루프로 보임".
// A peer that will never agree is indistinguishable, from the status line, from a peer that is
// merely unreachable — so the loop dials forever and the user is told "Reconnecting…" about a
// condition no amount of reconnecting can change. The cure is a *verdict*, and the verdict has to
// reach L3: `blocked` is latched, never retried (`./channel-failure.ts` `fatal`).
//
// **orca's two-sided window collapses here, and that is a finding, not a simplification.** orca
// negotiates `MOBILE_PROTOCOL_VERSION = 3` against `MIN_COMPATIBLE_DESKTOP_VERSION = 2`, i.e. a
// range. herdr's server does not offer a range: it requires **exact equality**
// (`src/protocol/wire.rs:1225`, and `packages/herdr-client-ts/src/constants.ts` records the same).
// So `MIN_COMPATIBLE_SERVER_VERSION === PROTOCOL_VERSION` is not a value someone chose loosely —
// widening it would only make this file lie about what the server does.
//
// **And a matching version still does not prove compatibility.** mx and upstream/master both report
// 20 while disagreeing on the tags this codec depends on (`ServerMessage::Terminal` is 13 here, 2
// upstream). That is the second `blocked` reason below, and unlike the first it cannot be decided
// from the `Welcome`: only `WireLayoutProbe` can see it, after frames start failing to decode. So
// this file answers what the handshake can answer and defers the rest, rather than pretending a
// version check is a layout check.
import { PROTOCOL_VERSION } from '@herdr/client-ts'

/** The protocol this app speaks. Sourced from the codec so a fork bump stays a one-file diff. */
export const MOBILE_PROTOCOL_VERSION = PROTOCOL_VERSION

/**
 * The oldest server this app can talk to.
 *
 * Equal to {@link MOBILE_PROTOCOL_VERSION} because `Welcome`'s negotiation is exact equality, not a
 * floor. Bump both together, and only when `src/protocol/wire.rs:23` bumps.
 */
export const MIN_COMPATIBLE_SERVER_VERSION = PROTOCOL_VERSION

export type CompatVerdict =
  | { kind: 'ok' }
  | {
      kind: 'blocked'
      reason: 'app-too-old' | 'server-too-old' | 'layout-skew'
      serverVersion: number
    }

export function evaluateCompat(input: {
  serverProtocolVersion: number | undefined
  /** Set once `WireLayoutProbe` has condemned the peer — a version match that decodes as garbage. */
  layoutMismatch?: boolean
}): CompatVerdict {
  const serverVersion = input.serverProtocolVersion ?? 0

  if (serverVersion > MOBILE_PROTOCOL_VERSION) {
    return { kind: 'blocked', reason: 'app-too-old', serverVersion }
  }
  if (serverVersion < MIN_COMPATIBLE_SERVER_VERSION) {
    return { kind: 'blocked', reason: 'server-too-old', serverVersion }
  }
  if (input.layoutMismatch === true) {
    return { kind: 'blocked', reason: 'layout-skew', serverVersion }
  }
  return { kind: 'ok' }
}

/** The hard-block screen's one line. orca's `ProtocolBlockScreen.tsx:13-30`, as a string. */
export function compatBlockMessage(verdict: CompatVerdict): string | null {
  if (verdict.kind === 'ok') {
    return null
  }
  switch (verdict.reason) {
    case 'app-too-old':
      return `This remote speaks herdr protocol ${verdict.serverVersion}; the app speaks ${MOBILE_PROTOCOL_VERSION}. Update the app.`
    case 'server-too-old':
      return `This remote speaks herdr protocol ${verdict.serverVersion}; the app needs ${MIN_COMPATIBLE_SERVER_VERSION}. Update herdr on the remote.`
    case 'layout-skew':
      return `This remote reports protocol ${verdict.serverVersion} but its frames do not match this app's wire layout — it is a different herdr build.`
  }
}
