// Not from orca.
//
// ⚠️⚠️ **UNVERIFIED SOURCE.** Never compiled. See the header of `HerdrSshModule.kt`.
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
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.verification.FingerprintVerifier
import net.schmizz.sshj.transport.verification.PromiscuousVerifier
import net.schmizz.sshj.userauth.keyprovider.OpenSSHKeyFile

/** How many bytes a pump hands to JS at once. Chunk boundaries are meaningless to the framer. */
private const val PUMP_BUFFER = 32 * 1024

object HerdrSshDialer {
  fun dial(config: HerdrSshConnectConfig): SSHClient {
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

    val keys = OpenSSHKeyFile()
    if (config.passphrase.isNullOrEmpty()) {
      keys.init(config.privateKey, null)
    } else {
      keys.init(config.privateKey, null, { config.passphrase!!.toCharArray() })
    }
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
    pumps.shutdownNow()
    val payload = mutableMapOf<String, Any?>()
    exec.exitStatus?.let { payload["exitCode"] = it }
    exec.exitSignal?.let { payload["signal"] = it.name }
    val transcript = synchronized(stderr) { stderr.toString() }
    if (transcript.isNotEmpty()) {
      payload["stderr"] = transcript
    }
    context?.executeOnJavaScriptThread { runCatching { onClose.invoke(payload) } }
    onFinished(this)
  }
}
