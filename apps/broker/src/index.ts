import { createLogger, envNum, JsonStore } from "@bargames/common";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrokerApp } from "./app.js";
import { MockDriver } from "./drivers/mock.js";
import { RokuDriver } from "./drivers/roku/index.js";
import { DisplayRegistry, type DisplayRecord } from "./registry.js";
import { PendingStreamService } from "./streams.js";
import type { DisplayDriver } from "./types.js";

const log = createLogger("broker");
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve(here, "../../../data/broker");
const port = envNum("PORT", 7200);
const host = process.env.HOST ?? "0.0.0.0";
// In development core writes the shared token to data/core/broker.token.
const token =
  process.env.BROKER_TOKEN ?? readFileSync(process.env.BROKER_TOKEN_FILE ?? path.resolve(here, "../../../data/core/broker.token"), "utf8").trim();

const streams = new PendingStreamService();
const drivers = new Map<string, DisplayDriver>();
const enabled = (process.env.DRIVERS ?? "roku").split(",").map((s) => s.trim());
const roku = enabled.includes("roku") ? new RokuDriver(streams) : undefined;
if (roku) drivers.set(roku.id, roku);
const mockCount = envNum("MOCK_DISPLAYS", 0);
if (mockCount) drivers.set("mock", new MockDriver(mockCount));

const registry = new DisplayRegistry(new JsonStore<{ displays: DisplayRecord[] }>(path.join(dataDir, "displays.json"), { displays: [] }), drivers);

createBrokerApp({ registry, roku, token, log }).listen(port, host, () => {
  log.info("boot", "listening", { port, host, drivers: [...drivers.keys()] });
  if (mockCount) void registry.discover();
});
