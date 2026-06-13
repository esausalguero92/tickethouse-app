FROM node:20-alpine

# Runtime deps para canvas/pdfkit y fuentes
RUN apk add --no-cache \
      cairo pango jpeg giflib \
      fontconfig ttf-dejavu \
      python3 make g++ \
      cairo-dev pango-dev jpeg-dev giflib-dev

WORKDIR /app

COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm ci --omit=dev

COPY server ./server
COPY landing ./landing

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

WORKDIR /app/server
CMD ["node", "server.js"]
