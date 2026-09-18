// Shared contract between the node agent and the control plane. Types only; validators live in
// validate.ts, framing in frame.ts. Sizes are MiB throughout (the UIs render GiB).

export const PROTOCOL_VERSION = 1;
export const AGENT_UI_PORT = 47800;
export const AGENT_DATA_PORT = 47801;
export const HEARTBEAT_MS = 2000;

// ---------- what a machine has (measured by the agent) ----------

export interface GpuDevice {
  /** Stable id: "cuda:0", "metal:0" */
  id: string;
  name: string;
  backend: "cuda" | "metal" | "cpu" | "other";
  /** Engine device name as ggml reports it (CUDA0, MTL0). */
  engineName: string;
  totalMiB: number;
  freeMiB?: number;
}

export interface NetMeasurement {
  rttMs: number;
  upMbit?: number;
  downMbit?: number;
  measuredAt: string;
}

export interface Capabilities {
  /** Supports controller-assigned per-deployment RAM/CPU budgets, including replicas. */
  allocationVersion?: 1;
  /** Node's process.platform value; "win32" is Windows. */
  os: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  hostname: string;
  ramMiB: number;
  /** RAM the OS keeps for itself; offers are validated against ramMiB - reserve. */
  ramReserveMiB: number;
  cpuCores: number;
  gpus: GpuDevice[];
  diskFreeMiB: number;
  privateIps: string[];
  publicIp?: string;
  /**
   * Endpoints a peer may dial directly, including a gateway port mapping the node requested for
   * itself (node-agent/nat.ts). Port-bearing, because a router grants whichever external port it
   * likes; empty unless a mapping is actually live.
   */
  publicEndpoints?: Array<{ host: string; port: number }>;
  /** Port of this node's TLS data listener (default AGENT_DATA_PORT); peers dial privateIps/publicIp at this port. */
  dataPort?: number;
  /** Linux: which cgroup controllers the user slice delegates (hard enforcement possible). */
  cgroup?: { memory: boolean; cpu: boolean };
  engine?: { proto: string; sha256: Record<string, string>; stages?: { engine: string } };
  net?: NetMeasurement;
  measuredAt: string;
}

// ---------- what the owner allows ----------

export interface Offer {
  enabled: boolean;
  roles: { worker: boolean; coordinator: boolean; replica: boolean };
  gpu: Array<{ id: string; memMiB: number }>;
  ramMiB: number;
  cpuCores: number;
  diskMiB: number;
  modelsDir: string;
}

export interface ModelFile {
  name: string;
  path: string;
  sizeBytes: number;
  sha256?: string;
  kind: "gguf" | "mtp" | "mmproj";
}

export interface NodeMetrics {
  ts: string;
  /** Numeric runtime diagnostics; no paths, process IDs or assignment identifiers. */
  runtime?: { releaseSequence: number; uptimeSec: number; workers: number; coordinators: number; replicas: number; stages: number };
  /** Measured ping/pong RTT on the live controller connection (includes relay path). */
  link?: { rttMs: number; measuredAt: string };
  cpuPct?: number;
  rssMiB?: number;
  freeRamMiB?: number;
  gpu?: Array<{ id: string; usedMiB: number; utilizationPct?: number; temperatureC?: number; powerW?: number; fanPct?: number }>;
  hardware?: {
    measuredAt: string;
    fans: Array<{ id: string; name: string; rpm?: number; targetRpm?: number; maxRpm?: number; mode?: string }>;
    temperatures: Array<{ name: string; celsius: number }>;
    fanControl: { state: "max" | "requested" | "automatic" | "unsupported" | "permission-required" | "error"; detail: string };
  };
  network?: Array<{ name: string; rxBps?: number; txBps?: number }>;
  /** Completed-token counter delta per sample interval. Counters advance at request completion;
   *  zero does not imply idle. Undefined for missing samples or a new/restarted server. */
  tokPerSec?: number;
  /** llama-server's own lifetime average (llamacpp:predicted_tokens_seconds). */
  tokPerSecAvg?: number;
  /** Time/status of the latest engine metrics scrape (separate from host metrics). */
  serverMetricsTs?: string;
  serverMetricsState?: "ok" | "partial" | "unavailable";
  tokensTotal?: number;
  inflight?: number;
  /** Served model name of the local llama-server the metrics came from. */
  serving?: string;
}

// ---------- what control asks a node to run ----------

/** How to reach another node's engine port: try `direct` addresses (TLS, pinned), else relay. */
export interface Endpoint {
  nodeId: string;
  certFp: string;
  /** Remote engine port on that node (rpc or peer port), reached through its data listener. */
  port: number;
  direct: Array<{ host: string; port: number }>;
  relay: boolean;
  /**
   * This peer will serve its port TO us over a reverse connection (it dials in). Set when control
   * issued that peer a `serve` target, so we prefer the inbound stream over addresses that, on a
   * network where the peer could not be dialled, are known not to answer.
   */
  inbound?: boolean;
}

export interface WorkerAssignment {
  kind: "worker";
  id: string;
  deploymentId: string;
  port: number;
  device: string;
  threads: number;
  memCapMiB?: number;
  /**
   * How many of the model's transformer blocks this worker holds, and how many the model has.
   *
   * The count exists only in the coordinator's tensor split, so without it a worker cannot tell its
   * owner what the machine is actually doing — it would know it is busy and nothing more. Both
   * fields are informational: the engine is driven entirely by the tensor split the coordinator
   * sends, so a worker never acts on them.
   */
  layers?: number;
  modelLayers?: number;
  peerPort?: number;
  /** Servers this worker pushes forwarded tensors to (index = position in the coordinator's --rpc list). */
  peers?: Array<{ index: number; endpoint: Endpoint }>;
  /**
   * Where this worker dials IN to serve its own rpc port.
   *
   * A worker behind a router nobody administers may never be diallable, and waiting for one that is
   * is not a strategy. The direction of the connect is not a property of the topology, so the worker
   * opens the stream to a peer that IS reachable - normally the coordinator, which publishes a
   * gateway mapping - and serves `port` over it. The bytes and the latency are those of a direct
   * dial; only who dials differs (node-agent/transport/servedial.ts).
   */
  serve?: Endpoint;
  /** Cert fingerprints allowed to connect to this node's data listener for this assignment. */
  allow: string[];
  enforce?: { ramMiB?: number; cpuCores?: number };
  /** Keep the engine's local tensor cache (-c). Default true: repeated loads of the same slab are instant. */
  cache?: boolean;
}

/** Draft proposals from repeated token sequences; no separate draft model is required. */
export interface NgramSpeculation { type: "ngram-simple" }

export interface CoordinatorAssignment {
  kind: "coordinator";
  id: string;
  deploymentId: string;
  model: { path: string; sha256?: string };
  rpc: Endpoint[];
  devices: string[];
  tensorSplit: number[];
  ctx: number;
  parallel: number;
  mtp?: { path: string; chain: number };
  speculation?: NgramSpeculation;
  env: Record<string, string>;
  extraArgs: string[];
  port: number;
  /** Served model name (--alias); what the router matches requests against. */
  modelName?: string;
  /** Free+reclaimable RAM the agent must see before launching (darwin fit gate). */
  fitMiB?: number;
  /** Id of an external service registered in the agent's config that must be stopped (via its maintenance script) to fit. */
  stopExternal?: string;
  allow: string[];
  enforce?: { ramMiB?: number; cpuCores?: number };
}

export interface ReplicaAssignment {
  kind: "replica";
  id: string;
  deploymentId: string;
  port: number;
  model?: { path: string; sha256?: string };
  /** Already-running server owned by something else (production llama-server): health only. */
  external?: { url: string; healthPath: string; maintenance?: string };
  modelName?: string;
  ctx?: number;
  parallel?: number;
  device?: string;
  mtp?: { path: string; chain: number };
  speculation?: NgramSpeculation;
  extraArgs?: string[];
  enforce?: { ramMiB?: number; cpuCores?: number };
  /** Free+reclaimable RAM the agent must see before launching (darwin fit gate). */
  fitMiB?: number;
  /** Id of an external service registered in the agent's config that must be stopped (via its maintenance script) to fit. */
  stopExternal?: string;
  allow: string[];
}

export interface StopAssignment {
  kind: "stop";
  id: string;
  deploymentId: string;
}

export interface NativeStageIdentity {
  schema: 1;
  engine: string;
  model_sha256: string;
  source_sha256: string;
  ctx: number;
  cache_k: "f32";
  cache_v: "f32";
  ubatch: 1;
  flash_attn: "disabled";
  stage_start: string;
  stage_end: string;
  stage_total: string;
}

export interface NativeStageEndpoint { nodeId: string; port: number; identity: NativeStageIdentity; binarySha256: string }
export interface NativeExecutionPlan {
  mode: "stages" | "prefill-decode";
  profile: "qwen35-2b-q8";
  endpoints: NativeStageEndpoint[];
  stateTransferQualification?: { sourceBinarySha256: string; targetBinarySha256: string; evidenceSha256: string };
}
export interface NativeStageWorkerPlan extends NativeStageEndpoint {
  modelPath: string;
  device: string;
  fitMiB?: number;
  enforce: { ramMiB: number; cpuCores: number };
}
export interface NativeExecutionPlacement extends NativeExecutionPlan {
  endpoints: NativeStageWorkerPlan[];
  qualificationEvidenceSha256: string;
}

/** One resident native context. State files live in an agent-generated private directory. */
export interface StageAssignment {
  kind: "stage";
  id: string;
  deploymentId: string;
  model: { path: string; sha256: string };
  port: number;
  ctx: number;
  gpuLayers: 999;
  identity: NativeStageIdentity;
  binarySha256: string;
  fitMiB?: number;
  allow: string[];
  enforce: { ramMiB: number; cpuCores: number };
}

export type Assignment = WorkerAssignment | CoordinatorAssignment | ReplicaAssignment | StageAssignment | StopAssignment;

export type AssignmentState = "starting" | "listening" | "loading" | "ready" | "stopped" | "failed";

// ---------- deployments (control side) ----------

export type DeploymentKind = "split" | "replica" | "external" | "stages" | "prefill-decode";
export type DeploymentState = "planned" | "placing" | "loading" | "ready" | "draining" | "stopped" | "failed";

export interface DeploymentSpec {
  name: string;
  /** Model profile id (control/profiles/*.json), "external", or "auto" to let control choose. */
  profile: string;
  /**
   * Serve the best model the nodes online can actually place, and keep re-deciding as they come and go.
   * The chosen profile and kind are written back onto this spec, so the record always says what is
   * really being served; the flag is what keeps the choice open.
   */
  autoModel?: boolean;
  kind: DeploymentKind;
  coordinatorNodeId?: string;
  workerNodeIds?: string[];
  /** Exact layer counts paired with workerNodeIds, in the same order; each must fit a profile envelope row. */
  workerLayers?: number[];
  replicaNodeId?: string;
  /** Explicit fleet budgets. GPU memory is reserved by the planner, not a hardware partition. */
  allocations?: NodeAllocation[];
  /** Ordered, explicitly qualified shards for kind stages. Ranges are [start,end). */
  stages?: Array<{ nodeId: string; modelPath: string; modelSha256: string; start: number; end: number }>;
  /** Two full-model resident contexts for kind prefill-decode. */
  prefillNodeId?: string;
  decodeNodeId?: string;
  modelSha256?: string;
  ctx?: number;
  parallel?: number;
  /** MTP chain length; 0 = no speculative decoding. */
  chain?: number;
  speculation?: NgramSpeculation;
  wire?: "off" | "f16" | "q8";
  batchedGets?: boolean;
  forwarding?: boolean;
  stopExternal?: boolean;
  /** "auto" (default): try direct TLS to peers, relay when unreachable; "relay": never dial directly (for A/B measurements). */
  transport?: "auto" | "relay";
  external?: { nodeId: string; url: string; healthPath: string; modelName: string; maintenance?: string };
}

export interface PlanWorker {
  nodeId: string;
  device: string;
  layers: number;
  port: number;
  peerPort?: number;
  threads: number;
  memCapMiB: number;
}

export interface Plan {
  coordinatorNodeId: string;
  coordinatorDevice: string;
  workers: PlanWorker[];
  tensorSplit: number[];
  /** Explicit placements only: engine weights include the output slot on the coordinator.
   * tensorSplit remains requested transformer counts; automatic plans retain historical weights. */
  engineTensorSplit?: number[];
  ctx: number;
  parallel: number;
  chain: number;
  speculation?: NgramSpeculation;
  env: Record<string, string>;
  modelPath: string;
  mtpPath?: string;
  /** Native contexts use the control-side execution adapter, never a raw OpenAI port proxy. */
  nativeExecution?: NativeExecutionPlacement;
  /** Human-readable reasons for every choice and every clamp. */
  reasons: string[];
  allocations?: NodeAllocation[];
}

export interface NodeAllocation {
  nodeId: string;
  ramMiB: number;
  cpuCores: number;
  gpu: Array<{ id: string; memMiB: number }>;
}

export interface LayerDistribution {
  coordinatorNodeId: string;
  workerNodeIds: string[];
  workerLayers: number[];
}

export interface Deployment {
  id: string;
  spec: DeploymentSpec;
  /** Saved separately: active placement and recovery change only after Apply. */
  savedDistribution?: LayerDistribution;
  state: DeploymentState;
  plan?: Plan;
  /** Where requests go once ready. */
  endpoint?: { nodeId: string; port: number; modelName: string };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnvelopeRow {
  /** Layers per worker this row was validated for. */
  workerLayers: number;
  maxCtx: number;
  maxParallel: number;
  maxChain: number;
}

export interface ModelProfile {
  id: string;
  /**
   * Preference order for automatic model choice: higher is the better model to serve. Editorial on
   * purpose - file size is not quality - and read only by the auto policy.
   */
  rank?: number;
  name: string;
  /** Served model name for /v1 routing. */
  modelName: string;
  /** Regex (string) matched against ModelFile.name to find the weights on a node. */
  ggufPattern: string;
  mtpPattern?: string;
  layers: number;
  layerMiB: number;
  /** Host-side residency the coordinator needs beyond GPU layers (PLE table etc.). */
  coordinatorHostMiB: number;
  /** Bytes crossing one layer boundary per token (documentation + planner reasons). */
  boundaryBytes: number;
  /** Validated (workerLayers, ctx, parallel, chain) combinations; the planner never leaves them. */
  envelope: EnvelopeRow[];
  extraArgs: string[];
  /** Per-worker VRAM margin for compute buffers at the envelope's max ctx/parallel. */
  workerMarginMiB: number;
  /** How a node obtains these files when it does not have them. Optional: a profile without it
   *  can still be served, but a node owner has no in-UI way to fetch the weights. */
  download?: ModelDownload;
}

/**
 * One file a node fetches to serve a profile's model. `name` must match the profile's
 * `ggufPattern` (kind "gguf") or `mtpPattern` (kind "mtp"); validation enforces that, so a file
 * obtained this way is by construction the file the planner will match on that node.
 *
 * The hash is the whole-file sha256. It is what makes an unauthenticated third-party URL safe to
 * fetch: the bytes are verified before the file is published into the models directory, so a
 * mutated or truncated download becomes a failed fetch, never a served model.
 */
export interface ModelDownloadFile {
  name: string;
  kind: "gguf" | "mtp";
  url: string;
  sha256: string;
  bytes: number;
}

export interface ModelDownload {
  files: ModelDownloadFile[];
}

/**
 * One model the fleet can serve, advertised to node owners so they can opt in and fetch it.
 * Reaches a node through the existing node-scoped `/v1/models?catalog=1` response, so no new
 * control-to-agent message is needed: the node requests the catalog with its own API key.
 */
export interface CatalogModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  ready: number;
  /** True when this node could serve the model as it stands (weights present, offer sufficient). */
  local_eligible: boolean;
  local_reasons: string[];
  /** Present when the profile declares how to obtain the weights; absent means "cannot fetch". */
  download?: ModelDownload;
}

/**
 * Where a node may fetch weights from. Remote origins must be https; an explicit loopback origin is
 * allowed so a node can pull from a mirror on its own machine (and so this path is testable without
 * a TLS fixture). Nothing here is trusted for integrity — the declared sha256 is what decides
 * whether fetched bytes are ever installed.
 */
export const DOWNLOAD_URL_RE = /^https:\/\/[^\s]+$|^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s]*)?$/;

/** Reject a catalog whose payload cannot be trusted to describe what will actually be downloaded. */
export function validCatalogDownload(file: unknown): file is ModelDownloadFile {
  if (typeof file !== "object" || file === null) return false;
  const f = file as Partial<ModelDownloadFile>;
  if (typeof f.name !== "string" || f.name.length === 0 || f.name.length > 240) return false;
  if (f.name.includes("/") || f.name.includes("\\") || f.name === "." || f.name === "..") return false;
  if (f.kind !== "gguf" && f.kind !== "mtp") return false;
  if (typeof f.url !== "string" || !DOWNLOAD_URL_RE.test(f.url) || f.url.length > 2048) return false;
  if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) return false;
  if (typeof f.bytes !== "number" || !Number.isSafeInteger(f.bytes) || f.bytes <= 0) return false;
  return true;
}

// ---------- agent channel messages ----------

export interface ChallengeMsg { t: "challenge"; nonce: string }
export interface AuthMsg { t: "auth"; nodeId: string; nonce: string; certFp: string; signature: string }
export interface WelcomeMsg { t: "welcome"; nodeId: string; serverTime: string; inferenceKey?: string }
export interface HelloMsg {
  t: "hello";
  proto: number;
  agentVersion: string;
  caps: Capabilities;
  offer: Offer;
  models: ModelFile[];
  assignments: Array<{ id: string; state: AssignmentState; detail?: string; ports?: Record<string, number> }>;
}
export interface HeartbeatMsg { t: "heartbeat"; ts: string; metrics: NodeMetrics; caps?: Partial<Capabilities> }
export interface OfferMsg { t: "offer"; offer: Offer }
export interface ModelsMsg { t: "models"; models: ModelFile[] }
export interface AssignmentStateMsg {
  t: "assignment";
  id: string;
  state: AssignmentState;
  detail?: string;
  /** Local ports the agent chose (e.g. dialed endpoints), for diagnostics. */
  ports?: Record<string, number>;
}
export interface LogMsg { t: "log"; assignmentId: string; line: string }
export interface AssignMsg { t: "assign"; assignment: Assignment }
/** Ask a node to fetch a catalog model's declared weights. The node decides whether it fits (disk reserve,
 *  validity) and reports progress through its log and by re-reporting its model list when files land. */
export interface FetchMsg { t: "fetch"; profile: string }
export interface ErrorMsg { t: "error"; message: string }
export interface PingMsg { t: "ping"; ts: string; link?: { rttMs: number; measuredAt: string } }
export interface PongMsg { t: "pong"; ts: string }

export type AgentToControl = AuthMsg | HelloMsg | HeartbeatMsg | OfferMsg | ModelsMsg | AssignmentStateMsg | LogMsg | PongMsg;
export type ControlToAgent = ChallengeMsg | WelcomeMsg | AssignMsg | ErrorMsg | PingMsg | FetchMsg;

// ---------- enrollment (HTTP) ----------

export interface EnrollRequest {
  code: string;
  nodeId: string;
  pubJwk: JsonWebKey;
  certFp: string;
  hostname: string;
  caps: Capabilities;
  signature?: string;
}
export interface EnrollResponse { ok: true; nodeId: string; controlPubJwk: JsonWebKey; agentUrl: string }

// ---------- stream headers (binary channel) ----------

/** OPEN payload. `relay`: bridge me to node `target`'s data listener port `port`. `http`: forward an HTTP request to the local port. */
export type StreamHeader =
  | { kind: "relay"; target: string; port: number; from: string }
  | { kind: "http"; port: number }
  | { kind: "data"; port: number; from: string };
