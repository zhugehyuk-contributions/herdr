// Not from orca. orca has no bottom navigation at all — its root is a single Stack whose home is
// the host catalog, and every other screen is pushed onto it (`app/_layout.tsx`, ported next door).
// herdr needs one because decision 3 makes the *cross-cutting* view the home
// ("Agents 화면 = 홈", 01-spec.md) while the physical tree (remote ▸ workspace ▸ tab ▸ pane) still
// has to be reachable; a Stack alone cannot express "two peers, either can be first".
// The two entries and their order are the mockup's (mockup.html:419-422, :651-654).
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { spacing } from '../theme/mobile-theme'
import { typography } from '../theme/herdr-typography'
import { mono } from '../theme/monotone'

export type BottomNavTab = 'nodes' | 'agents'

export function BottomNav({
  active,
  onSelect
}: {
  active: BottomNavTab
  onSelect: (tab: BottomNavTab) => void
}) {
  // The bottom half of .prd/09-review-followups.md §D1's defect class. This bar is pinned to the
  // window's bottom edge and had no bottom padding at all, so the home indicator sat on top of the
  // two tab labels — and on Android, where the window is edge-to-edge
  // (`android/gradle.properties:47`), so did the navigation bar. Neither was measured — §D1 is the
  // top edge — but it is the same defect one edge over, and it is live on both platforms.
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom }]}>
      {(['nodes', 'agents'] as const).map((tab) => (
        <Pressable
          key={tab}
          accessibilityRole="button"
          accessibilityState={{ selected: tab === active }}
          accessibilityLabel={`${tab} tab`}
          onPress={() => onSelect(tab)}
          style={styles.item}
        >
          <Text style={[styles.label, tab === active && styles.labelActive]}>{tab}</Text>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: mono.line,
    backgroundColor: mono.ink2
  },
  item: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md
  },
  label: {
    fontSize: 12,
    color: mono.dim,
    fontFamily: typography.monoFamily
  },
  labelActive: {
    color: mono.fg,
    fontWeight: '700'
  }
})
