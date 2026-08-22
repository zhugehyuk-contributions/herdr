// Not from orca. orca's `mobile-theme.ts` (ported verbatim next to this file) is a *hued* palette:
// `statusGreen` / `statusAmber` / `statusRed` / `accentBlue` / eight syntax colours. herdr's mobile
// mockup fixes a different contract — a single grayscale ramp where emphasis is brightness and the
// top emphasis level is inversion (a ring instead of a fill):
//
//   mobile/.prd/assets/mockup.html:5-16   the ramp (`--ink` … `--fg`), "the only 'color'"
//   mobile/.prd/assets/mockup.html:162-166 the state dots: ok / working / blocked(ring) / off
//   mobile/.prd/assets/mockup.html:863    "palette/type: monotone — #101010 grayscale ramp ·
//                                          emphasis by inversion · JetBrains Mono"
//
// The two palettes coexist on purpose: `mobile-theme.ts` stays byte-identical to orca so the ~1,700
// lines of ported modal/drawer chrome keep compiling unmodified, and only the surfaces where colour
// *is* the meaning (StatusDot, AgentStateDot) read from this file. Anything new should read here.
//
// Caveat recorded rather than papered over: mockup.html is the artefact `01-spec.md` marks as
// "목업 화면 설계는 아직 오너 검증 전이다" (01-spec.md:60). The ramp is treated as the design SSOT
// because nothing else in .prd states a palette; if the owner rejects the mockup this file is the
// one place that changes.

/** The grayscale ramp, brightest first. Brightness is emphasis. */
export const mono = {
  /** Drafting-table background, behind the screen surface. */
  bg: '#0a0a0a',
  /** Screen background. */
  ink: '#101010',
  ink2: '#161616',
  ink3: '#1d1d1d',
  line: '#282828',
  lineSoft: '#1f1f1f',
  /** Warm-biased white — the top of the ramp, and the mockup's "only color". */
  fg: '#f0efec',
  fgSoft: '#b3b2ae',
  dim: '#7d7d7a',
  dim2: '#575755',
  off: '#3f3f3d'
} as const

/** Dot geometry from mockup.html:162-166. `blocked` is the inverted (ring) form. */
export const dotMetrics = {
  size: 7,
  /** The ring reads as a hole, so it is drawn one point larger to keep the optical mass equal. */
  ringSize: 8,
  ringWidth: 2
} as const
