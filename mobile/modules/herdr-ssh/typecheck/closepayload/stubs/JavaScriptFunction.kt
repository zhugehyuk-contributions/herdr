package expo.modules.kotlin.jni

import expo.modules.kotlin.AppContext
import expo.modules.kotlin.JavaScriptObject

/**
 * ../../stubs/JavaScriptFunction.kt with an observation point.
 *
 * The call signature is the shared stub's, verbatim — run.sh diffs the two so a change there cannot
 * silently make this harness compile code the module could not. What is added is the `record`
 * hook: this harness *runs* the module, and `onClose` is where the payload under test appears, so
 * something has to be able to see it. The shared stub cannot grow one without weakening what it is
 * (a type-check surface that must stay as inert as the real class is opaque).
 *
 * The return is `Unit as ReturnType` rather than the shared stub's `null as ReturnType` for the
 * same reason: nothing executes there, and here `null` would be a return value the caller can trip
 * over. Only `JavaScriptFunction<Unit>` is ever instantiated, in this harness and in the module.
 */
class JavaScriptFunction<ReturnType : Any?>(
  private val record: (Array<out Any?>) -> Unit = {}
) {
  @Suppress("UNCHECKED_CAST")
  operator fun invoke(
    vararg args: Any?,
    thisValue: JavaScriptObject? = null,
    appContext: AppContext? = null
  ): ReturnType {
    record(args)
    return Unit as ReturnType
  }
}
