#!/usr/bin/env python3
"""Context sweep on the 2-Mac split: 4K .. 256K.

One variable moves (the configured ctx); everything else is fixed, so a difference between rows is
attributable to the context window and nothing else:

  * same model, same split shape (12 layers on the friend's Mac, rest + coordinator on mine)
  * same prompt text, same seed, temperature 0
  * two probes per ctx:
      SHALLOW — ~1K-token prompt, 128-token answer. Run at EVERY ctx with identical bytes, so the
                answer's hash is a cross-ctx invariant: if the context window perturbs the result,
                the hashes diverge.
      DEEP    — prompt sized ctx/8, capped at 8192 tokens, 128-token answer. Measures prompt
                throughput with a populated KV and the ring traffic it implies. The cap is a
                deliberate runtime bound, recorded as a limitation.

Per ctx it records: load time, both nodes' free RAM, control RTT, relay bytes moved (load and
generation), prompt/decode rates, wall time, answer hash, and any failure verbatim.
"""
import json, os, re, subprocess, sys, time, datetime, hashlib

CONTROL = "https://app.swarmlet.ai"
TOKEN = json.load(open("/Users/lotar/.swarmlet/control/control.json"))["adminToken"]
COORD, WORKER = "30f05a2670c368d0", "26bc380240373930"
PROFILE = "qwen38-27b-q8"
REF_SHA = "616f824037ab81fe26f2222093efc509"
CTS = [4096, 8192, 16384, 32768, 65536, 131072, 262144]
RESULTS = "/tmp/ctxsweep.jsonl"
LOG = "/tmp/ctxsweep.log"
READY_TIMEOUT = 8 * 60
GEN_TIMEOUT = 900


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


def nodes():
    return {n["id"]: n for n in api("/api/nodes").get("nodes", [])}


def fleet():
    return {n["id"]: n for n in api("/api/fleet").get("nodes", [])}


def rpc_socket_bytes():
    """Bytes on the engine<->agent relay socket: everything the ring moved for this node."""
    pid = subprocess.run(["bash", "-c", "pgrep -f 'releases/.*llama-server' | head -1"], capture_output=True, text=True).stdout.strip()
    if not pid:
        return None
    out = subprocess.run(["bash", "-c", f"lsof -nP -p {pid} 2>/dev/null | grep ESTABLISHED | awk '{{print $9}}' | head -1"], capture_output=True, text=True).stdout.strip()
    if not out:
        return None
    m = re.match(r"127\.0\.0\.1:(\d+)", out)
    if not m:
        return None
    port = m.group(1)
    rows = subprocess.run(["bash", "-c", f"netstat -anv -p tcp 2>/dev/null | grep ':{port} ' | head -1"], capture_output=True, text=True).stdout
    nums = rows.split()
    # columns: ... ESTABLISHED <rxbytes> ... <txbytes> ...
    try:
        i = nums.index("ESTABLISHED")
        return int(nums[i + 1]) + int(nums[i + 3])
    except Exception:
        return None


def prompt_tokens(n):
    """Deterministic filler of roughly n tokens (measured exactly from the response)."""
    sentence = "The mesh routes inference across sovereign nodes, and every boundary crossing moves state. "
    return sentence * max(1, int(n / 18))


def run_probe(ctx, label, prompt_text, max_tokens=128, seed=42):
    body = {"model": "qwen3.8-27b", "max_tokens": max_tokens, "temperature": 0, "seed": seed,
            "messages": [{"role": "user", "content": prompt_text + "\n\nReply with exactly: OK"}]}
    before = rpc_socket_bytes()
    t0 = time.time()
    out = subprocess.run(["curl", "-s", "--max-time", str(GEN_TIMEOUT), "http://127.0.0.1:47800/v1/chat/completions",
                          "-H", "content-type: application/json", "-d", json.dumps(body)],
                         capture_output=True, text=True).stdout
    wall = round(time.time() - t0, 2)
    after = rpc_socket_bytes()
    rec = {"probe": label, "wall_s": wall}
    if before is not None and after is not None:
        rec["relay_bytes"] = max(0, after - before)
    try:
        d = json.loads(out)
        if "error" in d:
            rec["error"] = json.dumps(d["error"])[:200]
            return rec
        c = d["choices"][0]["message"].get("content") or ""
        t = d.get("timings", {})
        rec.update({
            "prompt_n": t.get("prompt_n"), "prompt_tps": round(t.get("prompt_per_second", 0), 2),
            "decode_n": t.get("predicted_n"), "decode_tps": round(t.get("predicted_per_second", 0), 2),
            "sha256": hashlib.sha256(c.encode()).hexdigest()[:32],
            "content": c[:60],
            "timed_out": wall >= GEN_TIMEOUT - 2,
        })
    except Exception as e:
        rec["error"] = f"unparseable ({e}): {out[:120]}"
    return rec


def stop_all(prefixes=("ctxsweep",)):
    for d in api("/api/deployments").get("deployments", []):
        name = d.get("spec", {}).get("name", "")
        if name.startswith(prefixes) and d.get("state") not in ("stopped", "planned"):
            api(f"/api/deployments/{d['id']}/stop", "POST")
    for _ in range(40):
        if subprocess.run(["bash", "-c", "pgrep -f 'releases/.*llama-server' >/dev/null"], capture_output=True).returncode != 0:
            break
        time.sleep(5)


def main():
    # Release the machines first: any live deployment on these nodes reserves them entirely, and a
    # plan against reserved nodes is refused. This is deliberate (sole residency), not a bug.
    log("releasing nodes: stopping any running qwen38 split so the sweep can plan")
    stop_all(("ctxsweep", "qwen38-27b-mac2mac"))
    time.sleep(5)

    for ctx in CTS:
        rec = {"ctx": ctx, "at": datetime.datetime.now().isoformat(timespec="seconds")}
        try:
            spec = {"name": f"ctxsweep-{ctx}", "profile": PROFILE, "kind": "split", "coordinatorNodeId": COORD,
                    "workerNodeIds": [WORKER], "workerLayers": [12], "ctx": ctx, "parallel": 1,
                    "chain": 0, "stopExternal": False}
            preview = api("/api/deployments/plan-preview", "POST", spec)
            if "error" in preview:
                rec["outcome"] = "plan_refused"; rec["error"] = str(preview["error"])[:250]
                log(f"ctx {ctx}: plan refused — {rec['error'][:110]}")
                open(RESULTS, "a").write(json.dumps(rec) + "\n"); continue

            created = api("/api/deployments", "POST", spec)
            dep = created.get("id")
            if not dep:
                rec["outcome"] = "create_failed"; rec["error"] = str(created)[:200]
                open(RESULTS, "a").write(json.dumps(rec) + "\n"); continue
            rec["deployment"] = dep

            stop_all()                       # sole residency: never two engines at once
            bytes_before_load = rpc_socket_bytes()
            t0 = time.time()
            api(f"/api/deployments/{dep}/start", "POST", timeout=120)
            state = "loading"
            while time.time() - t0 < READY_TIMEOUT:
                time.sleep(15)
                for d in api("/api/deployments").get("deployments", []):
                    if d["id"] == dep:
                        state = d.get("state")
                        if state == "failed":
                            rec["detail"] = str(d.get("error") or d.get("detail") or "")[:250]
                if state in ("ready", "failed", "stopped"):
                    break
            rec["outcome"] = state
            rec["load_s"] = round(time.time() - t0, 1)
            log(f"ctx {ctx}: {state} after {rec['load_s']}s")

            ns, fs = nodes(), fleet()
            for key, nid in (("coordinator", COORD), ("worker", WORKER)):
                m = (ns.get(nid, {}).get("metrics") or {})
                rt = m.get("runtime") or {}
                rec[f"{key}_freeRamMiB"] = m.get("freeRamMiB")
                rec[f"{key}_cpuPct"] = m.get("cpuPct")
                rec[f"{key}_rttMs"] = (fs.get(nid, {}).get("net") or {}).get("rttMs")
                rec[f"{key}_roles"] = {k: rt.get(k) for k in ("coordinators", "workers")}
            if bytes_before_load is not None:
                now = rpc_socket_bytes()
                if now is not None:
                    rec["load_relay_bytes"] = max(0, now - bytes_before_load)

            if state == "ready":
                rec["shallow"] = run_probe(ctx, "shallow", "Name the first eight prime numbers separated by spaces.")
                deep_n = min(8192, max(512, ctx // 8))
                log(f"ctx {ctx}: shallow {json.dumps(rec['shallow'])[:130]}")
                rec["deep"] = run_probe(ctx, "deep", prompt_tokens(deep_n))
                log(f"ctx {ctx}: deep({deep_n}w) {json.dumps(rec['deep'])[:130]}")
        except Exception as e:
            rec["outcome"] = "runner_error"; rec["error"] = str(e)[:250]
            log(f"ctx {ctx}: runner error {e}")
        open(RESULTS, "a").write(json.dumps(rec) + "\n")
        stop_all()
    log("ctx sweep done")


if __name__ == "__main__":
    log(f"ctx sweep start: {CTS}")
    main()
