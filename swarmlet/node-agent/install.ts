// Run the agent at login as a user service: launchd (macOS) or systemd --user (Linux).
// The service runs the same binary with `run`; the GUI shell only talks to it on 127.0.0.1:47800.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LABEL = "ai.swarmlet.node";

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
}

export function servicePath(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
    : join(homedir(), ".config", "systemd", "user", "swarmlet-node.service");
}

export async function installService(binary: string, home: string, logsDir: string): Promise<string> {
  const path = servicePath();
  mkdirSync(join(path, ".."), { recursive: true });
  if (process.platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${binary}</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>SWARMLET_HOME</key><string>${home}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${join(logsDir, "agent.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(logsDir, "agent.err.log")}</string>
</dict></plist>
`;
    writeFileSync(path, plist);
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await run(["launchctl", "bootout", `${domain}/${LABEL}`]); // ignore result: may not be loaded
    const r = await run(["launchctl", "bootstrap", domain, path]);
    if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.out.trim()}`);
    return path;
  }
  const unit = `[Unit]
Description=Swarmlet node agent
After=network-online.target

[Service]
ExecStart=${binary} run
Environment=SWARMLET_HOME=${home}
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
`;
  writeFileSync(path, unit);
  const r1 = await run(["systemctl", "--user", "daemon-reload"]);
  if (r1.code !== 0) throw new Error(`systemctl daemon-reload failed: ${r1.out.trim()}`);
  const r2 = await run(["systemctl", "--user", "enable", "--now", "swarmlet-node.service"]);
  if (r2.code !== 0) throw new Error(`systemctl enable failed: ${r2.out.trim()}`);
  const linger = await run(["loginctl", "enable-linger"]);
  if (linger.code !== 0) console.error(`note: loginctl enable-linger failed (${linger.out.trim()}); the agent stops at logout until linger is enabled`);
  return path;
}

export async function uninstallService(): Promise<void> {
  const path = servicePath();
  if (process.platform === "darwin") {
    await run(["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`]);
  } else {
    await run(["systemctl", "--user", "disable", "--now", "swarmlet-node.service"]);
    await run(["systemctl", "--user", "daemon-reload"]);
  }
  if (existsSync(path)) unlinkSync(path);
}
