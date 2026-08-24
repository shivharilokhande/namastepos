# NamastePOS API - multi-stage Docker build

# --- Build stage ---------------------------------------------------------
FROM node:18-alpine AS builder
WORKDIR /app

# Install deps based on lockfile when available; falls back to npm install
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# --- Runtime stage -------------------------------------------------------
FROM node:18-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Non-root user
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/db ./db
COPY --from=builder /app/scripts ./scripts

USER app
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1

CMD ["node", "src/server.js"]
