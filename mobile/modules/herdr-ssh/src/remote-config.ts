// Not from orca. Where the app learns which hosts exist — the injection point, and deliberately
// only that.
//
// The shape only. *Where* a remote comes from is `./remote-store.ts` (the keystore, which is where
// a user's remotes live as of M2b), `./bundled-remotes.ts` (`app.json`'s `expo.extra.herdrRemotes`,
// now a development-only fallback) and `./remote-source.ts`, which decides between them.
//
// The prediction this file's header used to carry — "the durable home is `expo-secure-store`
// (already a dependency), and `HerdrSshRemoteConfig` is shaped so that swapping the source changes
// this file and nothing above it" — is what M2b cashed in: the schema below is unchanged, and the
// swap added two source modules beside it.
//
// ⚠️ `privateKey` in `app.json` still means a private key in the app bundle and in git. That is why
// `./remote-source.ts` will not read that channel in a release build.
//
// Validation is `zod`, matching `src/api/herdr-api-types.ts`'s treatment of the wire: config that
// arrives from outside the program is parsed, not asserted, and a bad entry is dropped by name
// instead of crashing the app shell at mount.
import { z } from 'zod'
import type { RemoteKeybindings } from '../../../src/api/herdr-api-types'

/**
 * The two sides mockup #7 offers (`.prd/assets/mockup.html:456`), spelled the way the wire spells
 * them — `RemoteKeybindingsSnapshot` is `#[serde(rename_all = "snake_case")]`
 * (`src/remote_registry.rs:56-64`), so `local`/`server` is one vocabulary from this form to
 * `remote.set_keybindings` and back out of `remote.list`.
 *
 * `satisfies` rather than a second spelling: the mirror type is the one checked against the schema
 * artefact (`src/api/herdr-api-types.schema.test.ts`), and a member added on the Rust side that
 * never reached this list would otherwise be a silent divergence between the phone's own registry
 * and the server's.
 */
const KEYBINDINGS = ['local', 'server'] as const satisfies readonly RemoteKeybindings[]

const remoteSchema = z.object({
  /** Matches `RemoteDefinition.id`; this is what `useHerdrConnection(remoteId)` looks up. */
  id: z.string().min(1),
  /** Display name. Defaults to `id`. */
  name: z.string().min(1).optional(),
  host: z.string().min(1),
  port: z.number().int().positive().max(65535).default(22),
  username: z.string().min(1),
  privateKey: z.string().min(1),
  passphrase: z.string().optional(),
  /** Base64 body of the server's OpenSSH `SHA256:` host-key fingerprint. See `ssh-transport.ts`. */
  hostKeySha256: z.string().min(1).optional(),
  allowUnknownHostKey: z.boolean().optional(),
  /** Absolute path to the remote `herdr`. `~` is not expanded — it is shell-quoted. */
  herdrBinary: z.string().min(1).optional(),
  /** `herdr --session <name>`. Omitted when absent or `default`. */
  session: z.string().min(1).optional(),
  /**
   * Which side owns this remote's keybindings — the phone's own registry entry for it, in the same
   * model the multi-remote client keeps (`.prd/assets/mockup.html:426`, "폰 자체 remote registry —
   * multi-remote client와 동일 모델").
   *
   * Optional exactly the way the wire's is: `RemoteDefinitionSnapshot.keybindings` is
   * `#[serde(default)]` over a `#[default] Local` (`src/remote_registry.rs:14-64`), so absent has
   * never been a third state — it *is* `local`. Readers resolve it with `?? 'local'`; nothing
   * downstream sees `undefined` (`./remote-store.ts`, `./app-connections.ts`), and a remote stored
   * before this field existed needs no migration.
   */
  keybindings: z.enum(KEYBINDINGS).optional(),
  env: z.record(z.string(), z.string()).optional(),
  connectTimeoutMs: z.number().int().positive().default(20_000),
  keepaliveIntervalMs: z.number().int().positive().default(15_000)
})

export type HerdrSshRemoteConfig = z.infer<typeof remoteSchema>

/** One rejected entry, kept so a misconfiguration is diagnosable without a debugger. */
export interface RejectedRemoteConfig {
  index: number
  reason: string
}

export interface ParsedRemoteConfigs {
  remotes: HerdrSshRemoteConfig[]
  rejected: RejectedRemoteConfig[]
}

/**
 * Parses `expo.extra.herdrRemotes`.
 *
 * Per entry rather than all-or-nothing: one host with a typo in its port should not take the other
 * three offline, and the app's fallback for "no reachable remote" is the mock fixture — a state in
 * which a whole-array rejection would be indistinguishable from an empty array.
 */
export function parseConfiguredRemotes(value: unknown): ParsedRemoteConfigs {
  if (!Array.isArray(value)) {
    return { remotes: [], rejected: [] }
  }
  const remotes: HerdrSshRemoteConfig[] = []
  const rejected: RejectedRemoteConfig[] = []
  for (const [index, entry] of value.entries()) {
    const parsed = parseRemoteConfig(entry)
    if (parsed.ok) {
      remotes.push(parsed.config)
    } else {
      rejected.push({ index, reason: parsed.reason })
    }
  }
  return { remotes, rejected }
}

export type RemoteConfigParse =
  | { ok: true; config: HerdrSshRemoteConfig }
  | { ok: false; reason: string }

/**
 * One entry, for the callers that hold one at a time: the keystore (one entry per remote) and the
 * settings form (one draft).
 *
 * ⚠️ `reason` is rendered on screen and is built from zod's *paths and messages only* — never from
 * the value. A rejection that quoted what it was given would put the private key on the glass, and
 * from there into any screenshot of the settings screen (`./remote-store.ts` pins that).
 */
export function parseRemoteConfig(value: unknown): RemoteConfigParse {
  const parsed = remoteSchema.safeParse(value)
  return parsed.success
    ? { ok: true, config: parsed.data }
    : { ok: false, reason: parsed.error.issues.map(describeIssue).join('; ') }
}

function describeIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.map(String).join('.')
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message
}
