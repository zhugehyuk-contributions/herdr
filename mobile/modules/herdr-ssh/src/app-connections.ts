// Not from orca. The junction: `app/_layout.tsx` had `const APP_CONNECTIONS = []` with a comment
// saying the array was empty because React Native has no ssh stack. This is the code that fills it.
//
// Deliberately *only* the injection point. No settings screen, no connection state, no reconnect —
// those are `src/transport/` and port-map stage 8 (`05-orca-transport.md` L1-L7). What this owns is
// the one step nothing else can do: turn configured hosts into `HerdrRemoteConnection`s by dialling
// the native module, and hand them to the provider that already existed.
//
// ⚠️ Both expo imports below are dynamic, for the reason `native-module.ts` explains: a static
// import would make `app/_layout.tsx` unloadable in the test environment and break two existing
// suites.
import { useEffect, useState } from 'react'
import {
  createRedialableConnection,
  type RedialableTransport
} from '../../../src/transport/redialable-transport'
import type { HerdrRemoteConnection } from '../../../src/transport/herdr-connection'
import type { RemoteDefinition } from '../../../src/api/herdr-api-types'
import { loadNativeHerdrSsh } from './native-module'
import { parseConfiguredRemotes, type HerdrSshRemoteConfig } from './remote-config'
import { NativeSshHerdrTransport } from './ssh-transport'

const NO_CONNECTIONS: readonly HerdrRemoteConnection[] = Object.freeze([])

/** What a dial attempt produced, including the parts that failed. Nothing is swallowed silently. */
export interface DialedRemotes {
  connections: readonly HerdrRemoteConnection[]
  /**
   * The transports behind them, because nothing else holds one.
   *
   * `HerdrRemoteConnection` exposes a `JsonApiClient` and a stream opener and no teardown — that is
   * `src/transport/herdr-connection.ts`'s deliberate omission, since ref-counting and reconnection
   * are a whole state machine scheduled for stage 8. Until it lands, whoever dialled is the only
   * one who can hang up, so the handles come back with the connections.
   *
   * Each is now a `RedialableTransport` rather than the ssh connection itself, so closing it closes
   * whichever connection is current — a hang-up that happens after a redial must not leave the
   * *replacement* connection open with nobody holding it.
   */
  transports: readonly { close(): void | Promise<void> }[]
  /** `id: reason` for every host that was configured but could not be reached. */
  failures: string[]
  /** True when this build has no `HerdrSsh` native module — the state before the module ships. */
  nativeModuleMissing: boolean
}

/** Reads `expo.extra.herdrRemotes`. Returns `[]` off a phone, where `expo-constants` will not load. */
async function readConfiguredRemotes(): Promise<HerdrSshRemoteConfig[]> {
  try {
    const constants = await import('expo-constants')
    const extra = constants.default.expoConfig?.extra as Record<string, unknown> | undefined
    return parseConfiguredRemotes(extra?.['herdrRemotes']).remotes
  } catch {
    return []
  }
}

/** `RemoteDefinition` for a host the app dialled itself; `target` is what it dialled. */
function remoteDefinition(config: HerdrSshRemoteConfig): RemoteDefinition {
  const definition: RemoteDefinition = {
    id: config.id,
    name: config.name ?? config.id,
    target: { type: 'ssh', target: `${config.username}@${config.host}` }
  }
  if (config.session !== undefined) {
    definition.session = config.session
  }
  return definition
}

/**
 * Dials one host. Its own function so one unreachable remote cannot take the others down.
 *
 * What comes back is a connection that can be dialled **again** — this file is the "dialer one level
 * down" `src/transport/observe-stream-link.ts` used to say it did not have, and the whole of the
 * supply is the closure below. The same `options` object is reused verbatim on every redial: the
 * remote's identity, its key and its host-key policy are the configuration, and re-deriving them
 * per dial is how two dials to "the same host" end up not being the same host.
 *
 * Nothing here decides *when*. That is L3's pacing and `observe-stream-link.ts`'s criteria; this
 * only makes the verb exist.
 */
async function dialRemote(
  native: Awaited<ReturnType<typeof loadNativeHerdrSsh>>,
  config: HerdrSshRemoteConfig
): Promise<{ connection: HerdrRemoteConnection; transport: RedialableTransport }> {
  if (native === null) {
    throw new Error('no HerdrSsh native module in this build')
  }
  const options = {
    ssh: {
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      passphrase: config.passphrase,
      hostKeySha256: config.hostKeySha256,
      allowUnknownHostKey: config.allowUnknownHostKey,
      connectTimeoutMs: config.connectTimeoutMs,
      keepaliveIntervalMs: config.keepaliveIntervalMs
    },
    ...(config.herdrBinary === undefined ? {} : { herdrBinary: config.herdrBinary }),
    ...(config.session === undefined ? {} : { session: config.session }),
    ...(config.env === undefined ? {} : { env: config.env })
  }
  // The signal is not forwarded and that is not an oversight: `NativeSshHerdrTransport.connect`
  // bottoms out in sshj/libssh2 through a native bridge that has no cancellation, only
  // `connectTimeoutMs` (`./remote-config.ts`, 20s by default). `RedialableTransport` honours it at
  // the seam instead — a connection that lands after the caller gave up is closed, not installed.
  const open = (): Promise<NativeSshHerdrTransport> =>
    NativeSshHerdrTransport.connect(native, options)
  return createRedialableConnection(remoteDefinition(config), await open(), open)
}

/**
 * Dials every configured host, in parallel, and reports the ones that failed.
 *
 * Exported so it can be driven without React — the Node live harness mounts the same app tree with
 * `SshHerdrTransport` instead, and a caller that wants the phone's path without a component has it.
 */
export async function openConfiguredSshConnections(): Promise<DialedRemotes> {
  const configs = await readConfiguredRemotes()
  if (configs.length === 0) {
    return { connections: NO_CONNECTIONS, transports: [], failures: [], nativeModuleMissing: false }
  }
  const native = await loadNativeHerdrSsh()
  const settled = await Promise.allSettled(configs.map((config) => dialRemote(native, config)))
  const connections: HerdrRemoteConnection[] = []
  const transports: RedialableTransport[] = []
  const failures: string[] = []
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      connections.push(result.value.connection)
      transports.push(result.value.transport)
    } else {
      const id = configs[index]?.id ?? String(index)
      failures.push(`${id}: ${errorMessage(result.reason)}`)
    }
  }
  return { connections, transports, failures, nativeModuleMissing: native === null }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * What the app tree knows about the dial: the result **and** whether it has happened yet.
 *
 * Why the whole outcome rather than just the connections, which is all this hook used to return:
 * `src/api/herdr-data-provider.tsx` has to tell *no remote is configured* — where the fixture is
 * the deliberate answer (port map §5, "이 시점 전까지 mock으로 UI가 이미 완성돼 있어야 한다") — from
 * *every configured remote failed*, where the fixture is a lie: four invented nodes and forty
 * invented agents on a phone whose whole job is to say whether a real agent is blocked. Both states
 * carry `connections: []`, so the connection list alone cannot answer the question, and the part
 * that could answer it was discarded here.
 */
export interface SshDialState {
  /** The remotes that answered. */
  connections: readonly HerdrRemoteConnection[]
  /** `id: reason` per configured remote that did not answer. Empty when none was configured. */
  failures: readonly string[]
  /** No `HerdrSsh` in this build (Expo Go, or a bundle predating the module) — not an auth failure. */
  nativeModuleMissing: boolean
  /** False until the dial settles, because "still dialling" is not "nothing was configured". */
  settled: boolean
}

/** The state before the first dial resolves. Frozen: it is shared by every mount. */
const DIALLING: SshDialState = Object.freeze({
  connections: NO_CONNECTIONS,
  failures: Object.freeze([]) as readonly string[],
  nativeModuleMissing: false,
  settled: false
})

/**
 * The dial `app/_layout.tsx` runs once at mount and hands to the providers below it.
 *
 * `settled: false` until it resolves, and settled-with-everything-failed afterwards — the two
 * states the caller needs to keep apart.
 */
export function useHerdrSshConnections(): SshDialState {
  const [dial, setDial] = useState<SshDialState>(DIALLING)

  useEffect(() => {
    let live = true
    let opened: readonly { close(): void | Promise<void> }[] = []
    void openConfiguredSshConnections().then((dialed) => {
      opened = dialed.transports
      if (!live) {
        closeAll(opened)
        return
      }
      // This now updates state in *every* case, the no-remotes one included. It used to update only
      // when a connection existed, to keep the suites that mount `app/_layout.tsx` free of an
      // out-of-`act` render — and that silence is exactly what collapsed "nothing configured" into
      // "nothing answered". The suites flush the dial inside `act` instead
      // (`src/app-shell/route-shell-mount.test.tsx`, `agents-home-mount.test.tsx`: `mountShell`).
      setDial({
        connections: dialed.connections,
        failures: dialed.failures,
        nativeModuleMissing: dialed.nativeModuleMissing,
        settled: true
      })
    })
    return () => {
      live = false
      closeAll(opened)
    }
  }, [])

  return dial
}

function closeAll(transports: readonly { close(): void | Promise<void> }[]): void {
  for (const transport of transports) {
    void transport.close()
  }
}
