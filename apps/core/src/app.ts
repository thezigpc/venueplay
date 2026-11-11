import { bearer, GATEWAY_PROOF_HEADER, safeEqual, type Logger } from "@bargames/common";
import {
  checkTheme,
  HEADERS,
  isHexColor,
  roomFromTableUrl,
  tableUrl,
  validateManifest,
  type CastDisplay,
  type CastTargets,
  type CommandRequest,
  type CommandResult,
  type CreatedRoom,
  type GameEventInput,
  type GameStatus,
} from "@bargames/sdk";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { ADMIN_COOKIE, AdminAuth, readCookie } from "./auth.js";
import type { CloudflareService } from "./cloudflare/service.js";
import type { EventBus } from "./events.js";
import { GameRegistry, HttpError } from "./games.js";
import { certificateWarning, checkPattern, hostFor } from "./hostnames.js";
import { idleScreenUrl } from "./idleScreen.js";
import { fetchManifest } from "./manifestSource.js";
import { RoomCache } from "./roomCache.js";
import { TvWatch } from "./tvWatch.js";
import type { GameRuntime } from "./runtime/types.js";
import type { AccessSettings, CastSettings, InstalledGame, State, VenueSettings } from "./state.js";
import { allHosts, buildContext, buildGatewayConfig, gameHost, gameTarget, liveAnnouncement, venueInfo } from "./venue.js";

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

/** A game-supplied path or URL made absolute on its public origin; only http(s). */
function absoluteHttpUrl(value: unknown, base: string): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const u = new URL(value, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

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
      if (["room_created", "room_closed", "players_changed", "round_started", "round_ended"].includes(body.type)) roomCache.touched(game.id);
      if (body.type === "room_closed" && typeof body.roomCode === "string") {
        void tvWatch.roomClosed(game.id, body.roomCode).catch((err) => d.log.warn("tvwatch", "room_closed handling failed", { err: String(err) }));
      }
      res.status(204).end();
    }),
  );

  // ---- casting from inside a game (bg.displays / bg.cast / bg.stopCast)

  /** A broker display; games only ever see the CastDisplay subset. */
  interface BrokerDisplay {
    id: string;
    name: string;
    label?: string;
    group?: string;
    content?: { kind: string; url?: string };
  }
  const castFailures = new Map<string, { n: number; until: number }>();
  const castGate = (game: InstalledGame, pin: unknown) => {
    const s = d.state.cast.get();
    if (!s.fromGames) throw new HttpError(403, "This venue doesn't allow casting from games.");
    if (!game.enabled) throw new HttpError(403, "This game is turned off.");
    if (!s.pin) return;
    const f = castFailures.get(game.id);
    if (f && f.n >= 5 && Date.now() < f.until) throw new HttpError(429, "Too many wrong TV PINs. Try again in a minute.");
    if (typeof pin !== "string" || !safeEqual(pin, s.pin)) {
      const n = f && Date.now() < f.until ? f.n + 1 : 1;
      castFailures.set(game.id, { n, until: Date.now() + 60_000 });
      throw new HttpError(403, "Wrong TV PIN.");
    }
    castFailures.delete(game.id);
  };
  /** The room a display shows for this game, or undefined when it shows something else. */
  const roomOf = (game: InstalledGame, url?: string): string | undefined => {
    if (!url) return undefined;
    try {
      const u = new URL(url);
      if (u.origin !== new URL(buildContext(d.state.venue.get(), game).game.publicUrl!).origin) return undefined;
      return roomFromTableUrl(game.manifest, u.pathname + u.search);
    } catch {
      return undefined;
    }
  };

  const gameStatusOf = async (game: InstalledGame): Promise<GameStatus | undefined> => {
    if (game.manifest.sdk.level < 2) return undefined;
    const r = await doFetch(`${gameTarget(game)}/__bargames/status`, { headers: { authorization: `Bearer ${game.token}` }, signal: AbortSignal.timeout(3000) });
    return r.ok ? ((await r.json()) as GameStatus) : undefined;
  };
  const idleContent = async () => {
    const venue = d.state.venue.get();
    const names = d.games.list().filter((g) => g.enabled).map((g) => buildContext(venue, g).game.displayName);
    return { kind: "idle" as const, title: "Idle", url: await idleScreenUrl({ venue: venueInfo(venue, { announcement: d.state.announcement.get() }), games: names }) };
  };
  /** Re-render the idle screen on TVs already showing it (after an announcement change). */
  const refreshIdleTvs = async () => {
    const list = ((await brokerCall("GET", "/displays").catch(() => [])) as BrokerDisplay[]) ?? [];
    const ids = list.filter((x) => x.content?.kind === "idle").map((x) => x.id);
    if (ids.length) await brokerCall("POST", "/show", { displayIds: ids, content: await idleContent() });
  };
  const roomCache = new RoomCache({
    games: () => d.games.list(),
    status: gameStatusOf,
    publicUrl: (g) => buildContext(d.state.venue.get(), g).game.publicUrl,
    log: d.log,
  });
  const tvWatch = new TvWatch({
    games: () => d.games.list(),
    roomOf,
    status: gameStatusOf,
    displays: async () => (await brokerCall("GET", "/displays")) as BrokerDisplay[],
    show: (displayIds, content) => brokerCall("POST", "/show", { displayIds, content }),
    idle: idleContent,
    log: d.log,
  });

  app.get(
    "/internal/displays",
    h(async (req, res) => {
      const game = gameAuth(req);
      const s: CastSettings = d.state.cast.get();
      if (!s.fromGames || !game.enabled) return void res.json({ enabled: false, pinRequired: false, displays: [] } satisfies CastTargets);
      const list = (await brokerCall("GET", "/displays")) as BrokerDisplay[];
      const displays: CastDisplay[] = list.map((x) => {
        const url = x.content?.kind === "url" ? x.content.url : undefined;
        const room = roomOf(game, url);
        return { id: x.id, name: x.label || x.name, group: x.group, busy: Boolean(url), showingThisGame: room !== undefined, roomCode: room };
      });
      res.json({ enabled: true, pinRequired: Boolean(s.pin), displays } satisfies CastTargets);
    }),
  );

  app.post(
    "/internal/cast",
    h(async (req, res) => {
      const game = gameAuth(req);
      const { roomCode, displayIds, pin } = (req.body ?? {}) as { roomCode?: string; displayIds?: string[]; pin?: string };
      castGate(game, pin);
      if (typeof roomCode !== "string" || !roomCode) throw new HttpError(400, "roomCode required");
      if (!Array.isArray(displayIds) || !displayIds.length) throw new HttpError(400, "pick at least one TV");
      if (!game.manifest.routes.table) throw new HttpError(400, "this game has no TV view");
      // Only rooms the game really has, so a host can't cast arbitrary pages.
      const st = await doFetch(`${gameTarget(game)}/__bargames/status`, { headers: { authorization: `Bearer ${game.token}` }, signal: AbortSignal.timeout(3000) })
        .then((r) => r.json() as Promise<GameStatus>)
        .catch(() => ({ rooms: [] }) as GameStatus);
      if (!st.rooms?.some((r) => r.code === roomCode)) throw new HttpError(404, `no room ${roomCode}`);
      const ctx = buildContext(d.state.venue.get(), game);
      const url = new URL(tableUrl(game.manifest, roomCode)!, ctx.game.publicUrl!).toString();
      const results = (await brokerCall("POST", "/show", { displayIds: displayIds.map(String), content: { kind: "url", url, title: `${ctx.game.displayName} · ${roomCode}` } })) as Record<
        string,
        { ok: boolean; message?: string; needsCode?: boolean }
      >;
      const failed = Object.values(results).filter((r) => !r.ok).length;
      d.log.info("cast", "cast from game", { game: game.id, room: roomCode, displays: Object.keys(results).length, failed });
      res.json({ ok: failed === 0, message: failed ? `${failed} TV(s) didn't start` : undefined, results });
    }),
  );

  app.post(
    "/internal/cast/stop",
    h(async (req, res) => {
      const game = gameAuth(req);
      const { displayIds, pin } = (req.body ?? {}) as { displayIds?: string[]; pin?: string };
      castGate(game, pin);
      if (!Array.isArray(displayIds) || !displayIds.length) throw new HttpError(400, "pick at least one TV");
      const list = (await brokerCall("GET", "/displays")) as BrokerDisplay[];
      const mine = list.filter((x) => displayIds.includes(x.id) && roomOf(game, x.content?.url) !== undefined).map((x) => x.id);
      const results = mine.length ? ((await brokerCall("POST", "/show", { displayIds: mine, content: { kind: "off" } })) as Record<string, { ok: boolean }>) : {};
      res.json({ ok: true, message: mine.length < displayIds.length ? "TVs showing something else were left alone" : undefined, results });
    }),
  );

  app.get(
    "/internal/venue",
    h((req, res) => {
      res.json(buildContext(d.state.venue.get(), gameAuth(req), { games: d.games.list(), announcement: d.state.announcement.get() }));
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
          announcement: d.state.announcement.get(),
          rooms: roomCache.snapshot(),
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

  // ------------------------------------------------------------ announcement

  let announcementTimer: ReturnType<typeof setTimeout> | undefined;
  /** Repaint idle TVs when a timed announcement comes down. */
  const scheduleExpiry = (until?: string) => {
    if (announcementTimer) clearTimeout(announcementTimer);
    announcementTimer = undefined;
    const ms = until ? Date.parse(until) - Date.now() : NaN;
    if (ms > 0 && ms < 2 ** 31 - 1) {
      announcementTimer = setTimeout(() => void refreshIdleTvs().catch(() => undefined), ms + 1000);
      announcementTimer.unref?.();
    }
  };
  scheduleExpiry(liveAnnouncement(d.state.announcement.get())?.until);

  app.get("/api/announcement", (_req, res) => res.json(liveAnnouncement(d.state.announcement.get()) ?? null));
  /** { text, minutes? }: shown on every game page (SDK 0.4.0), the games list and idle TVs. */
  app.put(
    "/api/announcement",
    h(async (req, res) => {
      const { text, minutes } = (req.body ?? {}) as { text?: unknown; minutes?: unknown };
      const t = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
      if (!t) throw new HttpError(400, "text required");
      if (t.length > 200) throw new HttpError(400, "keep it under 200 characters");
      const mins = minutes === undefined || minutes === null || minutes === "" ? undefined : Number(minutes);
      if (mins !== undefined && !(Number.isFinite(mins) && mins > 0 && mins <= 24 * 60)) throw new HttpError(400, "minutes must be between 1 and 1440");
      const a = { id: Date.now().toString(36), text: t, ...(mins ? { until: new Date(Date.now() + mins * 60_000).toISOString() } : {}) };
      await d.state.announcement.set(a);
      scheduleExpiry(a.until);
      d.log.info("announcement", "posted", { minutes: mins ?? null });
      await refreshIdleTvs().catch(() => undefined);
      res.json(a);
    }),
  );
  app.delete(
    "/api/announcement",
    h(async (_req, res) => {
      await d.state.announcement.set({});
      scheduleExpiry(undefined);
      await refreshIdleTvs().catch(() => undefined);
      res.json(null);
    }),
  );

  // ------------------------------------------------------------ casting settings

  app.get("/api/cast-settings", (_req, res) => res.json(d.state.cast.get()));
  app.put(
    "/api/cast-settings",
    h(async (req, res) => {
      const b = (req.body ?? {}) as Partial<CastSettings>;
      const next: CastSettings = { ...d.state.cast.get(), ...pick(b, ["fromGames", "pin"]) };
      next.fromGames = Boolean(next.fromGames);
      next.pin = String(next.pin ?? "").trim();
      if (next.pin && !/^\d{4,8}$/.test(next.pin)) throw new HttpError(400, "TV PIN must be 4-8 digits (or empty for none)");
      await d.state.cast.set(next);
      res.json(next);
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
    const next: VenueSettings = { ...d.state.venue.get(), domain: zoneName, publicScheme: "https", publicPort: null };
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

  /** Calls a game's /__bargames/command with its token. */
  async function gameCommand(game: InstalledGame, body: CommandRequest): Promise<{ status: number; result: CommandResult }> {
    const r = await doFetch(`${gameTarget(game)}/__bargames/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${game.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      throw new HttpError(502, `${game.id} isn't answering (is it running?)`);
    });
    return { status: r.status, result: (await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }))) as CommandResult };
  }

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
      const { url, manifest, devTarget, hostnameAlias } = req.body as { url?: string; manifest?: unknown; devTarget?: string; hostnameAlias?: string };
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
      // Optional subdomain chosen at install. A clash or bad label keeps the default and says why.
      if (typeof hostnameAlias === "string" && hostnameAlias.trim() && hostnameAlias.trim().toLowerCase() !== (installed.game.hostnameAlias ?? installed.game.id)) {
        try {
          installed = { ...installed, game: await d.games.patch(installed.game.id, { hostnameAlias }) };
        } catch (e) {
          warnings = [...warnings, `Subdomain not set: ${(e as Error).message}`];
        }
      }
      d.log.info("games", installed.upgraded ? "upgraded" : "installed", { game: installed.game.id, version: installed.game.manifest.version });
      res.json({ game: await gameView(installed.game), upgraded: installed.upgraded, warnings });
    }),
  );

  app.patch(
    "/api/games/:id",
    h(async (req, res) => {
      const game = await d.games.patch(req.params.id, req.body ?? {});
      if (req.body?.enabled === true) await d.runtime.ensureRunning(game);
      if (req.body?.enabled === false) {
        await tvWatch.gameGone(game.id).catch(() => undefined);
        await d.runtime.stop(game.id);
      }
      res.json(await gameView(game));
    }),
  );

  app.delete(
    "/api/games/:id",
    h(async (req, res) => {
      const keepData = req.query.keepData !== "false";
      await tvWatch.gameGone(req.params.id).catch(() => undefined);
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
      const r = await gameCommand(game, req.body);
      res.status(r.status).json(r.result);
    }),
  );

  /**
   * Puts a game's table view on TVs: { gameId, roomCode?, title?, displayIds? | group? }.
   * Without a roomCode the game creates a venue room first (standard "create_room").
   */
  app.post(
    "/api/cast",
    h(async (req, res) => {
      const { gameId, roomCode, title, displayIds, group } = (req.body ?? {}) as { gameId?: string; roomCode?: string; title?: string; displayIds?: string[]; group?: string };
      const game = d.games.get(String(gameId ?? ""));
      if (!game) throw new HttpError(404, "no such game");
      const ctx = buildContext(d.state.venue.get(), game);
      const name = ctx.game.displayName;
      if (!game.enabled) throw new HttpError(400, `${name} is turned off`);
      if (!game.manifest.routes.table) throw new HttpError(400, `${name} has no TV view`);
      const target = Array.isArray(displayIds) && displayIds.length ? { displayIds: displayIds.map(String) } : typeof group === "string" && group ? { group } : undefined;
      if (!target) throw new HttpError(400, "pick the TVs (displayIds or group)");
      const publicUrl = ctx.game.publicUrl!;

      let code = typeof roomCode === "string" && roomCode.trim() ? roomCode.trim().toUpperCase() : undefined;
      let hostUrl: string | undefined;
      if (!code) {
        if (game.manifest.sdk.level < 3 || !game.manifest.commands.includes("create_room")) {
          throw new HttpError(400, `${name} can't create rooms from the box yet. Start a room on a phone and enter its code.`);
        }
        const r = await gameCommand(game, { command: "create_room", args: { kind: "venue", purpose: "display", title: typeof title === "string" ? title : undefined } });
        const created = r.result.data as CreatedRoom | undefined;
        if (!r.result.ok || typeof created?.roomCode !== "string" || !created.roomCode) {
          throw new HttpError(502, `${name} didn't create a room: ${r.result.message ?? `HTTP ${r.status}`}`);
        }
        code = created.roomCode;
        hostUrl = absoluteHttpUrl(created.hostUrl, publicUrl);
        d.log.info("cast", "room created", { game: game.id, room: code });
      }

      const url = new URL(tableUrl(game.manifest, code)!, publicUrl).toString();
      const results = (await brokerCall("POST", "/show", { ...target, content: { kind: "url", url, title: `${name} · ${code}` } })) as Record<string, { ok: boolean; message?: string }>;
      d.log.info("cast", "shown", { game: game.id, room: code, displays: Object.keys(results).length, failed: Object.values(results).filter((x) => !x.ok).length });
      res.json({ roomCode: code, created: !roomCode, hostUrl, url, results });
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

  async function brokerCall(method: string, sub: string, body?: unknown): Promise<unknown> {
    const r = await doFetch(`${d.config.brokerUrl}${sub}`, {
      method,
      headers: { authorization: `Bearer ${d.config.brokerToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      throw new HttpError(502, "broker unreachable");
    });
    const json = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) throw new HttpError(r.status, json.error ?? `broker: HTTP ${r.status}`);
    return json;
  }

  /**
   * Bird's-eye view: every room of every game that's on, with the TVs showing it.
   * A game whose status can't be read is listed with its error instead of rooms.
   */
  app.get(
    "/api/rooms",
    h(async (_req, res) => {
      const venue = d.state.venue.get();
      const games = d.games.list().filter((g) => g.enabled && g.manifest.sdk.level >= 2);
      const displays = ((await brokerCall("GET", "/displays").catch(() => [])) as BrokerDisplay[]) ?? [];
      const out = await Promise.all(
        games.map(async (game) => {
          const ctx = buildContext(venue, game);
          const base = { id: game.id, name: ctx.game.displayName, publicUrl: ctx.game.publicUrl, commands: game.manifest.sdk.level >= 3 ? game.manifest.commands : [] };
          try {
            const st = await gameStatusOf(game);
            if (!st) return { ...base, rooms: [], error: "status unavailable" };
            const rooms = (st.rooms ?? []).map((r) => ({
              ...r,
              tvs: displays.filter((x) => x.content?.kind === "url" && roomOf(game, x.content.url) === r.code).map((x) => ({ id: x.id, name: x.label || x.name })),
            }));
            return { ...base, rooms };
          } catch (err) {
            return { ...base, rooms: [], error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      res.json({ games: out, at: new Date().toISOString() });
    }),
  );

  /** Puts TVs on the venue idle screen: { displayIds?, group? } (none: every TV). */
  app.post(
    "/api/tvs/idle",
    h(async (req, res) => {
      const { displayIds, group } = (req.body ?? {}) as { displayIds?: string[]; group?: string };
      const ids = displayIds?.length || group ? displayIds : ((await brokerCall("GET", "/displays")) as { id: string }[]).map((x) => x.id);
      res.json(await brokerCall("POST", "/show", { displayIds: ids, group, content: await idleContent() }));
    }),
  );

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

  app.locals.tvWatch = tvWatch;
  app.locals.roomCache = roomCache;
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
