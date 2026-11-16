# syntax=docker/dockerfile:1

# ---------- Etapa de compilación ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# better-sqlite3 puede necesitar compilar si no hay binario precompilado.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

# ---------- Etapa de ejecución ----------
FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY scripts ./scripts
COPY formato_respuestas.md ./

RUN mkdir -p /app/data /app/backups \
    && chown -R node:node /app

USER node

EXPOSE 4000

# Railway no admite puntos de montaje declarados en el Dockerfile: configurá el
# almacenamiento desde el dashboard. La plataforma no necesita disco local
# (Neon + WAHA), así que solo creamos los directorios para el modo legado.
# HEALTHCHECK usa $PORT en lugar de 4000 fijo: Railway asigna el puerto dinámicamente.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
