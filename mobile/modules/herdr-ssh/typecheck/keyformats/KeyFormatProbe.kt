// The assertions for ../run.sh's sibling gate (keyformats/run.sh). Read that header first.
//
// This file is harness, not a copy of the module: the code under test is `RealKeyLoad.load`, which
// run.sh generates by extracting the key-loading block verbatim out of HerdrSshSession.kt. Nothing
// here restates how the key is loaded, so nothing here can go green on a copy that has drifted.
package dev.herdr.ssh

import com.hierynomus.sshj.common.KeyDecryptionFailedException
import java.io.File
import kotlin.system.exitProcess
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.userauth.keyprovider.KeyProviderUtil

/**
 * One `ssh-keygen` output shape and what sshj must make of it.
 *
 * [format] is asserted separately from [type] because the two failure stories differ: a wrong
 * [format] means sshj's header sniffing changed under us, a wrong/absent [type] means the module
 * picked a provider that cannot read this container.
 *
 * [format] is what sshj detects for `separatePubKey = false`, which is the module's case — it holds
 * one string out of SecureStore and passes `null` for the public key. That argument changes the
 * answer for classic PEM: `PKCS8` without a public key, `OpenSSH` with one (SSHClient.loadKeys
 * forwards `publicKey != null`). Both land on a provider that reads classic PEM, so the key type is
 * the same either way; measure with the second argument the module actually passes, or the numbers
 * will not match.
 */
private class Fixture(
  val name: String,
  val passphrase: String?,
  val format: String,
  val type: String
)

/**
 * The first line of a failure, capped.
 *
 * Not cosmetic: sshj's 1-arg `loadKeys` reads its argument as a *file path*, so a provider that is
 * handed key text reports it back inside the exception message — the whole PEM body lands in the
 * gate output. The diagnosis is always on the first line (the header it choked on).
 */
private fun brief(failure: Throwable) = failure.toString().lineSequence().first().take(160)

private fun configOf(privateKey: String, passphrase: String?) =
  HerdrSshConnectConfig().also {
    it.privateKey = privateKey
    it.passphrase = passphrase
  }

fun main(args: Array<String>) {
  val dir = File(args[0])
  val passphrase = args[1]
  // The four rows measured on 2026-08-22. `ssh-keygen` has emitted openssh-key-v1 by default since
  // OpenSSH 7.8 for every algorithm, so RSA is here as its own row: the bug this gate exists for was
  // never ed25519-specific, and an "only ed25519 is affected" reading would license a partial fix.
  val fixtures = listOf(
    Fixture("ed25519-v1", null, "OpenSSHv1", "ssh-ed25519"),
    Fixture("rsa-v1", null, "OpenSSHv1", "ssh-rsa"),
    Fixture("rsa-pem", null, "PKCS8", "ssh-rsa"),
    Fixture("ed25519-v1-passphrase", passphrase, "OpenSSHv1", "ssh-ed25519")
  )
  val failures = mutableListOf<String>()

  for (fixture in fixtures) {
    val pem = File(dir, fixture.name).readText()
    val detected = runCatching { KeyProviderUtil.detectKeyFileFormat(pem, false).toString() }
      .getOrElse { "threw ${brief(it)}" }
    if (detected != fixture.format) {
      failures += "${fixture.name}: expected header format ${fixture.format}, sshj saw $detected"
    }
    // `type`/`private` and not just the load: a hardcoded provider accepts the wrong container at
    // init and only throws when the key is first read (OpenSSHKeyFile.getPublic), which is exactly
    // why the device symptom was a generic auth failure instead of a parse error. Reading both is
    // also what authPublickey does — the private half is what signs.
    val loaded = runCatching {
      val keys = RealKeyLoad.load(SSHClient(), configOf(pem, fixture.passphrase))
      val type = keys.type.toString()
      checkNotNull(keys.private) { "provider returned a null private key" }
      type
    }
    loaded.fold(
      onSuccess = { type ->
        if (type != fixture.type) {
          failures += "${fixture.name}: expected key type ${fixture.type}, module loaded $type"
        } else {
          println("  ok   ${fixture.name.padEnd(22)} $detected -> $type")
        }
      },
      onFailure = { failures += "${fixture.name}: module failed to load the key: ${brief(it)}" }
    )
  }

  // The passphrase must still be load-bearing. Without this row the `PasswordFinder` object could be
  // deleted and every row above would stay green on the three unencrypted fixtures.
  val encrypted = File(dir, "ed25519-v1-passphrase").readText()
  val withoutFinder = runCatching {
    val keys = RealKeyLoad.load(SSHClient(), configOf(encrypted, null))
    keys.private
  }
  // Any exception is not good enough: with a hardcoded provider this key fails to *parse*, which
  // would let a "refused without the finder" line print while the passphrase path was never reached.
  // The refusal has to come from decryption, so the row means what it says on its own.
  when (val refusal = withoutFinder.exceptionOrNull()) {
    null ->
      failures += "ed25519-v1-passphrase: decrypted WITHOUT a passphrase, so the PasswordFinder is dead code"
    !is KeyDecryptionFailedException ->
      failures +=
        "ed25519-v1-passphrase: refused without the finder, but never got as far as decryption: ${brief(refusal)}"
    else ->
      println("  ok   ${"passphrase required".padEnd(22)} refused without the finder: ${brief(refusal)}")
  }

  if (failures.isNotEmpty()) {
    System.err.println("herdr-ssh: key-format gate FAILED")
    failures.forEach { System.err.println("  FAIL $it") }
    exitProcess(1)
  }
}
