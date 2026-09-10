import Foundation
#if canImport(IOKit)
import IOKit
#endif

public final class AppleSMCBackend: SMCBackend {
    #if canImport(IOKit)
    private var connection: io_connect_t = 0

    public init() throws {
        var iterator: io_iterator_t = 0
        let matchResult = IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("AppleSMC"), &iterator)
        guard matchResult == kIOReturnSuccess else { throw FanCtlError.smc("AppleSMC matching failed: \(matchResult)") }
        defer { IOObjectRelease(iterator) }
        let service = IOIteratorNext(iterator)
        guard service != 0 else { throw FanCtlError.smc("AppleSMC service not found") }
        defer { IOObjectRelease(service) }
        let result = IOServiceOpen(service, mach_task_self_, 0, &connection)
        guard result == kIOReturnSuccess else { throw FanCtlError.smc("IOServiceOpen AppleSMC failed: \(result)") }
    }

    deinit { if connection != 0 { IOServiceClose(connection) } }

    public func readInt(_ key: String) throws -> Int {
        let info = try readKeyInfo(key)
        guard ["ui8 ": 1, "ui16": 2, "ui32": 4, "sp78": 2, "fpe2": 2, "flt ": 4][info.dataType] == Int(info.dataSize) else { throw FanCtlError.smc("Unsupported SMC format for \(key): \(info.dataType)") }
        let bytes = try readBytes(key, info: info)
        return SMCFormat.decodeInt(bytes: bytes, type: info.dataType)
    }

    public func temperatures() -> [[String: Any]] {
        guard let count = try? readInt("#KEY"), count > 0, count <= 16384 else { return [] }
        var readings: [[String: Any]] = []
        for index in 0..<count {
            var input = SMCParamStruct()
            input.data8 = 8
            input.data32 = UInt32(index)
            guard let result = try? call(input) else { continue }
            let key = SMCFormat.stringFromFourCharCode(result.key)
            guard key.hasPrefix("T"), let info = try? readKeyInfo(key), ["flt ", "sp78"].contains(info.dataType), let value = try? readInt(key), value > 0, value <= 130 else { continue }
            readings.append(["name": "SMC \(key)", "celsius": value])
        }
        return readings
    }

    public func writeInt(_ key: String, _ value: Int) throws {
        let info = try readKeyInfo(key)
        guard ["ui8 ": 1, "ui16": 2, "fpe2": 2, "flt ": 4][info.dataType] == Int(info.dataSize) else { throw FanCtlError.smc("Unsupported SMC format for \(key): \(info.dataType)") }
        let bytes = SMCFormat.encodeInt(value, type: info.dataType, size: Int(info.dataSize))
        try writeBytes(key, bytes: bytes, info: info)
    }

    private struct KeyInfo { let dataSize: UInt32; let dataType: String }

    private func readKeyInfo(_ key: String) throws -> KeyInfo {
        var input = SMCParamStruct()
        input.key = SMCFormat.fourCharCode(key)
        input.data8 = 9
        let output: SMCParamStruct
        do { output = try call(input) }
        catch FanCtlError.firmware(132) { throw FanCtlError.keyNotFound(key) }
        return KeyInfo(dataSize: output.keyInfo.dataSize, dataType: SMCFormat.stringFromFourCharCode(output.keyInfo.dataType))
    }

    private func readBytes(_ key: String, info: KeyInfo) throws -> [UInt8] {
        var input = SMCParamStruct()
        input.key = SMCFormat.fourCharCode(key)
        input.keyInfo.dataSize = info.dataSize
        input.keyInfo.dataType = SMCFormat.fourCharCode(info.dataType)
        input.data8 = 5
        let output = try call(input)
        return output.byteArray.prefix(Int(info.dataSize)).map { $0 }
    }

    private func writeBytes(_ key: String, bytes: [UInt8], info: KeyInfo) throws {
        var input = SMCParamStruct()
        input.key = SMCFormat.fourCharCode(key)
        input.keyInfo.dataSize = info.dataSize
        input.keyInfo.dataType = SMCFormat.fourCharCode(info.dataType)
        input.data8 = 6
        input.setBytes(bytes)
        _ = try call(input)
    }

    private func call(_ input: SMCParamStruct) throws -> SMCParamStruct {
        var inp = SMCParamStruct()
        withUnsafeMutableBytes(of: &inp) { rawBuffer in
            if let base = rawBuffer.baseAddress { memset(base, 0, rawBuffer.count) }
        }
        inp.key = input.key
        inp.data8 = input.data8
        inp.data32 = input.data32
        inp.keyInfo.dataSize = input.keyInfo.dataSize
        inp.keyInfo.dataType = input.keyInfo.dataType
        inp.bytes = input.bytes

        var out = SMCParamStruct()
        withUnsafeMutableBytes(of: &out) { rawBuffer in
            if let base = rawBuffer.baseAddress { memset(base, 0, rawBuffer.count) }
        }
        var outSize = MemoryLayout<SMCParamStruct>.stride
        let result = IOConnectCallStructMethod(
            connection, 2,
            &inp, MemoryLayout<SMCParamStruct>.stride,
            &out, &outSize
        )
        guard result == kIOReturnSuccess else { throw FanCtlError.smc("SMC call failed: \(result)") }
        guard out.result == 0 else { throw FanCtlError.firmware(out.result) }
        return out
    }
    #else
    public init() throws { throw FanCtlError.smc("AppleSMC is only available on macOS") }
    public func readInt(_ key: String) throws -> Int { throw FanCtlError.smc("AppleSMC is only available on macOS") }
    public func writeInt(_ key: String, _ value: Int) throws { throw FanCtlError.smc("AppleSMC is only available on macOS") }
    #endif
}

#if canImport(IOKit)
private typealias SMCBytes = (UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8)
private struct SMCVersion { var major: UInt8 = 0; var minor: UInt8 = 0; var build: UInt8 = 0; var reserved: UInt8 = 0; var release: UInt16 = 0 }
private struct SMCPLimitData { var version: UInt16 = 0; var length: UInt16 = 0; var cpuPLimit: UInt32 = 0; var gpuPLimit: UInt32 = 0; var memPLimit: UInt32 = 0 }
private struct SMCKeyInfoData { var dataSize: UInt32 = 0; var dataType: UInt32 = 0; var dataAttributes: UInt8 = 0 }

private struct SMCParamStruct {
    var key: UInt32 = 0
    var vers = SMCVersion()
    var pLimitData = SMCPLimitData()
    var keyInfo = SMCKeyInfoData()
    var padding: UInt16 = 0
    var result: UInt8 = 0
    var status: UInt8 = 0
    var data8: UInt8 = 0
    var data32: UInt32 = 0
    var bytes: SMCBytes = (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

    var byteArray: [UInt8] {
        [bytes.0, bytes.1, bytes.2, bytes.3, bytes.4, bytes.5, bytes.6, bytes.7,
         bytes.8, bytes.9, bytes.10, bytes.11, bytes.12, bytes.13, bytes.14, bytes.15,
         bytes.16, bytes.17, bytes.18, bytes.19, bytes.20, bytes.21, bytes.22, bytes.23,
         bytes.24, bytes.25, bytes.26, bytes.27, bytes.28, bytes.29, bytes.30, bytes.31]
    }

    mutating func setBytes(_ source: [UInt8]) {
        var arr = Array(repeating: UInt8(0), count: 32)
        for i in 0..<min(source.count, 32) { arr[i] = source[i] }
        bytes = (arr[0], arr[1], arr[2], arr[3], arr[4], arr[5], arr[6], arr[7],
                 arr[8], arr[9], arr[10], arr[11], arr[12], arr[13], arr[14], arr[15],
                 arr[16], arr[17], arr[18], arr[19], arr[20], arr[21], arr[22], arr[23],
                 arr[24], arr[25], arr[26], arr[27], arr[28], arr[29], arr[30], arr[31])
    }
}
#endif
