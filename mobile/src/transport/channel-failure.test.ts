// Not from orca. orca's equivalent evidence is a WebSocket close code and its test is a live
// socket; this is the ssh rewrite 05-orca-transport.md prescribes — "WebSocket close code(→ 자식
// exit status + stderr)" — so what needs proving is the *classification*, and specifically the one
// direction that can strand a user: a retryable failure must never be graded fatal, because a fatal
// grade latches the loop L3 exists to keep alive.
import { describe, expect, it } from 'vitest'
import {
  AbiMismatchError,
  LayoutMismatchError,
  ProtocolVersionMismatchError
} from '@herdr/client-ts'
import {
  AUTH_HINT,
  MISSING_BINARY_HINT,
  PROTOCOL_HINT,
  WIRE_ABI_HINT,
  classifyChannelFailure
} from './channel-failure'

describe('the ssh replacement for a WebSocket close code', () => {
  it('a dead TCP path is retryable — the default, and the one that must not drift', () => {
    const verdict = classifyChannelFailure({ error: new Error('read ECONNRESET') })
    expect(verdict).toMatchObject({ kind: 'transport', fatal: false, hint: undefined })
    expect(verdict.detail).toBe('closed (error=read ECONNRESET)')
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
    expect(classifyChannelFailure({}, new ProtocolVersionMismatchError(20, 19)).kind).toBe(
      'protocol'
    )
    expect(
      classifyChannelFailure({}, new LayoutMismatchError([{ tag: 2, name: 'Frame', count: 4 }], 0))
        .fatal
    ).toBe(true)
  })

  it('renders every field of the close into `detail`, in `describeClose`’s one shape', () => {
    // `detail` is the connection log's only account of a death, and this file used to render it
    // with a private copy of `describeClose`. Copies of a renderer drift: the one in
    // `./observe-stream-link.ts` grew an early return that dropped `stderr` whenever an `error` was
    // present, which is the field the `auth` branch above reads. So the shape is pinned here.
    expect(
      classifyChannelFailure({
        exitCode: 2,
        signal: 'SIGTERM',
        stderr: '  boom\n',
        error: new Error('channel closed')
      }).detail
    ).toBe('closed (exit=2 signal=SIGTERM error=channel closed stderr="boom")')
    // Nothing to say is said as one word, not as an empty string.
    expect(classifyChannelFailure({}).detail).toBe('closed')
  })

  it('a refused wire-ABI prelude is fatal — the case where the versions agree', () => {
    // `ServerMessageChannel` refuses a peer on its own prelude before decoding a byte and delivers
    // the verdict on `onError` (`packages/herdr-client-ts/src/transport.ts:970-990`), so it lands
    // here as a handshake error. It used to have no branch at all and fell through to `transport`,
    // i.e. the app retried, forever, a peer whose byte layout can never converge with its own.
    const peer = {
      fork: 'herdr-upstream',
      abiEpoch: 1,
      protocolVersion: 20,
      schemaFingerprint: '0badc0de0badc0de'
    }
    const verdict = classifyChannelFailure(
      {},
      new AbiMismatchError(peer, "peer speaks wire fork 'herdr-upstream', this client speaks 'mx'")
    )
    expect(verdict).toMatchObject({ kind: 'protocol', fatal: true, hint: WIRE_ABI_HINT })
    // Every axis of the peer's identity survives into the log line: this is the failure where both
    // sides report protocol 20, so the *version* is the one field that explains nothing.
    expect(verdict.detail).toContain('fork=herdr-upstream')
    expect(verdict.detail).toContain('abi_epoch=1')
    expect(verdict.detail).toContain('schema=0badc0de0badc0de')

    // A peer that announced nothing has no identity to print, and the absence is the evidence.
    const silent = classifyChannelFailure(
      {},
      new AbiMismatchError(undefined, 'the server sent no herdr-mx wire-ABI prelude')
    )
    expect(silent).toMatchObject({ kind: 'protocol', fatal: true, hint: WIRE_ABI_HINT })
    expect(silent.detail).toBe('the server sent no herdr-mx wire-ABI prelude')
  })

  it('does not print the peer’s axes twice when the message already carries them', () => {
    // `assertPeerAbiAccepted` renders them itself (`packages/herdr-client-ts/src/abi.ts:285-291`);
    // `detail` is one log line, and a doubled one reads as two different peers.
    const peer = {
      fork: 'herdr-mx',
      abiEpoch: 2,
      protocolVersion: 21,
      schemaFingerprint: 'aaaaaaaabbbbbbbb'
    }
    const message =
      'incompatible wire ABI epoch: peer fork=herdr-mx protocol=21 abi_epoch=2 ' +
      'schema=aaaaaaaabbbbbbbb vs this client'
    expect(classifyChannelFailure({}, new AbiMismatchError(peer, message)).detail).toBe(message)
  })

  it('classification is case-insensitive across stderr and the local error alike', () => {
    expect(classifyChannelFailure({ stderr: 'PERMISSION DENIED (PUBLICKEY)' }).kind).toBe('auth')
    expect(classifyChannelFailure({ error: new Error('Command Not Found') }).kind).toBe(
      'missing-binary'
    )
  })
})
