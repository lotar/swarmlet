// Command lines for each role. Pure functions (argv + env from an assignment and local ports), so
// they are unit-testable and the exact recipe the mesh measured with is visible in one place.
// Measured reference: docs/FLASHNEXT_RING_LEVERS_20260904.md (chain 4 + batched GETs, wire off).

import type { CoordinatorAssignment, ReplicaAssignment, WorkerAssignment } from "../../protocol/types.ts";
import { exeName } from "../platform.ts";

export interface WorkerRecipe { argv: string[]; env: Record<string, string> }

function speculationArgs(a: Pick<CoordinatorAssignment, "mtp" | "speculation">): string[] {
  if (a.mtp && a.speculation) throw new Error("MTP and ngram speculation cannot be combined");
  if (a.mtp) return ["--spec-type", "draft-mtp", "-md", a.mtp.path, "--spec-draft-n-max", String(a.mtp.chain), "-ngld", "999"];
  if (a.speculation) {
    if (a.speculation.type !== "ngram-simple") throw new Error("unsupported speculation type");
    // Small fixed horizon: no second model, and every proposed token is target-verified.
    return ["--spec-type", "ngram-simple", "--spec-ngram-simple-size-n", "3", "--spec-ngram-simple-size-m", "4", "--spec-ngram-simple-min-hits", "3"];
  }
  return [];
}

/** ggml-rpc-server for a worker slab. `peerLocalPorts[i]` is the local port dialed to peers[i]. */
export function workerArgv(engine: string, a: WorkerAssignment, peerLocalPorts: number[]): WorkerRecipe {
  const argv = [`${engine}/${exeName("ggml-rpc-server")}`, "-H", "127.0.0.1", "-p", String(a.port), "-d", a.device, "-t", String(a.threads)];
  if (a.memCapMiB && a.memCapMiB > 0) argv.push("--mem-cap-mib", String(a.memCapMiB));
  if (a.peerPort) argv.push("--peer-port", String(a.peerPort));
  (a.peers ?? []).forEach((p, i) => { const lp = peerLocalPorts[i]; if (lp) argv.push("--peer", `${p.index}=127.0.0.1:${lp}`); });
  if (a.cache !== false) argv.push("-c");
  return { argv, env: {} };
}

/** llama-server as the RPC client holding the model. `rpcLocalPorts[i]` is the local port dialed to rpc[i]. */
export function coordinatorArgv(engine: string, a: CoordinatorAssignment, rpcLocalPorts: number[]): WorkerRecipe {
  const argv = [
    `${engine}/${exeName("llama-server")}`, "-m", a.model.path, "--host", "127.0.0.1", "--port", String(a.port),
    "--rpc", rpcLocalPorts.map((p) => `127.0.0.1:${p}`).join(","),
    "--device", a.devices.join(","), "--tensor-split", a.tensorSplit.join(","),
    "-ngl", "999", "-c", String(a.ctx), "--parallel", String(a.parallel), "--metrics", "--temp", "0",
  ];
  if (a.modelName) argv.push("--alias", a.modelName);
  argv.push(...speculationArgs(a));
  argv.push(...a.extraArgs);
  if (a.enforce?.cpuCores) argv.push("-t", String(a.enforce.cpuCores), "-tb", String(a.enforce.cpuCores));
  const env: Record<string, string> = {
    GGML_RPC_FORWARD: "1", GGML_RPC_PIPELINE: "1", GGML_SCHED_PIPELINED_COPY: "1", GGML_RPC_GET_PIPELINE: "1", GGML_RPC_WIRE: "off",
    ...a.env,
  };
  return { argv, env };
}

/**
 * Whole-model llama-server (replica role). The planner names the device "CPU" on a node without a GPU
 * offer; llama-server has no device by that name, so that case runs with no offload device at all.
 */
export function replicaArgv(engine: string, a: ReplicaAssignment, cpuCores?: number): WorkerRecipe {
  if (!a.model) throw new Error("replica recipe needs a model");
  const cpuOnly = a.device === "CPU";
  const argv = [`${engine}/${exeName("llama-server")}`, "-m", a.model.path, "--host", "127.0.0.1", "--port", String(a.port), "-ngl", cpuOnly ? "0" : "999", "--metrics"];
  if (a.ctx) argv.push("-c", String(a.ctx));
  if (a.parallel) argv.push("--parallel", String(a.parallel));
  if (a.modelName) argv.push("--alias", a.modelName);
  if (a.device) argv.push("--device", cpuOnly ? "none" : a.device);
  argv.push(...speculationArgs(a));
  argv.push(...(a.extraArgs ?? []));
  if (cpuCores) argv.push("-t", String(cpuCores), "-tb", String(cpuCores));
  return { argv, env: {} };
}
