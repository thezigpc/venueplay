import { createLogger } from "@bargames/common";
import { createApp } from "./app.js";
import { AdminAuth } from "./auth.js";
import { CloudflareService } from "./cloudflare/service.js";
import { BOX_VERSION, config } from "./config.js";
import { EventBus } from "./events.js";
import { GameRegistry } from "./games.js";
import { publicUrl } from "./hostnames.js";
import { DockerRuntime } from "./runtime/docker.js";
import { NoopRuntime, type GameRuntime } from "./runtime/types.js";
import { openState } from "./state.js";
import { allHosts, gameHost } from "./venue.js";

const log = createLogger("core");
const state = openState(config.dataDir);
const games = new GameRegistry(state.games);
const bus = new EventBus(200, (sink, err) => log.warn("events", "sink failed", { sink, err: String(err) }));
bus.subscribe((evt) => log.info("events", evt.type, { game: evt.gameId, room: evt.roomCode }));

const runtime: GameRuntime =
  config.runtime === "docker"
    ? new DockerRuntime(config.dockerUrl, {
        coreUrl: config.internalUrl,
        attach: config.attachContainers,
        publicUrlFor: (g) => publicUrl(state.venue.get(), gameHost(state.venue.get(), g)),
        log,
        tunnel: { image: config.tunnel.image, network: config.tunnel.network },
      })
    : new NoopRuntime();

const cloudflare = new CloudflareService({
  store: state.cloudflare,
  connector: runtime as DockerRuntime | NoopRuntime,
  desiredHosts: () => allHosts(state.venue.get(), games.list()),
  tunnelName: () => `bargames-${state.venue.get().slug}-${config.boxId}`,
  origin: config.tunnel.origin,
  log,
});

const app = createApp({
  state,
  games,
  runtime,
  bus,
  auth: new AdminAuth(state.auth, config.sessionSecret),
  cloudflare,
  log,
  config: { ...config, boxVersion: BOX_VERSION },
});

app.listen(config.port, () => {
  log.info("boot", "listening", { port: config.port, runtime: runtime.kind, dataDir: config.dataDir });
  cloudflare.start();
  (app.locals.tvWatch as { start(): void }).start();
  (app.locals.roomCache as { start(): void }).start();
  // Bring enabled games back after a reboot.
  for (const g of games.list().filter((g) => g.enabled)) {
    runtime.ensureRunning(g).catch((err) => log.error("runtime", "failed to start game", { game: g.id, err: String(err) }));
  }
});
