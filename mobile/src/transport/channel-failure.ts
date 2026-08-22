// Not from orca. This file is the `rewrite` half of 02-architecture.md §2.5 for L2 and L6: orca's
// evidence is a WebSocket close *code* (`rpc-socket-close-evidence.ts`, `UNAUTHORIZED_CLOSE_CODE =
// 4001`) and its L6 hint is `isTailscaleEndpoint`, and neither concept survives the transport swap.
// 05-orca-transport.md names the replacements exactly:
//
//   > WebSocket close code(→ 자식 exit status + stderr) … 힌트만 교체: `Permission denied
//   > (publickey)` / `herdr: command not found` / 프로토콜 불일치
//
// So the evidence here is a {@link HerdrChannelClose} — `{exitCode, signal, stderr, error}` — which
// `packages/herdr-client-ts/src/transport.ts` documents as a struct rather than a `void` callback
// for this very reason: "the bridges report *every* startup failure there and nowhere else".
//
// The classification exists to answer one question the reconnect loop must not get wrong: **can
// retrying fix this?** L3 keeps dialling forever on purpose, and that is right for a dead network
// and wrong for a rejected public key — a client that trickles against `Permission denied` burns
// battery for a state only the user can change, and shows "Reconnecting…" while doing it. So a
// `fatal` verdict latches the supervisor instead, which is L6's "에스컬레이션 사다리" and L7's
// tappable status line reaching their real terminal states.
import {
  LayoutMismatchError,
  ProtocolVersionMismatchError,
  type HerdrChannelClose
} from '@herdr/client-ts'

/**
 * Why a channel died, in the only four kinds that change what the app should do.
 *
 * - `auth`: ssh refused the credential. Only re-pairing/re-keying fixes it. orca's `auth-failed`.
 * - `missing-binary`: ssh authenticated and the *command* failed — no `herdr` on the remote PATH.
 *   Distinct from `auth` because the fix is on the far side, and distinct from `transport` because
 *   dialling again will produce exactly the same 127.
 * - `protocol`: the peer speaks a different wire layout. B1/X6. Retrying cannot converge them.
 * - `transport`: everything else — the TCP path died, the exec was killed, the pipe went quiet.
 *   **This is the retryable one**, and it is the default, because guessing `fatal` on an unknown
 *   signal would reintroduce the parked loop L3 exists to abolish.
 */
export type ChannelFailureKind = 'auth' | 'missing-binary' | 'protocol' | 'transport'

export type ChannelFailure = {
  kind: ChannelFailureKind
  /** True when dialling again cannot change the outcome. Only `transport` is false. */
  fatal: boolean
  /** L6's hint slot — the string the status line appends after an em dash. */
  hint: string | undefined
  /** One diagnostic line, for the connection log. Never shown as the primary label. */
  detail: string
}

/** The three hints 05-orca-transport.md L6 names, verbatim, as the user-facing strings. */
export const AUTH_HINT = 'Permission denied (publickey)'
export const MISSING_BINARY_HINT = 'herdr: command not found'
export const PROTOCOL_HINT = 'protocol mismatch'

/**
 * `sh` reports "not found" as 127 and says so on stderr; ssh2 reports a failed key exchange as an
 * `error`, never as an exit code, because the command never ran.
 *
 * Matching on both the code and the text is deliberate: `exitCode === 127` alone would also catch a
 * remote shell whose *own* rc file failed, and the stderr text alone would catch a pane that
 * happened to print it. Either signal is enough here because a bridge channel runs one command and
 * nothing else, and requiring both would miss a transport that cannot observe exit codes at all —
 * which is the React Native case (`mobile/.prd/02-architecture.md` §2.4).
 */
const NOT_FOUND_EXIT = 127

function textOf(close: HerdrChannelClose): string {
  return [close.stderr ?? '', close.error?.message ?? ''].join('\n').toLowerCase()
}

/**
 * Classifies a channel death.
 *
 * `handshakeError` is separate from the close because a wire-layout or version verdict arrives on
 * `ServerMessageChannelHandlers.onError` *while the channel is still open* — the peer is answering,
 * it is simply answering in another dialect. Passing it here keeps one classifier rather than two
 * that can disagree about `fatal`.
 */
export function classifyChannelFailure(
  close: HerdrChannelClose,
  handshakeError?: unknown
): ChannelFailure {
  if (
    handshakeError instanceof ProtocolVersionMismatchError ||
    handshakeError instanceof LayoutMismatchError
  ) {
    return {
      kind: 'protocol',
      fatal: true,
      hint: PROTOCOL_HINT,
      detail: handshakeError.message
    }
  }
  const text = textOf(close)
  // `ensure_remote_server_running` (`src/remote/unix.rs:592-611`) fails with a plain `io::Error`
  // whose text is the only surviving evidence: "remote herdr server is running with protocol N,
  // but this bridge needs protocol M". The process then just exits non-zero, so without this the
  // supervisor would trickle forever against a box that will never agree.
  if (text.includes('but this bridge needs protocol')) {
    return { kind: 'protocol', fatal: true, hint: PROTOCOL_HINT, detail: describe(close) }
  }
  // ssh2 collapses every public-key rejection into one message; the sshd-side wording is the one
  // users recognize, so both are matched and the recognizable one is what gets shown.
  if (
    text.includes('all configured authentication methods failed') ||
    text.includes('permission denied') ||
    text.includes('publickey')
  ) {
    return { kind: 'auth', fatal: true, hint: AUTH_HINT, detail: describe(close) }
  }
  if (close.exitCode === NOT_FOUND_EXIT || text.includes('command not found')) {
    return {
      kind: 'missing-binary',
      fatal: true,
      hint: MISSING_BINARY_HINT,
      detail: describe(close)
    }
  }
  return { kind: 'transport', fatal: false, hint: undefined, detail: describe(close) }
}

/** Local copy of `describeClose`'s shape, kept here so a `ChannelFailure` renders without the codec. */
function describe(close: HerdrChannelClose): string {
  const parts: string[] = []
  if (close.exitCode !== undefined) {
    parts.push(`exit=${close.exitCode}`)
  }
  if (close.signal !== undefined) {
    parts.push(`signal=${close.signal}`)
  }
  if (close.error !== undefined) {
    parts.push(`error=${close.error.message}`)
  }
  const stderr = close.stderr?.trim()
  if (stderr !== undefined && stderr.length > 0) {
    parts.push(`stderr=${JSON.stringify(stderr)}`)
  }
  return parts.length === 0 ? 'closed' : parts.join(' ')
}
