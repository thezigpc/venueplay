# One image for core + gateway (+ broker for now); each service picks its entrypoint.
# Build from the repo root:  docker build -f deploy/Dockerfile -t bargames:dev .
FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/core/dist ./apps/core/dist
COPY --from=build /app/apps/core/package.json ./apps/core/
COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /app/apps/gateway/package.json ./apps/gateway/
COPY --from=build /app/apps/broker/dist ./apps/broker/dist
COPY --from=build /app/apps/broker/package.json ./apps/broker/
COPY --from=build /app/apps/admin/dist ./apps/admin/dist
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "apps/core/dist/index.js"]

# Phase 3: the broker gets its own image on top of this one, adding Chromium,
# a virtual display, GStreamer + intel-media-va-driver-non-free, and doubletake.
