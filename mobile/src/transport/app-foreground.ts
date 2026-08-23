// Not from orca. The two OS facts `./foreground-redial-ladder.ts` takes by injection, bound to the
// phone — kept in a file of their own for one reason: **everything else that needs them must be
// able to load without `react-native`.**
//
// `./connection-revival-triggers.ts` imports `AppState` and `expo-network`, and this repo's default
// vitest environment is `node`; `modules/herdr-ssh/test/bundle-contract.test.ts` additionally walks
// the ssh module's *static* graph and fails on any bare specifier outside
// `@herdr/client-ts`/`react`/`zod`. So `modules/herdr-ssh/src/dial-loop.ts` reaches this file
// through a dynamic `import()`, exactly as `./herdr-clients-context.tsx` reaches the trigger module
// and `modules/herdr-ssh/src/native-module.ts` reaches `expo-modules-core`.
//
// Why the nudge is `subscribeConnectionRevivalTriggers` rather than a second `AppState` listener:
// that module is the one place this app decides what "the link probably just came back" means, and
// it already folds in the signal an `AppState` listener cannot see — `expo-network`'s Wi-Fi↔cellular
// handoff, where the app never left the foreground and the socket died anyway.
import { AppState } from 'react-native'
import { subscribeConnectionRevivalTriggers } from './connection-revival-triggers'

/** The foreground gate. `AppState.currentState` is null very early on Android; that is not "off". */
export function isAppForeground(): boolean {
  return AppState.currentState !== 'background' && AppState.currentState !== 'inactive'
}

/**
 * Every "the link probably just came back" signal, as one callback.
 *
 * The reason is dropped rather than forwarded: a ladder that has no connection at all treats
 * `app-resume` and `network-change` identically — both mean *dial now instead of waiting out the
 * rung*. `ConnectionSupervisor.notifyForeground` is the caller that needs to tell them apart,
 * because only it has a live link to probe.
 */
export function subscribeAppRevival(nudge: () => void): () => void {
  return subscribeConnectionRevivalTriggers(() => nudge())
}
