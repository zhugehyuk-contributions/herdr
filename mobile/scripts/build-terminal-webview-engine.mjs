// Ported from orca mobile/scripts/build-terminal-webview-engine.mjs
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as esbuild from 'esbuild'

const require = createRequire(import.meta.url)
const scriptDir = import.meta.dirname
const mobileRoot = path.resolve(scriptDir, '..')
const outputPath = path.join(mobileRoot, 'src', 'terminal', 'terminal-webview-engine.generated.ts')
const fontOutputPath = path.join(
  mobileRoot,
  'src',
  'terminal',
  'terminal-webview-font.generated.ts'
)
const target = 'chrome74'

const packages = ['@xterm/xterm', '@xterm/addon-unicode11', '@xterm/addon-webgl']

// Not from orca. `expo-font` registers a face with the *native* text system, and a WKWebView /
// Android WebView document is a different font universe — the 12차 iOS QA round measured the
// terminal still painting the WebView's own monospace stack while every React Native screen around
// it was JetBrains Mono (`.prd/09-review-followups.md` §WW). A WebView document can only be given a
// face by the document itself, and it cannot fetch one: the terminal HTML is a `source={{ html }}`
// string with no origin and no network (`terminal-webview-engine.test.ts` bans `http(s)://` in it
// outright). So the face is inlined here as a base64 `data:` URI, from the same pinned
// `@expo-google-fonts/jetbrains-mono` the native side already ships — no new dependency, one
// version of the typeface across both halves of the app.
//
// Two faces, not four: the WebView asks for exactly two weights (see
// `terminal-webview-font-injected.ts`), and each embedded face costs ~150 KB of bundle.
const fontPackage = '@expo-google-fonts/jetbrains-mono'
const fontFaces = [
  { constant: 'JETBRAINS_MONO_REGULAR_DATA_URL', file: '400Regular/JetBrainsMono_400Regular.ttf' },
  { constant: 'JETBRAINS_MONO_BOLD_DATA_URL', file: '700Bold/JetBrainsMono_700Bold.ttf' }
]

async function readPackageVersion(packageName) {
  // Why: a package.json module specifier must use '/' — path.join emits '\' on
  // Windows, yielding an unresolvable bare specifier that fails postinstall there.
  const packageJsonPath = require.resolve(`${packageName}/package.json`)
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  return `${packageName}@${packageJson.version}`
}

function htmlText(value, closingTag) {
  return value.replace(new RegExp(`</${closingTag}`, 'gi'), `<\\/${closingTag}`)
}

async function buildEngineJs() {
  const result = await esbuild.build({
    stdin: {
      contents: `
        import { Terminal } from '@xterm/xterm'
        import { Unicode11Addon } from '@xterm/addon-unicode11'
        import { WebglAddon } from '@xterm/addon-webgl'

        // Why: xterm reaches for these runtime APIs on the terminal-bringup path,
        // and esbuild lowers syntax but not runtime APIs. Guarded shims let the
        // chrome74-syntax bundle actually run on old WebViews (the #7030 goal)
        // instead of throwing at construction and only surfacing the error overlay.

        // WeakRef (Chrome 84+): lazily constructed in window-tracking paths.
        // Strong retention is fine for a single-document terminal WebView.
        if (typeof window.WeakRef === 'undefined') {
          window.WeakRef = function WeakRefShim(target) { this.__target = target }
          window.WeakRef.prototype.deref = function () { return this.__target }
        }

        // structuredClone (Chrome 98+): xterm clones its plain-data DEC-mode default
        // objects at Terminal construction; a JSON round-trip clones those correctly
        // (any undefined-valued keys drop, but every reader treats absent == undefined).
        if (typeof window.structuredClone === 'undefined') {
          window.structuredClone = function (value) { return JSON.parse(JSON.stringify(value)) }
        }

        // Element.prototype.replaceChildren (Chrome 86+): used on the row/selection
        // render path; polyfill via remove-all + append (Chrome 54+, under the floor).
        if (typeof Element !== 'undefined' && !Element.prototype.replaceChildren) {
          Element.prototype.replaceChildren = function () {
            while (this.firstChild) this.removeChild(this.firstChild)
            this.append.apply(this, arguments)
          }
        }

        window.Terminal = Terminal
        window.Unicode11Addon = { Unicode11Addon }
        window.WebglAddon = { WebglAddon }
      `,
      resolveDir: mobileRoot,
      sourcefile: 'terminal-webview-engine-entry.js'
    },
    bundle: true,
    format: 'iife',
    minify: true,
    platform: 'browser',
    target,
    legalComments: 'none',
    write: false,
    logLevel: 'silent'
  })

  return result.outputFiles[0].text
}

async function buildFontModule() {
  const packageJsonPath = require.resolve(`${fontPackage}/package.json`)
  const packageRoot = path.dirname(packageJsonPath)
  const version = JSON.parse(await readFile(packageJsonPath, 'utf8')).version
  const faces = await Promise.all(
    fontFaces.map(async ({ constant, file }) => {
      const ttf = await readFile(path.join(packageRoot, ...file.split('/')))
      // Why `font/ttf` and not `application/octet-stream`: WebKit refuses a font whose data URL
      // carries no font MIME on some iOS builds, and the format() hint alone does not rescue it.
      return `export const ${constant} = ${JSON.stringify(`data:font/ttf;base64,${ttf.toString('base64')}`)}`
    })
  )
  return [
    '// Generated by scripts/build-terminal-webview-engine.mjs.',
    `// Faces: ${fontPackage}@${version} — ${fontFaces.map(({ file }) => path.basename(file)).join(', ')}.`,
    '// Do not edit by hand; regenerate via pnpm postinstall.',
    ...faces,
    ''
  ].join('\n')
}

async function main() {
  const [engineJs, rawEngineCss, ...versions] = await Promise.all([
    buildEngineJs(),
    readFile(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8'),
    ...packages.map(readPackageVersion)
  ])
  // Why: the no-external-URL regression gate bans http(s):// anywhere in the
  // terminal document. These xmlns URIs live inside data: URLs (never fetched);
  // percent-encoding the scheme colon satisfies the gate and URI-decodes back
  // before the SVG is parsed.
  const engineCss = rawEngineCss
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/http:\/\/www\.w3\.org\/2000\/svg/g, 'http%3A//www.w3.org/2000/svg')

  const source = [
    '// Generated by scripts/build-terminal-webview-engine.mjs.',
    `// Packages: ${versions.join(', ')}.`,
    `// Target: ${target}. Do not edit by hand; regenerate via pnpm postinstall.`,
    `export const XTERM_ENGINE_JS = ${JSON.stringify(htmlText(engineJs, 'script'))}`,
    `export const XTERM_ENGINE_CSS = ${JSON.stringify(htmlText(engineCss, 'style'))}`,
    ''
  ].join('\n')

  await writeFile(outputPath, source)
  await writeFile(fontOutputPath, await buildFontModule())
}

await main()
