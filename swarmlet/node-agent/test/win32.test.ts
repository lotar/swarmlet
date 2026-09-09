// Windows platform layer: pure parsers and generated service files, testable on any OS.
import { expect, test } from "bun:test";
import { defaultRamReserveMiB } from "../../protocol/validate.ts";
import { engineDistName, exeName, platformOf } from "../platform.ts";
import { cpuPctBetweenTimes, cpuTimes, driveOf, parseProcessLine, parseTasklistCsv } from "../probe/win32.ts";
import { windowsLauncherScript, windowsTaskXml } from "../install.ts";
import { coordinatorArgv, workerArgv } from "../roles/recipes.ts";

test("platform names: win32 is supported, engine binaries get .exe, dist dir is 'windows'", () => {
  expect(platformOf("win32")).toBe("win32");
  expect(() => platformOf("freebsd")).toThrow(/unsupported/);
  expect(exeName("llama-server", "win32")).toBe("llama-server.exe");
  expect(exeName("llama-server", "darwin")).toBe("llama-server");
  expect(engineDistName("win32")).toBe("windows");
  expect(engineDistName("linux")).toBe("linux");
  expect(defaultRamReserveMiB("win32")).toBe(6 * 1024);
});

test("recipes use the platform executable name", () => {
  const w = workerArgv("/eng", { kind: "worker", id: "w", deploymentId: "d", port: 50200, device: "CUDA0", threads: 4, allow: [] }, []);
  expect(w.argv[0]).toBe(`/eng/${exeName("ggml-rpc-server")}`);
  const c = coordinatorArgv("/eng", { kind: "coordinator", id: "c", deploymentId: "d", model: { path: "/m/x.gguf" }, rpc: [], devices: ["CPU"], tensorSplit: [1], ctx: 1024, parallel: 1, env: {}, extraArgs: [], port: 8100, allow: [] }, []);
  expect(c.argv[0]).toBe(`/eng/${exeName("llama-server")}`);
});

test("tasklist CSV: locale thousands separators and quoted names", () => {
  const text = [
    "\"System Idle Process\",\"0\",\"Services\",\"0\",\"8 K\"",
    "\"ggml-rpc-server.exe\",\"4321\",\"Console\",\"1\",\"1,234,567 K\"",
    "\"llama-server.exe\",\"4322\",\"Console\",\"1\",\"2.048 K\"",
    "\"odd \"\"name\"\".exe\",\"7\",\"Console\",\"1\",\"100 K\"",
    "INFO: No tasks are running which match the specified criteria.",
    "",
  ].join("\r\n");
  const rows = parseTasklistCsv(text);
  expect(rows.map((r) => [r.pid, r.memKiB])).toEqual([[0, 8], [4321, 1_234_567], [4322, 2048], [7, 100]]);
  expect(rows[3]!.image).toBe("odd \"name\".exe");
});

test("cpu percent from os.cpus() deltas", () => {
  const a = cpuTimes([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 } }]);
  const b = cpuTimes([{ times: { user: 400, nice: 0, sys: 150, idle: 950, irq: 0 } }, { times: { user: 200, nice: 0, sys: 0, idle: 1300, irq: 0 } }]);
  // 1000 ticks elapsed over two cpus, 400 idle -> 60 % busy
  expect(cpuPctBetweenTimes(a, b)).toBe(60);
  expect(cpuPctBetweenTimes(b, b)).toBeUndefined();
});

test("drive letter and CIM process line", () => {
  expect(driveOf("C:\\Users\\lotar")).toBe("C:");
  expect(driveOf("d:/models")).toBe("D:");
  expect(driveOf("\\\\server\\share")).toBeNull();
  expect(parseProcessLine("2026-09-09T17:00:00.1234567Z\t\"C:\\eng\\ggml-rpc-server.exe\" -p 50200\r\n"))
    .toEqual({ created: "2026-09-09T17:00:00.1234567Z", command: "\"C:\\eng\\ggml-rpc-server.exe\" -p 50200" });
  expect(parseProcessLine("\r\n")).toBeNull();
  expect(parseProcessLine("garbage")).toBeNull();
});

test("Windows service: hidden logon task runs the launcher, launcher appends logs and forwards the exit code", () => {
  const launcher = windowsLauncherScript("C:\\Program Files\\Swarmlet Node\\swarmlet-node.exe", "C:\\Users\\lotar\\.swarmlet", "C:\\Users\\lotar\\.swarmlet\\logs");
  expect(launcher).toContain("$env:SWARMLET_HOME = 'C:\\Users\\lotar\\.swarmlet'");
  expect(launcher).toContain("& 'C:\\Program Files\\Swarmlet Node\\swarmlet-node.exe' run 2>&1");
  expect(launcher).toContain("Add-Content -LiteralPath $log");
  expect(launcher.trim().endsWith("exit $LASTEXITCODE")).toBe(true);
  const xml = windowsTaskXml("LAPTOP\\Mladen Lotar", "C:\\Users\\Mladen Lotar\\AppData\\Local\\Swarmlet\\swarmlet-node-service.ps1");
  expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(xml).toContain("<UserId>LAPTOP\\Mladen Lotar</UserId>");
  expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  expect(xml).toContain("<Command>powershell.exe</Command>");
  expect(xml).toContain("-WindowStyle Hidden -ExecutionPolicy Bypass -File &quot;C:\\Users\\Mladen Lotar\\AppData\\Local\\Swarmlet\\swarmlet-node-service.ps1&quot;");
  expect(xml).toContain("<Interval>PT1M</Interval>");
});
