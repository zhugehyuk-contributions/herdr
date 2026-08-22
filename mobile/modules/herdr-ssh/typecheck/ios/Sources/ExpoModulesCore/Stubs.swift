// Faithful stubs, matched by hand to expo-modules-core/ios/Core/.
// SharedObject.swift:13,28,33 — open class, public init, open func sharedObjectWillRelease
// JavaScriptFunction.swift:6,27 — final class, `call` is THROWS and variadic
import Foundation
public final class JavaScriptObject {}
// AppContext.swift:196 — the closure is isolated to the @JavaScriptActor global actor.
@globalActor public actor JavaScriptActor {
  public static let shared = JavaScriptActor()
}
public final class AppContext {
  public func executeOnJavaScriptThread(_ closure: @JavaScriptActor @escaping () -> Void) {}
}
// SharedObject.swift:13,23,28,33
open class SharedObject {
  public internal(set) weak var appContext: AppContext?
  public init() {}
  open func sharedObjectWillRelease() {}
}
public final class JavaScriptFunction<ReturnType>: @unchecked Sendable {
  public func call(_ arguments: Any..., usingThis this: JavaScriptObject? = nil) throws -> ReturnType {
    fatalError("stub")
  }
}

// Records/Field.swift:5,6,41,59 — @propertyWrapper final class, generic over AnyArgument,
// with a nil-defaulting init for ExpressibleByNilLiteral. Records/Record.swift:5,14 — protocol
// Record with a nonisolated init().
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
