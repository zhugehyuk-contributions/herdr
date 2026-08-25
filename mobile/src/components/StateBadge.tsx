// Not from orca. orca has no inverted chip: its palette is hued, so `blocked` is red and a red word
// is already the loudest thing on the row. herdr's ramp is grayscale and its top emphasis level is
// inversion — ink on foreground — which the mockup spends on exactly one thing
// (`.prd/assets/mockup.html:175` `.bdg.inv`, used at `:538` for a blocked pane and `:490` for a
// blocked agent chip).
//
// Kept a component rather than a style so the rule stays one decision: inversion means blocked. A
// second surface that wants "emphasis" reaches for brightness (`mono.fg` text), not for this.
import { StyleSheet, Text } from 'react-native'
import { typography } from '../theme/herdr-typography'
import { mono } from '../theme/monotone'

export function StateBadge({ label }: { label: string }) {
  return <Text style={styles.badge}>{label}</Text>
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: mono.fg,
    color: mono.ink,
    fontSize: 10,
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: 'hidden',
    fontFamily: typography.monoFamilyBold
  }
})
