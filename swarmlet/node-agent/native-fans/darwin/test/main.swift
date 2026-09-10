import Foundation

final class Firmware: SMCBackend {
    var values = ["FNum":2,"F0Ac":5349,"F1Ac":5777,"F0Mn":1350,"F1Mn":1350,"F0Mx":5349,"F1Mx":5777,"F0Tg":1350,"F1Tg":1350]
    var writes: [(String, Int)] = []
    var readFailure: FanCtlError?
    var writeFailure = false
    init(legacy: Bool) {
        if legacy { values["Ftst"] = 0 }
        for fan in 0..<2 { values[legacy ? "F\(fan)Md" : "F\(fan)md"] = 0 }
    }
    func readInt(_ key: String) throws -> Int {
        if key == "Ftst", let readFailure { throw readFailure }
        guard let value=values[key] else {throw FanCtlError.keyNotFound(key)}
        return value
    }
    func writeInt(_ key: String, _ value: Int) throws {
        guard values[key] != nil else {throw FanCtlError.keyNotFound(key)}
        if key == "Ftst" && writeFailure {throw FanCtlError.firmware(130)}
        if key.hasSuffix("Md") && value == 1 && values["Ftst"] != 1 {throw FanCtlError.firmware(130)}
        values[key]=value; writes.append((key,value))
    }
}
func check(_ value: Bool, _ message: String) { if !value { fatalError(message) } }
if CommandLine.arguments.contains("--hold-fixture") {
    let firmware=Firmware(legacy:false)
    let controller=FanController(backend:firmware,sleep:{_ in})
    let timeout=Double(ProcessInfo.processInfo.environment["FAN_TEST_WATCHDOG"] ?? "10")!
    var failure: Error?
    do { try holdMaximum(controller,watchdogSeconds:timeout) } catch { failure = error }
    check(try controller.status().allSatisfy {!$0.manualMode},"hold must restore automatic control")
    if let result=ProcessInfo.processInfo.environment["FAN_TEST_RESULT"] {
        try "auto".write(toFile:result,atomically:true,encoding:.utf8)
    }
    print("restored")
    if let failure { fputs("\(failure)\n",stderr); exit(1) }
    exit(0)
}

for legacy in [true,false] {
    let firmware=Firmware(legacy:legacy)
    let controller=FanController(backend:firmware,sleep:{_ in})
    try controller.setMax()
    check(try controller.status().allSatisfy {$0.manualMode && $0.targetRPM == $0.maxRPM}, "maximum targets/modes")
    try controller.autoAll()
    check(try controller.status().allSatisfy {!$0.manualMode}, "automatic restoration")
    if legacy {
        check(firmware.writes.first!.0 == "Ftst" && firmware.writes.first!.1 == 1, "unlock must precede mode")
        check(firmware.writes.last!.0 == "Ftst" && firmware.writes.last!.1 == 0, "restore all modes before releasing unlock")
    } else {check(!firmware.writes.contains {$0.0 == "Ftst"}, "absent key must not be written")}
}
for error in [FanCtlError.firmware(130),FanCtlError.smc("transport failed")] {
    let firmware=Firmware(legacy:true);firmware.readFailure=error
    do {try FanController(backend:firmware,sleep:{_ in}).setMax();fatalError("read failure must propagate")}
    catch {check(firmware.writes.isEmpty,"failed capability probe must not write")}
}
let denied=Firmware(legacy:true);denied.writeFailure=true
do {try FanController(backend:denied,sleep:{_ in}).setMax();fatalError("unlock rejection must propagate")}
catch {check(denied.writes.isEmpty,"unlock rejection must not enable manual mode")}
print("PASS: legacy and absent-key maximum/restore; read and write failures remain closed")
