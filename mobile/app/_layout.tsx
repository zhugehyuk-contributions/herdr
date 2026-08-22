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
//   · `RpcClientProvider` (`:10`, `:161`) — ported at stage 6 as the pair below: `HerdrClientsProvider`
//     (the connection set, `src/transport/herdr-clients-context.tsx`) wrapping `HerdrDataProvider`
//     (which turns that set into the snapshot loader). orca's ref-counting/reconnect half of the
//     original is M4 — see that file's header for what was left out and why.
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
import { HerdrDataProvider } from '../src/api/herdr-data-provider'
import { HerdrClientsProvider } from '../src/transport/herdr-clients-context'
import type { HerdrRemoteConnection } from '../src/transport/herdr-connection'

// Why empty, and why it is still here: reaching a herdr server means an ssh exec channel onto
// `herdr remote-api-bridge`, and React Native has no ssh stack — the native module that would
// supply one is mobile/.prd/02-architecture.md §2.4 N1 and is not written. Until it is, the app
// dials nobody and `HerdrDataProvider` falls back to the mock fixture. The provider is mounted
// anyway because it is the injection point: the Node harness mounts this same tree with a real
// `SshHerdrTransport`, so the live path below is exercised by `test/live/` rather than by a phone.
const APP_CONNECTIONS: readonly HerdrRemoteConnection[] = []

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
    // Which loader runs is `HerdrDataProvider`'s single decision (live when a remote is reachable,
    // the stage-4 fixture otherwise); nothing below here knows the difference, which is the point of
    // the seam (port map §5, "이 시점 전까지 mock으로 UI가 이미 완성돼 있어야 한다").
    <HerdrClientsProvider connections={APP_CONNECTIONS}>
      <HerdrDataProvider>
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
      </HerdrDataProvider>
    </HerdrClientsProvider>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: mono.ink
  }
})
