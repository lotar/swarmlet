import { test } from "bun:test";

/** Skip only when an executable is absent. Installed-but-broken tools still fail the test. */
export function testWithTools(tools: string[]) {
  const missing = tools.filter((tool) => Bun.which(tool) === null);
  return (name: string, run: () => void | Promise<void>, timeout?: number) => {
    const reason = missing.length ? ` [requires ${missing.join(", ")}: executable absent on ${process.platform}]` : "";
    return test.skipIf(missing.length > 0)(name + reason, run, timeout);
  };
}

export const managedProcessTest = testWithTools(process.platform === "linux" ? ["systemd-run"] : []);
export const rssProbeTest = testWithTools(process.platform === "win32" ? ["tasklist"] : ["ps"]);
