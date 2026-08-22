// Not from orca.
//
// Compiled and exercised by `modules/herdr-ssh/typecheck/`. See the header of `HerdrSshModule.kt`
// for what that proves and what it does not.
//
// The sshj plumbing: dialing, one connection with N sessions, and the translation of one
// `Session.Command` into the `(onData, onClose)` pair the TypeScript side handed over.
package dev.herdr.ssh

import expo.modules.kotlin.AppContext
import expo.modules.kotlin.jni.JavaScriptFunction
import expo.modules.kotlin.sharedobjects.SharedObject
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.security.Security
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.verification.FingerprintVerifier
import net.schmizz.sshj.transport.verification.PromiscuousVerifier
import net.schmizz.sshj.userauth.password.PasswordFinder
import net.schmizz.sshj.userauth.password.Resource
import org.bouncycastle.jce.provider.BouncyCastleProvider

/** How many bytes a pump hands to JS at once. Chunk boundaries are meaningless to the framer. */
private const val PUMP_BUFFER = 32 * 1024

/**
 * How long a close waits for the channel's own `CHANNEL_CLOSE` before giving up on the exit status.
 *
 * Sized against a phone's link, not against sshj's: `conn.getTimeoutMs()` is `connectTimeoutMs`
 * (20 s, `HerdrSshModule.kt:32`) and that is a *dial* budget. Here the packet being waited for is
 * already on its way — the remote command has exited, so `exit-status` and `CHANNEL_CLOSE` are one
 * round trip behind the EOF we just read. 2 s is an order of magnitude more than an LTE round trip
 * including its tail, and short enough that the supervisor above (`src/transport/`) gets its verdict
 * inside one reconnect cycle. A remote that has not closed by then is not going to.
 */
private const val CHANNEL_CLOSE_TIMEOUT_MS = 2000L

/**
 * How long a close then waits for the pumps to hand over what the streams still hold.
 *
 * By this point the channel is closed, so both streams are at EOF (`AbstractChannel.gotClose`,
 * sshj 0.40.0 AbstractChannel.java:219-227, closes the streams before it sets the close event) and
 * a pump has only to move already-buffered bytes into memory — microseconds of work, and 500 ms
 * survives a thread that is descheduled several times on the way. The budget is only ever spent in
 * full when a pump is stuck on a stream that never ended, which is the case the bound exists for.
 */
private const val PUMP_DRAIN_TIMEOUT_MS = 500L

/**
 * Replaces Android's cut-down "BC" security provider with the full BouncyCastle one.
 *
 * Android registers its own stripped BouncyCastle under the name "BC", and it takes precedence over
 * the copy sshj depends on. The omission that matters here is X25519: `curve25519-sha256` is the
 * key exchange every modern OpenSSH offers first, so the very first connection fails with
 * `TransportException: no such algorithm: X25519 for provider BC` — long before authentication.
 * Observed on an API 36 emulator, 2026-08-22; it is not reproducible on the JVM, where "BC" is
 * already the full provider.
 *
 * Idempotent and called from [HerdrSshDialer.dial] rather than from an initializer, so the cost is
 * paid by the first connection instead of by app start.
 */
private object BouncyCastleSetup {
  private var installed = false

  @Synchronized
  fun ensureInstalled() {
    if (installed) return
    Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
    Security.insertProviderAt(BouncyCastleProvider(), 1)
    installed = true
  }
}

object HerdrSshDialer {
  fun dial(config: HerdrSshConnectConfig): SSHClient {
    BouncyCastleSetup.ensureInstalled()
    val client = SSHClient()
    // Host keys are policy, so the policy is a value in the source rather than an omission. A phone
    // has no `known_hosts` seeded by earlier sessions, and the credential at stake is an ssh key
    // with shell access (03-blockers.md B11) — so an unconfigured fingerprint is a refusal, and
    // accepting any key is something the caller had to ask for.
    val fingerprint = config.hostKeySha256?.trim().orEmpty()
    when {
      fingerprint.isNotEmpty() ->
        client.addHostKeyVerifier(
          FingerprintVerifier.getInstance(
            if (fingerprint.startsWith("SHA256:")) fingerprint else "SHA256:$fingerprint"
          )
        )
      config.allowUnknownHostKey -> client.addHostKeyVerifier(PromiscuousVerifier())
      else -> throw IllegalArgumentException(
        "no host key fingerprint configured for ${config.host}"
      )
    }

    client.connectTimeout = config.connectTimeoutMs
    client.timeout = config.connectTimeoutMs
    client.connect(config.host, config.port)
    // ssh-level keepalive only. Detecting a link that is up but silent is the app-level watchdog's
    // job (05-orca-transport.md L1) and lives above this module.
    client.connection.keepAlive.keepAliveInterval =
      TimeUnit.MILLISECONDS.toSeconds(config.keepaliveIntervalMs.toLong()).toInt().coerceAtLeast(1)

    // `client.loadKeys` and NOT `OpenSSHKeyFile` directly. The provider has to match the file
    // format, and `OpenSSHKeyFile` only reads the classic PEM one (`BEGIN RSA PRIVATE KEY` and
    // friends). Every key `ssh-keygen` has produced since OpenSSH 7.8 is the newer openssh-key-v1
    // container (`BEGIN OPENSSH PRIVATE KEY`), which needs `OpenSSHKeyV1KeyFile`.
    //
    // The failure mode when this is wrong is quiet and misleading: the key simply does not load, so
    // sshj offers the server no publickey method at all and reports
    // `UserAuthException: Exhausted available authentication methods` — which reads like the server
    // rejected us, when in fact we never asked. Observed on device 2026-08-22: the server's DEBUG3
    // log showed a completed `curve25519-sha256` KEX and an accepted `ssh-userauth` service request
    // followed by no authentication attempt whatsoever.
    //
    // `loadKeys` sniffs the header (`KeyProviderUtil.detectKeyFileFormat` -> `KeyFormat.OpenSSHv1`)
    // and picks the registered provider (`DefaultConfig:158`), so both formats work and neither is
    // hardcoded here.
    val passwordFinder = config.passphrase?.takeIf { it.isNotEmpty() }?.let { passphrase ->
      // NOT a lambda: `PasswordFinder` declares two abstract methods (`reqPassword` and
      // `shouldRetry`, sshj 0.40.0 PasswordFinder.java:13,25), so Kotlin SAM conversion does not
      // apply. `shouldRetry = false` is the deliberate half: the passphrase came from the caller in
      // one shot, so retrying just re-offers the same wrong secret and burns auth attempts.
      object : PasswordFinder {
        override fun reqPassword(resource: Resource<*>?): CharArray = passphrase.toCharArray()

        override fun shouldRetry(resource: Resource<*>?): Boolean = false
      }
    }
    val keys = client.loadKeys(config.privateKey, null, passwordFinder)
    client.authPublickey(config.username, keys)
    return client
  }
}

/**
 * One host: **one** [SSHClient], however many channels.
 *
 * Obligation 5 is structural — `openChannel` calls `startSession()`, which opens a new ssh channel
 * on the existing connection, and there is no second `connect` below this line. Each extra
 * connection would be another TCP handshake, another key exchange and another sshd session on a
 * link that is a phone's LTE.
 */
class HerdrSshConnection(
  private val client: SSHClient,
  private val context: AppContext?
) : SharedObject() {
  private val channels = CopyOnWriteArrayList<HerdrSshChannel>()

  fun openChannel(
    command: String,
    onData: JavaScriptFunction<Unit>,
    onClose: JavaScriptFunction<Unit>
  ): HerdrSshChannel {
    val session = client.startSession()
    // No `allocateDefaultPTY()` — obligation 1. Both bridges are pure byte pumps
    // (`src/remote/unix.rs:568-590`) and a pty puts a line discipline in front of them: CR/LF
    // translation and echo rewrite bytes *inside* every framed payload, silently.
    //
    // `command` is passed through exactly as `remoteBridgeCommand()` produced it — obligation 2.
    val exec = session.exec(command)
    val channel = HerdrSshChannel(session, exec, onData, onClose, context) { done ->
      channels.remove(done)
    }
    channels.add(channel)
    channel.start()
    return channel
  }

  fun disconnect() {
    for (channel in channels) {
      channel.close()
    }
    channels.clear()
    runCatching { client.disconnect() }
  }
}

/** One exec channel. */
class HerdrSshChannel(
  private val session: Session,
  private val exec: Session.Command,
  private val onData: JavaScriptFunction<Unit>,
  private val onClose: JavaScriptFunction<Unit>,
  private val context: AppContext?,
  private val onFinished: (HerdrSshChannel) -> Unit
) : SharedObject() {
  private val pumps = Executors.newFixedThreadPool(2)
  private val stderr = StringBuilder()
  private val stdin: OutputStream = exec.outputStream

  @Volatile private var finished = false

  fun start() {
    pumps.execute { pumpStdout() }
    pumps.execute { pumpStderr() }
  }

  /**
   * stdout -> `onData`, in order and exactly once (obligation 6).
   *
   * One thread, one `InputStream`, one hand-off per read: ordering is the single reader's, and
   * nothing re-delivers. That matters more than it sounds — the consumer is a length-prefixed
   * framer, so a reordered chunk does not cost an event, it desynchronizes the frame boundary.
   */
  private fun pumpStdout() {
    pump(exec.inputStream) { bytes ->
      // A fresh array per chunk, because it crosses into JS: obligation 7 says the buffer is the
      // transport's and valid only for the call, and the JSI conversion copies it again on the way
      // in (`JNIToJSIConverter.cpp:16-25`). Reusing this one would alias a buffer JS may still be
      // reading during that copy.
      context?.executeOnJavaScriptThread { runCatching { onData.invoke(bytes) } }
    }
    finish()
  }

  /** stderr -> the close payload (obligation 3): the bridges have no other error channel. */
  private fun pumpStderr() {
    pump(exec.errorStream) { bytes ->
      synchronized(stderr) { stderr.append(String(bytes, Charsets.UTF_8)) }
    }
  }

  private fun pump(stream: InputStream, sink: (ByteArray) -> Unit) {
    val buffer = ByteArray(PUMP_BUFFER)
    try {
      while (true) {
        val read = stream.read(buffer)
        if (read <= 0) {
          break
        }
        sink(buffer.copyOf(read))
      }
    } catch (_: Exception) {
      // A closed channel reads as an exception on both streams; `finish` reports the end once.
    }
  }

  /**
   * Obligation 8: returns once the bytes are in the ssh session's outbound path. Not a delivery
   * receipt — this protocol has none, and the only end-to-end confirmation is a reply on the same
   * channel.
   */
  fun write(bytes: ByteArray) {
    if (finished) {
      // Obligation 9: a write racing a close is normal traffic on an asynchronous teardown. The
      // TypeScript layer already drops these; this is the same answer from the other side.
      return
    }
    synchronized(stdin) {
      stdin.write(bytes)
      stdin.flush()
    }
  }

  fun close() {
    runCatching { stdin.close() }
    runCatching { exec.close() }
    runCatching { session.close() }
    finish()
  }

  private fun finish() {
    if (finished) {
      return
    }
    synchronized(this) {
      if (finished) {
        return
      }
      finished = true
    }
    // The payload is assembled on a thread of its own because [completeClose] blocks, and neither
    // caller can host that wait. `pumpStdout` runs on `pumps`, and waiting for that pool from
    // inside one of its own threads waits for itself — it would time out every time, by
    // construction. `close()` runs on the JS thread, where seconds of blocking is an ANR. Nothing
    // above this file sees a new shape: `onClose` was already delivered asynchronously via
    // `executeOnJavaScriptThread`.
    val closer = Thread({ completeClose() }, "herdr-ssh-close")
    closer.isDaemon = true
    closer.start()
  }

  /**
   * Assembles the close payload once everything that can still add to it has arrived.
   *
   * Two pieces of evidence arrive *after* the EOF that wakes `pumpStdout`, and reading the payload
   * at EOF — `shutdownNow()` and then straight into `exitStatus` — lost both:
   *
   * - **The exit status.** `exit-status` is its own channel request, handled in
   *   `SessionChannel.handleRequest` (sshj 0.40.0 SessionChannel.java:133-134); nothing in the
   *   protocol ties it to EOF, which is why sshj's own javadoc says "Always call `close()` first
   *   before inspecting the exit status" (Session.java:64-70). Read at EOF it is legitimately
   *   `null`, and a null `exitCode` is not a blank in a log line: `src/transport/channel-failure.ts`
   *   reads `close.exitCode === 127` as a **field** to say "no `herdr` on the remote PATH, stop
   *   retrying". No stderr text substitutes for it.
   * - **The tail of stderr.** One `CHANNEL_EOF` ends both streams at once
   *   (`SessionChannel.eofInputStreams`, :205-209), but each `ChannelInputStream` owns its buffer
   *   and keeps serving it after EOF (ChannelInputStream.java:94-98) — so when the stdout pump
   *   reaches EOF first, the stderr pump is typically still moving bytes. The old shape did not
   *   wait for it *at all*: `shutdownNow()` returns immediately, and the snapshot two lines later
   *   took whatever had been appended by then. The interrupt only makes it worse, and only
   *   sometimes — a pump blocked with nothing buffered dies of it (ChannelInputStream.java:106-111
   *   turns the interrupt into an `InterruptedIOException`, which `pump` swallows as a normal end),
   *   while one with bytes available keeps reading (:94-98), too late to be in the payload. stderr
   *   is the bridges' only error channel, and the half that gets cut is where `Permission denied
   *   (publickey)` lives — losing it demotes a fatal auth verdict to `transport`, which the app
   *   retries forever on a key only the user can fix.
   *
   * So: wait for the close, then let the pumps drain, then snapshot. Both waits are bounded,
   * because this runs on a phone and a remote that never sends `CHANNEL_CLOSE` must not hold
   * `onClose` open forever. When a bound is hit the payload is still delivered with whatever is in
   * hand — a late and partial close beats no close — and `errorMessage` says which bound was hit,
   * so an absent `exitCode` reads as "not observed" rather than as "the command did not report one".
   */
  private fun completeClose() {
    val closeFailure = runCatching {
      exec.join(CHANNEL_CLOSE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }.exceptionOrNull()
    // `shutdown` and not `shutdownNow`: "stop pumping" is the wrong instruction for a pump that
    // still has buffered bytes to move. This one refuses new work and lets the running pumps run
    // out, which after the join above means draining a stream that is already at EOF. The interrupt
    // is kept for the case it is actually for — a pump still blocked on a stream that never ended.
    pumps.shutdown()
    val drained = runCatching {
      pumps.awaitTermination(PUMP_DRAIN_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }.getOrDefault(false)
    if (!drained) {
      pumps.shutdownNow()
    }
    val payload = mutableMapOf<String, Any?>()
    exec.exitStatus?.let { payload["exitCode"] = it }
    exec.exitSignal?.let { payload["signal"] = it.name }
    val transcript = synchronized(stderr) { stderr.toString() }
    if (transcript.isNotEmpty()) {
      payload["stderr"] = transcript
    }
    val incomplete = mutableListOf<String>()
    if (closeFailure != null) {
      incomplete.add(
        "the channel did not close within $CHANNEL_CLOSE_TIMEOUT_MS ms" +
          " (${closeFailure.message}), so the exit status may be missing"
      )
    }
    if (!drained) {
      incomplete.add(
        "a stream pump was still running after $PUMP_DRAIN_TIMEOUT_MS ms," +
          " so stderr may be truncated"
      )
    }
    if (incomplete.isNotEmpty()) {
      // Deliberately not a new field: `NativeChannelClose` (`../src/native-types.ts`) has four, and
      // `errorMessage` is the one that means "the local side, not the remote command". It becomes
      // `close.error` in `ssh-transport.ts:58-60`, which `classifyChannelFailure` reads as text —
      // and this text matches none of its fatal patterns, so an incomplete close stays retryable.
      // That is the right verdict: a bound was hit, so we do not know what happened.
      payload["errorMessage"] = incomplete.joinToString("; ", prefix = "herdr-ssh: ")
    }
    context?.executeOnJavaScriptThread { runCatching { onClose.invoke(payload) } }
    onFinished(this)
  }
}
