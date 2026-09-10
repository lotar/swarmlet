import Foundation

public final class FanController {
    private let backend: SMCBackend
    private let sleep: (TimeInterval) -> Void
    private let log: (String) -> Void

    public init(
        backend: SMCBackend,
        sleep: @escaping (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
        log: @escaping (String) -> Void = { _ in }
    ) {
        self.backend = backend
        self.sleep = sleep
        self.log = log
    }

    public func status() throws -> [FanInfo] {
        let count = try backend.readInt(FanKeys.count)
        guard count > 0 else { throw FanCtlError.noFans }
        guard count <= 16 else { throw FanCtlError.smc("Unsupported firmware fan count") }
        return try (0..<count).map { fan in
            let upperMode = try? backend.readInt(FanKeys.key(FanKeys.modeUpper, fan: fan))
            let lowerMode = try? backend.readInt(FanKeys.key(FanKeys.modeLower, fan: fan))
            return FanInfo(
                index: fan,
                actualRPM: try backend.readInt(FanKeys.key(FanKeys.actual, fan: fan)),
                targetRPM: try backend.readInt(FanKeys.key(FanKeys.target, fan: fan)),
                minRPM: try backend.readInt(FanKeys.key(FanKeys.minimum, fan: fan)),
                maxRPM: try backend.readInt(FanKeys.key(FanKeys.maximum, fan: fan)),
                manualMode: (upperMode ?? lowerMode ?? 0) != 0
            )
        }
    }

    public func targetRPM(for profile: FanProfile, fan: FanInfo) -> Int {
        let span = max(0, fan.maxRPM - fan.minRPM)
        let rpm = fan.minRPM + Int((Double(span) * profile.fraction).rounded())
        return min(max(rpm, fan.minRPM), fan.maxRPM)
    }

    public func setAll(rpm: Int) throws {
        let fans = try status()
        try validate(rpm: rpm, fans: fans)
        for fan in fans { try set(fan: fan.index, rpm: rpm) }
    }

    public func setMax() throws {
        let fans = try status()
        for fan in fans { try set(fan: fan.index, rpm: fan.maxRPM) }
    }

    public func setProfile(_ profile: FanProfile) throws {
        let fans = try status()
        let targets = fans.map { ($0.index, targetRPM(for: profile, fan: $0)) }
        for (fan, rpm) in targets { try set(fan: fan, rpm: rpm) }
    }

    public func autoAll() throws {
        let count = (try? backend.readInt(FanKeys.count)) ?? 0
        var firstError: Error?
        for fan in 0..<max(0, count) {
            do { try writeAutoMode(fan: fan) } catch { if firstError == nil { firstError = error } }
        }
        do { if try hasForceTest() { try write(FanKeys.forceTest, 0) } }
        catch { if firstError == nil { firstError = error } }
        if let firstError { throw firstError }
    }

    private func validate(rpm: Int, fans: [FanInfo]) throws {
        for fan in fans where rpm < fan.minRPM || rpm > fan.maxRPM {
            throw FanCtlError.rpmOutOfRange(rpm: rpm, min: fan.minRPM, max: fan.maxRPM, fan: fan.index)
        }
    }

    public func setFan(index fan: Int, rpm: Int) throws {
        let fans = try status()
        guard let info = fans.first(where: { $0.index == fan }) else { throw FanCtlError.invalidArguments("Unknown fan index: \(fan)") }
        try validate(rpm: rpm, fans: [info])
        try set(fan: fan, rpm: rpm)
    }

    private func set(fan: Int, rpm: Int) throws {
        try enableManualMode(fan: fan)
        let targetKey = FanKeys.key(FanKeys.target, fan: fan)
        try write(targetKey, rpm)
        sleep(0.1)
        let actual = try backend.readInt(targetKey)
        log("verify \(targetKey) expected=\(rpm) actual=\(actual)")
        if abs(actual - rpm) > 5 {
            throw FanCtlError.smcVerifyFailed(key: targetKey, expected: rpm, actual: actual)
        }
    }

    private func hasForceTest() throws -> Bool {
        do { _ = try backend.readInt(FanKeys.forceTest); return true }
        catch FanCtlError.keyNotFound(FanKeys.forceTest) { return false }
    }

    private func enableManualMode(fan: Int) throws {
        if try hasForceTest() {
            try write(FanKeys.forceTest, 1)
            sleep(0.5)
        }

        var lastError: Error?
        for _ in 0..<10 {
            for keyFormat in [FanKeys.modeUpper, FanKeys.modeLower] {
                let key = FanKeys.key(keyFormat, fan: fan)
                do {
                    try write(key, 1)
                    return
                } catch {
                    lastError = error
                }
            }
            sleep(0.1)
        }
        throw lastError ?? FanCtlError.smc("manual mode write failed")
    }

    private func write(_ key: String, _ value: Int) throws {
        log("write \(key)=\(value)")
        do {
            try backend.writeInt(key, value)
        } catch {
            log("write \(key)=\(value) failed: \(error)")
            throw FanCtlError.smcWriteFailed(key: key, value: value, underlying: "\(error)")
        }
    }

    private func writeAutoMode(fan: Int) throws {
        var errors: [Error] = []
        for key in [FanKeys.modeUpper, FanKeys.modeLower] {
            do { try write(FanKeys.key(key, fan: fan), 0); return }
            catch { errors.append(error) }
        }
        throw errors.first ?? FanCtlError.smc("auto mode write failed")
    }
}
