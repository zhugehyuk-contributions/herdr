// Not from orca. The one place that decides *where the screens' data comes from*, so that decision
// is a single readable line rather than an import buried in `app/_layout.tsx`.
//
// Port map §5 puts the mock (stage 4) before the transport (stage 6) precisely so the screens are
// finished before a socket exists, and says the mock stays as the development/test path. This is
// the seam that keeps both alive: a remote the app can actually reach makes the snapshot live, and
// no reachable remote falls back to the fixture.
//
// ⚠️ On a device today the fallback is what runs, and that is not a bug hiding here: herdr's
// transport is ssh, React Native has no ssh stack, and the native module is unwritten
// (mobile/.prd/02-architecture.md §2.4 N1 — "최대 신규 작업"). `app/_layout.tsx` therefore mounts
// `HerdrClientsProvider` with an empty list. The Node test harness mounts the same provider with a
// real `SshHerdrTransport`, which is what makes the live path a tested path rather than an
// aspiration.
import { useMemo, type ReactNode } from 'react'
import { HerdrSnapshotProvider } from './snapshot-context'
import { createLiveSnapshotLoader } from './live/live-snapshot-loader'
import { loadMockSnapshot } from './mock/mock-snapshot-loader'
import { useHerdrConnections } from '../transport/herdr-clients-context'

export function HerdrDataProvider({ children }: { children: ReactNode }) {
  const connections = useHerdrConnections()
  // Identity has to be stable across renders: `HerdrSnapshotProvider` re-runs its effect whenever
  // `load` changes, so a new closure per render is an infinite reload loop.
  const load = useMemo(
    () => (connections.length > 0 ? createLiveSnapshotLoader(connections) : loadMockSnapshot),
    [connections]
  )
  return <HerdrSnapshotProvider load={load}>{children}</HerdrSnapshotProvider>
}
