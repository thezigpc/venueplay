// Node-only developer tools behind the `bargames` CLI: a pretend box for testing a
// game's integration without the platform. Not exported to browsers.
//
//   mock-box: fake core (venue context + event sink) and a fake gateway in front of
//             the game (adds the x-bargames-* headers, proxies HTTP and WebSockets).
//   command / status: call the game the way the box's iPad does.
//   check:    automated conformance checks.

import { createServer, request, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { MANIFEST_FILE, validateManifest, type GameManifest } from "./manifest.js";
import { HEADERS, PATHS, PROTOCOL_VERSION, STANDARD_EVENTS, type VenueContext, type VenueTheme } from "./protocol.js";
import { DEFAULT_THEME } from "./theme.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const DEV_TOKEN = "dev-token";

/** A loud theme, so it's obvious on screen when branding is applied. */
export const TEST_THEME: VenueTheme = {
  ...DEFAULT_THEME,
  colors: { background: "#0b2a2a", surface: "#12403f", text: "#f2fffd", primary: "#ff4fa3", accent: "#ffd23f" },
  font: "Georgia, serif",
  radius: 18,
};

export function loadManifest(dirOrFile: string): GameManifest | undefined {
  const file = existsSync(dirOrFile) && !dirOrFile.endsWith(".json") ? path.join(dirOrFile, MANIFEST_FILE) : dirOrFile;
  if (!existsSync(file)) return undefined;
  const r = validateManifest(JSON.parse(readFileSync(file, "utf8")));
  return r.ok ? r.manifest : undefined;
}

export function mockContext(gameId: string, displayName: string, publicUrl: string): VenueContext {
  return {
    protocol: PROTOCOL_VERSION,
    venue: { name: "Test Venue", theme: TEST_THEME, wifi: { ssid: "TestVenueGuest" }, playUrl: "http://play.localhost" },
    game: { id: gameId, displayName, tagline: "Branded by the mock box", publicUrl, theme: TEST_THEME },
    standalone: false,
    generatedAt: new Date().toISOString(),
  };
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function readBody(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s;
}

// ---------------------------------------------------------------- mock-box

export interface MockBoxOptions {
  gameId: string;
  displayName: string;
  /** Where the game server listens, e.g. http://127.0.0.1:3002 */
  gameUrl: string;
  corePort: number;
  gatewayPort: number;
  manifest?: GameManifest;
}

export function mockBox(o: MockBoxOptions) {
  const publicUrl = `http://localhost:${o.gatewayPort}`;
  const declared = new Set(o.manifest?.events ?? []);

  // Fake core: what the SDK inside the game talks to (BG_CORE_URL).
  const core = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${DEV_TOKEN}`) {
      console.log(c.bad(`✗ core: ${req.method} ${req.url} with a wrong/missing token (expected BG_GAME_TOKEN=${DEV_TOKEN})`));
      return json(401, { error: "bad game token" });
    }
    if (req.url === "/internal/venue") return json(200, mockContext(o.gameId, o.displayName, publicUrl));
    if (req.url === "/internal/events" && req.method === "POST") {
      const evt = JSON.parse((await readBody(req)) || "{}") as { type?: string; roomCode?: string; sessionKind?: string; data?: unknown };
      const problems: string[] = [];
      if (!evt.type || !(STANDARD_EVENTS as readonly string[]).includes(evt.type) && !/^x-[a-z0-9-]+$/.test(evt.type)) problems.push("type must be a standard event or start with x-");
      if (evt.type && o.manifest && !declared.has(evt.type)) problems.push(`"${evt.type}" isn't listed in bargames.json "events"`);
      if (evt.roomCode !== undefined && typeof evt.roomCode !== "string") problems.push("roomCode must be a string");
      if (evt.sessionKind && !["venue", "patron", "private"].includes(evt.sessionKind)) problems.push("sessionKind must be venue|patron|private");
      const line = `${evt.type} ${c.dim(`room=${evt.roomCode ?? "-"} kind=${evt.sessionKind ?? "-"}`)} ${evt.data ? JSON.stringify(evt.data) : ""}`;
      console.log(problems.length ? c.bad(`✗ event ${line}\n    ${problems.join("\n    ")}`) : `${c.ok("● event")} ${line}`);
      return problems.length ? json(400, { error: problems.join("; ") }) : (res.writeHead(204), res.end());
    }
    json(404, { error: "not found" });
  });

  // Fake gateway: what a browser on the venue LAN goes through.
  const target = new URL(o.gameUrl);
  const forwardHeaders = (req: IncomingMessage): OutgoingHttpHeaders => {
    const h: OutgoingHttpHeaders = { ...req.headers };
    for (const k of Object.values(HEADERS)) delete h[k];
    delete h["cf-connecting-ip"];
    h[HEADERS.via] = "1";
    h[HEADERS.clientIp] = req.socket.remoteAddress ?? "";
    h[HEADERS.access] = "local";
    h["x-forwarded-proto"] = "http";
    h["x-forwarded-for"] = req.socket.remoteAddress ?? "";
    h["x-forwarded-host"] = req.headers.host ?? "";
    return h;
  };
  const gateway = createServer((req, res) => {
    const up = request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: forwardHeaders(req) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`mock gateway: can't reach the game at ${o.gameUrl}. Is it running?`);
    });
    req.pipe(up);
  });
  gateway.on("upgrade", (req, socket, head) => {
    const up = connect(Number(target.port || 80), target.hostname, () => {
      const h = forwardHeaders(req);
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(h).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v === undefined ? [] : [`${k}: ${v}`]))];
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });

  core.listen(o.corePort, "127.0.0.1");
  gateway.listen(o.gatewayPort);
  return { core, gateway, publicUrl };
}

// ---------------------------------------------------------------- command / status

export async function callGame(gameUrl: string, p: string, body?: unknown, token = DEV_TOKEN): Promise<{ status: number; body: unknown }> {
  const res = await fetch(new URL(p, gameUrl), {
    method: body ? "POST" : "GET",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------- check

/**
 * Conformance checks against a running game started with the mock-box env
 * (BG_CORE_URL, BG_GAME_TOKEN=dev-token). Returns false if any check failed.
 */
export async function check(manifest: GameManifest, gameUrl: string): Promise<boolean> {
  let failed = 0;
  const pass = (m: string) => console.log(`${c.ok("✓")} ${m}`);
  const fail = (m: string, hint?: string) => {
    failed++;
    console.log(`${c.bad("✗")} ${m}${hint ? `\n    ${c.dim(hint)}` : ""}`);
  };
  const warn = (m: string) => console.log(`${c.warn("!")} ${m}`);
  const level = manifest.sdk.level;
  console.log(c.b(`${manifest.id}@${manifest.version} · level ${level} · ${gameUrl}`));

  const health = await callGame(gameUrl, manifest.health, undefined, "").catch((e: Error) => ({ status: 0, body: e.message }));
  if (health.status === 0) {
    fail(`game not reachable at ${gameUrl}`, `start it with the env printed by "bargames mock-box"`);
    return false;
  }
  health.status === 200 ? pass(`health ${manifest.health} → 200`) : fail(`health ${manifest.health} → ${health.status}`, "the box restarts games whose health check fails");

  if (level >= 1) {
    const v = await callGame(gameUrl, PATHS.venue, undefined, "");
    const ctx = v.body as VenueContext;
    if (v.status !== 200 || typeof ctx !== "object") fail(`${PATHS.venue} → ${v.status}`, "mount bg.middleware() before your routes (and before any SPA catch-all)");
    else if (ctx.standalone) fail(`${PATHS.venue} says standalone`, "start the game with BG_CORE_URL / BG_GAME_TOKEN from mock-box");
    else if (ctx.game.displayName.includes("(mock)")) pass(`${PATHS.venue} returns the box's branding ("${ctx.game.displayName}")`);
    else warn(`${PATHS.venue} returned "${ctx.game.displayName}" (expected the mock's name; is BG_CORE_URL pointing at mock-box?)`);
    const css = await callGame(gameUrl, PATHS.themeCss, undefined, "");
    css.status === 200 && String(css.body).includes("--venue-bg") ? pass(`${PATHS.themeCss} served`) : fail(`${PATHS.themeCss} → ${css.status}`);
  }

  if (level >= 2 && manifest.events.length === 0) warn(`level ${level} but "events" is empty in bargames.json`);

  if (level >= 3) {
    const anon = await callGame(gameUrl, PATHS.status, undefined, "");
    anon.status === 401 ? pass("status refuses requests without the game token") : fail(`status without token → ${anon.status} (must be 401)`);
    const st = await callGame(gameUrl, PATHS.status);
    const rooms = (st.body as { rooms?: unknown })?.rooms;
    if (st.status === 200 && Array.isArray(rooms)) {
      pass(`status → ${rooms.length} room(s)`);
      for (const r of rooms as Record<string, unknown>[]) {
        if (typeof r.code !== "string" || typeof r.players !== "number" || !["venue", "patron", "private"].includes(String(r.kind))) {
          fail(`room summary ${JSON.stringify(r)} needs code (string), kind (venue|patron|private), players (number)`);
          break;
        }
      }
    } else fail(`status → ${st.status}`, "call bg.setStatusProvider(() => ({ rooms: [...] }))");
    const bogus = await callGame(gameUrl, PATHS.command, { command: "definitely-not-a-command" });
    bogus.status === 404 ? pass("unknown commands are rejected") : fail(`unknown command → ${bogus.status} (expected 404)`);
    if (!manifest.commands.length) fail("level 3 needs at least one command in bargames.json");
    for (const cmd of manifest.commands) {
      const r = await callGame(gameUrl, PATHS.command, { command: cmd, roomCode: "ZZZZ-NO-SUCH-ROOM" });
      const ok = r.status === 200 && (r.body as { ok?: boolean })?.ok === false;
      ok ? pass(`command "${cmd}" is wired (and refuses a missing room)`) : fail(`command "${cmd}" → ${r.status} ${JSON.stringify(r.body)}`, `bg.onCommand("${cmd}", …) must return { ok: false, message } for an unknown room`);
    }
  }

  console.log(failed ? c.bad(`\n${failed} check(s) failed`) : c.ok("\nall checks passed"));
  return failed === 0;
}
