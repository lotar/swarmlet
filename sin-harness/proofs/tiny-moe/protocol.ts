import type { ExpertWeights } from "./math.ts";

export const PROTOCOL_VERSION = 2;
export const MODEL_ID = "tiny-moe-v1";
export interface ExpertFixture { nodeId: string; experts: ExpertWeights[] }
export interface PlacementOwner { nodeId: string; expertIds: number[]; fixtureSha256: string }
export interface PlacementPlan {
  schemaVersion: 1;
  protocolVersion: 2;
  modelId: string;
  owners: PlacementOwner[];
  placementEpoch: string;
}
export interface ExpertManifest {
  nodeId: string;
  modelId: string;
  protocolVersion: number;
  expertIds: number[];
  fixtureDigest: string;
  residentBytes: number;
  placementEpoch: string;
  launchId?: string;
}
export interface DispatchItem {
  tokenIndex: number;
  expertId: number;
  activation: number[];
}
export interface DispatchRequest {
  protocolVersion: number;
  placementEpoch: string;
  requestId: string;
  tokenCount: number;
  items: DispatchItem[];
}
export interface ExpertPiece { tokenIndex: number; expertId: number; output: number[] }
export interface DispatchResponse {
  protocolVersion: number;
  placementEpoch: string;
  nodeId: string;
  requestId: string;
  pieces: ExpertPiece[];
  requestBytes: number;
}
export interface AccessLogEntry { requestId: string; expertIds: number[]; itemCount: number }

export class ExpertUnavailable extends Error {
  constructor(public readonly expertIds: number[], message?: string) {
    super(message ?? `EXPERT_UNAVAILABLE(${expertIds.join(",")})`);
    this.name = "ExpertUnavailable";
  }
}
