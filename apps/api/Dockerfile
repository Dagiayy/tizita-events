# Ethiopia Event Photo Sharing Platform - API / worker image
# Multi-stage, non-root, fonts for Ethiopic text in watermarks/PDFs, libvips via sharp prebuilt binaries.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm config set fetch-retries 5 && npm config set fetch-retry-mintimeout 20000 && npm config set fetch-timeout 300000 && npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-core fontconfig tini curl \
  && rm -rf /var/lib/apt/lists/* && fc-cache -f
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./
RUN chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD curl -fsS http://127.0.0.1:4000/health/live || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
# Run migrations as a deployment step:  docker compose run --rm api node dist/scripts/migrate.js up
CMD ["node", "dist/src/main.js"]
