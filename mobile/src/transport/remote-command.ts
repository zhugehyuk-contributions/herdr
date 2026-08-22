// Not from orca. The narrowest possible shape of "run one short command on this host and tell me
// how it went", and the reason it is a separate type rather than a method on `HerdrTransport`.
//
// `HerdrTransport` is the *bridge* contract (`packages/herdr-client-ts/src/transport.ts`): every
// channel it opens runs the string `remoteBridgeCommand()` produced, and obligation 2 says the
// implementer never composes one. That is a rule worth keeping — it is why `--session` placement
// and `shell_quote` semantics cannot drift between the Node adapter, Swift and Kotlin — and a
// `runCommand` on that interface would delete it.
//
// So this is a *second*, optional capability, discovered structurally. A transport that has it
// (`modules/herdr-ssh`'s `NativeSshHerdrTransport`) can run the M5 push-token registration
// (`src/notifications/push-token-registration.ts`); one that does not (every unit-test fake, the
// Node live harness) simply reports that it cannot, and the caller degrades instead of crashing.
//
// It is deliberately request/response and not a stream: the only caller writes nothing to stdin,
// reads a few bytes, and needs an exit status. Anything that needs more is a bridge channel.

/** What a finished one-shot exec produced. `exitCode` is `null` when ssh reported a signal instead. */
export interface RemoteCommandResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
}

export interface RemoteCommandOptions {
  /**
   * Hard deadline. A registration that hangs must not hold an ssh channel open forever on a phone:
   * the app dials on every launch, and a leaked channel per launch is a leak per launch.
   */
  timeoutMs?: number
}

export interface RemoteCommandRunner {
  runCommand(command: string, options?: RemoteCommandOptions): Promise<RemoteCommandResult>
}

/** Default deadline. `HerdrSshRemoteConfig.connectTimeoutMs` is 20s and this is a smaller ask. */
export const REMOTE_COMMAND_TIMEOUT_MS = 15_000

/**
 * The structural test, in one place so no caller re-invents a slightly different one.
 *
 * `null` rather than a thrown error: "this transport cannot run commands" is a normal state of
 * every build that has no native ssh module, not an exception.
 */
export function asCommandRunner(value: unknown): RemoteCommandRunner | null {
  if (value === null || typeof value !== 'object') {
    return null
  }
  const candidate = value as Partial<RemoteCommandRunner>
  return typeof candidate.runCommand === 'function' ? (candidate as RemoteCommandRunner) : null
}

/**
 * Turns a finished exec into an error message, or `null` when it succeeded.
 *
 * stderr wins over the exit code in the text because it is the only thing that says *why* — the
 * same reason `NativeChannelClose.stderr` exists at all (implementer obligation 3): a remote that
 * fails at startup writes its whole explanation there and nowhere else.
 */
export function commandFailure(result: RemoteCommandResult): string | null {
  if (result.exitCode === 0) {
    return null
  }
  const detail = result.stderr.trim() || result.stdout.trim()
  const status =
    result.signal !== null
      ? `killed by ${result.signal}`
      : `exited ${result.exitCode === null ? 'without a status' : result.exitCode}`
  return detail.length > 0 ? `${status}: ${detail}` : status
}
