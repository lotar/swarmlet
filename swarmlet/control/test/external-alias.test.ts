// External alias rewrite: a deployment may route the retired mesh alias while the external server only
// accepts its own model id. The rewrite is pure and limited to the model field.
import { describe, expect, test } from "bun:test";
import { upstreamModelOf } from "../router.ts";
describe("external upstream model", () => {
  test("declared upstream model is used; managed deployments have none", () => {
    expect(upstreamModelOf({ kind: "external", upstreamModel: "incoai/Qwen3.8-27B-Splash" }))
      .toBe("incoai/Qwen3.8-27B-Splash");
    expect(upstreamModelOf({ kind: "external" }))
      .toBeUndefined();
    expect(upstreamModelOf({ kind: "replica" })).toBeUndefined();
  });
});
