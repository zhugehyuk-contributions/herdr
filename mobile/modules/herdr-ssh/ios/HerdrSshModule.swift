// Not from orca.
//
// ⚠️⚠️ **UNVERIFIED SOURCE.** This file has never been compiled. No `expo prebuild`, no `pod
// install`, no Xcode build, no device run — the unit whose receipt this is stops at the JavaScript
// boundary (`modules/herdr-ssh/test/`). Every Citadel/NIOSSH symbol below was read out of the
// upstream sources at the pinned tags (see README.md §iOS) rather than typed from memory, but read
// is not compiled. Treat the whole file as a first draft that the first `pod install` will correct.
//
// What it is: the iOS half of `NativeHerdrSsh` (`../src/native-types.ts`). The nine obligations of
// `HerdrTransport` (`packages/herdr-client-ts/src/transport.ts`) are split deliberately — the five
// that are not about ssh (4, 6, 7, 8, 9) are enforced in TypeScript, above this file, where they are
// testable. What is left here is genuinely ssh, and the ones this file owns are:
//
//   1. **no pty** — `SSHClient.withExec` is the pty-less exec (`withPTY`/`withTTY` are its siblings
//      and are not used). There is no pty parameter on this module's API to get wrong.
//   2. **the command string** — `command` arrives from JS and is passed to `withExec` verbatim.
//      Nothing here parses, quotes or rebuilds it.
//   3. **stderr** — `ExecCommandOutput.stderr` is accumulated and delivered in the close payload.
//   5. **one connection, N channels** — one `SSHClient` per `HerdrSshConnection`; `openChannel`
//      opens a child channel on it and never dials.
import ExpoModulesCore
import Citadel
import Crypto
import Foundation
import NIOCore
import NIOSSH

/// `NativeSshConnectConfig` (`../src/native-types.ts`), as an Expo record.
struct HerdrSshConnectConfig: Record {
  @Field var host: String = ""
  @Field var port: Int = 22
  @Field var username: String = ""
  @Field var privateKey: String = ""
  @Field var passphrase: String?
  /// Base64 body of the server's OpenSSH `SHA256:` fingerprint.
  @Field var hostKeySha256: String?
  @Field var allowUnknownHostKey: Bool = false
  @Field var connectTimeoutMs: Int = 20000
  @Field var keepaliveIntervalMs: Int = 15000
}

public final class HerdrSshModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HerdrSsh")

    AsyncFunction("connect") { (config: HerdrSshConnectConfig) -> HerdrSshConnection in
      let client = try await HerdrSshDialer.dial(config)
      return HerdrSshConnection(client: client)
    }

    Class(HerdrSshConnection.self) {
      // The handlers are *arguments*, not listeners added afterwards. That is obligation 4 and it
      // is the whole reason this is not an `EventEmitter`: the remote writes the instant the command
      // starts, and a listener attached after `openChannel` resolved would miss whatever preceded
      // it — including the entire stderr of a bridge that failed to start.
      AsyncFunction("openChannel") { (
        connection: HerdrSshConnection,
        command: String,
        onData: JavaScriptFunction<Void>,
        onClose: JavaScriptFunction<Void>
      ) -> HerdrSshChannel in
        let channel = HerdrSshChannel(onData: onData, onClose: onClose)
        channel.appContext = self.appContext
        try await connection.start(channel: channel, command: command)
        return channel
      }

      Function("disconnect") { (connection: HerdrSshConnection) in
        connection.disconnect()
      }
    }

    Class(HerdrSshChannel.self) {
      // `Data` in, `Uint8Array` on the JS side: `DynamicDataType` casts a `Uint8Array` straight into
      // `Data` over the JSI buffer (expo-modules-core/ios/Core/DynamicTypes/DynamicDataType.swift:20-25),
      // so a 55 KB frame crosses as one copy and never as base64.
      AsyncFunction("write") { (channel: HerdrSshChannel, bytes: Data) in
        try await channel.write(bytes)
      }

      Function("close") { (channel: HerdrSshChannel) in
        channel.close()
      }
    }
  }
}
