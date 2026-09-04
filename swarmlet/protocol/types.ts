// Shared contract between the node agent and the control plane. Types only; validators live in
// validate.ts, framing in frame.ts. Sizes are MiB throughout (the UIs render GiB).

export const PROTOCOL_VERSION = 1;
export const AGENT_UI_PORT = 47800;
export const AGENT_DATA_PORT = 47801;
export const HEARTBEAT_MS = 5000;

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
  os: "darwin" | "linux";
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
  /** Linux: which cgroup controllers the user slice delegates (hard enforcement possible). */
  cgroup?: { memory: boolean; cpu: boolean };
  engine?: { proto: string; sha256: Record<string, string> };
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
  cpuPct?: number;
  rssMiB?: number;
  freeRamMiB?: number;
  gpu?: Array<{ id: string; usedMiB: number }>;
  /** From llama-server /metrics on coordinator/replica nodes. */
  tokPerSec?: number;
  inflight?: number;
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
}

export interface WorkerAssignment {
  kind: "worker";
  id: string;
  deploymentId: string;
  port: number;
  device: string;
  threads: number;
  memCapMiB?: number;
  peerPort?: number;
  /** Servers this worker pushes forwarded tensors to (index = position in the coordinator's --rpc list). */
  peers?: Array<{ index: number; endpoint: Endpoint }>;
  /** Cert fingerprints allowed to connect to this node's data listener for this assignment. */
  allow: string[];
  enforce?: { ramMiB?: number; cpuCores?: number };
}

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
  env: Record<string, string>;
  extraArgs: string[];
  port: number;
  /** Id of an external deployment on this node that must be stopped (via its maintenance script) to fit. */
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
  ctx?: number;
  parallel?: number;
  extraArgs?: string[];
  allow: string[];
}

export interface StopAssignment {
  kind: "stop";
  id: string;
  deploymentId: string;
}

export type Assignment = WorkerAssignment | CoordinatorAssignment | ReplicaAssignment | StopAssignment;

export type AssignmentState = "starting" | "listening" | "loading" | "ready" | "stopped" | "failed";

// ---------- deployments (control side) ----------

export type DeploymentKind = "split" | "replica" | "external";
export type DeploymentState = "planned" | "placing" | "loading" | "ready" | "draining" | "stopped" | "failed";

export interface DeploymentSpec {
  name: string;
  /** Model profile id (control/profiles/*.json) or "external". */
  profile: string;
  kind: DeploymentKind;
  coordinatorNodeId?: string;
  workerNodeIds?: string[];
  replicaNodeId?: string;
  ctx?: number;
  parallel?: number;
  /** MTP chain length; 0 = no speculative decoding. */
  chain?: number;
  wire?: "off" | "f16" | "q8";
  batchedGets?: boolean;
  forwarding?: boolean;
  stopExternal?: boolean;
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
  ctx: number;
  parallel: number;
  chain: number;
  env: Record<string, string>;
  modelPath: string;
  mtpPath?: string;
  /** Human-readable reasons for every choice and every clamp. */
  reasons: string[];
}

export interface Deployment {
  id: string;
  spec: DeploymentSpec;
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
}

// ---------- agent channel messages ----------

export interface ChallengeMsg { t: "challenge"; nonce: string }
export interface AuthMsg { t: "auth"; nodeId: string; nonce: string; certFp: string; signature: string }
export interface WelcomeMsg { t: "welcome"; nodeId: string; serverTime: string }
export interface HelloMsg {
  t: "hello";
  proto: number;
  agentVersion: string;
  caps: Capabilities;
  offer: Offer;
  models: ModelFile[];
  assignments: Array<{ id: string; state: AssignmentState }>;
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
export interface ErrorMsg { t: "error"; message: string }
export interface PingMsg { t: "ping"; ts: string }
export interface PongMsg { t: "pong"; ts: string }

export type AgentToControl = AuthMsg | HelloMsg | HeartbeatMsg | OfferMsg | ModelsMsg | AssignmentStateMsg | LogMsg | PongMsg;
export type ControlToAgent = ChallengeMsg | WelcomeMsg | AssignMsg | ErrorMsg | PingMsg;

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
