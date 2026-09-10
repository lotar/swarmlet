import { afterEach, expect, test } from "bun:test";
import { createNodeInference, type InferenceTarget } from "../inference.ts";
import { startLocalApi, type LocalApiDeps } from "../localapi.ts";
import { UpdateDrain } from "../update-drain.ts";
const servers: Array<{ stop(force: boolean): void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });
function serve(fetch: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }); servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
const request = (model = "shared", extra = {}, headers = {}) => new Request("http://127.0.0.1/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }) });

test("updates wait for the local response body to finish and block new inference until resumed", async () => {
  const drain = new UpdateDrain();
  let end: (() => void) | undefined;
  const local = serve(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
    end = () => { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close(); };
  } }), { headers: { "content-type": "text/event-stream" } }));
  const handler = createNodeInference({ local: () => [{ model: "shared", deploymentId: "d", url: local, created: 0 }], remote: () => null, nodeId: () => "n", admit: () => drain.admit() });
  const response = await handler(request(), "/v1/chat/completions");
  expect(drain.begin()).toBe(false);
  const body = response.text();
  end!(); await body;
  expect(drain.begin()).toBe(true);
  expect((await handler(request(), "/v1/chat/completions")).status).toBe(503);
  drain.resume();
  const resumed = await handler(request(), "/v1/chat/completions");
  expect(resumed.status).toBe(200);
  await resumed.body!.cancel();
  expect(drain.begin()).toBe(true);
});

test("local ready server bypasses control, strips keys and preserves streamed UTF-8 bytes", async () => {
  let remoteCalls = 0;
  const expected = 'data: {"choices":[{"delta":{"content":"Živjo"}}]}\n\ndata: [DONE]\n\n';
  const local = serve(async (req) => {
    expect(req.headers.get("authorization")).toBeNull();
    expect(req.headers.get("cookie")).toBeNull();
    expect((await req.json() as { model: string }).model).toBe("shared");
    const bytes = new TextEncoder().encode(expected); let i = 0;
    return new Response(new ReadableStream({ pull(c) { if (i === bytes.length) c.close(); else c.enqueue(bytes.slice(i, ++i)); } }), { headers: { "content-type": "text/event-stream" } });
  });
  const remote = serve(() => { remoteCalls++; return Response.json({}); });
  const handler = createNodeInference({ local: () => [{ model: "shared", deploymentId: "d1", created: 1700000000, url: local }], remote: () => ({ url: remote, key: "secret" }), nodeId: () => "node1" });
  const result = await handler(request("shared", {}, { authorization: "Bearer caller", cookie: "private" }), "/v1/chat/completions");
  expect(await result.text()).toBe(expected);
  expect(result.headers.get("x-swarmlet-route")).toBe("local");
  expect(result.headers.get("x-swarmlet-node")).toBe("node1");
  expect(remoteCalls).toBe(0);
});

test("worker uses mesh key, forwards deployment pin and returns upstream errors unchanged", async () => {
  const remote = serve(async (req) => {
    expect(req.headers.get("authorization")).toBe("Bearer participant-key");
    expect(req.headers.get("cookie")).toBeNull();
    expect(req.headers.get("x-swarmlet-deployment")).toBe("d2");
    expect((await req.json() as { model: string }).model).toBe("other");
    return Response.json({ error: { message: "model unavailable" } }, { status: 409 });
  });
  const handler = createNodeInference({ local: () => [], remote: () => ({ url: remote, key: "participant-key" }), nodeId: () => "worker" });
  const result = await handler(request("other", {}, { authorization: "Bearer untrusted", "x-swarmlet-deployment": "d2" }), "/v1/chat/completions");
  expect(result.status).toBe(409); expect(result.headers.get("x-swarmlet-route")).toBe("mesh");
  expect(await result.json()).toEqual({ error: { message: "model unavailable" } });
});

test("model list merges local and mesh with local preference and survives control failure", async () => {
  let online = true;
  const remote = serve((req) => {
    expect(req.headers.get("authorization")).toBe("Bearer participant-key");
    return online ? Response.json({ data: [{ id: "shared", created: 1600000000 }, { id: "remote", created: 1600000010 }] }) : new Response("offline", { status: 503 });
  });
  let targets: InferenceTarget[] = [{ model: "shared", deploymentId: "d1", created: 1700000000, url: "http://127.0.0.1:8100" }];
  const handler = createNodeInference({ local: () => targets, remote: () => ({ url: remote, key: "participant-key" }), nodeId: () => "node1" });
  const req = new Request("http://127.0.0.1/v1/models");
  const first = await (await handler(req, "/v1/models")).json() as { data: Array<{ id: string; route: string; created: number }> };
  expect(first.data.map((m) => [m.id, m.route])).toEqual([["shared", "local"], ["remote", "mesh"]]);
  expect(first.data.map((m) => m.created)).toEqual([1700000000, 1600000010]);
  online = false;
  const offline = await (await handler(req, "/v1/models")).json() as { mesh_available: boolean; data: unknown[] };
  expect(offline.mesh_available).toBe(false); expect(offline.data).toHaveLength(1);
  targets = []; expect((await handler(req, "/v1/models")).status).toBe(503);
});

test("cancelling local response disconnects upstream without replaying on mesh", async () => {
  let cancelled = false, meshCalls = 0;
  const local = serve((req) => {
    req.signal.addEventListener("abort", () => { cancelled = true; });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {}\n\n')); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  });
  const remote = serve(() => { meshCalls++; return Response.json({}); });
  const handler = createNodeInference({ local: () => [{ model: "shared", deploymentId: "d", created: 1700000000, url: local }], remote: () => ({ url: remote, key: "key" }), nodeId: () => "n" });
  const res = await handler(request(), "/v1/chat/completions");
  const reader = res.body!.getReader(); await reader.read(); await reader.cancel();
  for (let i = 0; i < 50 && !cancelled; i++) await Bun.sleep(10);
  expect(cancelled).toBe(true); expect(meshCalls).toBe(0);
});

test("unsupported paths, missing model, disconnected mesh, and redirecting upstream fail closed", async () => {
  const handler = createNodeInference({ local: () => [], remote: () => null, nodeId: () => "n" });
  expect((await handler(request(), "/v1/files")).status).toBe(404);
  expect((await handler(request(), "/v1/chat/completions")).status).toBe(503);
  expect((await handler(request(""), "/v1/chat/completions")).status).toBe(400);
  const redirect = serve(() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/private" } }));
  const redirected = createNodeInference({ local: () => [], remote: () => ({ url: redirect, key: "key" }), nodeId: () => "n" });
  expect((await redirected(request(), "/v1/chat/completions")).status).toBe(502);
});

test("local HTTP API rejects foreign browser origins and DNS-rebinding Host", async () => {
  let calls = 0;
  const server = startLocalApi(0, { inference: async () => { calls++; return Response.json({ object: "list", data: [] }); } } as unknown as LocalApiDeps); servers.push(server);
  const url = `http://127.0.0.1:${server.port}/v1/models`;
  expect((await fetch(url, { headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect((await fetch(url, { headers: { host: "evil.example" } })).status).toBe(403);
  expect((await fetch(url, { headers: { origin: new URL(url).origin } })).status).toBe(200);
  expect((await fetch(url)).status).toBe(200); expect(calls).toBe(2);
});

test('participant telemetry follows local preference or explicit actual deployment without forwarding caller secrets', async () => {
  const seen: string[] = [];
  const remote=serve(req=>{
    expect(req.headers.get('authorization')).toBe('Bearer participant'); expect(req.headers.get('cookie')).toBeNull();
    const u=new URL(req.url); expect(u.pathname).toBe('/v1/mesh'); expect(u.searchParams.get('model')).toBe('shared');
    expect(u.searchParams.has('upstream')).toBe(false); seen.push(u.searchParams.get('deployment')!);
    return Response.json({deployment:{id:u.searchParams.get('deployment')}, nodes:[]});
  });
  const handler=createNodeInference({local:()=>[{model:'shared',deploymentId:'local',url:'http://unused',created:1}], remote:()=>({url:remote,key:'participant'}), nodeId:()=> 'node'});
  for(const query of ['model=shared&upstream=evil','model=shared&deployment=actual']) {
    const res=await handler(new Request('http://localhost/v1/mesh?'+query,{headers:{cookie:'private',authorization:'Bearer admin'}}),'/v1/mesh'); expect(res.status).toBe(200); await res.json();
  }
  expect(seen).toEqual(['local','actual']);
  const offline=createNodeInference({local:()=>[],remote:()=>null,nodeId:()=> 'n'});
  expect((await offline(new Request('http://localhost/v1/mesh'),'/v1/mesh')).status).toBe(503);
});

test('full catalog keeps unavailable models disabled and fails closed when cached mesh routes disappear', async () => {
  let online=true;
  const remote=serve(req=>{
    const url=new URL(req.url); expect(url.searchParams.get('node')).toBe('worker');expect(url.searchParams.get('catalog')).toBe('1');
    return online ? Response.json({data:[{id:'ready',ready:1,local_eligible:false,local_reasons:['Insufficient RAM']},{id:'unserved',ready:0,local_eligible:false,local_reasons:['Weights missing']}]}) : new Response('offline',{status:503});
  });
  const handler=createNodeInference({local:()=>[],remote:()=>({url:remote,key:'key'}),nodeId:()=> 'worker'});
  const req=new Request('http://localhost/v1/models?catalog=1');
  const first=await (await handler(req,'/v1/models')).json() as any;
  expect(first.data.map((m:any)=>[m.id,m.selectable,m.route])).toEqual([['ready',true,'mesh'],['unserved',false,'unavailable']]);
  expect(first.data[0].local_reasons).toEqual(['Insufficient RAM']);
  online=false;
  const cached=await (await handler(req,'/v1/models')).json() as any;
  expect(cached.data).toHaveLength(2);expect(cached.data.every((m:any)=>!m.selectable)).toBe(true);expect(cached.mesh_available).toBe(false);
});
