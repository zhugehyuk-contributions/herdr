// Not from orca.
//
// ⚠️⚠️ **UNVERIFIED SOURCE.** This file has never been compiled. No Gradle sync, no `expo prebuild`,
// no APK, no device run — the receipt for this unit stops at the JavaScript boundary
// (`modules/herdr-ssh/test/`). The sshj symbols below were taken from its published API, but that is
// not the same as a green `assembleDebug`.
//
// The Android half of `NativeHerdrSsh` (`../../../../../../src/native-types.ts`). Obligations 4, 6,
// 7, 8 and 9 of `HerdrTransport` (`packages/herdr-client-ts/src/transport.ts`) are enforced in
// TypeScript above this file, where they are testable; what is owned here is 1 (no pty), 2 (the
// command string is passed through, never rebuilt), 3 (stderr rides the close) and 5 (one
// connection, N channels).
package dev.herdr.ssh

import expo.modules.kotlin.jni.JavaScriptFunction
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** `NativeSshConnectConfig` (`../src/native-types.ts`). */
class HerdrSshConnectConfig : Record {
  @Field var host: String = ""
  @Field var port: Int = 22
  @Field var username: String = ""
  @Field var privateKey: String = ""
  @Field var passphrase: String? = null

  /** Base64 body of the server's OpenSSH `SHA256:` fingerprint. */
  @Field var hostKeySha256: String? = null

  @Field var allowUnknownHostKey: Boolean = false
  @Field var connectTimeoutMs: Int = 20000
  @Field var keepaliveIntervalMs: Int = 15000
}

class HerdrSshModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HerdrSsh")

    AsyncFunction("connect") { config: HerdrSshConnectConfig ->
      HerdrSshConnection(HerdrSshDialer.dial(config), appContext)
    }

    Class(HerdrSshConnection::class) {
      // The handlers are arguments, not listeners attached afterwards — obligation 4. sshj hands
      // back a `Session.Command` whose streams are already live, so a listener registered after
      // `openChannel` resolved would lose whatever the remote wrote first, which for a bridge that
      // failed to start is the entire diagnosis.
      AsyncFunction("openChannel") { connection: HerdrSshConnection,
        command: String,
        onData: JavaScriptFunction<Unit>,
        onClose: JavaScriptFunction<Unit> ->
        connection.openChannel(command, onData, onClose)
      }

      Function("disconnect") { connection: HerdrSshConnection ->
        connection.disconnect()
      }
    }

    Class(HerdrSshChannel::class) {
      // `ByteArray` in, `Uint8Array` on the JS side, with one `getRegion` copy and no base64:
      // `ByteArrayTypeConverter` declares `CppType.UINT8_TYPED_ARRAY` inbound, and outbound the
      // emit path routes through `FollyDynamicExtensionConverter` into `createUint8Array`
      // (expo-modules-core android/src/main/cpp/types/JNIToJSIConverter.cpp:16-41).
      AsyncFunction("write") { channel: HerdrSshChannel, bytes: ByteArray ->
        channel.write(bytes)
      }

      Function("close") { channel: HerdrSshChannel ->
        channel.close()
      }
    }
  }
}
