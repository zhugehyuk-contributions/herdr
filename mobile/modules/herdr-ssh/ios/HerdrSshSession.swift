// Not from orca.
//
// Compiled by `typecheck:ios` and *run* by `typecheck:writerace`, which drives this file's channel
// against a real ssh server. What neither of them touches is `HerdrSshModule.swift` — see its
// header, and `typecheck/writerace/run.sh` for the rest of the blind spots.
//
// The ssh plumbing: dialing, the one-connection-N-channels arrangement, and the translation of one
// Citadel exec stream into the `(onData, onClose)` pair the TypeScript side was handed.
import ExpoModulesCore
import Citadel
import Crypto
import Foundation
import NIOCore
import NIOSSH

enum HerdrSshError: Error, LocalizedError {
  case unsupportedPrivateKey(String)
  case encryptedKeyUnsupported
  case unknownHostKey(String)
  case channelGone

  var errorDescription: String? {
    switch self {
    case .unsupportedPrivateKey(let detail):
      return "unsupported private key: \(detail)"
    case .encryptedKeyUnsupported:
      return "passphrase-protected private keys are not supported yet"
    case .unknownHostKey(let fingerprint):
      return "host key \(fingerprint) does not match the configured fingerprint"
    case .channelGone:
      return "the ssh channel is no longer open"
    }
  }
}

/// Dialing, kept apart from the shared objects so `connect` is one readable sequence.
enum HerdrSshDialer {
  static func dial(_ config: HerdrSshConnectConfig) async throws -> SSHClient {
    let auth = try authentication(for: config)
    // Host keys: Citadel takes the policy as a parameter, so "we did not check" is a value in the
    // source rather than an omission. `allowUnknownHostKey` exists so that accepting any key is a
    // decision the caller made explicitly — a phone has no `known_hosts` from a previous session,
    // and the credential at stake is an ssh key with shell access (03-blockers.md B11).
    let validator: SSHHostKeyValidator
    if let fingerprint = config.hostKeySha256, !fingerprint.isEmpty {
      validator = .custom(HerdrHostKeyValidator(expectedSha256: fingerprint))
    } else if config.allowUnknownHostKey {
      validator = .acceptAnything()
    } else {
      throw HerdrSshError.unknownHostKey("<none configured>")
    }

    return try await SSHClient.connect(
      host: config.host,
      port: config.port,
      authenticationMethod: auth,
      hostKeyValidator: validator,
      reconnect: .never,
      connectTimeout: .milliseconds(Int64(config.connectTimeoutMs))
    )
  }

  /// Turns the PEM text into one of Citadel's authentication methods.
  ///
  /// Ed25519 first because it is what `ssh-keygen` has produced by default since OpenSSH 8.5, and
  /// because it is the one algorithm every layer here agrees on: swift-nio-ssh supports only
  /// Ed25519 and the NIST curves (`swift-nio-ssh` README, "Modern cryptographic primitives only"),
  /// and Citadel adds RSA on top of that.
  private static func authentication(for config: HerdrSshConnectConfig) throws -> SSHAuthenticationMethod {
    if let passphrase = config.passphrase, !passphrase.isEmpty {
      // Citadel can decrypt bcrypt-KDF keys, but this path is untested here and a silently wrong
      // decryption reads as an auth failure. Refused loudly until someone can run it on a device.
      throw HerdrSshError.encryptedKeyUnsupported
    }
    let pem = config.privateKey
    if pem.contains("BEGIN OPENSSH PRIVATE KEY") {
      if let ed25519 = try? Curve25519.Signing.PrivateKey(sshEd25519: pem) {
        return .ed25519(username: config.username, privateKey: ed25519)
      }
      if let rsa = try? Insecure.RSA.PrivateKey(sshRsa: pem) {
        return .rsa(username: config.username, privateKey: rsa)
      }
    }
    throw HerdrSshError.unsupportedPrivateKey(
      "expected an unencrypted OpenSSH Ed25519 or RSA key (`ssh-keygen -t ed25519`)"
    )
  }
}

/// Compares the server's key against the configured `SHA256:` fingerprint.
struct HerdrHostKeyValidator: NIOSSHClientServerAuthenticationDelegate {
  let expectedSha256: String

  func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
    // `String(openSSHPublicKey:)` renders "algorithm-id base64" (swift-nio-ssh
    // NIOSSHPublicKey.swift:460-461); OpenSSH fingerprints the base64 *body*, not the whole line.
    let rendered = String(openSSHPublicKey: hostKey)
    guard
      let encoded = rendered.split(separator: " ").dropFirst().first,
      let raw = Data(base64Encoded: String(encoded))
    else {
      validationCompletePromise.fail(HerdrSshError.unknownHostKey("<unreadable>"))
      return
    }
    let digest = Data(SHA256.hash(data: raw)).base64EncodedString()
      .trimmingCharacters(in: CharacterSet(charactersIn: "="))
    let expected = expectedSha256
      .replacingOccurrences(of: "SHA256:", with: "")
      .trimmingCharacters(in: CharacterSet(charactersIn: "="))
    if digest == expected {
      validationCompletePromise.succeed(())
    } else {
      validationCompletePromise.fail(HerdrSshError.unknownHostKey("SHA256:\(digest)"))
    }
  }
}

/// One host. **One** `SSHClient`, however many channels — obligation 5, made structural by there
/// being no second `SSHClient.connect` anywhere below this line.
public final class HerdrSshConnection: SharedObject {
  private let client: SSHClient
  private var channels: [HerdrSshChannel] = []
  private let lock = NSLock()

  init(client: SSHClient) {
    self.client = client
    super.init()
  }

  /// Starts one exec channel and pumps it until it ends.
  ///
  /// Returns once the exec has been accepted and the channel is **writable**, so the caller's
  /// promise resolves at the same moment `ssh2`'s `exec` callback fires in the Node implementation
  /// — and at the same moment `session.exec(command)` returns in the Kotlin one
  /// (`../android/src/main/java/dev/herdr/ssh/HerdrSshSession.kt:165`).
  func start(channel: HerdrSshChannel, command: String) async throws {
    lock.lock()
    channels.append(channel)
    lock.unlock()

    try await channel.attach(client: client, command: command) { [weak self] done in
      self?.forget(done)
    }
  }

  private func forget(_ channel: HerdrSshChannel) {
    lock.lock()
    channels.removeAll { $0 === channel }
    lock.unlock()
  }

  func disconnect() {
    lock.lock()
    let live = channels
    channels = []
    lock.unlock()
    for channel in live {
      channel.close()
    }
    Task { try? await client.close() }
  }
}

/// One exec channel: a byte stream in, a byte stream and a stderr transcript out.
public final class HerdrSshChannel: SharedObject {
  private let onData: JavaScriptFunction<Void>
  private let onClose: JavaScriptFunction<Void>
  private var writer: TTYStdinWriter?
  private var pump: Task<Void, Never>?
  private var stderr = Data()
  private var finished = false
  /// Set when the channel became writable, or when it ended without ever becoming writable. Both
  /// are answers to "may `attach` return"; only the first one means a write will reach the remote.
  private var ready = false
  /// The `attach` call parked on that latch. At most one: `attach` runs once per channel.
  private var readyWaiter: CheckedContinuation<Void, Never>?
  private let lock = NSLock()
  /// The context used to hop onto the JS thread.
  ///
  /// NOT `SharedObject.appContext`: that property is `public internal(set)`
  /// (expo-modules-core/ios/Core/SharedObjects/SharedObject.swift:23) and is set by the registry
  /// only once the object is converted into a JS value, i.e. *after* `openChannel` returns. This
  /// channel starts delivering inside `attach`, before that, so it is handed the module's context
  /// at construction. Measured 2026-08-23: assigning `appContext` from outside is
  /// `error: cannot assign to property: 'appContext' setter is inaccessible`. Weak for the same
  /// reason the base class is weak — the context owns the registry that owns this object.
  private weak var jsContext: AppContext?

  init(onData: JavaScriptFunction<Void>, onClose: JavaScriptFunction<Void>, jsContext: AppContext?) {
    self.onData = onData
    self.onClose = onClose
    self.jsContext = jsContext
    super.init()
  }

  /// Execs `command` **without a pty** and starts delivering.
  ///
  /// `withExec` is Citadel's pty-less exec; `withPTY` and `withTTY` are the siblings that are not
  /// used and must never be, because a pty's line discipline rewrites CR/LF *inside* every framed
  /// payload of a pure byte pump (`src/remote/unix.rs:568-590`) — obligation 1.
  ///
  /// **Returns only once the channel can be written to**, or once it has ended without ever
  /// becoming writable. That is the contract `openChannel` resolving states, and it is the reason
  /// this method awaits a latch instead of returning as soon as the pump task exists:
  ///
  /// `withExec` hands the stdin writer to a *closure* (Citadel 0.12.1 TTY.swift:456-476), and it
  /// only calls that closure after `_executeCommandStream` has opened the ssh channel and had the
  /// exec request acknowledged (TTY.swift:307-341) — round trips over the link. Returning before
  /// the closure ran therefore resolved `openChannel` with a channel whose `writer` was still nil,
  /// and the caller's very next statement is a write: `ServerMessageChannel.open` sends the wire
  /// prelude the moment the channel exists (`packages/herdr-client-ts/src/transport.ts:848`), and
  /// `JsonApiClient.call` writes its request line (`packages/herdr-client-ts/src/jsonApi.ts:210`).
  /// Whoever lost that race got `.channelGone` — an exec that opened, wrote zero bytes and closed.
  /// The Kotlin twin never had the window, because `session.exec(command)` returns the live channel
  /// (`../android/src/main/java/dev/herdr/ssh/HerdrSshSession.kt:165`); this makes the two sides of
  /// `NativeSshConnection.openChannel` mean the same thing again.
  func attach(
    client: SSHClient,
    command: String,
    onFinished: @escaping (HerdrSshChannel) -> Void
  ) async throws {
    let started = Task { [weak self] in
      guard let self else { return }
      var exitCode: Int?
      var failure: Error?
      do {
        try await client.withExec(command) { inbound, outbound in
          self.lock.lock()
          self.writer = outbound
          self.lock.unlock()
          // Writable from here and not one line earlier, so this is where `attach` is released.
          self.signalReady()
          for try await chunk in inbound {
            switch chunk {
            case .stdout(let buffer):
              self.deliver(buffer)
            case .stderr(let buffer):
              // Obligation 3: the bridges report every startup failure here and nowhere else, so it
              // is accumulated for the close payload rather than dropped or interleaved with stdout.
              self.lock.lock()
              self.stderr.append(contentsOf: buffer.readableBytesView)
              self.lock.unlock()
            }
          }
        }
      } catch let error as SSHClient.CommandFailed {
        exitCode = error.exitCode
      } catch {
        failure = error
      }
      // `finish` releases `attach` as well, which is what covers the exec that never reached the
      // closure at all — a refused exec request, a dead connection, a cancelled pump. Those must
      // fail the channel through `onClose`, exactly as they did before, and must never leave
      // `openChannel` awaiting a writer that is not coming.
      self.finish(exitCode: exitCode, error: failure)
      onFinished(self)
    }
    pump = started
    await awaitReady()
  }

  /// Releases `attach`. Idempotent, and safe to call from any thread.
  private func signalReady() {
    lock.lock()
    let waiter = readyWaiter
    readyWaiter = nil
    ready = true
    lock.unlock()
    waiter?.resume()
  }

  /// Parks until [signalReady], including when it already happened before this call.
  private func awaitReady() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      lock.lock()
      if ready {
        lock.unlock()
        continuation.resume()
        return
      }
      readyWaiter = continuation
      lock.unlock()
    }
  }

  /// One stdout chunk, on the JS thread, as a `Uint8Array`.
  ///
  /// The buffer is freshly allocated on the JS heap by the conversion
  /// (`expo-modules-core/ios/JSI/EXJSIConversions.mm:74-84`, one `memcpy`), so the "valid only for
  /// this call" convention of obligation 7 is honoured trivially — and the copy is the *only* one
  /// on the path, which is the point of using `Data` rather than base64.
  private func deliver(_ buffer: ByteBuffer) {
    let bytes = Data(buffer.readableBytesView)
    jsContext?.executeOnJavaScriptThread { [weak self] in
      try? self?.onData.call(bytes)
    }
  }

  private func finish(exitCode: Int?, error: Error?) {
    lock.lock()
    if finished {
      lock.unlock()
      return
    }
    finished = true
    let transcript = String(data: stderr, encoding: .utf8) ?? ""
    lock.unlock()
    signalReady()

    var payload: [String: Any] = [:]
    if let exitCode { payload["exitCode"] = exitCode }
    if !transcript.isEmpty { payload["stderr"] = transcript }
    if let error { payload["errorMessage"] = error.localizedDescription }
    jsContext?.executeOnJavaScriptThread { [weak self] in
      try? self?.onClose.call(payload)
    }
  }

  /// Obligation 8: resolves on hand-off — `writeAndFlush` completing means the ssh session accepted
  /// the bytes, not that the remote read them. This protocol has no delivery receipt.
  func write(_ bytes: Data) async throws {
    lock.lock()
    let outbound = writer
    let gone = finished
    lock.unlock()
    if gone { return }
    // Unreachable by construction now that `attach` returns only once one of the two is true:
    // `writer` is set, or `finished` is — kept as the backstop for a caller that ever gets hold of
    // a channel some other way.
    guard let outbound else { throw HerdrSshError.channelGone }
    try await outbound.write(ByteBuffer(bytes: bytes))
  }

  func close() {
    pump?.cancel()
    finish(exitCode: nil, error: nil)
  }
}
