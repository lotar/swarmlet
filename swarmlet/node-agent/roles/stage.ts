import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import type { NativeStageIdentity, StageAssignment } from "../../protocol/types.ts";

export function stageStateDirectory(stateDir: string, id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("invalid native assignment id");
  return join(stateDir, "stages", id);
}

export function stageArgv(engine: string, a: StageAssignment, stateDir: string): string[] {
  if (a.ctx !== 1024 || a.gpuLayers !== 999 || a.model.sha256 !== a.identity.model_sha256 || a.ctx !== a.identity.ctx) {
    throw new Error("invalid qualified native assignment");
  }
  return [join(engine, "mesh-stage-worker"), a.model.path, a.model.sha256,
    stageStateDirectory(stateDir, a.id), String(a.port), String(a.gpuLayers), String(a.ctx)];
}

/** Readiness requires the loaded model and executable, not merely an open HTTP port. */
export function assertStageHealth(value: unknown, identity: NativeStageIdentity, binarySha256: string): void {
  if (!value || typeof value !== "object") throw new Error("invalid native health response");
  const status = value as Record<string, unknown>;
  if (!status.identity || typeof status.identity !== "object") throw new Error("native identity missing");
  const actual = status.identity as Record<string, unknown>;
  for (const [field, expected] of Object.entries(identity)) {
    if (actual[field] !== expected) throw new Error(`native identity mismatch: ${field}`);
  }
  if (status.binary_sha256 !== binarySha256) throw new Error("native binary identity mismatch");
  if (status.n_embd !== 2048 || status.n_vocab !== 248320) throw new Error("native model dimensions mismatch");
  if (status.session !== "" || status.position !== 0 || status.evaluated_tokens !== 0) throw new Error("native context is not empty at startup");
}

export async function assertStagePortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(2000);
    socket.once("connect", () => { socket.destroy(); reject(new Error("native worker port is already occupied")); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("cannot establish native worker port availability")); });
    socket.once("error", (e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED" ? resolve() : reject(e));
  });
}

/** A health reply from another assignment must never make this process ready. Linux may wrap it in a scope. */
export function assertStageProcess(pid: unknown, supervisedPid: number | null): void {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !supervisedPid) throw new Error("invalid native worker PID");
  let current = pid as number;
  for (let depth = 0; depth < 64; depth++) {
    if (current === supervisedPid) return;
    if (process.platform !== "linux" || current <= 1) break;
    try {
      const stat = readFileSync(`/proc/${current}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!Number.isSafeInteger(parent) || parent === current) break;
      current = parent;
    } catch { break; }
  }
  throw new Error("native health belongs to an unowned process");
}
