# Next.js standalone image (guest PWA + host console + admin). No third-party calls at runtime; fonts are bundled.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm config set fetch-retries 5 && npm config set fetch-retry-mintimeout 20000 && npm config set fetch-timeout 300000 && npm ci --no-audit --no-fund
COPY . .
ARG API_INTERNAL_URL=http://api:4000
# same-origin behind nginx: CSP allows 'self' only (set to e.g. https://api.example.et if the API is on another origin)
ARG CSP_API_ORIGINS=
ENV API_INTERNAL_URL=$API_INTERNAL_URL CSP_API_ORIGINS=$CSP_API_ORIGINS NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
