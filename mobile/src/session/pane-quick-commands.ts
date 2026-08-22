// Not from orca — and that is a correction to the port map, which grades orca's
// `src/terminal/quick-commands.ts` (108 lines) **copy** for "M3의 y/n/승인 퀵커맨드" (§7).
// It was read at `4fd93ead` before this was written, and it is not that feature:
//
//   · it is the *user-configurable saved command* store — label/body/repo-scoping/agent-prompt
//     variants, the editor's mutation helpers, and a launch plan for **starting a new agent**
//     (`buildMobileQuickCommandLaunch` returns `{agent, options:{agentPrompt|startupCommand}}`).
//     herdr has no equivalent RPC; its nearest neighbour would be `workspace.create`, not
//     `pane.send_input`.
//   · four of its five imports are desktop-repo modules — `src/shared/terminal-quick-commands`,
//     `src/shared/terminal-quick-command-types`, `src/shared/tui-agent`,
//     `src/shared/protocol-version` — which is §6 위험 1 exactly ("orca `mobile/` 파일 293개가
//     데스크톱 레포 루트의 `src/shared/`를 import한다"). A byte-identical copy would not compile.
//   · it gates itself on `TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY`, an orca protocol capability.
//
// What M3 actually asks for ("blocked 에이전트에 **한 탭으로 y**") is this file: a fixed set of
// answers to an agent's confirmation prompt. It is ~40 lines of table, not a store, so the honest
// port grade for that row is **drop + new**, and the deviation is reported rather than papered over.
//
// The one thing taken from orca's file is a shape decision it makes explicitly — `appendEnter`
// (`quick-commands.ts:67-84`, "insert" vs "run"). Some prompts submit on the bare key and some want
// a newline, so each command below says which it is.
import type { PaneInputChunk } from './pane-input'

export type PaneQuickCommand = {
  id: string
  /** What the button says. Short: the row is one line on a phone. */
  label: string
  accessibilityLabel: string
  /** The `keys[]` this sends, in order. */
  keys: readonly string[]
}

/**
 * Answers, as **keys** rather than text — the whole reason M3 can be one tap.
 *
 * `text` would be wrong here, and measurably so: `encode_api_text`
 * (`src/app/api_helpers.rs:24-33`) wraps text in `ESC [ 200 ~` … `ESC [ 201 ~` whenever the pane has
 * bracketed paste on, which every agent TUI that reads a prompt does. A one-character *paste* is not
 * a keypress, and a prompt that reads keys would swallow it or take the brackets literally.
 * `keys[]` goes the other way — `parse_key_combo` -> the pane's own key encoder
 * (`src/app/api_helpers.rs:36-48`) — so `y` arrives as the byte `y`, and `Enter` arrives as whatever
 * that pane negotiated.
 *
 * Kept deliberately small. This is the confirmation vocabulary of the agents herdr detects, not a
 * command palette; anything longer belongs in the text field next to the row.
 */
export const PANE_QUICK_COMMANDS: readonly PaneQuickCommand[] = [
  // The M3 headline. `y` alone, because Claude Code / Codex confirmation prompts act on the
  // keystroke; `y↵` below is the variant for prompts that read a line.
  { id: 'yes', label: 'y', accessibilityLabel: 'Answer yes', keys: ['y'] },
  { id: 'no', label: 'n', accessibilityLabel: 'Answer no', keys: ['n'] },
  {
    id: 'yesEnter',
    label: 'y↵',
    accessibilityLabel: 'Answer yes and submit',
    keys: ['y', 'enter']
  },
  // Selection-list prompts ("1. yes  2. no  3. …") default to the highlighted row, so a bare Enter
  // is the accept. It is also the submit for an answer typed in the field.
  { id: 'accept', label: '↵', accessibilityLabel: 'Accept', keys: ['enter'] },
  // The universal back-out. `esc` and not `ctrl+c`: on an agent prompt Esc cancels the *prompt*,
  // while Ctrl-C interrupts the agent — the accessory row carries Ctrl-C separately, labelled as
  // the interrupt orca calls it.
  { id: 'cancel', label: 'esc', accessibilityLabel: 'Cancel prompt', keys: ['esc'] }
]

/** The `pane.send_input` payload for a quick command. */
export function quickCommandChunk(command: PaneQuickCommand): PaneInputChunk {
  return { text: '', keys: command.keys }
}

export function findQuickCommand(id: string): PaneQuickCommand | null {
  return PANE_QUICK_COMMANDS.find((command) => command.id === id) ?? null
}
