# Third-party components and artifacts

The Swarmlet Community License applies only to original repository material whose copyright holder offers it under that license.

The following are external and retain their own terms:

- Bun runtime and `@types/bun`;
- TypeScript development compiler;
- Python and NumPy;
- OpenSSL;
- Node.js and Chromium/Google Chrome used for optional site QA;
- Docker and Docker Compose;
- llama.cpp and patches applied to a separately obtained checkout;
- MLX used by optional Apple-Silicon proofs;
- model weights, tokenizers, metadata, and datasets obtained from their publishers.

No model weights are included in the source archive. Users are responsible for reviewing the license and usage policy of every model and external component they obtain.

`sin-harness/bun.lock` and `sin-harness/requirements-proofs.txt` pin repository development/proof dependencies. External llama.cpp and model revisions are recorded by individual proof manifests rather than vendored into this repository.
