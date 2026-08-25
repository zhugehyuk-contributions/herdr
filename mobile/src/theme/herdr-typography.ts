// The mockup's one non-negotiable typographic fact: JetBrains Mono, everywhere
// (`.prd/assets/mockup.html:14` declares the stack, `:863` states it as the palette/type contract).
//
// Why this file exists instead of an edit to `mobile-theme.ts`: that file is orca's, kept
// byte-identical so the ~1,700 lines of ported modal/drawer chrome keep compiling unmodified
// (see `monotone.ts`'s header for the same argument about the palette). orca's `typography.monoFamily`
// is the string `'monospace'`, which is an **Android generic family name**. iOS has no such family,
// so React Native fell back to the system sans-serif and every iOS screen rendered in SF Pro —
// measured 2026-08-25 on the QA screenshots. Android passed seven mockup-conformance rounds by
// accident, because there `'monospace'` resolves to Roboto Mono and *looks* right.
//
// Custom families do not synthesise weight on Android: `fontWeight: '700'` on a regular face is
// ignored, so bold has to name its own file. That is why `monoFamilyBold` exists and why the call
// sites that used to pair `monoFamily` with `fontWeight: '700'` name the bold family instead.
import { typography as orcaTypography } from './mobile-theme'

/** Family names as `expo-font` registers them; see `app/_layout.tsx` for the load. */
export const typography = {
  ...orcaTypography,
  monoFamily: 'JetBrainsMono_400Regular' as const,
  monoFamilyBold: 'JetBrainsMono_700Bold' as const
}
