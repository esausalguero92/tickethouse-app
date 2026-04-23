# ======================================================================
# Party House — Imagen del servidor (Node.js sirviendo landing + API)
# ======================================================================
FROM node:20-alpine AS base

WORKDIR /app

# 1) Instalar dependencias del servidor
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev

# 2) Copiar código
COPY server ./server
COPY landing ./landing

# 3) Config
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

WORKDIR /app/server
CMD ["node", "server.js"]
