// Not from orca. orca pairs a phone to a desktop over a relay with an E2EE handshake; herdr has no
// relay and no pairing protocol — the QR carries an ordinary ssh remote and the phone then dials it
// exactly as `--remote` does (`.prd/12-qr-pairing.md`, and the mockup's own note at
// `assets/mockup.html:325`, "인증은 ssh 그대로 … 신규 페어링 프로토콜 없음").
//
// This screen is goal condition 5 (2026-08-24, "qr 코드 로그인 기능 꼭 추가 … ssh 접속 키 때문에")
// and mockup screen ① — the one screen the audit found missing entirely (`.prd/11` 누락 #1), along
// with its `수동으로 추가` escape hatch (누락 #2).
//
// What it deliberately does not do: decide. It parses, it shows what it found, and it hands the
// result to the settings form. A code that carries a key produces a remote that can be saved as-is;
// a code that does not produces the same form with one field left to fill. Neither path saves
// anything without the user pressing save — a screen that wrote a credential to the keystore
// because a camera saw a shape would be the wrong shape of automatic.
import { useCallback, useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CameraView, useCameraPermissions } from 'expo-camera'
import {
  parsePairingCode,
  pairingCodeStaleness,
  type PairingPayload
} from '../src/pairing/pairing-payload'
import { pendingPairing } from '../src/pairing/pairing-handoff'
import { safeChromePadding } from '../src/layout/safe-area-chrome'
import { typography } from '../src/theme/mobile-theme'
import { mono } from '../src/theme/monotone'

const APPBAR_TOP_PADDING = 24

export default function PairScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  // A rejected scan has to stay on screen until the user does something about it; without this the
  // camera would re-read the same code sixty times a second and the message would flicker.
  const [rejected, setRejected] = useState<string | null>(null)
  const [scanned, setScanned] = useState(false)
  // A code that parsed is *shown*, not acted on. The user sees which box they are about to add
  // before anything reaches the keystore, and a stale code — one that may be a photograph of
  // someone else's screen — gets to say so while there is still a decision to make.
  const [found, setFound] = useState<PairingPayload | null>(null)

  const onScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanned) {
        return
      }
      const parsed = parsePairingCode(data)
      if (!parsed.ok) {
        setScanned(true)
        setRejected(parsed.reason)
        return
      }
      setScanned(true)
      setFound(parsed.payload)
    },
    [scanned]
  )

  const accept = useCallback(() => {
    if (found === null) {
      return
    }
    // The payload crosses to settings in memory, never through the URL: a route param ends up in
    // navigation state, in a deep-link history and in any log that prints a route, and this one can
    // carry a private key (`../src/pairing/pairing-handoff.ts`).
    pendingPairing.set(found)
    router.replace('/settings')
  }, [found, router])

  const staleness = found === null ? null : pairingCodeStaleness(found, Date.now())

  return (
    <View style={styles.screen}>
      <View
        style={[styles.appbar, { paddingTop: safeChromePadding(insets.top, APPBAR_TOP_PADDING) }]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="back to nodes"
          onPress={() => router.replace('/nodes')}
        >
          <Text style={styles.back}>‹ nodes</Text>
        </Pressable>
        <Text style={styles.crumb}>/ scan</Text>
      </View>

      <View style={styles.body}>
        <View style={styles.frame}>
          {permission?.granted === true && !scanned ? (
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onScanned}
            />
          ) : (
            // The frame is drawn even with no camera behind it, because it is what tells the user
            // where to point the phone once there is one (`assets/mockup.html:287`, a dashed square
            // with the code inside it).
            <View style={styles.cameraOff} />
          )}
        </View>

        {permission?.granted === true ? null : permission?.canAskAgain === false ? (
          // The 6차 device round pressed the old button in this state and measured what it did:
          // no dialog, no navigation, nothing. Once the OS has latched the refusal `requestPermission`
          // cannot ask again, so the button was the silent no-op `.prd/12` Q2 explicitly ruled out.
          // The one control that still works here is the one that opens the place the refusal can be
          // undone.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="open system settings"
            onPress={() => void Linking.openSettings()}
            style={styles.primary}
          >
            <Text style={styles.primaryLabel}>open system settings</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="allow camera"
            onPress={() => void requestPermission()}
            style={styles.primary}
          >
            <Text style={styles.primaryLabel}>allow camera</Text>
          </Pressable>
        )}

        {permission?.canAskAgain === false ? (
          // Asking again does nothing once the OS has latched the refusal, and a button that
          // silently no-ops is worse than a sentence naming the one place that can undo it.
          <Text style={styles.hint}>
            Camera access is off for herdr. Turn it on in the system settings, or add the remote by
            hand.
          </Text>
        ) : (
          <Text style={styles.hint}>
            {'On the desktop, run '}
            <Text style={styles.hintCode}>herdr pair</Text>. Scanning fills in the remote — key
            included.
          </Text>
        )}

        {rejected === null ? null : (
          <>
            <Text style={styles.rejected}>{rejected}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="scan again"
              onPress={() => {
                setRejected(null)
                setScanned(false)
              }}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>scan again</Text>
            </Pressable>
          </>
        )}

        {found === null ? null : (
          <>
            {/* What was found, before anything is stored. `key` is never rendered — not even its
                length: this screen is the one most likely to be photographed or screen-shared. */}
            <Text style={styles.found}>
              {`${found.name ?? found.host} — ${found.user}@${found.host}:${found.port}`}
            </Text>
            <Text style={styles.hint}>
              {found.key === undefined
                ? 'No key in this code — the form will need one.'
                : 'Key included. Save on the next screen to finish.'}
            </Text>
            {staleness === null ? null : (
              <Text
                style={styles.rejected}
              >{`${staleness} If that is not the screen in front of you, scan again.`}</Text>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="use this code"
              onPress={accept}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>use this code</Text>
            </Pressable>
          </>
        )}

        {/* .prd/11 누락 #2 — the mockup's `수동으로 추가` (`assets/mockup.html:326`). It is the only
            way through this screen when there is no camera, no permission, or no desktop herdr new
            enough to emit a code. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="add by hand"
          onPress={() => router.replace('/settings')}
        >
          <Text style={styles.manual}>add by hand</Text>
        </Pressable>
      </View>
    </View>
  )
}

const FRAME = 190

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: mono.ink },
  appbar: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 16 },
  back: { color: mono.fgSoft, fontSize: 13, fontFamily: typography.monoFamily },
  crumb: { color: mono.dim, fontSize: 13, marginLeft: 6, fontFamily: typography.monoFamily },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 24 },
  // `assets/mockup.html:287-292`: a dashed square, faintly filled, with the code inside it.
  frame: {
    width: FRAME,
    height: FRAME,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: mono.line,
    backgroundColor: mono.ink2,
    overflow: 'hidden'
  },
  camera: { flex: 1 },
  cameraOff: { flex: 1 },
  hint: {
    color: mono.dim,
    fontSize: 11,
    lineHeight: 19,
    textAlign: 'center',
    fontFamily: typography.monoFamily
  },
  hintCode: { color: mono.fg, fontFamily: typography.monoFamily },
  rejected: {
    color: mono.fg,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    fontFamily: typography.monoFamily
  },
  // Inverted, like the node list's FAB: on this screen it is the one thing to press.
  primary: {
    backgroundColor: mono.fg,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 10
  },
  primaryLabel: {
    color: mono.ink,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: typography.monoFamily
  },
  secondary: {
    borderWidth: 1,
    borderColor: mono.line,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10
  },
  secondaryLabel: { color: mono.fg, fontSize: 12, fontFamily: typography.monoFamily },
  found: {
    color: mono.fg,
    fontSize: 13,
    textAlign: 'center',
    fontFamily: typography.monoFamily
  },
  manual: {
    color: mono.fgSoft,
    fontSize: 11,
    textDecorationLine: 'underline',
    fontFamily: typography.monoFamily
  }
})
