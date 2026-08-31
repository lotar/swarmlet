# Release reference

## Supported alpha surface

`v1.0.0-alpha.1` supports the deterministic Bun harness, portable no-model proof formats, static site, and the two-Ubuntu tiny-MoE protocol. Real-model, Docker, Qwen, DFlash, and hardware workflows are opt-in research tiers with explicit prerequisites.

Models, signing private keys, event/knowledge databases, process logs, host inventories, and generated hardware reports are not part of the source archive.

## Required gate

From a clean tree:

```bash
sin-harness/scripts/release-check.sh
```

The gate runs:

- frozen Bun installation;
- strict TypeScript checking;
- deterministic unit/process tests;
- portable low-RAM Python proofs;
- shell and Python syntax checks;
- results-grid regeneration check;
- static-site HTTP smoke test;
- developer-path and basic credential scans.

It intentionally starts no model and no Docker workload. Model/Docker/hardware results must be reported separately rather than silently skipped.

## Historical evidence policy

`sin-harness/gates/` and `sin-harness/proofs/*/results/` contain immutable historical evidence. Some old signed artifacts include the measurement host's local filesystem paths. Rewriting them would invalidate their signatures, so the alpha retains them as disclosed snapshots. New manifests sanitize artifact display paths and preserve full content hashes.

Measured, simulated, and projected rows remain distinct in `docs/RESULTS_GRID.md`.

## Source package

After the release gate passes and the tree is clean:

```bash
sin-harness/scripts/package-release.sh
```

Outputs:

```text
dist/swarmlet-1.0.0-alpha.1.tar.gz
dist/swarmlet-1.0.0-alpha.1.sbom.json
dist/swarmlet-1.0.0-alpha.1.sha256
```

The SBOM identifies runtime, development, and optional Python proof dependencies. It explicitly records that no model is included.

## Tag and publication

Publication is a separate operator-authorized action:

```bash
git tag -s v1.0.0-alpha.1 -m 'Swarmlet v1.0.0-alpha.1'
git push origin main v1.0.0-alpha.1
```

Before pushing, verify the custom source-available license with qualified counsel and ensure the public repository description does not call it Open Source.

## Release claims

Allowed:

- deterministic local/process proof results actually run by the gate;
- signed physical or model evidence when its explicit tier passes;
- historical measurements with their exact scope and source.

Not allowed:

- presenting simulations as hardware measurements;
- claiming physical nodes before signed physical evidence exists;
- claiming full-model Qwen/Kimi inference from a layer-0 expert proof;
- claiming CUDA execution from a NumPy bundle worker;
- calling the revenue-restricted license Open Source or OSI-approved.
