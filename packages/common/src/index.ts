// Small Node helpers shared by core, gateway and broker. Not part of the game SDK.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- JSON store

/**
 * One JSON document on disk, cached in memory. Writes are atomic (tmp + rename)
 * and serialized, so a crash never leaves a half-written file.
 */
export class JsonStore<T> {
  private data: T;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly file: string,
    defaults: T,
    /** File mode, e.g. 0o600 for documents holding credentials. */
    private readonly mode?: number,
  ) {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      const loaded = JSON.parse(readFileSync(file, "utf8")) as T;
      this.data = isPlainObject(defaults) && isPlainObject(loaded) ? ({ ...defaults, ...loaded } as T) : loaded;
    } catch {
      this.data = structuredClone(defaults);
    }
    // A file written before its mode was set (e.g. 644 from an older box) is fixed now, not
    // only at the next write. Errors are ignored (Windows development has no modes).
    if (this.mode !== undefined && existsSync(file)) {
      try {
        chmodSync(file, this.mode);
      } catch {
        /* not ours to change, or no modes here */
      }
    }
  }

  get(): T {
    return this.data;
  }

  set(next: T): Promise<void> {
    this.data = next;
    const snapshot = JSON.stringify(next, null, 2);
    this.chain = this.chain.then(() => {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, snapshot, this.mode === undefined ? undefined : { mode: this.mode });
      renameSync(tmp, this.file);
    });
    return this.chain;
  }

  /** Mutate a copy and save it. */
  async update(fn: (draft: T) => T | void): Promise<T> {
    const draft = structuredClone(this.data);
    const result = fn(draft);
    const next = (result === undefined ? draft : result) as T;
    await this.set(next);
    return next;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------- tokens

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Short signed tokens between core and the gateway (they share the gateway token):
 * "<kind>.<expiry ms>.<nonce>.<hmac>". Used for staff sign-in links and the staff cookie.
 */
export function signToken(secret: string, kind: string, expiresAt: number, nonce = ""): string {
  const body = `${kind}.${expiresAt}.${nonce}`;
  return `${body}.${createHmac("sha256", `${secret}:${kind}`).update(body).digest("base64url")}`;
}

/** The token's expiry and nonce when it's ours, of this kind, and not expired. */
export function verifyToken(secret: string, kind: string, token: string | undefined, now = Date.now()): { expiresAt: number; nonce: string } | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== kind) return undefined;
  const [, exp, nonce, sig] = parts;
  const want = createHmac("sha256", `${secret}:${kind}`).update(`${kind}.${exp}.${nonce}`).digest("base64url");
  const expiresAt = Number(exp);
  if (!safeEqual(sig, want) || !(expiresAt > now)) return undefined;
  return { expiresAt, nonce };
}

/** The venue-wide staff cookie (gateway-signed "staff" token): staff signed in to the box admin. */
export const STAFF_COOKIE = "bg_staff";
/** The box admin's session cookie (core). The gateway never passes it to a game. */
export const ADMIN_COOKIE = "bg_admin";
/** Staff cookies last as long as a box admin login. */
export const STAFF_TTL_MS = 12 * 3600e3;
/** One-time staff sign-in links (box admin → a game's admin) last this long. */
export const STAFF_LINK_TTL_MS = 2 * 60_000;

/** "Bearer xyz" → "xyz" */
export function bearer(header: string | string[] | undefined): string {
  const h = Array.isArray(header) ? header[0] : header;
  return h?.startsWith("Bearer ") ? h.slice(7) : "";
}

/** Loads a secret from env, else from <dataDir>/<name>, creating it once. */
export function persistentSecret(dataDir: string, name: string, envValue?: string): string {
  if (envValue) return envValue;
  const file = path.join(dataDir, name);
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    mkdirSync(dataDir, { recursive: true });
    const secret = randomToken(32);
    writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

// ---------------------------------------------------------------- logging

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON-lines logger (docker logs friendly). */
export function createLogger(service: string, level: Level = (process.env.LOG_LEVEL as Level) || "info") {
  const min = ORDER[level] ?? 20;
  const write = (lvl: Level, area: string, msg: string, extra?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), lvl, svc: service, area, msg, ...extra });
    (lvl === "error" || lvl === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (area: string, msg: string, extra?: Record<string, unknown>) => write("debug", area, msg, extra),
    info: (area: string, msg: string, extra?: Record<string, unknown>) => write("info", area, msg, extra),
    warn: (area: string, msg: string, extra?: Record<string, unknown>) => write("warn", area, msg, extra),
    error: (area: string, msg: string, extra?: Record<string, unknown>) => write("error", area, msg, extra),
  };
}
export type Logger = ReturnType<typeof createLogger>;

// ---------------------------------------------------------------- env

export function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ---------------------------------------------------------------- core → gateway contract

import type { VenueContext, VenueInfo } from "@bargames/sdk";

export type RouteKind = "game" | "admin" | "hub";

export interface GatewayRoute {
  host: string;
  kind: RouteKind;
  gameId?: string;
  /** Upstream base URL (hub routes are rendered by the gateway and have none). */
  target?: string;
  enabled: boolean;
  /** Inject the venue theme stylesheet into HTML (level 0 games). */
  injectTheme: boolean;
  /**
   * Path routing (SDK 0.10.0): served under this prefix on `host` ("/bingo"). The gateway strips
   * it before proxying and puts it back on the game's redirects.
   */
  path?: string;
  /** Old address: answer every request with a redirect to this URL plus the request's path. */
  redirectTo?: string;
}

export interface WhitelistEntry {
  cidr: string;
  label?: string;
  /** ISO time; expired entries are ignored. */
  expiresAt?: string;
}

export interface GatewayAccess {
  pinEnabled: boolean;
  pin: string;
  whitelist: WhitelistEntry[];
  /** Detect the venue's public IPv4 and IPv6 /64 automatically. */
  autoVenueIp: boolean;
  /** Extra venue ranges entered by hand. */
  venueCidrs: string[];
  /** Allow the admin host from anywhere (it still needs the admin login). */
  adminRemote: boolean;
  /** Open mode: anyone on the internet may play (the PIN still applies if on; the admin doesn't open). */
  open?: boolean;
}

export interface HubGame {
  id: string;
  displayName: string;
  tagline?: string;
  iconUrl?: string;
  url: string;
  enabled: boolean;
  /** "app": a menu or other app, listed apart from the games ("display" from 0.5.0 cores means the same). */
  kind?: "game" | "app" | "display";
  /** Its open venue/patron rooms (games list "Join" links). Undefined: unknown or not level 2+. */
  rooms?: HubRoom[];
}

/** A room on the games list. joinUrl is set only when the game gave a joinPath. */
export interface HubRoom {
  code: string;
  players: number;
  title?: string;
  joinUrl?: string;
}

export interface GatewayConfig {
  boxVersion: string;
  /** Cloudflare zone; the PIN cookie is shared across its subdomains. */
  domain: string;
  venue: VenueInfo;
  routes: GatewayRoute[];
  access: GatewayAccess;
  /** Per-game venue context, keyed by game id; "_hub" for the landing page. */
  contexts: Record<string, VenueContext>;
  hub: { games: HubGame[] };
  /** No admin password yet: the landing page sends LAN visitors to first-run setup. */
  setupRequired: boolean;
  /** The admin UI's public URL (for redirects to setup). */
  adminUrl: string;
  /**
   * Box 0.15.1: staff cookies and sign-in links issued before this (ms) are refused. Set
   * when the admin password changes or staff "sign out everywhere". Absent or 0: never.
   */
  staffNotBefore?: number;
}

/**
 * Set by the gateway (value: the gateway token) on requests it forwards to core, so
 * core can trust the gateway's access decision (e.g. "local" for first-run setup).
 * Games can reach core directly, so the access header alone proves nothing.
 */
export const GATEWAY_PROOF_HEADER = "x-bargames-gateway";
