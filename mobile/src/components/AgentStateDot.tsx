// Ported from orca mobile/src/components/AgentStateDot.tsx
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Three changes from the orca original, recorded because the port map grades this `copy` ("herdr
// 상태 어휘와 거의 1:1", §2.5):
//
// 1. Vocabulary. orca's `AgentDotState` is `working|blocked|waiting|done|idle|interrupted`, derived
//    in `src/worktree/agent-row-display.ts` from desktop-shared types. herdr's is the API's own
//    `AgentStatus` = `idle|working|blocked|done|unknown`
//    (docs/next/api/herdr-api.schema.json, transcribed in ../api/herdr-api-types.ts). `waiting` and
//    `interrupted` have no herdr producer, and `unknown` has no orca counterpart, so the table is
//    herdr's and only the table.
// 2. Monotone. orca colours the dot emerald/red/yellow; herdr's ramp is grayscale with emphasis by
//    brightness (../theme/monotone.ts, from mobile/.prd/assets/mockup.html:162-166).
// 3. `blocked` is a ring. That is the mockup's top emphasis level, "반전 칩(모노톤 최상위 강조)"
//    (mockup.html:165, :513) — the one state the phone exists to surface.
//
// The animation is orca's, unmodified: a rotating ring for `working`, stopped and reset on any
// other state. (The mockup draws `working` as a *pulse* instead — mockup.html:164. Not changed:
// swapping a rotation for an opacity loop is a design call the owner has not signed off on, and the
// mockup is marked "오너 검증 전" in 01-spec.md:60.)
import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, View } from 'react-native'
import type { AgentStatus } from '../api/herdr-api-types'
import { dotMetrics, mono } from '../theme/monotone'

const DOT_COLORS: Record<Exclude<AgentStatus, 'working' | 'blocked'>, string> = {
  done: mono.fgSoft,
  idle: mono.off,
  unknown: mono.dim2
}

export function AgentStateDot({ state }: { state: AgentStatus }) {
  const spinValue = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (state === 'working') {
      const animation = Animated.loop(
        Animated.timing(spinValue, {
          toValue: 1,
          duration: 1000,
          easing: Easing.linear,
          useNativeDriver: true
        })
      )
      animation.start()
      return () => animation.stop()
    }
    spinValue.setValue(0)
    return undefined
  }, [state, spinValue])

  if (state === 'working') {
    const rotate = spinValue.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
    return (
      <View style={styles.wrapper}>
        <Animated.View style={[styles.spinner, { transform: [{ rotate }] }]} />
      </View>
    )
  }

  if (state === 'blocked') {
    return (
      <View style={styles.wrapper}>
        <View style={styles.ring} />
      </View>
    )
  }

  return (
    <View style={styles.wrapper}>
      <View style={[styles.dot, { backgroundColor: DOT_COLORS[state] }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: { width: 10, height: 10, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: mono.off },
  ring: {
    width: dotMetrics.ringSize,
    height: dotMetrics.ringSize,
    borderRadius: dotMetrics.ringSize / 2,
    borderWidth: dotMetrics.ringWidth,
    borderColor: mono.fg,
    backgroundColor: 'transparent'
  },
  spinner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: mono.fg,
    borderTopColor: 'transparent'
  }
})
