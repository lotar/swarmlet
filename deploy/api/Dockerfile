FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

ARG SWARMLET_REVISION=unknown

LABEL org.opencontainers.image.title="SwarmletAI wishlist API" \
      org.opencontainers.image.revision="${SWARMLET_REVISION}"

WORKDIR /app
COPY api/wishlist.mjs /app/wishlist.mjs

RUN mkdir -p /data && chown node:node /data

USER node
ENV HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=3000 \
    WISHLIST_ALLOWED_ORIGIN=https://swarmlet.ai \
    WISHLIST_DB_PATH=/data/wishlist.sqlite

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "/app/wishlist.mjs"]
