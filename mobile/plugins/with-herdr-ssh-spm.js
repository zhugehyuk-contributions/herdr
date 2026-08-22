// Not from orca. Adds the Swift Package Manager dependencies the `herdr-ssh` local module needs to
// the generated iOS project.
//
// ⚠️ UNVERIFIED: `expo prebuild` has never been run against this plugin. It has not produced a
// project.pbxproj, and CocoaPods/Xcode have not read one it produced.
//
// ## Why a plugin, and not a `s.dependency` in the podspec
//
// There is no maintained ssh client on CocoaPods. Measured 2026-08-22 against trunk: `NMSSH` last
// published 2.3.1 on 2018-07-29, and the only `libssh2` pod is 1.4.3 from 2014-05-19. Both vendor a
// crypto stack from before 2019 — in the app that holds the user's ssh key.
//
// The maintained implementations are SPM-only: `apple/swift-nio-ssh` (Apache-2.0, 0.15.0 on
// 2026-07-28) and `orlandos-nl/Citadel` (MIT, 0.12.1, built on top of it). A CocoaPods podspec
// cannot declare an SPM dependency, and `expo-modules-autolinking`'s Apple config accepts only
// `podspecPath` (node_modules/expo-modules-autolinking/build/types.d.ts:136-171), so the package has
// to be attached to the Xcode project directly.
//
// ## Why it writes raw pbxproj objects
//
// `xcode@3.0.1` — the parser `@expo/config-plugins` uses — has no API for
// `XCRemoteSwiftPackageReference` (grepped: the identifier appears nowhere in `lib/`). Its *writer*
// is generic, though: `pbxWriter.writeObjectsSections` (xcode/lib/pbxWriter.js:180-196) iterates
// every key of `objects` and serializes whatever it finds, so a section it has no model for still
// round-trips. That is the seam this plugin uses, and it is also why this file is the most fragile
// thing in the module: it depends on a writer's generality rather than on an API.
const { withXcodeProject } = require('expo/config-plugins')

/**
 * Pinned to a minor range, NOT to an exact version: the requirement emitted below is
 * `upToNextMinorVersion` from 0.12.1, i.e. `0.12.1 ..< 0.13.0`, so Citadel patch releases are
 * picked up without a decision here. That is deliberate — patch releases of an ssh stack are
 * usually the security fixes you want — but it is a range, and the rationale cuts both ways: a
 * floating ssh dependency in a mobile release is a crypto stack that changes without anyone
 * deciding to change it. `upToNextMinorVersion` is the widest rule that still keeps the
 * major/minor pair a human chose; if this app ever needs a reproducible crypto stack per release,
 * switch `kind` to `exactVersion` and take the update cost explicitly.
 *
 * (Corrected 2026-08-22: this comment previously opened with "Pinned exactly, not by range",
 * which contradicted the `kind` two dozen lines below. Verified live the same day: Citadel 0.12.1
 * and swift-nio-ssh 0.15.0 tags both exist; sshj 0.40.0, eddsa 0.3.0 and slf4j-nop 2.0.16 all
 * resolve on Maven Central. None of this module has been compiled — see ios/HerdrSsh.podspec.)
 */
const PACKAGES = [
  {
    name: 'Citadel',
    url: 'https://github.com/orlandos-nl/Citadel.git',
    minimumVersion: '0.12.1',
    products: ['Citadel']
  }
]

/** Deterministic 24-hex uuid, so re-running prebuild does not churn the project file. */
function stableId(seed) {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).toUpperCase().padStart(8, '0').repeat(3).slice(0, 24)
}

module.exports = function withHerdrSshSpm(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults
    const objects = project.hash.project.objects
    const rootId = project.getFirstProject().uuid
    const rootObject = project.getFirstProject().firstProject

    objects['XCRemoteSwiftPackageReference'] ??= {}
    objects['XCSwiftPackageProductDependency'] ??= {}
    rootObject.packageReferences ??= []

    for (const pkg of PACKAGES) {
      const referenceId = stableId(`ref:${pkg.url}`)
      if (objects['XCRemoteSwiftPackageReference'][referenceId]) {
        continue
      }
      objects['XCRemoteSwiftPackageReference'][referenceId] = {
        isa: 'XCRemoteSwiftPackageReference',
        repositoryURL: `"${pkg.url}"`,
        requirement: {
          kind: 'upToNextMinorVersion',
          minimumVersion: pkg.minimumVersion
        }
      }
      objects['XCRemoteSwiftPackageReference'][`${referenceId}_comment`] =
        `XCRemoteSwiftPackageReference "${pkg.name}"`
      rootObject.packageReferences.push({
        value: referenceId,
        comment: `XCRemoteSwiftPackageReference "${pkg.name}"`
      })

      for (const product of pkg.products) {
        const productId = stableId(`product:${pkg.url}:${product}`)
        objects['XCSwiftPackageProductDependency'][productId] = {
          isa: 'XCSwiftPackageProductDependency',
          package: referenceId,
          productName: product
        }
        objects['XCSwiftPackageProductDependency'][`${productId}_comment`] = product
      }
    }

    // `rootId` is read only so that a future reviewer can see which project object was mutated;
    // `firstProject` above is that object's body.
    void rootId
    return cfg
  })
}
