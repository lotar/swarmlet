import { expect, test } from "bun:test";
import type { StageAssignment } from "../types.ts";
import { parseControlMessage, validateAssignment } from "../validate.ts";
function stage(): StageAssignment {
 return { kind: "stage", id: "as-native", deploymentId: "dep-native", model: { path: "/models/stage.gguf", sha256: "a".repeat(64) }, port: 19000, ctx: 1024, gpuLayers: 999, binarySha256: "b".repeat(64), fitMiB: 5503, allow: [], enforce: { ramMiB: 8192, cpuCores: 2 }, identity: { schema: 1, engine: "c".repeat(64), model_sha256: "a".repeat(64), source_sha256: "d".repeat(64), ctx: 1024, cache_k: "f32", cache_v: "f32", ubatch: 1, flash_attn: "disabled", stage_start: "0", stage_end: "3", stage_total: "24" } };
}
const parse = (a: unknown) => parseControlMessage(JSON.stringify({ t: "assign", assignment: a }));
test("valid stage assignment survives the actual control-message parser", () => {
 const a = stage(); expect(validateAssignment(a).ok).toBe(true);
 const parsed = parse(a); expect(parsed.ok).toBe(true);
 if(parsed.ok) expect(parsed.value).toEqual({t:"assign",assignment:a});
});
test("middle/final shards and full P/D contexts preserve their identities", () => {
 for(const [start,end] of [["3","6"],["3","24"],["0","24"],["",""]]) {
  const a=stage(); a.identity.stage_start=start!;a.identity.stage_end=end!;delete a.fitMiB;
  if(!start){a.identity.stage_total="";a.identity.source_sha256=a.model.sha256;}
  expect(parse(a).ok).toBe(true);
 }
});
test("malformed native assignments cannot cross the control-message parser", () => {
 const changes: Array<(a:any)=>void> = [
 a=>a.id="../escape",a=>a.id="",a=>a.deploymentId="",a=>a.extra=true,
 a=>a.model=null,a=>a.model.path="",a=>a.model.path="/models/x\u0000.gguf",a=>a.model.sha256="A".repeat(64),a=>a.model.extra=true,
 a=>a.port=19000.5,a=>a.port=1023,a=>a.port=65536,a=>a.ctx=2048,a=>a.gpuLayers=0,a=>a.binarySha256="bad",
 a=>a.fitMiB=-1,a=>a.fitMiB=1.5,a=>a.allow=["bad"],a=>a.allow=["e".repeat(64)],
 a=>a.enforce=null,a=>a.enforce.ramMiB=0,a=>a.enforce.ramMiB=1.5,a=>a.enforce.cpuCores=1,a=>a.enforce.extra=1,
 a=>a.identity=null,a=>a.identity.schema=2,a=>a.identity.engine="bad",a=>a.identity.model_sha256="b".repeat(64),a=>a.identity.source_sha256="bad",
 a=>a.identity.ctx=2048,a=>a.identity.cache_k="f16",a=>a.identity.cache_v="f16",a=>a.identity.ubatch=64,a=>a.identity.flash_attn="auto",a=>a.identity.extra=true,
 a=>a.identity.stage_start="-1",a=>a.identity.stage_start="03",a=>a.identity.stage_start=0,a=>a.identity.stage_end="0",a=>a.identity.stage_end="25",a=>a.identity.stage_total="23",
 a=>a.identity.stage_start="",a=>{a.identity.stage_start="";a.identity.stage_end="";a.identity.stage_total="";},
 ];
 for(const change of changes){const a=stage();change(a);expect(validateAssignment(a).ok).toBe(false);expect(parse(a).ok).toBe(false);}
 for(const key of Object.keys(stage()).filter(k=>k!=="fitMiB")){const a:any=stage();delete a[key];expect(parse(a).ok).toBe(false);}
 for(const key of Object.keys(stage().identity)){const a:any=stage();delete a.identity[key];expect(parse(a).ok).toBe(false);}
});
