FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
ARG SWARMLET_REVISION
LABEL org.opencontainers.image.title="Swarmlet control plane" \
      org.opencontainers.image.revision="${SWARMLET_REVISION}"
WORKDIR /app
COPY swarmlet/control ./swarmlet/control
COPY swarmlet/protocol ./swarmlet/protocol
COPY swarmlet/shared ./swarmlet/shared
COPY swarmlet/node-agent/streams.ts ./swarmlet/node-agent/streams.ts
COPY sin-harness/core/sign.ts ./sin-harness/core/sign.ts
USER bun
EXPOSE 47900
CMD ["bun", "run", "swarmlet/control/main.ts"]
