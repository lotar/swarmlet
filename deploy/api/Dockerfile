FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

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
