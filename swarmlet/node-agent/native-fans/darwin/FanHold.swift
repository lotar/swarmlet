import Foundation
import Darwin

/// A pipe-owned cooling request. No launch daemon, socket, or arbitrary targets.
/// EOF, signals, malformed input, and a lost heartbeat all restore automatic mode.
public func holdMaximum(_ controller: FanController, watchdogSeconds: TimeInterval = 10) throws {
    let lock = NSLock()
    var stopping = false
    let signals = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
        source.setEventHandler { lock.lock(); stopping = true; lock.unlock() }
        source.resume()
        return source
    }
    defer { for source in signals { source.cancel() } }
    var previousHeartbeat = ProcessInfo.processInfo.systemUptime
    var receivedHeartbeat = false
    var pending = ""
    var failure: Error?
    do {
        while true {
            lock.lock(); let stop = stopping; lock.unlock()
            if stop { break }
            let now = ProcessInfo.processInfo.systemUptime
            if now - previousHeartbeat >= watchdogSeconds { break }
            var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN | POLLHUP), revents: 0)
            let result = poll(&descriptor, 1, 200)
            if result < 0 {
                if errno == EINTR { continue }
                throw FanCtlError.smc("Fan heartbeat pipe failed")
            }
            if result > 0 {
                var bytes = [UInt8](repeating: 0, count: 64)
                let count = read(STDIN_FILENO, &bytes, bytes.count)
                if count == 0 { break }
                guard count > 0, let text = String(bytes: bytes.prefix(count), encoding: .utf8) else {
                    throw FanCtlError.smc("Invalid fan heartbeat")
                }
                pending += text
                while let end = pending.firstIndex(of: "\n") {
                    guard pending[..<end] == "ping" else { throw FanCtlError.smc("Invalid fan heartbeat") }
                    pending.removeSubrange(...end)
                    previousHeartbeat = ProcessInfo.processInfo.systemUptime
                    if !receivedHeartbeat { receivedHeartbeat = true; print("ready"); fflush(stdout) }
                }
                guard pending.utf8.count <= 4 else { throw FanCtlError.smc("Invalid fan heartbeat") }
            }
            if receivedHeartbeat {
                // Firmware can replace a target while accepting its write. Reassert
                // the bounded maximum; actual RPM remains independently measured.
                do { try controller.setMax() }
                catch FanCtlError.smcVerifyFailed { }
            }
        }
    } catch { failure = error }
    do { try controller.autoAll() } catch { if failure == nil { failure = error } }
    if let failure { throw failure }
}
