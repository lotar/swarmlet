// Controller-owned admission records for the resident Qwen35 execution engine.
// A record is added only after native numerical/session/cleanup proofs for this exact
// ordered artifact and binary combination pass. Request JSON cannot supply these records.

export interface NativeQualifiedArtifact {
  name: string;
  sha256: string;
  start: number;
  end: number;
}

export interface Qwen35NativeQualification {
  mode: "stages" | "prefill-decode";
  sourceSha256: string;
  sourceSizeBytes: number;
  engine: string;
  ctx: 1024;
  /** Conservatively reserved alongside the whole source-model byte size on every node,
   * even for small shards. Set from the qualification's measured workspace requirement. */
  workspaceMiB: number;
  /** Measured conservative host-memory reserve for every endpoint in this proof.
   * Includes mapped CPU/model residency; added to GPU reserve on unified memory. */
  hostMiB: number;
  endpoints: Array<{ artifact: NativeQualifiedArtifact; binarySha256: string }>;
  evidenceSha256: string;
}

// stage-cross-proof-20260909-02: all four cases passed the original float gate and
// exact greedy-token comparisons with F32 K/V, microbatch 1 and Flash Attention off.
// See docs/reports/PLACEMENT_EXECUTION_PLAN_20260909.md for the retained evidence.
// Reserve the whole source model even for a shard, plus 512 MiB GPU workspace and
// 3 GiB host RAM; these exceed measured native residency on the qualified rig.
const proof = {
  sourceSha256: "1b04acba824817554f4ce23639bc8495ff70453b8fcb047900c731521021f2c1",
  sourceSizeBytes: 2012012800,
  engine: "fefcec450d5b009e1f6fd2853c892e7d4be45d6a765ce9f7207d94e9589f9a3c",
  ctx: 1024 as const,
  workspaceMiB: 512,
  hostMiB: 3072,
  evidenceSha256: "5bddb3bec4a3bd437af76f8dd3b045e5e73fbbc9365bb725e6780d34d5ea3d79",
};
const metal = "0121c1cbb375040fa78a16f19f71b6b40bd95804831b1f3638b71dc73f30d430";
const cuda = "35b5bcf5c7740390465193df9efb837d5a5cb77ec089fdd43bb6d70d25ed2b64";
const full = { name: "Qwen3.5-2B-Q8_0.gguf", sha256: proof.sourceSha256, start: 0, end: 24 };
const first = { name: "stage-0-3.gguf", sha256: "c57aea57890507cc8baf08691349ad6be21052fa1611f56974f41b2946c01e46", start: 0, end: 3 };
const middle = { name: "stage-3-6.gguf", sha256: "f979c19916871ac08ce9f37d55c19513b35db1773a086feed4def9eaa0028593", start: 3, end: 6 };
const last21 = { name: "stage-3-24.gguf", sha256: "228c3c76c249a24da4746afe76d7144bdb4f12b2520f8acc2e863766f9227f6b", start: 3, end: 24 };
const last18 = { name: "stage-6-24.gguf", sha256: "d1baa07f6abececc46f9fe31212448a26933b79aa3bac2285e4e1241272fa40c", start: 6, end: 24 };

export const QWEN35_NATIVE_QUALIFICATIONS: readonly Qwen35NativeQualification[] = [
  { ...proof, mode: "stages", endpoints: [{ artifact: first, binarySha256: cuda }, { artifact: last21, binarySha256: metal }] },
  { ...proof, mode: "stages", endpoints: [{ artifact: first, binarySha256: cuda }, { artifact: middle, binarySha256: cuda }, { artifact: last18, binarySha256: metal }] },
  { ...proof, mode: "prefill-decode", endpoints: [{ artifact: full, binarySha256: metal }, { artifact: full, binarySha256: cuda }] },
  { ...proof, mode: "prefill-decode", endpoints: [{ artifact: full, binarySha256: cuda }, { artifact: full, binarySha256: metal }] },
];
