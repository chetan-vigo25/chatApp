import Foundation

/// Lock-guarded value: the uploader's ready flag is flipped from the ReplayKit
/// sample thread and from the socket's network thread.
@propertyWrapper
struct Atomic<Value> {
  private var value: Value
  private let lock = NSLock()

  init(wrappedValue value: Value) {
    self.value = value
  }

  var wrappedValue: Value {
    get { load() }
    set { store(newValue: newValue) }
  }

  func load() -> Value {
    lock.lock()
    defer { lock.unlock() }
    return value
  }

  mutating func store(newValue: Value) {
    lock.lock()
    defer { lock.unlock() }
    value = newValue
  }
}
