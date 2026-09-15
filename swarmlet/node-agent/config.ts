// Node configuration (~/.swarmlet/node.json, mode 0600): control binding, the owner's Offer, local
// ports, engine location, and the external services this node is allowed to stop/start for a
// deployment (each with its maintenance script, so control can only reference them by id).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DATA_PORT, AGENT_UI_PORT, type Capabilities, type Offer } from "../protocol/types.ts";
import { defaultRamReserveMiB } from "../protocol/validate.ts";
import type { AgentPaths } from "./paths.ts";
import { engineDistName, exeName } from "./platform.ts";

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
  controlPubJwk?: JsonWebKey;
  discovery?: boolean;
  offer: Offer;
  /**
   * Which `contributionOffer` revision this node has already adopted. Absent means the node has
   * never been asked to contribute, which is when the agent fills the offer in from measured
   * capabilities. It exists so that an owner's later edit is never overwritten again.
   */
  offerPolicy?: number;
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
  if (existsSync(join(beside, exeName("ggml-rpc-server")))) return beside;
  // engine/dist/<os>: "windows" on win32, matching engine/build.sh and node-agent/build.ts.
  return fileURLToPath(new URL(`../engine/dist/${engineDistName()}/`, import.meta.url));
}

/**
 * The offer a node starts life with, before it has measured itself.
 *
 * `enabled: true` states the intent: a freshly joined machine contributes. The resources cannot be
 * filled in here — config is created before capabilities are probed — so this is deliberately an
 * empty-but-enabled offer, and `contributionOffer` replaces it from measured hardware during the
 * same startup, before the node ever reports to control. If probing fails, the node advertises an
 * enabled offer with nothing behind it, which control refuses visibly rather than silently
 * accepting; that is preferable to a machine that looks idle when its owner meant it to help.
 */
export function defaultOffer(home: string): Offer {
  return {
    enabled: true,
    roles: { worker: true, coordinator: false, replica: false },
    gpu: [],
    ramMiB: 0,
    cpuCores: 0,
    diskMiB: 0,
    modelsDir: defaultModelsDir(home),
  };
}

/** Bumped when `contributionOffer` changes in a way existing nodes should adopt once. */
export const OFFER_POLICY_VERSION = 1;

/**
 * The offer a node adopts on its own behalf, derived from the hardware it measured.
 *
 * Why this is not just `defaultOffer`: config is created before capabilities are probed, so the
 * default cannot know how much GPU or RAM the machine has, and an offer with no resources is one
 * the control refuses (a worker needs GPU memory or RAM, and a machine WITH a usable GPU may not
 * offer CPU only). So the intent lives in the default and the numbers are filled in here, once,
 * after probing.
 *
 * It only ever ADDS capability: a role the owner already claimed is never removed. The coordinator
 * role especially is not ours to take away, because that is what makes a machine drivable rather
 * than merely useful to someone else's coordinator.
 */
export function contributionOffer(caps: Capabilities, current: Offer): Offer {
  const reserve = caps.ramReserveMiB || defaultRamReserveMiB(caps.os, caps.ramMiB);
  const freeDisk = Number.isSafeInteger(caps.diskFreeMiB) ? caps.diskFreeMiB : 0;
  return {
    enabled: true,
    roles: { worker: true, coordinator: current.roles.coordinator, replica: current.roles.replica },
    gpu: (caps.gpus ?? []).map((g) => ({ id: g.id, memMiB: g.totalMiB })),
    ramMiB: Math.max(0, caps.ramMiB - reserve),
    cpuCores: caps.cpuCores,
    diskMiB: current.diskMiB > 0 ? current.diskMiB : freeDisk,
    modelsDir: current.modelsDir,
  };
}

export function loadNodeConfig(paths: AgentPaths): NodeConfig {
  const base: NodeConfig = {
    controlUrl: null, agentUrl: null, enrolledNodeId: null, discovery: true, offer: defaultOffer(paths.home),
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
