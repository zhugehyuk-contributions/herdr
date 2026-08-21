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

config.resolver = {
  ...config.resolver,
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
