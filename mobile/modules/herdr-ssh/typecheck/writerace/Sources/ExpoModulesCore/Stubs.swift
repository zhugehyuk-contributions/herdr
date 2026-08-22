// The two Expo symbols `HerdrSshSession.swift` cannot have off a device, in the RECORDING variant
// this harness needs. Companion to ../ios/Sources/ExpoModulesCore/Stubs.swift, which is the one the
// type-check gate uses; that one is hand-matched to expo-modules-core and every signature here has
// to stay identical to it, which `run.sh` enforces by diffing the two declarations. The only
// difference allowed is behaviour:
//
//   - `JavaScriptFunction.call` invokes a recorded handler instead of `fatalError("stub")`, so
//     `onData`/`onClose` can be observed.
//   - `AppContext.executeOnJavaScriptThread` actually runs the closure instead of dropping it, so
//     the deliveries the module makes through it arrive. It hops onto `JavaScriptActor` rather than
//     running inline, because that is what the real one does — the JS thread is not the caller's.
import Foundation
public final class JavaScriptObject {}
@globalActor public actor JavaScriptActor {
  public static let shared = JavaScriptActor()
}
public final class AppContext {
  public init() {}
  public func executeOnJavaScriptThread(_ closure: @JavaScriptActor @escaping () -> Void) {
    Task { @JavaScriptActor in closure() }
  }
}
open class SharedObject {
  public internal(set) weak var appContext: AppContext?
  public init() {}
  open func sharedObjectWillRelease() {}
}
public final class JavaScriptFunction<ReturnType>: @unchecked Sendable {
  private let handler: ([Any]) -> ReturnType

  public init(_ handler: @escaping ([Any]) -> ReturnType) {
    self.handler = handler
  }

  public func call(_ arguments: Any..., usingThis this: JavaScriptObject? = nil) throws -> ReturnType {
    handler(arguments)
  }
}

public protocol AnyArgument {}
extension String: AnyArgument {}
extension Int: AnyArgument {}
extension Bool: AnyArgument {}
extension Optional: AnyArgument where Wrapped: AnyArgument {}
public protocol Record { init() }
@propertyWrapper
public final class Field<Type: AnyArgument>: @unchecked Sendable {
  public var wrappedValue: Type
  public init(wrappedValue: Type) { self.wrappedValue = wrappedValue }
  public init(wrappedValue: Type = nil) where Type: ExpressibleByNilLiteral { self.wrappedValue = wrappedValue }
}
