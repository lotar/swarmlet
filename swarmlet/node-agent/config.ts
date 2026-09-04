// Node configuration (~/.swarmlet/node.json, mode 0600): control binding, the owner's Offer, local
// ports, engine location, and the external services this node is allowed to stop/start for a
// deployment (each with its maintenance script, so control can only reference them by id).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_DATA_PORT, AGENT_UI_PORT, type Offer } from "../protocol/types.ts";
import type { AgentPaths } from "./paths.ts";

export interface ExternalService {
  id: string;
  /** Served model name for routing. */
  modelName: string;
  url: string;
  healthPath: string;
  /** Script accepting check-only|stop|start (sin-harness/scripts/flashnext-maintenance.sh). */
  maintenance: string;
}

export interface NodeConfig {
  controlUrl: string | null;
  agentUrl: string | null;
  enrolledNodeId: string | null;
  offer: Offer;
  uiPort: number;
  dataPort: number;
  /** Directory with ggml-rpc-server / llama-server / llama-ring-bench. */
  enginePath: string;
  /** Extra hosts other nodes may try for the direct path (public DNS name / port-forwarded address). */
  advertise: string[];
  externals: ExternalService[];
}

export function defaultModelsDir(home: string): string { return join(home, "models"); }

/** Engine binaries: SWARMLET_ENGINE, else next to the running binary, else the repo dist for this OS. */
export function defaultEnginePath(): string {
  if (process.env.SWARMLET_ENGINE) return process.env.SWARMLET_ENGINE;
  const beside = join(dirname(process.execPath), "engine");
  if (existsSync(join(beside, "ggml-rpc-server"))) return beside;
  const repo = new URL(`../engine/dist/${process.platform}/`, import.meta.url).pathname;
  return repo;
}

export function defaultOffer(home: string): Offer {
  return {
    enabled: false,
    roles: { worker: true, coordinator: false, replica: false },
    gpu: [],
    ramMiB: 0,
    cpuCores: 0,
    diskMiB: 0,
    modelsDir: defaultModelsDir(home),
  };
}

export function loadNodeConfig(paths: AgentPaths): NodeConfig {
  const base: NodeConfig = {
    controlUrl: null, agentUrl: null, enrolledNodeId: null, offer: defaultOffer(paths.home),
    uiPort: AGENT_UI_PORT, dataPort: AGENT_DATA_PORT, enginePath: defaultEnginePath(), advertise: [], externals: [],
  };
  if (!existsSync(paths.configFile)) { saveNodeConfig(paths, base); return base; }
  const stored = JSON.parse(readFileSync(paths.configFile, "utf8")) as Partial<NodeConfig>;
  const cfg: NodeConfig = { ...base, ...stored, offer: { ...base.offer, ...(stored.offer ?? {}) } };
  if (process.env.SWARMLET_ENGINE) cfg.enginePath = process.env.SWARMLET_ENGINE;
  return cfg;
}

export function saveNodeConfig(paths: AgentPaths, cfg: NodeConfig): void {
  writeFileSync(paths.configFile, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}
