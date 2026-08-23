// Not from orca. orca's pairing is a relay handshake over WebSocket with an E2EE key exchange
// (`tweetnacl`, dropped in `package.json`'s `//deps` note); herdr's is one QR code and no new
// protocol at all — the phone ends up holding an ordinary ssh key and dials the same way the
// desktop `--remote` does (`.prd/assets/mockup.html:325`).
//
// What a code carries is `.prd/12-qr-pairing.md`, decided by the owner on 2026-08-24 (option B′):
// the desktop mints a *dedicated* ed25519 for the phone, so `key` is present and is a credential —
// but one whose blast radius is a single revocable entry in `authorized_keys` rather than the
// user's own key. `key` stays **optional** in the schema on purpose: a code without one is the
// mockup's prefill-only form, still valid, and the screen simply lands on a form with the key field
// empty instead of a working remote.
//
// ⚠️ Failure `reason`s are built from zod's *paths and messages only*, never from the value — the
// same rule `modules/herdr-ssh/src/remote-config.ts` states, and here it is sharper: the value may
// be a private key, and a reason that quoted it would put it on the glass and into any screenshot.
import { z } from 'zod'
import type { HerdrSshRemoteConfig } from '../../modules/herdr-ssh/src/remote-config'

/**
 * Payload version.
 *
 * Present so a desktop that learns to emit more than this can be told apart from one that emits
 * less: an unknown version is refused with a message that names the app as the thing to update,
 * which is the only honest reading when a code from the future arrives.
 */
export const PAIRING_PAYLOAD_VERSION = 1

const payloadSchema = z.object({
  v: z.number().int(),
  /** Display name. Defaults to the host, so a code that omits it still produces a nameable remote. */
  name: z.string().min(1).optional(),
  host: z.string().min(1),
  port: z.number().int().positive().max(65535).default(22),
  user: z.string().min(1),
  /** `herdr --session <name>`. Omitted when the desktop is on the default session. */
  session: z.string().min(1).optional(),
  /** OpenSSH private key body. Optional — see this file's header. */
  key: z.string().min(1).optional(),
  /** Epoch ms the desktop minted this code. Optional; absent means "cannot tell how old". */
  issuedAt: z.number().int().positive().optional()
})

export type PairingPayload = z.infer<typeof payloadSchema>

export type PairingParse = { ok: true; payload: PairingPayload } | { ok: false; reason: string }

/**
 * Parses the text a scanned code carried.
 *
 * Never throws: every way a camera can hand back something unusable — a URL, a wifi code, a
 * truncated frame, a code from a newer herdr — is an ordinary answer for this screen, and a screen
 * that crashes on a bad scan is worse than one that says what it saw.
 */
export function parsePairingCode(text: string): PairingParse {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Deliberately not "invalid JSON": the common case is a code that is not a herdr code at all,
    // and telling the user to check the JSON of a wifi QR is worse than useless.
    return { ok: false, reason: 'This is not a herdr pairing code.' }
  }
  const parsed = payloadSchema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => {
        const path = issue.path.map(String).join('.')
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message
      })
      .join('; ')
    return { ok: false, reason: `This pairing code is missing something — ${detail}` }
  }
  if (parsed.data.v !== PAIRING_PAYLOAD_VERSION) {
    return {
      ok: false,
      reason:
        parsed.data.v > PAIRING_PAYLOAD_VERSION
          ? 'This code was made by a newer herdr. Update the app.'
          : 'This code was made by an older herdr. Update herdr on the desktop.'
    }
  }
  return { ok: true, payload: parsed.data }
}

/**
 * Past this a code is old enough to say so.
 *
 * Not an expiry — this app cannot enforce one, and refusing a code the desktop still honours would
 * be inventing a rule the other side does not have. It is a warning, and the number is the length
 * of time a QR is plausibly still on the screen it was generated on.
 */
export const PAIRING_CODE_STALE_AFTER_MS = 10 * 60_000

/** A warning when the code is old enough to be a photograph of one, or `null`. */
export function pairingCodeStaleness(
  payload: Pick<PairingPayload, 'issuedAt'>,
  nowMs: number
): string | null {
  if (payload.issuedAt === undefined) {
    return null
  }
  const ageMs = nowMs - payload.issuedAt
  if (ageMs < PAIRING_CODE_STALE_AFTER_MS) {
    return null
  }
  const minutes = Math.floor(ageMs / 60_000)
  return minutes < 60
    ? `This code was made ${minutes}m ago.`
    : `This code was made ${Math.floor(minutes / 60)}h ago.`
}

/**
 * The keystore id for a scanned remote.
 *
 * `z@10.0.2.2:2222` reads better and is **not storable**: `modules/herdr-ssh/src/remote-store.ts`
 * concatenates the id into a keystore key and bounds it to `[A-Za-z0-9._-]{1,64}`, so an `@` or a
 * `:` makes `saveStoredRemote` throw — a scan that parsed perfectly and then failed on write. The
 * id is an internal handle; `name` is what a person reads.
 */
export function pairingRemoteId(payload: Pick<PairingPayload, 'user' | 'host' | 'port'>): string {
  const raw = `${payload.user}-${payload.host}-${payload.port}`
  return raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64)
}

/**
 * The remote a scanned code describes, in the shape the rest of the app already stores.
 *
 * `privateKey` is empty when the code carried none: the caller lands the user on the form with
 * everything else filled in, which is the mockup's own flow (`assets/mockup.html:324`, "스캔하면
 * add remote가 미리 채워진다") and is what makes a keyless code useful rather than an error.
 */
export function remoteConfigFromPairing(payload: PairingPayload): HerdrSshRemoteConfig {
  return {
    id: pairingRemoteId(payload),
    name: payload.name ?? payload.host,
    host: payload.host,
    port: payload.port,
    username: payload.user,
    privateKey: payload.key ?? '',
    ...(payload.session === undefined ? {} : { session: payload.session }),
    connectTimeoutMs: 20_000,
    keepaliveIntervalMs: 15_000
  }
}
