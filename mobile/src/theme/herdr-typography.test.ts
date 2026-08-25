// This file exists because seven mockup-conformance QA rounds passed while every iOS screen
// rendered in the system sans-serif. The value under test was the string `'monospace'` — an Android
// generic family name, which iOS has no entry for — so Android *looked* right and iOS did not, and
// a screenshot-based reviewer on Android could not tell. A unit test can.
import { describe, expect, it } from 'vitest'
import { typography } from './herdr-typography'
import { typography as orcaTypography } from './mobile-theme'

describe('herdr typography', () => {
  it('names a real face, not a platform generic', () => {
    // `'monospace'`/`'sans-serif'`/`'serif'` are Android generics: on iOS they resolve to nothing
    // and React Native silently falls back to San Francisco.
    expect(['monospace', 'sans-serif', 'serif']).not.toContain(typography.monoFamily)
    expect(typography.monoFamily).toMatch(/^JetBrainsMono_/)
  })

  it('gives bold its own face, because Android does not synthesise weight for custom families', () => {
    expect(typography.monoFamilyBold).toMatch(/^JetBrainsMono_/)
    expect(typography.monoFamilyBold).not.toBe(typography.monoFamily)
  })

  it("leaves the rest of orca's scale untouched", () => {
    // The point of the shim is to override one value, not to fork the type scale.
    const { monoFamily: _dropped, ...orcaRest } = orcaTypography
    for (const key of Object.keys(orcaRest) as (keyof typeof orcaRest)[]) {
      expect(typography[key]).toEqual(orcaRest[key])
    }
  })
})
