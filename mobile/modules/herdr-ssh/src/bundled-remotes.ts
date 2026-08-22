// Not from orca. `app.json`'s `expo.extra.herdrRemotes`, which used to be *the* source of remotes
// and is now the development fallback — split out of `./app-connections.ts` so that the two
// channels are two files and `./remote-source.ts` can hold the precedence rule between them without
// importing a dialler.
//
// ⚠️ This channel is a **build-time** one: `app.json` is committed and ships inside the binary, so a
// `privateKey` here is a private key in git and in the APK. It survives because it is the only way
// to configure a remote before a human can reach the settings screen — a Metro dev build, the Node
// live harness, a QA lab host — and for no other reason. `./remote-source.ts` is what stops it
// being read in a release build.
//
// The `import()` is dynamic for `./native-module.ts`'s reason: `expo-constants` is unloadable in the
// test environment, and `modules/herdr-ssh/test/bundle-contract.test.ts` pins that it stays that way.
import { parseConfiguredRemotes, type ParsedRemoteConfigs } from './remote-config'

const NONE: ParsedRemoteConfigs = { remotes: [], rejected: [] }

/** Returns nothing off a phone, where `expo-constants` will not load. */
export async function readBundledRemotes(): Promise<ParsedRemoteConfigs> {
  try {
    const constants = await import('expo-constants')
    const extra = constants.default.expoConfig?.extra as Record<string, unknown> | undefined
    return parseConfiguredRemotes(extra?.['herdrRemotes'])
  } catch {
    return NONE
  }
}
