// Not from orca. `./monotone-discipline.test.tsx` is the precedent — a rule about the whole app
// stated once, where something enforces it — but that one renders components to inspect colour,
// and this one cannot: the defect it guards is a *non-effect*. React Native does not synthesise a
// weight for a custom font family on Android, so `fontWeight: '700'` next to
// `fontFamily: 'JetBrainsMono_400Regular'` is silently dropped and the text falls back to the
// system sans-serif (Roboto) at that node. A render test sees the style object it was given and
// reports success; only the device shows two typefaces in one frame.
//
// That is exactly how the 8차 Android UI QA round found five of them (`AgentRow`'s identity
// emphasis, `app/index.tsx`'s section label, `BottomNav`'s active tab, the remote screen's tab
// header, `RemoteEditor`'s selected segment) after fd42c472 had loaded JetBrains Mono and swept
// what looked like every call site: the survivors were the ones where the weight and the family
// live in *different* style objects, composed by a `style={[base, on && emphasis]}` array. No
// object-shaped search can see those pairs, so the rule this file enforces is the flat one — a
// weight is never a style property here, it is the name of a face (`./herdr-typography.ts`).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { typography } from './herdr-typography'

const MOBILE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Everything the app renders: `app/` is expo-router's screens, `src/` is everything they mount. */
const SCANNED_DIRS = ['app', 'src']

/**
 * The rule is about React Native styles, and these files are not that — three of them are the
 * xterm WebView's own document (a real browser, where `fontWeight` is CSS), one is the test that
 * pins those strings, and one is this file, which has to name the property to look for it. Listed
 * explicitly, and checked below to still carry a `fontWeight`, so an exception cannot outlive its
 * reason.
 *
 * The exception used to rest on "and synthesis works there". It does not any more, and the 12차 iOS
 * round is why: that document was rendering in the WebView's own monospace stack, so it now embeds
 * JetBrains Mono itself (`../terminal/terminal-webview-font-injected.ts`) — and an embedded family
 * synthesises no weight either, exactly like a custom family on Android. What earns the exception
 * instead is that the document declares one `@font-face` per weight *range*, so every number these
 * files ask for lands on a face that is really there. Same rule as the rest of the app — a weight
 * is a face, not a wish — written in the one dialect where CSS is allowed to say it.
 */
const ALLOWED = [
  'src/terminal/terminal-webview-engine.generated.ts',
  'src/terminal/terminal-webview-html.ts',
  'src/terminal/terminal-webview-painted-cell-injected.ts',
  'src/terminal/terminal-webview-text-zoom.test.ts',
  'src/theme/typography-discipline.test.ts'
]

/** Prose may say the word — `./herdr-typography.ts` explains the very defect in its header. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/

function sourceFilesIn(dir: string): string[] {
  return readdirSync(join(MOBILE_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      return sourceFilesIn(path)
    }
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function weightSitesIn(path: string): string[] {
  return readFileSync(join(MOBILE_ROOT, path), 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      !COMMENT_LINE.test(line) && line.includes('fontWeight') ? [`${path}:${index + 1}`] : []
    )
}

const SCANNED = SCANNED_DIRS.flatMap(sourceFilesIn).filter((path) => !ALLOWED.includes(path))

/** `[token, family]` for every face `./herdr-typography.ts` adds on top of orca's tokens. */
const FACE_TOKENS: Array<[string, string]> = Object.entries(typography)
  .filter(([, value]) => typeof value === 'string' && value.startsWith('JetBrainsMono_'))
  .map(([token, value]): [string, string] => [token, String(value)])

describe('weights are faces, not style properties', () => {
  it('scans the whole app, so a new screen is covered by existing', () => {
    expect(SCANNED.length).toBeGreaterThan(100)
  })

  it('finds no fontWeight in any React Native style', () => {
    expect(SCANNED.flatMap(weightSitesIn)).toEqual([])
  })

  it('keeps every exception earning its place', () => {
    for (const path of ALLOWED) {
      expect(weightSitesIn(path).length, `${path} no longer needs an exception`).toBeGreaterThan(0)
    }
  })

  // The other half of the same defect: a face named by a token but never registered by
  // `expo-font` resolves to nothing, and React Native falls back to the system sans-serif exactly
  // as an unsynthesised weight does — same symptom on screen, one directory away.
  it.each(FACE_TOKENS)('typography.%s names a face the root layout loads', (_token, face) => {
    expect(readFileSync(join(MOBILE_ROOT, 'app/_layout.tsx'), 'utf8')).toContain(face)
  })
})
