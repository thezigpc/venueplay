import { GATEWAY_PROOF_HEADER, type GatewayConfig, type GatewayRoute, type Logger } from "@bargames/common";
import { HEADERS, PATHS, themeToCss, type VenueContext } from "@bargames/sdk";
import httpProxy from "http-proxy";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { checkAccess, type AccessDecision } from "./ipgate.js";
import { closedPage, hubPage, joinWifiPage, pinPage, simplePage } from "./pages.js";

const PIN_COOKIE = "bg_pin";

export interface GatewayDeps {
  config: () => GatewayConfig | undefined;
  /** Auto-detected venue ranges (public IPv4 /32, IPv6 /64). */
  detectedCidrs: () => string[];
  secret: string;
  /** Sent to core (only core) so it can trust this gateway's access decision. */
  coreToken: string;
  log: Logger;
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
  injecting.on("proxyRes", (proxyRes, _req, res) => {
    const type = String(proxyRes.headers["content-type"] ?? "");
    const headers = { ...proxyRes.headers };
    if (!type.includes("text/html")) {
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      return void proxyRes.pipe(res);
    }
    const chunks: Buffer[] = [];
    proxyRes.on("data", (c: Buffer) => chunks.push(c));
    proxyRes.on("end", () => {
      const html = injectTheme(Buffer.concat(chunks).toString("utf8"));
      delete headers["content-length"];
      delete headers["content-encoding"];
      res.writeHead(proxyRes.statusCode ?? 200, headers);
      res.end(html);
    });
  });

  const pinToken = (pin: string) => createHmac("sha256", d.secret).update(`pin:${pin}`).digest("base64url");

  function decide(req: IncomingMessage, cfg: GatewayConfig, route: GatewayRoute): AccessDecision {
    const cfIp = header(req, "cf-connecting-ip");
    const decision = checkAccess(
      { cfIp, remote: req.socket.remoteAddress },
      { venueCidrs: [...(cfg.access.autoVenueIp ? d.detectedCidrs() : []), ...cfg.access.venueCidrs], whitelist: cfg.access.whitelist },
    );
    // The admin UI has its own login; venues can open it to the internet.
    if (!decision.allowed && route.kind === "admin" && cfg.access.adminRemote) return { allowed: true, clientIp: decision.clientIp };
    return decision;
  }

  function pinOk(req: IncomingMessage, cfg: GatewayConfig, decision: AccessDecision, route: GatewayRoute): boolean {
    if (!cfg.access.pinEnabled || decision.reason === "local" || route.kind === "admin") return true;
    return readCookie(req.headers.cookie, PIN_COOKIE) === pinToken(cfg.access.pin);
  }

  function prepare(req: IncomingMessage, decision: AccessDecision, route: GatewayRoute): void {
    for (const h of [...Object.values(HEADERS), GATEWAY_PROOF_HEADER]) delete req.headers[h];
    if (route.kind === "admin") req.headers[GATEWAY_PROOF_HEADER] = d.coreToken;
    req.headers[HEADERS.via] = "1";
    if (decision.clientIp) req.headers[HEADERS.clientIp] = decision.clientIp;
    if (decision.reason) req.headers[HEADERS.access] = decision.reason;
    req.headers["x-forwarded-proto"] = header(req, "cf-connecting-ip") ? "https" : "http";
    req.headers["x-forwarded-for"] = decision.clientIp ?? "";
    req.headers["x-forwarded-host"] = req.headers.host ?? "";
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cfg = d.config();
    if (!cfg) return send(res, 503, simplePage(undefined, "Starting up", "The game box is starting. Try again in a moment."));
    const route = findRoute(cfg, req) ?? consoleRoute(cfg, req);
    if (!route) return send(res, 404, simplePage(cfg.venue, "Not found", "There's nothing at this address."));
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/internal")) return send(res, 404, simplePage(cfg.venue, "Not found", ""));

    const decision = decide(req, cfg, route);
    if (!decision.allowed) return send(res, 403, joinWifiPage(cfg.venue));

    if (url.pathname === PATHS.pin && req.method === "POST") return handlePin(req, res, cfg);
    if (!pinOk(req, cfg, decision, route)) {
      if (req.method !== "GET") return send(res, 401, JSON.stringify({ error: "venue PIN required" }), "application/json");
      return send(res, 401, pinPage(cfg.venue, url.pathname + url.search));
    }

    const ctx: VenueContext | undefined = cfg.contexts[route.gameId ?? "_hub"];
    if (url.pathname === PATHS.venue && ctx) return send(res, 200, JSON.stringify(ctx), "application/json");
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
    (route.injectTheme ? injecting : proxy).web(req, res, { target: route.target });
  }

  async function handlePin(req: IncomingMessage, res: ServerResponse, cfg: GatewayConfig): Promise<void> {
    const form = new URLSearchParams(await readBody(req, 4096));
    const to = safeReturn(form.get("to"));
    if (!cfg.access.pinEnabled || form.get("pin") !== cfg.access.pin) return send(res, 401, pinPage(cfg.venue, to, true));
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
    if (!cfg || !route || route.kind !== "game" || !route.enabled || !route.target) return void socket.destroy();
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

export function injectTheme(html: string): string {
  const tag = `<link rel="stylesheet" href="${PATHS.themeCss}" data-bargames>`;
  const i = html.search(/<\/head>/i);
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : tag + html;
}

function findRoute(cfg: GatewayConfig, req: IncomingMessage): GatewayRoute | undefined {
  const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  return cfg.routes.find((r) => r.host === host);
}

/**
 * Out of the box (no domain, no DNS) staff reach the box by IP or LAN name, e.g.
 * http://192.168.77.13/. Any hostname we don't serve, asked from the LAN, gets the
 * admin console: first-run setup, then login. Never via the tunnel.
 */
function consoleRoute(cfg: GatewayConfig, req: IncomingMessage): GatewayRoute | undefined {
  const admin = cfg.routes.find((r) => r.kind === "admin");
  if (!admin) return undefined;
  const local = checkAccess({ cfIp: header(req, "cf-connecting-ip"), remote: req.socket.remoteAddress }, { venueCidrs: [], whitelist: [] });
  return local.reason === "local" ? { ...admin, host: "" } : undefined;
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
function safeReturn(to: string | null): string {
  return to && to.startsWith("/") && !to.startsWith("//") ? to : "/";
}
