// The box's sound: outputs (its own jack/HDMI, paired Bluetooth speakers, AirPlay TVs),
// Bluetooth pairing, and playback sessions. Core calls these routes for the admin's
// Connected devices page and for apps that play sound (SDK 0.13.0 bg.audio).

import { existsSync } from "node:fs";
import path from "node:path";
import { JsonStore, type Logger } from "@bargames/common";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { DisplayRegistry } from "../registry.js";
import { hostOf } from "../registry.js";
import { Bluetooth, isBtAddress } from "./bluetooth.js";
import { boxOutputs } from "./boxOutputs.js";
import { AudioEngine, type Spawn } from "./engine.js";
import type { AudioSettings, OutputTarget } from "./types.js";

export interface BoxAudio {
  engine: AudioEngine;
  bluetooth?: Bluetooth;
}

export function createBoxAudio(o: {
  registry: DisplayRegistry;
  dataDir: string;
  log: Logger;
  /** pyatv for AirPlay audio (absent: no TV outputs). */
  airplay?: { python: string; script: string };
  bluetooth?: Bluetooth;
  /** Overrides for tests and development. */
  boxTargets?: () => OutputTarget[];
  spawn?: Spawn;
}): BoxAudio {
  const bluetooth = o.bluetooth;
  const targets = async (): Promise<OutputTarget[]> => {
    const out: OutputTarget[] = [...(o.boxTargets ?? boxOutputs)()];
    if (bluetooth) {
      const devices = await bluetooth.paired().catch(() => []);
      for (const d of devices.filter((x) => x.audio)) {
        out.push({
          id: `bt:${d.address}`,
          kind: "bluetooth",
          name: d.name,
          address: d.address,
          available: true,
          detail: d.connected ? "Connected" : "Paired; the box connects to it when it plays",
        });
      }
    }
    if (o.airplay) {
      const views = await o.registry.view(false).catch(() => []);
      for (const v of views) {
        const host = hostOf(v.address);
        if (!host || !v.capabilities?.delivery.includes("airplay")) continue;
        out.push({
          id: `tv:${v.id}`,
          kind: "tv",
          name: v.label || v.name,
          address: host,
          available: true,
          detail: "Over AirPlay. Stops anything the box is casting to this TV while it plays",
        });
      }
    }
    return out;
  };
  const engine = new AudioEngine({
    settings: new JsonStore<AudioSettings>(path.join(o.dataDir, "audio.json"), { volumes: {}, labels: {} }),
    targets,
    ensureBluetooth: bluetooth ? (addr) => bluetooth.ensureConnected(addr) : undefined,
    log: o.log,
    spawn: o.spawn,
    airplay: o.airplay,
  });
  return { engine, bluetooth };
}

/** The real thing in the broker image; nothing (no outputs) on a dev machine without the tools. */
export function audioFromEnv(registry: DisplayRegistry, dataDir: string, log: Logger, atv: { python: string; script: string }): BoxAudio | undefined {
  if (process.env.AUDIO === "off" || !existsSync("/usr/bin/aplay")) return undefined;
  const streamScript = path.join(path.dirname(atv.script), "atv-stream.py");
  const airplay = existsSync(atv.python) && existsSync(streamScript) ? { python: atv.python, script: streamScript } : undefined;
  const bluetooth = existsSync("/usr/bin/bluetoothctl") ? new Bluetooth() : undefined;
  if (bluetooth) void bluetooth.powerOn().catch(() => undefined);
  return createBoxAudio({ registry, dataDir, log, airplay, bluetooth });
}

const h =
  (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Mounts /audio/* on the broker app (behind its bearer check). */
export function mountAudio(app: Express, audio: BoxAudio | undefined): void {
  const need = (_req: Request, res: Response, next: NextFunction) => {
    if (!audio) return void res.status(503).json({ error: "This box has no sound outputs." });
    next();
  };
  const a = () => audio!;
  const bt = () => {
    if (!audio?.bluetooth) throw Object.assign(new Error("This box has no Bluetooth."), { status: 409 });
    return audio.bluetooth;
  };

  /** Everything the Connected devices page shows, in one call. */
  app.get(
    "/audio",
    h(async (_req, res) => {
      if (!audio) return void res.json({ available: false, outputs: [], sessions: [], bluetooth: null });
      const [outputs, bluetooth] = await Promise.all([a().engine.outputs(), audio.bluetooth ? audio.bluetooth.status() : Promise.resolve(null)]);
      res.json({ available: true, outputs, sessions: a().engine.list(), bluetooth });
    }),
  );

  app.get("/audio/outputs", need, h(async (_req, res) => res.json(await a().engine.outputs())));

  /** { label?, volume?, default?: true } */
  app.patch(
    "/audio/outputs/:id",
    need,
    h(async (req, res) => {
      const { label, volume } = req.body ?? {};
      if (volume !== undefined) await a().engine.setVolume(req.params.id, Number(volume));
      if (label !== undefined) await a().engine.setLabel(req.params.id, label === null ? null : String(label));
      if (req.body?.default === true) await a().engine.setDefault(req.params.id);
      res.json((await a().engine.outputs()).find((o) => o.id === req.params.id) ?? { ok: true });
    }),
  );

  app.post(
    "/audio/outputs/:id/test",
    need,
    h(async (req, res) => res.json(await a().engine.play({ output: req.params.id, tone: true, owner: "admin", title: "Test sound" }))),
  );

  app.get("/audio/sessions", need, (req, res) => res.json(a().engine.list(str(req.query.owner))));

  /** { url, owner, output?, title?, artist?, album?, durationMs? } (core: an app's audio). */
  app.post(
    "/audio/play",
    need,
    h(async (req, res) => {
      const b = req.body ?? {};
      const owner = str(b.owner);
      if (!owner || !/^(admin|app:[a-z][a-z0-9-]{1,31})$/.test(owner)) return void res.status(400).json({ error: "owner: admin or app:<id>" });
      res.json(await a().engine.play({ url: str(b.url), owner, output: str(b.output), title: str(b.title), artist: str(b.artist), album: str(b.album), durationMs: num(b.durationMs) }));
    }),
  );

  app.post(
    "/audio/sessions/:id/:action(pause|resume|stop)",
    need,
    h((req, res) => {
      const e = a().engine;
      const id = req.params.id;
      res.json(req.params.action === "pause" ? e.pause(id) : req.params.action === "resume" ? e.resume(id) : e.stop(id, req.body?.by === "admin" ? "Stopped by staff." : "Stopped."));
    }),
  );

  // ---- Bluetooth
  app.get(
    "/audio/bluetooth",
    need,
    h(async (_req, res) => {
      const b = bt();
      const status = await b.status();
      res.json({ status, devices: status.available ? await b.devices() : [] });
    }),
  );
  app.post(
    "/audio/bluetooth/scan",
    need,
    h(async (req, res) => {
      const seconds = Math.min(60, Math.max(5, Number(req.body?.seconds) || 20));
      await bt().scan(seconds);
      res.json({ ok: true, seconds });
    }),
  );
  app.post(
    "/audio/bluetooth/:address/:action(pair|connect|disconnect)",
    need,
    h(async (req, res) => {
      const addr = req.params.address.toUpperCase();
      if (!isBtAddress(addr)) return void res.status(400).json({ error: "bad Bluetooth address" });
      const b = bt();
      if (req.params.action === "pair") b.pair(addr);
      else if (req.params.action === "connect") await b.connect(addr);
      else await b.disconnect(addr);
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/audio/bluetooth/:address",
    need,
    h(async (req, res) => {
      const addr = req.params.address.toUpperCase();
      if (!isBtAddress(addr)) return void res.status(400).json({ error: "bad Bluetooth address" });
      const playing = a().engine.list().find((s) => s.output === `bt:${addr}` && (s.state === "playing" || s.state === "paused" || s.state === "starting"));
      if (playing) a().engine.stop(playing.id, "The speaker was removed.", "disconnected");
      await bt().forget(addr);
      res.json({ ok: true });
    }),
  );
}
