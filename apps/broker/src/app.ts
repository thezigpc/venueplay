import { bearer, safeEqual, type Logger } from "@bargames/common";
import { readFileSync } from "node:fs";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { AirplayDriver } from "./drivers/airplay/index.js";
import type { RokuDriver } from "./drivers/roku/index.js";
import type { VenueboxHub } from "./venuebox/hub.js";
import type { DisplayRegistry } from "./registry.js";
import { checkStreamSettings, type DeliveryMethod, type DisplayContent, type StreamSettings } from "./types.js";

const h =
  (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);

/** Broker API. Only core calls it (bearer token); it never faces players. */
export function createBrokerApp(d: { registry: DisplayRegistry; roku?: RokuDriver; airplay?: AirplayDriver; venuebox?: VenueboxHub; token: string; log: Logger }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    if (!safeEqual(bearer(req.headers.authorization), d.token)) return void res.status(401).json({ error: "unauthorized" });
    next();
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
    h(async (req, res) => res.json(await d.registry.view(req.query.health === "1"))),
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

  app.patch(
    "/displays/:id",
    h(async (req, res) => {
      const { label, group, delivery, streamSettings } = req.body ?? {};
      // null clears a TV's own settings (back to the box default).
      if (streamSettings !== undefined && streamSettings !== null) {
        const problem = checkStreamSettings(streamSettings);
        if (problem) return void res.status(400).json({ error: problem });
      }
      res.json(await d.registry.patch(req.params.id, { label, group, delivery: delivery as DeliveryMethod | undefined, streamSettings: streamSettings as StreamSettings | null | undefined }));
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
  const APP_ID = /^[A-Za-z0-9_.-]{1,40}$/;
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
      const dev = one(req.params.id);
      await d.registry.driverFor(dev).setInput(dev, String(req.body?.input ?? ""));
      res.json({ ok: true });
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
