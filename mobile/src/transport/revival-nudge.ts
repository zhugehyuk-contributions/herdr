// Rewritten for herdr, from orca mobile/src/transport/client-context.tsx:299-313 (the `useEffect` that
// wires `subscribeConnectionRevivalTriggers` to every live client)
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// L4's consumer. The trigger source itself is `./connection-revival-triggers.ts`, ported
// byte-identical because it is pure OS plumbing — `AppState 'active'` plus `expo-network`'s return
// *and* its Wi-Fi↔cellular type change, folded into one callback.
//
// Why this is a separate function rather than the `useEffect` orca has: that effect imports
// `react-native` and `expo-network` transitively, and this repo's default vitest environment is
// `node`. Taking `subscribe` as a parameter keeps the OS module out of the receipt entirely — the
// same injection discipline `./reconnect-policy.ts` uses for its clock — and it is what lets the
// fan-out rule below be proved rather than asserted in a comment. The app-level mount is then two
// lines and carries no logic:
//
//     useEffect(
//       () => bindConnectionRevival(() => supervisors, subscribeConnectionRevivalTriggers),
//       [supervisors]
//     )

export type RevivalReason = 'app-resume' | 'network-change'

/** Anything the nudge can reach. In practice a {@link ConnectionSupervisor}. */
export type Nudgeable = {
  notifyForeground: (reason: RevivalReason) => void
}

/** The shape of `./connection-revival-triggers.ts`'s export, restated so this file need not import it. */
export type RevivalSubscribe = (nudge: (reason: RevivalReason) => void) => () => void

/**
 * Fans one OS revival signal out to every supervised connection, and returns the unsubscribe.
 *
 * `targets` is a *function* rather than an array because the set changes: a remote added or removed
 * between the subscription and the nudge must be included or excluded as of the nudge. Capturing an
 * array here is X4's mistake ("화면이 교체된 client 핸들을 붙잡고 있음") in the trigger layer.
 *
 * Each nudge is isolated. orca's comment says why in one line — "One broken physical session must
 * not block recovery for other hosts" — and that is not hypothetical here: `notifyForeground` on a
 * supervisor whose dial rejects synchronously would otherwise stop the loop before the remaining
 * remotes were told the network came back.
 */
export function bindConnectionRevival(
  targets: () => Iterable<Nudgeable>,
  subscribe: RevivalSubscribe
): () => void {
  return subscribe((reason) => {
    for (const target of targets()) {
      try {
        target.notifyForeground(reason)
      } catch {
        // One broken connection must not block recovery for the others.
      }
    }
  })
}
