// Not from orca. The one place that decides *where the screens' data comes from*, so that decision
// is a single readable line rather than an import buried in `app/_layout.tsx`.
//
// Port map §5 puts the mock (stage 4) before the transport (stage 6) precisely so the screens are
// finished before a socket exists, and says the mock stays as the development/test path. This is
// the seam that keeps both alive: a remote the app can actually reach makes the snapshot live, and
// **no remote configured** falls back to the fixture.
//
// ⚠️ "No remote configured" is the whole of the fallback, and used to be more. The decision was
// `connections.length > 0 ? live : mock`, and a build with a configured remote whose key, host or
// auth was broken produced `connections: []` — indistinguishable from an empty config, so the
// screens rendered `./mock/mock-fixture.ts` forever: 4 invented nodes, 40 invented agents named
// claude/codex/build/shell/tail, and nothing on screen saying anything had failed. On a phone whose
// job is "is an agent blocked", plausible fake data is worse than an error (same defect class as
// mobile/.prd/09-review-followups.md §G, one layer down). `dial` is what tells the two apart.
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { HerdrSnapshotProvider, type SnapshotLoader } from './snapshot-context'
import { createLiveSnapshotLoader } from './live/live-snapshot-loader'
import { loadMockSnapshot } from './mock/mock-snapshot-loader'
import { useHerdrConnections } from '../transport/herdr-clients-context'
import type { HerdrRemoteConnection } from '../transport/herdr-connection'

/**
 * What dialling the configured remotes produced, as this file needs it.
 *
 * Structural on purpose rather than an import of `modules/herdr-ssh`'s `SshDialState`: nothing in
 * `src/api/` knows that the transport is ssh (the Node harness dials over `SshHerdrTransport`, the
 * phone over the native module, and a settings screen will dial a third way), and the required
 * fields still make a mismatch a type error at the one call site that supplies it,
 * `app/_layout.tsx`.
 */
export type RemoteDialOutcome = {
  /** False while the dial is still in flight. */
  settled: boolean
  /** `id: reason` per configured remote that could not be reached. Empty when none was configured. */
  failures: readonly string[]
  /** This build has no native ssh module at all — a different cause from a rejected key. */
  nativeModuleMissing: boolean
  /**
   * At least one of those remotes still has a rung armed (`modules/herdr-ssh/src/dial-loop.ts`).
   *
   * Read by the message and by nothing else. It deliberately does **not** enter {@link dataSourceOf}:
   * a remote being retried is a configured remote that has not answered, which is `'failed'` — the
   * same state it was in a millisecond earlier. Letting it reach the source decision is how a retry
   * ends up rendering the fixture, and 4 invented nodes with 40 invented agents is worse than any
   * error this app can print.
   *
   * Optional because the Node harness and the provider suites build this object by hand and have no
   * ladder; absent reads as "nothing is retrying", which for them is true.
   */
  retrying?: boolean
}

/**
 * A loader that never resolves, i.e. `status: 'loading'` for exactly as long as the dial runs.
 *
 * Why not the fixture in the meantime: a dial fails after `connectTimeoutMs`, 20s by default
 * (`modules/herdr-ssh/src/remote-config.ts`), and showing 40 fake agents for those 20s is the
 * defect above with a timer on it — the user reads the fleet as real before it is replaced by an
 * error. A spinner cannot be misread as a fleet. Nothing leaks: `HerdrSnapshotProvider` re-runs its
 * effect when `load` changes identity, and the abandoned promise can never write state (it holds no
 * `setState`, and the provider's load token has moved on — `./snapshot-context.tsx`).
 */
const loadWhileDialling: SnapshotLoader = () => new Promise<never>(() => {})

/**
 * What a screen says while a remote is being retried, appended to the failure.
 *
 * Its absence is what the M4 QA phone was actually stuck on: `No configured remote could be reached
 * — ECONNREFUSED`, unchanged for six minutes, said the app had *finished* — so the user force-quit,
 * which recovered in ten seconds and taught them that force-quitting is the fix. A line that says
 * the app is still trying is the difference between waiting and quitting.
 */
export const RETRYING_SUFFIX = ' Retrying…'

/** The error the screens show when the user asked for real hosts and got none of them. */
function dialFailureMessage(dial: RemoteDialOutcome): string {
  if (dial.nativeModuleMissing) {
    // Reported first and separately because the fix is a different one: this build cannot dial
    // *anything* (Expo Go, or a bundle from before the native module landed —
    // `modules/herdr-ssh/src/native-module.ts`), so every remote also appears in `failures` with
    // the same reason, and calling that an authentication problem would send the user to their keys.
    return 'No ssh module in this build — a configured remote cannot be dialled from Expo Go. Use a dev build.'
  }
  // Every id, not just the first: with three remotes configured, which ones died is the whole
  // content of the message. They are already formatted `${id}: ${message}` upstream.
  //
  // The suffix ends the list with a full stop rather than another `·`, which is the separator
  // *between remotes* — "lab: Connection refused · retrying" reads as a second remote named
  // `retrying`.
  const reached = `No configured remote could be reached — ${dial.failures.join(' · ')}`
  return dial.retrying === true ? `${reached}.${RETRYING_SUFFIX}` : reached
}

/**
 * Which of the four states the app is in. The loader below is chosen from this and nothing else, so
 * the screens' answer to "am I looking at real data" cannot drift from the data they are handed.
 *
 * Partial success stays live deliberately: one remote that answered is a real fleet view of that
 * remote, and dropping it because a second remote is down would trade a true partial answer for no
 * answer (same rule `./live/live-snapshot-loader.ts` applies inside one load).
 */
export type HerdrDataSource = 'live' | 'dialling' | 'failed' | 'demo'

export function dataSourceOf(
  connections: readonly HerdrRemoteConnection[],
  dial: RemoteDialOutcome | undefined
): HerdrDataSource {
  if (connections.length > 0) {
    return 'live'
  }
  if (dial === undefined) {
    // No dialler mounted at all: the Node harness and every provider test supply connections
    // directly, and for them an empty list means what it always meant.
    return 'demo'
  }
  if (!dial.settled) {
    return 'dialling'
  }
  return dial.failures.length > 0 || dial.nativeModuleMissing ? 'failed' : 'demo'
}

function selectLoader(
  connections: readonly HerdrRemoteConnection[],
  dial: RemoteDialOutcome | undefined
): SnapshotLoader {
  switch (dataSourceOf(connections, dial)) {
    case 'live':
      return createLiveSnapshotLoader(connections)
    case 'dialling':
      return loadWhileDialling
    case 'failed':
      // Reusing the provider's existing failure path (`status: 'error'` + message) rather than
      // adding a state of its own; `createLiveSnapshotLoader([])` would raise the same status with
      // a message that names none of the remotes that actually failed.
      return () => Promise.reject(new Error(dialFailureMessage(dial as RemoteDialOutcome)))
    case 'demo':
      return loadMockSnapshot
  }
}

/**
 * ⚠️ M2b changed what `'demo'` *means* without changing when it happens.
 *
 * Before the settings screen existed, "no remote configured" was a statement about a developer's
 * `app.json` and the fixture was the documented answer (port map §5: the screens are finished
 * before a socket exists). Now it is also the state every user is in on first launch — and 4
 * invented nodes with 40 invented agents, rendered with nothing on screen saying so, is the same
 * defect this file's header was written about, one install earlier.
 *
 * The fixture stays (it is the development, demo and test path, and three suites are built on it),
 * so the screens are told instead: `useHerdrDataSource() === 'demo'` is what `app/index.tsx` and
 * `app/nodes.tsx` render their `demo data` marker from. A user who sees it has somewhere to go —
 * the settings screen is one tap away in the same header.
 */
const DataSourceContext = createContext<HerdrDataSource>('demo')

export function useHerdrDataSource(): HerdrDataSource {
  return useContext(DataSourceContext)
}

export function HerdrDataProvider({
  dial,
  children
}: {
  /** Omitted where nothing dials — see `selectLoader`. */
  dial?: RemoteDialOutcome
  children: ReactNode
}) {
  const connections = useHerdrConnections()
  // Identity has to be stable across renders: `HerdrSnapshotProvider` re-runs its effect whenever
  // `load` changes, so a new closure per render is an infinite reload loop. `dial` is state held by
  // `useHerdrSshConnections`, so it too changes identity only when the dial actually moved.
  const load = useMemo(() => selectLoader(connections, dial), [connections, dial])
  const source = dataSourceOf(connections, dial)
  return (
    <DataSourceContext.Provider value={source}>
      <HerdrSnapshotProvider load={load}>{children}</HerdrSnapshotProvider>
    </DataSourceContext.Provider>
  )
}
