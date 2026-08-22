package expo.modules.kotlin.jni
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.JavaScriptObject
// Faithful to expo/modules/kotlin/jni/JavaScriptFunction.kt:14,22
class JavaScriptFunction<ReturnType : Any?> {
  @Suppress("UNCHECKED_CAST")
  operator fun invoke(
    vararg args: Any?,
    thisValue: JavaScriptObject? = null,
    appContext: AppContext? = null
  ): ReturnType = null as ReturnType
}
