# One image for core + gateway (+ broker for now); each service picks its entrypoint.
# Build from the repo root:  docker build -f deploy/Dockerfile -t bargames:dev .
FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

# core + gateway (compose target "app")
FROM node:22-slim AS app
WORKDIR /app
# The box version (repo VERSION file), set by the release workflow; "dev" for local builds.
ARG BOX_VERSION=dev
ENV NODE_ENV=production BARGAMES_VERSION=$BOX_VERSION
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

# broker (compose target "broker"): the app plus what casting needs.
#   Xvfb (virtual display) -> Chromium (kiosk, the game's TV view) -> doubletake
#   (AirPlay mirroring sender, LGPL-3.0, prebuilt static binary) encoding H.264 with
#   GStreamer + Intel VA-API (QuickSync; intel-media-va-driver-non-free).
FROM app AS broker
USER root
RUN sed -i "s/Components: main/Components: main contrib non-free non-free-firmware/" /etc/apt/sources.list.d/debian.sources  && apt-get update && apt-get install -y --no-install-recommends       xvfb xdotool chromium fonts-dejavu-core fonts-liberation fonts-noto-color-emoji       gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad       gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-x       intel-media-va-driver-non-free vainfo pulseaudio-utils ca-certificates \n      cage seatd xwayland libgl1-mesa-dri  && rm -rf /var/lib/apt/lists/*
# doubletake v0.5.0 (https://github.com/omarroth/doubletake). Pinned by checksum.
ADD --checksum=sha256:59027455bb844f15119232600569aded721203271001591a0afc5a0d07c06b5c     https://github.com/omarroth/doubletake/releases/download/v0.5.0/doubletake /usr/local/bin/doubletake
ADD --checksum=sha256:1cf40195f83ef4c1f885392e1b90d2ce077270b9391a38a717598170cb1aa4eb     https://github.com/omarroth/doubletake/releases/download/v0.5.0/doubletake-ctl /usr/local/bin/doubletake-ctl
# Plugged-in screens: seatd (root) hands the screen to cage; the broker itself runs as node.
COPY deploy/broker-start /usr/local/bin/broker-start
RUN chmod 755 /usr/local/bin/doubletake /usr/local/bin/doubletake-ctl /usr/local/bin/broker-start
USER node
ENV STREAMS=airplay
CMD ["node", "apps/broker/dist/index.js"]

# Default target (plain `docker build`): core/gateway.
FROM app
