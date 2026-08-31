# Two-node expert protocol reference

The alpha physical proof is a deterministic, plan-pinned expert protocol. It validates ownership, routing, reduction, failure behavior, and evidence handling. It is not a model-serving API.

## Trust and transport

```text
coordinator
  ├── http://127.0.0.1:19571 ── SSH ── owner n1 :9571 loopback
  └── http://127.0.0.1:19572 ── SSH ── owner n2 :9572 loopback
```

Owners always bind `127.0.0.1`. SSH authenticates hosts and encrypts transport. The placement epoch pins model ID, ownership, and exact fixture digests. The final Ed25519 signature binds results to a separately pinned evidence signer.

## Placement plan

Schema version 1 and protocol version 2:

```json
{
  "schemaVersion": 1,
  "protocolVersion": 2,
  "modelId": "tiny-moe-v1",
  "owners": [
    { "nodeId": "n1", "expertIds": [0, 3], "fixtureSha256": "<sha256>" },
    { "nodeId": "n2", "expertIds": [1, 2], "fixtureSha256": "<sha256>" }
  ],
  "placementEpoch": "<sha256>"
}
```

`placementEpoch` is SHA-256 over canonical JSON containing the schema version, protocol version, model ID, and owners sorted by node ID, excluding the epoch field. URLs and tunnel ports do not affect content identity.

Validation requires:

- at least two unique owners;
- valid node IDs;
- each expert owned exactly once;
- complete expert coverage;
- sorted unique expert IDs;
- exact fixture SHA-256;
- exact recomputed epoch.

`launchId` is not part of the content epoch. The physical campaign generates it per run and uses it to prevent an occupied port, stale PID file, or concurrent supervisor from being mistaken for the owner it launched.

## Owner command

```bash
bun proofs/tiny-moe/node.ts \
  --id n1 \
  --launch-id local-demo \
  --port 9571 \
  --fixture proofs/tiny-moe/fixtures/two-node/n1.json \
  --placement-plan proofs/tiny-moe/fixtures/two-node/plan.json \
  --admin-token-file data/two-node/admin.token
```

Options:

| Option | Constraint |
|---|---|
| `--id` | Plan node ID, 1–64 safe characters |
| `--launch-id` | Per-run nonce, 1–128 safe characters; defaults to `local` |
| `--port` | Integer 0–65535; still binds loopback only |
| `--fixture` | JSON whose node/expert/digest matches the plan |
| `--placement-plan` | Protocol-v2 plan |
| `--delay-ms` | 0–100; test instrumentation only |
| `--admin-token-file` | Optional token of at least 24 characters |

Without an admin-token file, every `/admin/*` route returns 404.

## HTTP API

### `GET /health`

Returns status plus the complete owner identity:

```json
{
  "status": "ok",
  "nodeId": "n1",
  "modelId": "tiny-moe-v1",
  "protocolVersion": 2,
  "expertIds": [0, 3],
  "fixtureDigest": "<sha256>",
  "residentBytes": 1234,
  "placementEpoch": "<sha256>",
  "launchId": "<run nonce>"
}
```

### `GET /manifest`

Returns the same identity without `status`.

### `POST /execute`

Request limits:

- body ≤128 KiB;
- 1–64 tokens;
- 1–128 assignments;
- request ID: 1–128 printable ASCII characters;
- unique `(tokenIndex, expertId)` pairs;
- activation length exactly 8;
- finite numbers only;
- resident experts only.

```json
{
  "protocolVersion": 2,
  "placementEpoch": "<sha256>",
  "requestId": "tiny-123-1",
  "tokenCount": 1,
  "items": [
    { "tokenIndex": 0, "expertId": 0, "activation": [0,0,0,0,0,0,0,0] }
  ]
}
```

The worker returns raw expert output. It never accepts or echoes routing weights; the coordinator owns weights and deterministic ordered reduction.

```json
{
  "protocolVersion": 2,
  "placementEpoch": "<sha256>",
  "nodeId": "n1",
  "requestId": "tiny-123-1",
  "pieces": [
    { "tokenIndex": 0, "expertId": 0, "output": [0,0,0,0,0,0,0,0] }
  ],
  "requestBytes": 240
}
```

### Admin routes

Require `Authorization: Bearer <token>` and exist only when configured:

| Route | Behavior |
|---|---|
| `POST /admin/crash-next` | Kills the worker during the next valid execute request |
| `GET /admin/access-log` | Returns bounded request ownership telemetry |

The proof deletes admin tokens after cleanup.

## Status codes

| Code | Meaning |
|---:|---|
| 200 | Valid request |
| 400 | Malformed or invalid dimensions/assignments |
| 401 | Missing/wrong admin token |
| 404 | Unknown or disabled route |
| 409 | Stale epoch or non-owned expert |
| 413 | Body too large |

A timeout, disconnect, malformed response, duplicate/wrong piece, missing piece, wrong identity, or non-finite output becomes `ExpertUnavailable`. The coordinator returns no partial output.

## Coordinator response validation

For every owner response the coordinator verifies:

- node, request, protocol, and epoch identity;
- exact expected `(tokenIndex, expertId)` set;
- no duplicate, missing, or extra pieces;
- output width exactly 8;
- finite output values;
- routing weights taken only from its own deterministic router.

Manifest initialization is atomic: a failed new plan never replaces a previously valid complete placement.

## Evidence

`physical.ts` writes result JSON atomically. `sign_artifact.py` wraps it with:

- Git commit and dirty status;
- command/configuration;
- artifact SHA-256 and size;
- host evidence;
- proof assertions and timings;
- signer fingerprint, public key, and Ed25519 signature.

Verification requires an operator-pinned signer fingerprint. Replacing the embedded public key is rejected.

## Scope

Passing this protocol proves deterministic distributed expert semantics between physical hosts. It does not prove GPU kernels, quantization, arbitrary model routing, full-model logits, model quality, or production availability.
