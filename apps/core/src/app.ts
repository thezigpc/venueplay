import { bearer, GATEWAY_PROOF_HEADER, safeEqual, signToken, STAFF_COOKIE, STAFF_TTL_MS, type Logger } from "@bargames/common";
import { PasswordLimiter } from "./limiter.js";
import { HostSampler } from "./systemStats.js";
import { cleanScene, cleanSchedule, closingTimeScene, dueNow, type Scene, type Schedule } from "./scenes.js";
import { cleanResult, board, Leaderboards, nightStart } from "./leaderboard.js";
import { rewardsHook } from "./rewards.js";
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
  type Countdown,
  type Announcement,
  adminPath,
  compareVersions,
  PATHS,
  isApp,
  joinUrl,
  injectBasePath,
  normalizeBasePath,
} from "@bargames/sdk";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { ADMIN_COOKIE, AdminAuth, readCookie } from "./auth.js";
import type { CloudflareService } from "./cloudflare/service.js";
import type { EventBus } from "./events.js";
import { GameRegistry, HttpError } from "./games.js";
import { certificateWarning, checkPattern, hostFor } from "./hostnames.js";
import { idleScreenUrl } from "./idleScreen.js";
import { imageState, UpdateChecker } from "./updates.js";
import { checkStartupRule, StartupRunner, type StartupRule } from "./startup.js";
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
    /** Core's data folder (reboot requests, host helper marker). */
    dataDir?: string;
    /** How long a cast from inside a game waits before answering "starting" (default 6000). */
    castAnswerMs?: number;
    /** bgctl's token (ops endpoints). Absent: they're off. */
    opsToken?: string;
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
    // A path from the game is on the game's address, prefix included (path routing).
    const u = new URL(value.startsWith("/") && !value.startsWith("//") ? joinUrl(base, value) : value, base);
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
      const base = new URL(buildContext(d.state.venue.get(), game).game.publicUrl!);
      const prefix = base.pathname.replace(/\/$/, "");
      if (u.origin !== base.origin || (prefix && !u.pathname.startsWith(`${prefix}/`))) return undefined;
      return roomFromTableUrl(game.manifest, u.pathname.slice(prefix.length) + u.search);
    } catch {
      return undefined;
    }
  };

  const gameStatusOf = async (game: InstalledGame): Promise<GameStatus | undefined> => {
    if (game.manifest.sdk.level < 2) return undefined;
    const r = await doFetch(`${gameTarget(game)}/__bargames/status`, { headers: { authorization: `Bearer ${game.token}` }, signal: AbortSignal.timeout(3000) });
    return r.ok ? ((await r.json()) as GameStatus) : undefined;
  };
  // ---------------------------------------------------------------- SDK 0.9.0 state
  const leaderboards = new Leaderboards(d.state.results, rewardsHook(d.log));
  const gameNames = () => Object.fromEntries(d.games.list().map((g) => [g.id, buildContext(d.state.venue.get(), g).game.displayName]));
  /** Everything games and pages hear about the venue right now. */
  const venueExtras = () => ({
    games: d.games.list(),
    announcement: d.state.announcement.get(),
    countdown: d.state.countdown.get(),
    leaderboards: leaderboards.tonight(gameNames(), d.state.venue.get().timezone ?? undefined),
  });
  /** Needs-attention items per source (a game id, or "_box"). In memory: sources re-send them. */
  const attention = new Map<string, { level: "info" | "warn" | "error"; message: string; actionPath?: string }[]>();

  /** The display module idle TVs show, if the venue picked one and it's on. */
  const idleModuleOf = (): InstalledGame | undefined => {
    const id = d.state.venue.get().idleModule;
    const g = id ? d.games.get(id) : undefined;
    return g && g.enabled && isApp(g.manifest) && g.manifest.routes.table ? g : undefined;
  };
  const idleContent = async () => {
    const venue = d.state.venue.get();
    const mod = idleModuleOf();
    if (mod) {
      const ctx = buildContext(venue, mod);
      return { kind: "idle" as const, title: ctx.game.displayName, url: joinUrl(ctx.game.publicUrl!, mod.manifest.routes.table!) };
    }
    const names = d.games.list().filter((g) => g.enabled).map((g) => buildContext(venue, g).game.displayName);
    return { kind: "idle" as const, title: "Idle", url: await idleScreenUrl({ venue: venueInfo(venue, venueExtras()), games: names }) };
  };
  /**
   * Re-render the idle screen on TVs already showing it (after an announcement change).
   * A menu on idle TVs shows announcements itself, so it's only reloaded when `force`d
   * (the idle choice changed, or the menu went away).
   */
  const refreshIdleTvs = async (force = false) => {
    if (!force && idleModuleOf()) return;
    const list = ((await brokerCall("GET", "/displays").catch(() => [])) as BrokerDisplay[]) ?? [];
    const content = await idleContent();
    // Box 0.12.0: the idle page follows announcements and countdowns by itself, so its address
    // usually doesn't change; a TV already on it is left alone (no stream restart, no blink).
    const ids = list.filter((x) => x.content?.kind === "idle" && x.content.url !== content.url).map((x) => x.id);
    if (ids.length) await brokerCall("POST", "/show", { displayIds: ids, content });
  };
  /**
   * A display module was turned off or removed: TVs showing it (cast on purpose or as the
   * idle screen) go to the idle screen. Call after the change, with the module's address.
   */
  const moduleGone = async (origin: string | undefined) => {
    if (!origin) return;
    const list = ((await brokerCall("GET", "/displays").catch(() => [])) as BrokerDisplay[]) ?? [];
    const ids = list.filter((x) => typeof x.content?.url === "string" && x.content.url.startsWith(`${origin}/`)).map((x) => x.id);
    if (ids.length) await brokerCall("POST", "/show", { displayIds: ids, content: await idleContent() });
  };
  const originOf = (g: InstalledGame | undefined) => {
    try {
      // The app's address without a trailing slash (its origin, or origin + path prefix).
      return g && isApp(g.manifest) ? buildContext(d.state.venue.get(), g).game.publicUrl!.replace(/\/$/, "") : undefined;
    } catch {
      return undefined;
    }
  };
  const updates = new UpdateChecker({
    games: () => d.games.list(),
    fetchManifest: (ref) => fetchManifest(ref, doFetch),
    imageState: (image) => imageState(image, doFetch),
    boxVersion: d.config.boxVersion,
    log: d.log,
  });
  app.locals.updates = updates;

  /**
   * After an upgrade of a game that's on: start it on the new image. If that fails, put the
   * previous version back (and running), so a bad release never leaves the venue without it.
   */
  const restartUpgraded = async (prev: InstalledGame | undefined, game: InstalledGame) => {
    if (!prev || !game.enabled) return;
    try {
      await d.runtime.ensureRunning(game);
    } catch (e) {
      const msg = (e as Error).message;
      d.log.error("games", "upgrade failed to start, rolling back", { game: game.id, version: game.manifest.version, err: msg });
      await d.games.install({ manifest: prev.manifest, source: prev.source, verified: prev.verified, devTarget: prev.devTarget });
      await d.runtime.ensureRunning(prev).catch(() => undefined);
      throw new HttpError(502, `${game.manifest.name} ${game.manifest.version} didn't start, so it's back on ${prev.manifest.version}: ${msg}`);
    }
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
      const url = joinUrl(ctx.game.publicUrl!, tableUrl(game.manifest, roomCode)!);
      type Results = Record<string, { ok: boolean; message?: string; needsCode?: boolean }>;
      const ids = displayIds.map(String);
      const showing = (brokerCall("POST", "/show", { displayIds: ids, content: { kind: "url", url, title: `${ctx.game.displayName} · ${roomCode}` } }) as Promise<Results>).then((results) => {
        const failed = Object.values(results).filter((r) => !r.ok).length;
        d.log.info("cast", "cast from game", { game: game.id, room: roomCode, displays: Object.keys(results).length, failed });
        return results;
      });
      // Games call this from a phone, where the game kit gives up after 8 s, but an AirPlay
      // TV can take longer to connect. Answer within 6 s: "starting" if the TVs
      // are still connecting (the cast carries on; the game's TV list shows when they're on).
      const results = await Promise.race([showing, new Promise<undefined>((r) => setTimeout(() => r(undefined), d.config.castAnswerMs ?? 6000).unref?.())]);
      if (!results) {
        showing.catch((err) => d.log.warn("cast", "cast from game failed", { game: game.id, room: roomCode, err: String(err) }));
        return void res.json({ ok: true, message: "Starting the TVs; they can take a few seconds to come on.", results: Object.fromEntries(ids.map((id) => [id, { ok: true, message: "starting" }])) });
      }
      const failed = Object.values(results).filter((r) => !r.ok).length;
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
      res.json(buildContext(d.state.venue.get(), gameAuth(req), venueExtras()));
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
          countdown: d.state.countdown.get(),
          leaderboards: venueExtras().leaderboards,
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
    // title: the venue's own name for this admin (shown on the sign-in screen too, so it's public).
    res.json({ setup: d.auth.isSetup(), loggedIn: d.auth.check(readCookie(req.headers.cookie, ADMIN_COOKIE)), canSetup: fromLan(req), title: d.state.venue.get().adminTitle || undefined });
  });

  /** The client's address: the gateway's word when it proves itself, else the socket. */
  const clientIpOf = (req: Request): string => {
    const proof = req.headers[GATEWAY_PROOF_HEADER];
    const viaGateway = typeof proof === "string" && proof && safeEqual(proof, d.config.gatewayToken);
    return (viaGateway ? String(req.headers[HEADERS.clientIp] ?? "") : "") || req.socket.remoteAddress || "unknown";
  };
  const passwords = new PasswordLimiter();

  /**
   * The venue domain for the staff cookie, when the admin is on it (admin.example.com).
   * From an IP or Tailscale address there's no shared domain: the Settings hand-off covers it.
   */
  const staffCookieDomain = (req: Request): string | undefined => {
    const domain = d.state.venue.get().domain;
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(":")[0].toLowerCase();
    return domain && domain !== "localhost" && host.endsWith(`.${domain}`) ? domain : undefined;
  };

  /** The admin's path prefix ("/admin" on the games list's hostname), from the gateway; "" at a hostname's root. */
  const adminPrefix = (req: Request) => normalizeBasePath(String(req.headers["x-forwarded-prefix"] ?? ""));

  const login = (req: Request, res: Response) => {
    const secure = req.headers["x-forwarded-proto"] === "https";
    // Under /admin the session cookie is scoped to it, so browsing games doesn't send it around.
    res.cookie(ADMIN_COOKIE, d.auth.issue(), { httpOnly: true, sameSite: "strict", secure, maxAge: 12 * 3600e3, path: `${adminPrefix(req)}/` });
    // Signed in here = signed in to every game's and app's own admin (SDK 0.7.0+): the
    // gateway checks this cookie and tells games "staff", never passing the cookie on.
    const domain = staffCookieDomain(req);
    if (domain) {
      const token = signToken(d.config.gatewayToken, "staff", Date.now() + STAFF_TTL_MS, randomBytes(8).toString("base64url"));
      res.cookie(STAFF_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, maxAge: STAFF_TTL_MS, path: "/", domain, encode: String });
    }
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
    const ip = clientIpOf(req);
    if (!passwords.allowed(ip)) return void res.status(429).json({ error: "too many wrong passwords; try again in 15 minutes" });
    if (!d.auth.verify(String(req.body?.password ?? ""))) {
      passwords.failed(ip);
      return void res.status(401).json({ error: "wrong password" });
    }
    passwords.succeeded(ip);
    login(req, res);
    res.json({ ok: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie(ADMIN_COOKIE, { path: `${adminPrefix(req)}/` });
    res.clearCookie(ADMIN_COOKIE, { path: "/" });
    const domain = staffCookieDomain(req);
    if (domain) res.clearCookie(STAFF_COOKIE, { path: "/", domain });
    res.json({ ok: true });
  });

  /**
   * SDK 0.8.0: a game/app login form accepts the box admin password too. The game sends
   * what was typed (and who typed it); the box answers yes or no, with the same limits as
   * its own login, per game + client and box-wide.
   */
  app.post(
    "/internal/venue-password",
    h(async (req, res) => {
      const game = gameAuth(req);
      const { password, clientIp } = (req.body ?? {}) as { password?: unknown; clientIp?: unknown };
      const source = `${game.id}:${typeof clientIp === "string" ? clientIp.slice(0, 64) : "?"}`;
      if (!passwords.allowed(source)) return void res.json({ ok: false, reason: "blocked" });
      const ok = typeof password === "string" && password.length > 0 && password.length <= 256 && d.auth.verify(password);
      if (!ok) {
        passwords.failed(source);
        return void res.json({ ok: false, reason: "wrong" });
      }
      passwords.succeeded(source);
      d.log.info("auth", "box password used in a game", { game: game.id, clientIp });
      res.json({ ok: true });
    }),
  );

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

  // ------------------------------------------------------------ SDK 0.9.0: media providers

  const mediaApps = () => d.games.list().filter((g) => g.enabled && g.manifest.media && g.manifest.sdk.level >= 3 && g.manifest.commands.includes("media_play"));
  const mediaApp = (id: string) => {
    const g = mediaApps().find((x) => x.id === id);
    if (!g) throw new HttpError(404, "no media app " + id);
    return g;
  };
  const mediaProviderAuth = (req: Request) => {
    const game = gameAuth(req);
    if (!game.manifest.media) throw new HttpError(403, "declare media in bargames.json to use this");
    return game;
  };

  /** Every venue TV, for media providers (not gated by "casting from games"). */
  app.get(
    "/internal/tvs",
    h(async (req, res) => {
      const game = mediaProviderAuth(req);
      const allowed = game.manifest.media!.launch;
      const list = ((await brokerCall("GET", "/displays?health=1").catch(() => [])) as { id: string; name: string; label?: string; group?: string; driver: string; health?: { online?: boolean }; launchable?: string[] }[]) ?? [];
      const tvs = await Promise.all(
        list.map(async (x) => {
          const canLaunch = (x.launchable ?? []).filter((a) => allowed.includes(a));
          const tv: Record<string, unknown> = { id: x.id, name: x.label || x.name, ...(x.group ? { group: x.group } : {}), kind: x.driver, online: Boolean(x.health?.online), canLaunch };
          if (allowed.includes("youtube") && x.health?.online && x.driver === "roku") {
            const r = (await brokerCall("GET", "/displays/" + encodeURIComponent(x.id) + "/dial/youtube").catch(() => undefined)) as { screenId?: string } | undefined;
            if (r?.screenId) tv.youtubeScreenId = r.screenId;
          }
          // SDK 0.10.4: what's on screen, from the TV itself (a YouTube link can still say
          // "connected" after the app closed). Only the provider's own apps are named.
          if (x.health?.online && x.driver === "roku") {
            const a = (await brokerCall("GET", "/displays/" + encodeURIComponent(x.id) + "/active-app").catch(() => undefined)) as { app?: string; home?: boolean; id?: string } | undefined;
            if (a?.id) tv.activeApp = a.app && allowed.includes(a.app) ? a.app : a.home ? "home" : "other";
          }
          return tv;
        }),
      );
      res.json({ tvs });
    }),
  );

  /** { displayId, app }: only an app the provider declared, on a TV it reports as its target. */
  app.post(
    "/internal/launch-app",
    h(async (req, res) => {
      const game = mediaProviderAuth(req);
      const { displayId, app: tvApp } = (req.body ?? {}) as { displayId?: unknown; app?: unknown };
      if (typeof displayId !== "string" || typeof tvApp !== "string") throw new HttpError(400, "displayId and app required");
      const refuse = (message: string) => {
        d.log.warn("media", "launch app refused", { game: game.id, display: displayId, app: tvApp, message });
        res.json({ ok: false, reason: "not-allowed", message });
      };
      if (!game.manifest.media!.launch.includes(tvApp)) return refuse(tvApp + " isn't in media.launch in bargames.json");
      await roomCache.refresh(game.id).catch(() => undefined);
      if (!roomCache.mediaTargets(game.id).some((t) => t.displayId === displayId)) return refuse("report this TV in status.media.targets first");
      const r = await brokerCall("POST", "/displays/" + encodeURIComponent(displayId) + "/launch", { app: tvApp, provider: game.id }).catch((err: Error) => ({ ok: false, reason: "error", message: err.message }));
      d.log.info("media", "launch app", { game: game.id, display: displayId, app: tvApp, ok: (r as { ok?: boolean }).ok });
      res.json(r);
    }),
  );

  /** Media apps and the TVs they play on (TVs page / Tonight page). */
  app.get("/api/media", (_req, res) => {
    res.json({
      providers: mediaApps().map((g) => ({
        gameId: g.id,
        displayName: buildContext(d.state.venue.get(), g).game.displayName,
        targets: roomCache.mediaTargets(g.id),
      })),
    });
  });
  app.get(
    "/api/media/:gameId/items",
    h(async (req, res) => {
      const r = await gameCommand(mediaApp(req.params.gameId), { command: "media_list" });
      if (!r.result.ok) throw new HttpError(502, r.result.message ?? "the app didn't answer");
      res.json({ items: ((r.result.data as { items?: unknown[] } | undefined)?.items ?? []).slice(0, 500) });
    }),
  );
  /** { displayId?, itemId }: a staff pick (takes the TV back from local control). */
  app.post(
    "/api/media/:gameId/play",
    h(async (req, res) => {
      const game = mediaApp(req.params.gameId);
      const { displayId, itemId } = (req.body ?? {}) as { displayId?: unknown; itemId?: unknown };
      if (typeof itemId !== "string" || !itemId) throw new HttpError(400, "itemId required");
      const args = { itemId, takeBack: true, ...(typeof displayId === "string" && displayId ? { displayId } : {}) };
      // Stop the box's own cast to that TV first: an AirPlay mirror (the idle screen) would
      // reconnect over the app while it opens. Put the idle screen back if the play fails.
      const onTv = typeof displayId === "string" && displayId ? displayId : undefined;
      if (onTv) await brokerCall("POST", "/displays/" + encodeURIComponent(onTv) + "/external", { app: game.manifest.media!.launch[0] ?? game.id, provider: game.id }).catch(() => undefined);
      const backToIdle = async () => {
        if (onTv) await brokerCall("POST", "/show", { displayIds: [onTv], content: await idleContent() }).catch(() => undefined);
      };
      const r = await gameCommand(game, { command: "media_play", args }).catch(async (err: unknown) => {
        await backToIdle();
        throw err;
      });
      const data = (r.result.data ?? {}) as { pending?: boolean; launched?: boolean };
      if (!r.result.ok) await backToIdle();
      if (r.result.ok) roomCache.boost(game.id);
      else void roomCache.refresh(game.id).catch(() => undefined);
      d.log.info("media", "play", { game: game.id, display: displayId, item: itemId, ok: r.result.ok, pending: data.pending });
      res.json({ ok: r.result.ok, message: r.result.message, pending: data.pending === true, launched: data.launched === true });
    }),
  );
  /** { displayId }: pause + clear on that TV, then the box's idle screen (never over local control). */
  app.post(
    "/api/media/:gameId/stop",
    h(async (req, res) => {
      const game = mediaApp(req.params.gameId);
      const displayId = (req.body ?? {}).displayId as unknown;
      if (typeof displayId !== "string" || !displayId) throw new HttpError(400, "displayId required");
      const r = await gameCommand(game, { command: "media_stop", args: { displayId } });
      const target = roomCache.mediaTargets(game.id).find((t) => t.displayId === displayId);
      if (r.result.ok && target?.state !== "local") {
        await brokerCall("POST", "/show", { displayIds: [displayId], content: await idleContent() }).catch(() => undefined);
      }
      void roomCache.refresh(game.id).catch(() => undefined);
      res.json({ ok: r.result.ok, message: r.result.message });
    }),
  );

  // ------------------------------------------------------------ SDK 0.9.0: attention

  const LEVELS = new Set(["info", "warn", "error"]);
  /** A game's needs-attention list (replaces its previous one; [] clears it). */
  app.post(
    "/internal/attention",
    h(async (req, res) => {
      const game = gameAuth(req);
      const items = Array.isArray(req.body?.items) ? (req.body.items as Record<string, unknown>[]) : [];
      const clean = items
        .filter((i) => i && LEVELS.has(String(i.level)) && typeof i.message === "string" && i.message.trim())
        .slice(0, 20)
        .map((i) => ({
          level: i.level as "info" | "warn" | "error",
          message: String(i.message).trim().slice(0, 200),
          ...(typeof i.actionPath === "string" && i.actionPath.startsWith("/") && !i.actionPath.startsWith("//") ? { actionPath: i.actionPath.slice(0, 200) } : {}),
        }));
      if (clean.length) attention.set(game.id, clean);
      else attention.delete(game.id);
      res.json({ ok: true, count: clean.length });
    }),
  );
  /** Everything that needs staff, for the Tonight page: games' items and the box's own. */
  app.get("/api/attention", (_req, res) => {
    const names = gameNames();
    const out = [...attention.entries()].flatMap(([source, items]) =>
      items.map((i) => ({ ...i, source, sourceName: source === "_box" ? "Box" : (names[source] ?? source) })),
    );
    res.json({ items: out });
  });

  /** TV health: a TV offline for more than 10 minutes becomes a box attention item. */
  const offlineSince = new Map<string, number>();
  const sweepTvHealth = async (now = Date.now()) => {
    const list = (await brokerCall("GET", "/displays?health=1").catch(() => undefined)) as { id: string; name: string; label?: string; health?: { online?: boolean } }[] | undefined;
    if (!Array.isArray(list)) return;
    const seen = new Set<string>();
    const items: { level: "warn"; message: string }[] = [];
    for (const tv of list) {
      seen.add(tv.id);
      if (tv.health?.online) {
        offlineSince.delete(tv.id);
        continue;
      }
      const since = offlineSince.get(tv.id) ?? now;
      offlineSince.set(tv.id, since);
      const mins = Math.floor((now - since) / 60_000);
      if (mins >= 10) items.push({ level: "warn", message: (tv.label || tv.name) + " has been offline for " + (mins >= 120 ? Math.floor(mins / 60) + " hours" : mins + " minutes") + "." });
    }
    for (const id of offlineSince.keys()) if (!seen.has(id)) offlineSince.delete(id);
    if (items.length) attention.set("_box", items);
    else attention.delete("_box");
  };
  const healthTimer = setInterval(() => void sweepTvHealth().catch(() => undefined), 60_000);
  healthTimer.unref();
  app.locals.sweepTvHealth = sweepTvHealth;

  // ------------------------------------------------------------ SDK 0.9.0: countdown

  let countdownTimer: ReturnType<typeof setTimeout> | undefined;
  /** Sets (or clears) the venue countdown; repaints idle TVs now and when it ends. */
  const setCountdown = async (c: Partial<Countdown>) => {
    await d.state.countdown.set(c);
    if (countdownTimer) clearTimeout(countdownTimer);
    const ms = c.endsAt ? Date.parse(c.endsAt) - Date.now() : NaN;
    if (ms > 0 && ms < 2 ** 31 - 1) {
      countdownTimer = setTimeout(() => void refreshIdleTvs().catch(() => undefined), ms + 1000);
      countdownTimer.unref?.();
    }
    void refreshIdleTvs().catch(() => undefined);
  };
  const newCountdown = (body: Record<string, unknown>, game?: InstalledGame): Countdown => {
    const label = typeof body.label === "string" ? body.label.trim().replace(/\s+/g, " ").slice(0, 60) : "";
    const minutes = Number(body.minutes);
    if (!label) throw new HttpError(400, 'label required, e.g. "Trivia starts in"');
    if (!(minutes >= 0.25 && minutes <= 180)) throw new HttpError(400, "minutes: 0.25-180");
    let joinUrl: string | undefined;
    if (game) {
      const room = typeof body.roomCode === "string" ? (roomCache.snapshot()[game.id] ?? []).find((r) => r.code === body.roomCode) : undefined;
      joinUrl = room?.joinUrl ?? buildContext(d.state.venue.get(), game).game.publicUrl;
    }
    return { id: Date.now().toString(36), label, endsAt: new Date(Date.now() + minutes * 60_000).toISOString(), ...(game ? { gameId: game.id } : {}), ...(joinUrl ? { joinUrl } : {}) };
  };
  app.post(
    "/internal/countdown",
    h(async (req, res) => {
      const game = gameAuth(req);
      const c = newCountdown(req.body ?? {}, game);
      await setCountdown(c);
      d.log.info("countdown", "started by a game", { game: game.id, label: c.label, endsAt: c.endsAt });
      res.json(c);
    }),
  );
  app.delete(
    "/internal/countdown",
    h(async (req, res) => {
      const game = gameAuth(req);
      if (d.state.countdown.get().gameId === game.id) await setCountdown({});
      res.json({ ok: true });
    }),
  );
  app.get("/api/countdown", (_req, res) => {
    const c = d.state.countdown.get();
    res.json(c.endsAt && Date.parse(c.endsAt) > Date.now() ? c : null);
  });
  /** Staff: { label, minutes, gameId? }. */
  app.put(
    "/api/countdown",
    h(async (req, res) => {
      const gameId = typeof req.body?.gameId === "string" ? req.body.gameId : undefined;
      const game = gameId ? d.games.get(gameId) : undefined;
      if (gameId && !game) throw new HttpError(404, "no such game");
      const c = newCountdown(req.body ?? {}, game);
      await setCountdown(c);
      res.json(c);
    }),
  );
  app.delete(
    "/api/countdown",
    h(async (_req, res) => {
      await setCountdown({});
      res.json({ ok: true });
    }),
  );

  // ------------------------------------------------------------ SDK 0.9.0: results and leaderboards

  app.post(
    "/internal/results",
    h(async (req, res) => {
      const game = gameAuth(req);
      const r = cleanResult(req.body);
      if (typeof r === "string") throw new HttpError(400, r);
      await leaderboards.record(game.id, r);
      res.json({ ok: true });
    }),
  );
  /** Tonight and all time, per game (top 10). */
  app.get("/api/leaderboards", (_req, res) => {
    const names = gameNames();
    const since = nightStart(new Date(), d.state.venue.get().timezone ?? undefined);
    const ids = [...new Set(leaderboards.entries().map((e) => e.gameId))];
    res.json({
      tonightSince: since.toISOString(),
      games: ids.map((id) => ({
        gameId: id,
        displayName: names[id] ?? id,
        tonight: board(leaderboards.entries(id, since)).slice(0, 10),
        allTime: board(leaderboards.entries(id)).slice(0, 10),
      })),
    });
  });
  app.delete(
    "/api/leaderboards",
    h(async (req, res) => {
      await leaderboards.reset(typeof req.query.gameId === "string" ? req.query.gameId : undefined);
      res.json({ ok: true });
    }),
  );

  /** STUB (planned): player profiles. */
  app.all(/^\/internal\/profiles(\/.*)?$/, (_req, res) => res.status(501).json({ error: "player profiles aren't built yet" }));

  // ------------------------------------------------------------ SDK 0.9.0: scenes and schedules

  const displayIds = async () => (((await brokerCall("GET", "/displays").catch(() => [])) as { id: string }[]) ?? []).map((x) => x.id);

  /** Applies a scene: end rooms, announcement, countdown, then each TV. Returns what happened per step. */
  const applyScene = async (scene: Scene) => {
    const steps: { step: string; ok: boolean; message?: string }[] = [];
    if (scene.endRooms) {
      for (const g of d.games.list().filter((x) => x.enabled && x.manifest.sdk.level >= 3 && x.manifest.commands.includes("end"))) {
        const st = await gameStatusOf(g).catch(() => undefined);
        for (const room of st?.rooms ?? []) {
          const r = await gameCommand(g, { command: "end", roomCode: room.code, args: { reason: scene.announcement?.text ?? "The venue closed this room." } }).catch((err: Error) => ({ result: { ok: false, message: err.message } }));
          steps.push({ step: `end ${g.id} ${room.code}`, ok: r.result.ok, message: r.result.message });
        }
      }
    }
    if (scene.announcement) {
      await postAnnouncement(scene.announcement.text, scene.announcement.minutes);
      steps.push({ step: "announcement", ok: true });
    }
    if (scene.countdown) {
      await setCountdown(newCountdown(scene.countdown));
      steps.push({ step: "countdown", ok: true });
    }
    const idle = scene.actions.some((a) => a.do === "idle") ? await idleContent() : undefined;
    for (const a of scene.actions) {
      try {
        if (a.do === "game") {
          const r = await castGame(a.gameId, { displayIds: [a.displayId] }, { firstJoinerHosts: true });
          const res = r.results[a.displayId];
          steps.push({ step: `${a.displayId}: ${a.gameId}`, ok: res?.ok !== false, message: res?.message });
        } else if (a.do === "media") {
          const r = await gameCommand(mediaApp(a.gameId), { command: "media_play", args: { displayId: a.displayId, itemId: a.itemId, takeBack: true } });
          if (r.result.ok) roomCache.boost(a.gameId);
          steps.push({ step: `${a.displayId}: ${a.gameId} list`, ok: r.result.ok, message: r.result.message });
        } else {
          const res = ((await brokerCall("POST", "/show", { displayIds: [a.displayId], content: a.do === "idle" ? idle : { kind: "off" } })) as Record<string, { ok: boolean; message?: string }>)[a.displayId];
          steps.push({ step: `${a.displayId}: ${a.do}`, ok: res?.ok !== false, message: res?.message });
        }
      } catch (err) {
        steps.push({ step: `${a.displayId}: ${a.do}`, ok: false, message: (err as Error).message });
      }
    }
    d.log.info("scenes", "applied", { scene: scene.id, steps: steps.length, failed: steps.filter((s) => !s.ok).length });
    return steps;
  };

  app.get(
    "/api/scenes",
    h(async (_req, res) => res.json({ scenes: d.state.scenes.get().scenes, presets: [closingTimeScene(await displayIds())] })),
  );
  app.put(
    "/api/scenes/:id",
    h(async (req, res) => {
      const ids = new Set(await displayIds());
      const scene = cleanScene({ ...(req.body ?? {}), id: req.params.id }, { game: (id) => Boolean(d.games.get(id)), display: (id) => ids.has(id) });
      if (typeof scene === "string") throw new HttpError(400, scene);
      await d.state.scenes.update((s) => {
        s.scenes = [...s.scenes.filter((x) => x.id !== scene.id), scene];
      });
      res.json(scene);
    }),
  );
  app.delete(
    "/api/scenes/:id",
    h(async (req, res) => {
      await d.state.scenes.update((s) => {
        s.scenes = s.scenes.filter((x) => x.id !== req.params.id);
      });
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/scenes/:id/apply",
    h(async (req, res) => {
      const scene = d.state.scenes.get().scenes.find((x) => x.id === req.params.id);
      if (!scene) throw new HttpError(404, "no such scene");
      res.json({ steps: await applyScene(scene) });
    }),
  );

  app.get("/api/schedules", (_req, res) => res.json({ schedules: d.state.schedules.get().schedules }));
  app.put(
    "/api/schedules/:id",
    h(async (req, res) => {
      const sch = cleanSchedule({ ...(req.body ?? {}), id: req.params.id }, { game: (id) => Boolean(d.games.get(id)), scene: (id) => d.state.scenes.get().scenes.some((s) => s.id === id) });
      if (typeof sch === "string") throw new HttpError(400, sch);
      await d.state.schedules.update((s) => {
        s.schedules = [...s.schedules.filter((x) => x.id !== sch.id), sch];
      });
      res.json(sch);
    }),
  );
  app.delete(
    "/api/schedules/:id",
    h(async (req, res) => {
      await d.state.schedules.update((s) => {
        s.schedules = s.schedules.filter((x) => x.id !== req.params.id);
      });
      res.json({ ok: true });
    }),
  );

  /** Runs due schedules (venue time). Exposed for tests as app.locals.runSchedules(now). */
  const runSchedules = async (now = new Date()) => {
    const { schedules, fired } = d.state.schedules.get();
    const tz = d.state.venue.get().timezone ?? undefined;
    const due = dueNow(schedules, now, tz, fired);
    if (!due.start.length && !due.countdown.length) return;
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz ?? "UTC" }).format(now);
    const mark: Record<string, string> = {};
    for (const s of due.countdown) {
      mark[`${s.id}|countdown`] = date;
      const game = s.gameId ? d.games.get(s.gameId) : undefined;
      if (!game?.enabled) continue;
      const label = `${s.title ?? buildContext(d.state.venue.get(), game).game.displayName} starts in`;
      await setCountdown(newCountdown({ label, minutes: s.countdownMinutes }, game)).catch(() => undefined);
    }
    for (const s of due.start) {
      mark[`${s.id}|start`] = date;
      try {
        if (s.kind === "scene") {
          const scene = d.state.scenes.get().scenes.find((x) => x.id === s.sceneId);
          if (scene) await applyScene(scene);
        } else if (s.gameId) {
          const target = s.displayIds?.length ? { displayIds: s.displayIds } : { group: s.group };
          await castGame(s.gameId, target, { title: s.title, firstJoinerHosts: true });
        }
        d.log.info("schedules", "started", { schedule: s.id, kind: s.kind });
      } catch (err) {
        d.log.warn("schedules", "failed", { schedule: s.id, err: (err as Error).message });
      }
    }
    await d.state.schedules.update((st) => {
      st.fired = { ...st.fired, ...mark };
    });
  };
  const scheduleTimer = setInterval(() => void runSchedules().catch(() => undefined), 20_000);
  scheduleTimer.unref();
  app.locals.runSchedules = runSchedules;

  // ------------------------------------------------------------ system stats and reboot

  const sampler = new HostSampler({ diskPath: d.config.dataDir });
  const coreStarted = Date.now();
  /** The host helper (deploy/host/install.sh) leaves this marker; without it the box can't reboot itself. */
  const hostHooks = (): { reboot?: boolean; update?: boolean; installedAt?: string } => {
    if (!d.config.dataDir) return {};
    try {
      return JSON.parse(readFileSync(path.join(d.config.dataDir, "host-hooks.json"), "utf8"));
    } catch {
      return {};
    }
  };
  const rebootFile = () => (d.config.dataDir ? path.join(d.config.dataDir, "reboot.request") : undefined);
  const dataFile = (name: string) => (d.config.dataDir ? path.join(d.config.dataDir, name) : undefined);
  const readText = (name: string) => {
    const f = dataFile(name);
    try {
      return f ? readFileSync(f, "utf8") : undefined;
    } catch {
      return undefined;
    }
  };

  /** The latest released box version (repo VERSION on main), checked at most hourly. */
  let latestCache: { at: number; version?: string } = { at: 0 };
  const latestVersion = async (): Promise<string | undefined> => {
    if (Date.now() - latestCache.at < 3600_000) return latestCache.version;
    latestCache = { at: Date.now(), version: latestCache.version };
    const repo = process.env.BARGAMES_REPO ?? "thezigpc/venueplay";
    const tries = [
      () => doFetch(`https://api.github.com/repos/${repo}/contents/VERSION?ref=main`, { headers: { accept: "application/vnd.github.raw+json", "user-agent": "bargames-box" }, signal: AbortSignal.timeout(8000) }),
      () => doFetch(`https://raw.githubusercontent.com/${repo}/main/VERSION`, { signal: AbortSignal.timeout(8000) }),
    ];
    for (const t of tries) {
      try {
        const r = await t();
        const v = r.ok ? (await r.text()).trim() : "";
        if (/^\d+\.\d+\.\d+$/.test(v)) return (latestCache = { at: Date.now(), version: v }).version;
      } catch {
        /* next */
      }
    }
    return latestCache.version;
  };
  const updateStatus = () => {
    const running = Boolean(readText("update.request") !== undefined || readText("update.state") !== undefined);
    const exit = readText("update.exit")?.trim();
    const log = readText("update.log");
    return {
      available: Boolean(hostHooks().update),
      running,
      ...(exit !== undefined ? { lastExit: Number(exit) } : {}),
      ...(log ? { logTail: log.split("\n").filter(Boolean).slice(-12) } : {}),
    };
  };

  app.get(
    "/api/system/stats",
    h(async (_req, res) => {
      const [containers, broker] = await Promise.all([
        d.runtime.containerStats?.().catch(() => undefined),
        brokerCall("GET", "/system").catch(() => undefined) as Promise<{ network?: unknown; casting?: unknown } | undefined>,
      ]);
      const rooms = Object.values(roomCache.snapshot()).reduce((n, r) => n + r.length, 0);
      const pending = rebootFile();
      res.json({
        at: new Date().toISOString(),
        host: sampler.read(),
        containers,
        network: broker?.network,
        casting: broker?.casting,
        box: { version: d.config.boxVersion, latest: await latestVersion(), coreUptimeSec: Math.round((Date.now() - coreStarted) / 1000), games: d.games.list().filter((g) => g.enabled).length, openRooms: rooms },
        update: updateStatus(),
        reboot: { available: Boolean(hostHooks().reboot), pending: Boolean(pending && existsSync(pending)) },
      });
    }),
  );

  /** { version? }: updates Bar Games itself (host helper runs bgctl self-update; it snapshots and rolls back on failure). */
  app.post(
    "/api/system/update",
    h(async (req, res) => {
      const file = dataFile("update.request");
      if (!file || !hostHooks().update) throw new HttpError(409, "This box can't update itself yet: run deploy/host/install.sh on it once (sudo).");
      if (updateStatus().running) throw new HttpError(409, "An update is already running.");
      const v = typeof req.body?.version === "string" ? req.body.version.trim() : "";
      if (v && !/^\d+\.\d+\.\d+$/.test(v)) throw new HttpError(400, "version: x.y.z");
      writeFileSync(file, v);
      d.log.warn("system", "update requested from the admin", { to: v || "latest", by: clientIpOf(req) });
      res.json({ ok: true, message: "Updating. The box restarts its services; this page reconnects by itself." });
    }),
  );

  /** { confirm: "reboot" }: restarts the whole machine (host helper required). TV startup choices run after. */
  app.post(
    "/api/system/reboot",
    h(async (req, res) => {
      if ((req.body ?? {}).confirm !== "reboot") throw new HttpError(400, 'send { confirm: "reboot" }');
      const file = rebootFile();
      if (!file || !hostHooks().reboot) throw new HttpError(409, "This box can't reboot itself yet: run deploy/host/install.sh on it once (sudo).");
      writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), by: clientIpOf(req) }));
      d.log.warn("system", "reboot requested from the admin", { by: clientIpOf(req) });
      res.json({ ok: true, message: "Rebooting. The box is back in a minute or two; this page reconnects by itself." });
    }),
  );

  /**
   * STUB (planned): Tailscale from the venue's side, for the Internet page: status of the
   * operator's remote-support link, pausing it, a venue's own Tailscale plan for remote
   * Venuebox screens. Tailscale runs on the host; nothing reads it yet.
   */
  app.get("/api/tailscale", (_req, res) => res.json({ built: false }));

  // ------------------------------------------------------------ venue

  const venueView = (v: VenueSettings) => {
    const hosts = { play: hostFor(v, v.playLabel), admin: v.adminOwnHost ? hostFor(v, v.adminLabel) : `${hostFor(v, v.playLabel)}/admin` };
    const warnings = [...checkTheme(v.theme)];
    for (const host of [hosts.play, ...(v.adminOwnHost ? [hosts.admin] : []), ...d.games.list().map((g) => gameHost(v, g))]) {
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
      const next: VenueSettings = {
        ...cur,
        ...pick(b, ["name", "theme", "wifi", "domain", "hostnamePattern", "playLabel", "adminLabel", "adminOwnHost", "slug", "publicScheme", "publicPort", "location", "timezone", "units", "idleModule", "adminTitle"]),
        ...(typeof b.adminTitle === "string" ? { adminTitle: b.adminTitle.trim().replace(/\s+/g, " ").slice(0, 24) || null } : {}),
      };
      const venueProblem = checkVenueExtras(next, (id) => d.games.get(id));
      if (venueProblem) throw new HttpError(400, venueProblem);
      const problems = checkPattern(next.hostnamePattern);
      if (problems.length) throw new HttpError(400, problems.join("; "));
      if (!Object.values(next.theme?.colors ?? {}).every(isHexColor)) throw new HttpError(400, "theme colors must be hex");
      try {
        hostFor(next, "test");
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      await d.state.venue.set(next);
      if ((cur.idleModule ?? null) !== (next.idleModule ?? null)) void refreshIdleTvs(true).catch(() => undefined);
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
  const postAnnouncement = async (text: string, minutes?: number, show?: Announcement["show"], position?: Announcement["position"]) => {
    const a = {
      id: Date.now().toString(36),
      text,
      ...(minutes ? { until: new Date(Date.now() + minutes * 60_000).toISOString() } : {}),
      ...(show && show !== "everywhere" ? { show } : {}),
      ...(position === "bottom" ? { position } : {}),
    };
    await d.state.announcement.set(a);
    scheduleExpiry(a.until);
    d.log.info("announcement", "posted", { minutes: minutes ?? null });
    await refreshIdleTvs().catch(() => undefined);
    return a;
  };
  /** { text, minutes? }: shown on every game page (SDK 0.4.0), the games list and idle TVs. */
  app.put(
    "/api/announcement",
    h(async (req, res) => {
      const { text, minutes, show, position } = (req.body ?? {}) as { text?: unknown; minutes?: unknown; show?: unknown; position?: unknown };
      if (show !== undefined && !["everywhere", "phones", "tvs"].includes(String(show))) throw new HttpError(400, "show: everywhere, phones or tvs");
      if (position !== undefined && !["top", "bottom"].includes(String(position))) throw new HttpError(400, "position: top or bottom");
      const t = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
      if (!t) throw new HttpError(400, "text required");
      if (t.length > 200) throw new HttpError(400, "keep it under 200 characters");
      const mins = minutes === undefined || minutes === null || minutes === "" ? undefined : Number(minutes);
      if (mins !== undefined && !(Number.isFinite(mins) && mins > 0 && mins <= 24 * 60)) throw new HttpError(400, "minutes must be between 1 and 1440");
      res.json(await postAnnouncement(t, mins, show as Announcement["show"], position as Announcement["position"]));
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
      // An IP ("203.0.113.7", "2001:db8::1") or a range ("203.0.113.0/24"); anything else would be silently ignored.
      const range = (s: unknown) => {
        if (typeof s !== "string") return false;
        const [ip, bits, extra] = s.trim().split("/");
        const v = isIP(ip);
        return Boolean(v) && extra === undefined && (bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (v === 4 ? 32 : 128)));
      };
      const bad = [...(next.venueCidrs ?? []), ...(next.whitelist ?? []).map((w) => w?.cidr)].filter((c) => !range(c));
      if (bad.length) throw new HttpError(400, `not an IP address or range: ${bad.join(", ")}`);
      next.venueCidrs = [...new Set(next.venueCidrs.map((c) => c.trim()))];
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
      let prev: InstalledGame | undefined;
      if (url) {
        const fetched = await fetchManifest(url, doFetch).catch((e: Error) => {
          throw new HttpError(400, e.message);
        });
        warnings = fetched.warnings;
        prev = d.games.get(fetched.manifest.id);
        installed = await d.games.install({ manifest: fetched.manifest, source: { kind: "url", ref: fetched.url }, verified: false });
      } else if (manifest) {
        const r = validateManifest(manifest);
        if (!r.ok) throw new HttpError(400, r.errors.join("; "));
        warnings = r.warnings;
        prev = d.games.get(r.manifest.id);
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
      await restartUpgraded(prev, installed.game);
      d.log.info("games", installed.upgraded ? "upgraded" : "installed", { game: installed.game.id, version: installed.game.manifest.version });
      res.json({ game: await gameView(installed.game), upgraded: installed.upgraded, warnings });
    }),
  );

  /** Update checks: what the Games tab shows ("Update available: 1.1.0 → 1.2.0"). */
  app.get("/api/games/updates", (_req, res) => res.json({ lastRun: updates.lastRun, games: updates.list() }));
  app.post(
    "/api/games/updates/check",
    h(async (_req, res) => {
      await updates.checkAll();
      res.json({ lastRun: updates.lastRun, games: updates.list() });
    }),
  );

  /** Installs the newer version from where the game came from, and restarts it if it's on. */
  /** Installs the newer version from the game's source and restarts it if it's on (admin and bgctl). */
  const performUpdate = async (id: string, by: string) => {
    const prev = d.games.get(id);
    if (!prev) throw new HttpError(404, `no game "${id}" on this box`);
    if (prev.source.kind !== "url") throw new HttpError(400, "this game wasn't installed from a URL; install the new version by hand");
    const fetched = await fetchManifest(prev.source.ref, doFetch).catch((e: Error) => {
      throw new HttpError(502, e.message);
    });
    if (fetched.manifest.id !== prev.id) throw new HttpError(409, `the source now describes "${fetched.manifest.id}", not ${prev.id}`);
    if (compareVersions(fetched.manifest.version, prev.manifest.version) <= 0) throw new HttpError(409, `already on ${prev.manifest.version}`);
    const installed = await d.games.install({ manifest: fetched.manifest, source: prev.source, verified: prev.verified });
    await restartUpgraded(prev, installed.game);
    void updates.check(installed.game).catch(() => undefined);
    d.log.info("games", "updated", { game: prev.id, from: prev.manifest.version, to: fetched.manifest.version, by });
    return { game: installed.game, from: prev.manifest.version, warnings: fetched.warnings };
  };

  app.post(
    "/api/games/:id/update",
    h(async (req, res) => {
      const r = await performUpdate(req.params.id, "admin");
      res.json({ game: await gameView(r.game), from: r.from, warnings: r.warnings });
    }),
  );

  // ------------------------------------------------------------ ops (bgctl on the box host)
  // Only with the ops token, which lives in core's data folder: whoever can read it can
  // already run Docker on the box. Games can reach core but never see this token.
  const opsToken = d.config.opsToken;
  const opsAuth: RequestHandler = (req, _res, next) => {
    const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const want = Buffer.from(opsToken ?? "");
    if (!opsToken || given.length !== want.length || !timingSafeEqual(given, want)) return next(new HttpError(401, "ops token required"));
    next();
  };
  const opsRow = async (g: InstalledGame) => ({
    id: g.id,
    name: buildContext(d.state.venue.get(), g).game.displayName,
    version: g.manifest.version,
    kind: isApp(g.manifest) ? "app" : "game",
    enabled: g.enabled,
    state: await d.runtime.state(g.id).catch(() => "unknown"),
    source: g.source.kind === "url" ? g.source.ref : g.source.kind,
    update: updates.get(g.id),
  });
  app.get(
    "/internal/ops/games",
    opsAuth,
    h(async (_req, res) => res.json({ box: d.config.boxVersion, lastCheck: updates.lastRun, games: await Promise.all(d.games.list().map(opsRow)) })),
  );
  /** { gameId? }: re-check now (one game, or all). */
  app.post(
    "/internal/ops/check",
    opsAuth,
    h(async (req, res) => {
      const id = (req.body ?? {}).gameId as string | undefined;
      if (id) {
        const g = d.games.get(String(id));
        if (!g) throw new HttpError(404, `no game "${id}" on this box`);
        await updates.check(g);
      } else await updates.checkAll();
      res.json({ box: d.config.boxVersion, lastCheck: updates.lastRun, games: await Promise.all(d.games.list().map(opsRow)) });
    }),
  );
  /**
   * { url, enable? }: install a game from its repo (or upgrade it). Refuses with "image not
   * available yet" while its image can't be pulled, so bgctl can wait for a build.
   */
  app.post(
    "/internal/ops/install",
    opsAuth,
    h(async (req, res) => {
      const { url, enable } = (req.body ?? {}) as { url?: unknown; enable?: unknown };
      if (typeof url !== "string" || !url.trim()) throw new HttpError(400, "url required (the game's GitHub repo)");
      const fetched = await fetchManifest(url, doFetch).catch((e: Error) => {
        throw new HttpError(400, e.message);
      });
      const m = fetched.manifest;
      const img = await imageState(m.image, doFetch).catch(() => "unknown" as const);
      if (img === "missing" || img === "private") {
        throw new HttpError(409, `image not available yet: ${m.image} can't be downloaded (its build may still be running, or the package is private)`);
      }
      const prev = d.games.get(m.id);
      const installed = await d.games.install({ manifest: m, source: { kind: "url", ref: fetched.url }, verified: false });
      await restartUpgraded(prev, installed.game);
      let game = installed.game;
      if (enable === true && !game.enabled) {
        game = await d.games.patch(game.id, { enabled: true });
        await d.runtime.ensureRunning(game);
      }
      void updates.check(game).catch(() => undefined);
      d.log.info("games", installed.upgraded ? "upgraded" : "installed", { game: game.id, version: m.version, by: "bgctl" });
      res.json({ id: game.id, version: m.version, upgraded: installed.upgraded, enabled: game.enabled, warnings: fetched.warnings, game: await opsRow(game) });
    }),
  );

  /** Applies the TV startup choices now (bgctl startup). */
  app.post(
    "/internal/ops/startup",
    opsAuth,
    h(async (_req, res) => {
      startup.start();
      await startup.tick();
      res.json({ waiting: startup.waiting, rules: d.state.tvStartup.get() });
    }),
  );

  app.post(
    "/internal/ops/update/:id",
    opsAuth,
    h(async (req, res) => {
      const r = await performUpdate(req.params.id, "bgctl");
      res.json({ id: r.game.id, from: r.from, to: r.game.manifest.version, warnings: r.warnings, game: await opsRow(r.game) });
    }),
  );

  app.patch(
    "/api/games/:id",
    h(async (req, res) => {
      const game = await d.games.patch(req.params.id, req.body ?? {});
      if (req.body?.enabled === true) await d.runtime.ensureRunning(game);
      if (req.body?.enabled === false) {
        await tvWatch.gameGone(game.id).catch(() => undefined);
        await moduleGone(originOf(game)).catch(() => undefined);
        await d.runtime.stop(game.id);
      }
      res.json(await gameView(game));
    }),
  );

  app.delete(
    "/api/games/:id",
    h(async (req, res) => {
      const keepData = req.query.keepData !== "false";
      const origin = originOf(d.games.get(req.params.id));
      await tvWatch.gameGone(req.params.id).catch(() => undefined);
      await d.runtime.remove(req.params.id, { keepData });
      const removed = await d.games.remove(req.params.id);
      await moduleGone(origin).catch(() => undefined);
      res.json({ removed });
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
  /**
   * Puts a game's (or menu's) TV view on TVs. A game without a roomCode creates a venue
   * room first (standard "create_room"). Used by the admin and by TV startup rules.
   */
  const castGame = async (gameId: string, target: { displayIds?: string[]; group?: string }, opts: { roomCode?: string; title?: string; firstJoinerHosts?: boolean } = {}) => {
    const game = d.games.get(gameId);
    if (!game) throw new HttpError(404, "no such game");
    const ctx = buildContext(d.state.venue.get(), game);
    const name = ctx.game.displayName;
    if (!game.enabled) throw new HttpError(400, `${name} is turned off`);
    if (!game.manifest.routes.table) throw new HttpError(400, `${name} has no TV view`);
    const publicUrl = ctx.game.publicUrl!;
    type Results = Record<string, { ok: boolean; message?: string; needsCode?: boolean }>;

    // Apps (menus…): no rooms, their TV view as is.
    if (isApp(game.manifest)) {
      const url = joinUrl(publicUrl, game.manifest.routes.table);
      const results = (await brokerCall("POST", "/show", { ...target, content: { kind: "url", url, title: name } })) as Results;
      d.log.info("cast", "shown", { game: game.id, displays: Object.keys(results).length, failed: Object.values(results).filter((x) => !x.ok).length });
      return { url, results } as { url: string; results: Results; roomCode?: string; created?: boolean; hostUrl?: string };
    }

    const { roomCode, title } = opts;
    let code = typeof roomCode === "string" && roomCode.trim() ? roomCode.trim().toUpperCase() : undefined;
    let hostUrl: string | undefined;
    if (!code) {
      if (game.manifest.sdk.level < 3 || !game.manifest.commands.includes("create_room")) {
        throw new HttpError(400, `${name} can't create rooms from the box yet. Start a room on a phone and enter its code.`);
      }
      const r = await gameCommand(game, {
        command: "create_room",
        args: { kind: "venue", purpose: "display", title: typeof title === "string" ? title : undefined, ...(opts.firstJoinerHosts ? { firstJoinerHosts: true } : {}) },
      });
      const created = r.result.data as CreatedRoom | undefined;
      if (!r.result.ok || typeof created?.roomCode !== "string" || !created.roomCode) {
        throw new HttpError(502, `${name} didn't create a room: ${r.result.message ?? `HTTP ${r.status}`}`);
      }
      code = created.roomCode;
      hostUrl = absoluteHttpUrl(created.hostUrl, publicUrl);
      d.log.info("cast", "room created", { game: game.id, room: code });
    }

    const url = joinUrl(publicUrl, tableUrl(game.manifest, code)!);
    const results = (await brokerCall("POST", "/show", { ...target, content: { kind: "url", url, title: `${name} · ${code}` } })) as Results;
    d.log.info("cast", "shown", { game: game.id, room: code, displays: Object.keys(results).length, failed: Object.values(results).filter((x) => !x.ok).length });
    return { roomCode: code, created: !roomCode, hostUrl, url, results };
  };

  // ------------------------------------------------------------ per-app secret settings

  /**
   * Secret settings for a game or app (API keys, OAuth clients): set in the box admin,
   * stored owner-only in core's data folder, injected as container env at start. Values are
   * write-only here: the admin only ever sees names. Never logged.
   */
  const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
  app.get(
    "/api/games/:id/secrets",
    h(async (req, res) => {
      if (!d.games.get(req.params.id)) throw new HttpError(404, "no such game");
      const mine = d.state.appSecrets.get()[req.params.id] ?? {};
      res.json({ secrets: Object.keys(mine).sort().map((name) => ({ name, length: mine[name].length })) });
    }),
  );
  /** { value } sets it; { value: null } (or DELETE) removes it. Restarts the app if it's on. */
  const setSecret = async (id: string, name: string, value: string | null) => {
    const game = d.games.get(id);
    if (!game) throw new HttpError(404, "no such game");
    if (!SECRET_NAME.test(name) || name.startsWith("BG_") || name === "PORT") throw new HttpError(400, "name: CAPITALS_AND_UNDERSCORES, not BG_* or PORT");
    if (value !== null && (typeof value !== "string" || !value.length || value.length > 4096)) throw new HttpError(400, "value: 1-4096 characters");
    await d.state.appSecrets.update((s) => {
      const mine = { ...(s[id] ?? {}) };
      if (value === null) delete mine[name];
      else mine[name] = value;
      if (Object.keys(mine).length) s[id] = mine;
      else delete s[id];
    });
    d.log.info("games", value === null ? "secret setting removed" : "secret setting saved", { game: id, name });
    if (game.enabled) await d.runtime.ensureRunning(game);
  };
  app.put(
    "/api/games/:id/secrets/:name",
    h(async (req, res) => {
      const v = (req.body ?? {}).value as unknown;
      await setSecret(req.params.id, req.params.name, v === null ? null : (v as string));
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/games/:id/secrets/:name",
    h(async (req, res) => {
      await setSecret(req.params.id, req.params.name, null);
      res.json({ ok: true });
    }),
  );

  // ------------------------------------------------------------ staff sign-in to games

  /**
   * A one-time link that signs this admin in to a game's or app's own admin pages: the
   * gateway checks it (same secret), sets a 12-hour staff cookie for the venue's domain, and
   * games on SDK 0.7.0 trust it (bg.isStaff). { gameId, path? } → { url }.
   */
  app.get(
    "/api/staff-link",
    h(async (req, res) => {
      const game = d.games.get(String(req.query.gameId ?? ""));
      if (!game) throw new HttpError(404, "no such game");
      const raw = typeof req.query.path === "string" ? req.query.path : (adminPath(game.manifest) ?? "/");
      const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
      const base = buildContext(d.state.venue.get(), game).game.publicUrl!;
      const t = signToken(d.config.gatewayToken, "staff-link", Date.now() + 2 * 60_000, randomBytes(9).toString("base64url"));
      const url = new URL(joinUrl(base, PATHS.staff));
      url.searchParams.set("t", t);
      url.searchParams.set("next", next);
      res.json({ url: url.toString(), staffAware: compareVersions(game.manifest.sdk.version, "0.7.0") >= 0 });
    }),
  );

  // ------------------------------------------------------------ TV startup rules

  const applyStartup = async (displayId: string, rule: StartupRule) => {
    const target = { displayIds: [displayId] };
    let results: Record<string, { ok: boolean; message?: string }>;
    if (rule.mode === "game") results = (await castGame(rule.gameId, target)).results;
    else if (rule.mode === "idle") results = (await brokerCall("POST", "/show", { ...target, content: await idleContent() })) as typeof results;
    else if (rule.mode === "off") results = (await brokerCall("POST", "/show", { ...target, content: { kind: "off" } })) as typeof results;
    else if (rule.mode === "media") {
      const r = await gameCommand(mediaApp(rule.gameId), { command: "media_play", args: { displayId, itemId: rule.itemId, takeBack: true } });
      if (!r.result.ok) throw new Error(r.result.message ?? "the media app refused");
      roomCache.boost(rule.gameId);
      return;
    }
    else return;
    const r = results[displayId];
    if (r && !r.ok) throw new Error(r.message ?? "the TV didn't start");
  };
  const startup = new StartupRunner({
    rules: () => d.state.tvStartup.get(),
    displays: async () => ((await brokerCall("GET", "/displays?health=1")) as { id: string; health?: { online?: boolean } }[]).map((x) => ({ id: x.id, online: Boolean(x.health?.online) })),
    apply: applyStartup,
    log: d.log,
  });
  app.locals.startup = startup;

  app.get("/api/tv-startup", (_req, res) => res.json(d.state.tvStartup.get()));
  /** { rule } for one TV; { mode: "last" } removes its rule. */
  app.put(
    "/api/tv-startup/:displayId",
    h(async (req, res) => {
      const rule = req.body as StartupRule;
      const problem = checkStartupRule(rule, (id) => Boolean(d.games.get(id)));
      if (problem) throw new HttpError(400, problem);
      const id = req.params.displayId;
      await d.state.tvStartup.update((s) => {
        if (rule.mode === "last") delete s[id];
        else if (rule.mode === "game") s[id] = { mode: "game", gameId: rule.gameId };
        else if (rule.mode === "media") s[id] = { mode: "media", gameId: rule.gameId, itemId: rule.itemId };
        else s[id] = { mode: rule.mode };
      });
      res.json(d.state.tvStartup.get());
    }),
  );
  /** Runs the startup choices now (what a reboot would do), for trying them out. */
  app.post(
    "/api/tv-startup/run",
    h(async (_req, res) => {
      startup.start();
      res.json({ waiting: startup.waiting });
    }),
  );

  app.post(
    "/api/cast",
    h(async (req, res) => {
      const { gameId, roomCode, title, displayIds, group, firstJoinerHosts } = (req.body ?? {}) as {
        gameId?: string;
        roomCode?: string;
        title?: string;
        displayIds?: string[];
        group?: string;
        firstJoinerHosts?: boolean;
      };
      const target = Array.isArray(displayIds) && displayIds.length ? { displayIds: displayIds.map(String) } : typeof group === "string" && group ? { group } : undefined;
      if (!d.games.get(String(gameId ?? ""))) throw new HttpError(404, "no such game");
      if (!target) throw new HttpError(400, "pick the TVs (displayIds or group)");
      res.json(await castGame(String(gameId), target, { roomCode, title, firstJoinerHosts: firstJoinerHosts === true }));
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
      // JSON, or a TV preview (image/jpeg); 204 when there's no picture.
      res.status(r.status);
      if (r.status === 204) return void res.end();
      res.set("cache-control", "no-store").type(r.headers.get("content-type") ?? "application/json").send(Buffer.from(await r.arrayBuffer()));
    }),
  );

  // ------------------------------------------------------------ admin UI (SPA)

  if (existsSync(d.config.adminDist)) {
    app.use(express.static(d.config.adminDist, { index: false }));
    // The page carries its prefix ("/admin" on the games list's hostname) so its relative
    // assets and API calls resolve under it. A missing asset is a 404, never the page.
    const indexFile = path.join(d.config.adminDist, "index.html");
    app.get(/^\/(?!api\/|internal\/).*/, (req, res, next) => {
      if (req.path.startsWith("/assets/")) return next();
      res.set("cache-control", "no-cache").type("html").send(injectBasePath(readFileSync(indexFile, "utf8"), adminPrefix(req)));
    });
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

/** Venue location, time zone, units and idle module (SDK 0.5.0). Returns a problem, or undefined. */
export function checkVenueExtras(v: VenueSettings, gameOf: (id: string) => InstalledGame | undefined): string | undefined {
  const loc = v.location;
  if (loc != null) {
    if (typeof loc !== "object") return "location: { latitude, longitude, label? }";
    const { latitude, longitude, label } = loc;
    if (typeof latitude !== "number" || !(latitude >= -90 && latitude <= 90)) return "location.latitude: -90 to 90";
    if (typeof longitude !== "number" || !(longitude >= -180 && longitude <= 180)) return "location.longitude: -180 to 180";
    if (label !== undefined && (typeof label !== "string" || label.length > 60)) return "location.label: at most 60 characters";
  }
  if (v.timezone != null) {
    if (typeof v.timezone !== "string") return "timezone: an IANA name like America/New_York";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: v.timezone });
    } catch {
      return `timezone: "${v.timezone}" isn't a time zone (try America/New_York)`;
    }
  }
  if (v.units != null && v.units !== "imperial" && v.units !== "metric") return "units: imperial or metric";
  if (v.idleModule != null && v.idleModule !== "") {
    const g = gameOf(String(v.idleModule));
    if (!g || !isApp(g.manifest)) return "idleModule: pick an installed app with a TV view (a menu)";
  }
  return undefined;
}
