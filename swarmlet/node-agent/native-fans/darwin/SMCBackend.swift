import Foundation

public protocol SMCBackend {
    func readInt(_ key: String) throws -> Int
    func writeInt(_ key: String, _ value: Int) throws
}
