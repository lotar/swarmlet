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
