#!/usr/bin/env python3
"""Collect one native llama-server arm inside the rig owner's maintenance guard.

Does not launch, stop, or reconfigure anything. Run collect separately against
fresh target-only and ngram servers, then compare the two immutable JSON files.
The owner must serialize inference to make per-request metric deltas meaningful.
"""
import argparse
import datetime
import hashlib
import json
import math
import os
import time
import urllib.request
from pathlib import Path

PROMPTS = [
    ("repeat", "Continue this exact repeating sequence without commentary:\n" + "red blue green yellow\n" * 24),
    ("copy", "Copy the following paragraph three times exactly, without commentary.\n" + "The small boat crossed the quiet lake before sunrise. " * 8 + "\nCopy:\n"),
    ("diverse", "Explain in three clear sentences why a shadow changes length during the day.\nAnswer:\n"),
    ("code", "Write a Python function that returns the largest number in a nonempty list, without using max.\n```python\n"),
]
METRICS = ("spec_decode_num_draft_tokens_total", "spec_decode_num_accepted_tokens_total", "spec_decode_num_drafts_total")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def fixture_request(prompt):
    return {"prompt": prompt, "temperature": 0, "seed": 0, "n_predict": 128,
            "cache_prompt": False, "return_tokens": True, "stream": False}


def valid_counters(values):
    return set(values) == set(METRICS) and all(
        isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x >= 0 and int(x) == x
        for x in values.values())


def request(url, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as response:
        return response.read().decode()


def metrics(url):
    raw = request(url + "/metrics")
    result = {}
    for line in raw.splitlines():
        if not line or line.startswith("#"):
            continue
        key, value = line.split()[:2]
        for suffix in METRICS:
            if key == "llamacpp:" + suffix:
                result[suffix] = float(value)
    if not valid_counters(result):
        raise RuntimeError("engine did not expose all valid speculative counters")
    return result


def collect(args):
    if os.environ.get("SWARMLET_IDLE_WINDOW") != "1":
        raise RuntimeError("collect requires SWARMLET_IDLE_WINDOW=1 from the rig maintenance guard")
    url = args.url.rstrip("/")
    rows = []
    output = Path(args.output)
    # Refuse overwrite before generating any inference or losing prior evidence.
    with output.open("x") as handle:
        result = {"schema": 1, "arm": args.arm, "url": url,
                  "createdUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "rows": rows}
        try:
            for name, prompt in PROMPTS:
                body = fixture_request(prompt)
                before = metrics(url)
                started = time.monotonic()
                response = json.loads(request(url + "/completion", body))
                elapsed = time.monotonic() - started
                after = metrics(url)
                if not response.get("stop") or not response.get("tokens") or not response.get("content"):
                    raise RuntimeError(f"{name}: missing completion, token IDs or generated text")
                rows.append({"name": name, "request": body,
                             "promptSha256": hashlib.sha256(prompt.encode()).hexdigest(),
                             "elapsedSeconds": elapsed, "response": response, "responseSha256": digest(response),
                             "metricsBefore": before, "metricsAfter": after,
                             "metricsDelta": {key: after[key] - before[key] for key in METRICS}})
            result["completed"] = True
        finally:
            json.dump(result, handle, indent=2)
            handle.write("\n")
    print(json.dumps({"arm": args.arm, "rows": len(rows), "output": str(output)}))


def compare(args):
    baseline = json.loads(Path(args.baseline).read_text())
    candidate = json.loads(Path(args.candidate).read_text())
    if not baseline.get("completed") or not candidate.get("completed"):
        raise RuntimeError("incomplete arm")
    if len(baseline["rows"]) != len(PROMPTS) or len(candidate["rows"]) != len(PROMPTS):
        raise RuntimeError("missing fixture rows")
    for arm in (baseline, candidate):
        if arm.get("schema") != 1 or not arm.get("arm") or not arm.get("url") or not arm.get("createdUtc"):
            raise RuntimeError("missing arm provenance")
        for row, (name, prompt) in zip(arm["rows"], PROMPTS):
            if row["name"] != name or row["request"] != fixture_request(prompt) or row["promptSha256"] != hashlib.sha256(prompt.encode()).hexdigest():
                raise RuntimeError("fixture provenance mismatch")
            response = row["response"]
            if row["responseSha256"] != digest(response):
                raise RuntimeError("response digest mismatch")
            if not response.get("stop") or not response.get("content") or not response.get("tokens") or not response.get("model"):
                raise RuntimeError("incomplete response provenance")
            for key in ("metricsBefore", "metricsAfter", "metricsDelta"):
                if not valid_counters(row[key]):
                    raise RuntimeError("invalid speculative counters")
            if any(row["metricsAfter"][key] - row["metricsBefore"][key] != row["metricsDelta"][key] for key in METRICS):
                raise RuntimeError("counter delta mismatch")
    rows = []
    for base, spec in zip(baseline["rows"], candidate["rows"]):
        if base["name"] != spec["name"] or base["request"] != spec["request"]:
            raise RuntimeError("arms used different fixture requests")
        if base["response"]["model"] != spec["response"]["model"]:
            raise RuntimeError("arms used different model identities")
        a, b = base["response"]["tokens"], spec["response"]["tokens"]
        prefix = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
        rows.append({"name": base["name"], "tokenExact": a == b,
                     "textExact": base["response"]["content"] == spec["response"]["content"],
                     "commonPrefixTokens": prefix, "baselineTokens": len(a), "candidateTokens": len(b),
                     "metricsDelta": spec["metricsDelta"]})
    totals = {key: sum(row["metricsDelta"][key] for row in rows) for key in METRICS}
    drafted, accepted = (totals[key] for key in METRICS[:2])
    gates = {"tokenAndTextParity": all(row["tokenExact"] and row["textExact"] for row in rows),
             "draftedAndAccepted": drafted > 0 and accepted > 0,
             "rejectionsObserved": drafted > accepted,
             "baselineNoDrafts": all(all(value == 0 for value in row["metricsDelta"].values()) for row in baseline["rows"]),
             "counterConsistency": all(0 <= row["metricsDelta"][METRICS[1]] <= row["metricsDelta"][METRICS[0]] and (row["metricsDelta"][METRICS[0]] == 0 or row["metricsDelta"][METRICS[2]] > 0) for row in rows)}
    print(json.dumps({"gates": gates, "totals": totals, "rows": rows}, indent=2))
    return 0 if all(gates.values()) else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    arm = sub.add_parser("collect")
    arm.add_argument("--url", required=True)
    arm.add_argument("--arm", required=True)
    arm.add_argument("--output", required=True)
    check = sub.add_parser("compare")
    check.add_argument("--baseline", required=True)
    check.add_argument("--candidate", required=True)
    args = parser.parse_args()
    return collect(args) if args.command == "collect" else compare(args)


if __name__ == "__main__":
    raise SystemExit(main())
