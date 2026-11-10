import { bearer, GATEWAY_PROOF_HEADER, safeEqual, type Logger } from "@bargames/common";
import { checkTheme, HEADERS, isHexColor, validateManifest, type GameEventInput } from "@bargames/sdk";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { ADMIN_COOKIE, AdminAuth, readCookie } from "./auth.js";
import type { CloudflareService } from "./cloudflare/service.js";
import type { EventBus } from "./events.js";
import { GameRegistry, HttpError } from "./games.js";
import { certificateWarning, checkPattern, hostFor } from "./hostnames.js";
import { fetchManifest } from "./manifestSource.js";
import type { GameRuntime } from "./runtime/types.js";
import type { AccessSettings, InstalledGame, State, VenueSettings } from "./state.js";
import { allHosts, buildContext, buildGatewayConfig, gameHost, gameTarget } from "./venue.js";

export interface AppDeps {
  state: State;
  games: GameRegistry;
  runtime: GameRuntime;
  bus: EventBus;
  auth: AdminAuth;
  cloudflare: CloudflareService;
  log: Logger;
  config: {
    gatewayToken: string;
    brokerUrl: string;
    brokerToken: string;
    internalUrl: string;
    adminDist: string;
    boxVersion: string;
  };
  fetch?: typeof fetch;
}

const h =
  (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);

export function createApp(d: AppDeps) {
  const app = express();
  const doFetch = d.fetch ?? fetch;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, version: d.config.boxVersion }));

  // ------------------------------------------------------------ internal (games, gateway)
  // Never routed publicly: the gateway refuses /internal on every hostname.

  const gameAuth = (req: Request): InstalledGame => {
    const game = d.games.byToken(bearer(req.headers.authorization));
    if (!game) throw new HttpError(401, "bad game token");
    return game;
  };

  app.post(
    "/internal/events",
    h((req, res) => {
      const game = gameAuth(req);
      const body = req.body as GameEventInput;
      if (typeof body?.type !== "string" || !/^(?:[a-z][a-z0-9_]*|x-[a-z0-9-]+)$/.test(body.type)) throw new HttpError(400, "bad event type");
      d.bus.publish({
        type: body.type,
        roomCode: typeof body.roomCode === "string" ? body.roomCode.slice(0, 32) : undefined,
        sessionKind: body.sessionKind,
        data: body.data && typeof body.data === "object" ? body.data : undefined,
        gameId: game.id,
        at: new Date().toISOString(),
      });
      res.status(204).end();
    }),
  );

  app.get(
    "/internal/venue",
    h((req, res) => {
      res.json(buildContext(d.state.venue.get(), gameAuth(req)));
    }),
  );

  app.get(
    "/internal/gateway-config",
    h((req, res) => {
      if (!safeEqual(bearer(req.headers.authorization), d.config.gatewayToken)) throw new HttpError(401, "bad gateway token");
      res.json(
        buildGatewayConfig({
          venue: d.state.venue.get(),
          access: d.state.access.get(),
          games: d.games.list(),
          coreUrl: d.config.internalUrl,
          boxVersion: d.config.boxVersion,
          setupRequired: !d.auth.isSetup(),
        }),
      );
    }),
  );

  // ------------------------------------------------------------ admin auth

  /**
   * First-run setup is only allowed from the venue LAN, so nobody can claim a fresh
   * box through the tunnel. Trusted: the gateway's "local" decision (proven with the
   * gateway token), or a direct loopback call (development, seed script).
   */
  const fromLan = (req: Request): boolean => {
    const proof = req.headers[GATEWAY_PROOF_HEADER];
    if (typeof proof === "string" && proof) return safeEqual(proof, d.config.gatewayToken) && req.headers[HEADERS.access] === "local";
    const ip = req.socket.remoteAddress ?? "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  };

  app.get("/api/auth/status", (req, res) => {
    res.json({ setup: d.auth.isSetup(), loggedIn: d.auth.check(readCookie(req.headers.cookie, ADMIN_COOKIE)), canSetup: fromLan(req) });
  });

  const login = (req: Request, res: Response) => {
    const secure = req.headers["x-forwarded-proto"] === "https";
    res.cookie(ADMIN_COOKIE, d.auth.issue(), { httpOnly: true, sameSite: "strict", secure, maxAge: 12 * 3600e3, path: "/" });
  };

  app.post(
    "/api/auth/setup",
    h(async (req, res) => {
      if (d.auth.isSetup()) throw new HttpError(409, "already set up");
      if (!fromLan(req)) throw new HttpError(403, "first-run setup is only allowed from the venue network");
      await d.auth.setPassword(String(req.body?.password ?? "")).catch((e: Error) => {
        throw new HttpError(400, e.message);
      });
      login(req, res);
      res.json({ ok: true });
    }),
  );

  app.post("/api/auth/login", (req, res) => {
    if (!d.auth.verify(String(req.body?.password ?? ""))) return void res.status(401).json({ error: "wrong password" });
    login(req, res);
    res.json({ ok: true });
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.clearCookie(ADMIN_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  app.use("/api", (req, _res, next) => {
    if (!d.auth.check(readCookie(req.headers.cookie, ADMIN_COOKIE))) return next(new HttpError(401, "login required"));
    next();
  });

  // ------------------------------------------------------------ system

  app.get(
    "/api/system",
    h(async (_req, res) => {
      const broker = await doFetch(`${d.config.brokerUrl}/health`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false);
      res.json({ version: d.config.boxVersion, runtime: d.runtime.kind, broker });
    }),
  );

  // ------------------------------------------------------------ venue

  const venueView = (v: VenueSettings) => {
    const hosts = { play: hostFor(v, v.playLabel), admin: hostFor(v, v.adminLabel) };
    const warnings = [...checkTheme(v.theme)];
    for (const host of [hosts.play, hosts.admin, ...d.games.list().map((g) => gameHost(v, g))]) {
      const w = certificateWarning(host, v.domain);
      if (w) warnings.push(w);
    }
    return { venue: v, hosts, warnings: [...new Set(warnings)] };
  };

  app.get("/api/venue", (_req, res) => res.json(venueView(d.state.venue.get())));

  app.put(
    "/api/venue",
    h(async (req, res) => {
      const cur = d.state.venue.get();
      const b = req.body as Partial<VenueSettings>;
      const next: VenueSettings = { ...cur, ...pick(b, ["name", "theme", "wifi", "domain", "hostnamePattern", "playLabel", "adminLabel", "slug", "publicScheme", "publicPort"]) };
      const problems = checkPattern(next.hostnamePattern);
      if (problems.length) throw new HttpError(400, problems.join("; "));
      if (!Object.values(next.theme?.colors ?? {}).every(isHexColor)) throw new HttpError(400, "theme colors must be hex");
      try {
        hostFor(next, "test");
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      await d.state.venue.set(next);
      res.json(venueView(next));
    }),
  );

  // ------------------------------------------------------------ access

  app.get("/api/access", (_req, res) => res.json(d.state.access.get()));

  app.put(
    "/api/access",
    h(async (req, res) => {
      const b = req.body as Partial<AccessSettings>;
      const next = { ...d.state.access.get(), ...pick(b, ["pinEnabled", "pin", "whitelist", "autoVenueIp", "venueCidrs", "adminRemote"]) };
      if (next.pinEnabled && !/^\d{4,8}$/.test(next.pin)) throw new HttpError(400, "PIN must be 4-8 digits");
      await d.state.access.set(next);
      res.json(next);
    }),
  );

  // ------------------------------------------------------------ Cloudflare (setup wizard)

  app.get("/api/cloudflare", h(async (_req, res) => res.json(await d.cloudflare.status())));

  app.post(
    "/api/cloudflare/token",
    h(async (req, res) => {
      const zones = await d.cloudflare.saveToken(String(req.body?.token ?? "")).catch(cfError);
      res.json({ zones });
    }),
  );

  app.get("/api/cloudflare/zones", h(async (_req, res) => res.json(await d.cloudflare.zones().catch(cfError))));

  /** The venue settings a connect would produce: the zone becomes the domain, https, no port. */
  const venueFor = (zoneName: string, b: { hostnamePattern?: string }): VenueSettings => {
    const next: VenueSettings = { ...d.state.venue.get(), domain: zoneName, publicScheme: "https", publicPort: undefined };
    if (b.hostnamePattern) next.hostnamePattern = b.hostnamePattern;
    const problems = checkPattern(next.hostnamePattern);
    if (problems.length) throw new HttpError(400, problems.join("; "));
    try {
      hostFor(next, "test");
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return next;
  };
  const zoneById = async (zoneId: unknown) => {
    const zone = (await d.cloudflare.zones().catch(cfError)).find((z) => z.id === zoneId);
    if (!zone) throw new HttpError(400, "pick one of your domains");
    return zone;
  };

  app.post(
    "/api/cloudflare/plan",
    h(async (req, res) => {
      const zone = await zoneById(req.body?.zoneId);
      const v = venueFor(zone.name, req.body ?? {});
      const hosts = await d.cloudflare.plan(zone.id, allHosts(v, d.games.list())).catch(cfError);
      const warnings = [...new Set(hosts.map((h) => certificateWarning(h.host, zone.name)).filter((w): w is string => Boolean(w)))];
      if (zone.status !== "active") warnings.unshift(`${zone.name} isn't active in Cloudflare yet (status: ${zone.status}). Finish changing the nameservers at your registrar first.`);
      res.json({ zone, hosts, warnings });
    }),
  );

  app.post(
    "/api/cloudflare/connect",
    h(async (req, res) => {
      const zone = await zoneById(req.body?.zoneId);
      const before = d.state.venue.get();
      await d.state.venue.set(venueFor(zone.name, req.body ?? {}));
      if (typeof req.body?.adminRemote === "boolean") await d.state.access.update((a) => void (a.adminRemote = req.body.adminRemote));
      try {
        res.json(await d.cloudflare.connect(zone.id));
      } catch (e) {
        await d.state.venue.set(before);
        cfError(e as Error);
      }
    }),
  );

  app.post("/api/cloudflare/sync", h(async (_req, res) => res.json(await d.cloudflare.sync().catch(cfError))));

  app.delete(
    "/api/cloudflare",
    h(async (_req, res) => {
      const r = await d.cloudflare.disconnect();
      // Back to LAN-only addresses.
      await d.state.venue.update((v) => Object.assign(v, { domain: "localhost", publicScheme: "http", publicPort: 7080 }));
      res.json(r);
    }),
  );

  // ------------------------------------------------------------ games

  const gameView = async (g: InstalledGame) => {
    const v = d.state.venue.get();
    const { token: _secret, ...rest } = g;
    return { ...rest, host: gameHost(v, g), context: buildContext(v, g), state: await d.runtime.state(g.id) };
  };

  app.get(
    "/api/games",
    h(async (_req, res) => res.json(await Promise.all(d.games.list().map(gameView)))),
  );

  app.post(
    "/api/games/install",
    h(async (req, res) => {
      const { url, manifest, devTarget } = req.body as { url?: string; manifest?: unknown; devTarget?: string };
      let installed;
      let warnings: string[] = [];
      if (url) {
        const fetched = await fetchManifest(url, doFetch).catch((e: Error) => {
          throw new HttpError(400, e.message);
        });
        warnings = fetched.warnings;
        installed = await d.games.install({ manifest: fetched.manifest, source: { kind: "url", ref: fetched.url }, verified: false });
      } else if (manifest) {
        const r = validateManifest(manifest);
        if (!r.ok) throw new HttpError(400, r.errors.join("; "));
        warnings = r.warnings;
        installed = await d.games.install({ manifest: r.manifest, source: { kind: "local", ref: "upload" }, verified: false, devTarget });
      } else throw new HttpError(400, "send { url } or { manifest }");
      d.log.info("games", installed.upgraded ? "upgraded" : "installed", { game: installed.game.id, version: installed.game.manifest.version });
      res.json({ game: await gameView(installed.game), upgraded: installed.upgraded, warnings });
    }),
  );

  app.patch(
    "/api/games/:id",
    h(async (req, res) => {
      const game = await d.games.patch(req.params.id, req.body ?? {});
      if (req.body?.enabled === true) await d.runtime.ensureRunning(game);
      if (req.body?.enabled === false) await d.runtime.stop(game.id);
      res.json(await gameView(game));
    }),
  );

  app.delete(
    "/api/games/:id",
    h(async (req, res) => {
      const keepData = req.query.keepData !== "false";
      await d.runtime.remove(req.params.id, { keepData });
      res.json({ removed: await d.games.remove(req.params.id) });
    }),
  );

  app.post(
    "/api/games/:id/command",
    h(async (req, res) => {
      const game = d.games.get(req.params.id);
      if (!game) throw new HttpError(404, "no such game");
      if (game.manifest.sdk.level < 3) throw new HttpError(400, `${game.id} does not accept commands (sdk level ${game.manifest.sdk.level})`);
      if (!game.manifest.commands.includes(req.body?.command)) throw new HttpError(400, `unknown command ${req.body?.command}`);
      const r = await doFetch(`${gameTarget(game)}/__bargames/command`, {
        method: "POST",
        headers: { authorization: `Bearer ${game.token}`, "content-type": "application/json" },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(5000),
      });
      res.status(r.status).json(await r.json().catch(() => ({ ok: false })));
    }),
  );

  app.get(
    "/api/games/:id/status",
    h(async (req, res) => {
      const game = d.games.get(req.params.id);
      if (!game) throw new HttpError(404, "no such game");
      if (game.manifest.sdk.level < 2) return void res.json({ rooms: [] });
      const r = await doFetch(`${gameTarget(game)}/__bargames/status`, { headers: { authorization: `Bearer ${game.token}` }, signal: AbortSignal.timeout(3000) });
      res.status(r.status).json(await r.json().catch(() => ({ rooms: [] })));
    }),
  );

  // ------------------------------------------------------------ events

  app.get("/api/events/recent", (req, res) => res.json(d.bus.latest(Number(req.query.limit) || 50, req.query.game as string | undefined)));

  app.get("/api/events/stream", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": connected\n\n");
    const off = d.bus.subscribe((evt) => res.write(`event: game\ndata: ${JSON.stringify(evt)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      off();
      clearInterval(ping);
    });
  });

  // ------------------------------------------------------------ broker (displays) passthrough

  app.all(
    "/api/broker/*",
    h(async (req, res) => {
      const sub = req.originalUrl.replace(/^\/api\/broker/, "");
      const r = await doFetch(`${d.config.brokerUrl}${sub}`, {
        method: req.method,
        headers: { authorization: `Bearer ${d.config.brokerToken}`, "content-type": "application/json" },
        body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => {
        throw new HttpError(502, "broker unreachable");
      });
      res.status(r.status).type("application/json").send(await r.text());
    }),
  );

  // ------------------------------------------------------------ admin UI (SPA)

  if (existsSync(d.config.adminDist)) {
    app.use(express.static(d.config.adminDist, { index: false }));
    app.get(/^\/(?!api\/|internal\/).*/, (_req, res) => res.sendFile(path.join(d.config.adminDist, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) d.log.error("http", "request failed", { err: String(err) });
    res.status(status).json({ error: err instanceof Error ? err.message : "error" });
  });

  return app;
}

function pick<T extends object, K extends keyof T>(obj: T | undefined, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  if (!obj) return out;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Cloudflare failures are the user's to fix (token, permissions, DNS): 400 with the message. */
function cfError(e: Error): never {
  throw e instanceof HttpError ? e : new HttpError(400, e.message);
}
