// Not from orca. This is the remote list — orca's `app/index.tsx` (1,362 lines, `port` in the port
// map §2.2) — moved off the home route, because decision 3 puts the Agents view there instead
// (see `./index.tsx`). The body is the stage-3 scaffolding one grown up: the same provider, the
// same route push, plus the per-remote roll-up the mockup's node list carries
// (mockup.html:399-416, "4 spaces · 11 panes · 3 working").
//
// `MobileHostCard` (183 lines, graded `port`) is deliberately *not* ported yet. Its load-bearing
// part is L7 — `showConnectionRetry` and the "… — tap to retry" affordance that only becomes
// pressable on a `warning`/`unreachable` verdict (`WorktreeListRow`'s sibling,
// `MobileHostCard.tsx:52`, and `05-orca-transport.md` L7). A retry button is `forceReconnect` on a
// transport that does not exist until stage 6; porting the card now would mean porting a card whose
// one interesting behaviour is stubbed. The row below shows reachability from the snapshot only,
// and says nothing it cannot know.
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { StatusDot } from '../src/components/StatusDot'
import { BottomNav } from '../src/components/BottomNav'
import { useHerdrSnapshot, remoteSubtitle } from '../src/api/snapshot-context'
import { useHerdrDataSource } from '../src/api/herdr-data-provider'
import { snapshotStalenessLabel } from '../src/api/snapshot-staleness'
import { rollupText } from '../src/panes/pane-tree'
import { mono } from '../src/theme/monotone'

export default function NodeListScreen() {
  const router = useRouter()
  const { status, snapshot, error, refreshError, updatedAt } = useHerdrSnapshot()
  // Same hint the Agents home carries, for the same reason and off the same poll — see
  // `./index.tsx` for why nothing here needs a timer. This list ages worse than that one, in fact:
  // its rows are roll-ups ("4 spaces · 12 panes · 2 blocked"), and a roll-up nobody can date is
  // indistinguishable from a fleet that simply stopped changing.
  const staleness = snapshotStalenessLabel({ updatedAt, refreshError })
  const source = useHerdrDataSource()
  const byRemote = new Map(snapshot.perRemote.map((entry) => [entry.remote.id, entry]))

  return (
    <View style={styles.screen}>
      <View style={styles.appbar}>
        <Text style={styles.logo}>herdr</Text>
        <Text style={styles.crumb}>/ nodes</Text>
        {/* Unlike `./index.tsx` this header had no right-hand meta slot; the spacer creates one, and
            when refreshes are healthy it stays empty — the screen is unchanged. */}
        <View style={styles.spacer} />
        {staleness ? <Text style={styles.stale}>{staleness}</Text> : null}
        {/* M2b: the fixture is still what an unconfigured app renders (`../src/api/herdr-data-provider.tsx`),
            but a first-run user cannot tell 40 invented agents from a fleet. Saying so is the whole
            fix; the settings affordance beside it is where they go next. */}
        {source === 'demo' ? <Text style={styles.stale}>demo data</Text> : null}
        {/* Same affordance as `./index.tsx`, for the same reason: either list can be where the user
            is standing when they need to add or fix a remote. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="settings"
          onPress={() => router.push('/settings')}
          style={styles.settings}
        >
          <Text style={styles.settingsLabel}>settings</Text>
        </Pressable>
      </View>
      {status === 'loading' ? <Text style={styles.meta}>Loading…</Text> : null}
      {/* The whole screen when a load fails — nothing else renders, since `snapshot` is empty on
          `error` (`../src/api/snapshot-context.tsx`). So it is the top of the ramp and not `meta`'s
          `dim`: on a screen with one line of text, that line is the emphasis. The message is the
          loader's own — for a failed dial it names the remotes that could not be reached
          (`../src/api/herdr-data-provider.tsx`), which is what makes an error more use than the
          fixture it replaced. */}
      {status === 'error' ? <Text style={styles.error}>{error ?? 'Load failed'}</Text> : null}
      <ScrollView style={styles.body}>
        {snapshot.remotes.map((remote) => {
          const entry = byRemote.get(remote.id)
          // A disabled remote is never dialled, so it has no snapshot — and saying "0 panes" about
          // a box we did not ask would be a lie the user cannot tell from a real zero.
          const detail = remote.disabled
            ? 'disabled'
            : entry
              ? `${remoteSubtitle(remote)} · ${entry.workspaces.length} spaces · ${entry.panes.length} panes · ${rollupText(entry.panes)}`
              : remoteSubtitle(remote)
          return (
            <Pressable
              key={remote.id}
              accessibilityRole="button"
              accessibilityLabel={`${remote.name} — ${detail}`}
              onPress={() => router.push(`/h/${remote.id}`)}
              style={styles.row}
            >
              <View style={styles.rowHead}>
                <StatusDot state={remote.disabled ? 'disconnected' : 'connected'} />
                <Text style={styles.name}>{remote.name}</Text>
                <View style={styles.spacer} />
                <Text style={styles.chevron}>›</Text>
              </View>
              <Text style={styles.meta}>{detail}</Text>
            </Pressable>
          )
        })}
      </ScrollView>
      <BottomNav
        active="nodes"
        onSelect={(tab) => (tab === 'agents' ? router.push('/') : undefined)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: mono.ink },
  appbar: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 16, paddingTop: 24 },
  logo: { color: mono.fg, fontSize: 20, fontWeight: '700' },
  crumb: { color: mono.dim, fontSize: 13, marginLeft: 6 },
  body: { flex: 1, paddingHorizontal: 16 },
  row: { paddingVertical: 12 },
  rowHead: { flexDirection: 'row', alignItems: 'center' },
  name: { color: mono.fg, fontSize: 15 },
  meta: { color: mono.dim, fontSize: 12 },
  // Padded, unlike `meta`: that one is a row subtitle inside the already-inset body, so an error
  // borrowing it rendered flush against the screen edge, out of line with everything else.
  error: { color: mono.fg, fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingTop: 8 },
  // Brighter than `meta` on purpose, and grayscale — see the same style in `./index.tsx`.
  stale: { color: mono.fgSoft, fontSize: 12 },
  chevron: { color: mono.dim2, fontSize: 13 },
  settings: { paddingLeft: 10 },
  settingsLabel: { color: mono.dim, fontSize: 12 },
  spacer: { flex: 1 }
})
