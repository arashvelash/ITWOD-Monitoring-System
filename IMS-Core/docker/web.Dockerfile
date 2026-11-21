# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# IMS-Core web image: Caddy + built dashboard. Build context: repository root.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci -w frontend --no-audit --no-fund
COPY frontend frontend
RUN npm run build -w frontend

FROM caddy:2.10-alpine
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/frontend/dist /srv/www
EXPOSE 80 443 443/udp
