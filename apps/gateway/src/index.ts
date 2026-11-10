import { createLogger, envNum, type GatewayConfig } from "@bargames/common";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VenueIpDetector } from "./publicIp.js";
import { createGateway } from "./server.js";

const log = createLogger("gateway");
const here = path.dirname(fileURLToPath(import.meta.url));

const port = envNum("PORT", 7080);
const coreUrl = (process.env.CORE_URL ?? "http://127.0.0.1:7100").replace(/\/$/, "");
// In development core writes its token to data/core/gateway.token.
const token =
  process.env.GATEWAY_TOKEN ??
  readFileSync(process.env.GATEWAY_TOKEN_FILE ?? path.resolve(here, "../../../data/core/gateway.token"), "utf8").trim();

let config: GatewayConfig | undefined;
async function pull(): Promise<void> {
  try {
    const res = await fetch(`${coreUrl}/internal/gateway-config`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = (await res.json()) as GatewayConfig;
    if (!config) log.info("config", "loaded", { routes: next.routes.map((r) => r.host) });
    config = next;
  } catch (err) {
    log.warn("config", "could not refresh from core; keeping last good", { err: String(err) });
  }
}

const detector = new VenueIpDetector(log);
if (process.env.DETECT_VENUE_IP !== "false") detector.start();

await pull();
setInterval(() => void pull(), envNum("CONFIG_REFRESH_MS", 5000)).unref();

createGateway({ config: () => config, detectedCidrs: () => detector.cidrs(), secret: token, coreToken: token, log }).listen(port, () =>
  log.info("boot", "listening", { port, core: coreUrl }),
);
