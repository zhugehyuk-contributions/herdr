// Not from orca. orca's equivalent evidence is a WebSocket close code and its test is a live
// socket; this is the ssh rewrite 05-orca-transport.md prescribes — "WebSocket close code(→ 자식
// exit status + stderr)" — so what needs proving is the *classification*, and specifically the one
// direction that can strand a user: a retryable failure must never be graded fatal, because a fatal
// grade latches the loop L3 exists to keep alive.
import { describe, expect, it } from 'vitest'
import { LayoutMismatchError, ProtocolVersionMismatchError } from '@herdr/client-ts'
import {
  AUTH_HINT,
  MISSING_BINARY_HINT,
  PROTOCOL_HINT,
  classifyChannelFailure
} from './channel-failure'

describe('the ssh replacement for a WebSocket close code', () => {
  it('a dead TCP path is retryable — the default, and the one that must not drift', () => {
    const verdict = classifyChannelFailure({ error: new Error('read ECONNRESET') })
    expect(verdict).toMatchObject({ kind: 'transport', fatal: false, hint: undefined })
    expect(verdict.detail).toContain('ECONNRESET')
  })

  it('an unexplained close is retryable, not fatal', () => {
    // Airplane mode gives no exit code, no signal and no stderr — the channel simply ends. Grading
    // that fatal would be exactly the parked loop of #5049 wearing a new name.
    expect(classifyChannelFailure({}).fatal).toBe(false)
    expect(classifyChannelFailure({ signal: 'SIGKILL' }).fatal).toBe(false)
    expect(classifyChannelFailure({ exitCode: 1 }).fatal).toBe(false)
    expect(classifyChannelFailure({ exitCode: 255 }).fatal).toBe(false)
  })

  it('a refused public key is fatal and says so in the words the user will recognize', () => {
    const fromSshd = classifyChannelFailure({ stderr: 'Permission denied (publickey).' })
    expect(fromSshd).toMatchObject({ kind: 'auth', fatal: true, hint: AUTH_HINT })
    // ssh2 collapses every key rejection into one message; both spellings must reach the same verdict.
    const fromSsh2 = classifyChannelFailure({
      error: new Error('All configured authentication methods failed')
    })
    expect(fromSsh2).toMatchObject({ kind: 'auth', fatal: true, hint: AUTH_HINT })
  })

  it('no herdr on the remote is fatal — 127 and the text each suffice', () => {
    expect(classifyChannelFailure({ exitCode: 127 })).toMatchObject({
      kind: 'missing-binary',
      fatal: true,
      hint: MISSING_BINARY_HINT
    })
    // A React Native transport may not observe exit codes at all (02-architecture.md §2.4), so the
    // stderr text has to stand on its own.
    expect(
      classifyChannelFailure({ stderr: 'bash: line 1: herdr: command not found' })
    ).toMatchObject({ kind: 'missing-binary', fatal: true })
  })

  it('the bridge’s protocol-mismatch io::Error is fatal — matched on the server’s own words', () => {
    // `ensure_remote_server_running`, `src/remote/unix.rs:592-611`, verbatim shape.
    const stderr =
      'remote herdr server is running with protocol 19, but this bridge needs protocol 20; ' +
      'rerun `herdr --remote` from an interactive terminal to approve stopping it'
    expect(classifyChannelFailure({ stderr, exitCode: 1 })).toMatchObject({
      kind: 'protocol',
      fatal: true,
      hint: PROTOCOL_HINT
    })
  })

  it('a handshake verdict outranks the close: the peer answered, in another dialect', () => {
    // These arrive while the channel is still open — the version check and the wire-layout probe.
    expect(
      classifyChannelFailure({}, new ProtocolVersionMismatchError(20, 19)).kind
    ).toBe('protocol')
    expect(
      classifyChannelFailure({}, new LayoutMismatchError([{ tag: 2, name: 'Frame', count: 4 }], 0))
        .fatal
    ).toBe(true)
  })

  it('classification is case-insensitive across stderr and the local error alike', () => {
    expect(classifyChannelFailure({ stderr: 'PERMISSION DENIED (PUBLICKEY)' }).kind).toBe('auth')
    expect(classifyChannelFailure({ error: new Error('Command Not Found') }).kind).toBe(
      'missing-binary'
    )
  })
})
