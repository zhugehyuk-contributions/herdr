// Rewritten for herdr; the orca original (mobile/metro.config.js @ 4fd93ead, MIT / Lovecast Inc.)
// is the shape but not the content — see mobile/THIRD_PARTY_NOTICES.md.
//
// orca added the repo-root directory `src/shared` to `watchFolders` so that 293 files under
// `mobile/` could reach desktop TypeScript by relative path (`../../../src/shared/*`). herdr has no
// such directory and must not grow one: the shared TS here is a *package*,
// `packages/herdr-client-ts` (mobile/.prd/02-architecture.md §2.5), imported by name.
//
// A package needs both halves. `watchFolders` alone only tells Metro to watch the files; module
// resolution still starts from mobile/node_modules and would miss `@herdr/client-ts`, so
// `extraNodeModules` maps the specifier onto the package root. (The relative-path form orca used
// needs no resolver entry, which is why the original has only the one line.)
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const repoRoot = path.resolve(projectRoot, '..')
const clientTsRoot = path.resolve(repoRoot, 'packages', 'herdr-client-ts')

const config = getDefaultConfig(projectRoot)

config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), clientTsRoot]))

// Why this exists at all — measured, not anticipated. `npx expo export` (mobile `bundle`/`bundle:*`)
// failed on the *first* module of the package:
//
//     Unable to resolve module ./constants.js from packages/herdr-client-ts/src/index.ts
//     None of these files exist: .../src/constants.js(.ios.ts|.native.ts|.ts|…)
//
// `@herdr/client-ts` is `"type": "module"` and ships **TypeScript source** as its entry
// (`package.json` `exports: {".": "./src/index.ts"}`), so every relative import inside it is written
// in TypeScript's NodeNext form: the specifier names the *emitted* file (`./constants.js`) while the
// file on disk is `./constants.ts`. tsc and Vite/Vitest both perform that rewrite, which is why the
// 160-test package suite and mobile's own unit suite never saw this. Metro does not: it appends its
// `sourceExts` to the specifier as written, so it looks for `constants.js.ts`, `constants.js.tsx`, …
// and never for `constants.ts`.
//
// The rewrite is scoped to origins inside `clientTsRoot` on purpose. Doing it globally would change
// how every `node_modules` package resolves, and a real `foo.js` sitting next to a `foo.ts` would
// start resolving to the wrong one; inside this package the two never coexist. The fallback is
// ordered `.ts` first, then the untouched specifier, so a genuine `.js` file in the package (there
// are none today) still resolves rather than erroring.
const upstreamResolveRequest = config.resolver.resolveRequest
const clientTsPrefix = clientTsRoot + path.sep

config.resolver = {
  ...config.resolver,
  resolveRequest: (context, moduleName, platform) => {
    const fallback =
      typeof upstreamResolveRequest === 'function' ? upstreamResolveRequest : context.resolveRequest
    const fromClientTs =
      typeof context.originModulePath === 'string' &&
      context.originModulePath.startsWith(clientTsPrefix)
    if (fromClientTs && moduleName.startsWith('.') && moduleName.endsWith('.js')) {
      try {
        return fallback(context, `${moduleName.slice(0, -3)}.ts`, platform)
      } catch {
        // Not a TypeScript-emitted specifier after all — fall through to the name as written.
      }
    }
    return fallback(context, moduleName, platform)
  },
  extraNodeModules: {
    ...config.resolver.extraNodeModules,
    '@herdr/client-ts': clientTsRoot
  },
  // Why: `@herdr/client-ts/node` is the ssh2/Node entry point. It exists for the desktop test
  // harness only; pulling it into a Hermes bundle would fail at require time on `node:*` builtins.
  blockList: [
    ...(Array.isArray(config.resolver.blockList)
      ? config.resolver.blockList
      : config.resolver.blockList
        ? [config.resolver.blockList]
        : []),
    new RegExp(`^${clientTsRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/src/node/.*`)
  ]
}

module.exports = config
