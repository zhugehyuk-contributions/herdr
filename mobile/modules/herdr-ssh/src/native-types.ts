// Not from orca. orca's transport is a WebSocket that React Native already provides; herdr's is an
// ssh exec channel, and React Native has no ssh stack (mobile/.prd/02-architecture.md §2.4 N1).
//
// This file is the **seam between TypeScript and the native module** — nothing more. It is
// deliberately the whole native surface, written as an interface rather than as a
// `requireNativeModule()` call, for the reason `packages/herdr-client-ts/src/transport.ts` is an
// interface rather than the ssh2 client: it is the only part of the ssh path that can be tested
// without a device. `ssh-transport.ts` is written against *these* types, so every obligation in
// `HerdrTransport`'s implementer contract that lives above the wire (4, 6, 7, 8, 9) is provable
// against a fake — see `ssh-transport.test.ts`.
//
// ⚠️ Nothing here may import `expo-modules-core`. That package pulls in `react-native`, which is
// Flow source and cannot be parsed by the test runner's transformer (measured 2026-08-22: importing
// it under vitest fails with `Flow is not supported` at react-native/index.js:1). The one file that
// does the `requireNativeModule()` call is `native-module.ts`, and it is reached only through a
// dynamic `import()` so that a bundle-less environment simply has no native module rather than a
// module-load crash.

/** Why the channel ended, as the native side can observe it. Mirrors `HerdrChannelClose`. */
export interface NativeChannelClose {
  /** Exit status of the remote `herdr`, when ssh delivered an `exit-status` request. */
  exitCode?: number | null
  /** `exit-signal`, when ssh delivered one instead. */
  signal?: string | null
  /**
   * Everything the remote command wrote to stderr, UTF-8 decoded.
   *
   * Obligation 3 of the implementer contract: the bridges report *every* startup failure there and
   * nowhere else (`src/remote/unix.rs:592-611`), so a native module that drops the extended-data
   * stream turns "the remote herdr is a version older than the protocol" into a bare "closed".
   */
  stderr?: string | null
  /**
   * Set when the channel died locally — the ssh session dropped, the write failed, the module was
   * torn down. A string and not an `Error` because there is no Error across the JSI boundary;
   * `ssh-transport.ts` is what turns it back into one.
   */
  errorMessage?: string | null
}

/** One exec channel: a bidirectional byte stream to one remote bridge process. */
export interface NativeSshChannel {
  /**
   * Writes to the remote command's stdin.
   *
   * Obligation 8: resolves on **hand-off** — when the bytes have been accepted by the ssh session's
   * outbound path — not on delivery. This protocol has no delivery receipt.
   */
  write(bytes: Uint8Array): Promise<void>
  /** Sends EOF and tears the channel down. Idempotent. Must still deliver `onClose`. */
  close(): void
}

/**
 * One ssh connection. `openChannel` multiplexes onto it; there is no second dial in this API,
 * which is how obligation 5 ("one connection, N channels") is made unexpressible rather than
 * merely documented.
 */
export interface NativeSshConnection {
  /**
   * Execs `command` **without a pty** and starts pumping it.
   *
   * Two contract points are structural here rather than optional:
   *
   * - Obligation 2: `command` is the string `remoteBridgeCommand()` produced, passed through
   *   verbatim. The native side never composes it, so `--session` placement, `shell_quote`
   *   semantics and the `env` prefix cannot drift between iOS, Android and the Rust arbiter.
   * - Obligation 4: the handlers are **arguments**, so the native side holds them before it sends
   *   the exec request. There is no window between "channel exists" and "listener attached", which
   *   an `addListener`-shaped API would have — and the remote writes the instant it starts.
   *
   * There is deliberately no `pty` parameter: `BRIDGE_EXEC_OPTIONS` is `{ pty: false }` and a pty's
   * line discipline rewrites bytes inside every framed payload (obligation 1). A knob that may only
   * ever hold one value is a knob that will eventually hold the other one.
   */
  openChannel(
    command: string,
    onData: (chunk: Uint8Array) => void,
    onClose: (close: NativeChannelClose) => void
  ): Promise<NativeSshChannel>
  /** Closes every channel and the connection. */
  disconnect(): void
}

/** How to reach one host. Everything ssh-specific, and nothing herdr-specific. */
export interface NativeSshConnectConfig {
  host: string
  port: number
  username: string
  /** OpenSSH/PEM private key text. */
  privateKey: string
  /** Passphrase for an encrypted key, if any. */
  passphrase?: string | undefined
  /**
   * The server's expected host key, as the base64 body of an OpenSSH `SHA256:` fingerprint.
   *
   * Absent + `allowUnknownHostKey !== true` is a **hard failure**, not a warning: a phone has no
   * `known_hosts` to have been seeded from a previous session, so "trust on first use" here is
   * "trust", and the thing being handed over is a key with shell access (blocker B11).
   */
  hostKeySha256?: string | undefined
  /** Opt out of the check above. Exists so the failure is a decision, not an accident. */
  allowUnknownHostKey?: boolean | undefined
  connectTimeoutMs: number
  /** ssh-level keepalive. The app-level watchdog is a separate concern (05-orca-transport.md L1). */
  keepaliveIntervalMs: number
}

/** The native module object itself. */
export interface NativeHerdrSsh {
  connect(config: NativeSshConnectConfig): Promise<NativeSshConnection>
}
