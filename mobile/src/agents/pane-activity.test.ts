// Not from orca. `.prd/11-mockup-conformance.md` 누락 #13: the mockup draws a second line under
// every pane row (`mockup.html:535` — `└ Running cargo nextest… · 2m41s`) and names its source in
// the acceptance sentence (`:555`). The implementation shipped without it for eight milestones,
// which left the pane list as names plus one state word — you cannot tell from it which pane to
// open, so you open them one at a time.
//
// What is tested here is the *rule*, not the layout: which field becomes the line, and when the
// line is suppressed. The suppression is the load-bearing half — `agentIdentityLabel` falls
// through to the terminal title exactly when there is no agent name, so a naive implementation
// prints the same string twice on precisely the rows that have the least to say.
import { describe, expect, it } from 'vitest'
import { agentIdentityLabel, paneActivityLabel } from './agent-display'

const WORKING = { agent_status: 'working' } as const

describe('paneActivityLabel', () => {
  it('reports the running command when the row is already named by its agent', () => {
    const pane = { ...WORKING, agent: 'claude', terminal_title_stripped: 'cargo nextest run' }
    expect(agentIdentityLabel(pane)).toBe('claude')
    expect(paneActivityLabel(pane)).toBe('cargo nextest run')
  })

  it('says nothing when the terminal title is what the row above already says', () => {
    // No agent name, so the identity chain reaches `terminal_title_stripped` itself. Printing it
    // again below would be a row that repeats itself.
    const pane = { ...WORKING, terminal_title_stripped: 'zsh' }
    expect(agentIdentityLabel(pane)).toBe('zsh')
    expect(paneActivityLabel(pane)).toBeNull()
  })

  it('falls back to the unstripped title, and to nothing at all', () => {
    expect(paneActivityLabel({ ...WORKING, agent: 'codex', title: 'pytest -q' })).toBe('pytest -q')
    expect(paneActivityLabel({ ...WORKING, agent: 'codex' })).toBeNull()
  })

  it('ignores whitespace-only titles rather than rendering a blank line', () => {
    expect(
      paneActivityLabel({ ...WORKING, agent: 'claude', terminal_title_stripped: '   ' })
    ).toBeNull()
  })

  it('does not invent an elapsed time', () => {
    // The mockup's line ends `· 2m41s`. herdr's wire carries no timestamp at all
    // (`agent-display.ts` header, 누락 #16) — inventing a clock would be worse than not having one,
    // so the line is the activity and stops there.
    const line = paneActivityLabel({ ...WORKING, agent: 'claude', terminal_title_stripped: 'make' })
    expect(line).toBe('make')
    expect(line).not.toMatch(/\d+[ms]/)
  })
})
