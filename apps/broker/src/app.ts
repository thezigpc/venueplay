import { bearer, safeEqual, type Logger } from "@bargames/common";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { RokuDriver } from "./drivers/roku/index.js";
import type { DisplayRegistry } from "./registry.js";
import type { DeliveryMethod, DisplayContent } from "./types.js";

const h =
  (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);

/** Broker API. Only core calls it (bearer token); it never faces players. */
export function createBrokerApp(d: { registry: DisplayRegistry; roku?: RokuDriver; token: string; log: Logger }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    if (!safeEqual(bearer(req.headers.authorization), d.token)) return void res.status(401).json({ error: "unauthorized" });
    next();
  });

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

  app.patch(
    "/displays/:id",
    h(async (req, res) => {
      const { label, group, delivery } = req.body ?? {};
      res.json(await d.registry.patch(req.params.id, { label, group, delivery: delivery as DeliveryMethod | undefined }));
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
