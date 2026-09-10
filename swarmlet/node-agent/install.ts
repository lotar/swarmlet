// Run the agent at login as a user service: launchd (macOS), systemd --user (Linux) or a Task
// Scheduler logon task (Windows). The service runs the stable `supervise` entry point; the GUI shell only
// talks to it on 127.0.0.1:47800 and treats the written service file as the "installed" marker.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LABEL = "ai.swarmlet.node";
/** Task Scheduler task name (Windows). */
export const WINDOWS_TASK = "Swarmlet Node";

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
}

/** %LOCALAPPDATA%\Swarmlet: where the Windows service task, its launcher and the marker live. */
export function windowsServiceDir(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Swarmlet");
}

export function servicePath(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  if (process.platform === "win32") return join(windowsServiceDir(), "swarmlet-node.task.xml");
  return join(homedir(), ".config", "systemd", "user", "swarmlet-node.service");
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Windows launcher: one PowerShell script the task runs hidden. It sets SWARMLET_HOME, starts the
 * agent in the same (hidden) console and appends both output streams to logs/agent.log.
 * Own the crash retry: Task Scheduler's configured RestartOnFailure did not restart either
 * timed or on-demand failing tasks on the supported Windows host during live verification.
 */
export function windowsLauncherScript(binary: string | string[], home: string, logsDir: string): string {
  const command = (typeof binary === "string" ? [binary] : binary).map(psQuote).join(" ");
  return [
    "# Written by `swarmlet-node install`; runs as the Task Scheduler task \"Swarmlet Node\" at logon.",
    "$ErrorActionPreference = 'Continue'",
    `$env:SWARMLET_HOME = ${psQuote(home)}`,
    `$log = ${psQuote(join(logsDir, "agent.log"))}`,
    "$retrySeconds = 5",
    "while ($true) {",
    "  $started = [DateTime]::UtcNow",
    "  $LASTEXITCODE = 1",
    `  & ${command} supervise 2>&1 | ForEach-Object { Add-Content -LiteralPath $log -Encoding UTF8 -Value ($_.ToString()) }`,
    "  $agentExit = $LASTEXITCODE",
    "  if ($agentExit -eq 0) { exit 0 }",
    "  if (([DateTime]::UtcNow - $started).TotalSeconds -ge 60) { $retrySeconds = 5 }",
    '  Add-Content -LiteralPath $log -Encoding UTF8 -Value ("Agent exited with code {0}; restarting in {1}s" -f $agentExit, $retrySeconds)',
    "  Start-Sleep -Seconds $retrySeconds",
    "  $retrySeconds = [Math]::Min(60, $retrySeconds * 2)",
    "}",
    "",
  ].join("\r\n");
}

/** Task Scheduler definition: run the launcher hidden at this user's logon, keep it alive, restart on failure. */
export function windowsTaskXml(user: string, launcher: string): string {
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${launcher}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Swarmlet node agent (written by swarmlet-node install). Serves the mesh in the background and the local node UI on http://127.0.0.1:47800.</Description>
    <URI>\\${WINDOWS_TASK}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** End both supervisor and child owned by this Windows account; an orphan supervisor
 * would otherwise respawn its agent while install/uninstall changes the scheduled task. */
async function stopWindowsAgents(): Promise<void> {
  const self = process.pid;
  await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
    `$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $nodes = @(Get-CimInstance Win32_Process -Filter "Name='swarmlet-node.exe'" | Where-Object { $_.ProcessId -ne ${self} -and $_.CommandLine -match '\\s+(run|supervise)\\s*$' -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $sid }); $nodes | Sort-Object @{Expression={ if ($_.CommandLine -match '\\s+supervise\\s*$') { 0 } else { 1 } }} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
}

async function windowsUser(): Promise<string> {
  // OpenSSH may report USERDOMAIN=WORKGROUP, which is not the local account authority.
  // Task Scheduler accepts the actual token SID, independent of domain or display name.
  const result = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"]);
  const sid = result.out.trim();
  if (result.code !== 0 || !/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error("Could not resolve the Windows account SID for Task Scheduler");
  return sid;
}

export async function installService(binary: string | string[], home: string, logsDir: string): Promise<string> {
  const command = typeof binary === "string" ? [binary] : binary;
  if (!command.length || [...command, home, logsDir].some(value => !value || /[\r\n\0]/.test(value))) throw new Error("invalid service command or path");
  const path = servicePath();
  mkdirSync(join(path, ".."), { recursive: true });
  if (process.platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${[...command, "supervise"].map(arg => `<string>${xmlEscape(arg)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict><key>SWARMLET_HOME</key><string>${xmlEscape(home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(join(logsDir, "agent.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(logsDir, "agent.err.log"))}</string>
</dict></plist>
`;
    writeFileSync(path, plist);
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await run(["launchctl", "bootout", `${domain}/${LABEL}`]); // ignore result: may not be loaded
    // bootout can return before launchd finishes unloading the old job. The same valid
    // plist then transiently returns EIO (5); bounded retry closes that observed native race.
    const deadline = Date.now() + 20_000;
    let r = await run(["launchctl", "bootstrap", domain, path]);
    while (r.code === 5 && Date.now() < deadline) {
      await Bun.sleep(500);
      r = await run(["launchctl", "bootstrap", domain, path]);
    }
    if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.out.trim()}`);
    return path;
  }
  if (process.platform === "win32") {
    mkdirSync(logsDir, { recursive: true });
    const launcher = join(windowsServiceDir(), "swarmlet-node-service.ps1");
    writeFileSync(launcher, windowsLauncherScript(binary, home, logsDir));
    // schtasks reads task XML the way Windows exports it: UTF-16 LE with a byte order mark.
    writeFileSync(path, Buffer.from("\uFEFF" + windowsTaskXml(await windowsUser(), launcher), "utf16le"));
    await run(["schtasks", "/End", "/TN", WINDOWS_TASK]); // ignore result: may not exist or not be running
    await stopWindowsAgents(); // like launchctl bootout: the previous service's agent must release the port
    const r1 = await run(["schtasks", "/Create", "/TN", WINDOWS_TASK, "/XML", path, "/F"]);
    if (r1.code !== 0) throw new Error(`schtasks /Create failed: ${r1.out.trim()}`);
    const r2 = await run(["schtasks", "/Run", "/TN", WINDOWS_TASK]);
    if (r2.code !== 0) throw new Error(`schtasks /Run failed: ${r2.out.trim()}`);
    return path;
  }
  const quoteUnit = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
  const unit = `[Unit]
Description=Swarmlet node agent
After=network-online.target

[Service]
ExecStart=${command.map(arg => quoteUnit(arg.replace(/\$/g, "$$$$"))).join(" ")} supervise
Environment=${quoteUnit(`SWARMLET_HOME=${home}`)}
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
`;
  writeFileSync(path, unit);
  const r1 = await run(["systemctl", "--user", "daemon-reload"]);
  if (r1.code !== 0) throw new Error(`systemctl daemon-reload failed: ${r1.out.trim()}`);
  const r2 = await run(["systemctl", "--user", "enable", "swarmlet-node.service"]);
  if (r2.code !== 0) throw new Error(`systemctl enable failed: ${r2.out.trim()}`);
  const restart = await run(["systemctl", "--user", "restart", "swarmlet-node.service"]);
  if (restart.code !== 0) throw new Error(`systemctl restart failed: ${restart.out.trim()}`);
  const linger = await run(["loginctl", "enable-linger"]);
  if (linger.code !== 0) console.error(`note: loginctl enable-linger failed (${linger.out.trim()}); the agent stops at logout until linger is enabled`);
  return path;
}

export async function uninstallService(): Promise<void> {
  const path = servicePath();
  if (process.platform === "darwin") {
    await run(["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`]);
  } else if (process.platform === "win32") {
    await run(["schtasks", "/End", "/TN", WINDOWS_TASK]);
    await run(["schtasks", "/Delete", "/TN", WINDOWS_TASK, "/F"]);
    await stopWindowsAgents();
    const launcher = join(windowsServiceDir(), "swarmlet-node-service.ps1");
    if (existsSync(launcher)) unlinkSync(launcher);
  } else {
    await run(["systemctl", "--user", "disable", "--now", "swarmlet-node.service"]);
    await run(["systemctl", "--user", "daemon-reload"]);
  }
  if (existsSync(path)) unlinkSync(path);
}
