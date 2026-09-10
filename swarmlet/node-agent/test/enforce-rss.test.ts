import { expect, test } from "bun:test";
import { enforce } from "../enforce/index.ts";
import { rssMiB } from "../probe/host.ts";
import type { Logger } from "../../control/log.ts";

test.skipIf(process.platform === "linux")("soft RSS cap stops a real engine process before a 10% allowance can consume the OS reserve", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    const bytes = new Uint8Array(128*1024*1024).fill(42);
    process.on('SIGTERM', () => process.exit(0));
    console.log('ready');
    setInterval(() => { if(bytes[0] !== 42) throw Error('memory changed'); }, 1000);
  `], { stdout: "pipe", stderr: "inherit" });
  let cancel: (() => void) | undefined;
  try {
    await child.stdout.getReader().read();
    await Bun.sleep(300);
    const rss = await rssMiB([child.pid]);
    expect(rss).toBeGreaterThan(100);
    const cap = Math.floor(rss! * .96);
    let reason = "";
    const policy = await enforce("rss-boundary", [], { ramMiB: cap }, { warn() {} } as unknown as Logger);
    cancel = policy.watch!(child.pid, value => { reason = value; child.kill("SIGTERM"); });
    const deadline = Date.now() + 6500;
    while (!reason && Date.now() < deadline) await Bun.sleep(100);
    expect(reason).toContain(`exceeds cap ${cap} MiB`);
    // Windows terminates SIGTERM targets unconditionally; POSIX runs the fixture handler.
    expect(await child.exited).toBe(process.platform === "win32" ? 143 : 0);
  } finally {
    cancel?.();
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }
}, 12_000);
