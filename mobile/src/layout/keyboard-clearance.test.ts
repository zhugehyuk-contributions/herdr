// The properties `keyboardBarLift` exists to hold, written as the case .prd/09-review-followups.md
// §BB measured. The mount-level proof that the bar actually moves — and that the terminal does not —
// is `../app-shell/keyboard-lift-mount.test.tsx`; this file is why the arithmetic is not a guess.
import { describe, expect, it } from 'vitest'
import { keyboardBarLift } from './keyboard-clearance'

/** iPhone 17 Pro portrait: home indicator 34pt, and a letters+QuickType keyboard over it. */
const HOME_INDICATOR = 34
const KEYBOARD = 336

describe('keyboardBarLift', () => {
  it('lifts the bar by exactly what the keyboard covers that the inset did not', () => {
    // The §BB defect: `↵` at y=796..834 in an 874pt window, keyboard top around y=538. The bar is
    // already padded by the inset, so the shift owed is the rest of the keyboard.
    expect(keyboardBarLift(KEYBOARD, HOME_INDICATOR)).toBe(302)
    // Stated as the property rather than the number: padding + lift = the whole keyboard, i.e. the
    // bar's bottom edge sits exactly on the keyboard's top edge.
    expect(HOME_INDICATOR + keyboardBarLift(KEYBOARD, HOME_INDICATOR)).toBe(KEYBOARD)
  })

  it('does not stack the inset onto the keyboard the way orca stacks spacing', () => {
    // §D1's divergence, restated at the other edge: iOS measures the keyboard frame from the
    // window's bottom, so it *contains* the home-indicator strip. `inset + height` would leave the
    // bar floating 34pt above the keyboard for the whole session.
    expect(keyboardBarLift(KEYBOARD, HOME_INDICATOR)).not.toBe(KEYBOARD + HOME_INDICATOR)
    expect(keyboardBarLift(KEYBOARD, HOME_INDICATOR)).toBeLessThan(KEYBOARD)
  })

  it('is zero whenever the keyboard is down — no permanent offset', () => {
    // §BB requirement 2. A bar that stays lifted after dismissal is a worse defect than the one
    // being fixed: it covers the terminal with nothing in front of it to explain why.
    expect(keyboardBarLift(0, HOME_INDICATOR)).toBe(0)
    expect(keyboardBarLift(0, 0)).toBe(0)
  })

  it('never returns a negative shift, whatever the platform reports', () => {
    // A keyboard shorter than the inset (an accessory bar over a hardware keyboard) would otherwise
    // push the bar *down*, off the bottom of the window.
    expect(keyboardBarLift(20, HOME_INDICATOR)).toBe(0)
    expect(keyboardBarLift(-1, HOME_INDICATOR)).toBe(0)
    expect(keyboardBarLift(Number.NaN, HOME_INDICATOR)).toBe(0)
    expect(keyboardBarLift(KEYBOARD, Number.NaN)).toBe(KEYBOARD)
  })

  it('lifts by the whole keyboard where there is no inset to spend', () => {
    // Android's edge-to-edge navigation bar is 48 and the window resizes anyway (the hook never
    // calls this there); this is the iPhone SE shape — no home indicator, bottom inset 0.
    expect(keyboardBarLift(KEYBOARD, 0)).toBe(KEYBOARD)
  })
})
