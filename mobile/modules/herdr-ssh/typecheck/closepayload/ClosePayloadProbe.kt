// Not from orca. Runs the REAL `HerdrSshChannel` close path against sshj 0.40.0's own stream
// classes and asserts what comes out of `onClose`.
//
// The scenarios are driven through a channel object shaped like sshj's own: `SessionChannel`
// implements `Session` and `Session.Command` with one class (SessionChannel.java:31-33), and so
// does [FakeChannel]. Both its streams are real `ChannelInputStream`s, so the buffering, the EOF
// rule and the interrupt behaviour under test are sshj's code and not an imitation of it — see
// run.sh for what that does and does not buy.
package dev.herdr.ssh

import expo.modules.kotlin.AppContext
import expo.modules.kotlin.jni.JavaScriptFunction
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.lang.reflect.Proxy
import java.nio.charset.Charset
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import net.schmizz.sshj.ConfigImpl
import net.schmizz.sshj.common.LoggerFactory
import net.schmizz.sshj.common.Message
import net.schmizz.sshj.common.SSHException
import net.schmizz.sshj.common.SSHPacket
import net.schmizz.sshj.connection.ConnectionException
import net.schmizz.sshj.connection.channel.ChannelInputStream
import net.schmizz.sshj.connection.channel.Window
import net.schmizz.sshj.connection.channel.direct.PTYMode
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.connection.channel.direct.Signal
import net.schmizz.sshj.transport.Transport

private const val MAX_PACKET = 32 * 1024
private const val WINDOW = 2L * 1024 * 1024

/** One extended-data packet's worth of stderr, in the size sshj would actually receive it. */
private const val STDERR_CHUNK = 24 * 1024

private class ProbeFailure(message: String) : AssertionError(message)

private fun require(condition: Boolean, message: () -> String) {
  if (!condition) {
    throw ProbeFailure(message())
  }
}

/**
 * A stream that delays each read, wrapped around the real stderr `ChannelInputStream`.
 *
 * This does NOT create the race — the race is that `finish()` snapshots the transcript without
 * waiting for the stderr pump at all, so any nonzero drain time loses bytes. What the delay does is
 * fix the timing of an interleaving that is otherwise decided by the scheduler, so the check is a
 * verdict rather than a coin toss. On a phone the same interleaving comes for free: a pump thread
 * that is descheduled once between reads is mid-drain when stdout's EOF arrives.
 *
 * Everything else is the real stream's: buffering, serving buffered bytes after EOF
 * (ChannelInputStream.java:94-98), and dying on interrupt (ChannelInputStream.java:106-111) — an
 * interrupted `Thread.sleep` here throws exactly where an interrupted `buf.wait()` would.
 */
private class PacedStream(private val inner: InputStream, private val delayMs: Long) : InputStream() {
  override fun read(): Int {
    pace()
    return inner.read()
  }

  override fun read(b: ByteArray, off: Int, len: Int): Int {
    pace()
    return inner.read(b, off, len)
  }

  override fun available(): Int = inner.available()

  override fun close() = inner.close()

  private fun pace() {
    if (delayMs > 0) {
      Thread.sleep(delayMs)
    }
  }
}

/**
 * The channel the module is handed, scripted packet by packet.
 *
 * Only the members the module actually reaches are implemented; every other one throws, so a
 * dependency this harness does not model shows up as a loud failure instead of a green run against
 * a convenient default.
 */
private class FakeChannel(
  private val stderrPaceMs: Long = 0,
  private val closeRefusedByPeer: Boolean = false
) : Session, Session.Command {
  private val config = ConfigImpl()

  // Only `getConfig` (for the circular buffer bound) and `write` (window adjustments) are reached
  // from `ChannelInputStream`; anything else means this harness has stopped modelling sshj.
  private val transport: Transport = Proxy.newProxyInstance(
    Transport::class.java.classLoader,
    arrayOf<Class<*>>(Transport::class.java)
  ) { _, method, _ ->
    when (method.name) {
      "getConfig" -> config
      "write" -> 0L
      "toString" -> "probe-transport"
      "hashCode" -> 1
      "equals" -> false
      else -> throw UnsupportedOperationException("probe transport: Transport." + method.name)
    }
  } as Transport

  private val stdoutStream =
    ChannelInputStream(this, transport, Window.Local(WINDOW, MAX_PACKET, LoggerFactory.DEFAULT))
  private val stderrStream =
    ChannelInputStream(this, transport, Window.Local(WINDOW, MAX_PACKET, LoggerFactory.DEFAULT))
  private val pacedStderr = PacedStream(stderrStream, stderrPaceMs)
  private val stdin = ByteArrayOutputStream()
  private val closeEvent = CountDownLatch(1)

  @Volatile private var status: Int? = null

  fun deliverStdout(bytes: ByteArray) {
    stdoutStream.receive(bytes, 0, bytes.size)
  }

  fun deliverStderr(bytes: ByteArray) {
    stderrStream.receive(bytes, 0, bytes.size)
  }

  /** One CHANNEL_EOF, which ends both streams at once — `SessionChannel.eofInputStreams` :205-209. */
  fun deliverEof() {
    stderrStream.eof()
    stdoutStream.eof()
  }

  /**
   * `exit-status` and then CHANNEL_CLOSE, in the order the connection's single reader thread would
   * apply them: `handleRequest` assigns the status (SessionChannel.java:133-134) before `gotClose`
   * sets the close event (AbstractChannel.java:219-227, :351-354).
   */
  fun deliverExitAndClose(exitStatus: Int?) {
    status = exitStatus
    stdoutStream.eof()
    stderrStream.eof()
    closeEvent.countDown()
  }

  override fun getInputStream(): InputStream = stdoutStream

  override fun getErrorStream(): InputStream = pacedStderr

  override fun getOutputStream(): OutputStream = stdin

  override fun getExitStatus(): Int? = status

  override fun getExitSignal(): Signal? = null

  override fun getExitErrorMessage(): String? = null

  override fun getExitWasCoreDumped(): Boolean? = null

  override fun join(timeout: Long, unit: TimeUnit) {
    if (!closeEvent.await(timeout, unit)) {
      // The shape sshj throws on a close that never arrives: `Event.await` -> `Promise.retrieve`
      // (Promise.java:140) chains a `TimeoutException("Timeout expired: ...")`.
      throw ConnectionException("Timeout expired: " + timeout + " " + unit)
    }
  }

  /** `AbstractChannel.close()` :255-267 — sends CHANNEL_CLOSE and awaits the peer's answer. */
  override fun close() {
    if (closeRefusedByPeer) {
      // A peer that never answers: the real one blocks for `conn.getTimeoutMs()` first (20 s here,
      // `HerdrSshModule.kt:32`) and then throws. The harness cannot afford the 20 s, and the wait is
      // the caller's problem, not this file's — see run.sh, "does not prove".
      Thread.sleep(50)
      throw ConnectionException("Timeout expired: 20000 MILLISECONDS")
    }
    deliverExitAndClose(status)
  }

  override fun getAutoExpand(): Boolean = false

  override fun getID(): Int = 1

  override fun getLocalMaxPacketSize(): Int = MAX_PACKET

  override fun getRecipient(): Int = 1

  override fun getLoggerFactory(): LoggerFactory = LoggerFactory.DEFAULT

  private fun unreached(name: String): Nothing =
    throw UnsupportedOperationException("probe channel: " + name + " is not modelled")

  override fun getLocalWinSize(): Long = unreached("getLocalWinSize")

  override fun getRemoteCharset(): Charset = unreached("getRemoteCharset")

  override fun getRemoteMaxPacketSize(): Int = unreached("getRemoteMaxPacketSize")

  override fun getRemoteWinSize(): Long = unreached("getRemoteWinSize")

  override fun getType(): String = unreached("getType")

  override fun isOpen(): Boolean = unreached("isOpen")

  override fun isEOF(): Boolean = unreached("isEOF")

  override fun setAutoExpand(autoExpand: Boolean) = unreached("setAutoExpand")

  override fun join() = unreached("join()")

  override fun handle(msg: Message, buf: SSHPacket) = unreached("handle")

  override fun notifyError(error: SSHException) = unreached("notifyError")

  override fun signal(signal: Signal) = unreached("signal")

  override fun allocateDefaultPTY() = unreached("allocateDefaultPTY")

  override fun allocatePTY(
    term: String,
    cols: Int,
    rows: Int,
    width: Int,
    height: Int,
    modes: MutableMap<PTYMode, Int>
  ) = unreached("allocatePTY")

  override fun exec(command: String): Session.Command = unreached("exec")

  override fun reqX11Forwarding(authProto: String, authCookie: String, screen: Int) =
    unreached("reqX11Forwarding")

  override fun setEnvVar(name: String, value: String) = unreached("setEnvVar")

  override fun startShell(): Session.Shell = unreached("startShell")

  override fun startSubsystem(name: String): Session.Subsystem = unreached("startSubsystem")
}

/** The JS side of the module, reduced to what it delivered. */
private class Recorder {
  private val closed = CountDownLatch(1)

  @Volatile private var payload: Map<*, *>? = null

  val stdout = ByteArrayOutputStream()

  val onData = JavaScriptFunction<Unit>({ args ->
    synchronized(stdout) { stdout.write(args[0] as ByteArray) }
  })

  val onClose = JavaScriptFunction<Unit>({ args ->
    payload = args[0] as Map<*, *>
    closed.countDown()
  })

  fun awaitClose(timeoutMs: Long): Map<*, *> {
    require(closed.await(timeoutMs, TimeUnit.MILLISECONDS)) {
      "onClose never fired within " + timeoutMs + " ms"
    }
    return payload!!
  }
}

private fun stderrText(chunks: Int): List<String> =
  (0 until chunks).map { index ->
    // Distinct per chunk, so a truncated transcript names the chunk it stopped at. The last one
    // carries the line the app's classifier actually reads (`src/transport/channel-failure.ts`).
    val tail = if (index == chunks - 1) "Permission denied (publickey)." else "filler"
    "[chunk " + index + "] " + tail.padEnd(STDERR_CHUNK - 24, '.') + "\n"
  }

private fun millisSince(startNanos: Long): Long =
  TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos)

/**
 * stdout EOFs while stderr still has buffered bytes, and the exit status arrives with the close.
 *
 * This is the shape the module sees whenever a bridge dies at startup: sh writes the diagnosis to
 * stderr, both streams end on one CHANNEL_EOF, and `exit-status` follows a round trip later.
 */
private fun scenarioEofThenClose(): String {
  val fake = FakeChannel(stderrPaceMs = 40)
  val recorder = Recorder()
  val channel = HerdrSshChannel(fake, fake, recorder.onData, recorder.onClose, AppContext()) {}
  channel.start()

  val chunks = stderrText(5)
  for (chunk in chunks) {
    fake.deliverStderr(chunk.toByteArray())
  }
  fake.deliverStdout("frame".toByteArray())
  val started = System.nanoTime()
  fake.deliverEof()
  val server = Thread {
    Thread.sleep(80)
    fake.deliverExitAndClose(127)
  }
  server.start()

  val payload = recorder.awaitClose(15_000)
  val elapsed = millisSince(started)
  server.join()

  val transcript = payload["stderr"] as String?
  val expected = chunks.joinToString("")
  require(transcript == expected) {
    "stderr was truncated: got " + (transcript?.length ?: 0) + " of " + expected.length +
      " bytes, ending in <<<" + (transcript?.takeLast(60) ?: "") + ">>>"
  }
  require(payload["exitCode"] == 127) {
    "exitCode was " + payload["exitCode"] + ", not 127 — classifyChannelFailure reads it as a field"
  }
  require(payload["errorMessage"] == null) {
    "an unbounded close should report no incompleteness, got " + payload["errorMessage"]
  }
  require(elapsed < 1500) { "close took " + elapsed + " ms; it should not have reached a bound" }
  return "eof-then-close: stderr " + expected.length + " bytes intact, exitCode=127, " + elapsed + " ms"
}

/** The channel EOFs and then never closes: the exit status is unknowable, the payload is not. */
private fun scenarioNeverCloses(): String {
  val fake = FakeChannel()
  val recorder = Recorder()
  val channel = HerdrSshChannel(fake, fake, recorder.onData, recorder.onClose, AppContext()) {}
  channel.start()

  val chunks = stderrText(2)
  for (chunk in chunks) {
    fake.deliverStderr(chunk.toByteArray())
  }
  val started = System.nanoTime()
  fake.deliverEof()

  val payload = recorder.awaitClose(15_000)
  val elapsed = millisSince(started)

  require(payload["stderr"] == chunks.joinToString("")) {
    "a bounded close must still carry the stderr it did collect"
  }
  require(payload["exitCode"] == null) { "no exit status was ever sent, so none may be reported" }
  val note = payload["errorMessage"] as String? ?: ""
  require(note.contains("did not close within 2000 ms")) {
    "the payload must say which bound it hit, got " + note
  }
  require(elapsed in 2000..6000) {
    "close arrived after " + elapsed + " ms; the 2000 ms bound is what should have released it"
  }
  return "never-closes: payload at " + elapsed + " ms, stderr intact, exitCode absent and labelled"
}

/** Nothing ever ends: the app closes the channel and the peer does not answer. */
private fun scenarioPeerWentSilent(): String {
  val fake = FakeChannel(closeRefusedByPeer = true)
  val recorder = Recorder()
  val channel = HerdrSshChannel(fake, fake, recorder.onData, recorder.onClose, AppContext()) {}
  channel.start()

  val chunks = stderrText(1)
  fake.deliverStderr(chunks[0].toByteArray())
  Thread.sleep(200)

  val started = System.nanoTime()
  channel.close()
  val callerBlocked = millisSince(started)

  val payload = recorder.awaitClose(15_000)
  val elapsed = millisSince(started)

  require(callerBlocked < 500) {
    "close() blocked its caller for " + callerBlocked + " ms; the waits belong on the closer thread"
  }
  require(payload["stderr"] == chunks[0]) { "the transcript collected before the stall must survive" }
  val note = payload["errorMessage"] as String? ?: ""
  require(note.contains("did not close within 2000 ms")) {
    "the close bound must be reported, got " + note
  }
  require(note.contains("still running after 500 ms")) {
    "the drain bound must be reported when a pump is stuck, got " + note
  }
  require(elapsed in 2400..8000) {
    "payload arrived after " + elapsed + " ms; both bounds together are 2500 ms"
  }
  return "peer-went-silent: caller free in " + callerBlocked + " ms, payload at " + elapsed +
    " ms with both bounds named"
}

fun main() {
  val scenarios = listOf(
    "eof-then-close" to ::scenarioEofThenClose,
    "never-closes" to ::scenarioNeverCloses,
    "peer-went-silent" to ::scenarioPeerWentSilent
  )
  var failed = 0
  for ((name, scenario) in scenarios) {
    val outcome = runCatching { scenario() }
    outcome.onSuccess { println("  ok   " + it) }
    outcome.onFailure {
      failed += 1
      println("  FAIL " + name + ": " + it.message)
    }
  }
  if (failed > 0) {
    println("closepayload: " + failed + " of " + scenarios.size + " scenarios failed")
    System.exit(1)
  }
  println("herdr-ssh: HerdrSshSession.kt delivers a complete close payload (3 scenarios)")
}
