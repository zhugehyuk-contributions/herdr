// Ported from orca mobile/src/transport/connection-health.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// L6 of mobile/.prd/05-orca-transport.md. The thresholds, their comments and the order of the gates
// are orca's, unchanged — that ladder is the thing being ported, and its alignment with
// `GIVE_UP_AFTER_ATTEMPTS` is the reason L3's counter is pinned rather than reset (see
// `./reconnect-policy.ts`). Three things changed, each because the concept does not exist here:
//
//   1. **`isTailscaleEndpoint` → an injected `hint`.** orca decides the hint from the endpoint's
//      shape (a `100.x`/`*.ts.net` address means "check Tailscale"). herdr's failure evidence is not
//      an address but the channel's exit status and stderr, which `./channel-failure.ts` has already
//      classified. Passing the hint in keeps this file a pure verdict function instead of teaching
//      it to read ssh errors, and it is what 05's "힌트만 교체" asks for.
//   2. **The relay branch is dropped.** orca's `pendingPath === 'relay'` is its fallback WebSocket
//      path; 02-architecture.md §2.5 lists 릴레이 under 덜어낸다 because ssh *is* the relay. There is
//      no second path to label.
//   3. **`pairingRejected` → `fatalFailure`.** herdr has no pairing. The state that outranks "still
//      connecting" is instead a `ChannelFailure` the loop cannot retry out of — a refused public
//      key, a missing remote binary, a protocol mismatch — and the label names which one.
import type { ConnectionState } from './connection-state-types'
import type { ChannelFailureKind } from './channel-failure'

// Why: thresholds for escalating connection UX from neutral
// "Reconnecting…" to alarming "host appears unreachable, re-pair?".
//
// - WARNING_ATTEMPTS: 3 → label flips to "Can't connect" (existing
//   behavior). Calibrated to absorb a normal laptop wake / brief
//   network blip without alarming the user.
// - UNREACHABLE_ATTEMPTS: 12 → with the tiered 0.5s→60s backoff this
//   is ≈ 6 minutes of continuous failure (the last four attempts all
//   reuse the 60s cap). Combined with the never-connected /
//   stale-since-last-connect heuristic below, this is the trigger to
//   surface a "re-pair?" affordance. MUST stay aligned with
//   reconnect-policy.ts GIVE_UP_AFTER_ATTEMPTS (past which the loop
//   slows to a 90s trickle instead of parking).
// - STALE_SINCE_LAST_CONNECT_MS: 60s → if we WERE connected this
//   session but haven't been for ≥ 1 minute despite the retry loop
//   spinning, treat the same as never-connected. Catches the case
//   where the remote's IP changed mid-session.
export const WARNING_ATTEMPTS = 3
export const UNREACHABLE_ATTEMPTS = 12
export const STALE_SINCE_LAST_CONNECT_MS = 60_000

export type ConnectionVerdict =
  | { kind: 'normal'; label: string }
  | { kind: 'warning'; label: string; hint?: string } // "Can't connect"
  | {
      kind: 'unreachable'
      label: string
      reason: 'never-connected' | 'stale'
      hint?: string
    }
  | { kind: 'auth-failed'; label: string; hint?: string }

/** The label each unretryable failure gets. `transport` never reaches here — it is retryable. */
const FATAL_LABELS: Record<ChannelFailureKind, string> = {
  auth: 'ssh rejected this key — check the remote’s authorized_keys',
  'missing-binary': 'no herdr on the remote — install it or set the binary path',
  protocol: 'this remote speaks a different herdr protocol',
  transport: 'Reconnecting…'
}

// Why: the supervisor's lastConnectedAt is a one-shot timestamp; we have
// to recompute "are we currently stale" against now() each render.
// Centralized so home + pane viewer show identical verdicts.
export function classifyConnection(args: {
  state: ConnectionState
  reconnectAttempts: number
  lastConnectedAt: number | null
  // The hint `./channel-failure.ts` derived from the last close, if any. Shown on
  // warning/unreachable/auth-failed verdicts; callers without one get plain labels.
  hint?: string | null
  // The loop has latched on something retrying cannot fix, so it outranks any "still connecting"
  // reading — the same precedence orca gives `pairingRejected`.
  fatalFailure?: ChannelFailureKind | null
  nowMs?: number
}): ConnectionVerdict {
  const { state, reconnectAttempts, lastConnectedAt } = args
  const now = args.nowMs ?? Date.now()
  const hint = args.hint ?? undefined

  // Why: a fatal failure means dialling again produces the identical result — say what it is
  // instead of animating "Reconnecting…" over a state only the user can change.
  const fatal = args.fatalFailure
  if (fatal !== null && fatal !== undefined && fatal !== 'transport' && state !== 'connected') {
    return { kind: 'auth-failed', label: FATAL_LABELS[fatal], hint }
  }
  if (state === 'auth-failed') {
    return { kind: 'auth-failed', label: FATAL_LABELS.auth, hint }
  }

  if (state === 'connected') {
    return { kind: 'normal', label: 'Connected' }
  }

  if (state === 'disconnected') {
    return { kind: 'normal', label: 'Disconnected' }
  }

  // connecting / handshaking / reconnecting from here. The gates apply to all
  // three: every redial re-enters 'connecting', and letting that revert an
  // escalated verdict to "Connecting…" hid the failure loop behind a reassuring
  // label for most of each cycle (issue #10119).
  if (reconnectAttempts >= UNREACHABLE_ATTEMPTS) {
    if (lastConnectedAt === null) {
      return { kind: 'unreachable', label: 'Can’t reach remote', reason: 'never-connected', hint }
    }
    if (now - lastConnectedAt >= STALE_SINCE_LAST_CONNECT_MS) {
      return { kind: 'unreachable', label: 'Can’t reach remote', reason: 'stale', hint }
    }
  }

  if (reconnectAttempts >= WARNING_ATTEMPTS) {
    return { kind: 'warning', label: 'Can’t connect', hint }
  }

  return { kind: 'normal', label: state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…' }
}

// Why: single place that turns a verdict into display text so every screen
// renders the hint the same way.
export function verdictDisplayLabel(verdict: ConnectionVerdict): string {
  if (verdict.kind !== 'normal' && verdict.hint) {
    return `${verdict.label} — ${verdict.hint}`
  }
  return verdict.label
}

/**
 * L7. orca's session screen computes this inline (`app/h/[hostId]/session/[worktreeId].tsx:4191`):
 * the status line is tappable — and the tap *revives the transport*, it does not resend a request —
 * only when the verdict has escalated. Below that it is a label, because offering "Retry" during a
 * 500ms backoff teaches the user to poke at a loop that is already working.
 */
export function showConnectionRetry(verdict: ConnectionVerdict): boolean {
  return verdict.kind !== 'normal'
}
