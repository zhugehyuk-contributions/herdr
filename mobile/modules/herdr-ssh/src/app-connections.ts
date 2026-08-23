// Not from orca. The junction: `app/_layout.tsx` had `const APP_CONNECTIONS = []` with a comment
// saying the array was empty because React Native has no ssh stack. This is the code that fills it.
//
// Deliberately *only* the injection point. No settings screen, no connection state — those are
// `src/transport/` and port-map stage 8 (`05-orca-transport.md` L1-L7). What this owns is the one
// step nothing else can do: turn configured hosts into `HerdrRemoteConnection`s by dialling the
// native module, and hand them to the provider that already existed.
//
// The *when* of a second attempt is not here either, and used to be nowhere: `./dial-loop.ts` holds
// it, over L3's ladder, because a remote whose first dial failed never reached the layer that
// retries everything else (its header has the measurement).
//
// ⚠️ Both expo imports below are dynamic, for the reason `native-module.ts` explains: a static
// import would make `app/_layout.tsx` unloadable in the test environment and break two existing
// suites.
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  createRedialableConnection,
  type RedialableTransport
} from '../../../src/transport/redialable-transport'
import {
  classifyChannelFailure,
  closeOfDialRejection
} from '../../../src/transport/channel-failure'
import type { HerdrRemoteConnection } from '../../../src/transport/herdr-connection'
import type { RemoteDefinition } from '../../../src/api/herdr-api-types'
import { startSshDialLoop, type SshDialLoopOptions } from './dial-loop'
import { loadNativeHerdrSsh } from './native-module'
import { createPushTokenRegistrar, type PushTokenRegistrar } from './push-token-registrar'
import type { HerdrSshRemoteConfig } from './remote-config'
import { loadRemoteInventory, type RemoteSource } from './remote-source'
import { purgeIfFreshInstall, storedRemotesRevision, subscribeStoredRemotes } from './remote-store'
import { NativeSshHerdrTransport } from './ssh-transport'

const NO_CONNECTIONS: readonly HerdrRemoteConnection[] = Object.freeze([])
const NO_REGISTRARS: readonly PushTokenRegistrar[] = Object.freeze([])
const NO_REMOTES: readonly RemoteDefinition[] = Object.freeze([])

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
  /**
   * Every configured remote as a `RemoteDefinition`, dialled or not. The registry, not the outcome.
   *
   * Without it a host that never answered had **no row at all**:
   * `src/api/live/live-snapshot-loader.ts` builds its fleet from the live connections plus the
   * `remote.list` of the box it reached, and a remote that failed to dial is in neither — so the
   * node list showed `1 nodes` and said nothing about the second one. `src/nodes/node-list-model.ts`
   * has drawn that row since stage 4 (`blocked` dot, `reconnecting… · last seen …`, the mockup's
   * `blade-4090` at `assets/mockup.html:409-412`); what was missing was an input for it.
   *
   * *Every* remote rather than only the failed ones on purpose: the reader subtracts what it
   * dialled, so this side never has to be right about which dial failed.
   *
   * Built from the whole inventory even on a retry round, which dials only `only`: a remote whose
   * failure was fatal (a refused key) is deliberately absent from every later round's `only`
   * ({@link DialedRemotes.retryableIds}), and a list narrowed to the round's subset would delete
   * exactly the rows this field exists to keep.
   */
  configured: readonly RemoteDefinition[]
  /**
   * The subset of those hosts worth dialling again, by id. `./dial-loop.ts` is the only reader.
   *
   * The verdict is `src/transport/channel-failure.ts`'s and nothing here re-decides it: a refused
   * public key, a missing remote `herdr` and a wire-layout mismatch all answer the next dial
   * identically, so a ladder that kept trying them would be an ssh authentication attempt every 90
   * seconds for a state only the user can change. Everything else — refused TCP, timeout, a dead
   * radio — is exactly what a ladder is for, and is the default for the same reason that file
   * states: guessing "fatal" on an unknown message reintroduces the parked loop L3 abolishes.
   *
   * Empty when this build has no native ssh module: every remote then fails with the same
   * build-level reason, and no number of dials produces a module the bundle does not contain.
   */
  retryableIds: string[]
  /** True when this build has no `HerdrSsh` native module — the state before the module ships. */
  nativeModuleMissing: boolean
  /** Which channel supplied the list (`./remote-source.ts`) — `'none'` when nothing was configured. */
  source: RemoteSource
  /**
   * M5. One per connected remote: the verb that hands that host this phone's push token
   * (`./push-token-registrar.ts`).
   *
   * Alongside `connections` rather than folded into `HerdrRemoteConnection`, because it is not part
   * of what a *screen* does with a remote — no screen calls it, exactly one root-level effect does
   * — and `./herdr-connection.ts` is explicit that its two faces are the data plane and nothing
   * else. Empty in every build with no reachable remote, which is also every build where there is
   * nothing to tell.
   */
  pushTokenRegistrars: readonly PushTokenRegistrar[]
}

/**
 * The remotes this launch will dial, and where they came from.
 *
 * Two channels now (`./remote-source.ts`): the keystore the settings screen writes, and — in a
 * development build only — `app.json`. The precedence between them is that file's decision; what
 * happens here is the one thing that must happen *before* either is read.
 *
 * `purgeIfFreshInstall` first: on iOS a keychain entry outlives the app that wrote it, so the very
 * first read after a reinstall can hand back the previous install's private keys. Memoised because
 * this function runs again on every re-dial, and the purge is a once-per-process question
 * (`./remote-store.ts` explains the marker).
 */
let freshInstallCheck: Promise<unknown> | null = null

async function readSelectedRemotes(): Promise<{
  remotes: HerdrSshRemoteConfig[]
  source: RemoteSource
}> {
  // Swallowed on purpose: this is a best-effort hygiene step on the launch path, and a keystore
  // that refuses to answer must not leave the app behind a spinner forever
  // (`src/api/herdr-data-provider.tsx`'s `loadWhileDialling` never resolves).
  freshInstallCheck ??= purgeIfFreshInstall().catch(() => 'unavailable')
  await freshInstallCheck
  const inventory = await loadRemoteInventory()
  return { remotes: inventory.remotes, source: inventory.source }
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
): Promise<{
  connection: HerdrRemoteConnection
  transport: RedialableTransport
  registrar: PushTokenRegistrar
}> {
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
  const dialled = createRedialableConnection(remoteDefinition(config), await open(), open)
  // The registrar is given the *redialable* transport, not the connection this dial produced, so a
  // registration that runs after a redial goes down the connection that is current then
  // (`src/transport/redialable-transport.ts`, `runCommand`).
  return { ...dialled, registrar: createPushTokenRegistrar(config, dialled.transport) }
}

/**
 * Dials every configured host, in parallel, and reports the ones that failed.
 *
 * Exported so it can be driven without React — the Node live harness mounts the same app tree with
 * `SshHerdrTransport` instead, and a caller that wants the phone's path without a component has it.
 *
 * `only` restricts the pass to those remote ids, which is what a retry round is (`./dial-loop.ts`):
 * a host that is already connected keeps its ssh connection, its exec channel and its remote
 * `herdr` process (03-blockers.md B8) instead of being torn down and re-opened because a *different*
 * host is down. An id that is no longer in the configuration is simply not dialled — the remote was
 * deleted, and there is nothing left to retry.
 */
export async function openConfiguredSshConnections(
  only?: readonly string[]
): Promise<DialedRemotes> {
  const { remotes: all, source } = await readSelectedRemotes()
  const configured = Object.freeze(all.map(remoteDefinition))
  const configs = only === undefined ? all : all.filter((config) => only.includes(config.id))
  if (configs.length === 0) {
    return {
      connections: NO_CONNECTIONS,
      transports: [],
      failures: [],
      configured,
      retryableIds: [],
      nativeModuleMissing: false,
      source,
      pushTokenRegistrars: NO_REGISTRARS
    }
  }
  const native = await loadNativeHerdrSsh()
  const settled = await Promise.allSettled(configs.map((config) => dialRemote(native, config)))
  const connections: HerdrRemoteConnection[] = []
  const transports: RedialableTransport[] = []
  const registrars: PushTokenRegistrar[] = []
  const failures: string[] = []
  const retryableIds: string[] = []
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      connections.push(result.value.connection)
      transports.push(result.value.transport)
      registrars.push(result.value.registrar)
    } else {
      const id = configs[index]?.id ?? String(index)
      failures.push(`${id}: ${errorMessage(result.reason)}`)
      // `native === null` is checked here rather than folded into the classifier because the reason
      // string `dialRemote` throws for it reads as an ordinary transport error, and the classifier
      // would correctly — and uselessly — call it retryable.
      if (native !== null && !classifyChannelFailure(closeOfDialRejection(result.reason)).fatal) {
        retryableIds.push(id)
      }
    }
  }
  return {
    connections,
    transports,
    failures,
    configured,
    retryableIds,
    nativeModuleMissing: native === null,
    source,
    pushTokenRegistrars: registrars
  }
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
  /** Every configured remote, dialled or not; see {@link DialedRemotes.configured}. */
  configured: readonly RemoteDefinition[]
  /** No `HerdrSsh` in this build (Expo Go, or a bundle predating the module) — not an auth failure. */
  nativeModuleMissing: boolean
  /** False until the dial settles, because "still dialling" is not "nothing was configured". */
  settled: boolean
  /** Where the dialled list came from: the keystore, `app.json`, or nowhere. */
  source: RemoteSource
  /** M5. One per connected remote; see {@link DialedRemotes.pushTokenRegistrars}. */
  pushTokenRegistrars: readonly PushTokenRegistrar[]
  /**
   * A fourth field rather than a fourth meaning for the other three, on purpose.
   *
   * True while `./dial-loop.ts` still has a rung armed for a remote that did not answer. It says
   * nothing about *which* of the states above the app is in — `settled` still means the first dial
   * resolved, `failures` still names every remote that did not answer, `nativeModuleMissing` is
   * still a build fact — because `src/api/herdr-data-provider.tsx` splits "nothing configured" from
   * "nothing answered" on exactly those three, and a remote that is being retried must never be
   * mistaken for one that was never configured: that mistake renders the fixture, which is this
   * app's signature lie.
   *
   * What it is for is the screen's honesty. The QA phone showed `No configured remote could be
   * reached — ECONNREFUSED` unchanged for six minutes with nothing behind it, and the user's only
   * remaining move was the app switcher.
   */
  retrying: boolean
}

/** The state before the first dial resolves. Frozen: it is shared by every mount. */
const DIALLING: SshDialState = Object.freeze({
  connections: NO_CONNECTIONS,
  failures: Object.freeze([]) as readonly string[],
  configured: NO_REMOTES,
  nativeModuleMissing: false,
  settled: false,
  source: 'none',
  pushTokenRegistrars: NO_REGISTRARS,
  retrying: false
})

/** What a receipt injects to drive the retry deterministically. Undefined everywhere else. */
export type SshDialRetryOptions = Pick<
  SshDialLoopOptions,
  'timer' | 'isForeground' | 'subscribeRevival'
>

/**
 * The dial `app/_layout.tsx` starts at mount and hands to the providers below it.
 *
 * `settled: false` until the first pass resolves, and settled-with-everything-failed afterwards —
 * the two states the caller needs to keep apart.
 *
 * ⚠️ It is a **loop**, not a dial, and `./dial-loop.ts` is where the reason lives: the effect below
 * used to run exactly once per keystore revision, so a remote that was unreachable at mount stayed
 * unreachable until the user force-quit the app. Everything this hook still owns is the React half
 * — when the loop starts, when it stops, and how its state reaches the tree.
 */
export function useHerdrSshConnections(retry: SshDialRetryOptions = {}): SshDialState {
  // M2b: a remote added or deleted on the settings screen has to take effect without a restart, and
  // the loop below is a mount-time effect. The keystore's revision counter is the dependency that
  // makes "the user saved a remote" a re-dial (`./remote-store.ts`); it never changes in a build
  // where nothing writes to the store, so every existing mount path is unaffected.
  const revision = useSyncExternalStore(
    subscribeStoredRemotes,
    storedRemotesRevision,
    storedRemotesRevision
  )
  const [dial, setDial] = useState<SshDialState>(DIALLING)
  const { timer, isForeground, subscribeRevival } = retry

  useEffect(() => {
    let live = true
    // Back to "still dialling" on a re-dial: the previous answer described a different config, and
    // reporting it while the new one is in flight is the same lie as the fixture-during-dial one
    // (`src/api/herdr-data-provider.tsx`). Identity-stable, so the first mount does not re-render.
    setDial(DIALLING)
    const loop = startSshDialLoop({
      round: (only) => openConfiguredSshConnections(only),
      // The loop publishes only on an observable change, so this is not a per-rung render — see
      // `SshDialLoopOptions.onState`, and `src/transport/use-supervised-remotes.ts` for what a
      // churned `connections` identity would cost.
      onState: (state) => {
        if (live) {
          setDial(state)
        }
      },
      ...(timer === undefined ? {} : { timer }),
      ...(isForeground === undefined ? {} : { isForeground }),
      ...(subscribeRevival === undefined ? {} : { subscribeRevival })
    })
    return () => {
      live = false
      loop.stop()
    }
  }, [revision, timer, isForeground, subscribeRevival])

  return dial
}
