# syntax=docker/dockerfile:1
#
# swarmlet-rig-node: emulated 16GB inference node running ggml-rpc-server
# (CPU backend only — no GPU in containers). Built --platform linux/arm64
# to match Docker Desktop's native VM architecture on Apple silicon.
#
# Multi-stage: builder compiles ggml-rpc-server from a local llama.cpp
# checkout (copied in as llama-src/ by rig.sh), runtime stage is a slim
# Ubuntu image with just the binary + iproute2 (for netem) + iputils-ping
# (for the ping smoke test).

# ---------- builder ----------
FROM --platform=linux/arm64 ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY llama-src/ /src/

# Static-ish build: BUILD_SHARED_LIBS=OFF avoids having to hunt down and
# copy every libggml-*.so into the runtime stage. GGML_RPC=ON is the only
# backend we need (CPU device is always compiled in). Metal is explicitly
# off since the runtime is Linux/containers with no GPU passthrough.
RUN cmake -S . -B build \
        -DGGML_RPC=ON \
        -DGGML_METAL=OFF \
        -DBUILD_SHARED_LIBS=OFF \
        -DLLAMA_BUILD_TOOLS=ON \
        -DLLAMA_BUILD_EXAMPLES=OFF \
        -DLLAMA_BUILD_TESTS=OFF \
        -DLLAMA_CURL=OFF \
        -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --target ggml-rpc-server -j"$(nproc)"

# Sanity: confirm the binary exists and record its dynamic dependencies
# for debugging (build log only, not copied forward).
RUN ldd build/bin/ggml-rpc-server || true

# ---------- runtime ----------
FROM --platform=linux/arm64 ubuntu:24.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        iproute2 \
        iputils-ping \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /src/build/bin/ggml-rpc-server /usr/local/bin/ggml-rpc-server

# LLAMA_CACHE steers rpc-server's own cache-dir resolution (fs_get_cache_directory())
# when it's started with -c/--cache; there is no direct --cache-dir flag.
ENV LLAMA_CACHE=/cache
VOLUME ["/cache"]

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 50052

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
