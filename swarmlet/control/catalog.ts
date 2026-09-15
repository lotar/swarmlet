import type { ModelDownload, ModelProfile } from "../protocol/types.ts";
import type { DeploymentManager } from "./deployments.ts";
import { PlanError, planDeployment } from "./planner.ts";
import type { NodeRow } from "./registry.ts";

interface CatalogEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  ready: number;
  local_eligible: boolean;
  local_reasons: string[];
  /** How a node can obtain these weights. Carried so a node owner can fetch what it lacks rather
   *  than being told only that it is missing. Never implies the file is present. */
  download?: ModelDownload;
}

/** Catalog visibility is independent of readiness. Eligibility uses the deployment planner. */
export function modelCatalog(profiles: Iterable<ModelProfile>, routing: ReturnType<DeploymentManager["routing"]>, node: NodeRow | null) {
  const models = new Map<string, CatalogEntry>();
  for (const profile of profiles) {
    let eligible = false;
    let reasons = ["This node is not connected to control."];
    if (node) {
      try {
        planDeployment({ profile, nodes: [node], usedPorts: new Map(), spec: { name: "Local availability", profile: profile.id, kind: "replica", replicaNodeId: node.id } });
        eligible = true;
        reasons = [];
      } catch (error) {
        if (!(error instanceof PlanError)) throw error;
        reasons = error.reasons.map(reason => reason.replace(`holds no model matching ${profile.ggufPattern}`, "does not have this model downloaded"));
      }
    }
    const existing = models.get(profile.modelName);
    if (!existing || eligible) models.set(profile.modelName, { id: profile.modelName, object: "model", created: 0, owned_by: "swarmlet", ready: 0, local_eligible: eligible, local_reasons: reasons, download: profile.download });
    else if (!existing.download && profile.download) existing.download = profile.download;
  }
  for (const route of routing) {
    const entry = models.get(route.modelName) ?? { id: route.modelName, object: "model", created: 0, owned_by: "swarmlet", ready: 0, local_eligible: false, local_reasons: ["This model has no local deployment profile."] };
    entry.ready = route.deployments.length;
    entry.created = route.created;
    models.set(route.modelName, entry);
  }
  return { object: "list", data: [...models.values()] };
}
