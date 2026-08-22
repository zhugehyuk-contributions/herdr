// Not from orca.
//
// The React Native half of the transport seam: a `HerdrTransport`
// (`packages/herdr-client-ts/src/transport.ts`) implemented over the native ssh module. The Node
// half is `packages/herdr-client-ts/src/node/sshTransport.ts` and that file is the reference this
// one has to match — same interface, same nine obligations, a different stack underneath.
//
// The split between this file and `native-types.ts` is the point: everything the obligations demand
// that is *not* ssh — handler attachment order, per-channel isolation, buffer ownership, write/close
// races, the exec-without-pty rule, the command string's provenance — is decided here, in
// TypeScript, where `ssh-transport.test.ts` can prove it against a fake native layer. What is left
// on the other side of `NativeSshConnection` is genuinely ssh: key exchange, auth, host keys, the
// exec request, and reading the channel's two data streams.
import {
  BRIDGE_EXEC_OPTIONS,
  remoteBridgeCommand,
  type HerdrChannel,
  type HerdrChannelClose,
  type HerdrChannelHandlers,
  type HerdrChannelKind,
  type HerdrTransport,
  type RemoteBridgeCommandOptions
} from '@herdr/client-ts'
import type {
  NativeChannelClose,
  NativeHerdrSsh,
  NativeSshChannel,
  NativeSshConnectConfig,
  NativeSshConnection
} from './native-types'

/** Connection + command options. The command half is `packages/herdr-client-ts`'s, verbatim. */
export interface NativeSshTransportOptions extends RemoteBridgeCommandOptions {
  ssh: NativeSshConnectConfig
}

/**
 * Turns the native module's close record into the codec's.
 *
 * `null` and `undefined` are both "absent" here because they arrive from two different bridges:
 * Kotlin's nullable fields marshal as `null`, Swift's optionals as `undefined`. `HerdrChannelClose`
 * uses `undefined` for absent, and `describeClose` (`packages/herdr-client-ts/src/transport.ts`)
 * tests fields with `!== undefined` — so a `null` that leaked through would print as `exit=null`.
 */
export function toChannelClose(close: NativeChannelClose): HerdrChannelClose {
  const result: HerdrChannelClose = {}
  if (close.exitCode !== undefined && close.exitCode !== null) {
    result.exitCode = close.exitCode
  }
  if (close.signal !== undefined && close.signal !== null) {
    result.signal = close.signal
  }
  // Obligation 3: stderr is the bridges' only error channel and it survives the conversion even
  // when it is the *only* field, which is exactly the startup-failure case.
  if (close.stderr !== undefined && close.stderr !== null && close.stderr.length > 0) {
    result.stderr = close.stderr
  }
  if (close.errorMessage !== undefined && close.errorMessage !== null) {
    result.error = new Error(close.errorMessage)
  }
  return result
}

/**
 * One exec channel.
 *
 * Three of the obligations are enforced by the two latches below rather than by the native side,
 * because "the native side promises" is not a property this repo can test:
 *
 * - **6 (ordered, exactly once)** — `onData` after `onClose` is dropped and counted. The framer
 *   above is length-prefixed, so a byte delivered after the reader was told the stream ended does
 *   not cost an event, it desynchronizes the frame boundary permanently.
 * - **9 (write racing close must not throw)** — a write after close resolves and is counted, and a
 *   native rejection that arrives after close is swallowed. `close()` is asynchronous on every real
 *   transport, so this race is normal traffic, not an error.
 * - **onClose exactly once** — whichever arrives first wins: the native close event, or the
 *   synthetic one `NativeSshHerdrTransport.close()` delivers.
 */
export class NativeChannel implements HerdrChannel {
  readonly kind: HerdrChannelKind
  /** Chunks that arrived after `onClose`. Zero is the number a test should be able to assert. */
  dataAfterClose = 0
  /** Writes that landed after the channel was gone. Counted, never thrown — obligation 9. */
  writesAfterClose = 0

  private native: NativeSshChannel | null = null
  private closed = false
  private readonly handlers: HerdrChannelHandlers
  private readonly onFinished: (channel: NativeChannel) => void

  constructor(
    kind: HerdrChannelKind,
    handlers: HerdrChannelHandlers,
    onFinished: (channel: NativeChannel) => void
  ) {
    this.kind = kind
    this.handlers = handlers
    this.onFinished = onFinished
  }

  /**
   * The `onData` the native side is handed, before the exec request goes out (obligation 4).
   *
   * The chunk is forwarded **by reference** (obligation 7): the buffer belongs to the transport and
   * is valid only for the duration of the call, and a consumer that keeps bytes copies them — which
   * the codec does, in `FrameReader.push` and `LineAccumulator.push`. Adding a defensive copy here
   * would pay that cost twice on every 55 KB frame.
   */
  readonly onNativeData = (chunk: Uint8Array): void => {
    if (this.closed) {
      this.dataAfterClose += 1
      return
    }
    this.handlers.onData(chunk)
  }

  readonly onNativeClose = (close: NativeChannelClose): void => {
    this.finish(toChannelClose(close))
  }

  /** Attaches the native channel once `openChannel` has resolved. */
  bind(native: NativeSshChannel): void {
    this.native = native
    if (this.closed) {
      // The remote died between the exec request and its acknowledgement; nothing is listening.
      native.close()
    }
  }

  /** Delivers `onClose` at most once, whatever the source. */
  finish(close: HerdrChannelClose): void {
    if (this.closed) {
      return
    }
    this.closed = true
    // Dropped from the transport's live set first: a channel that has been reported closed must not
    // be reported again by `NativeSshHerdrTransport.close()`, and holding it would leak one entry
    // per API request (`HerdrChannelKind.ApiRequest` is one exec per call — blocker B8).
    this.onFinished(this)
    this.handlers.onClose(close)
  }

  write(bytes: Uint8Array): Promise<void> {
    const native = this.native
    if (this.closed || native === null) {
      this.writesAfterClose += 1
      return Promise.resolve()
    }
    // Obligation 8: this promise is the native side's hand-off, not a delivery receipt.
    return native.write(bytes).catch((error: unknown) => {
      if (this.closed) {
        // Obligation 9 again, from the other direction: the channel died while the bytes were in
        // flight. `onClose` already reported the end; a second rejection here would surface as an
        // unhandled rejection in whichever `ServerMessageChannel.send` did not await it.
        this.writesAfterClose += 1
        return
      }
      throw error
    })
  }

  close(): void {
    this.native?.close()
  }
}

/**
 * One host: one ssh connection, N exec channels.
 *
 * Obligation 5 is structural. `connect` is the only place `NativeHerdrSsh.connect` is called and
 * `openChannel` can do nothing but ask the one connection it holds — mirroring
 * `SshHerdrTransport`'s arrangement, `connectionCount` included, so the same assertion can be made
 * on both sides of the seam instead of trusting the prose.
 */
export class NativeSshHerdrTransport implements HerdrTransport {
  private readonly connection: NativeSshConnection
  private readonly options: NativeSshTransportOptions
  private readonly live = new Set<NativeChannel>()
  private connections = 1
  private channelsOpened = 0
  private ended = false

  private constructor(connection: NativeSshConnection, options: NativeSshTransportOptions) {
    this.connection = connection
    this.options = options
  }

  /** ssh connections established. One transport is one host, so this must stay at 1. */
  get connectionCount(): number {
    return this.connections
  }

  /** Exec channels opened over the lifetime of this transport. */
  get channelCount(): number {
    return this.channelsOpened
  }

  static async connect(
    native: NativeHerdrSsh,
    options: NativeSshTransportOptions
  ): Promise<NativeSshHerdrTransport> {
    assertHostKeyPolicy(options.ssh)
    const connection = await native.connect(options.ssh)
    return new NativeSshHerdrTransport(connection, options)
  }

  /**
   * Returns the concrete channel rather than the interface, so a test can read `dataAfterClose` /
   * `writesAfterClose` — the two counters that make obligations 6 and 9 assertable instead of
   * asserted. `HerdrTransport.openChannel` is satisfied either way.
   */
  async openChannel(
    kind: HerdrChannelKind,
    handlers: HerdrChannelHandlers
  ): Promise<NativeChannel> {
    if (this.ended) {
      throw new Error('transport is closed')
    }
    assertNoPty()
    // Obligation 2: the string this package produced, passed through verbatim. Rebuilding it in
    // Swift and Kotlin is what would let three implementations disagree about `shell_quote`.
    const command = remoteBridgeCommand(kind, this.options)
    const channel = new NativeChannel(kind, handlers, (done) => this.live.delete(done))
    this.live.add(channel)
    let native: NativeSshChannel
    try {
      // Obligation 4: the handlers cross the bridge *with* the exec request, so bytes the remote
      // emits the instant the command starts have somewhere to land.
      native = await this.connection.openChannel(
        command,
        channel.onNativeData,
        channel.onNativeClose
      )
    } catch (error) {
      this.live.delete(channel)
      throw error
    }
    channel.bind(native)
    this.channelsOpened += 1
    return channel
  }

  close(): void {
    if (this.ended) {
      return
    }
    this.ended = true
    const closing = [...this.live]
    this.live.clear()
    this.connection.disconnect()
    // Every channel gets exactly one termination, even if the native side is already gone — which
    // is the case this synthetic close exists for. `NativeChannel.finish` is idempotent, so a real
    // close event that arrives behind this one is dropped rather than double-reported.
    for (const channel of closing) {
      channel.finish({ error: new Error('transport closed') })
    }
  }
}

/**
 * Obligation 1, as a check rather than a comment.
 *
 * `BRIDGE_EXEC_OPTIONS` is the protocol layer's instruction and the native API has no pty knob to
 * pass it to, so the two could silently disagree if that constant ever changed. A pty inserts a
 * line discipline in front of a pure byte pump (`src/remote/unix.rs:568-590`): CR/LF translation
 * rewrites bytes *inside* framed payloads, and the result is a total, silent corruption that reads
 * as a codec bug. Failing the open is the cheap end of that.
 */
function assertNoPty(): void {
  if (BRIDGE_EXEC_OPTIONS.pty !== false) {
    throw new Error(
      'BRIDGE_EXEC_OPTIONS.pty is no longer false; the native ssh module execs without a pty and ' +
        'cannot honour it — see obligation 1 in packages/herdr-client-ts/src/transport.ts'
    )
  }
}

/**
 * Refuses to dial a host whose key this app cannot check.
 *
 * Not a native concern: the native side would have to decide what to do with a missing fingerprint,
 * and the safe answer is a decision the caller has to make explicitly. A phone has no `known_hosts`
 * seeded by previous sessions, so accepting an unknown key is accepting whatever answered the DNS
 * name — and the credential at stake is an ssh key with shell access (`03-blockers.md` B11).
 */
function assertHostKeyPolicy(ssh: NativeSshConnectConfig): void {
  const fingerprint = ssh.hostKeySha256?.trim() ?? ''
  if (fingerprint.length > 0 || ssh.allowUnknownHostKey === true) {
    return
  }
  throw new Error(
    `no host key fingerprint configured for ${ssh.host}: set hostKeySha256 (the base64 body of ` +
      "the server's `SHA256:` fingerprint) or opt out explicitly with allowUnknownHostKey"
  )
}
