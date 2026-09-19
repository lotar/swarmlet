// External alias rewrite: a deployment may route the retired mesh alias while the external server only
// accepts its own model id. The rewrite is pure and limited to the model field.
import { describe, expect, test } from "bun:test";
import { upstreamModelOf } from "../router.ts";
import type { DeploymentSpec } from "../../protocol/types.ts";

const spec = (over: Partial<DeploymentSpec> = {}): DeploymentSpec => ({ name: "s", profile: "external", kind: "external", ...over });

describe("external upstream model", () => {
  test("declared upstream model is used; managed deployments have none", () => {
    expect(upstreamModelOf(spec({ external: { nodeId: "n", url: "http://127.0.0.1:8120", healthPath: "/health", modelName: "qwen3.8-27b", upstreamModel: "incoai/Qwen3.8-27B-Splash" } })))
      .toBe("incoai/Qwen3.8-27B-Splash");
    expect(upstreamModelOf(spec({ external: { nodeId: "n", url: "http://127.0.0.1:8120", healthPath: "/health", modelName: "qwen3.8-27b" } })))
      .toBeUndefined();
    expect(upstreamModelOf({ name: "r", profile: "p", kind: "replica" })).toBeUndefined();
  });
});
