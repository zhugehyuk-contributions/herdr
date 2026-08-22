// Not from orca. It guards the one place a phone tap can be silently wrong: the mapping from
// orca's accessory ids to the key *names* herdr's `parse_key_combo` accepts. A drift here does not
// crash — the server answers `invalid_key` (`src/app/api/panes.rs:1552`) and the key just never
// happens, which on an approval prompt looks exactly like a slow agent.
//
// The live receipt (`test/live/paneInput.live.test.tsx`) proves the mapping against a real parser;
// this proves it against the transcription, phone-free, so a break is localised before anything is
// spawned (port map §3 P1).
import { describe, expect, it } from 'vitest'
import { TERMINAL_ACCESSORY_KEYS } from './terminal-accessory-keys'
import {
  HERDR_ACCESSORY_KEYS,
  HERDR_KEY_BY_ACCESSORY_ID,
  UNSUPPORTED_ACCESSORY_KEY_IDS,
  herdrKeyForAccessoryId,
  isHerdrKeyName
} from './terminal-accessory-herdr-keys'

describe('the orca accessory row against herdr key names', () => {
  it('covers every orca built-in exactly once, as mapped or as unsupported', () => {
    const ids = TERMINAL_ACCESSORY_KEYS.map((key) => key.id)
    const accounted = [...Object.keys(HERDR_KEY_BY_ACCESSORY_ID), ...UNSUPPORTED_ACCESSORY_KEY_IDS]
    expect([...accounted].sort()).toEqual([...ids].sort())
    // No id is both mapped and unsupported.
    expect(
      UNSUPPORTED_ACCESSORY_KEY_IDS.filter((id) => id in HERDR_KEY_BY_ACCESSORY_ID)
    ).toEqual([])
  })

  it('maps nineteen of orca’s twenty; `delete` is the one herdr cannot name', () => {
    expect(TERMINAL_ACCESSORY_KEYS).toHaveLength(20)
    expect(Object.keys(HERDR_KEY_BY_ACCESSORY_ID)).toHaveLength(19)
    expect(UNSUPPORTED_ACCESSORY_KEY_IDS).toEqual(['delete'])
    // …and it is dropped from the row rather than rendered as a dead button.
    expect(HERDR_ACCESSORY_KEYS.map((key) => key.id)).not.toContain('delete')
    expect(HERDR_ACCESSORY_KEYS).toHaveLength(19)
    expect(herdrKeyForAccessoryId('delete')).toBeNull()
  })

  it('every mapped name is one `parse_key_combo` would accept', () => {
    for (const [id, name] of Object.entries(HERDR_KEY_BY_ACCESSORY_ID)) {
      expect(isHerdrKeyName(name), `${id} -> ${name}`).toBe(true)
    }
  })

  it('spells the keys M3 names the way `src/config/keybinds.rs:1221-1259` does', () => {
    expect(herdrKeyForAccessoryId('enter')).toBe('enter')
    expect(herdrKeyForAccessoryId('escape')).toBe('esc')
    expect(herdrKeyForAccessoryId('ctrlC')).toBe('ctrl+c')
    expect(herdrKeyForAccessoryId('tab')).toBe('tab')
    expect(herdrKeyForAccessoryId('arrowUp')).toBe('up')
    expect(herdrKeyForAccessoryId('arrowDown')).toBe('down')
    expect(herdrKeyForAccessoryId('arrowLeft')).toBe('left')
    expect(herdrKeyForAccessoryId('arrowRight')).toBe('right')
  })

  it('sends reverse-tab as `shift+tab`, the only spelling the parser rewrites', () => {
    // `keybinds.rs:1226-1229` — the `"tab"` arm with SHIFT set becomes `KeyCode::BackTab`. There is
    // no `backtab` name, so orca's `\x1b[Z` byte has to arrive as a modifier combo or not at all.
    expect(herdrKeyForAccessoryId('shiftTab')).toBe('shift+tab')
    expect(isHerdrKeyName('backtab')).toBe(false)
  })

  it('keeps orca’s ids/labels: the row is still orca’s, only the wire changed', () => {
    const byId = new Map(TERMINAL_ACCESSORY_KEYS.map((key) => [key.id, key]))
    for (const key of HERDR_ACCESSORY_KEYS) {
      expect(key).toBe(byId.get(key.id))
    }
  })
})

describe('isHerdrKeyName mirrors parse_key_combo', () => {
  it('accepts the named arms', () => {
    for (const name of ['space', 'enter', 'return', 'esc', 'escape', 'tab', 'backspace', 'bs']) {
      expect(isHerdrKeyName(name)).toBe(true)
    }
  })

  it('accepts any single character and f<n>', () => {
    // `single_key_char` (`keybinds.rs:1265-1272`) is not ASCII-limited: `parse_key_combo`'s own test
    // at `:1483` feeds it `ö`.
    for (const name of ['y', 'n', '1', 'ö', 'f1', 'f12']) {
      expect(isHerdrKeyName(name)).toBe(true)
    }
  })

  it('accepts a literal `+` only because the API aliases it first', () => {
    // Measured, not assumed: `parse_key_combo` splits on `+` (`keybinds.rs:1202`), so `"+"` reaches
    // it as two empty segments and fails. `normalize_api_key_alias` (`api_helpers.rs:19`) rewrites
    // it to `plus` before that, which is why the alias pass has to be mirrored here too.
    expect(isHerdrKeyName('+')).toBe(true)
    expect(isHerdrKeyName('plus')).toBe(true)
    expect(isHerdrKeyName('C-c')).toBe(true) // api_helpers.rs:17
  })

  it('rejects the special keys orca has and herdr does not', () => {
    for (const name of ['delete', 'home', 'end', 'pageUp', 'pageDown', 'insert']) {
      expect(isHerdrKeyName(name)).toBe(false)
    }
  })

  it('rejects escape sequences — the bug this whole file exists to catch', () => {
    // If orca's byte table were piped into `keys[]` as the port map's wording suggests, this is what
    // would be sent. Every multi-byte sequence fails `single_key_char` (`keybinds.rs:1265-1272`) and
    // matches no named arm, so the server answers `invalid_key`.
    for (const bytes of ['\x1b[A', '\x1b[Z', '\x1b[3~', '\t\t']) {
      expect(isHerdrKeyName(bytes)).toBe(false)
    }
  })

  it('would NOT catch a single-byte control character, and that is the parser’s doing', () => {
    // `\x03` (orca's `ctrlC` byte) is one char, so `single_key_char` accepts it and the combo parses
    // as `KeyCode::Char('\u{3}')` with no CONTROL modifier — a *different* thing from `ctrl+c` that
    // happens to encode to the same byte today. Recorded rather than asserted away: the mapping
    // table above is what keeps bytes out of `keys[]`, not this predicate.
    expect(isHerdrKeyName('\x03')).toBe(true)
    expect(Object.values(HERDR_KEY_BY_ACCESSORY_ID)).not.toContain('\x03')
  })

  it('rejects the malformed combos the parser rejects', () => {
    expect(isHerdrKeyName('')).toBe(false)
    expect(isHerdrKeyName('ctrl+')).toBe(false) // keybinds.rs:1209-1211, empty segment
    expect(isHerdrKeyName('a+b')).toBe(false) // keybinds.rs:1212-1214, two non-modifiers
    expect(isHerdrKeyName('ctrl')).toBe(false) // modifiers only, `key_str?` at :1220
  })

  it('accepts every modifier token, in any case', () => {
    for (const modifier of ['ctrl', 'control', 'shift', 'alt', 'option', 'meta', 'cmd', 'command', 'super', 'hyper']) {
      expect(isHerdrKeyName(`${modifier}+c`)).toBe(true)
      expect(isHerdrKeyName(`${modifier.toUpperCase()}+c`)).toBe(true)
    }
  })
})
