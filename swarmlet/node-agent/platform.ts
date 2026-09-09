// Small platform facts shared by the agent: which OS this is and how engine executables are named.
// Windows executables carry ".exe"; everything that builds a path to an engine binary goes through here.

import type { Capabilities } from "../protocol/types.ts";

export type Platform = Capabilities["os"];

export const IS_WINDOWS = process.platform === "win32";

/** process.platform narrowed to what the mesh supports; throws for anything else. */
export function platformOf(p: string = process.platform): Platform {
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  throw new Error(`unsupported platform ${p}`);
}

/** Executable file name for this platform ("llama-server" -> "llama-server.exe" on Windows). */
export function exeName(base: string, platform: string = process.platform): string {
  return platform === "win32" ? `${base}.exe` : base;
}

/** Directory name used for per-OS build outputs (engine/dist/<name>, dist/agent/<name>): darwin, linux, windows. */
export function engineDistName(platform: string = process.platform): string {
  return platform === "win32" ? "windows" : platform;
}

/** Engine binary names as they appear in an engine dist for `platform` (sha256.txt keys, bundle resources). */
export const ENGINE_BINARIES = ["ggml-rpc-server", "llama-server", "llama-ring-bench"] as const;
