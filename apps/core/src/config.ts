import { envNum, persistentSecret } from "@bargames/common";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve(here, "../../../data/core");

export const BOX_VERSION = "0.1.0";

export const config = {
  port: envNum("PORT", 7100),
  dataDir,
  /** How games and the gateway reach core (container DNS name on the box). */
  internalUrl: process.env.CORE_INTERNAL_URL ?? "http://127.0.0.1:7100",
  /** Broker runs on the host network; from a container it's host.docker.internal. */
  brokerUrl: process.env.BROKER_URL ?? "http://127.0.0.1:7200",
  brokerToken: persistentSecret(dataDir, "broker.token", process.env.BROKER_TOKEN),
  gatewayToken: persistentSecret(dataDir, "gateway.token", process.env.GATEWAY_TOKEN),
  sessionSecret: persistentSecret(dataDir, "session.secret", process.env.SESSION_SECRET),
  /** For bgctl (the box host's command line): read from the data folder, never sent anywhere. */
  opsToken: persistentSecret(dataDir, "ops.token"),
  /** "docker" on a box, "noop" for local development. */
  runtime: (process.env.GAME_RUNTIME ?? "noop") as "docker" | "noop",
  dockerUrl: process.env.DOCKER_URL ?? "http://docker-proxy:2375",
  /** Containers that must join every game network (so they can reach games). */
  attachContainers: (process.env.ATTACH_CONTAINERS ?? "bargames-core,bargames-gateway").split(",").filter(Boolean),
  adminDist: process.env.ADMIN_DIST ?? path.resolve(here, "../../admin/dist"),
  /** Stable per-box id (tunnel names, so two boxes on one Cloudflare account never collide). */
  boxId: createHash("sha256").update(persistentSecret(dataDir, "box.id")).digest("hex").slice(0, 6),
  tunnel: {
    image: process.env.CLOUDFLARED_IMAGE ?? "cloudflare/cloudflared:2026.10.4",
    /** The stack's network: cloudflared must reach the gateway there. */
    network: process.env.TUNNEL_NETWORK ?? "bargames",
    origin: process.env.TUNNEL_ORIGIN ?? "http://bargames-gateway:7080",
  },
};
