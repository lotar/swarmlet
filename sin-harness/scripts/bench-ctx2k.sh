#!/bin/bash
# Reproducible apples-to-apples benchmark for every SIN topology.
# ctx=2048; deterministic prompt=1681 tokens on OLMoE tokenizer;
# max output=341 (= floor(2048/6)); EOS ignored so every run emits 341 tokens.
set -euo pipefail
LABEL="${1:-BENCH}"
BASE_URL="${2:-http://127.0.0.1:8081}"
RUNS="${RUNS:-3}"
python3 - "$LABEL" "$BASE_URL" "$RUNS" <<'PY'
import json, sys, urllib.request
label, base, runs = sys.argv[1], sys.argv[2].rstrip('/'), int(sys.argv[3])
para = ("The warehouse inventory system processes inbound shipments every morning "
        "before the retail floors open at nine. Each pallet is scanned twice by the "
        "receiving team, and discrepancies above two percent trigger an audit queue entry. ")
prompt = para * 42
for i in range(1, runs + 1):
    body = json.dumps({"prompt": prompt, "n_predict": 341, "temperature": 0,
                       "cache_prompt": False, "ignore_eos": True}).encode()
    req = urllib.request.Request(base + "/completion", data=body,
                                 headers={"content-type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=1800))["timings"]
    print(f"{label} run={i}  prefill={d['prompt_per_second']:7.1f} tok/s "
          f"({d['prompt_n']} tok)  decode={d['predicted_per_second']:7.2f} tok/s "
          f"({d['predicted_n']} tok)")
PY
