// Not from orca. orca's `app/settings.tsx` is graded `copy` in the port map (§2.2), but what it is a
// shell *over* is orca's host store — a relay pairing — and herdr's authentication is ssh
// (01-spec.md). So the chrome is orca-shaped and the content is this repo's.
//
// This is the screen milestone M2b exists for. Before it, the only way to tell the app which server
// to dial was `app.json`'s `expo.extra.herdrRemotes`: a committed file, shipped inside the binary,
// which meant a working build was a private key in git and a user could not add their own box
// without a rebuild. The two halves of "됐다" here are (1) a remote added on the phone is dialled
// without a rebuild — and, because `useHerdrSshConnections` subscribes to the keystore's revision,
// without a restart either — and (2) the key it holds is never rendered, logged or copied into
// component state.
//
// The list has two kinds of row and they are not equal:
//   · keystore rows, which this screen owns and can edit or delete;
//   · `app.json` rows, shown read-only and only in a development build, because that channel is a
//     fallback the settings screen cannot manage (the entry is in the bundle, not in the store) and
//     a release build does not read it at all (`modules/herdr-ssh/src/remote-source.ts`).
import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  bundledFallbackAllowed,
  deleteStoredRemote,
  loadStoredRemoteSummaries,
  privateKeyAdvisories,
  readBundledRemotes,
  saveStoredRemote,
  summariseRemote,
  updateStoredRemote,
  type StoredRemoteSummary
} from '../modules/herdr-ssh'
import { RemoteEditor } from '../src/settings/RemoteEditor'
import { describeProbe, probeSshRemote } from '../modules/herdr-ssh/src/probe'
import {
  draftFromRemote,
  emptyDraft,
  parseRemoteDraft,
  type RemoteDraft,
  type RemoteDraftField
} from '../src/settings/remote-form'
import { describePrivateKey } from '../modules/herdr-ssh'
import { useBlockedPushStatus } from '../src/notifications/blocked-push-context'
import { BLOCKED_ONLY_NOTE, summarisePush } from '../src/notifications/blocked-push-summary'
import { typography } from '../src/theme/mobile-theme'
import { mono } from '../src/theme/monotone'
import { spacing } from '../src/theme/mobile-theme'

interface Inventory {
  stored: StoredRemoteSummary[]
  /** `app.json`'s entries, summarised on arrival so their keys never reach this component's state. */
  bundled: StoredRemoteSummary[]
  rejected: string[]
  storeAvailable: boolean
  bundledActive: boolean
}

const EMPTY: Inventory = {
  stored: [],
  bundled: [],
  rejected: [],
  storeAvailable: true,
  bundledActive: false
}

async function readInventory(): Promise<Inventory> {
  const [stored, bundled] = await Promise.all([loadStoredRemoteSummaries(), readBundledRemotes()])
  return {
    stored: stored.summaries,
    bundled: bundled.remotes.map(summariseRemote),
    rejected: [
      ...stored.rejected.map((entry) => `keystore ${entry.reason}`),
      ...bundled.rejected.map((entry) => `app.json entry ${entry.index}: ${entry.reason}`)
    ],
    storeAvailable: stored.available,
    // The keystore wins whenever it holds anything, so an `app.json` entry is only ever dialled by
    // a development build with an empty store (`modules/herdr-ssh/src/remote-source.ts`).
    bundledActive: bundledFallbackAllowed() && stored.summaries.length === 0
  }
}

type Editing = { mode: 'create' | 'edit'; draft: RemoteDraft }

/**
 * M5. The only surface on which a push that never arrives is distinguishable from a fleet that was
 * never blocked.
 *
 * It reads the root provider rather than registering anything itself: a second `useBlockedPush`
 * here would mean a second permission prompt and a second ssh exec per visit.
 */
function NotificationsSection() {
  const status = useBlockedPushStatus()
  const summary = summarisePush(status)
  return (
    <View style={styles.row}>
      <Text style={styles.name}>notifications</Text>
      <Text style={styles.meta}>{summary.headline}</Text>
      {summary.detail.map((line) => (
        <Text key={line} style={styles.advisory}>
          {line}
        </Text>
      ))}
      {/* Always, in every state — including the working one. It is the shape of the feature, not a
          failure message (`src/notifications/blocked-push-summary.ts`). */}
      <Text style={styles.meta}>{BLOCKED_ONLY_NOTE}</Text>
    </View>
  )
}

export default function SettingsScreen() {
  // Bottom only, and that asymmetry is the point. This is the one route with a real native header
  // (`app/_layout.tsx`: `<Stack.Screen name="settings" options={{ title: 'settings' }} />`), and a
  // native header is already laid out *below* the top inset — adding `insets.top` to the bar under
  // it would count the status bar a second time and push the screen 59pt down its own content.
  // The bottom edge has no such owner: the scroll view runs into the home indicator.
  const insets = useSafeAreaInsets()
  const [inventory, setInventory] = useState<Inventory>(EMPTY)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [errors, setErrors] = useState<Partial<Record<RemoteDraftField, string>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  // `.prd/11-mockup-conformance.md` 누락 #9. Lives here rather than in `RemoteEditor` because the
  // editor is a pure form — it owns no async work and no transport — and because a probe needs the
  // *parsed* draft, which is the same parse `save()` does.
  const [probeLine, setProbeLine] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const probe = useCallback(async () => {
    if (editing === null) {
      return
    }
    const parsed = parseRemoteDraft(editing.draft, { mode: editing.mode })
    if (!parsed.ok) {
      setErrors(parsed.errors)
      // Not a probe failure: nothing was dialled. Saying so beats a ✗ that blames the host.
      setProbeLine('✗ fix the fields above first')
      return
    }
    if (parsed.kind !== 'full') {
      // An edit that kept its stored key. Dialling would need the key back out of the keystore,
      // which this screen deliberately never holds (`src/settings/remote-form.ts`).
      setProbeLine('✗ re-enter the private key to test this remote')
      return
    }
    setProbing(true)
    setProbeLine(null)
    try {
      setProbeLine(describeProbe(await probeSshRemote(parsed.config)))
    } finally {
      setProbing(false)
    }
  }, [editing])
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setInventory(await readInventory())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const change = useCallback((field: RemoteDraftField, value: string) => {
    setEditing((current) =>
      current === null
        ? current
        : {
            ...current,
            draft: {
              ...current.draft,
              [field]: field === 'allowUnknownHostKey' ? value.length > 0 : value
            }
          }
    )
  }, [])

  const save = useCallback(async () => {
    if (editing === null) {
      return
    }
    const parsed = parseRemoteDraft(editing.draft, { mode: editing.mode })
    if (!parsed.ok) {
      setErrors(parsed.errors)
      return
    }
    setErrors({})
    try {
      // `keepKey` is the whole reason an edit form can exist without a secret in it: the config
      // being saved has no `privateKey`, and the store reunites it with the one already encrypted
      // at rest (`modules/herdr-ssh/src/remote-store.ts`).
      await (parsed.kind === 'full'
        ? saveStoredRemote(parsed.config)
        : updateStoredRemote(parsed.config))
    } catch (error) {
      setSaveError(errorMessage(error))
      return
    }
    setSaveError(null)
    setEditing(null)
    await reload()
  }, [editing, reload])

  const remove = useCallback(
    async (id: string) => {
      setPendingDelete(null)
      try {
        await deleteStoredRemote(id)
      } catch (error) {
        setSaveError(errorMessage(error))
        return
      }
      await reload()
    },
    [reload]
  )

  const advisories =
    editing === null
      ? []
      : privateKeyAdvisories(describePrivateKey(editing.draft.privateKey), {
          hasPassphrase: editing.draft.passphrase.length > 0
        })

  return (
    <View style={styles.screen}>
      <View style={styles.appbar}>
        <Text style={styles.logo}>herdr</Text>
        <Text style={styles.crumb}>/ settings</Text>
      </View>
      <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: insets.bottom }}>
        {/* Said up front, because every action below it will fail otherwise — and failing at the
            save button would read as "this remote is wrong" rather than "this build cannot store
            one" (`modules/herdr-ssh/src/remote-store.ts` returns `available: false` for it). */}
        {inventory.storeAvailable ? null : (
          <Text style={styles.notice}>
            This build has no secure storage, so a remote cannot be saved on it. Use a dev build.
          </Text>
        )}
        <Text style={styles.sectionLabel}>push</Text>
        <NotificationsSection />
        <Text style={styles.sectionLabel}>{`remotes · ${inventory.stored.length}`}</Text>
        {inventory.stored.length === 0 ? (
          <Text style={styles.meta}>
            None yet. Everything the app shows until one is added is the built-in demo fleet.
          </Text>
        ) : null}
        {inventory.stored.map((remote) => (
          <View key={remote.id} style={styles.row}>
            <Text style={styles.name}>{remote.name}</Text>
            <Text style={styles.meta}>{`${remote.username}@${remote.host}:${remote.port}`}</Text>
            {/* What the key *is*, never what it holds. `describePrivateKey` reads the header of the
                stored blob and nothing past the public half. */}
            <Text style={styles.meta}>{`key · ${keyLabel(remote)}`}</Text>
            {privateKeyAdvisories(remote.key, { hasPassphrase: remote.hasPassphrase }).map(
              (advisory) => (
                <Text key={advisory} style={styles.advisory}>
                  {advisory}
                </Text>
              )
            )}
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`edit ${remote.id}`}
                onPress={() => {
                  setErrors({})
                  setSaveError(null)
                  setEditing({ mode: 'edit', draft: draftFromRemote(remote) })
                }}
                style={styles.button}
              >
                <Text style={styles.buttonLabel}>edit</Text>
              </Pressable>
              {pendingDelete === remote.id ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`confirm delete ${remote.id}`}
                  onPress={() => void remove(remote.id)}
                  style={styles.primary}
                >
                  <Text style={styles.primaryLabel}>delete for good</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`delete ${remote.id}`}
                  // Two steps, because the key goes with it and nothing in the app can bring it
                  // back — the user has to have it somewhere else to re-enter it.
                  onPress={() => setPendingDelete(remote.id)}
                  style={styles.button}
                >
                  <Text style={styles.buttonLabel}>delete</Text>
                </Pressable>
              )}
            </View>
          </View>
        ))}
        {editing === null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="add remote"
            onPress={() => {
              setErrors({})
              setSaveError(null)
              setEditing({ mode: 'create', draft: emptyDraft() })
            }}
            style={styles.addButton}
          >
            <Text style={styles.buttonLabel}>add remote</Text>
          </Pressable>
        ) : (
          <RemoteEditor
            draft={editing.draft}
            errors={errors}
            mode={editing.mode}
            advisories={advisories}
            saveError={saveError}
            onChange={change}
            onSave={() => void save()}
            probeLine={probeLine}
            probing={probing}
            onProbe={() => void probe()}
            onCancel={() => {
              setEditing(null)
              setErrors({})
              setSaveError(null)
            }}
          />
        )}
        {inventory.bundled.length > 0 ? (
          <View>
            <Text style={styles.sectionLabel}>{`app.json · ${inventory.bundled.length}`}</Text>
            <Text style={styles.meta}>
              {inventory.bundledActive
                ? 'Read from the app bundle by this development build. A release build ignores them, and any remote above wins.'
                : 'In the app bundle but not dialled — a remote in the keystore takes precedence.'}
            </Text>
            {inventory.bundled.map((remote) => (
              <View key={`bundled-${remote.id}`} style={styles.row}>
                <Text style={styles.name}>{remote.name}</Text>
                <Text
                  style={styles.meta}
                >{`${remote.username}@${remote.host}:${remote.port}`}</Text>
                <Text style={styles.meta}>{`key · ${keyLabel(remote)} · in the bundle`}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {inventory.rejected.map((reason) => (
          <Text key={reason} style={styles.error}>
            {reason}
          </Text>
        ))}
      </ScrollView>
    </View>
  )
}

/** Enough to recognise a key by, useless to steal. */
function keyLabel(remote: StoredRemoteSummary): string {
  const parts = [remote.key.algorithm ?? remote.key.container]
  if (remote.key.algorithm !== null && remote.key.container === 'openssh-v1') {
    parts.push('openssh-key-v1')
  }
  if (remote.key.encrypted || remote.hasPassphrase) {
    parts.push('passphrase-protected')
  }
  return parts.join(' · ')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: mono.ink },
  // Keeps its literal 24 — see the note in the component: below a native header this is plain
  // spacing, not a status-bar stand-in, so `safeChromePadding` has nothing to say about it.
  appbar: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 16, paddingTop: 24 },
  logo: { color: mono.fg, fontSize: 20, fontWeight: '700', fontFamily: typography.monoFamily },
  crumb: { color: mono.dim, fontSize: 13, marginLeft: 6, fontFamily: typography.monoFamily },
  body: { flex: 1, paddingHorizontal: 16 },
  sectionLabel: {
    color: mono.dim,
    fontSize: 11,
    fontWeight: '700',
    paddingTop: spacing.lg,
    paddingBottom: 2,
    fontFamily: typography.monoFamily
  },
  row: { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: mono.lineSoft },
  name: { color: mono.fg, fontSize: 15, fontFamily: typography.monoFamily },
  meta: { color: mono.dim, fontSize: 12, lineHeight: 16, fontFamily: typography.monoFamily },
  advisory: {
    color: mono.fgSoft,
    fontSize: 11,
    lineHeight: 15,
    paddingTop: 2,
    fontFamily: typography.monoFamily
  },
  notice: {
    color: mono.fg,
    fontSize: 13,
    lineHeight: 18,
    paddingTop: spacing.md,
    fontFamily: typography.monoFamily
  },
  error: { color: mono.fgSoft, fontSize: 11, paddingTop: 4, fontFamily: typography.monoFamily },
  actions: { flexDirection: 'row', paddingTop: spacing.sm },
  button: {
    borderWidth: 1,
    borderColor: mono.line,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8
  },
  addButton: {
    borderWidth: 1,
    borderColor: mono.line,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: spacing.md,
    alignSelf: 'flex-start'
  },
  buttonLabel: { color: mono.fg, fontSize: 13, fontFamily: typography.monoFamily },
  primary: { backgroundColor: mono.fg, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8 },
  primaryLabel: {
    color: mono.ink,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: typography.monoFamily
  }
})
