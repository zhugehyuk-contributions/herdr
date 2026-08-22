// Not from orca. It is the adapter the port map's plan for `terminal-accessory-keys.ts` turns out
// to need: §7 says "**바이트 테이블은 그대로**(`:28-70` ESC/시프트/Ctrl 매핑), 출력만
// `pane.send_input{keys[]}`로", and that is not a substitution — **the bytes never enter `keys[]` at
// all.**
//
//   `PaneSendInputParams.keys` is `Vec<String>` (`src/api/schema/panes.rs:243-250`), and each string
//   goes `normalize_api_key_alias` -> `config::parse_key_combo` (`src/app/api_helpers.rs:11-22`),
//   i.e. it is a *key-combo name* like `ctrl+c`, not a byte sequence. An unparseable name is
//   rejected as `invalid_key` (`src/app/api/panes.rs:1552`) — a stray `\x1b[A` would not be sent
//   literally, it would fail the request.
//
// So orca's table stays as ported (byte-identical, and still the source of the row's ids, labels and
// accessibility labels), and this file is the id -> herdr-name map beside it.
//
// **This is an upgrade, not a workaround.** orca's bytes are fixed at build time, so its `arrowUp`
// is always `ESC [ A` — wrong for a pane in application-cursor mode. herdr encodes the *name* on the
// server through that pane's live key encoder (`src/app/api_helpers.rs:44` ->
// `TerminalRuntime::encode_terminal_key` -> `src/pane/terminal.rs:1709-1733`, which asks the pane's
// ghostty encoder first and falls back to `src/input/encode.rs:18`), so the same tap produces
// `ESC O A` when the TUI asked for it. Keys are also *not* wrapped in bracketed paste, which
// `text` is (`src/app/api_helpers.rs:24-33`) — see `../session/pane-quick-commands.ts`.
import { TERMINAL_ACCESSORY_KEYS, type TerminalAccessoryKey } from './terminal-accessory-keys'

/**
 * The names `parse_key_combo` accepts, transcribed from `src/config/keybinds.rs:1221-1259`.
 *
 * Only the arms this app can reach are listed: the literal match arms, plus "any single character"
 * (`:1252-1259`, via `single_key_char` at `:1265`) and `f<n>` (`:1260`). Modifier tokens are
 * `src/config/keybinds.rs:1151-1160` — `ctrl`/`control`, `shift`, `alt`/`option`/`meta`,
 * `cmd`/`command`/`super`, `hyper` — joined to the key with `+` (`:1202`).
 *
 * Exported because the receipt asserts against it: a mapping that drifts from the server's parser
 * fails as `invalid_key` at runtime, which is exactly the class of bug a table like this exists to
 * prevent.
 */
export const HERDR_NAMED_KEYS: readonly string[] = [
  'space',
  'enter',
  'return',
  'esc',
  'escape',
  'tab',
  'backspace',
  'bs',
  'left',
  'right',
  'up',
  'down',
  'minus',
  'comma',
  'period',
  'slash',
  'backslash',
  'quote',
  'double_quote',
  'double-quote',
  'semicolon',
  'colon',
  'percent',
  'ampersand',
  'backtick',
  'plus'
]

const HERDR_MODIFIERS: readonly string[] = [
  'ctrl',
  'control',
  'shift',
  'alt',
  'option',
  'meta',
  'cmd',
  'command',
  'super',
  'hyper'
]

/**
 * orca accessory-key id -> the `keys[]` entry herdr's parser accepts for it.
 *
 * Every value is one of the arms cited on {@link HERDR_NAMED_KEYS}; the specific line is on each
 * row. Nineteen of orca's twenty built-ins map; the twentieth is in {@link
 * UNSUPPORTED_ACCESSORY_KEY_IDS}.
 */
export const HERDR_KEY_BY_ACCESSORY_ID: Readonly<Record<string, string>> = {
  escape: 'esc', // keybinds.rs:1225 `"esc" | "escape"`
  tab: 'tab', // keybinds.rs:1230
  enter: 'enter', // keybinds.rs:1224 `"enter" | "return"`
  // keybinds.rs:1226-1229: `"tab"` *with* SHIFT is the one arm that rewrites its own code, to
  // `KeyCode::BackTab`. So reverse-tab is spelled as a modifier here, not as its own name.
  shiftTab: 'shift+tab',
  space: 'space', // keybinds.rs:1223 `"space" | " "`
  backspace: 'backspace', // keybinds.rs:1231 `"backspace" | "bs"`
  arrowUp: 'up', // keybinds.rs:1234
  arrowDown: 'down', // keybinds.rs:1235
  arrowLeft: 'left', // keybinds.rs:1232
  arrowRight: 'right', // keybinds.rs:1233
  // The Ctrl row: `ctrl` is a modifier token (keybinds.rs:1153) and the letter falls through to the
  // single-character arm (keybinds.rs:1252-1259). `ctrl+c` additionally has an explicit alias ahead
  // of the parser (`src/app/api_helpers.rs:17` maps `C-c`/`c-c` onto it), which is corroboration
  // that this spelling is the one the API expects.
  ctrlC: 'ctrl+c',
  ctrlD: 'ctrl+d',
  ctrlL: 'ctrl+l',
  ctrlZ: 'ctrl+z',
  ctrlR: 'ctrl+r',
  ctrlA: 'ctrl+a',
  ctrlE: 'ctrl+e',
  ctrlW: 'ctrl+w',
  ctrlU: 'ctrl+u'
}

/**
 * Accessory keys herdr's JSON API cannot express, with the reason.
 *
 * `delete` (forward delete) is orca's `ESC [ 3 ~`. `parse_key_combo` has no `delete` arm and no
 * `KeyCode::Delete` anywhere in `src/config/keybinds.rs:1221-1261`; `"delete"` is longer than one
 * char so `single_key_char` (`:1265-1272`) returns `None`, and it does not start with `f`, so the
 * function returns `None` and the request is answered `invalid_key`
 * (`src/app/api/panes.rs:1552`). The same hole covers `home`/`end`/`pageUp`/`pageDown`/`insert`,
 * which orca offers in `TERMINAL_SHORTCUT_SPECIAL_KEYS` but not in the default row.
 *
 * Dropping the button is the honest move: sending `\x1b[3~` as `text` instead would take the
 * bracketed-paste path (`src/app/api_helpers.rs:24-33`) and arrive as pasted *text* — an escape
 * sequence delivered as literal characters is worse than an absent key.
 */
export const UNSUPPORTED_ACCESSORY_KEY_IDS: readonly string[] = ['delete']

/**
 * `normalize_api_key_alias` (`src/app/api_helpers.rs:16-22`) — the two rewrites the API applies
 * *before* the parser sees a name. `"+"` is the load-bearing one: the parser splits on `+`
 * (`src/config/keybinds.rs:1202`), so a literal plus could never reach it as a key.
 */
function normalizeApiKeyAlias(key: string): string {
  switch (key) {
    case 'C-c':
    case 'c-c':
      return 'ctrl+c'
    case '+':
      return 'plus'
    default:
      return key
  }
}

/**
 * True when `name` is a combo the API would accept. Mirrors `src/app/api_helpers.rs:11-14`: the
 * alias pass over the trimmed string, then `src/config/keybinds.rs:1201`, arm for arm.
 */
export function isHerdrKeyName(name: string): boolean {
  const parts = normalizeApiKeyAlias(name.trim()).split('+')
  let key: string | null = null
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed.length === 0) {
      // keybinds.rs:1209-1211: an empty segment fails the whole combo.
      return false
    }
    if (HERDR_MODIFIERS.includes(trimmed.toLowerCase())) {
      continue
    }
    if (key !== null) {
      // keybinds.rs:1212-1214: a second non-modifier segment fails the whole combo.
      return false
    }
    key = trimmed
  }
  if (key === null) {
    return false
  }
  const lower = key.toLowerCase()
  if (HERDR_NAMED_KEYS.includes(lower)) {
    return true
  }
  // keybinds.rs:1252-1259, then :1260. `Array.from` because `single_key_char` counts *chars*, and a
  // non-BMP codepoint is one `char` in Rust but two UTF-16 units here.
  if (Array.from(key).length === 1) {
    return true
  }
  return /^f([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(lower)
}

/** The accessory keys this app shows: orca's row minus what herdr cannot express. */
export const HERDR_ACCESSORY_KEYS: readonly TerminalAccessoryKey[] = TERMINAL_ACCESSORY_KEYS.filter(
  (key) => !UNSUPPORTED_ACCESSORY_KEY_IDS.includes(key.id)
)

/** The `keys[]` entry for an accessory id, or null when herdr has no name for it. */
export function herdrKeyForAccessoryId(id: string): string | null {
  return HERDR_KEY_BY_ACCESSORY_ID[id] ?? null
}
