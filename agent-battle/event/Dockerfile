# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
#
# Agent Battle event server. Build & run:
#   docker build -t agent-battle-event .
#   docker run -p 8888:8888 -v event-data:/data \
#     -e WORKSHOP_KEY=... -e ADMIN_KEY=... -e MC_SEED=... \
#     -e PUBLIC_URL=https://your-host.example.com \
#     agent-battle-event

FROM node:22-slim

WORKDIR /app

# Install production deps first so code edits don't bust the layer cache.
# .npmrc pins the public npm registry: this is a public OSS repo built by
# external participants and third-party CI (Fly.io/Cloud Run builders),
# none of which can reach a private mirror. Copying it in makes the
# registry choice explicit and keeps builds deterministic with the
# committed lockfile.
COPY .npmrc package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.mjs ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8888
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8888/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
