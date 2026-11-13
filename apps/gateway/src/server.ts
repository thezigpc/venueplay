import { ADMIN_COOKIE, GATEWAY_PROOF_HEADER, safeEqual, signToken, STAFF_COOKIE, STAFF_LINK_TTL_MS, STAFF_TTL_MS, verifyToken, type GatewayConfig, type GatewayRoute, type Logger } from "@bargames/common";
import { GAMES_LINK_CSS, gamesLinkHtml, HEADERS, PATHS, themeToCss, type VenueContext } from "@bargames/sdk";
import httpProxy from "http-proxy";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { checkAccess, type AccessDecision } from "./ipgate.js";
import { PinLimiter } from "./pinLimit.js";
import { closedPage, hubPage, joinWifiPage, pinPage, simplePage } from "./pages.js";

const PIN_COOKIE = "bg_pin";
export { STAFF_COOKIE };

export interface GatewayDeps {
  config: () => GatewayConfig | undefined;
  /** Auto-detected venue ranges (public IPv4 /32, IPv6 /64). */
  detectedCidrs: () => string[];
  secret: string;
  /** Sent to core (only core) so it can trust this gateway's access decision. */
  coreToken: string;
  log: Logger;
  /** Wrong-PIN limits (tests pass their own). */
  pinLimiter?: PinLimiter;
}

export function createGateway(d: GatewayDeps) {
  const proxy = httpProxy.createProxyServer({ xfwd: false, ws: true, proxyTimeout: 60_000 });
  const injecting = httpProxy.createProxyServer({ xfwd: false, selfHandleResponse: true, proxyTimeout: 60_000 });

  for (const p of [proxy, injecting]) {
    p.on("error", (err, _req, res) => {
      d.log.warn("proxy", "upstream error", { err: String(err) });
      if (res && "writeHead" in res && !res.headersSent) {
        (res as ServerResponse).writeHead(502, { "content-type": "text/html; charset=utf-8" });
        (res as ServerResponse).end(simplePage(d.config()?.venue, "Game is starting", "Give it a moment and refresh."));
      } else (res as Duplex | undefined)?.destroy?.();
    });
  }
  injecting.on("proxyReq", (proxyReq) => proxyReq.setHeader("accept-encoding", "identity"));
  // Path routing: the game's own redirects ("/admin") get its prefix back. http-proxy emits
  // proxyRes before it copies the headers, so changing them here is enough.
  proxy.on("proxyRes", (proxyRes, req) => prefixLocation(proxyRes, req));
  injecting.on("proxyRes", (proxyRes, req, res) => {
    prefixLocation(proxyRes, req);
    const type = String(proxyRes.headers["content-type"] ?? "");
    const headers = { ...proxyRes.headers };
    if (!type.includes("text/html")) {
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      return void proxyRes.pipe(res);
    }
    const chunks: Buffer[] = [];
    proxyRes.on("data", (c: Buffer) => chunks.push(c));
    proxyRes.on("end", () => {
      // Games without the SDK can't place a games link themselves: add it to their landing page.
      const landing = new URL(req.url ?? "/", "http://x").pathname === "/";
      const ctx = landing ? (req as IncomingMessage & { bgContext?: VenueContext }).bgContext : undefined;
      const html = injectTheme(Buffer.concat(chunks).toString("utf8"), ctx);
      delete headers["content-length"];
      delete headers["content-encoding"];
      res.writeHead(proxyRes.statusCode ?? 200, headers);
      res.end(html);
    });
  });

  const pins = d.pinLimiter ?? new PinLimiter();
  const pinToken = (pin: string) => createHmac("sha256", d.secret).update(`pin:${pin}`).digest("base64url");

  function decide(req: IncomingMessage, cfg: GatewayConfig, route: GatewayRoute): AccessDecision {
    const cfIp = header(req, "cf-connecting-ip");
    const decision = checkAccess(
      { cfIp, remote: req.socket.remoteAddress },
      {
        venueCidrs: [...(cfg.access.autoVenueIp ? d.detectedCidrs() : []), ...cfg.access.venueCidrs],
        whitelist: cfg.access.whitelist,
        // Open mode lets anyone play; the admin stays behind its own "from outside" switch.
        open: Boolean(cfg.access.open) && route.kind !== "admin",
      },
    );
    // The admin UI has its own login; venues can open it to the internet.
    if (!decision.allowed && route.kind === "admin" && cfg.access.adminRemote) return { allowed: true, clientIp: decision.clientIp };
    return decision;
  }

  /**
   * Valid staff cookie: signed by this box, not expired, and issued after the last "sign
   * everyone out" (a password change). Tokens carry their expiry, so issued = expiry - TTL.
   */
  const isStaff = (req: IncomingMessage) => {
    const t = verifyToken(d.coreToken, "staff", readCookie(req.headers.cookie, STAFF_COOKIE));
    return Boolean(t && t.expiresAt - STAFF_TTL_MS >= (d.config()?.staffNotBefore ?? 0));
  };
  /** One-time sign-in links already used (nonce → expiry). */
  const usedLinks = new Map<string, number>();

  /**
   * GET /__bargames/staff?t=<link>&next=/admin: core signs the link for staff signed in to
   * the box admin; this sets the staff cookie for the venue's domain and goes on to `next`.
   */
  function handleStaff(req: IncomingMessage, res: ServerResponse, cfg: GatewayConfig, url: URL, route: GatewayRoute): void {
    const now = Date.now();
    for (const [n, exp] of usedLinks) if (exp < now) usedLinks.delete(n);
    const link = verifyToken(d.coreToken, "staff-link", url.searchParams.get("t") ?? undefined, now);
    if (!link || !link.nonce || usedLinks.has(link.nonce) || link.expiresAt - STAFF_LINK_TTL_MS < (cfg.staffNotBefore ?? 0)) {
      return send(res, 403, simplePage(cfg.venue, "Link expired", "This sign-in link has expired or was already used. Open it again from the box admin."));
    }
    usedLinks.set(link.nonce, link.expiresAt);
    const cookie = signToken(d.coreToken, "staff", now + STAFF_TTL_MS, randomBytes(8).toString("base64url"));
    const domain = cfg.domain && cfg.domain !== "localhost" ? `; Domain=${cfg.domain}` : "";
    res.writeHead(303, {
      location: underPrefix(route.path, safeReturn(url.searchParams.get("next"))),
      "cache-control": "no-store",
      "set-cookie": `${STAFF_COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${STAFF_TTL_MS / 1000}${domain}${header(req, "cf-connecting-ip") ? "; Secure" : ""}`,
    });
    res.end();
    d.log.info("staff", "staff signed in to a game", { host: req.headers.host });
  }

  function pinOk(req: IncomingMessage, cfg: GatewayConfig, decision: AccessDecision, route: GatewayRoute): boolean {
    if (!cfg.access.pinEnabled || decision.reason === "local" || route.kind === "admin" || isStaff(req)) return true;
    return readCookie(req.headers.cookie, PIN_COOKIE) === pinToken(cfg.access.pin);
  }

  function prepare(req: IncomingMessage, decision: AccessDecision, route: GatewayRoute): void {
    for (const h of [...Object.values(HEADERS), GATEWAY_PROOF_HEADER, "x-forwarded-prefix"]) delete req.headers[h];
    const prefix = (req as PrefixedRequest).bgPrefix;
    if (prefix) req.headers["x-forwarded-prefix"] = prefix;
    if (route.kind === "admin") req.headers[GATEWAY_PROOF_HEADER] = d.coreToken;
    req.headers[HEADERS.via] = "1";
    // Staff: the game hears "staff", never the cookie (a game could replay it elsewhere).
    if (isStaff(req)) req.headers[HEADERS.staff] = "1";
    // Games never see the box admin's session either (it's scoped to /admin, but be sure).
    const cookies = route.kind === "admin" ? withoutCookie(req.headers.cookie, STAFF_COOKIE) : withoutCookie(withoutCookie(req.headers.cookie, STAFF_COOKIE), ADMIN_COOKIE);
    if (cookies) req.headers.cookie = cookies;
    else delete req.headers.cookie;
    if (decision.clientIp) req.headers[HEADERS.clientIp] = decision.clientIp;
    if (decision.reason) req.headers[HEADERS.access] = decision.reason;
    req.headers["x-forwarded-proto"] = header(req, "cf-connecting-ip") ? "https" : "http";
    req.headers["x-forwarded-for"] = decision.clientIp ?? "";
    req.headers["x-forwarded-host"] = req.headers.host ?? "";
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cfg = d.config();
    // The container's own health check (compose; bgctl self-update waits on it). Loopback
    // only, so it's never a public path and never shadows a game's.
    if (req.url === GATEWAY_HEALTH_PATH && isLoopback(req.socket.remoteAddress)) return send(res, cfg ? 200 : 503, JSON.stringify({ ok: Boolean(cfg) }), "application/json");
    if (!cfg) return send(res, 503, simplePage(undefined, "Starting up", "The game box is starting. Try again in a moment."));
    const route = findRoute(cfg, req) ?? consoleRoute(cfg, req);
    if (!route) return send(res, 404, simplePage(cfg.venue, "Not found", "There's nothing at this address."));
    const asked = req.url ?? "/";
    if (route.redirectTo) {
      // A game's old subdomain, after it moved to a path on the venue's hostname.
      res.writeHead(301, { location: route.redirectTo + (asked.startsWith("/") ? asked : "/"), "cache-control": "no-store" });
      return void res.end();
    }
    if (route.path) {
      const r = stripPrefix(route.path, asked);
      if (r.redirect) {
        res.writeHead(302, { location: r.redirect, "cache-control": "no-store" });
        return void res.end();
      }
      req.url = r.url;
      (req as PrefixedRequest).bgPrefix = route.path;
    }
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/internal")) return send(res, 404, simplePage(cfg.venue, "Not found", ""));

    const decision = decide(req, cfg, route);
    if (!decision.allowed) return send(res, 403, joinWifiPage(cfg.venue));

    // The announcement and countdown only: idle TV pages (a data: page, so CORS) follow it.
    // Public text, so no PIN; still behind the venue's access rules above.
    if (url.pathname === PATHS.live && req.method === "GET") {
      return held(req, res, url, () => { const v = d.config()?.venue; return v ? { announcement: v.announcement ?? null, countdown: v.countdown ?? null } : undefined; }, { "access-control-allow-origin": "*", "access-control-expose-headers": "x-bargames-etag, x-bargames-wait" });
    }

    if (url.pathname === PATHS.pin && req.method === "POST") return handlePin(req, res, cfg, decision);
    if (url.pathname === PATHS.staff && req.method === "GET" && route.kind === "game") return handleStaff(req, res, cfg, url, route);
    if (!pinOk(req, cfg, decision, route)) {
      if (req.method !== "GET") return send(res, 401, JSON.stringify({ error: "venue PIN required" }), "application/json");
      return send(res, 401, pinPage(cfg.venue, (route.path ?? "") + url.pathname + url.search));
    }

    const ctx: VenueContext | undefined = cfg.contexts[route.gameId ?? "_hub"];
    if (url.pathname === PATHS.venue && ctx) {
      // SDK 0.11.0: ?wait=<etag> is held until the context changes (or 25 s), so pages
      // hear about an announcement in seconds instead of polling.
      const key = route.gameId ?? "_hub";
      return held(req, res, url, () => d.config()?.contexts[key], {});
    }
    if (url.pathname === PATHS.themeCss && ctx) return send(res, 200, themeToCss(ctx.game.theme), "text/css");

    if (route.kind === "hub") {
      if (cfg.setupRequired) {
        if (decision.reason !== "local") return send(res, 503, simplePage(cfg.venue, "Not set up yet", "This game box hasn't been set up. Staff: open it from the venue network."));
        res.writeHead(302, { location: cfg.adminUrl, "cache-control": "no-store" });
        return void res.end();
      }
      return send(res, 200, hubPage(cfg.venue, cfg.hub.games));
    }
    if (!route.enabled) return send(res, 503, closedPage(cfg.venue, ctx?.game.displayName ?? "This game", cfg.venue.playUrl));
    if (!route.target) return send(res, 502, simplePage(cfg.venue, "Misconfigured", "No upstream for this address."));

    prepare(req, decision, route);
    if (route.injectTheme) (req as IncomingMessage & { bgContext?: VenueContext }).bgContext = ctx;
    (route.injectTheme ? injecting : proxy).web(req, res, { target: route.target });
  }

  /**
   * Answers `read()` as JSON with an etag; with ?wait=<that etag> the answer is held until
   * it changes (checked every second, as config refreshes) or 25 s pass.
   */
  async function held(req: IncomingMessage, res: ServerResponse, url: URL, read: () => unknown, headers: Record<string, string>): Promise<void> {
    const wait = url.searchParams.get("wait");
    let body = read();
    if (body === undefined) return send(res, 404, "{}", "application/json");
    if (wait && contentTag(body) === wait) {
      let gone = false;
      res.on("close", () => (gone = true));
      const until = Date.now() + 25_000;
      while (!gone && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        body = read() ?? body;
        if (contentTag(body) !== wait) break;
      }
      if (gone) return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-bargames-etag": contentTag(body), "x-bargames-wait": "1", ...headers });
    res.end(JSON.stringify(body));
  }

  async function handlePin(req: IncomingMessage, res: ServerResponse, cfg: GatewayConfig, decision: AccessDecision): Promise<void> {
    const form = new URLSearchParams(await readBody(req, 4096));
    const to = safeReturn(form.get("to"));
    const ip = decision.clientIp ?? req.socket.remoteAddress ?? "unknown";
    if (!pins.allowed(ip, decision.reason)) {
      d.log.warn("pin", "PIN entry locked for a client", { reason: decision.reason });
      return send(res, 429, pinPage(cfg.venue, to, "locked"));
    }
    if (!cfg.access.pinEnabled || !safeEqual(form.get("pin") ?? "", cfg.access.pin)) {
      if (cfg.access.pinEnabled) pins.failed(ip, decision.reason);
      return send(res, 401, pinPage(cfg.venue, to, true));
    }
    pins.succeeded(ip);
    const domain = cfg.domain && cfg.domain !== "localhost" ? `; Domain=${cfg.domain}` : "";
    res.writeHead(303, {
      location: to,
      "set-cookie": `${PIN_COOKIE}=${pinToken(cfg.access.pin)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${domain}${header(req, "cf-connecting-ip") ? "; Secure" : ""}`,
    });
    res.end();
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const cfg = d.config();
    const route = cfg && (findRoute(cfg, req) ?? consoleRoute(cfg, req));
    if (!cfg || !route || route.kind !== "game" || !route.enabled || !route.target || route.redirectTo) return void socket.destroy();
    if (route.path) {
      const r = stripPrefix(route.path, req.url ?? "/");
      if (!r.url) return void socket.destroy();
      req.url = r.url;
      (req as PrefixedRequest).bgPrefix = route.path;
    }
    const decision = decide(req, cfg, route);
    if (!decision.allowed || !pinOk(req, cfg, decision, route)) return void socket.destroy();
    prepare(req, decision, route);
    proxy.ws(req, socket, head, { target: route.target });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      d.log.error("http", "handler failed", { err: String(err) });
      if (!res.headersSent) send(res, 500, simplePage(d.config()?.venue, "Something went wrong", "Please try again."));
    });
  });
  server.on("upgrade", upgrade);
  return server;
}

/**
 * For games without the SDK (level 0): the venue theme on every page and, on the landing
 * page only (pass its context), the "← All games" link at the end of the body.
 */
export function injectTheme(html: string, landingCtx?: VenueContext): string {
  const tag = `<link rel="stylesheet" href="${PATHS.themeCss}" data-bargames>`;
  const i = html.search(/<\/head>/i);
  let out = i >= 0 ? html.slice(0, i) + tag + html.slice(i) : tag + html;
  const link = landingCtx ? gamesLinkHtml(landingCtx) : "";
  if (link) {
    const nav = `<style data-bargames>${GAMES_LINK_CSS}</style><nav class="bargames-games-link" aria-label="Venue games">${link}</nav>`;
    const j = out.search(/<\/body>/i);
    out = j >= 0 ? out.slice(0, j) + nav + out.slice(j) : out + nav;
  }
  return out;
}

type PrefixedRequest = IncomingMessage & { bgPrefix?: string };

/** Answered only to the gateway's own container: 200 once it has its routes from core. */
export const GATEWAY_HEALTH_PATH = "/__bargames/gateway-health";
const isLoopback = (ip: string | undefined) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

/** A short tag of a JSON body, ignoring generatedAt (it changes on every config refresh). */
export function contentTag(body: unknown): string {
  const text = JSON.stringify(body, (k, v) => (k === "generatedAt" ? undefined : v));
  return createHash("sha1").update(text).digest("base64url").slice(0, 16);
}

/** "/bingo/x?y" under "/bingo" → "/x?y"; "/bingo?y" → redirect to "/bingo/?y". */
export function stripPrefix(prefix: string, asked: string): { url?: string; redirect?: string } {
  const q = asked.indexOf("?");
  const path = q < 0 ? asked : asked.slice(0, q);
  const query = q < 0 ? "" : asked.slice(q);
  if (path === prefix) return { redirect: `${prefix}/${query}` };
  return path.startsWith(`${prefix}/`) ? { url: asked.slice(prefix.length) } : {};
}

/** A game's own path with its prefix ("/admin" → "/menu/admin"); already prefixed paths stay. */
function underPrefix(prefix: string | undefined, p: string): string {
  return !prefix || p === prefix || p.startsWith(`${prefix}/`) ? p : prefix + p;
}

/** A redirect from a path-routed game to one of its own paths gets the prefix back. */
function prefixLocation(proxyRes: IncomingMessage, req: IncomingMessage): void {
  const prefix = (req as PrefixedRequest).bgPrefix;
  const loc = proxyRes.headers.location;
  if (!prefix || typeof loc !== "string" || !loc.startsWith("/") || loc.startsWith("//")) return;
  if (loc === prefix || loc.startsWith(`${prefix}/`)) return;
  proxyRes.headers.location = prefix + loc;
}

function findRoute(cfg: GatewayConfig, req: IncomingMessage): GatewayRoute | undefined {
  const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  const path = (req.url ?? "/").split("?")[0];
  // A game under a path on this hostname first, then the hostname itself (the games list).
  return (
    cfg.routes.find((r) => r.host === host && r.path && (path === r.path || path.startsWith(`${r.path}/`))) ??
    cfg.routes.find((r) => r.host === host && !r.path)
  );
}

/**
 * Out of the box (no domain, no DNS) staff reach the box by IP or LAN name, e.g.
 * http://192.168.77.13/. Any hostname we don't serve, asked from the LAN, gets the
 * admin console: first-run setup, then login. Never via the tunnel.
 */
function consoleRoute(cfg: GatewayConfig, req: IncomingMessage): GatewayRoute | undefined {
  const admin = cfg.routes.find((r) => r.kind === "admin" && !r.redirectTo);
  if (!admin) return undefined;
  const local = checkAccess({ cfIp: header(req, "cf-connecting-ip"), remote: req.socket.remoteAddress }, { venueCidrs: [], whitelist: [] });
  if (local.reason !== "local") return undefined;
  // By IP the admin answers at the root, and at /admin too (the address staff learn).
  const p = (req.url ?? "/").split("?")[0];
  const { path: _p, redirectTo: _r, ...rest } = admin;
  return p === "/admin" || p.startsWith("/admin/") ? { ...rest, host: "", path: "/admin" } : { ...rest, host: "" };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function send(res: ServerResponse, status: number, body: string, type = "text/html"): void {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(body);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  let body = "";
  for await (const c of req) {
    body += c;
    if (body.length > max) break;
  }
  return body;
}

/** Only same-site relative paths, so the PIN form can't be used as an open redirect. */
/** The cookie header without one cookie ("" when nothing is left). */
function withoutCookie(header: string | undefined, name: string): string {
  return (header ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && c.split("=")[0] !== name)
    .join("; ");
}

function safeReturn(to: string | null): string {
  return to && to.startsWith("/") && !to.startsWith("//") ? to : "/";
}
