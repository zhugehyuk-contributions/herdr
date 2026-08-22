// Not from orca. Adds the Swift Package Manager dependencies the `herdr-ssh` local module needs to
// the generated iOS project.
//
// ## What this plugin is measured to do, and what it is NOT (first prebuild, 2026-08-23)
//
// Verified: `expo prebuild --platform ios` runs it, the objects below survive into
// `ios/herdr.xcodeproj/project.pbxproj`, and **Xcode accepts them** — `kind = exactVersion` and
// `kind = revision` both resolve, producing `ios/herdr.xcworkspace/xcshareddata/swiftpm/Package.resolved`
// with Citadel at `ae8562f8…` (0.12.1) and swift-nio-ssh pinned to a bare revision `a05e6bb…`
// (no `version` field — Citadel's own `0.3.4 ..< 0.4.0` range is overridden from the root).
//
// NOT verified, because it is false: this plugin alone does not make `import Citadel` compile. The
// module's Swift is compiled in the **Pods** project, which never sees the app project's package
// reference — first build failed with
// `HerdrSshModule.swift:22:8: error: unable to resolve module dependency: 'Citadel'`. The
// XCSwiftPackageProductDependency written below does not even survive: `pod install` re-saves the
// app project through Xcodeproj, which drops objects no target references (measured: present after
// `prebuild --no-install`, gone after `pod install`). The half that actually compiles is
// `spm_dependency` in `modules/herdr-ssh/ios/HerdrSsh.podspec`; the pins are written in both files
// and must be changed together.
//
// ## Why a plugin, and not a `s.dependency` in the podspec
//
// There is no maintained ssh client on CocoaPods. Measured 2026-08-22 against trunk: `NMSSH` last
// published 2.3.1 on 2018-07-29, and the only `libssh2` pod is 1.4.3 from 2014-05-19. Both vendor a
// crypto stack from before 2019 — in the app that holds the user's ssh key.
//
// The maintained implementations are SPM-only: `apple/swift-nio-ssh` (Apache-2.0, 0.15.0 on
// 2026-07-28) and `orlandos-nl/Citadel` (MIT, 0.12.1). NOTE, verified 2026-08-22 by resolving the
// package: Citadel 0.12.1 does NOT depend on apple/swift-nio-ssh. Its Package.swift:20 points at
// `https://github.com/Wellz26/swift-nio-ssh.git` with a floating `0.3.4 ..< 0.4.0`, resolving to
// 0.3.6 — a fork of the Citadel author's own fork, created 2026-04-02, pushed once that day and
// not since, 0 stars, pulled in by Citadel PR #127 (a Mac Catalyst build fix). See
// .prd/06-open-decisions.md decision 7. A CocoaPods podspec
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

const PACKAGES = [
  {
    name: 'Citadel',
    url: 'https://github.com/orlandos-nl/Citadel.git',
    requirement: { kind: 'exactVersion', version: '0.12.1' },
    products: ['Citadel']
  },
  // Citadel floats this transitive hop as `0.3.4 ..< 0.4.0`; we pin it to a revision from the root.
  // In that repository the tags lie — `0.4.0` (c997b6b, 2025-09-16) is the PARENT of `0.3.6`
  // (a05e6bb, 2026-04-02), i.e. 0.3.6 is the newer content, re-tagged low to fit Citadel's range.
  // A version or range constraint is therefore meaningless there; only a revision is honest.
  // See .prd/06-open-decisions.md decision 7. `products` is empty on purpose — NIOSSH is linked by
  // Citadel, this entry exists only to override the resolution.
  {
    name: 'swift-nio-ssh',
    url: 'https://github.com/Wellz26/swift-nio-ssh.git',
    requirement: { kind: 'revision', revision: 'a05e6bbe6b141ee68da3030e00275504c0595d4d' },
    products: []
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
        requirement: pkg.requirement
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
