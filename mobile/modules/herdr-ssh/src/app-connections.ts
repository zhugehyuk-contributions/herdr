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
// suites. The hook is also written so that the no-remotes case performs **no state update** — the
// mount tests render this component and must not be handed an out-of-`act` render.
import { useEffect, useState } from 'react'
import { createTransportConnection } from '../../../src/transport/herdr-connection'
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

/** Dials one host. Its own function so one unreachable remote cannot take the others down. */
async function dialRemote(
  native: Awaited<ReturnType<typeof loadNativeHerdrSsh>>,
  config: HerdrSshRemoteConfig
): Promise<{ connection: HerdrRemoteConnection; transport: NativeSshHerdrTransport }> {
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
  const transport = await NativeSshHerdrTransport.connect(native, options)
  return { connection: createTransportConnection(remoteDefinition(config), transport), transport }
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
  const transports: NativeSshHerdrTransport[] = []
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
 * The connections `app/_layout.tsx` hands to `HerdrClientsProvider`.
 *
 * Empty until the dial finishes, and empty forever when nothing is configured — which is exactly
 * the state the app has today, so `HerdrDataProvider` keeps falling back to the mock fixture and no
 * screen learns that anything changed.
 */
export function useHerdrSshConnections(): readonly HerdrRemoteConnection[] {
  const [connections, setConnections] = useState<readonly HerdrRemoteConnection[]>(NO_CONNECTIONS)

  useEffect(() => {
    let live = true
    let opened: readonly { close(): void | Promise<void> }[] = []
    void openConfiguredSshConnections().then((dialed) => {
      opened = dialed.transports
      if (!live) {
        closeAll(opened)
        return
      }
      // No state update when there is nothing to show: the mount suites render this component and
      // a setState after the render they awaited would be an out-of-`act` update.
      if (dialed.connections.length > 0) {
        setConnections(dialed.connections)
      }
    })
    return () => {
      live = false
      closeAll(opened)
    }
  }, [])

  return connections
}

function closeAll(transports: readonly { close(): void | Promise<void> }[]): void {
  for (const transport of transports) {
    void transport.close()
  }
}
