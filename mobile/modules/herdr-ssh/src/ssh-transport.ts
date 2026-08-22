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
import {
  REMOTE_COMMAND_TIMEOUT_MS,
  type RemoteCommandOptions,
  type RemoteCommandResult,
  type RemoteCommandRunner
} from '../../../src/transport/remote-command'
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

  /**
   * Abandons a channel the caller never received, without telling anyone it closed.
   *
   * The one user is the exec-ack deadline in `awaitExecAck`, and the missing notification is the
   * point rather than an omission: `openChannel` rejects there, so the caller holds no channel
   * object and its `onClose` would be a *second* signal for one failure. Downstream that is not
   * cosmetic — `PaneObserver` guards its `onClose` by generation (`src/session/pane-observer.ts`)
   * but its `fail()` path does not, so a close followed by a rejection books two failures against
   * one generation and advances the reconnect ladder's attempt counter twice.
   *
   * What it keeps is everything except the notification: `closed` is what makes `bind` close a
   * native channel that lands late, and what routes stray data and writes into the after-close
   * counters; `onFinished` is what keeps a dead channel out of the live set (obligation: one exec
   * per API call — blocker B8 — so a retained entry leaks per request).
   */
  discard(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    // Dropped from the transport's live set: a channel that is over must not be reported again by
    // `NativeSshHerdrTransport.close()`, and holding it would leak one entry per API request
    // (`HerdrChannelKind.ApiRequest` is one exec per call — blocker B8).
    this.onFinished(this)
  }

  /** Delivers `onClose` at most once, whatever the source — the live set is dropped first. */
  finish(close: HerdrChannelClose): void {
    if (this.closed) {
      return
    }
    this.discard()
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
export class NativeSshHerdrTransport implements HerdrTransport, RemoteCommandRunner {
  private readonly connection: NativeSshConnection
  private readonly options: NativeSshTransportOptions
  private readonly live = new Set<NativeChannel>()
  /** One-shot `runCommand` channels. Not bridge channels, but `close()` still owns their teardown. */
  private readonly auxiliary = new Set<NativeSshChannel>()
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
    try {
      // Obligation 4: the handlers cross the bridge *with* the exec request, so bytes the remote
      // emits the instant the command starts have somewhere to land.
      await this.awaitExecAck(
        kind,
        channel,
        this.connection.openChannel(command, channel.onNativeData, channel.onNativeClose)
      )
    } catch (error) {
      this.live.delete(channel)
      throw error
    }
    this.channelsOpened += 1
    return channel
  }

  /**
   * Waits for the exec request to be acknowledged, and refuses to wait forever.
   *
   * Neither native side bounds this on its own in the same way, which is why the deadline is here
   * rather than in Swift and Kotlin: sshj ties `session.exec` to the connect timeout
   * (`android/.../HerdrSshSession.kt`), while Citadel times out opening the *channel* but not the
   * `ExecRequest(wantReply: true)` reply — and the iOS session now waits for that reply before
   * `attach()` returns, so a remote that accepts the TCP connection and then never answers the exec
   * hangs the dial with nothing on screen. One deadline at this seam covers both platforms and is
   * provable in vitest, where a native harness is not.
   *
   * The budget is `ssh.connectTimeoutMs` on purpose, not a new config key: Android's exec already
   * runs under exactly that value, so reusing it keeps the two platforms on one budget instead of
   * two that drift.
   *
   * A TypeScript timeout cannot cancel the native request, so the late arrival is handled rather
   * than wished away: `finish` marks the channel closed (and drops it from `live`) before anything
   * else, and `bind` closes a native channel that lands for an already-closed one — the same rule
   * `app-connections.ts` applies to a connection that lands after the caller gave up.
   */
  private awaitExecAck(
    kind: HerdrChannelKind,
    channel: NativeChannel,
    opening: Promise<NativeSshChannel>
  ): Promise<NativeSshChannel> {
    const timeoutMs = this.options.ssh.connectTimeoutMs
    return new Promise<NativeSshChannel>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Discarded, not finished: the rejection below is the *only* signal this failure gets,
        // because the caller never received a channel to hear an `onClose` about. `discard` still
        // sets the closed flag `bind` reads, so a native channel that lands later is closed.
        // Dropping it from the live set is `discard`'s job; the `catch` in `openChannel` repeats
        // that delete for the native-rejection path, where nothing else has done it.
        channel.discard()
        reject(
          new Error(
            `ssh exec request for the ${kind} channel was not acknowledged within ` +
              `${timeoutMs}ms: the connection is up but the remote never answered the exec`
          )
        )
      }, timeoutMs)
      // Cleared the instant the outcome is known, on both paths. One exec is one channel (blocker
      // B8), so a timer left armed per channel is a live 20s handle for every API call this makes.
      opening.then(
        (native) => {
          clearTimeout(timer)
          // Binds before this promise settles, so the successful path is unchanged; after the
          // deadline this is the late arrival, and `bind` closes it instead of installing it.
          channel.bind(native)
          resolve(native)
        },
        (error: unknown) => {
          clearTimeout(timer)
          // Passed through as it came: the native rejection is the diagnosis. A rejection that
          // arrives after the deadline is dropped by the already-settled promise.
          reject(error)
        }
      )
    })
  }

  /**
   * Runs one short command on this host and waits for it to finish.
   *
   * **Not a bridge channel**, and that distinction is why this is a separate method rather than a
   * parameter on `openChannel`: obligation 2 says a bridge channel runs the string
   * `remoteBridgeCommand()` produced, verbatim, and `openChannel` above still does exactly that.
   * This runs a command the caller composed. There is one caller —
   * `src/notifications/push-token-registration.ts`, which hands each herdr server this phone's push
   * token over the ssh connection it has already authenticated on.
   *
   * It bypasses `NativeChannel` on purpose. That class holds the framing obligations (6, 7, 9) for
   * a channel a *codec* is reading; here nothing is framed, the output is a few bytes of
   * diagnostics and the answer wanted is the exit status. What it keeps is the teardown: the native
   * channel is tracked, so `close()` cannot leave it behind.
   *
   * The timeout is a hard local deadline, not a hint. ssh has no way to cancel a running remote
   * command, so this closes the channel and reports; a phone that dials on every launch cannot
   * afford to leak one channel per launch to a remote that never answers.
   */
  runCommand(command: string, options: RemoteCommandOptions = {}): Promise<RemoteCommandResult> {
    if (this.ended) {
      return Promise.reject(new Error('transport is closed'))
    }
    assertNoPty()
    const timeoutMs = options.timeoutMs ?? REMOTE_COMMAND_TIMEOUT_MS
    const decoder = new TextDecoder()
    let stdout = ''
    let settled = false
    let native: NativeSshChannel | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    return new Promise<RemoteCommandResult>((resolve, reject) => {
      const disarm = () => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }
      const finish = (close: NativeChannelClose) => {
        if (settled) {
          return
        }
        settled = true
        disarm()
        if (native !== null) {
          this.auxiliary.delete(native)
        }
        const converted = toChannelClose(close)
        resolve({
          exitCode: converted.exitCode ?? null,
          signal: converted.signal ?? null,
          stdout,
          // `error` is the *local* side dying rather than the remote's stderr, but it is the only
          // explanation there is going to be, so it is not dropped on the floor.
          stderr: converted.stderr ?? converted.error?.message ?? ''
        })
      }

      timer = setTimeout(() => {
        if (settled) {
          return
        }
        // The verdict is recorded *before* the channel is torn down, and the order is the point:
        // `close()` is allowed to deliver its own close synchronously, and a `finish` that ran
        // second would be the idempotent no-op — turning a timeout into a silent `exit=null` with
        // no explanation attached.
        const dying = native
        finish({ errorMessage: `command timed out after ${timeoutMs}ms` })
        dying?.close()
      }, timeoutMs)

      this.connection
        .openChannel(
          command,
          (chunk: Uint8Array) => {
            if (!settled) {
              stdout += decoder.decode(chunk, { stream: true })
            }
          },
          finish
        )
        .then(
          (opened) => {
            if (settled) {
              // Finished, or timed out, before the exec was acknowledged: nothing is listening.
              opened.close()
              return
            }
            native = opened
            this.auxiliary.add(opened)
          },
          (error: unknown) => {
            if (settled) {
              return
            }
            settled = true
            disarm()
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        )
    })
  }

  close(): void {
    if (this.ended) {
      return
    }
    this.ended = true
    for (const auxiliary of this.auxiliary) {
      auxiliary.close()
    }
    this.auxiliary.clear()
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
