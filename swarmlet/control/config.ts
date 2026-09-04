// Control-plane configuration: one JSON file in the data dir plus environment overrides.
// First run creates the file with a random admin token and prints where it is.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ControlConfig {
  /** Directory holding control.json, control.sqlite and keys/. */
  dataDir: string;
  host: string;
  port: number;
  adminToken: string;
  /** URL agents should use to reach this control plane (what /enroll hands out). */
  publicUrl: string;
  /** Path prefix served to browsers; keep "/" unless behind a sub-path proxy. */
  logLevel: "debug" | "info" | "warn";
}

const DEFAULT_PORT = 47900;

function randomToken(bytes = 24): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function loadControlConfig(overrides: Partial<ControlConfig> = {}): ControlConfig {
  const dataDir = overrides.dataDir ?? process.env.SWARMLET_CONTROL_DIR ?? join(homedir(), ".swarmlet", "control");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "control.json");
  let stored: Partial<ControlConfig> = {};
  if (existsSync(file)) {
    stored = JSON.parse(readFileSync(file, "utf8")) as Partial<ControlConfig>;
  }
  const host = overrides.host ?? process.env.SWARMLET_CONTROL_HOST ?? stored.host ?? "127.0.0.1";
  const port = overrides.port ?? Number(process.env.SWARMLET_CONTROL_PORT ?? stored.port ?? DEFAULT_PORT);
  const cfg: ControlConfig = {
    dataDir,
    host,
    port,
    adminToken: overrides.adminToken ?? process.env.SWARMLET_ADMIN_TOKEN ?? stored.adminToken ?? randomToken(),
    publicUrl: overrides.publicUrl ?? process.env.SWARMLET_CONTROL_URL ?? stored.publicUrl ?? `http://${host}:${port}`,
    logLevel: overrides.logLevel ?? (process.env.SWARMLET_LOG as ControlConfig["logLevel"] | undefined) ?? stored.logLevel ?? "info",
  };
  if (!existsSync(file) || stored.adminToken !== cfg.adminToken || stored.port !== cfg.port || stored.publicUrl !== cfg.publicUrl) {
    writeFileSync(file, JSON.stringify({ host: cfg.host, port: cfg.port, adminToken: cfg.adminToken, publicUrl: cfg.publicUrl, logLevel: cfg.logLevel }, null, 2) + "\n", { mode: 0o600 });
  }
  return cfg;
}
