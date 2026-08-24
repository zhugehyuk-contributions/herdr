# Not from orca. Podspec for the local Expo module `herdr-ssh`.
#
# Verified 2026-08-23: `expo prebuild --platform ios` + `pod install` parse this file and install
# the pod (`Installing HerdrSsh (0.0.0)`). It is skipped silently unless the app's iOS deployment
# target is >= the floor below — see `s.platforms`.
#
# Where the ssh library comes from: Swift Package Manager, declared below with `spm_dependency`.
# Citadel is SPM-only, and a CocoaPods *dependency* cannot name an SPM package — but React Native
# 0.83 ships a bridge for exactly this case: `spm_dependency(spec, url:, requirement:, products:)`
# (react-native/scripts/react_native_pods.rb:325) records the package, and `react_native_post_install`
# (:540) hands it to `SPMManager#apply_on_post_install` (react-native/scripts/cocoapods/spm.rb:19-41),
# which adds an XCRemoteSwiftPackageReference to the **Pods** project, attaches an
# XCSwiftPackageProductDependency to *this pod's target*, and appends the build dir to that target's
# SWIFT_INCLUDE_PATHS. That last part is why the declaration has to live here: `import Citadel` is
# compiled in the Pods project, and the app-project package reference written by
# `mobile/plugins/with-herdr-ssh-spm.js` is not visible from it.
#
# Measured 2026-08-23, first `pod install` ever run against this file: with only the config plugin,
# `ios/Pods/Pods.xcodeproj` contained zero Citadel references and this target's
# `SWIFT_INCLUDE_PATHS` was `ExpoModulesCore` + `RCTSwiftUI` only. The plugin's app-project half is
# still useful — it is what makes Xcode resolve and write
# `ios/herdr.xcworkspace/xcshareddata/swiftpm/Package.resolved` — but on its own it cannot compile
# this file. The pins below are the same ones, from .prd/06-open-decisions.md decision 7; they are
# duplicated in the plugin and the two must be changed together.
#
# The CocoaPods alternative was measured, not assumed: the only ssh clients on CocoaPods trunk are
# NMSSH (last release 2.3.1, 2018-07-29) and a third-party `libssh2` pod (1.4.3, 2014-05-19). Both
# vendor a crypto stack from before 2019, in the app that holds the user's ssh key.
Pod::Spec.new do |s|
  s.name           = 'HerdrSsh'
  s.version        = '0.0.0'
  s.summary        = 'ssh exec channels for the herdr mobile client'
  s.description    = 'Wraps an ssh connection as a HerdrTransport: one connection, N exec channels, no pty.'
  s.author         = 'herdr'
  s.homepage       = 'https://github.com/2lab-ai/herdr'
  # iOS 17.0, not 15.1, and no tvOS — this is dictated by the dependency, not chosen here.
  # Citadel 0.12.1 declares `platforms: [.macOS(.v14), .iOS(.v17)]` in its Package.swift and does
  # not declare tvOS at all, so an iOS 15.1 / tvOS 15.1 floor cannot resolve it; SwiftPM refuses
  # before anything is compiled. Verified 2026-08-22 against the 0.12.1 tag.
  #
  # The alternative, if an iOS 15/16 floor is ever a requirement: drop to `apple/swift-nio-ssh`
  # directly (0.15.0 declares .iOS(.v13) / .tvOS(.v13) / .macOS(.v10_15)). Citadel IS a layer on
  # top of nio-ssh, so the cost is re-implementing what it gives us here — `withExec` (pty-less
  # exec channels), `SSHAuthenticationMethod`, `SSHHostKeyValidator` — by hand, in the app that
  # holds the user's ssh key. That is a real trade, not a footnote; it has not been made.
  s.platforms      = { :ios => '17.0' }
  s.source         = { git: 'https://github.com/2lab-ai/herdr' }
  s.static_framework = true
  s.license        = { :type => 'Apache-2.0' }

  s.dependency 'ExpoModulesCore'

  # ssh stack, pinned per .prd/06-open-decisions.md decision 7. Citadel is pinned to an exact
  # version; its transitive `Wellz26/swift-nio-ssh` hop is pinned to a *revision* because that
  # repository's tags lie — `0.4.0` (c997b6b, 2025-09-16) is the parent commit of `0.3.6`
  # (a05e6bb, 2026-04-02), so no version range there means what it says. Citadel floats that hop as
  # `0.3.4 ..< 0.4.0`; declaring it here overrides the resolution from the root.
  # Gated so `scripts/pods-install.sh` can take a snapshot of the project WITHOUT these —
  # the repair it runs afterwards needs the objects CocoaPods' SPM integration evicts.
  # See scripts/repair-pods-spm-collision.mjs and .prd/12-qr-pairing.md.
  if ENV['HERDR_SSH_SPM'] != '0'
    spm_dependency(s,
      url: 'https://github.com/orlandos-nl/Citadel.git',
      requirement: { kind: 'exactVersion', version: '0.12.1' },
      products: ['Citadel']
    )
    spm_dependency(s,
      url: 'https://github.com/Wellz26/swift-nio-ssh.git',
      requirement: { kind: 'revision', revision: 'a05e6bbe6b141ee68da3030e00275504c0595d4d' },
      products: ['NIOSSH']
    )
  end

  # Swift 6 concurrency checking off for now: Citadel's async surface is not fully Sendable-audited
  # at 0.12.1 and this module has never been compiled, so a strict-concurrency failure here would be
  # noise on top of an unbuilt target rather than a signal.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
