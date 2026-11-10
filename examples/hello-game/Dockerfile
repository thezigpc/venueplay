# Build from the repo root:  docker build -f examples/hello-game/Dockerfile -t hello-game .
FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npx tsc -b packages/sdk examples/hello-game && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=7300
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/sdk ./packages/sdk
COPY --from=build /app/examples/hello-game ./examples/hello-game
USER node
EXPOSE 7300
CMD ["node", "examples/hello-game/dist/index.js"]
