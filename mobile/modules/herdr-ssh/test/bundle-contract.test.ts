// Not from orca. `packages/herdr-client-ts/test/hermesContract.test.ts` applied to `mobile/modules/`.
//
// That test exists because `tsconfig`'s `types: []` does not catch a value-only `import "node:net"`,
// and because a Metro bundle failure is discovered on a device, days later. This module has the same
// exposure plus one more of its own: it is the *only* code under `mobile/` that touches
// `expo-modules-core`, and that package re-exports `react-native` — Flow source, which the test
// runner cannot parse. A static import of it anywhere in this module's graph would take out
// `app/_layout.tsx` and with it `src/app-shell/route-shell-mount.test.tsx` and
// `src/app-shell/agents-home-mount.test.tsx`, which mount that file.
//
// So the walker below checks two things at once: nothing Node-shaped is reachable from the module
// entry (the Hermes half), and the two expo packages are reachable only through a dynamic
// `import()` (the test-environment half).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MODULE_ROOT = resolve(import.meta.dirname, '..')

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'dns',
  'events',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'timers',
  'tls',
  'url',
  'util',
  'worker_threads',
  'zlib'
])

/** Specifiers reached by a *static* import — the ones that load when the module loads. */
function staticSpecifiers(source: string): string[] {
  const found: string[] = []
  for (const pattern of [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g]) {
    for (const match of source.matchAll(pattern)) {
      found.push(match[1] as string)
    }
  }
  return found
}

function dynamicSpecifiers(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    found.push(match[1] as string)
  }
  return found
}

/** `moduleResolution: bundler` — a bare relative specifier resolves to `.ts`, then `/index.ts`. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate
      }
    } catch {
      // Not this shape; try the next.
    }
  }
  return null
}

interface Reach {
  files: string[]
  bare: Array<{ specifier: string; importer: string }>
}

function reachableFrom(entry: string): Reach {
  const seen = new Set<string>()
  const bare: Array<{ specifier: string; importer: string }> = []
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const specifier of staticSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(file, specifier)
        if (resolved !== null) {
          queue.push(resolved)
        }
      } else {
        bare.push({ specifier, importer: file })
      }
    }
  }
  return { files: [...seen], bare }
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full))
    } else if (full.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

const relative = (file: string): string => file.replace(`${MODULE_ROOT}/`, '')

describe('herdr-ssh bundle contract', () => {
  const reach = reachableFrom(join(MODULE_ROOT, 'index.ts'))

  it('walks a real graph (the checks below are not vacuous)', () => {
    expect(reach.files.length).toBeGreaterThan(4)
    expect(reach.files.map(relative)).toContain('src/ssh-transport.ts')
    expect(reach.files.map(relative)).toContain('src/native-module.ts')
  })

  it('imports no Node built-in', () => {
    const builtins = reach.bare.filter(
      ({ specifier }) => specifier.startsWith('node:') || NODE_BUILTINS.has(specifier)
    )
    expect(
      builtins.map(({ specifier, importer }) => `${relative(importer)} -> ${specifier}`)
    ).toEqual([])
  })

  it('never reaches the ssh2 entry point that metro.config.js blocks', () => {
    const leaked = reach.bare.filter(
      ({ specifier }) => specifier === 'ssh2' || specifier.startsWith('@herdr/client-ts/node')
    )
    expect(
      leaked.map(({ specifier, importer }) => `${relative(importer)} -> ${specifier}`)
    ).toEqual([])
  })

  it('static imports are confined to the packages a Hermes bundle already carries', () => {
    const allowed = new Set(['@herdr/client-ts', 'react', 'zod'])
    const unexpected = reach.bare.filter(({ specifier }) => !allowed.has(specifier))
    expect(
      unexpected.map(({ specifier, importer }) => `${relative(importer)} -> ${specifier}`)
    ).toEqual([])
  })

  it('reaches expo-modules-core and expo-constants only through a dynamic import', () => {
    const deferred = new Set(['expo-modules-core', 'expo-constants'])
    const offenders: string[] = []
    const dynamic: string[] = []
    for (const file of tsFilesUnder(MODULE_ROOT)) {
      const source = readFileSync(file, 'utf8')
      for (const specifier of staticSpecifiers(source)) {
        if (deferred.has(specifier)) {
          offenders.push(`${relative(file)} -> ${specifier}`)
        }
      }
      for (const specifier of dynamicSpecifiers(source)) {
        if (deferred.has(specifier)) {
          dynamic.push(`${relative(file)} -> ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
    // Both are still actually used — otherwise this test would pass by the module doing nothing.
    expect(dynamic.sort()).toEqual([
      'src/app-connections.ts -> expo-constants',
      'src/native-module.ts -> expo-modules-core'
    ])
  })
})
