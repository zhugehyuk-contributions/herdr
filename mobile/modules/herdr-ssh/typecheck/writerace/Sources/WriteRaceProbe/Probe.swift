// Not from orca. RUNS the real `HerdrSshChannel` against a real ssh server and asserts the one
// thing a type-check cannot see: that `attach` returning means the channel can be written to.
//
// The server is Citadel's own `SSHServer` in this process, so every hop under test is real ssh —
// TCP, key exchange, publickey auth, `CHANNEL_OPEN`, an `exec` request, `CHANNEL_DATA`. Only the
// two Expo symbols are stubs (../Sources/ExpoModulesCore, the recording variant of the type-check
// gate's). See run.sh for what that buys and what it does not.
import Citadel
import Crypto
import ExpoModulesCore
import Foundation
import NIOCore
import NIOPosix
import NIOSSH

private struct ProbeFailure: Error {
  let message: String
}

private func expect(_ condition: Bool, _ message: @autoclosure () -> String) throws {
  if !condition {
    throw ProbeFailure(message: message())
  }
}

/// Polls until `condition` holds. Every wait in this file is bounded: a probe that hangs is a probe
/// that says nothing, and the defect under test is precisely one that used to hang or throw.
private func waitUntil(
  _ what: String,
  timeoutMs: Int = 5000,
  _ condition: @escaping () -> Bool
) async throws {
  let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
  while Date() < deadline {
    if condition() {
      return
    }
    try await Task.sleep(nanoseconds: 5_000_000)
  }
  throw ProbeFailure(message: "timed out after \(timeoutMs) ms waiting for \(what)")
}

/// Auth is not what this probe is about, so the server accepts the first offer it is given. The key
/// on the client side is generated in memory for this run and never leaves it.
private final class AcceptAnyUser: NIOSSHServerUserAuthenticationDelegate {
  let supportedAuthenticationMethods: NIOSSHAvailableUserAuthenticationMethods = .all

  func requestReceived(
    request: NIOSSHUserAuthenticationRequest,
    responsePromise: EventLoopPromise<NIOSSHUserAuthenticationOutcome>
  ) {
    responsePromise.succeed(.success)
  }
}

/// The remote end, recorded: every exec request, every stdin byte, every channel that went away.
///
/// This is a raw `NIOSSH` server rather than Citadel's `SSHServer`, and the reason is a measured
/// one: Citadel's `SubsystemHandler` parks inbound channel data behind a `configured` promise that
/// its exec path never fulfils (Citadel 0.12.1 Server.swift:112-116 vs :52-56, where an
/// `ExecRequest` is only forwarded), so a Citadel server never delivers an exec's stdin to its
/// delegate at all — measured here 2026-08-23, the first version of this probe timed out on it.
/// Reading `SSHChannelData` directly is also the more honest instrument: what this file asserts is
/// that bytes reached the *wire*, and that is exactly what it now observes.
private final class RemoteRecorder: @unchecked Sendable {
  /// Whether an exec request is answered with success or refused outright — the two servers this
  /// probe needs, as one flag.
  let acceptsExec: Bool

  private let lock = NSLock()
  private var commandsSeen: [String] = []
  private var stdinByCommand: [String: Data] = [:]
  private var closedChannels = 0

  init(acceptsExec: Bool) {
    self.acceptsExec = acceptsExec
  }

  var commands: [String] {
    lock.lock()
    defer { lock.unlock() }
    return commandsSeen
  }

  var channelsClosed: Int {
    lock.lock()
    defer { lock.unlock() }
    return closedChannels
  }

  func stdin(of command: String) -> Data {
    lock.lock()
    defer { lock.unlock() }
    return stdinByCommand[command] ?? Data()
  }

  func noteExec(_ command: String) {
    lock.lock()
    commandsSeen.append(command)
    lock.unlock()
  }

  func noteStdin(_ command: String, _ bytes: Data) {
    lock.lock()
    stdinByCommand[command, default: Data()].append(bytes)
    lock.unlock()
  }

  func noteClosed() {
    lock.lock()
    closedChannels += 1
    lock.unlock()
  }
}

/// One session channel on the server side: answers the exec request, records stdin, echoes it back.
private final class ExecRecordingHandler: ChannelDuplexHandler {
  typealias InboundIn = SSHChannelData
  typealias InboundOut = SSHChannelData
  typealias OutboundIn = SSHChannelData
  typealias OutboundOut = SSHChannelData

  private let recorder: RemoteRecorder
  private var command: String?

  init(recorder: RemoteRecorder) {
    self.recorder = recorder
  }

  func handlerAdded(context: ChannelHandlerContext) {
    context.channel.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).whenFailure { error in
      context.fireErrorCaught(error)
    }
  }

  func channelInactive(context: ChannelHandlerContext) {
    if command != nil {
      recorder.noteClosed()
    }
    context.fireChannelInactive()
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    guard let request = event as? SSHChannelRequestEvent.ExecRequest else {
      context.fireUserInboundEventTriggered(event)
      return
    }
    guard recorder.acceptsExec else {
      // The shape Citadel's own server answers with when it has no exec delegate
      // (Citadel 0.12.1 ExecHandler.swift:78-82): refuse, then drop the channel.
      let channel = context.channel
      channel.triggerUserOutboundEvent(ChannelFailureEvent()).whenComplete { _ in
        channel.close(promise: nil)
      }
      return
    }
    command = request.command
    recorder.noteExec(request.command)
    if request.wantReply {
      context.channel.triggerUserOutboundEvent(ChannelSuccessEvent(), promise: nil)
    }
  }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    let payload = unwrapInboundIn(data)
    guard
      case .byteBuffer(let buffer) = payload.data,
      payload.type == .channel,
      let command
    else {
      return
    }
    recorder.noteStdin(command, Data(buffer.readableBytesView))
    // Echoed back, so one scenario also exercises the module's inbound half: the bytes return as
    // CHANNEL_DATA, reach `deliver`, and land in `onData` through the JS-thread hop.
    context.channel.writeAndFlush(
      SSHChannelData(type: .channel, data: .byteBuffer(buffer)),
      promise: nil
    )
  }
}

/// The JS side of the module, reduced to what it delivered — the iOS twin of `closepayload`'s
/// `Recorder`.
private final class Recorder: @unchecked Sendable {
  private let lock = NSLock()
  private var stdoutBytes = Data()
  private var closes: [[String: Any]] = []

  var stdout: Data {
    lock.lock()
    defer { lock.unlock() }
    return stdoutBytes
  }

  var closePayloads: [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return closes
  }

  lazy var onData = JavaScriptFunction<Void> { [weak self] arguments in
    guard let self, let bytes = arguments.first as? Data else { return }
    self.lock.lock()
    self.stdoutBytes.append(bytes)
    self.lock.unlock()
  }

  lazy var onClose = JavaScriptFunction<Void> { [weak self] arguments in
    guard let self else { return }
    let payload = arguments.first as? [String: Any] ?? [:]
    self.lock.lock()
    self.closes.append(payload)
    self.lock.unlock()
  }
}

private func hostServer(
  group: MultiThreadedEventLoopGroup,
  recorder: RemoteRecorder
) async throws -> (server: Channel, port: Int) {
  let hostKey = NIOSSHPrivateKey(ed25519Key: .init())
  let server = try await ServerBootstrap(group: group)
    .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
    .childChannelInitializer { channel in
      channel.pipeline.addHandlers([
        NIOSSHHandler(
          role: .server(SSHServerConfiguration(hostKeys: [hostKey], userAuthDelegate: AcceptAnyUser())),
          allocator: channel.allocator,
          inboundChildChannelInitializer: { child, channelType in
            guard case .session = channelType else {
              return child.eventLoop.makeFailedFuture(ProbeFailure(message: "unexpected channel type"))
            }
            return child.pipeline.addHandler(ExecRecordingHandler(recorder: recorder))
          }
        )
      ])
    }
    .bind(host: "127.0.0.1", port: 0)
    .get()
  guard let port = server.localAddress?.port else {
    throw ProbeFailure(message: "the kernel bound a port this probe cannot read back")
  }
  return (server, port)
}

private func dial(port: Int) async throws -> SSHClient {
  try await SSHClient.connect(
    host: "127.0.0.1",
    port: port,
    authenticationMethod: .ed25519(username: "probe", privateKey: .init()),
    hostKeyValidator: .acceptAnything(),
    reconnect: .never,
    connectTimeout: .seconds(10)
  )
}

/// THE ONE THIS FILE EXISTS FOR.
///
/// Ten channels, and on each one the first thing the caller does after `attach` returns is write —
/// which is exactly what `ssh-transport.ts` does: `ServerMessageChannel.open` sends the wire
/// prelude on the statement after `openChannel` resolves
/// (`packages/herdr-client-ts/src/transport.ts:848`), and `JsonApiClient.call` writes its request
/// line (`packages/herdr-client-ts/src/jsonApi.ts:210`). Before the fix `attach` returned as soon
/// as the pump *task existed*, while `writer` is only assigned inside Citadel's `withExec` closure
/// two round trips later, so every one of these writes threw `.channelGone` and the channel that
/// reached the server carried zero bytes of stdin.
///
/// Ten rather than one because the old shape is a race, and a race that loses ten times out of ten
/// on a loopback connection loses far more often on a phone's LTE.
private func scenarioWriteImmediatelyAfterAttach(
  remote: RemoteRecorder,
  client: SSHClient,
  context: AppContext
) async throws -> String {
  let count = 10
  var channels: [HerdrSshChannel] = []
  let recorder = Recorder()
  let finished = NSLock()
  var finishedCount = 0

  for index in 0..<count {
    let command = "herdr-probe-write-\(index)"
    let channel = HerdrSshChannel(
      onData: recorder.onData,
      onClose: recorder.onClose,
      jsContext: context
    )
    try await channel.attach(client: client, command: command) { _ in
      finished.lock()
      finishedCount += 1
      finished.unlock()
    }
    // No sleep, no yield, no await in between. This is the line the defect lived on.
    do {
      try await channel.write(Data("prelude-\(index)".utf8))
    } catch {
      let detail = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
      throw ProbeFailure(
        message: "channel \(index): the write on the statement after attach threw — \(detail). "
          + "attach returned before Citadel handed over the stdin writer."
      )
    }
    channels.append(channel)
  }

  try await waitUntil("the server to receive all \(count) execs") { remote.commands.count == count }
  for index in 0..<count {
    let command = "herdr-probe-write-\(index)"
    let expected = "prelude-\(index)"
    try await waitUntil("stdin of \(command)") {
      String(data: remote.stdin(of: command), encoding: .utf8) == expected
    }
  }
  // Obligation 2: the command crossed verbatim. Obligation 5 / blocker B8: one exec per channel,
  // never two, so a phone does not leave a second `herdr` running on the remote per request.
  try await expect(
    remote.commands.sorted() == (0..<count).map { "herdr-probe-write-\($0)" }.sorted(),
    "the server saw \(remote.commands) rather than one exec per channel with the command verbatim"
  )
  // The inbound half, end to end: the echo came back as CHANNEL_DATA, through `deliver`, over the
  // JS-thread hop, into `onData`.
  try await waitUntil("onData to deliver every echoed byte") {
    recorder.stdout.count == (0..<count).reduce(0) { $0 + "prelude-\($1)".utf8.count }
  }

  for channel in channels {
    channel.close()
  }
  try await waitUntil("every channel to be torn down on the remote") { remote.channelsClosed == count }
  try await waitUntil("onClose for every channel") { recorder.closePayloads.count == count }

  return "write-after-attach: \(count)/\(count) channels writable on the statement after attach, "
    + "\(recorder.stdout.count) bytes echoed back, \(remote.channelsClosed) execs closed on the remote"
}

/// The other half of the contract: an exec the server refuses must still release `attach`.
///
/// The latch that fixes the race is only safe if *every* path opens it. This one never reaches
/// Citadel's closure at all — the server has no exec delegate, so it answers the exec request with
/// `ChannelFailure` (Citadel 0.12.1 ExecHandler.swift:78-82) — and if `finish` did not open the
/// latch, `openChannel` would hang until the app's own watchdog fired instead of reporting the
/// failure through `onClose`. It also pins obligation 9 from the other side: a write on a channel
/// that is already gone resolves, it does not throw.
private func scenarioExecRefused(client: SSHClient, context: AppContext) async throws -> String {
  let recorder = Recorder()
  let channel = HerdrSshChannel(
    onData: recorder.onData,
    onClose: recorder.onClose,
    jsContext: context
  )
  let started = Date()
  try await channel.attach(client: client, command: "herdr-probe-refused") { _ in }
  let elapsed = Date().timeIntervalSince(started) * 1000

  try await expect(elapsed < 5000, "attach took \(elapsed) ms on a refused exec")
  try await waitUntil("onClose after a refused exec") { recorder.closePayloads.count == 1 }
  try await expect(
    recorder.closePayloads.count == 1,
    "onClose fired \(recorder.closePayloads.count) times, not once"
  )
  let payload = recorder.closePayloads[0]
  try await expect(
    payload["errorMessage"] is String,
    "a refused exec must reach JS as an errorMessage, got \(payload)"
  )
  // Obligation 9: write racing a close is normal traffic, not an error.
  try await channel.write(Data("after-the-end".utf8))

  return "exec-refused: attach released in \(String(format: "%.2f", elapsed)) ms, one onClose carrying "
    + "\(payload["errorMessage"] ?? "<none>"), a later write did not throw"
}

@main
enum WriteRaceProbe {
  static func main() async {
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 4)
    var failures = 0
    do {
      // `jsContext` is weak on the channel — it is the app context that owns the registry that
      // owns the channel — so the probe has to hold this itself or every delivery is dropped.
      let context = AppContext()
      let acceptingRemote = RemoteRecorder(acceptsExec: true)
      let refusingRemote = RemoteRecorder(acceptsExec: false)
      let (execServer, execPort) = try await hostServer(group: group, recorder: acceptingRemote)
      let (refusingServer, refusingPort) = try await hostServer(group: group, recorder: refusingRemote)
      let execClient = try await dial(port: execPort)
      let refusedClient = try await dial(port: refusingPort)

      let scenarios: [(String, () async throws -> String)] = [
        (
          "write-after-attach",
          { try await scenarioWriteImmediatelyAfterAttach(
            remote: acceptingRemote,
            client: execClient,
            context: context
          ) }
        ),
        ("exec-refused", { try await scenarioExecRefused(client: refusedClient, context: context) })
      ]
      for (name, scenario) in scenarios {
        do {
          print("  ok   " + (try await scenario()))
        } catch let failure as ProbeFailure {
          failures += 1
          print("  FAIL " + name + ": " + failure.message)
        } catch {
          failures += 1
          print("  FAIL " + name + ": " + String(describing: error))
        }
      }

      try? await execClient.close()
      try? await refusedClient.close()
      try? await execServer.close().get()
      try? await refusingServer.close().get()
    } catch {
      print("  FAIL harness: " + String(describing: error))
      failures += 1
    }
    if failures > 0 {
      print("writerace: \(failures) scenario(s) failed")
      exit(1)
    }
    print("herdr-ssh: HerdrSshSession.swift's attach returns a writable channel (2 scenarios)")
    exit(0)
  }
}
