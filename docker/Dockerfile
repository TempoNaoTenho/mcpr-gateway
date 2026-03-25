# Build from repository root (context must include package.json at root), e.g.:
#   docker build -f docker/Dockerfile .
#
# ── Stage 1: build UI ─────────────────────────────────────────────────────────
FROM node:20-alpine AS ui-builder

WORKDIR /app/ui

COPY ui/package*.json ./
RUN npm ci

COPY ui/ .
# UI imports shared parser via $gatewayLib → ../src/lib (see ui/svelte.config.js)
COPY src/lib/ /app/src/lib/
RUN npm run build

# ── Stage 2: build backend ────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:gateway

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=ui-builder /app/ui/build ./ui/dist

EXPOSE 3000

ENV CONFIG_PATH=/config

VOLUME ["/config"]

CMD ["node", "dist/index.js"]
