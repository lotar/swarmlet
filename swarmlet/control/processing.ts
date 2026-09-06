import type { ControlDeps } from "./server.ts";

/** Participant-safe projection. Never serialize registry rows, assignments, endpoints or plans. */
export function processingSnapshot(deps: ControlDeps, url: URL, now = Date.now()) {
  const model = url.searchParams.get("model");
  const pinned = url.searchParams.get("deployment");
  const candidates = deps.deployments.routing().filter((m) => !model || m.modelName === model).flatMap((m) => m.deployments);
  const pick = pinned ? candidates.find((d) => d.id === pinned || d.name === pinned)
    : candidates.sort((a, b) => (a.inflight - b.inflight) || ((a.rttMs ?? 1e9) - (b.rttMs ?? 1e9)))[0];
  const dep = pick ? deps.reg.getDeployment(pick.id) : pinned ? deps.reg.getDeployment(pinned) : null;
  const profile = dep && deps.profiles.get(dep.spec.profile);
  const modelName = dep?.endpoint?.modelName ?? dep?.spec.external?.modelName ?? profile?.modelName;
  if (!dep || (model && modelName !== model)) return null;
  const plan = dep.plan;
  const total = profile?.layers ?? plan?.tensorSplit.reduce((a, b) => a + b, 0) ?? null;
  const rows = plan ? [
    { id: plan.coordinatorNodeId, role: dep.spec.kind === "replica" ? "Replica" : "Coordinator", device: plan.coordinatorDevice, layers: plan.tensorSplit.at(-1) ?? total },
    ...plan.workers.map((w) => ({ id: w.nodeId, role: "Worker", device: w.device, layers: w.layers })),
  ] : [{ id: dep.endpoint?.nodeId ?? dep.spec.external?.nodeId ?? "", role: "External server", device: null, layers: null }];
  return {
    sampledAt: new Date(now).toISOString(), model: modelName,
    deployment: { id: dep.id, name: dep.spec.name, state: dep.state },
    shareBasis: plan ? "assigned_layers" : "whole_model", totalLayers: total,
    nodes: rows.map((row) => {
      const n = deps.reg.getNode(row.id), metrics = n?.metrics;
      const online = deps.channel.isOnline(row.id);
      const age = now - Date.parse(metrics?.ts ?? "");
      const fresh = online && Number.isFinite(age) && age >= -2000 && age <= 10_000;
      const pct = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
      return { ...row, name: n?.hostname ?? row.id.slice(0, 8), online,
        sharePct: !plan ? 100 : total && row.layers != null ? pct(row.layers / total * 100) : null,
        metricsState: !online ? "offline" : fresh ? "live" : "stale",
        metricsAt: metrics?.ts ?? null, cpuPct: fresh ? pct(metrics?.cpuPct) : null,
        gpuUsedMiB: fresh && metrics?.gpu?.length ? metrics.gpu.reduce((sum, g) => sum + g.usedMiB, 0) : null,
      };
    }),
  };
}
