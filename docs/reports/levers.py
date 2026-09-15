#!/usr/bin/env python3
"""Family A levers, cell by cell, measured the same way as the concurrency sweep.

Each cell changes exactly ONE thing against the baseline (12 layers, chain 0, no speculation,
batched boundary GETs on), so a difference is attributable to that lever:

  mtp3        chain 3            — speculative decoding with the MTP head (fewer boundary trips/token)
  ngram       ngram-simple       — speculative decoding with no extra model
  w6 / w20    workerLayers 6/20  — rebalance, to expose whether the worker stage is the bottleneck
  nobatchget  batchedGets false  — control: forces one round trip per boundary tensor

Records TTFT (client-measured), aggregate and per-caller rate, and the answer hash, because a
speculative path that changes the output is not a speedup.
"""
import json, subprocess, threading, time, datetime, hashlib

CONTROL = "https://app.swarmlet.ai"
TOKEN = json.load(open("/Users/lotar/.swarmlet/control/control.json"))["adminToken"]
COORD, WORKER = "30f05a2670c368d0", "26bc380240373930"
PROFILE = "qwen38-27b-q8"
CTX = 32768   # ctx is flat for decode (measured, CTX_SWEEP): keeps KV small enough that auto placement at c4 does not OOM
MAX_TOKENS = 64
RESULTS = "/tmp/levers.jsonl"
LOG = "/tmp/levers.log"
PROMPT = ("The mesh routes inference across sovereign nodes. " * 20) + "\n\nReply with exactly: OK"

# label, workerLayers, chain, speculation, batchedGets
MATRIX = [
    ("auto-chain0", None, 0, None, True),
    ("auto-mtp3", None, 3, None, True),
]
CONCURRENCY = [4]


def log(m):
    line = f"{datetime.datetime.now().strftime('%H:%M:%S')} {m}"
    print(line, flush=True)
    open(LOG, "a").write(line + "\n")


def api(path, method="GET", body=None, timeout=90):
    cmd = ["curl", "-s", "--max-time", str(timeout), "-X", method, f"{CONTROL}{path}", "-H", f"Authorization: Bearer {TOKEN}"]
    if body is not None:
        cmd += ["-H", "content-type: application/json", "-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {"_raw": out[:300]}


def one_request(idx, results, gate):
    gate.wait()
    t0 = time.time()
    body = {"model": "qwen3.8-27b", "max_tokens": MAX_TOKENS, "temperature": 0, "seed": 42, "stream": True,
            "stream_options": {"include_usage": True}, "messages": [{"role": "user", "content": PROMPT}]}
    p = subprocess.Popen(["curl", "-sN", "--max-time", "900", "http://127.0.0.1:47800/v1/chat/completions",
                          "-H", "content-type: application/json", "-d", json.dumps(body)],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
    ttft, parts, usage = None, [], None
    try:
        for line in p.stdout:
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
                piece = (ch.get("delta") or {}).get("content") or ""
                if piece:
                    if ttft is None:
                        ttft = time.time() - t0
                    parts.append(piece)
    finally:
        p.wait(timeout=30)
    total = time.time() - t0
    text = "".join(parts)
    results[idx] = {"ttft_ms": round(ttft * 1000) if ttft else None, "total_ms": round(total * 1000),
                    "tokens": (usage or {}).get("completion_tokens"),
                    "sha": hashlib.sha256(text.encode()).hexdigest()[:12]}


def run_cell(label, layers, chain, spec, batched, conc):
    spec_body = {"name": f"lever-{label}-c{conc}", "profile": PROFILE, "kind": "split", "coordinatorNodeId": COORD,
                 "workerNodeIds": [WORKER], "ctx": CTX, "parallel": conc,
                 "chain": chain, "stopExternal": False}
    if layers is not None:
        spec_body["workerLayers"] = [layers]
    if spec:
        spec_body["speculation"] = spec
    if batched is False:
        spec_body["batchedGets"] = False
    prev = api("/api/deployments/plan-preview", "POST", spec_body)
    if "error" in prev:
        return {"label": label, "conc": conc, "outcome": "plan_refused", "error": str(prev["error"])[:200]}
    dep = api("/api/deployments", "POST", spec_body).get("id")
    if not dep:
        return {"label": label, "conc": conc, "outcome": "create_failed"}
    t0 = time.time()
    api(f"/api/deployments/{dep}/start", "POST", timeout=120)
    state = "loading"
    while time.time() - t0 < 480 and state == "loading":
        time.sleep(15)
        for d in api("/api/deployments").get("deployments", []):
            if d["id"] == dep:
                state = d.get("state")
                if state == "failed":
                    det = str(d.get("error") or d.get("detail") or "")
    rec = {"label": label, "conc": conc, "layers": layers, "chain": chain, "speculation": bool(spec),
           "batchedGets": batched, "outcome": state, "load_s": round(time.time() - t0, 1), "deployment": dep}
    log(f"{label} c{conc}: {state} after {rec['load_s']}s")
    if state != "ready":
        rec["detail"] = det if state == "failed" else ""
        return rec

    # warmup, then exactly `conc` concurrent streams
    warm = {}
    g = threading.Event(); g.set()
    one_request(0, warm, g)
    results = {}
    g = threading.Event()
    ts = [threading.Thread(target=one_request, args=(i, results, g)) for i in range(1, conc + 1)]
    w0 = time.time()
    for t in ts: t.start()
    g.set()
    for t in ts: t.join(timeout=1200)
    wall = time.time() - w0
    rs = [results[i] for i in sorted(results)]
    toks = sum(r.get("tokens") or 0 for r in rs)
    ttfts = [r["ttft_ms"] for r in rs if r.get("ttft_ms")]
    shas = sorted({r.get("sha") for r in rs if r.get("sha")})
    rec.update({"wall_s": round(wall, 2), "ttft_min": min(ttfts) if ttfts else None,
                "ttft_max": max(ttfts) if ttfts else None,
                "agg_tps": round(toks / wall, 2) if wall and toks else None,
                "per_caller_tps": round((toks / wall) / conc, 2) if wall and toks else None,
                "answers": len(shas), "hash": shas[0] if len(shas) == 1 else "DIVERGENT",
                "warmup": warm.get(0)})
    log(f"{label} c{conc}: agg {rec['agg_tps']} tok/s, per-caller {rec['per_caller_tps']} tok/s, "
        f"ttft {rec['ttft_min']}-{rec['ttft_max']} ms, answers={rec['answers']}")
    api(f"/api/deployments/{dep}/stop", "POST")
    for _ in range(40):
        if subprocess.run(["bash", "-c", "pgrep -f 'releases/.*llama-server' >/dev/null"], capture_output=True).returncode != 0:
            break
        time.sleep(5)
    return rec


def main():
    for d in api("/api/deployments").get("deployments", []):
        n = d.get("spec", {}).get("name", "")
        if (n.startswith("lever-") or n.startswith("ctxconc") or n.startswith("qwen38-27b-mac2mac")) and d.get("state") not in ("stopped", "planned"):
            api(f"/api/deployments/{d['id']}/stop", "POST")
    time.sleep(5)
    for label, layers, chain, spec, batched in MATRIX:
        for conc in CONCURRENCY:
            try:
                rec = run_cell(label, layers, chain, spec, batched, conc)
            except Exception as e:
                rec = {"label": label, "conc": conc, "outcome": "runner_error", "error": str(e)[:200]}
                log(f"{label} c{conc}: error {e}")
            open(RESULTS, "a").write(json.dumps(rec) + "\n")
    log("lever matrix done")


if __name__ == "__main__":
    log(f"lever matrix start: {[m[0] for m in MATRIX]} at c{CONCURRENCY}")
    main()
