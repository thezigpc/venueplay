import { createLogger, envNum, JsonStore } from "@bargames/common";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrokerApp } from "./app.js";
import { MockDriver } from "./drivers/mock.js";
import { AirplayDriver } from "./drivers/airplay/index.js";
import { RokuDriver } from "./drivers/roku/index.js";
import { DisplayRegistry, type DisplayRecord } from "./registry.js";
import { AirplayStreams } from "./airplay.js";
import { NodeProcRunner } from "./procs.js";
import { PendingStreamService } from "./streams.js";
import type { DisplayDriver, StreamService } from "./types.js";
import { existsSync } from "node:fs";

const log = createLogger("broker");
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve(here, "../../../data/broker");
const port = envNum("PORT", 7200);
const host = process.env.HOST ?? "0.0.0.0";
// In development core writes the shared token to data/core/broker.token.
const token =
  process.env.BROKER_TOKEN ?? readFileSync(process.env.BROKER_TOKEN_FILE ?? path.resolve(here, "../../../data/core/broker.token"), "utf8").trim();

// AirPlay needs Xvfb + Chromium + doubletake (the broker image has them); "auto" uses
// them when present, so a dev machine without them still runs (casts say "not built").
const streamMode = process.env.STREAMS ?? "auto";
const airplayReady = streamMode === "airplay" || (streamMode === "auto" && existsSync("/usr/local/bin/doubletake"));
const runDir = process.env.CAST_RUN_DIR ?? "/tmp/bargames-cast";
const airplay = airplayReady
  ? new AirplayStreams({
      runner: new NodeProcRunner(log, runDir),
      log,
      runDir,
      credsFile: path.join(dataDir, "airplay-credentials.json"),
      hwaccel: process.env.AIRPLAY_HWACCEL ?? "auto",
      chromium: process.env.CHROMIUM_BIN ?? "chromium",
      fps: envNum("CAST_FPS", 30),
    })
  : undefined;
const streams: StreamService = airplay ?? new PendingStreamService();
const drivers = new Map<string, DisplayDriver>();
const enabled = (process.env.DRIVERS ?? "roku,airplay").split(",").map((s) => s.trim());
const roku = enabled.includes("roku") ? new RokuDriver(streams) : undefined;
if (roku) drivers.set(roku.id, roku);
const airplayDriver = enabled.includes("airplay") ? new AirplayDriver(streams) : undefined;
if (airplayDriver) drivers.set(airplayDriver.id, airplayDriver);
const mockCount = envNum("MOCK_DISPLAYS", 0);
if (mockCount) drivers.set("mock", new MockDriver(mockCount));

const registry = new DisplayRegistry(new JsonStore<{ displays: DisplayRecord[] }>(path.join(dataDir, "displays.json"), { displays: [] }), drivers);

createBrokerApp({ registry, roku, airplay: airplayDriver, token, log }).listen(port, host, () => {
  log.info("boot", "listening", { port, host, drivers: [...drivers.keys()], airplay: Boolean(airplay) });
  if (mockCount) void registry.discover();
  if (airplay) {
    airplay.start();
    void registry.resume();
  }
});

process.on("SIGTERM", () => {
  void (airplay?.shutdown() ?? Promise.resolve()).finally(() => process.exit(0));
});
