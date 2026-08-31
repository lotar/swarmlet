# Contributing to Swarmlet

Swarmlet is an evidence-first research project. Contributions must preserve the distinction between measured, simulated, projected, and unproven claims.

## Before opening a change

1. Open an issue describing the behavior and acceptance evidence.
2. Keep model weights, private data, signing keys, credentials, and runtime databases out of Git.
3. Do not expose worker/admin HTTP ports beyond loopback.
4. Do not rewrite signed historical evidence. Add a new signed artifact instead.

## Development setup

```bash
cd sin-harness
bun install --frozen-lockfile
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --requirement requirements-proofs.txt
bun run test
```

Required versions are documented in the root README.

## Test tiers

- `bun run test`: required portable gate.
- `bun run test:integration`: requires a local model server.
- `bun run test:docker`: requires Docker, a pinned llama.cpp checkout, and a model.
- `bun run test:hardware`: requires two key-authenticated Ubuntu hosts.

A pull request must state exactly which tiers ran and which did not.

## Evidence rules

- Include source command, Git commit, configuration, and artifact hashes.
- Pin deterministic seeds where applicable.
- A failed run remains a failed run; do not weaken assertions or delete rows.
- Label simulations and projections in every table containing measured data.
- Preserve cleanup evidence for processes, listeners, tunnels, model contexts, and temporary credentials.

## Code style

- TypeScript is strict and must pass `bun run typecheck`.
- Runtime TypeScript uses Bun built-ins; new production dependencies require justification.
- Python proof dependencies belong in `requirements-proofs.txt`.
- Scripts use `set -euo pipefail`, exact PID ownership, and fail-closed cleanup.
- Prefer repository-relative paths and explicit environment variables.

## Contribution license

By intentionally submitting a contribution, you agree to Section 7 of the [Swarmlet Community License 1.0](LICENSE), including the copyright and patent rights needed to distribute and commercially relicense the contribution. Do not contribute code you lack authority to license.

## Security

Do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).
