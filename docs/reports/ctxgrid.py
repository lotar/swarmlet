#!/usr/bin/env python3
"""Slot/concurrency sweep with real per-request latency on the 2-Mac split.

The ctx sweep measured the controller's periodic link RTT, which characterises the link and not a
request. This measures what a caller actually experiences, per request, by streaming:

  * TTFT      — wall clock until the first content token. Includes queueing behind other slots,
                prompt evaluation, the ring trip, and the network: exactly the number an operator
                feels when they turn slots up.
  * total     — wall clock until completion.
  * engine    — prompt_ms and predicted_ms as the engine reports them.
  * overhead  — total minus engine compute. This is the transport + ring + queueing remainder: the
                "implication" the operator wanted to see, isolated from the model's own speed.

Axes: --parallel in {1, 4, 8, 16} (the deployment's slot count) x ctx in {4096, 262144}, with N
concurrent requests per level so contention is actually present rather than assumed.
"""
import json, subprocess, sys, threading, time, datetime, hashlib

CONTROL = "https://app.swarmlet.ai"
TOKEN = json.load(open("/Users/lotar/.swarmlet/control/control.json"))["adminToken"]
COORD, WORKER = "30f05a2670c368d0", "26bc380240373930"
PROFILE = "qwen38-27b-q8"
PARALLELS = [1, 2, 4, 8, 16]
CTS = [8192, 65536, 262144]
MAX_TOKENS = 64
RESULTS = "/tmp/ctxgrid.jsonl"
LOG = "/tmp/ctxgrid.log"
READY_TIMEOUT = 8 * 60

PROMPT = ("The mesh routes inference across sovereign nodes. " * 20) + "\n\nReply with exactly: OK"


def log(msg):
    line = f"{datetime.datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(LOG, "a") as fh:
        fh.write(line + "\n")


def api(path, method="GET", body=None, timeout=90):
    cmd = ["curl", "-s", "--max-time", str(timeout), "-X", method, f"{CONTROL}{path}", "-H", f"Authorization: Bearer {TOKEN}"]
    if body is not None:
        cmd += ["-H", "content-type: application/json", "-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {"_raw": out[:300]}


def node_metrics(nid):
    for n in api("/api/nodes").get("nodes", []):
        if n["id"] == nid:
            m = n.get("metrics") or {}
            return {"freeRamMiB": m.get("freeRamMiB"), "cpuPct": m.get("cpuPct")}
    return {}


def one_request(idx, results, start_gate):
    """Stream one completion; record TTFT, total, engine timings and the transport remainder."""
    start_gate.wait()
    t0 = time.time()
    req = {"model": "qwen3.8-27b", "max_tokens": MAX_TOKENS, "temperature": 0, "seed": 42,
           "stream": True, "stream_options": {"include_usage": True},
           "messages": [{"role": "user", "content": PROMPT}]}
    proc = subprocess.Popen(["curl", "-sN", "--max-time", "900", "http://127.0.0.1:47800/v1/chat/completions",
                             "-H", "content-type: application/json", "-d", json.dumps(req)],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
    ttft = None
    content = []
    usage = None
    try:
        for line in proc.stdout:
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                d = json.loads(payload)
            except Exception:
                continue
            if d.get("usage"):
                usage = d["usage"]
            for ch in d.get("choices") or []:
                delta = (ch.get("delta") or {})
                piece = delta.get("content") or ""
                if piece:
                    if ttft is None:
                        ttft = time.time() - t0
                    content.append(piece)
            if usage and usage.get("completion_tokens") is not None and proc.poll() is not None:
                break
    finally:
        proc.wait(timeout=30)
    total = time.time() - t0
    text = "".join(content)
    rec = {"i": idx, "ttft_ms": round(ttft * 1000) if ttft else None, "total_ms": round(total * 1000),
           "completion_tokens": (usage or {}).get("completion_tokens"), "sha": hashlib.sha256(text.encode()).hexdigest()[:12]}
    if usage and usage.get("completion_tokens") and total > 0:
        rec["stream_tps"] = round(usage["completion_tokens"] / total, 2)
    results[idx] = rec


def run_parallel(parallel, ctx):
    spec = {"name": f"ctxconc-p{parallel}-{ctx}", "profile": PROFILE, "kind": "split", "coordinatorNodeId": COORD,
            "workerNodeIds": [WORKER], "workerLayers": [12], "ctx": ctx, "parallel": parallel,
            "chain": 0, "stopExternal": False}
    preview = api("/api/deployments/plan-preview", "POST", spec)
    if "error" in preview:
        return {"parallel": parallel, "ctx": ctx, "outcome": "plan_refused", "error": str(preview["error"])[:200]}
    dep = api("/api/deployments", "POST", spec).get("id")
    if not dep:
        return {"parallel": parallel, "ctx": ctx, "outcome": "create_failed"}
    api(f"/api/deployments/{dep}/stop", "POST") if False else None

    t0 = time.time()
    api(f"/api/deployments/{dep}/start", "POST", timeout=120)
    state = "loading"
    while time.time() - t0 < READY_TIMEOUT and state == "loading":
        time.sleep(15)
        for d in api("/api/deployments").get("deployments", []):
            if d["id"] == dep:
                state = d.get("state")
                if state == "failed":
                    detail = str(d.get("error") or d.get("detail") or "")
    rec = {"parallel": parallel, "ctx": ctx, "deployment": dep, "outcome": state, "load_s": round(time.time() - t0, 1)}
    log(f"p{parallel} ctx{ctx}: {state} after {rec['load_s']}s")
    if state != "ready":
        return rec

    rec["coordinator"] = node_metrics(COORD)
    rec["worker"] = node_metrics(WORKER)

    # One sequential warmup so the first measured request is not paying page-faults.
    warm = {}
    gate = threading.Event(); gate.set()
    one_request(0, warm, gate)

    n = parallel
    results = {}
    gate = threading.Event()
    threads = [threading.Thread(target=one_request, args=(i, results, gate)) for i in range(1, n + 1)]
    wall0 = time.time()
    for t in threads:
        t.start()
    gate.set()
    for t in threads:
        t.join(timeout=1000)
    wall = time.time() - wall0
    reqs = [results[i] for i in sorted(results)]
    ttfts = [r["ttft_ms"] for r in reqs if r.get("ttft_ms")]
    totals = [r["total_ms"] for r in reqs if r.get("total_ms")]
    toks = sum(r.get("completion_tokens") or 0 for r in reqs)
    hashes = sorted({r.get("sha") for r in reqs if r.get("sha")})
    rec.update({
        "concurrent": n, "wall_s": round(wall, 2), "requests_ok": len(reqs),
        "ttft_ms_min": min(ttfts) if ttfts else None, "ttft_ms_max": max(ttfts) if ttfts else None,
        "ttft_ms_median": sorted(ttfts)[len(ttfts) // 2] if ttfts else None,
        "total_ms_median": sorted(totals)[len(totals) // 2] if totals else None,
        "aggregate_tps": round(toks / wall, 2) if wall > 0 and toks else None,
        "per_stream_tps": round((sorted([r.get("stream_tps") or 0 for r in reqs])[len(reqs) // 2]), 2) if reqs else None,
        "answers": len(hashes), "hash": hashes[0] if len(hashes) == 1 else "DIVERGENT",
        "warmup": warm.get(1),
        "requests": reqs,
    })
    log(f"p{parallel} ctx{ctx}: ttft {rec['ttft_ms_min']}–{rec['ttft_ms_max']} ms, aggregate {rec['aggregate_tps']} tok/s, "
        f"per-stream {rec['per_stream_tps']} tok/s, answers={rec['answers']}")
    api(f"/api/deployments/{dep}/stop", "POST")
    for _ in range(40):
        if subprocess.run(["bash", "-c", "pgrep -f 'releases/.*llama-server' >/dev/null"], capture_output=True).returncode != 0:
            break
        time.sleep(5)
    return rec


def main():
    # Release the machines: a live deployment reserves them and a second plan is refused.
    for d in api("/api/deployments").get("deployments", []):
        name = d.get("spec", {}).get("name", "")
        if (name.startswith("ctxconc") or name.startswith("qwen38-27b-mac2mac")) and d.get("state") not in ("stopped", "planned"):
            api(f"/api/deployments/{d['id']}/stop", "POST")
    time.sleep(5)
    for parallel in PARALLELS:
        for ctx in CTS:
            try:
                rec = run_parallel(parallel, ctx)
            except Exception as e:
                rec = {"parallel": parallel, "ctx": ctx, "outcome": "runner_error", "error": str(e)[:200]}
                log(f"p{parallel} ctx{ctx}: error {e}")
            open(RESULTS, "a").write(json.dumps(rec) + "\n")
    log("concurrency sweep done")


if __name__ == "__main__":
    log(f"concurrency sweep start: parallels {PARALLELS} at ctx {CTS}")
    main()
