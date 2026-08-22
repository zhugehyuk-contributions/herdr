// Not from orca. Where the app learns which hosts exist — the injection point, and deliberately
// only that.
//
// There is no settings UI in this milestone, so the source is `app.json`'s `expo.extra.herdrRemotes`
// (read through `expo-constants` by `app-connections.ts`). That is a **build-time** channel and it
// is the right one for exactly one reason: it is the only configuration a developer can supply
// before the settings screen exists, and it makes "the phone shows mock data" a fact about an empty
// array rather than about a missing feature.
//
// ⚠️ `privateKey` in `app.json` means a private key in the app bundle and in git. That is fine for a
// throwaway key against a lab host and wrong for anything else; the durable home is
// `expo-secure-store` (already a dependency), and `HerdrSshRemoteConfig` is shaped so that swapping
// the source changes this file and nothing above it.
//
// Validation is `zod`, matching `src/api/herdr-api-types.ts`'s treatment of the wire: config that
// arrives from outside the program is parsed, not asserted, and a bad entry is dropped by name
// instead of crashing the app shell at mount.
import { z } from 'zod'

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
    const parsed = remoteSchema.safeParse(entry)
    if (parsed.success) {
      remotes.push(parsed.data)
    } else {
      rejected.push({ index, reason: parsed.error.issues.map(describeIssue).join('; ') })
    }
  }
  return { remotes, rejected }
}

function describeIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.map(String).join('.')
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message
}
