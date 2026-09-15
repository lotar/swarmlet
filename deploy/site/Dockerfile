FROM nginx:alpine@sha256:4870c12cd2ca986de501a804b4f506ad3875a0b1874940ba0a2c7f763f1855b2

ARG SWARMLET_REVISION=unknown

LABEL org.opencontainers.image.title="SwarmletAI website" \
      org.opencontainers.image.revision="${SWARMLET_REVISION}"

COPY deploy/site/nginx.conf /etc/nginx/conf.d/default.conf
COPY site/index.html \
     site/app.js \
     site/install.sh \
     site/favicon.svg \
     site/og.png \
     site/robots.txt \
     site/sitemap.xml \
     /usr/share/nginx/html/

# NOTE: install.sh is also reachable at https://app.swarmlet.ai/install.sh, not just
# swarmlet.ai. That is served by THIS container through a Traefik file-provider router
# (traefik/dynamic/swarmlet-agent-install.yml on the host), because app.swarmlet.ai itself is
# the swarmlet-control Bun API, which serves no static files. The agent bundle it downloads
# (agent/swarmlet-agent-<os>-<arch>.tar.gz + .sha256) is a build artifact and is NOT in this
# image - it is copied into the running container, so recreating this container from a rebuilt
# image drops the bundle until it is re-published.

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/health || exit 1
