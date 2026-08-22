// Not from orca as a file. orca's accessory row and quick-command row live inside
// `app/h/[hostId]/session/[worktreeId].tsx` (5,333 lines), which the port map forbids taking whole
// (§6 위험 2: "훅·순수함수 단위로만 뽑아라"), and its bar is a drag-to-reorder, user-configurable
// surface built on `terminal-accessory-layout.ts` + the quick-command store. This is the same three
// rows against herdr's write API and against the design SSOT the repo actually has:
//
//   mobile/.prd/assets/mockup.html:587  `.keysrow` — one flex row of equal-width keycaps
//   mobile/.prd/assets/mockup.html:588  `.inputbar` — a text field and a `↵` send button
//   mobile/.prd/assets/mockup.html:273-283  their metrics, transcribed into `styles` below
//
// Deliberately absent, each a whole subsystem rather than a line:
//   · reorder / show-hide of the key row (orca's `terminal-accessory-layout.ts`, 230 lines, and its
//     AsyncStorage preference). The row is fixed until someone asks for it to move.
//   · the saved-quick-command store and its editor — see `./pane-quick-commands.ts` for why that
//     orca file is not the feature M3 names.
//   · dictation, the native chat overlay, paste. M3 is "폰에서 승인 눌러주기".
import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  HERDR_ACCESSORY_KEYS,
  herdrKeyForAccessoryId
} from '../terminal/terminal-accessory-herdr-keys'
import { PANE_QUICK_COMMANDS, quickCommandChunk } from './pane-quick-commands'
import { inputStatusLabel } from './pane-input'
import { mono } from '../theme/monotone'
import type { PaneInputView } from './use-pane-input'

export function PaneInputBar({ input }: { input: PaneInputView }) {
  const [draft, setDraft] = useState('')
  const { send, sendKeys, enabled, state } = input
  // .prd/09-review-followups.md §D1's bottom edge. This bar is the last thing in the viewer's
  // column, so its `↵` sat under the home indicator (and under Android's navigation bar, the
  // window being edge-to-edge) — the one control M3 exists for. The keyboard covers the bar
  // whether or not this padding is here (`keyboardLift` is 0, see the route file), so it costs
  // nothing when the field is focused.
  const insets = useSafeAreaInsets()

  // Text, not keys: what the soft keyboard/IME produces is prose, and prose is exactly what
  // `encode_api_text` (`src/app/api_helpers.rs:24-33`) is for — including its bracketed-paste
  // wrapping, which is *correct* for a pasted-looking multi-character answer and wrong for a single
  // confirmation keystroke. The quick-command row is the other case and uses `keys[]`.
  const submit = useCallback(() => {
    const text = draft
    if (text.length === 0) {
      return
    }
    // Cleared optimistically: the field is the phone's own state, and X2 forbids treating an
    // un-acked write as failed, so there is nothing to restore it *to*. The verdict lands in the
    // status line instead.
    setDraft('')
    // One call, text and Enter together, because `encode_api_input` emits text then keys in that
    // order (`src/app/api_helpers.rs:72-84`) — so this is one exec (blocker B8) and one PTY write,
    // not a text call racing an Enter call.
    void send({ text, keys: ['enter'] })
  }, [draft, send])

  const status = inputStatusLabel(state)

  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom }]}>
      <View style={styles.quickRow}>
        {PANE_QUICK_COMMANDS.map((command) => (
          <Pressable
            key={command.id}
            accessibilityRole="button"
            accessibilityLabel={command.accessibilityLabel}
            disabled={!enabled}
            style={[styles.quick, !enabled && styles.disabled]}
            onPress={() => void send(quickCommandChunk(command))}
          >
            <Text style={styles.quickLabel}>{command.label}</Text>
          </Pressable>
        ))}
        {status === null ? null : (
          <Text style={styles.status} numberOfLines={1}>
            {status}
          </Text>
        )}
      </View>

      {/* orca `:4416-4420` again: with the keyboard open, a tap must register on the first press. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.keysRow}
      >
        {HERDR_ACCESSORY_KEYS.map((key) => {
          const name = herdrKeyForAccessoryId(key.id)
          if (name === null) {
            return null
          }
          return (
            <Pressable
              key={key.id}
              accessibilityRole="button"
              accessibilityLabel={key.accessibilityLabel ?? key.label}
              disabled={!enabled}
              style={[styles.key, !enabled && styles.disabled]}
              onPress={() => void sendKeys([name])}
            >
              <Text style={styles.keyLabel}>{key.label}</Text>
            </Pressable>
          )
        })}
      </ScrollView>

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          editable={enabled}
          placeholder="send input…"
          placeholderTextColor={mono.dim2}
          accessibilityLabel="Pane input"
          autoCapitalize="none"
          autoCorrect={false}
          // `blurOnSubmit={false}`: answering one prompt is usually followed by another, and losing
          // the keyboard between them is the phone version of losing the terminal.
          blurOnSubmit={false}
          returnKeyType="send"
          onSubmitEditing={submit}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send input"
          disabled={!enabled || draft.length === 0}
          style={[styles.send, (!enabled || draft.length === 0) && styles.disabled]}
          onPress={submit}
        >
          <Text style={styles.sendLabel}>↵</Text>
        </Pressable>
      </View>
    </View>
  )
}

// mockup.html:273-283, transcribed. The `.key` there is `flex: 1` inside a non-scrolling row of six;
// this row carries nineteen, so the caps get a min-width and the row scrolls instead of shrinking
// them past the touch target.
const styles = StyleSheet.create({
  bar: { borderTopWidth: 1, borderTopColor: mono.line, backgroundColor: mono.ink },
  quickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 8
  },
  quick: {
    minWidth: 44,
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: mono.fgSoft,
    backgroundColor: mono.ink3,
    paddingVertical: 7,
    paddingHorizontal: 10
  },
  quickLabel: { color: mono.fg, fontSize: 12, fontWeight: '700' },
  status: { color: mono.dim, fontSize: 10.5, flexShrink: 1, marginLeft: 4 },
  keysRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingTop: 8 },
  key: {
    minWidth: 44,
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: mono.line,
    backgroundColor: mono.ink3,
    paddingVertical: 7,
    paddingHorizontal: 8
  },
  keyLabel: { color: mono.fgSoft, fontSize: 10.5 },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6
  },
  input: {
    flex: 1,
    color: mono.fg,
    fontSize: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: mono.line,
    backgroundColor: mono.ink2,
    paddingHorizontal: 10,
    paddingVertical: 9
  },
  send: {
    width: 38,
    height: 38,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: mono.fg
  },
  sendLabel: { color: mono.ink, fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.4 }
})
