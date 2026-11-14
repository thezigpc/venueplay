// @bargames/sdk/server: what a game's Node server uses to talk to the box.
//
// Works the same on and off a box. Without BG_CORE_URL/BG_GAME_TOKEN the game is
// "standalone": venue() returns default branding, emit() is a no-op, and the
// middleware still serves /__bargames/venue.json so the client SDK works everywhere.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basePathFromEnv, joinUrl } from "./base.js";
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
  type AttentionItem,
  type AudioOutput,
  type BoxTv,
  type Countdown,
  type GameResult,
  type LaunchResult,
  type MediaItem,
  type MediaPlayArgs,
  type MediaPlayResult,
  type PlayerProfile,
} from "./protocol.js";
import { themeToCss } from "./theme.js";
import { AudioError, createAudio, type Audio } from "./audio.js";

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
  /**
   * SDK 0.10.0: the path prefix this game is served under ("/bingo"), from BG_BASE_PATH (the box)
   * or BASE_PATH (self-hosted behind your own proxy). "" at the root. The proxy strips it, so your
   * routes stay "/api", "/socket.io"…; put it in the HTML you serve with injectBasePath().
   */
  readonly basePath: string;
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
  /**
   * True when `password` is the venue box's admin password (SDK 0.8.0), so the game's admin
   * login can accept it too. The box limits wrong guesses itself (per game + client and
   * box-wide); pass the client's IP (bg.clientIp(req)). Always false off a box.
   */
  checkVenuePassword(password: string, clientIp?: string): Promise<boolean>;

  // ---------------------------------------------------------------- SDK 0.9.0
  /** Staff should look at these (shown on the box's Tonight page). Pass [] to clear. No-op off a box. */
  setAttention(items: AttentionItem[]): Promise<void>;
  /** "Trivia starts in 5:00" on phones, the games list and idle TVs. One per venue; a new one replaces it. */
  startCountdown(c: { label: string; minutes: number; roomCode?: string }): Promise<Countdown | undefined>;
  /** Ends this game's countdown early. */
  clearCountdown(): Promise<void>;
  /** A finished game's results: feeds the venue's leaderboards (and, later, rewards). Also emits "game_result". */
  reportResults(r: GameResult): Promise<void>;
  /** STUB (planned): the venue profile of the player behind this request. Always undefined for now. */
  profile(req: IncomingMessage): Promise<PlayerProfile | undefined>;
  /**
   * SDK 0.13.0: the box's sound outputs (needs "audio": { "play": true } in bargames.json).
   * [] off a box or without it. Same as bg.audio.outputs(), without the errors.
   */
  audioOutputs(): Promise<AudioOutput[]>;
  /**
   * SDK 0.13.0: plays a sound from your own server (`sound` is its path, "/sounds/ding.mp3")
   * on an output (default: the venue's default). Never throws: { ok: false, reason } off a
   * box ("standalone"), without the manifest's audio.play ("not-allowed"), or when the box
   * can't ("busy", "error"). For music and anything you need to follow, use bg.audio.
   */
  playSound(sound: string, opts?: { outputId?: string }): Promise<{ ok: boolean; reason?: string; message?: string; sessionId?: string }>;
  /** SDK 0.13.0: play, pause and follow audio on the box's outputs (see "@bargames/sdk/audio"). */
  audio: Audio;
  /**
   * SDK 0.13.0: true when this request comes from the box itself (it carries your
   * BG_GAME_TOKEN), e.g. the box fetching the audio you asked it to play. Always false off a box.
   */
  fromBox(req: IncomingMessage): boolean;
  /** Media providers: every venue TV (not gated by "casting from games"). [] off a box or without manifest media. */
  tvs(): Promise<BoxTv[]>;
  /** Media providers: start a TV app (one of manifest media.launch) on one of your target displays. Returns once accepted. */
  launchApp(displayId: string, app: string): Promise<LaunchResult>;
  /** media_list: your lists and plans. */
  onMediaList(fn: () => MediaItem[] | Promise<MediaItem[]>): void;
  /** media_play: answer within ~3 s; return pending: true while a TV app starts. */
  onMediaPlay(fn: (args: MediaPlayArgs) => MediaPlayResult | Promise<MediaPlayResult>): void;
  /** media_stop: pause and clear the queue on one TV. */
  onMediaStop(fn: (args: { displayId: string }) => { ok: boolean; message?: string } | Promise<{ ok: boolean; message?: string }>): void;
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
  const audio = createAudio({ coreUrl, token, fetch: doFetch });
  const basePath = basePathFromEnv();
  const rawBase = process.env[ENV.basePath] || process.env.BASE_PATH;
  // Git Bash turns "/bingo" into "C:/Program Files/Git/bingo"; say so instead of running at the root.
  if (rawBase && rawBase !== "/" && !basePath) log(`ignoring base path "${rawBase}" (not like "/my-game"; in Git Bash set MSYS_NO_PATHCONV=1). Serving at the root.`);

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
    basePath,
    venue,
    publicUrl: async (path) => {
      if (!connected) return undefined;
      const base = (await venue()).game.publicUrl;
      return base ? joinUrl(base, path) : undefined;
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
    async checkVenuePassword(password, clientIp) {
      if (!connected || typeof password !== "string" || !password) return false;
      try {
        const r = await core("POST", "/internal/venue-password", { password, clientIp });
        return r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
      } catch {
        return false;
      }
    },
    async setAttention(items) {
      if (!connected) return;
      const clean = (Array.isArray(items) ? items : []).slice(0, 20).map((i) => ({ level: i.level, message: String(i.message).slice(0, 200), ...(i.actionPath ? { actionPath: i.actionPath } : {}) }));
      await core("POST", "/internal/attention", { items: clean }).catch(() => undefined);
    },
    async startCountdown(c) {
      if (!connected) return undefined;
      const r = await core("POST", "/internal/countdown", c).catch(() => undefined);
      return r?.ok ? ((await r.json()) as Countdown) : undefined;
    },
    async clearCountdown() {
      if (connected) await core("DELETE", "/internal/countdown").catch(() => undefined);
    },
    async reportResults(r) {
      if (!connected) return;
      emit({ type: "game_result", roomCode: r.roomCode, data: r as unknown as Record<string, unknown> });
      await core("POST", "/internal/results", r).catch(() => undefined);
    },
    profile: async () => undefined,
    audio,
    fromBox: (req) => authorized(req),
    audioOutputs: async () => (connected ? audio.outputs().catch(() => []) : []),
    async playSound(sound, o) {
      if (!connected) return { ok: false, reason: "standalone" };
      try {
        const s = await audio.play({ path: sound, output: o?.outputId });
        return { ok: true, sessionId: s.id };
      } catch (err) {
        const status = err instanceof AudioError ? err.status : 0;
        return { ok: false, reason: status === 403 ? "not-allowed" : status === 409 ? "busy" : "error", message: (err as Error).message };
      }
    },
    async tvs() {
      if (!connected) return [];
      const r = await core("GET", "/internal/tvs").catch(() => undefined);
      return r?.ok ? ((await r.json()) as { tvs: BoxTv[] }).tvs : [];
    },
    async launchApp(displayId, app) {
      if (!connected) return { ok: false, reason: "unsupported", message: "not running on a Bar Games box" };
      try {
        const r = await core("POST", "/internal/launch-app", { displayId, app });
        return (await r.json()) as LaunchResult;
      } catch (err) {
        return { ok: false, reason: "error", message: String(err) };
      }
    },
    onMediaList: (fn) => void commands.set("media_list", async () => ({ ok: true, data: { items: await fn() } })),
    onMediaPlay: (fn) =>
      void commands.set("media_play", async ({ args }) => {
        const a = (args ?? {}) as Partial<MediaPlayArgs>;
        if (typeof a.itemId !== "string" || !a.itemId) return { ok: false, message: "itemId required" };
        const r = await fn({ itemId: a.itemId, displayId: typeof a.displayId === "string" ? a.displayId : undefined, takeBack: a.takeBack === true });
        return { ok: r.ok, message: r.message, data: r };
      }),
    onMediaStop: (fn) =>
      void commands.set("media_stop", async ({ args }) => {
        const displayId = (args as { displayId?: unknown } | undefined)?.displayId;
        if (typeof displayId !== "string" || !displayId) return { ok: false, message: "displayId required" };
        return fn({ displayId });
      }),
    flush: async () => {
      await draining;
    },
  };
}

export type {
  AttentionItem,
  AudioOutput,
  BoxTv,
  CastDisplay,
  CastResult,
  CastTargets,
  ClaimArgs,
  CommandRequest,
  CommandResult,
  Countdown,
  CreateRoomArgs,
  CreatedRoom,
  GameEventInput,
  GameResult,
  GameStatus,
  LaunchResult,
  MediaItem,
  MediaPlayArgs,
  MediaPlayResult,
  MediaTarget,
  PendingClaim,
  PlayerProfile,
  RoomSummary,
  VenueContext,
} from "./protocol.js";

// SDK 0.13.0: audio on the box's outputs.
export { AudioError, AudioUnavailable, createAudio, type Audio } from "./audio.js";
export type { AudioPlayOptions, AudioSession, AudioSessionState } from "./protocol.js";

// SDK 0.10.0: running under a path prefix (see base.ts).
export { BASE_META, basePathFromEnv, injectBasePath, joinUrl, normalizeBasePath, shortAddress } from "./base.js";
