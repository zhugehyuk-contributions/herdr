// Not from orca. orca has no bottom navigation at all — its root is a single Stack whose home is
// the host catalog, and every other screen is pushed onto it (`app/_layout.tsx`, ported next door).
// herdr needs one because decision 3 makes the *cross-cutting* view the home
// ("Agents 화면 = 홈", 01-spec.md) while the physical tree (remote ▸ workspace ▸ tab ▸ pane) still
// has to be reachable; a Stack alone cannot express "two peers, either can be first".
// The two entries and their order are the mockup's (mockup.html:419-422, :651-654).
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { spacing } from '../theme/mobile-theme'
import { mono } from '../theme/monotone'

export type BottomNavTab = 'nodes' | 'agents'

export function BottomNav({
  active,
  onSelect
}: {
  active: BottomNavTab
  onSelect: (tab: BottomNavTab) => void
}) {
  return (
    <View style={styles.bar}>
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
    color: mono.dim
  },
  labelActive: {
    color: mono.fg,
    fontWeight: '700'
  }
})
