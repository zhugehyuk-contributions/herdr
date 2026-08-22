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
//     (which turns that set into the snapshot loader). orca's **reconnect** half of the original
//     landed at M4 and is the `supervisors` prop below; its ref-counting half is still deferred —
//     see that file's header for why.
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
import { useSupervisedRemotes } from '../src/transport/use-supervised-remotes'
import { useHerdrSshConnections } from '../modules/herdr-ssh'
import { useForegroundRefresh } from '../src/api/use-foreground-refresh'

// Why: keeps the native splash screen visible until the React tree is mounted
// and ready to render. Without this the user sees a blank white/black frame
// between the native splash and the first React paint.
SplashScreen.preventAutoHideAsync()

// Why a component rather than a hook call in `RootLayout`: the poller reads the snapshot context,
// and `RootLayout` is what *installs* it — a hook called there would see the default context and
// poll nothing forever. Rendering null keeps it out of the layout entirely
// (`src/api/use-foreground-refresh.ts` explains what it is for).
function ForegroundSnapshotPolling() {
  useForegroundRefresh()
  return null
}

export default function RootLayout() {
  // Was `const APP_CONNECTIONS = []`, with a comment saying it was empty because React Native has no
  // ssh stack (mobile/.prd/02-architecture.md §2.4 N1). `modules/herdr-ssh` is that stack, and this
  // hook is the whole junction: it reads `app.json`'s `expo.extra.herdrRemotes`, dials each one over
  // the native module, and wraps the results as `HerdrRemoteConnection`s.
  //
  // Still empty in every build that has no configured remote, so the fallback to the mock fixture is
  // unchanged rather than removed. No settings UI exists yet; the list is a build-time value on
  // purpose (see `modules/herdr-ssh/src/remote-config.ts`).
  //
  // The *whole* dial goes down, not just its connections: "no remote configured" and "every
  // configured remote failed" both produce an empty list, and only `dial.failures` /
  // `dial.nativeModuleMissing` / `dial.settled` can tell `HerdrDataProvider` which one it is looking
  // at — without them a broken key renders the fixture and says nothing.
  const dial = useHerdrSshConnections()
  const connections = dial.connections

  // M4. One supervisor per connection: the L1 watchdog, the L3 forever-backoff, the L6 ladder and
  // the L7 revive, mounted where every screen can reach them by remote id. Empty in — and only in —
  // the same builds `connections` is empty in, so a build with no configured remote opens no extra
  // channel and this line costs nothing (`src/transport/use-supervised-remotes.ts`).
  const supervisors = useSupervisedRemotes(connections)

  // Why: hide the native splash only once the navigation Stack has been laid
  // out — this is the earliest moment the user will see actual app content.
  const onNavigatorLayout = useCallback(async () => {
    await SplashScreen.hideAsync()
  }, [])

  return (
    // Which loader runs is `HerdrDataProvider`'s single decision (live when a remote is reachable,
    // an error when configured remotes all failed, the stage-4 fixture only when none was
    // configured); nothing below here knows the difference, which is the point of the seam (port map
    // §5, "이 시점 전까지 mock으로 UI가 이미 완성돼 있어야 한다").
    <HerdrClientsProvider connections={connections} supervisors={supervisors}>
      <HerdrDataProvider dial={dial}>
        <ForegroundSnapshotPolling />
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
