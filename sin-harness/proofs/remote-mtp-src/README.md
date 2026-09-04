# Remote-MTP sources (archived 2026-09-02)

Untracked sources rescued from `/tmp` llama.cpp worktrees (base commit `dfa0c0fee2b704fd2ac228d365d40502c3006c40`).
Build: copy `remote-mtp/` to `examples/remote-mtp/` in a dfa0c0f checkout, apply the matching
`*.tracked-changes.patch`, add `add_subdirectory(remote-mtp)` to `examples/CMakeLists.txt`, cmake with Metal or CUDA.

- `remote-mtp/`: bounded protocol header, worker server (Metal/CUDA), RTT stage client, E2E bench (partial rollback, dead end), fork bench v2 (exact fork/commit target state).
- `target-verify-bench/`: accept-all capacity verifier with file barriers.
- `mtp-worker-bench/`: direct CUDA MTP microbenchmark.

Results and interpretation: `docs/HANDOFF_LEGION_PARALLEL_EXECUTION_20260902_ADDENDUM.md`.
