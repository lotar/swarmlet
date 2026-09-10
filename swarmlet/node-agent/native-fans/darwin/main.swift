import Foundation

func output(_ value: [String: Any]) {
    if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let text = String(data: bytes, encoding: .utf8) { print(text) }
}
do {
    let args = Array(CommandLine.arguments.dropFirst())
    guard args.count == 1, ["status", "max", "auto"].contains(args[0]) else { throw FanCtlError.invalidArguments("Usage: swarmlet-fans status|max|auto") }
    let backend = try AppleSMCBackend(), controller = FanController(backend: backend)
    let fans: [FanInfo]
    do { fans = try controller.status() } catch FanCtlError.noFans { fans = [] }
    guard fans.count <= 16, fans.allSatisfy({ $0.minRPM > 0 && $0.maxRPM >= $0.minRPM && $0.maxRPM <= 50000 && $0.actualRPM >= 0 && $0.actualRPM <= 50000 }) else { throw FanCtlError.smc("Firmware reported an unsupported fan range") }
    if args[0] != "status" {
        guard !fans.isEmpty else { throw FanCtlError.noFans }
        guard geteuid() == 0 else { throw FanCtlError.smc("Administrator access is required for fan control") }
        if args[0] == "max" {
            do { try controller.setMax() }
            catch { try? controller.autoAll(); throw error }
        } else { try controller.autoAll() }
    }
    let measured = args[0] == "status" ? fans : try controller.status()
    output(["provider": "AppleSMC", "temperatures": backend.temperatures(), "fans": measured.map { ["id": "smc:\($0.index)", "name": "Fan \($0.index + 1)", "rpm": $0.actualRPM, "targetRpm": $0.targetRPM, "minRpm": $0.minRPM, "maxRpm": $0.maxRPM, "mode": $0.manualMode ? "manual" : "auto"] as [String: Any] }])
} catch {
    output(["provider": "AppleSMC", "error": String(describing: error)])
    exit(1)
}
