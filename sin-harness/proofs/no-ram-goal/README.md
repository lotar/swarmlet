# No-RAM implementation suite

```bash
bun run test:no-ram-goal
```

Pure Python/metadata tooling only. It memory-maps GGUF files read-only for
tensor metadata but does not materialize or execute weights, start Docker
containers, or restart production. The E2E verifies:

- integer-exact hybrid rollback oracle;
- append-only hidden-feature cache and truncation recovery;
- DFlash2 candidate config validation;
- queueing/p99 scheduler simulation;
- actual-GGUF contiguous partition planning;
- Ed25519 run-manifest signing/tamper rejection;
- result-grid generation;
- Flash Next LaunchAgent runbook `check-only`;
- unchanged production PID and bounded RSS.

Limit: the rollback fixture proves the state-machine algorithm, not llama.cpp
backend state bytes. That requires the future tiny Qwen4Exp GGUF fixture.
