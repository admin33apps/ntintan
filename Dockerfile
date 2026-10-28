# syntax=docker/dockerfile:1
# Node 24 LTS (the version the test suite runs on). Rebuild regularly to pick up security patches.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/ntintan.db \
    BACKUP_DIR=/data/backups
WORKDIR /app
# No npm dependencies — copy source only
COPY package.json server.js ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown -R app:app /data
USER app
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
