// Not from orca. The add/edit form for one remote — split out of `app/settings.tsx` so that screen
// stays a list with a form on it rather than a form with a list on it.
//
// Two properties it is judged on, both security ones:
//   1. The private key field is **write-only**. Editing an existing remote renders an empty box
//      whose placeholder says the stored key is kept; the key itself is never read out of the
//      keystore into this tree, so it cannot appear in a screenshot, a props dump or a crash report
//      (`../../modules/herdr-ssh/src/remote-store.ts` is what makes that possible, by handing the
//      screen a summary with no key field on it).
//   2. What the user pastes is described back to them *before* it is stored — an RSA or classic-PEM
//      key authenticates on Android and silently fails on iOS (`../../.prd/06-open-decisions.md`
//      결정 7), and the advisory line is the only place that gap is visible before a dial fails.
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { typography } from '../theme/herdr-typography'
import { mono } from '../theme/monotone'
import { spacing } from '../theme/mobile-theme'
import type { RemoteDraft, RemoteDraftField } from './remote-form'

interface FieldSpec {
  field: RemoteDraftField
  label: string
  placeholder: string
  multiline?: boolean
  secure?: boolean
}

/** Order is the order a user fills them in: identity, then address, then credentials, then extras. */
const FIELDS: FieldSpec[] = [
  { field: 'id', label: 'id', placeholder: 'fable' },
  { field: 'name', label: 'name', placeholder: 'optional — defaults to the id' },
  { field: 'host', label: 'host', placeholder: '192.168.50.10' },
  { field: 'port', label: 'port', placeholder: '22' },
  { field: 'username', label: 'username', placeholder: 'z' },
  {
    field: 'privateKey',
    label: 'private key',
    placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----',
    multiline: true
  },
  { field: 'passphrase', label: 'passphrase', placeholder: 'optional', secure: true },
  { field: 'hostKeySha256', label: 'host key sha256', placeholder: 'optional — the SHA256: body' },
  { field: 'herdrBinary', label: 'herdr binary', placeholder: 'optional — /opt/herdr' },
  { field: 'session', label: 'session', placeholder: 'optional — herdr --session <name>' }
]

export function RemoteEditor({
  draft,
  errors,
  mode,
  advisories,
  saveError,
  onChange,
  onSave,
  onCancel,
  probeLine,
  probing,
  onProbe
}: {
  draft: RemoteDraft
  errors: Partial<Record<RemoteDraftField, string>>
  mode: 'create' | 'edit'
  /** Per-platform warnings about the key in the box, from `privateKeyAdvisories`. */
  advisories: string[]
  saveError: string | null
  onChange: (field: RemoteDraftField, value: string) => void
  onSave: () => void
  onCancel: () => void
  /**
   * The mockup's reachability line (`assets/mockup.html:460`), already rendered — this component
   * owns no async work, so the screen that can dial hands it the finished sentence.
   */
  probeLine: string | null
  probing: boolean
  onProbe: () => void
}) {
  return (
    <View style={styles.form}>
      <Text style={styles.formTitle}>{mode === 'create' ? 'new remote' : `edit ${draft.id}`}</Text>
      {FIELDS.map((spec) => (
        <View key={spec.field} style={styles.field}>
          <Text style={styles.label}>{spec.label}</Text>
          <TextInput
            accessibilityLabel={spec.label}
            value={draft[spec.field] as string}
            onChangeText={(value: string) => onChange(spec.field, value)}
            placeholder={placeholderFor(spec, mode)}
            placeholderTextColor={mono.dim2}
            autoCapitalize="none"
            autoCorrect={false}
            multiline={spec.multiline ?? false}
            secureTextEntry={spec.secure ?? false}
            // The id is the keystore key this remote is stored under
            // (`../../modules/herdr-ssh/src/remote-store.ts`), so changing it in place would mean
            // "update a remote that does not exist" — the save would fail with a message about an
            // id the user just typed. Fixed here instead, and a rename is a delete plus an add,
            // which is honest about what it costs: re-entering the key.
            editable={!(mode === 'edit' && spec.field === 'id')}
            style={[styles.input, spec.multiline === true && styles.inputMultiline]}
          />
          {errors[spec.field] ? (
            <Text style={styles.error}>{`${spec.label} · ${errors[spec.field]}`}</Text>
          ) : null}
        </View>
      ))}
      {/* A checkbox rather than a `Switch`: the platform switch paints itself in a hue, and the
          palette here has none (`../theme/monotone.ts`). */}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel="allow unknown host key"
        accessibilityState={{ checked: draft.allowUnknownHostKey }}
        onPress={() => onChange('allowUnknownHostKey', draft.allowUnknownHostKey ? '' : 'on')}
        style={styles.checkbox}
      >
        <Text style={styles.checkboxMark}>{draft.allowUnknownHostKey ? '[x]' : '[ ]'}</Text>
        <Text style={styles.checkboxLabel}>
          allow unknown host key — dials a host whose key is not pinned above
        </Text>
      </Pressable>
      {advisories.map((advisory) => (
        <Text key={advisory} style={styles.advisory}>
          {advisory}
        </Text>
      ))}
      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
      {/* `.prd/11-mockup-conformance.md` 누락 #9 (P0). Adding a remote here means typing a host, a
          port, a username and a private key body into a phone, and until this line existed the app
          said nothing afterwards — a wrong port and a wrong key both showed up as a list that
          stayed empty. Placed above the actions because it is what tells you whether to press
          save. */}
      {probeLine ? <Text style={styles.probe}>{probeLine}</Text> : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="test connection"
          disabled={probing}
          onPress={onProbe}
          style={[styles.button, probing && styles.buttonBusy]}
        >
          <Text style={styles.buttonLabel}>{probing ? 'testing…' : 'test'}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="save remote"
          onPress={onSave}
          style={styles.primary}
        >
          <Text style={styles.primaryLabel}>save</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="cancel"
          onPress={onCancel}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>cancel</Text>
        </Pressable>
      </View>
    </View>
  )
}

function placeholderFor(spec: FieldSpec, mode: 'create' | 'edit'): string {
  if (mode === 'edit' && spec.field === 'id') {
    return 'fixed — delete and re-add to change it'
  }
  if (mode === 'edit' && spec.field === 'privateKey') {
    return 'kept — paste a key here to replace it'
  }
  if (mode === 'edit' && spec.field === 'passphrase') {
    return 'kept with the key'
  }
  return spec.placeholder
}

const styles = StyleSheet.create({
  form: {
    borderTopWidth: 1,
    borderTopColor: mono.line,
    paddingTop: spacing.md,
    marginTop: spacing.md
  },
  formTitle: {
    color: mono.fg,
    fontSize: 13,
    fontWeight: '700',
    paddingBottom: spacing.sm,
    fontFamily: typography.monoFamily
  },
  field: { paddingBottom: spacing.sm },
  label: { color: mono.dim, fontSize: 11, paddingBottom: 2, fontFamily: typography.monoFamily },
  input: {
    color: mono.fg,
    fontSize: 13,
    backgroundColor: mono.ink2,
    borderWidth: 1,
    borderColor: mono.line,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontFamily: typography.monoFamily
  },
  inputMultiline: { minHeight: 84 },
  error: { color: mono.fgSoft, fontSize: 11, paddingTop: 2, fontFamily: typography.monoFamily },
  // One rung below `fg`: a platform caveat is not an error, and the app must not look like it is
  // refusing a key it is about to store happily.
  advisory: {
    color: mono.fgSoft,
    fontSize: 11,
    paddingTop: 4,
    lineHeight: 15,
    fontFamily: typography.monoFamily
  },
  checkbox: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
  checkboxMark: { color: mono.fg, fontSize: 13, fontFamily: typography.monoFamily },
  checkboxLabel: {
    color: mono.dim,
    fontSize: 11,
    marginLeft: 6,
    flex: 1,
    fontFamily: typography.monoFamily
  },
  actions: { flexDirection: 'row', paddingTop: spacing.sm },
  // Emphasis by inversion, which is this palette's only way to say "primary" (mockup.html:863).
  primary: { backgroundColor: mono.fg, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8 },
  primaryLabel: {
    color: mono.ink,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: typography.monoFamily
  },
  button: { borderWidth: 1, borderColor: mono.line, paddingHorizontal: 14, paddingVertical: 8 },
  buttonLabel: { color: mono.fg, fontSize: 13, fontFamily: typography.monoFamily },
  buttonBusy: { opacity: 0.5 },
  probe: {
    color: mono.fgSoft,
    fontSize: 12,
    paddingBottom: 6,
    fontFamily: typography.monoFamily
  }
})
