// Ported from orca mobile/app/_layout.tsx
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Kept from orca, and the reason this file is graded `copy` (port map §2.2): the provider-wraps-
// Stack shape, the splash-hide-on-navigator-layout timing (`:152-158`), the shared `screenOptions`
// block, and above all the *absence* of an `orientation` screen option — see the comment below,
// which orca paid for and which only holds together with `plugins/android-respect-rotation-lock.js`
// (already ported).
//
// Dropped, each because the port map drops the feature, not because it was hard:
//   · `orca://pair` deep-link routing (`:47-71`) + `recoverMobileRelayPairing` (`:41-45`) — pairing
//     and the relay are `drop` (§2.2, §2.3); ssh is herdr's authentication (01-spec.md).
//   · notification tap routing (`:73-150`) — `src/notifications/*` is `port(M5)` (§2.5) and pulling
//     it in now would drag `host-store` and the whole notification family with it. The Stack it
//     routes into is here; the routing lands with M5.
//   · `OrcaLogo` (`:9`, `:182`) — brand, not code (§0).
//   · `RpcClientProvider` (`:10`, `:161`) — stage 6. Replaced by the snapshot provider below, which
//     is the smallest thing that lets stage 3 mount before a transport exists.
// Screens: only the three routes that exist. orca lists fourteen; the rest are ported in later
// stages or dropped, and expo-router warns about a `Stack.Screen` with no file. `nodes` is the one
// route with no orca counterpart at this position — orca's host catalog *is* its `index`, and
// herdr's home is the Agents view instead (01-spec.md decision 3), so the catalog needs a name.
import { useCallback } from 'react'
import { View, StyleSheet } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import { mono } from '../src/theme/monotone'
import { HerdrSnapshotProvider } from '../src/api/snapshot-context'
import { loadMockSnapshot } from '../src/api/mock/mock-snapshot-loader'

// Why: keeps the native splash screen visible until the React tree is mounted
// and ready to render. Without this the user sees a blank white/black frame
// between the native splash and the first React paint.
SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  // Why: hide the native splash only once the navigation Stack has been laid
  // out — this is the earliest moment the user will see actual app content.
  const onNavigatorLayout = useCallback(async () => {
    await SplashScreen.hideAsync()
  }, [])

  return (
    // The loader is the stage-4 mock. Stage 6 swaps it for the ssh-backed one; nothing below here
    // knows the difference, which is the point of the seam (port map §5, "이 시점 전까지 mock으로
    // UI가 이미 완성돼 있어야 한다").
    <HerdrSnapshotProvider load={loadMockSnapshot}>
      <View style={styles.root} onLayout={onNavigatorLayout}>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: mono.ink2 },
            headerTintColor: mono.fg,
            headerTitleStyle: { fontSize: 16, fontWeight: '600' },
            contentStyle: { backgroundColor: mono.ink },
            headerShadowVisible: false
            // Why: deliberately no `orientation` screenOption. react-native-screens
            // has no value that respects the device rotation lock — even 'default'
            // calls setRequestedOrientation(UNSPECIFIED) at runtime, overriding the
            // manifest. Leaving it unset lets the manifest's "fullUser" (set by the
            // android-respect-rotation-lock config plugin) honor the auto-rotate lock.
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="nodes" options={{ headerShown: false }} />
          <Stack.Screen name="h" options={{ headerShown: false }} />
        </Stack>
      </View>
    </HerdrSnapshotProvider>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: mono.ink
  }
})
