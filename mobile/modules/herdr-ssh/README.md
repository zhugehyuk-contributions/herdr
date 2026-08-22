# `herdr-ssh` — the React Native ssh transport

> **하이레벨:** 폰이 herdr 서버를 보려면 `ssh <host> herdr remote-{api,client}-bridge` 위의 stdio
> 바이트 펌프가 필요하고, React Native에는 ssh 스택이 없다. 이 모듈이 그 스택이다. 계약은
> `packages/herdr-client-ts/src/transport.ts`의 `HerdrTransport`이며, 노드 쪽 구현
> (`src/node/sshTransport.ts`, ssh2)과 **같은 인터페이스·같은 9개 의무**를 만족한다.

Not from orca. orca's transport is a WebSocket that React Native already provides; there is no
counterpart to port (`mobile/.prd/02-architecture.md` §2.4 — "orca 대비 최대 신규 작업").

## Layout

| Path | What |
|---|---|
| `index.ts` | Public entry. Imports nothing from `expo-*` or `react-native` at module scope. |
| `src/native-types.ts` | The whole native surface, as an interface. The seam a fake can stand in for. |
| `src/ssh-transport.ts` | `HerdrTransport` over that interface. Where obligations 1, 2, 4, 6, 7, 8, 9 live. |
| `src/remote-config.ts` | Parses `app.json` → `expo.extra.herdrRemotes`. |
| `src/app-connections.ts` | `useHerdrSshConnections()` — the junction `app/_layout.tsx` calls. |
| `src/native-module.ts` | The one `requireOptionalNativeModule` call, behind a dynamic import. |
| `test/` | The receipt: 33 tests, no device. |
| `ios/`, `android/` | **Unverified native sources — see below.** |

## Autolinking — why there is no `app.json` entry for the module

`expo-modules-autolinking` resolves `nativeModulesDir` to `./modules` by default when that directory
exists (`node_modules/expo-modules-autolinking/build/commands/autolinkingOptions.js:170-174`), and
`findModulesAsync` searches it before anything else (`build/autolinking/findModules.js:40-44`). So
`modules/herdr-ssh/expo-module.config.json` is what links this module; an `app.json` `plugins` entry
would be a no-op. The one thing that *is* registered in `app.json` is
`./plugins/with-herdr-ssh-spm.js`, and that is for the iOS package dependency, not for the module.

## iOS — Citadel on apple/swift-nio-ssh

**Chosen:** [`orlandos-nl/Citadel`](https://github.com/orlandos-nl/Citadel) 0.12.1 (MIT), which is a
layer over [`apple/swift-nio-ssh`](https://github.com/apple/swift-nio-ssh) 0.15.0 (Apache-2.0).

The evidence, measured 2026-08-22 rather than recalled:

| Candidate | License | Last release | Verdict |
|---|---|---|---|
| `apple/swift-nio-ssh` | Apache-2.0 | 0.15.0, 2026-07-28 | The protocol engine. Kept — Citadel brings it. |
| `orlandos-nl/Citadel` | MIT | 0.12.1, 2026-04-04 | **Chosen.** Adds what swift-nio-ssh lacks (below). |
| `NMSSH/NMSSH` | MIT | 2.3.1, **2018-07-29** | Rejected: an 8-year-old crypto stack in the app that holds the user's ssh key. |
| `libssh2` (CocoaPods) | BSD-3 | 1.4.3, **2014-05-19** | Rejected, same reason, worse. |

Why Citadel and not swift-nio-ssh alone: swift-nio-ssh has **no OpenSSH private-key parser** — its
`NIOSSHPrivateKey` only accepts already-parsed `Curve25519`/`P256`/`P384`/`P521` keys
(`Sources/NIOSSH/Keys And Signatures/NIOSSHPrivateKey.swift:39-56`) — and it supports **no RSA**
("Modern cryptographic primitives only: Ed25519 and ECDSA over the major NIST curves", upstream
README:34). Citadel supplies both, plus `SSHHostKeyValidator` as a first-class parameter. Using
swift-nio-ssh directly would mean hand-writing an `openssh-key-v1` container parser and a bcrypt KDF
in an app nobody can build yet.

**Distribution is the sharp edge.** Both are SPM-only and a CocoaPods `dependency` cannot name an
SPM package, so the wiring is in two places, and the first `pod install` ever run (2026-08-23)
showed why both are needed:

- `ios/HerdrSsh.podspec` calls React Native 0.83's `spm_dependency`
  (`react-native/scripts/react_native_pods.rb:325` → `scripts/cocoapods/spm.rb:19-41`), which puts
  the package in the **Pods** project, attaches the product to *this pod's target* and widens that
  target's `SWIFT_INCLUDE_PATHS`. **This is the half that makes `import Citadel` compile**, because
  the module's Swift is compiled in the Pods project. Without it the build dies at
  `HerdrSshModule.swift:22:8: error: unable to resolve module dependency: 'Citadel'`.
- `mobile/plugins/with-herdr-ssh-spm.js` writes `XCRemoteSwiftPackageReference` objects into the
  **app** `project.pbxproj` — legal only because `xcode@3.0.1`'s writer serializes sections it has
  no model for (`xcode/lib/pbxWriter.js:180-196`), which is why it is the most fragile file in this
  module. Measured limit: the `XCSwiftPackageProductDependency` it also writes does **not** survive
  `pod install` — CocoaPods re-saves the app project through Xcodeproj, which drops objects no
  target references. What survives is the package reference itself, and that is what makes Xcode
  resolve the graph and write `ios/herdr.xcworkspace/xcshareddata/swiftpm/Package.resolved`.

The pins (`.prd/06-open-decisions.md` decision 7) are therefore written twice and must be changed
together.

**Known limitation:** passphrase-protected private keys are refused with a named error rather than
attempted (`ios/HerdrSshSession.swift`), because a wrong decryption reads as an auth failure and
nobody can run it yet.

## Android — sshj

**Chosen:** [`hierynomus/sshj`](https://github.com/hierynomus/sshj) 0.40.0 — **Apache-2.0**, the same
license as herdr; released 2026-06-29, repository pushed 2026-07-10, 2.6k stars. It supports RSA,
Ed25519 (with `net.i2p.crypto:eddsa`) and the NIST curves, parses OpenSSH keys, exposes
`Session.Command.getErrorStream()` separately from stdout, and gives N `Session`s per `SSHClient` —
which is obligation 5 for free. `mwiede/jsch` was the alternative and is rejected on licensing: the
GitHub API reports no SPDX identifier for it.

## The nine obligations, and where each is kept

`packages/herdr-client-ts/src/transport.ts` states them; this table says where each is enforced and
what proves it.

| # | Obligation | Enforced in | Proof |
|---|---|---|---|
| 1 | exec without a pty | native API has no pty parameter; `assertNoPty()` guards the constant | `test/ssh-transport.test.ts` — flipping `BRIDGE_EXEC_OPTIONS.pty` fails the open |
| 2 | run the command string this package produced | `remoteBridgeCommand()` in `openChannel`, passed through | byte-identity per kind + one pinned literal |
| 3 | pump stderr into the close | `NativeChannelClose.stderr` → `toChannelClose` | close carries stderr; `null`/`""` become absent |
| 4 | handlers attached before the channel is observable | handlers are **arguments** to `openChannel` | data and a full close emitted *before* `openChannel` resolves are still delivered |
| 5 | one connection, N channels | `connect` is the only dial; `openChannel` has no dial | 4 channels → `connections.length === 1` |
| 6 | ordered, exactly once, per channel | per-channel callbacks; post-close data dropped and counted | interleaved two-channel transcript; `dataAfterClose` |
| 7 | the `onData` buffer belongs to the transport | forwarded by reference, retained nowhere | identity assertion + a reused-buffer round trip |
| 8 | `write` resolves on hand-off | returns the native promise | resolves with no reply in sight |
| 9 | a write racing a close must not throw | dropped and counted; late rejections swallowed | three races, all resolve |

## Unverified

Everything under `ios/` and `android/` — **and `plugins/with-herdr-ssh-spm.js`** — has never been
compiled, linked, installed or run. No `expo prebuild`, no `pod install`, no Gradle sync, no device.
Each native file says so in its own header. The upstream API surface was read from the pinned
sources rather than recalled, but reading is not compiling, and the first real build will find
mistakes in these files.

The only machine check the native sources have had, and exactly what it is worth:

| Check | Result | What it does *not* say |
|---|---|---|
| `swiftc -parse ios/*.swift` | exit 0, both files | Syntax only. No type checking, no imports resolved — Xcode is not installed on this machine (`/Applications/Xcode.app` absent), so `-typecheck` against `ExpoModulesCore`/`Citadel`/`NIOSSH` cannot run. Every symbol could still be wrong. |
| Kotlin | **not run** | No `kotlinc` and no `ktlint` on this machine. `android/` has had no check of any kind. |
| `node -e "require('../../plugins/with-herdr-ssh-spm.js')"` | loads, exports a function | It has never been handed a `project.pbxproj`. |

What *is* verified is the TypeScript boundary: `test/` runs in the default `pnpm -C mobile test`
gate, and three of its assertions were confirmed to go red when the behaviour they describe is
removed (obligations 6, 7 and 9 — mutation-checked 2026-08-22).
