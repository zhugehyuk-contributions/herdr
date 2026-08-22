// Not from orca. An in-memory `NativeHerdrSsh`, modelled on
// `packages/herdr-client-ts/test/fakeTransport.ts` and for the same reason: the implementer
// contract in `packages/herdr-client-ts/src/transport.ts` is nine obligations, and the ones that
// are *not* about ssh (4, 6, 7, 8, 9) are decided in TypeScript. A fake native layer is the only
// way to prove them without a device, so it is the claim under test rather than a convenience.
//
// What it deliberately does NOT do: resolve `openChannel` before the caller can be surprised. The
// `onOpen` hook fires **synchronously, inside `openChannel`, before the promise settles**, which is
// the shape of a real bridge — `bridge_stdio_to_socket` (`src/remote/unix.rs:568-590`) starts
// pumping the instant the command runs, and `ensure_remote_server_running` (`:592-611`) can write
// its whole failure to stderr and exit before the exec is acknowledged.
import type {
  NativeChannelClose,
  NativeHerdrSsh,
  NativeSshChannel,
  NativeSshConnectConfig,
  NativeSshConnection
} from '../src/native-types'

export class FakeNativeChannel implements NativeSshChannel {
  /** The command string the transport handed over. Obligation 2 is asserted against this. */
  readonly command: string
  /** Every write, in order, copied — so a later mutation by the caller cannot rewrite history. */
  readonly written: Uint8Array[] = []
  /** Writes accepted by the fake's send path. Obligation 8 resolves off this, not off a reply. */
  handedOff = 0
  closeCalls = 0
  closed = false
  /** When set, `write` returns this promise instead of resolving; a test controls the race. */
  pendingWrite: Promise<void> | null = null

  private readonly onData: (chunk: Uint8Array) => void
  private readonly onClose: (close: NativeChannelClose) => void

  constructor(
    command: string,
    onData: (chunk: Uint8Array) => void,
    onClose: (close: NativeChannelClose) => void
  ) {
    this.command = command
    this.onData = onData
    this.onClose = onClose
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.pendingWrite !== null) {
      return this.pendingWrite
    }
    this.written.push(bytes.slice())
    this.handedOff += 1
    // Hand-off, not delivery: nothing on the far side has seen these bytes and this fake has no
    // way to tell the caller when it does. That asymmetry is obligation 8.
    return Promise.resolve()
  }

  close(): void {
    this.closeCalls += 1
    if (this.closed) {
      return
    }
    this.closed = true
    this.onClose({})
  }

  // --- remote side -------------------------------------------------------

  /** Delivers bytes as the remote bridge would. The buffer is the transport's — see obligation 7. */
  emit(chunk: Uint8Array): void {
    this.onData(chunk)
  }

  emitText(text: string): void {
    this.emit(new TextEncoder().encode(text))
  }

  /** Ends the channel from the remote side. */
  die(close: NativeChannelClose = {}): void {
    this.closed = true
    this.onClose(close)
  }
}

export class FakeNativeConnection implements NativeSshConnection {
  readonly channels: FakeNativeChannel[] = []
  disconnects = 0

  /** Runs inside `openChannel`, before it resolves. Where a test scripts the remote's first bytes. */
  onOpen: ((channel: FakeNativeChannel) => void) | null = null
  /** When set, `openChannel` rejects with it. */
  openFailure: Error | null = null
  /**
   * When set, `openChannel` waits on this before resolving — a remote that took the connection and
   * has not acknowledged the exec yet. A test that never settles it is a sshd that never answers.
   */
  openGate: Promise<void> | null = null

  openChannel(
    command: string,
    onData: (chunk: Uint8Array) => void,
    onClose: (close: NativeChannelClose) => void
  ): Promise<NativeSshChannel> {
    if (this.openFailure !== null) {
      return Promise.reject(this.openFailure)
    }
    const channel = new FakeNativeChannel(command, onData, onClose)
    this.channels.push(channel)
    this.onOpen?.(channel)
    // A microtask, so no caller can accidentally depend on a synchronous open. A real exec is a
    // round trip to the server.
    return (this.openGate ?? Promise.resolve()).then(() => channel)
  }

  disconnect(): void {
    this.disconnects += 1
  }

  /** The most recently opened channel. Throws rather than returning `undefined`. */
  last(): FakeNativeChannel {
    const channel = this.channels[this.channels.length - 1]
    if (channel === undefined) {
      throw new Error('no channel has been opened')
    }
    return channel
  }
}

export class FakeNativeSsh implements NativeHerdrSsh {
  /** Every dial. Obligation 5 is the assertion that this stays at length 1. */
  readonly connections: FakeNativeConnection[] = []
  readonly configs: NativeSshConnectConfig[] = []

  connect(config: NativeSshConnectConfig): Promise<NativeSshConnection> {
    this.configs.push(config)
    const connection = new FakeNativeConnection()
    this.connections.push(connection)
    return Promise.resolve(connection)
  }

  only(): FakeNativeConnection {
    const connection = this.connections[0]
    if (connection === undefined) {
      throw new Error('no connection has been opened')
    }
    return connection
  }
}
