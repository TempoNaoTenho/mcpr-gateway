# Build from repository root (context must include package.json at root), e.g.:
#   docker build -f docker/Dockerfile .
#
# ── Stage 1: build UI ─────────────────────────────────────────────────────────
FROM node:24-alpine AS ui-builder

WORKDIR /app/ui

COPY ui/package*.json ./
RUN npm ci

COPY ui/ .
# UI imports shared parser via $gatewayLib → ../src/lib (see ui/svelte.config.js)
COPY src/lib/ /app/src/lib/
RUN npm run build

# ── Stage 2: build backend ────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:gateway

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=ui-builder /app/ui/build ./ui/dist

EXPOSE 3000

ENV CONFIG_PATH=/config

VOLUME ["/config"]

RUN chown -R node:node /app
USER node

CMD ["node", "--no-node-snapshot", "dist/index.js"]
