// Not from orca (orca's `quick-commands.test.ts` tests a saved-command store; see the header of
// `./pane-quick-commands.ts` for why that is a different feature). This pins the one property M3's
// "됐다" depends on: the approval answers travel as **keys**, and every name is one herdr's parser
// accepts — because a quick command that the server answers `invalid_key` is a button that silently
// does nothing to a blocked agent.
import { describe, expect, it } from 'vitest'
import { PANE_QUICK_COMMANDS, findQuickCommand, quickCommandChunk } from './pane-quick-commands'
import { isHerdrKeyName } from '../terminal/terminal-accessory-herdr-keys'

describe('pane quick commands', () => {
  it('offers the y/n/approve set M3 names', () => {
    expect(PANE_QUICK_COMMANDS.map((command) => command.id)).toEqual([
      'yes',
      'no',
      'yesEnter',
      'accept',
      'cancel'
    ])
  })

  it('answers a prompt with `y` in one tap — the milestone, as a value', () => {
    expect(findQuickCommand('yes')?.keys).toEqual(['y'])
  })

  it('sends keys and never text', () => {
    // `text` would be wrapped in `ESC [ 200 ~`…`ESC [ 201 ~` whenever the pane has bracketed paste
    // on (`src/app/api_helpers.rs:24-33`) — which an agent TUI reading a confirmation prompt does.
    // A one-character *paste* is not a keypress.
    for (const command of PANE_QUICK_COMMANDS) {
      const chunk = quickCommandChunk(command)
      expect(chunk.text, command.id).toBe('')
      expect(chunk.keys.length, command.id).toBeGreaterThan(0)
    }
  })

  it('spells every key the way `parse_key_combo` does', () => {
    for (const command of PANE_QUICK_COMMANDS) {
      for (const key of command.keys) {
        expect(isHerdrKeyName(key), `${command.id} -> ${key}`).toBe(true)
      }
    }
  })

  it('gives every command an accessibility label distinct from its glyph label', () => {
    // The labels are `y` / `n` / `↵` — unreadable to a screen reader, which is the whole reason
    // orca's accessory table carries `accessibilityLabel` beside `label`.
    for (const command of PANE_QUICK_COMMANDS) {
      expect(command.accessibilityLabel.length, command.id).toBeGreaterThan(2)
      expect(command.accessibilityLabel).not.toBe(command.label)
    }
  })

  it('has unique ids and labels', () => {
    expect(new Set(PANE_QUICK_COMMANDS.map((c) => c.id)).size).toBe(PANE_QUICK_COMMANDS.length)
    expect(new Set(PANE_QUICK_COMMANDS.map((c) => c.label)).size).toBe(PANE_QUICK_COMMANDS.length)
  })

  it('returns null for an unknown id rather than throwing at a tap site', () => {
    expect(findQuickCommand('nope')).toBeNull()
  })
})
