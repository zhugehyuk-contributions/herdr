// Not from orca — orca pairs over a URL and has nothing to reach for. This is the mockup's
// reachability line (`.prd/assets/mockup.html:460` — `✓ reachable · herdr 0.34.1 · protocol 12 ·
// 41ms`), which the first mockup audit found missing and ranked P0
// (`.prd/11-mockup-conformance.md` 누락 #9).
//
// Why P0: adding a remote on this client means typing a host, a port, a username and a **private
// key body** into a phone, and until now the app said nothing afterwards. A wrong port and a wrong
// key look identical — a list that stays empty. The probe is the difference between "I mistyped
// something" and "the box is down", and it is the reason the QR screen (누락 #1) exists at all.
//
// It dials rather than reusing a connection on purpose: the whole point is to test a remote the
// app is not connected to — a draft the user is still editing, or a saved one that stopped
// answering. It tears the connection down before returning, so a probe costs one ssh connection
// and one exec and leaves nothing behind (blocker B8's accounting).
import { NativeSshHerdrTransport } from './ssh-transport'
import { loadNativeHerdrSsh } from './native-module'
import type { HerdrSshRemoteConfig } from './remote-config'

/** What the mockup's line is made of, plus the failure it has to be able to say instead. */
export type RemoteProbe =
  | { ok: true; version: string; protocol: string | null; elapsedMs: number }
  | { ok: false; reason: string; elapsedMs: number }

/**
 * A probe is a person waiting on a spinner, so it gets its own deadline rather than the dial's.
 * `connectTimeoutMs` defaults to 20s (`./remote-config.ts`); waiting that long to be told a port is
 * wrong is the same as no answer.
 */
export const PROBE_TIMEOUT_MS = 8_000

/**
 * Reads `herdr --version` output into the two fields the mockup shows.
 *
 * Exported for its own test: the shape of that output is the server's, not ours, and a parser that
 * silently returns `null` for a format change would render the line without the number that makes
 * it worth reading.
 */
export function parseHerdrVersion(stdout: string): { version: string; protocol: string | null } {
  const text = stdout.trim()
  // `?? 'unknown'` alone does not hold here: `''.split(/\s+/)[0]` is `''`, not `undefined`, so an
  // empty stdout would render a line with a hole where the version goes.
  const matched = /herdr\s+([0-9][^\s]*)/i.exec(text)?.[1]
  const firstWord = text.split(/\s+/)[0]
  const version =
    matched ?? (firstWord !== undefined && firstWord.length > 0 ? firstWord : 'unknown')
  const protocol = /protocol\s+([0-9]+)/i.exec(text)?.[1] ?? null
  return { version, protocol }
}

/**
 * Dials `config`, asks the remote `herdr` what it is, and hangs up.
 *
 * Every failure becomes `{ok:false}` rather than a throw, because every one of them is a normal
 * answer for this button: no native module in this build, a refused key, a wrong port, a host that
 * does not have `herdr` on its PATH. The caller renders `reason` next to the ✗.
 */
export async function probeSshRemote(config: HerdrSshRemoteConfig): Promise<RemoteProbe> {
  const started = Date.now()
  const elapsed = (): number => Date.now() - started
  const native = await loadNativeHerdrSsh()
  if (native === null) {
    return { ok: false, reason: 'no ssh module in this build', elapsedMs: elapsed() }
  }
  let transport: NativeSshHerdrTransport | null = null
  try {
    transport = await NativeSshHerdrTransport.connect(native, {
      ssh: {
        host: config.host,
        port: config.port,
        username: config.username,
        privateKey: config.privateKey,
        passphrase: config.passphrase,
        hostKeySha256: config.hostKeySha256,
        allowUnknownHostKey: config.allowUnknownHostKey,
        connectTimeoutMs: Math.min(config.connectTimeoutMs, PROBE_TIMEOUT_MS),
        keepaliveIntervalMs: config.keepaliveIntervalMs
      },
      ...(config.herdrBinary === undefined ? {} : { herdrBinary: config.herdrBinary })
    })
    const binary = config.herdrBinary ?? 'herdr'
    const result = await transport.runCommand(`${binary} --version`, {
      timeoutMs: PROBE_TIMEOUT_MS
    })
    if (result.exitCode !== 0) {
      // The remote answered ssh and then could not run the binary — a different problem from an
      // unreachable host, and the one `herdrBinary` exists to fix, so say which it was.
      const detail = (result.stderr || result.stdout).trim().split('\n')[0] ?? ''
      return {
        ok: false,
        reason: detail.length > 0 ? detail : `${binary} exited ${String(result.exitCode)}`,
        elapsedMs: elapsed()
      }
    }
    return { ok: true, ...parseHerdrVersion(result.stdout), elapsedMs: elapsed() }
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      elapsedMs: elapsed()
    }
  } finally {
    // Before the return value is read, and swallowing its own failure: a probe that cannot hang up
    // must still report what it learned, and a leaked ssh connection per button press is a leak per
    // button press.
    try {
      await transport?.close()
    } catch {
      // Already gone is the normal case here.
    }
  }
}

/** The mockup's line (`:460`), rendered from a finished probe. */
export function describeProbe(probe: RemoteProbe): string {
  if (!probe.ok) {
    return `✗ ${probe.reason} · ${String(probe.elapsedMs)}ms`
  }
  const protocol = probe.protocol === null ? '' : ` · protocol ${probe.protocol}`
  return `✓ reachable · herdr ${probe.version}${protocol} · ${String(probe.elapsedMs)}ms`
}
