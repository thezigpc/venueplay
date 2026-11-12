// @bargames/sdk/server: what a game's Node server uses to talk to the box.
//
// Works the same on and off a box. Without BG_CORE_URL/BG_GAME_TOKEN the game is
// "standalone": venue() returns default branding, emit() is a no-op, and the
// middleware still serves /__bargames/venue.json so the client SDK works everywhere.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { standaloneContext } from "./context.js";
import {
  ENV,
  HEADERS,
  PATHS,
  type AccessReason,
  type BarGamesEvent,
  type CommandRequest,
  type CommandResult,
  type CastResult,
  type CastTargets,
  type CreateRoomArgs,
  type CreatedRoom,
  type GameEventInput,
  type GameStatus,
  type VenueContext,
} from "./protocol.js";
import { themeToCss } from "./theme.js";

export type CommandHandler = (req: CommandRequest) => CommandResult | Promise<CommandResult>;
type Next = (err?: unknown) => void;

export interface BarGamesOptions {
  /** Game id; defaults to BG_GAME_ID, then this value. */
  gameId?: string;
  /** Name used when standalone (e.g. your existing GAME_NAME). */
  defaultName?: string;
  coreUrl?: string;
  token?: string;
  /** How long venue context is cached (ms). Branding changes show up after this. */
  venueTtlMs?: number;
  fetch?: typeof fetch;
  log?: (msg: string, extra?: unknown) => void;
}

export interface GatewayInfo {
  /** Request came through the Bar Games gateway. */
  viaGateway: boolean;
  clientIp?: string;
  access?: AccessReason;
  /** Staff signed in to the box admin (SDK 0.7.0). Always false off a box. */
  staff: boolean;
}

export interface BarGames {
  readonly gameId: string;
  /** True on a box (core URL and token present). Off a box every call is a no-op. */
  readonly connected: boolean;
  venue(): Promise<VenueContext>;
  /**
   * An absolute link on the venue's address for this game, e.g. publicUrl(`/join/${code}`)
   * for a room QR. On a box it follows the venue's subdomain (also after a rename).
   * Off a box: undefined, so keep building the link the way the game always has.
   */
  publicUrl(path: string): Promise<string | undefined>;
  /** Fire-and-forget; queued and retried briefly if the box is busy. */
  emit<T extends Record<string, unknown>>(event: GameEventInput<T>): void;
  onCommand(name: string, handler: CommandHandler): void;
  /**
   * Handles the standard "create_room" command: create a room with no host phone
   * (kind "venue"), return its code (and optionally a host URL). Throw an Error to
   * refuse; its message is shown to staff. Same as onCommand("create_room", …) with
   * the result wrapped for you.
   */
  onCreateRoom(handler: (args: CreateRoomArgs) => CreatedRoom | Promise<CreatedRoom>): void;
  setStatusProvider(fn: () => GameStatus | Promise<GameStatus>): void;
  /**
   * Casting from the game: the venue TVs a host may put this game on. Off a box, or when
   * the venue hasn't allowed it, `enabled` is false: hide the casting UI.
   */
  displays(): Promise<CastTargets>;
  /**
   * Puts a room's table view on venue TVs. Only call it for a room's host (your own
   * check). The room must be listed by your status provider. `pin`: the venue's TV PIN
   * when `pinRequired`.
   */
  cast(roomCode: string, displayIds: string[], opts?: { pin?: string }): Promise<CastResult>;
  /** Clears TVs that show this game (TVs showing anything else are left alone). */
  stopCast(displayIds: string[], opts?: { pin?: string }): Promise<CastResult>;
  /** Connect/Express-style middleware for the reserved /__bargames/* paths. */
  middleware(): (req: IncomingMessage, res: ServerResponse, next?: Next) => void;
  gateway(req: IncomingMessage): GatewayInfo;
  /**
   * The real player IP, for rate limits and logs. On a box: the gateway's
   * x-bargames-client-ip (LAN players otherwise all share the gateway's address).
   * Off a box: cf-connecting-ip, else the socket address (what the games did before).
   * Works with Express requests and socket.io's socket.request.
   */
  clientIp(req: IncomingMessage): string;
  /**
   * True when the request comes from staff signed in to the venue box's admin (SDK 0.7.0):
   * the box vouches for them, so the game can skip its own admin password. Use it with the
   * game kit: adminRouter({ ..., trusted: (req) => bg.isStaff(req) }). Always false off a box.
   */
  isStaff(req: IncomingMessage): boolean;
  /** Flush queued events (call on shutdown). */
  flush(): Promise<void>;
}

export function createBarGames(opts: BarGamesOptions = {}): BarGames {
  const gameId = process.env[ENV.gameId] || opts.gameId || "game";
  const defaultName = opts.defaultName ?? gameId;
  const coreUrl = (opts.coreUrl ?? process.env[ENV.coreUrl] ?? "").replace(/\/$/, "");
  const token = opts.token ?? process.env[ENV.token] ?? "";
  const connected = Boolean(coreUrl && token);
  const doFetch = opts.fetch ?? fetch;
  const ttl = opts.venueTtlMs ?? 30_000;
  const log = opts.log ?? ((msg: string, extra?: unknown) => console.warn(`[bargames] ${msg}`, extra ?? ""));

  const commands = new Map<string, CommandHandler>();
  let statusProvider: (() => GameStatus | Promise<GameStatus>) | undefined;
  let cached: { ctx: VenueContext; at: number } | undefined;
  let inflight: Promise<VenueContext> | undefined;

  const auth = { authorization: `Bearer ${token}` };

  async function venue(): Promise<VenueContext> {
    if (!connected) return standaloneContext(gameId, defaultName);
    if (cached && Date.now() - cached.at < ttl) return cached.ctx;
    inflight ??= (async () => {
      try {
        const res = await doFetch(`${coreUrl}/internal/venue`, { headers: auth });
        if (!res.ok) throw new Error(`venue ${res.status}`);
        const ctx = (await res.json()) as VenueContext;
        cached = { ctx, at: Date.now() };
        return ctx;
      } catch (err) {
        log("venue fetch failed; using last known or defaults", String(err));
        return cached?.ctx ?? standaloneContext(gameId, defaultName);
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  // Bounded queue so a down core never grows memory.
  const queue: BarGamesEvent[] = [];
  const MAX_QUEUE = 200;
  let draining: Promise<void> | undefined;

  async function drain(): Promise<void> {
    while (queue.length) {
      const evt = queue[0];
      let attempt = 0;
      for (;;) {
        try {
          const res = await doFetch(`${coreUrl}/internal/events`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify(evt),
          });
          if (res.ok || (res.status >= 400 && res.status < 500)) break; // 4xx: drop, retrying won't help
          throw new Error(`events ${res.status}`);
        } catch (err) {
          if (++attempt >= 3) {
            log("dropping event after retries", { type: evt.type, err: String(err) });
            break;
          }
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
      queue.shift();
    }
  }

  function emit<T extends Record<string, unknown>>(event: GameEventInput<T>): void {
    if (!connected) return;
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ ...event, gameId, at: new Date().toISOString() } as BarGamesEvent);
    draining ??= drain().finally(() => (draining = undefined));
  }

  function authorized(req: IncomingMessage): boolean {
    if (!connected) return false;
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    const want = Buffer.from(`Bearer ${token}`);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  function send(res: ServerResponse, status: number, body: unknown, type = "application/json", cors = false): void {
    const payload = type === "application/json" ? JSON.stringify(body) : String(body);
    res.writeHead(status, {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "no-store",
      // venue.json / theme.css are public branding; CORS lets a dev client on another port read them.
      ...(cors ? { "access-control-allow-origin": "*" } : {}),
    });
    res.end(payload);
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    // Express' json() may have parsed it already.
    const pre = (req as IncomingMessage & { body?: unknown }).body;
    if (pre !== undefined && typeof pre === "object") return pre;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024) throw new Error("body too large");
      chunks.push(c as Buffer);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  }

  function middleware() {
    return (req: IncomingMessage, res: ServerResponse, next?: Next) => {
      const path = (req.url ?? "/").split("?")[0];
      if (!path.startsWith("/__bargames/")) return next ? next() : send(res, 404, { error: "not found" });
      void (async () => {
        try {
          if (path === PATHS.venue && req.method === "GET") return send(res, 200, await venue(), "application/json", true);
          if (path === PATHS.themeCss && req.method === "GET") return send(res, 200, themeToCss((await venue()).game.theme), "text/css", true);
          if (path === PATHS.status && req.method === "GET") {
            if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
            return send(res, 200, statusProvider ? await statusProvider() : { rooms: [] });
          }
          if (path === PATHS.command && req.method === "POST") {
            if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
            const body = (await readJson(req)) as CommandRequest;
            const handler = typeof body?.command === "string" ? commands.get(body.command) : undefined;
            if (!handler) return send(res, 404, { ok: false, message: `unknown command: ${String(body?.command)}` });
            return send(res, 200, await handler(body));
          }
          return send(res, 404, { error: "not found" });
        } catch (err) {
          log("middleware error", String(err));
          if (!res.headersSent) send(res, 500, { ok: false, message: "internal error" });
        }
      })();
    };
  }

  function gateway(req: IncomingMessage): GatewayInfo {
    const h = req.headers;
    // Only trust gateway headers on a box; standalone, anyone could send them.
    const viaGateway = connected && h[HEADERS.via] === "1";
    const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    return {
      viaGateway,
      clientIp: viaGateway ? first(h[HEADERS.clientIp]) : (first(h["cf-connecting-ip"]) ?? req.socket?.remoteAddress),
      access: viaGateway ? (first(h[HEADERS.access]) as AccessReason | undefined) : undefined,
      staff: viaGateway && first(h[HEADERS.staff]) === "1",
    };
  }

  function core(method: string, p: string, body?: unknown): Promise<Response> {
    return doFetch(`${coreUrl}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  }

  async function castCall(p: string, body: unknown): Promise<CastResult> {
    if (!connected) return { ok: false, message: "not running on a Bar Games box" };
    try {
      const r = await core("POST", p, body);
      const json = (await r.json().catch(() => ({}))) as CastResult & { error?: string };
      return r.ok ? json : { ok: false, message: json.message ?? json.error ?? `HTTP ${r.status}` };
    } catch (err) {
      return { ok: false, message: `box unreachable: ${String(err)}` };
    }
  }

  return {
    gameId,
    connected,
    venue,
    publicUrl: async (path) => {
      if (!connected) return undefined;
      const base = (await venue()).game.publicUrl;
      return base ? new URL(path, base).toString() : undefined;
    },
    emit,
    onCommand: (name, handler) => void commands.set(name, handler),
    displays: async () => {
      const off: CastTargets = { enabled: false, pinRequired: false, displays: [] };
      if (!connected) return off;
      const r = await core("GET", "/internal/displays").catch(() => undefined);
      return r?.ok ? ((await r.json()) as CastTargets) : off;
    },
    cast: (roomCode, displayIds, opts) => castCall("/internal/cast", { roomCode, displayIds, pin: opts?.pin }),
    stopCast: (displayIds, opts) => castCall("/internal/cast/stop", { displayIds, pin: opts?.pin }),
    onCreateRoom: (handler) =>
      void commands.set("create_room", async ({ args }) => {
        const a = (args ?? {}) as Partial<CreateRoomArgs>;
        try {
          const room = await handler({
            kind: a.kind ?? "venue",
            purpose: a.purpose,
            title: typeof a.title === "string" ? a.title : undefined,
            ...(a.firstJoinerHosts === true ? { firstJoinerHosts: true } : {}),
          });
          if (!room || typeof room.roomCode !== "string" || !room.roomCode) return { ok: false, message: "create_room handler returned no roomCode" };
          return { ok: true, data: room };
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
      }),
    setStatusProvider: (fn) => void (statusProvider = fn),
    middleware,
    gateway,
    clientIp: (req) => gateway(req).clientIp ?? "unknown",
    isStaff: (req) => gateway(req).staff,
    flush: async () => {
      await draining;
    },
  };
}

export type { CastDisplay, CastResult, CastTargets, ClaimArgs, CommandRequest, CommandResult, CreateRoomArgs, CreatedRoom, GameEventInput, GameStatus, PendingClaim, RoomSummary, VenueContext } from "./protocol.js";
