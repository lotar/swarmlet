import Foundation

public enum FanKeys {
    public static let count = "FNum"
    public static let actual = "F%dAc"
    public static let target = "F%dTg"
    public static let minimum = "F%dMn"
    public static let maximum = "F%dMx"
    public static let forceTest = "Ftst"
    public static let modeUpper = "F%dMd"
    public static let modeLower = "F%dmd"

    public static func key(_ template: String, fan: Int) -> String {
        String(format: template, fan)
    }
}

public enum FanProfile: String, CaseIterable {
    case quiet
    case balanced
    case cool

    public var fraction: Double {
        switch self {
        case .quiet: return 0.35
        case .balanced: return 0.55
        case .cool: return 0.75
        }
    }
}

public struct FanInfo: Equatable {
    public let index: Int
    public let actualRPM: Int
    public let targetRPM: Int
    public let minRPM: Int
    public let maxRPM: Int
    public let manualMode: Bool

    public init(index: Int, actualRPM: Int, targetRPM: Int, minRPM: Int, maxRPM: Int, manualMode: Bool) {
        self.index = index
        self.actualRPM = actualRPM
        self.targetRPM = targetRPM
        self.minRPM = minRPM
        self.maxRPM = maxRPM
        self.manualMode = manualMode
    }
}

public enum FanCtlError: Error, Equatable, CustomStringConvertible {
    case invalidArguments(String)
    case invalidRPM(String)
    case noFans
    case rpmOutOfRange(rpm: Int, min: Int, max: Int, fan: Int)
    case smc(String)
    case firmware(UInt8)
    case keyNotFound(String)
    case noTemperatureSensors
    case smcWriteFailed(key: String, value: Int, underlying: String)
    case smcVerifyFailed(key: String, expected: Int, actual: Int)

    public var description: String {
        switch self {
        case .invalidArguments(let message), .invalidRPM(let message), .smc(let message): return message
        case .firmware(let code): return "SMC firmware error: \(code)"
        case .keyNotFound(let key): return "SMC key not found: \(key)"
        case .noTemperatureSensors: return "No valid temperature sensors found"
        case let .smcWriteFailed(key, value, underlying): return "write \(key)=\(value) failed: \(underlying)"
        case let .smcVerifyFailed(key, expected, actual): return "write \(key) did not stick: expected \(expected), got \(actual)"
        case .noFans: return "No fans detected"
        case let .rpmOutOfRange(rpm, min, max, fan):
            return "RPM \(rpm) is outside fan \(fan) range \(min)...\(max)"
        }
    }
}
