// swift-tools-version:6.0
import PackageDescription
let package = Package(
  name: "HerdrSshCheck",
  platforms: [.macOS(.v15)],
  dependencies: [.package(url: "https://github.com/orlandos-nl/Citadel.git", exact: "0.12.1")],
  targets: [
    .target(name: "ExpoModulesCore", swiftSettings: [.swiftLanguageMode(.v5)]),
    .target(name: "HerdrSshCheck", dependencies: ["ExpoModulesCore", .product(name: "Citadel", package: "Citadel")], swiftSettings: [.swiftLanguageMode(.v5)])
  ]
)
