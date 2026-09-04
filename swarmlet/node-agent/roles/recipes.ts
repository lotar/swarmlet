// Command lines for each role. Pure functions (argv + env from an assignment and local ports), so
// they are unit-testable and the exact recipe the mesh measured with is visible in one place.
// Measured reference: docs/FLASHNEXT_RING_LEVERS_20260904.md (chain 4 + batched GETs, wire off).

import type { CoordinatorAssignment, ReplicaAssignment, WorkerAssignment } from "../../protocol/types.ts";

export interface WorkerRecipe { argv: string[]; env: Record<string, string> }

/** ggml-rpc-server for a worker slab. `peerLocalPorts[i]` is the local port dialed to peers[i]. */
export function workerArgv(engine: string, a: WorkerAssignment, peerLocalPorts: number[]): WorkerRecipe {
  const argv = [`${engine}/ggml-rpc-server`, "-H", "127.0.0.1", "-p", String(a.port), "-d", a.device, "-t", String(a.threads)];
  if (a.memCapMiB && a.memCapMiB > 0) argv.push("--mem-cap-mib", String(a.memCapMiB));
  if (a.peerPort) argv.push("--peer-port", String(a.peerPort));
  (a.peers ?? []).forEach((p, i) => { const lp = peerLocalPorts[i]; if (lp) argv.push("--peer", `${p.index}=127.0.0.1:${lp}`); });
  if (a.cache !== false) argv.push("-c");
  return { argv, env: {} };
}

/** llama-server as the RPC client holding the model. `rpcLocalPorts[i]` is the local port dialed to rpc[i]. */
export function coordinatorArgv(engine: string, a: CoordinatorAssignment, rpcLocalPorts: number[]): WorkerRecipe {
  const argv = [
    `${engine}/llama-server`, "-m", a.model.path, "--host", "127.0.0.1", "--port", String(a.port),
    "--rpc", rpcLocalPorts.map((p) => `127.0.0.1:${p}`).join(","),
    "--device", a.devices.join(","), "--tensor-split", a.tensorSplit.join(","),
    "-ngl", "999", "-c", String(a.ctx), "--parallel", String(a.parallel), "--metrics", "--temp", "0",
  ];
  if (a.modelName) argv.push("--alias", a.modelName);
  if (a.mtp) argv.push("--spec-type", "draft-mtp", "-md", a.mtp.path, "--spec-draft-n-max", String(a.mtp.chain), "-ngld", "999");
  argv.push(...a.extraArgs);
  const env: Record<string, string> = {
    GGML_RPC_FORWARD: "1", GGML_RPC_PIPELINE: "1", GGML_SCHED_PIPELINED_COPY: "1", GGML_RPC_GET_PIPELINE: "1", GGML_RPC_WIRE: "off",
    ...a.env,
  };
  return { argv, env };
}

/** Whole-model llama-server (replica role). */
export function replicaArgv(engine: string, a: ReplicaAssignment): WorkerRecipe {
  if (!a.model) throw new Error("replica recipe needs a model");
  const argv = [`${engine}/llama-server`, "-m", a.model.path, "--host", "127.0.0.1", "--port", String(a.port), "-ngl", "999", "--metrics"];
  if (a.ctx) argv.push("-c", String(a.ctx));
  if (a.parallel) argv.push("--parallel", String(a.parallel));
  if (a.modelName) argv.push("--alias", a.modelName);
  argv.push(...(a.extraArgs ?? []));
  return { argv, env: {} };
}
