// Not from orca (orca's settings screens edit orca hosts, which are a relay pairing and not an ssh
// login). The settings form's non-visual half: a screenful of strings in, either a config the
// dialler accepts or a reason per field.
//
// Separate from the screen because these are decisions rather than pixels — "a port is 1..65535",
// "an id has to survive being a keystore key", "an edit with an empty key field means *keep the
// stored key*, not delete it" — and a decision that only a mounted renderer can reach is one nobody
// re-checks. The screen renders what this returns.
import {
  parseRemoteConfig,
  STORED_REMOTE_ID_PATTERN,
  type HerdrSshRemoteConfig,
  type StoredRemoteEdit,
  type StoredRemoteSummary
} from '../../modules/herdr-ssh'
import { pairingRemoteId } from '../pairing/pairing-payload'

/** Every field as the user types it — all strings, because that is what a `TextInput` produces. */
export interface RemoteDraft {
  id: string
  name: string
  host: string
  port: string
  username: string
  privateKey: string
  passphrase: string
  hostKeySha256: string
  allowUnknownHostKey: boolean
  herdrBinary: string
  session: string
}

export type RemoteDraftField = keyof RemoteDraft

export function emptyDraft(): RemoteDraft {
  return {
    id: '',
    name: '',
    host: '',
    port: '',
    username: '',
    privateKey: '',
    passphrase: '',
    hostKeySha256: '',
    allowUnknownHostKey: false,
    herdrBinary: '',
    session: ''
  }
}

/**
 * The form for an existing remote — built from the summary, which has no key in it to begin with
 * (`modules/herdr-ssh/src/remote-store.ts`).
 *
 * Field by field rather than a spread: a summary that ever grew a `privateKey` (or anything else
 * secret) would otherwise ride into React state, and from there into a screenshot, a JS error
 * report or a `console.log` of the component's props.
 */
export function draftFromRemote(summary: StoredRemoteSummary): RemoteDraft {
  return {
    id: summary.id,
    name: summary.name,
    host: summary.host,
    port: String(summary.port),
    username: summary.username,
    // Both stay empty and both mean "keep what is stored" — see `parseRemoteDraft`.
    privateKey: '',
    passphrase: '',
    hostKeySha256: summary.hostKeySha256 ?? '',
    allowUnknownHostKey: summary.allowUnknownHostKey,
    herdrBinary: summary.herdrBinary ?? '',
    session: summary.session ?? ''
  }
}

export type ParsedDraft =
  | { ok: true; kind: 'full'; config: HerdrSshRemoteConfig }
  | { ok: true; kind: 'keepKey'; config: StoredRemoteEdit }
  | { ok: false; errors: Partial<Record<RemoteDraftField, string>> }

/**
 * `kind` is the interesting half.
 *
 * `full` carries a key the user just typed. `keepKey` carries everything *but* the key, and only an
 * edit can produce it: the key stays in the keystore and `updateStoredRemote` puts it back, so
 * editing a remote's port never requires the app to hold its private key at all.
 */
export function parseRemoteDraft(
  draft: RemoteDraft,
  options: { mode: 'create' | 'edit' }
): ParsedDraft {
  const errors: Partial<Record<RemoteDraftField, string>> = {}
  const id = draft.id.trim()
  const host = draft.host.trim()
  const username = draft.username.trim()
  const privateKey = normalisePrivateKey(draft.privateKey)

  if (id.length === 0) {
    errors.id = 'required — this is the id the app addresses this remote by'
  } else if (!STORED_REMOTE_ID_PATTERN.test(id)) {
    // Not cosmetic: the id becomes part of a keystore key, whose charset is `/^[\w.-]+$/`
    // (`node_modules/expo-secure-store/build/SecureStore.js:150`).
    errors.id = 'letters, digits, ".", "-" and "_" only, at most 64'
  }
  if (host.length === 0) {
    errors.host = 'required'
  }
  if (username.length === 0) {
    errors.username = 'required'
  }
  if (privateKey.length === 0 && options.mode === 'create') {
    errors.privateKey = 'required — paste the contents of an OpenSSH private key file'
  }
  const port = parsePort(draft.port)
  if (port === null) {
    errors.port = 'a whole number from 1 to 65535, or blank for 22'
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors }
  }

  const keepKey = privateKey.length === 0
  const record: Record<string, unknown> = {
    id,
    host,
    username,
    // A blank key is only reachable in edit mode, where the placeholder below is validated and then
    // dropped — it is never stored and never leaves this function.
    privateKey: keepKey ? KEY_PLACEHOLDER : privateKey,
    ...(port === undefined ? {} : { port }),
    ...optional('name', draft.name),
    ...optional('hostKeySha256', draft.hostKeySha256),
    ...optional('herdrBinary', draft.herdrBinary),
    ...optional('session', draft.session),
    ...(keepKey ? {} : optional('passphrase', draft.passphrase)),
    // Absent rather than `false`: the schema's default already means "enforce the host key".
    ...(draft.allowUnknownHostKey ? { allowUnknownHostKey: true } : {})
  }

  const parsed = parseRemoteConfig(record)
  if (!parsed.ok) {
    // Everything the form knows about is checked above, so this is a schema rule the form has not
    // learned yet. Reported on the field it names rather than swallowed.
    return { ok: false, errors: { [fieldOf(parsed.reason)]: parsed.reason } }
  }
  if (!keepKey) {
    return { ok: true, kind: 'full', config: parsed.config }
  }
  const { privateKey: _key, passphrase: _passphrase, ...edit } = parsed.config
  return { ok: true, kind: 'keepKey', config: edit }
}

/**
 * Stands in for the stored key while the schema validates the *rest* of an edit.
 *
 * The alternative was a second zod schema without `privateKey`, i.e. two definitions of one shape
 * that drift apart. This value is discarded three lines after it is created and never reaches a
 * store.
 */
const KEY_PLACEHOLDER = '(kept)'

/**
 * What a paste has to become before it is stored: no `\r`, no surrounding blank lines, one trailing
 * newline.
 *
 * Not cosmetic. Citadel — iOS's whole ssh stack — strips `\n` and then requires the text to *end*
 * with `-----END OPENSSH PRIVATE KEY-----`
 * (`modules/herdr-ssh/typecheck/ios/.build/checkouts/Citadel/Sources/Citadel/OpenSSHKey.swift:307-313`),
 * and it does not strip `\r`. A key pasted with CRLF line endings therefore fails there with
 * `invalidOpenSSHBoundary`, on a phone, with no log — while the same paste works on Android. The
 * trailing newline is restored because that is how the file the user copied from ends.
 */
function normalisePrivateKey(text: string): string {
  const stripped = text.replaceAll('\r', '').trim()
  return stripped.length === 0 ? '' : `${stripped}\n`
}

function optional(field: string, value: string): Record<string, string> {
  const trimmed = value.trim()
  return trimmed.length === 0 ? {} : { [field]: trimmed }
}

/** `undefined` = blank, i.e. take the schema's 22. `null` = the user typed something that is not a port. */
function parsePort(value: string): number | null | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  if (!/^\d+$/.test(trimmed)) {
    return null
  }
  const port = Number(trimmed)
  return port >= 1 && port <= 65535 ? port : null
}

const FIELDS = new Set<string>(Object.keys(emptyDraft()))

/** zod's reason is `path: message`; the path is the field the screen should point at. */
function fieldOf(reason: string): RemoteDraftField {
  const path = reason.split(':')[0]?.trim() ?? ''
  return FIELDS.has(path) ? (path as RemoteDraftField) : 'id'
}

/**
 * The form a scanned pairing code lands on (`.prd/12-qr-pairing.md`, goal condition 5).
 *
 * A draft rather than a saved remote on purpose: nothing reaches the keystore because a camera saw
 * a shape. The user sees the filled form and presses save, which is also the only path on which the
 * existing validation, the host-key advisories and the reachability probe (`.prd/11` #9) run.
 *
 * `allowUnknownHostKey` is left **false**. A code can carry a key and a target; it cannot carry the
 * user's decision to dial a host whose identity nothing has pinned, and defaulting that to true
 * because the transport arrived over a QR would be the app deciding a security question on the
 * strength of a photograph.
 */
export function draftFromPairing(payload: {
  name?: string | undefined
  host: string
  port: number
  user: string
  session?: string | undefined
  key?: string | undefined
}): RemoteDraft {
  return {
    ...emptyDraft(),
    id: pairingRemoteId({ user: payload.user, host: payload.host, port: payload.port }),
    name: payload.name ?? payload.host,
    host: payload.host,
    port: String(payload.port),
    username: payload.user,
    privateKey: payload.key ?? '',
    session: payload.session ?? ''
  }
}
