# DFlash2 eight-stage pipeline simulator

Memory-free feasibility model for one Qwen3.8 Flash Next model distributed over
8 × 16-GB cards. It separates per-stream block latency from saturated aggregate
pipeline capacity.

```bash
bun run test:dflash-pipeline
```

The viable interpretation of “all eight at 50 tok/s” is:

- one shared 8-stage model, not eight replicas;
- eight concurrent streams filling all stages;
- each stream ≥50 accepted tok/s;
- cluster aggregate ≥400 accepted tok/s.

Required assumptions for the passing configuration:

- Flash-Next-specific DFlash2, mean acceptance 4.8;
- one draft block in 10 ms;
- 8 contiguous stages, approximately 6 layers/card;
- stage compute ≤10.53 ms at block width 8;
- adjacent one-way latency ≤0.25 ms;
- PLE table remains in system RAM; target GPU weights ~9.60 GiB/stage;
- rollback+KV ~1.06 GiB/stage.

The simulator rejects pan-European stages and 10× EU latency. It does not
predict GPU stage compute; the 9–12 ms stage microbenchmark is the decisive
hardware gate.

## Strict target/draft A/B/A concurrency screen

`strict_ab_harness.py` is the reusable correctness-first benchmark client.
The physical workflow is split because the 104-GB target-only and draft-enabled
servers cannot coexist. Start only the required server, acquire one arm using
one URL, stop it, and repeat. Use identical acquisition options for all arms:

```bash
# Target-only server running; stop it after this command.
python3 sin-harness/proofs/dflash-pipeline/strict_ab_harness.py acquire \
  --arm A1 --url http://127.0.0.1:8095 --out /tmp/flashnext-a1 \
  --concurrency 8 --tokens 128 --warmup-waves 1 --measured-waves 3

# Draft-enabled server running; stop it after this command.
python3 sin-harness/proofs/dflash-pipeline/strict_ab_harness.py acquire \
  --arm B --url http://127.0.0.1:8095 --out /tmp/flashnext-b \
  --concurrency 8 --tokens 128 --warmup-waves 1 --measured-waves 3

# Target-only server running again; stop it after this command.
python3 sin-harness/proofs/dflash-pipeline/strict_ab_harness.py acquire \
  --arm A2 --url http://127.0.0.1:8095 --out /tmp/flashnext-a2 \
  --concurrency 8 --tokens 128 --warmup-waves 1 --measured-waves 3

# No server is used by compare.
python3 sin-harness/proofs/dflash-pipeline/strict_ab_harness.py compare \
  --a1-artifact /tmp/flashnext-a1/arm.json \
  --b-artifact /tmp/flashnext-b/arm.json \
  --a2-artifact /tmp/flashnext-a2/arm.json \
  --out /tmp/flashnext-aba-c8 \
  --min-b-ratio 1.05 --max-a-drift-pct 5 \
  --screen-label short-screen
```

Each `acquire` invocation creates one integrity-hashed, immutable `arm.json`
and its `responses/` records. `compare` is offline: it verifies each artifact's
payload and requires equal configuration fingerprints before applying strict
parity, B-ratio, and A-drift checks. Output directories must be absent or empty;
the harness rejects nonempty directories rather than mixing stale evidence.
The old `--a-url`/`--b-url` all-in-one invocation remains only for local test
backward compatibility and must not be used for the physical 104-GB run.

Use `--screen-label final` only for the predeclared final comparison; the label
does not weaken or strengthen checks. The built-in eight-prompt corpus is fixed
regardless of concurrency. A JSON array of prompt strings can be supplied with
`--corpus` during every acquisition; every wave still processes the entire
corpus, partitioned into batches no larger than `--concurrency`. All workers in
a batch wait on a barrier before opening their HTTP requests. Requests use
greedy decoding, fixed per-prompt seeds, `cache_prompt=false`, and exactly
`--tokens` forced output tokens.

The client makes one HTTP attempt per request and never retries. It saves every
attempt, including the base64-encoded exact raw response body for malformed or
HTTP-error responses. The offline comparison writes the authoritative
`summary.json` and exits nonzero unless all of these hold:

- every response reports `timings.predicted_n == --tokens` and captures exactly
  that many integer IDs in `completion_probabilities`;
- token IDs and content match exactly for every corresponding A1/B/A2 response,
  including warmups;
- B client-wall aggregate goodput divided by the arithmetic mean of A1 and A2
  meets `--min-b-ratio`;
- absolute A2-versus-A1 aggregate-goodput drift is at most
  `--max-a-drift-pct`.

Artifact configuration fingerprints cover the corpus, concurrency, token and
wave counts, timeout, completion path, and no-retry policy. Comparison policy
(the ratio/drift thresholds and screen label) is declared only at `compare`.
Aggregate goodput uses validated tokens divided by measured phase client wall
(not server-reported decode timing). The summary also contains per-stream
client-wall latency/goodput, wave and barrier-skew metrics, signed A drift,
B/A1 and B/A2 ratios, and canonical SHA-256 hashes for request JSON, prompt
bytes, token-ID JSON, and content bytes. `RESULT_JSON=...` on stdout is a small
machine-readable run result; `summary.json` is authoritative.

Run the local deterministic fake-server tests from `sin-harness/` with:

```bash
bun run test:strict-ab-harness
```
