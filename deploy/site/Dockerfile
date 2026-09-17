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

# The installer bundle. This used to be copied into the running container by hand, which meant recreating the
# container silently reverted it - and on 2026-09-17 it had gone six days stale, so "re-run the installer to
# upgrade" installed an OLDER agent than the node was already running. It is produced from one signed release
# and verified against the published feed by sin-harness/scripts/build-agent-bundle.sh, which writes it to
# site/agent/ (gitignored: 40 MB of binaries do not belong in git). This COPY is intentionally explicit: if the
# bundle has not been built, the image build fails here rather than shipping an image without it.
COPY site/agent/latest.tar.gz site/agent/latest.tar.gz.sha256 /usr/share/nginx/html/agent/

# NOTE: install.sh is also reachable at https://app.swarmlet.ai/install.sh, not just
# swarmlet.ai. That is served by THIS container through a Traefik file-provider router
# (traefik/dynamic/swarmlet-agent-install.yml on the host), because app.swarmlet.ai itself is
# the swarmlet-control Bun API, which serves no static files.

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/health || exit 1
