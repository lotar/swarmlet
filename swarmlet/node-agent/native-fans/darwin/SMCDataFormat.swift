import Foundation

public enum SMCFormat {
    public static func decodeInt(bytes: [UInt8], type: String) -> Int {
        guard !bytes.isEmpty else { return 0 }
        switch type.trimmingCharacters(in: .controlCharacters) {
        case "ui8", "ui8 ": return Int(bytes[0])
        case "ui16", "ui16 ": return bytes.count >= 2 ? Int(bytes[0]) << 8 | Int(bytes[1]) : Int(bytes[0])
        case "ui32": return bytes.reduce(0) { ($0 << 8) | Int($1) }
        case "sp78":
            guard bytes.count == 2 else { return -1 }
            return Int(Int16(bitPattern: UInt16(bytes[0]) << 8 | UInt16(bytes[1]))) / 256
        case "flt ":
            guard bytes.count >= 4 else { return 0 }
            let bitPattern = UInt32(bytes[3]) << 24 | UInt32(bytes[2]) << 16 | UInt32(bytes[1]) << 8 | UInt32(bytes[0])
            let value = Float(bitPattern: bitPattern)
            guard value.isFinite, value >= 0, value <= 100000 else { return -1 }
            return Int(value.rounded())
        case "fpe2":
            guard bytes.count >= 2 else { return 0 }
            let raw = Int(bytes[0]) << 8 | Int(bytes[1])
            return raw / 4
        default:
            if bytes.count >= 2 { return Int(bytes[0]) << 8 | Int(bytes[1]) }
            return Int(bytes[0])
        }
    }

    public static func encodeInt(_ value: Int, type: String, size: Int) -> [UInt8] {
        let cleanType = type.trimmingCharacters(in: .controlCharacters)
        switch cleanType {
        case "ui8", "ui8 ": return [UInt8(clamping: value)]
        case "ui16", "ui16 ": return [UInt8((value >> 8) & 0xff), UInt8(value & 0xff)]
        case "fpe2":
            let raw = max(0, value * 4)
            return [UInt8((raw >> 8) & 0xff), UInt8(raw & 0xff)]
        case "flt ":
            var floatValue = Float(value)
            return withUnsafeBytes(of: &floatValue) { Array($0.prefix(max(0, min(size, 4)))) }
        default:
            if size == 1 { return [UInt8(clamping: value)] }
            return [UInt8((value >> 8) & 0xff), UInt8(value & 0xff)]
        }
    }

    public static func fourCharCode(_ string: String) -> UInt32 {
        var result: UInt32 = 0
        for scalar in string.utf8.prefix(4) { result = (result << 8) + UInt32(scalar) }
        return result
    }

    public static func stringFromFourCharCode(_ code: UInt32) -> String {
        let bytes: [UInt8] = [
            UInt8((code >> 24) & 0xff), UInt8((code >> 16) & 0xff),
            UInt8((code >> 8) & 0xff), UInt8(code & 0xff)
        ]
        return String(bytes: bytes, encoding: .ascii) ?? ""
    }
}
