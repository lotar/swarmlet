# Security policy

## Supported version

Security fixes target the latest tagged alpha. Research snapshots and external llama.cpp patch targets may require upgrading to the latest commit before a fix applies.

## Reporting a vulnerability

Email `hello@swarmlet.ai` with subject `SECURITY` and include:

- affected commit/tag;
- affected file, route, or protocol;
- reproduction steps;
- expected impact;
- whether credentials, private data, or model artifacts were exposed.

Do not include live secrets in the first message. Allow reasonable time for acknowledgement and remediation before disclosure.

## Security boundaries

- Tiny/Qwen proof workers are not internet-facing services.
- Bind workers to loopback and use SSH forwarding or another authenticated encrypted transport.
- Admin routes are test-only and require a per-run token.
- The public key embedded beside a signature is not a trust root; pin its fingerprint separately.
- Models, private keys, event stores, knowledge stores, logs, PID files, and host inventories are ignored runtime artifacts.
- Docker, llama.cpp, model files, OpenSSL, NumPy, Bun, Node, and operating systems have their own security update policies.

## Out of scope

The alpha does not promise production multi-tenancy, sandboxing, denial-of-service resistance, confidential computing, remote attestation, or secure internet federation. Reports showing a documented research limitation without a new security consequence may be closed as out of scope.
