# ======================================================================
# Party House v2.0 — Node.js + Express (API + landing estática)
# Multi-stage: deps separados del código para capas de caché óptimas.
# ======================================================================

# ── Stage 1: deps ──────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app/server

# Sólo package files primero (máximo cache hit)
COPY server/package.json server/package-lock.json* ./

# Canvas / pdfkit necesitan build tools (cairo, pango)
RUN apk add --no-cache \
      python3 make g++ \
      cairo-dev pango-dev jpeg-dev giflib-dev \
  && npm ci --omit=dev \
  && apk del python3 make g++

# ── Stage 2: runner ────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Runtime deps para canvas/pdfkit y fuentes
RUN apk add --no-cache \
      cairo pango jpeg giflib \
      fontconfig ttf-dejavu

WORKDIR /app

# node_modules compilados desde la etapa deps
COPY --from=deps /app/server/node_modules ./server/node_modules

# Código
COPY server ./server
COPY landing ./landing

# Seguridad: usuario sin privilegios
RUN addgroup -S ph && adduser -S ph -G ph \
  && chown -R ph:ph /app
USER ph

# Entorno
ENV NODE_ENV=production
ENV PORT=3000

# Health check (Easypanel / Docker lo monitorea)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

EXPOSE 3000
WORKDIR /app/server
CMD ["node", "server.js"]
