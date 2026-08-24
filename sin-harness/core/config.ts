// Config loader — single source of truth for endpoints, model identity, seeds.
// Paths inside config.json are relative to the project root (sin-harness/).

import type { ModelManifest } from "./types.ts";

export interface BaseModelConfig {
  name: string;
  quantization: string;
  moe: boolean;
  activeParamsB?: number;
  totalParamsB?: number;
  ggufPath: string;
  contextLength: number;
}

export interface SinConfig {
  baseModel: BaseModelConfig;
  llamaServer: { host: string; port: number };
  mesh: { nodeCount: number; nodePorts: number[] };
  suiteSeed: number;
  paths: { knowledge: string; data: string; gates: string };
}

/** Absolute path of the project root (directory containing package.json). */
export const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

export function resolveFromRoot(p: string): string {
  return p.startsWith("/") ? p : `${PROJECT_ROOT}/${p}`;
}

const DEFAULT_CONFIG_PATH = new URL("../config.json", import.meta.url);

export async function loadConfig(path?: string): Promise<SinConfig> {
  const raw: unknown = await Bun.file(path ?? DEFAULT_CONFIG_PATH).json();
  return raw as SinConfig; // structural trust: config.json is owned at root
}

/** Manifest fields derivable from config alone (before any probe). */
export function manifestFromConfig(cfg: SinConfig, endpoint: string): ModelManifest {
  return {
    name: cfg.baseModel.name,
    contextLength: cfg.baseModel.contextLength,
    quantization: cfg.baseModel.quantization,
    moe: cfg.baseModel.moe,
    activeParams: cfg.baseModel.activeParamsB,
    endpoint,
  };
}
