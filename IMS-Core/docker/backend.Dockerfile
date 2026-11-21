# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# IMS-Core backend image (NestJS). Build context: repository root.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
ENV CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci -w backend --no-audit --no-fund

FROM deps AS build
COPY backend backend
RUN npm run prisma:generate -w backend \
 && npm run build -w backend \
 && npm prune --omit=dev -w backend --no-audit --no-fund \
 && mkdir -p backend/node_modules

FROM node:22-alpine AS runtime
RUN apk add --no-cache tini openssl
ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    XDG_CACHE_HOME=/tmp/.cache \
    HOME=/tmp
WORKDIR /app
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/backend/node_modules ./backend/node_modules
COPY --from=build --chown=root:root /app/backend/dist ./backend/dist
COPY --from=build --chown=root:root /app/backend/prisma ./backend/prisma
COPY --from=build --chown=root:root /app/backend/package.json ./backend/package.json
COPY VERSION ./VERSION
COPY scripts/install-agent.sh ./assets/install-agent.sh
COPY docker/backend-entrypoint.sh /usr/local/bin/ims-entrypoint
RUN chmod 0555 /usr/local/bin/ims-entrypoint && mkdir -p /app/data && chown node:node /app/data

# Application code is owned by root and read-only for the runtime user.
USER node
WORKDIR /app/backend
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/ims-entrypoint"]
CMD ["serve"]
