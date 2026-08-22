# Not from orca. Podspec for the local Expo module `herdr-ssh`.
#
# ⚠️ UNVERIFIED: no `expo prebuild` and no `pod install` has been run against this file. It has never
# been parsed by CocoaPods.
#
# What is NOT here, and why: the ssh library itself. Citadel and apple/swift-nio-ssh are distributed
# through Swift Package Manager only, and a CocoaPods podspec cannot declare an SPM dependency.
# `expo-modules-autolinking`'s Apple config accepts `podspecPath` and nothing else
# (node_modules/expo-modules-autolinking/build/types.d.ts:136-171), so the SPM half is wired into the
# generated Xcode project by `mobile/plugins/with-herdr-ssh-spm.js` instead. See README.md §iOS.
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

  # Swift 6 concurrency checking off for now: Citadel's async surface is not fully Sendable-audited
  # at 0.12.1 and this module has never been compiled, so a strict-concurrency failure here would be
  # noise on top of an unbuilt target rather than a signal.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
