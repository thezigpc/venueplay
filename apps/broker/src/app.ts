import { bearer, safeEqual, type Logger } from "@bargames/common";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { VirtualScreenDriver } from "./drivers/virtual.js";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { AirplayDriver } from "./drivers/airplay/index.js";
import type { RokuDriver } from "./drivers/roku/index.js";
import type { VizioDriver } from "./drivers/vizio/index.js";
import type { AppleTvDriver } from "./drivers/appletv/index.js";
import type { VenueboxHub } from "./venuebox/hub.js";
import { mountAudio, type BoxAudio } from "./audio/index.js";
import type { DisplayRegistry } from "./registry.js";
import { checkStreamSettings, checkVideo, checkVideoAction, type DeliveryMethod, type DisplayContent, type StreamSettings } from "./types.js";

const h =
  (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);

/** Box 0.16.0: the broker's own saved files that go in a settings backup. */
const BACKUP_FILE = /^[a-z0-9-]+\.json$/;
const httpErr = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Broker API. Only core calls it (bearer token); it never faces players. */
export function createBrokerApp(d: { registry: DisplayRegistry; virtual?: VirtualScreenDriver; roku?: RokuDriver; airplay?: AirplayDriver; vizio?: VizioDriver; appletv?: AppleTvDriver; venuebox?: VenueboxHub; audio?: BoxAudio; token: string; log: Logger; dataDir?: string; restart?: () => void; setBoxName?: (name: string) => void }) {
  const app = express();
  app.disable("x-powered-by");
  // Settings restores (box 0.16.0) carry every TV pairing file; everything else is small.
  const small = express.json({ limit: "64kb" });
  const large = express.json({ limit: "4mb" });
  app.use((req, res, next) => (req.path === "/backup/restore" ? large : small)(req, res, next));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    if (!safeEqual(bearer(req.headers.authorization), d.token)) return void res.status(401).json({ error: "unauthorized" });
    next();
  });

  /**
   * Box 0.16.0: settings backup. The broker's saved files (TVs, groups, pairings, sound
   * settings), base64. Bluetooth pairings live in a root-only folder and aren't included.
   */
  app.get(
    "/backup",
    h(async (_req, res) => {
      if (!d.dataDir) throw httpErr(501, "no data folder");
      const files: Record<string, string> = {};
      for (const f of readdirSync(d.dataDir)) {
        if (!BACKUP_FILE.test(f)) continue;
        try {
          files[f] = readFileSync(path.join(d.dataDir, f)).toString("base64");
        } catch {
          // unreadable: left out
        }
      }
      res.json({ files });
    }),
  );
  /** { files }: writes them back (only *.json names) and restarts the broker to load them. */
  app.post(
    "/backup/restore",
    h(async (req, res) => {
      if (!d.dataDir) throw httpErr(501, "no data folder");
      const files = (req.body ?? {}).files as Record<string, unknown> | undefined;
      if (!files || typeof files !== "object") throw httpErr(400, "files: { name: base64 }");
      const names = Object.keys(files).filter((f) => BACKUP_FILE.test(f) && typeof files[f] === "string");
      for (const f of names) {
        const target = path.join(d.dataDir, f);
        const tmp = `${target}.restore`;
        writeFileSync(tmp, Buffer.from(files[f] as string, "base64"), { mode: 0o600 });
        renameSync(tmp, target);
      }
      d.log.warn("backup", "settings restored; restarting to load them", { files: names.length });
      res.json({ ok: true, restored: names });
      setTimeout(() => d.restart?.(), 500).unref?.();
    }),
  );

  /** Box 0.16.2: { name }: the venue's name, from core (Venuebox apps and LAN discovery show it). */
  app.put("/box", (req, res) => {
    const name = String(req.body?.name ?? "").trim().slice(0, 100);
    if (!name) return void res.status(400).json({ error: "name required" });
    d.setBoxName?.(name);
    res.json({ ok: true, name });
  });

  /** Host network traffic (the broker shares the host's network) and casting load, for the System page. */
  app.get(
    "/system",
    h(async (_req, res) => {
      const views = await d.registry.view(false);
      const streams = views.map((v) => v.stream).filter((x): x is NonNullable<typeof x> => Boolean(x));
      res.json({
        network: hostInterfaces(readFileSync("/proc/net/dev", "utf8")),
        casting: { tvs: streams.length, streaming: streams.filter((x) => x.state === "streaming").length, pages: new Set(streams.map((x) => `${x.settings ?? ""}|${x.url}`)).size },
      });
    }),
  );

  app.get(
    "/displays",
    h(async (req, res) => res.json(await d.registry.view(req.query.health === "1", req.query.all === "1"))),
  );

  app.post(
    "/discover",
    h(async (req, res) => res.json(await d.registry.discover(Number(req.body?.timeoutMs) || 3000))),
  );

  /** Add a Roku by IP when multicast discovery can't see it (other subnet, AP isolation). */
  app.post(
    "/displays/roku",
    h(async (req, res) => {
      if (!d.roku) return void res.status(400).json({ error: "roku driver disabled" });
      const host = String(req.body?.host ?? "");
      if (!/^[\w.-]+$/.test(host)) return void res.status(400).json({ error: "host must be an IP or hostname" });
      const dev = await d.roku.probe(`http://${host}:8060`);
      await d.registry.merge([dev]);
      res.json(d.registry.get(dev.id));
    }),
  );

  /** Add an AirPlay receiver (Apple TV, AirPlay TV, UxPlay) by IP when mDNS can't see it. */
  app.post(
    "/displays/airplay",
    h(async (req, res) => {
      if (!d.airplay) return void res.status(400).json({ error: "airplay driver disabled" });
      const host = String(req.body?.host ?? "");
      if (!/^[\w.-]+$/.test(host)) return void res.status(400).json({ error: "host must be an IP or hostname" });
      const dev = await d.airplay.probe(host);
      await d.registry.merge([dev]);
      const added = d.registry.get(dev.id);
      if (!added) return void res.status(409).json({ error: `${host} is already listed as a Roku` });
      res.json(added);
    }),
  );

  /** Add a Vizio by IP when mDNS can't see it. */
  app.post(
    "/displays/vizio",
    h(async (req, res) => {
      if (!d.vizio) return void res.status(400).json({ error: "vizio driver disabled" });
      const host = String(req.body?.host ?? "");
      if (!/^[\w.-]+$/.test(host)) return void res.status(400).json({ error: "host must be an IP or hostname" });
      const dev = await d.vizio.probe(host);
      const replaced = await d.registry.merge([dev]);
      res.json({ ...d.registry.get(dev.id), replaced });
    }),
  );

  /** Add an Apple TV by IP when mDNS can't see it. */
  app.post(
    "/displays/appletv",
    h(async (req, res) => {
      if (!d.appletv) return void res.status(400).json({ error: "Apple TV control isn't available on this box" });
      const host = String(req.body?.host ?? "");
      if (!/^[\w.-]+$/.test(host)) return void res.status(400).json({ error: "host must be an IP or hostname" });
      const dev = await d.appletv.probe(host);
      const replaced = await d.registry.merge([dev]);
      res.json({ ...d.registry.get(dev.id), replaced });
    }),
  );

  app.patch(
    "/displays/:id",
    h(async (req, res) => {
      const { label, group, delivery, streamSettings, ignored, touch } = req.body ?? {};
      if (touch !== undefined) {
        if (typeof touch !== "boolean") return void res.status(400).json({ error: "touch: true or false" });
        if (one(req.params.id).driver !== "local") return void res.status(400).json({ error: "touch is for screens plugged into the box" });
      }
      if (ignored !== undefined) {
        if (typeof ignored !== "boolean") return void res.status(400).json({ error: "ignored: true or false" });
        await d.registry.setIgnored(req.params.id, ignored);
        if (label === undefined && group === undefined && delivery === undefined && streamSettings === undefined) return void res.json(d.registry.get(req.params.id));
      }
      // null clears a TV's own settings (back to the box default).
      if (streamSettings !== undefined && streamSettings !== null) {
        const problem = checkStreamSettings(streamSettings);
        if (problem) return void res.status(400).json({ error: problem });
      }
      res.json(await d.registry.patch(req.params.id, { label, group, delivery: delivery as DeliveryMethod | undefined, streamSettings: streamSettings as StreamSettings | null | undefined, ...(touch !== undefined ? { touch } : {}) }));
    }),
  );

  app.delete(
    "/displays/:id",
    h(async (req, res) => {
      await d.registry.remove(req.params.id);
      res.json({ ok: true });
    }),
  );

  const one = (id: string) => {
    const dev = d.registry.get(id);
    if (!dev) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    return dev;
  };

  app.post(
    "/displays/:id/power",
    h(async (req, res) => {
      const dev = one(req.params.id);
      await d.registry.driverFor(dev).power(dev, Boolean(req.body?.on));
      res.json({ ok: true });
    }),
  );

  /** {} starts pairing (the TV shows its code); { code } completes it. */
  app.post(
    "/displays/:id/pair",
    h(async (req, res) => {
      one(req.params.id);
      const code = req.body?.code === undefined ? undefined : String(req.body.code).trim();
      if (code !== undefined && !/^[ -~]{1,64}$/.test(code)) return void res.status(400).json({ error: "code: 1-64 printable characters" });
      res.json(await d.registry.pair(req.params.id, code || undefined));
    }),
  );

  /** TV control (Vizio): {} makes the TV show a PIN; { code } completes it. The token stays in the broker. */
  app.post(
    "/displays/:id/pair-control",
    h(async (req, res) => {
      one(req.params.id);
      const code = req.body?.code === undefined ? undefined : String(req.body.code).trim();
      if (code !== undefined && code !== "" && !/^\d{4,8}$/.test(code)) return void res.status(400).json({ error: "the PIN is the 4 digits the TV shows" });
      res.json(await d.registry.pairControl(req.params.id, code || undefined));
    }),
  );

  // Venuebox apps: paired devices, pending codes, pair / rename / revoke.
  const hub = () => {
    if (!d.venuebox) throw Object.assign(new Error("Venuebox clients are turned off on this box"), { status: 400 });
    return d.venuebox;
  };
  app.get("/venuebox", (_req, res) => res.json(hub().devicesView()));
  /** { code, name? }: the code a Venuebox app shows on its screen. */
  app.post(
    "/venuebox/pair",
    h(async (req, res) => {
      const code = String(req.body?.code ?? "").replace(/\D/g, "");
      if (code.length !== 6) return void res.status(400).json({ error: "the code is 6 digits" });
      res.json(await hub().approve(code, typeof req.body?.name === "string" ? req.body.name : undefined));
    }),
  );
  app.patch(
    "/venuebox/devices/:id",
    h(async (req, res) => {
      const name = String(req.body?.name ?? "").trim();
      if (!name) return void res.status(400).json({ error: "name required" });
      const dev = await hub().rename(req.params.id, name);
      if (!dev) return void res.status(404).json({ error: "no such device" });
      res.json(dev);
    }),
  );
  app.delete(
    "/venuebox/devices/:id",
    h(async (req, res) => {
      if (!(await hub().revoke(req.params.id))) return void res.status(404).json({ error: "no such device" });
      res.json({ ok: true });
    }),
  );
  /** Flashes the screen's name on it. */
  app.post(
    "/displays/:id/identify",
    h(async (req, res) => {
      const dev = one(req.params.id);
      if (dev.driver !== "venuebox" || !d.venuebox?.identify(dev)) return void res.status(400).json({ error: "only connected Venuebox screens can do that" });
      res.json({ ok: true });
    }),
  );

  // Media providers (core checks the provider's rights before calling these).
  /** { app, provider, title? }: start a TV app on this display. */
  app.post(
    "/displays/:id/launch",
    h(async (req, res) => {
      const { app: tvApp, provider, title } = req.body ?? {};
      if (typeof tvApp !== "string" || typeof provider !== "string") return void res.status(400).json({ error: "app and provider required" });
      res.json(await d.registry.launchApp(req.params.id, tvApp, provider, typeof title === "string" ? title.slice(0, 80) : undefined));
    }),
  );
  /** { app, provider, title? }: the TV shows an app now (the provider got there without a launch). */
  app.post(
    "/displays/:id/external",
    h(async (req, res) => {
      const { app: tvApp, provider, title } = req.body ?? {};
      if (typeof tvApp !== "string" || typeof provider !== "string") return void res.status(400).json({ error: "app and provider required" });
      await d.registry.markExternal(req.params.id, provider, tvApp, typeof title === "string" ? title.slice(0, 80) : undefined);
      res.json({ ok: true });
    }),
  );
  // Box 0.27.0: video links the TV plays itself. Core checks the app's video.play first.
  // The URL and poster may carry the media server's key: never logged, never stored.
  /** { url, mime?, title, poster?, startAt?, provider } */
  app.post(
    "/displays/:id/video",
    h(async (req, res) => {
      const v = checkVideo(req.body);
      if (typeof v === "string") return void res.status(400).json({ error: v });
      res.json(await d.registry.playVideo(req.params.id, v.video, v.provider));
    }),
  );
  /** { action: "pause" | "resume" | "stop" } or { seek: seconds } */
  app.post(
    "/displays/:id/video/control",
    h(async (req, res) => {
      const action = checkVideoAction(req.body);
      if (!action) return void res.status(400).json({ error: 'action: "pause" | "resume" | "stop", or seek: seconds, or audio / subtitle: a track id' });
      res.json(await d.registry.videoControl(req.params.id, action));
    }),
  );
  app.get(
    "/displays/:id/video",
    h(async (req, res) => res.json(await d.registry.videoStatus(req.params.id))),
  );

  /** DIAL screen id (YouTube's Lounge screen id). Never logged. */
  app.get(
    "/displays/:id/dial/:app",
    h(async (req, res) => res.json({ screenId: await d.registry.dialScreenId(req.params.id, req.params.app) })),
  );

  /** What's on screen (Roku: ECP active-app). {} when the TV can't say. */
  app.get(
    "/displays/:id/active-app",
    h(async (req, res) => {
      const dev = one(req.params.id);
      const r = await d.registry.driverFor(dev).foregroundApp?.(dev).catch(() => undefined);
      res.json(r ?? {});
    }),
  );

  // The remote's Apps list (Roku channels).
  // Roku channel ids ("837", "dev") and Apple TV bundle ids ("com.example.App").
  const APP_ID = /^[A-Za-z0-9_.-]{1,100}$/;
  app.get(
    "/displays/:id/apps",
    h(async (req, res) => res.json(await d.registry.listApps(req.params.id))),
  );
  app.get(
    "/displays/:id/apps/:appId/icon",
    h(async (req, res) => {
      if (!APP_ID.test(req.params.appId)) return void res.status(400).json({ error: "bad app id" });
      const icon = await d.registry.appIcon(req.params.id, req.params.appId);
      if (!icon) return void res.status(204).end();
      res.set("cache-control", "private, max-age=86400").type(icon.type).send(icon.data);
    }),
  );
  app.post(
    "/displays/:id/apps/:appId/launch",
    h(async (req, res) => {
      if (!APP_ID.test(req.params.appId)) return void res.status(400).json({ error: "bad app id" });
      await d.registry.launchChannel(req.params.id, req.params.appId);
      res.json({ ok: true });
    }),
  );

  /** { key }: a remote-control key (capabilities.remoteKeys). */
  app.post(
    "/displays/:id/key",
    h(async (req, res) => {
      const dev = one(req.params.id);
      const drv = d.registry.driverFor(dev);
      if (!drv.keypress) return void res.status(400).json({ error: `${dev.label || dev.name} has no remote control` });
      await drv.keypress(dev, String(req.body?.key ?? ""));
      res.json({ ok: true });
    }),
  );

  /** { text }: types into the TV's current text field. */
  app.post(
    "/displays/:id/text",
    h(async (req, res) => {
      const dev = one(req.params.id);
      const drv = d.registry.driverFor(dev);
      const text = String(req.body?.text ?? "");
      if (!drv.typeText) return void res.status(400).json({ error: `${dev.label || dev.name} can't take typed text` });
      if (!/^[ -~]{1,100}$/.test(text)) return void res.status(400).json({ error: "text: 1-100 printable characters" });
      await drv.typeText(dev, text);
      res.json({ ok: true });
    }),
  );

  // ---- Box 0.30.1: the virtual test TV (drivers/virtual.ts). Broker token only; never in the admin.
  const vt = () => {
    if (!d.virtual) throw Object.assign(new Error("no virtual TV on this box"), { status: 404 });
    return d.virtual;
  };
  const pageName = (n: string) => {
    if (!/^[a-z0-9-]{1,20}$/.test(n)) throw Object.assign(new Error("page names: a-z, 0-9, -"), { status: 400 });
    return n;
  };
  app.get(
    "/virtual",
    h(async (_req, res) => void res.json(await vt().inspect())),
  );
  /** { minutes } turns it on (1..240) and lists it; { off: true } turns it off now. */
  app.post(
    "/virtual",
    h(async (req, res) => {
      const b = (req.body ?? {}) as { minutes?: unknown; off?: unknown };
      if (b.off === true) {
        await vt().off();
        return void res.json({ ok: true, active: false });
      }
      const minutes = typeof b.minutes === "number" && Number.isFinite(b.minutes) ? b.minutes : 60;
      const until = vt().on(minutes);
      await d.registry.merge(await vt().discover());
      res.json({ ok: true, active: true, until: until.toISOString() });
    }),
  );
  app.post(
    "/virtual/:page/open",
    h(async (req, res) => {
      const url = (req.body ?? {}).url;
      if (typeof url !== "string" || !/^(https?:|about:blank$)/.test(url)) return void res.status(400).json({ error: "url: http(s)" });
      await vt().open(pageName(req.params.page), url);
      res.json({ ok: true });
    }),
  );
  app.post(
    "/virtual/:page/eval",
    h(async (req, res) => {
      const expression = (req.body ?? {}).expression;
      if (typeof expression !== "string" || !expression) return void res.status(400).json({ error: "expression: a script" });
      res.json({ ok: true, value: await vt().evaluate(pageName(req.params.page), expression) });
    }),
  );
  app.get(
    "/virtual/:page/shot",
    h(async (req, res) => {
      const jpeg = await vt().screenshot(pageName(req.params.page));
      if (!jpeg) return void res.status(204).end();
      res.set("cache-control", "no-store").type("image/jpeg").send(jpeg);
    }),
  );
  app.delete(
    "/virtual/:page",
    h(async (req, res) => {
      await vt().closePage(pageName(req.params.page));
      res.json({ ok: true });
    }),
  );

  /** A JPEG of what the box is sending this TV; 204 when it isn't casting. */
  app.get(
    "/displays/:id/preview",
    h(async (req, res) => {
      const jpeg = await d.registry.preview(req.params.id).catch((err: Error & { status?: number }) => {
        if (err.status === 404) throw err;
        return undefined; // page still loading, Chromium busy: no picture this time
      });
      if (!jpeg) return void res.status(204).end();
      res.set("cache-control", "no-store").type("image/jpeg").send(jpeg);
    }),
  );

  app.post(
    "/displays/:id/input",
    h(async (req, res) => {
      one(req.params.id);
      await d.registry.setInput(req.params.id, String(req.body?.input ?? ""));
      res.json({ ok: true });
    }),
  );

  /** { channel: "7.1" }: the TV's own tuner (Roku TVs). */
  app.post(
    "/displays/:id/channel",
    h(async (req, res) => {
      one(req.params.id);
      const channel = String(req.body?.channel ?? "").trim();
      if (!/^\d{1,4}(\.\d{1,3})?$/.test(channel)) return void res.status(400).json({ error: "channel: like 7 or 7.1" });
      await d.registry.tuneChannel(req.params.id, channel);
      res.json({ ok: true });
    }),
  );

  /**
   * Box 0.15.2: "Detach from all TVs". Stops every cast and every sound session on a TV.
   * Nothing is powered off and no input changes.
   */
  app.post(
    "/detach-all",
    h(async (_req, res) => {
      const audioStopped: string[] = [];
      if (d.audio) {
        for (const s of d.audio.engine.list()) {
          if (s.output.startsWith("tv:") && ["starting", "playing", "paused"].includes(s.state)) {
            d.audio.engine.stop(s.id, "Staff detached the box from every TV.");
            audioStopped.push(s.id);
          }
        }
      }
      const r = await d.registry.detachAll();
      d.log.info("displays", "detached from every TV", { tvs: r.stopped.length, failed: Object.keys(r.failed).length, audio: audioStopped.length });
      res.json({ ...r, audioStopped: audioStopped.length });
    }),
  );

  /** { displayIds?: string[], group?: string, content: { kind: "url", url } | { kind: "idle" } | { kind: "off" } } */
  app.post(
    "/show",
    h(async (req, res) => {
      const content = req.body?.content as DisplayContent | undefined;
      if (!content || !["url", "idle", "off"].includes(content.kind)) return void res.status(400).json({ error: "content.kind must be url, idle or off" });
      if (content.kind === "url" && !/^https?:\/\//.test(content.url)) return void res.status(400).json({ error: "content.url must be http(s)" });
      if (content.kind === "idle" && content.url !== undefined && !/^(https?:\/\/|data:text\/html[;,])/.test(content.url)) return void res.status(400).json({ error: "idle url must be http(s) or a data:text/html page" });
      res.json(await d.registry.show({ displayIds: req.body.displayIds, group: req.body.group }, content));
    }),
  );

  // Sound outputs, Bluetooth speakers and playback (Settings → Connected devices; apps' bg.audio).
  mountAudio(app, d.audio);

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    if (status >= 500) d.log.warn("http", "request failed", { err: String(err) });
    res.status(status).json({ error: err.message });
  });

  return app;
}

/** /proc/net/dev → physical/VPN interfaces with byte counters (docker bridges and veths left out). */
export function hostInterfaces(text: string): { name: string; rxBytes: number; txBytes: number }[] {
  return text
    .split(/\r?\n/)
    .slice(2)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, rest] = l.split(":");
      const n = rest.trim().split(/\s+/).map(Number);
      return { name: name.trim(), rxBytes: n[0] ?? 0, txBytes: n[8] ?? 0 };
    })
    .filter((i) => i.name !== "lo" && !/^(veth|docker|br-)/.test(i.name));
}
