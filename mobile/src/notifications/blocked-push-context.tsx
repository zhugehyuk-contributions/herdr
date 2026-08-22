// Not from orca. Two jobs in one small provider, and the second one is the interesting one.
//
// The obvious job: mount `useBlockedPush` once, at the root, where the OS subscription belongs.
//
// The other: **make the state visible.** M5's acceptance is "5회 연속" — five blocked events in a
// row that reach the phone. Every way that can fail (permission denied, no `projectId`, `herdr` not
// on a remote's `PATH`, the ssh registration refused) fails *silently and identically*: no
// notification arrives. That is indistinguishable from "no agent was blocked", which is also the
// normal state, so without a place that says which one it is, the milestone is untestable by the
// person it is for. `app/settings.tsx` renders that place; this context is how it gets the answer
// without a second subscription and a second permission prompt.
import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { useRouter } from 'expo-router'
import { useBlockedPush, type BlockedPushStatus } from './use-blocked-push'
import type { PushTokenRegistrar } from '../../modules/herdr-ssh/src/push-token-registrar'

const UNMOUNTED: BlockedPushStatus = Object.freeze({
  state: 'starting',
  token: null,
  registered: Object.freeze([]) as readonly string[],
  failures: Object.freeze([]) as readonly string[],
  error: null,
  available: true
})

const BlockedPushContext = createContext<BlockedPushStatus>(UNMOUNTED)

export function BlockedPushProvider({
  registrars,
  ready,
  children
}: {
  registrars: readonly PushTokenRegistrar[]
  /** True once a navigator exists; a cold-start tap is held until then. */
  ready: boolean
  children: ReactNode
}) {
  const router = useRouter()
  // `push`, not `replace`: the notification arrived while the user was somewhere else — usually
  // nowhere, because the app was closed — and Back should return them there rather than strand them
  // on a pane with no history behind it.
  const navigate = useCallback((href: string) => router.push(href), [router])
  const status = useBlockedPush({ registrars, navigate, ready })
  return <BlockedPushContext.Provider value={status}>{children}</BlockedPushContext.Provider>
}

/** `starting` in any tree with no provider, which is every test that does not mount the shell. */
export function useBlockedPushStatus(): BlockedPushStatus {
  return useContext(BlockedPushContext)
}
