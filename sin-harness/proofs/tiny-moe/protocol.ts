import type { ExpertWeights } from "./math.ts";

export interface ExpertFixture { nodeId: string; experts: ExpertWeights[] }
export interface ExpertManifest {
  nodeId: string;
  expertIds: number[];
  fixtureDigest: string;
  residentBytes: number;
}
export interface DispatchItem {
  tokenIndex: number;
  expertId: number;
  activation: number[];
  gateWeight: number;
}
export interface DispatchRequest { requestId: string; items: DispatchItem[] }
export interface ExpertPiece {
  tokenIndex: number;
  expertId: number;
  gateWeight: number;
  output: number[];
}
export interface DispatchResponse {
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
