import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadControlConfig } from "../config.ts";
import { bootControl } from "../server.ts";
import { loadIdentity } from "../../node-agent/identity.ts";
import { agentPaths } from "../../node-agent/paths.ts";
import { signObject } from "../../protocol/sign.ts";

test("public web opt-in keeps admin authentication and enrollment trust across a reverse proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarmlet-public-web-"));
  const cfg = loadControlConfig({ dataDir: dir, host: "127.0.0.1", port: 0, publicUrl: "https://app.swarmlet.ai", publicWeb: true, adminTrustLoopback: true, logLevel: "warn" });
  const ctl = await bootControl(cfg);
  const base = `http://127.0.0.1:${ctl.server.port}`;
  const forwarded = { "cf-ray": "edge", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https" };
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...forwarded, ...init.headers }, redirect: "manual" });
  try {
    for (const path of ["/", "/app.js", "/processing.js", "/style.css", "/health"]) expect((await request(path)).status).toBe(200);
    for (const path of ["/api/nodes", "/api/stream", "/v1/models"]) {
      expect((await request(path)).status).toBe(401); // forwarding never grants loopback admin
      expect((await request(path, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      const res = await request(path, { headers: { authorization: `Bearer ${cfg.adminToken}` } });
      expect(res.status).toBe(200); await res.body?.cancel();
    }
    const key = ctl.reg.createApiKey("inference-only");
    expect((await request("/v1/models", { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
    expect((await request("/api/nodes", { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
    const bad = new FormData(); bad.set("token", "wrong");
    expect((await request("/login", { method: "POST", body: bad })).status).toBe(401);
    const form = new FormData(); form.set("token", cfg.adminToken);
    const login = await request("/login", { method: "POST", body: form });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie")!;
    for (const attr of ["Secure", "HttpOnly", "SameSite=Strict"]) expect(cookie).toContain(attr);
    expect((await request("/api/nodes", { headers: { cookie: cookie.split(";")[0]! } })).status).toBe(200);
    const identity = await loadIdentity(agentPaths(join(dir, "node")));
    const body = await signObject({ code: "", nodeId: identity.nodeId, pubJwk: identity.pubJwk, certFp: identity.certFp, hostname: "unknown-public-node", caps: { os: "linux", arch: "x64" } }, identity.keys.priv);
    expect((await request("/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(403);
    expect(ctl.reg.getNode(identity.nodeId)).toBeNull();
    expect((await request("/logout")).headers.get("set-cookie")).toContain("Secure");
  } finally { ctl.deployments.dispose(); ctl.server.stop(true); ctl.reg.close(); await rm(dir, { recursive: true, force: true }); }
});
