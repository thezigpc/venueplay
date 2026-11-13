import { createLogger, envNum, JsonStore } from "@bargames/common";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrokerApp } from "./app.js";
import { MockDriver } from "./drivers/mock.js";
import { AirplayDriver } from "./drivers/airplay/index.js";
import { RokuDriver } from "./drivers/roku/index.js";
import { LocalScreenDriver } from "./drivers/local/index.js";
import { DeviceStore, Pairings, type Device } from "./venuebox/devices.js";
import { VenueboxHub } from "./venuebox/hub.js";
import { playable } from "./registry.js";
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
// Plugged-in screens (HDMI/DisplayPort): cage + Chromium on the real output.
if (enabled.includes("local")) {
  const localDir = process.env.LOCAL_RUN_DIR ?? "/tmp/bargames-local";
  drivers.set("local", new LocalScreenDriver({ runner: existsSync("/usr/bin/cage") ? new NodeProcRunner(log, localDir) : undefined, log, runDir: localDir }));
}
const mockCount = envNum("MOCK_DISPLAYS", 0);
if (mockCount) drivers.set("mock", new MockDriver(mockCount));

const registry = new DisplayRegistry(new JsonStore<{ displays: DisplayRecord[] }>(path.join(dataDir, "displays.json"), { displays: [] }), drivers);

// Venuebox apps (docs/NATIVE-CLIENTS.md): pair with the box, render TV pages themselves.
const clientPort = envNum("CLIENT_PORT", 7210);
// On unless VENUEBOX=off (it only answers devices staff paired).
const venuebox = process.env.VENUEBOX !== "off"
  ? new VenueboxHub({
      devices: new DeviceStore(new JsonStore<{ devices: Device[] }>(path.join(dataDir, "venuebox-devices.json"), { devices: [] }, 0o600)),
      pairings: new Pairings(),
      log,
      boxName: () => process.env.BOX_NAME ?? "Bar Games box",
      displaysChanged: async (found, removed) => {
        await registry.merge(found);
        await registry.removeMany(removed);
      },
      reconnected: (ids) => {
        for (const id of ids) {
          const d = registry.get(id);
          if (d?.content && playable(d.content).kind === "url") void registry.show({ displayIds: [id] }, d.content).catch(() => undefined);
        }
      },
    })
  : undefined;
if (venuebox) drivers.set(venuebox.id, venuebox);

if (venuebox) venuebox.listen(clientPort).on("listening", () => log.info("boot", "venuebox clients", { port: clientPort }));

createBrokerApp({ registry, roku, airplay: airplayDriver, venuebox, token, log }).listen(port, host, () => {
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
