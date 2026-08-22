package expo.modules.kotlin
// Faithful to node_modules/expo-modules-core/android/src/main/java/expo/modules/kotlin/AppContext.kt:382
class JavaScriptObject
class AppContext { fun executeOnJavaScriptThread(runnable: Runnable) { runnable.run() } }
