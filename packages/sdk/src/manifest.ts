// bargames.json: the manifest every game package ships at its repo root.

import { SESSION_KINDS, type IntegrationLevel, type SessionKind } from "./protocol.js";

export const MANIFEST_FILE = "bargames.json";

export const BRANDABLE_SLOTS = ["displayName", "tagline", "icon", "accent", "logo"] as const;
export type BrandableSlot = (typeof BRANDABLE_SLOTS)[number];

export interface ContentPack {
  id: string;
  name: string;
  description?: string;
}

/**
 * "game" (default): rooms and players.
 * "app" (SDK 0.6.0): anything else the venue runs on the box (menus, signage, a jukebox):
 * no rooms, listed under Apps. "display" (SDK 0.5.0) is the old name for "app", still accepted.
 */
export const MODULE_KINDS = ["game", "app", "display"] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

export interface GameManifest {
  /** Unique slug; also the default hostname label (pool → pool.example.com). */
  id: string;
  name: string;
  /** What this package is ("display" is read as "app"). Boxes older than SDK 0.5.0 ignore it and treat everything as a game. */
  kind?: ModuleKind;
  /** Semver. */
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
  /** Container image. Pin by digest (…@sha256:…) for releases. */
  image: string;
  /** Port the game's HTTP server listens on inside the container. */
  port: number;
  sdk: { version: string; level: IntegrationLevel };
  routes: {
    /** Player landing page. */
    player: string;
    /** Big-screen view; "{code}" is replaced with the room code. */
    table?: string;
    /** Host / controller view. */
    host?: string;
    /** The game's own admin (settings) page, linked from the box with staff sign-in (SDK 0.7.0). */
    admin?: string;
  };
  /** Health endpoint returning 2xx when ready. */
  health: string;
  /** Events this game emits (level 2+). */
  events: string[];
  /** Commands this game accepts (level 3). */
  commands: string[];
  brandable: BrandableSlot[];
  contentPacks: ContentPack[];
  /** Session kinds this game supports (always empty for apps). */
  sessionKinds: SessionKind[];
  resources: { memory: string; cpus: number };
  /** internet: false keeps the game on an internal-only network. */
  network: { internet: boolean };
  /** Static, non-secret environment. Keys starting with BG_ are reserved. */
  env: Record<string, string>;
  minBoxVersion?: string;
}

export type ManifestResult =
  | { ok: true; manifest: GameManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MEMORY = /^\d+(?:[kmg])$/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const strArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Validates and fills defaults. Never throws. */
export function validateManifest(input: unknown): ManifestResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ["manifest must be a JSON object"], warnings };
  const m = input;

  if (!isStr(m.id) || !ID.test(m.id)) errors.push("id: 2-32 chars, lowercase letters, digits and dashes, starting with a letter");
  if (!isStr(m.name) || m.name.length > 40) errors.push("name: required, at most 40 characters");
  if (!isStr(m.version) || !SEMVER.test(m.version)) errors.push("version: must be semver, e.g. 1.2.0");
  if (!isStr(m.image) || /\s/.test(m.image)) errors.push("image: required container image reference");
  else if (!m.image.includes("@sha256:")) warnings.push("image: not pinned by digest; releases should use image@sha256:…");
  if (typeof m.port !== "number" || !Number.isInteger(m.port) || m.port < 1 || m.port > 65535) errors.push("port: integer 1-65535");

  const kind = m.kind === undefined ? "game" : m.kind;
  if (!(MODULE_KINDS as readonly unknown[]).includes(kind)) errors.push(`kind: ${MODULE_KINDS.join(" or ")}`);
  const display = kind === "app" || kind === "display";
  if (kind === "display") warnings.push('kind: "display" is now "app" (both work)');

  // sdk
  let level: IntegrationLevel = 0;
  if (!isObj(m.sdk)) errors.push("sdk: required object { version, level }");
  else {
    if (!isStr(m.sdk.version)) errors.push("sdk.version: required");
    if (![0, 1, 2, 3].includes(m.sdk.level as number)) errors.push("sdk.level: 0, 1, 2 or 3");
    else level = m.sdk.level as IntegrationLevel;
  }

  // routes
  const routes = isObj(m.routes) ? m.routes : undefined;
  if (!routes || !isStr(routes.player) || !routes.player.startsWith("/")) errors.push("routes.player: required path starting with /");
  for (const k of ["table", "host", "admin"] as const) {
    if (routes && routes[k] !== undefined && (!isStr(routes[k]) || !(routes[k] as string).startsWith("/"))) {
      errors.push(`routes.${k}: must be a path starting with /`);
    }
  }
  if (routes && routes.table === undefined) {
    warnings.push(display ? "routes.table: no TV view; this app can't be cast to TVs or used on idle TVs" : "routes.table: no big-screen view; this game cannot be cast to TVs");
  }
  if (display && routes && isStr(routes.table) && routes.table.includes("{code}")) errors.push("routes.table: apps have no rooms, so no {code}");
  if (display && level >= 2) warnings.push("sdk.level: apps have no rooms; level 2+ room events and commands won't be used");

  const health = m.health === undefined ? "/health" : m.health;
  if (!isStr(health) || !health.startsWith("/")) errors.push("health: path starting with /");

  const events = m.events === undefined ? [] : m.events;
  if (!strArray(events)) errors.push("events: array of strings");
  const commands = m.commands === undefined ? [] : m.commands;
  if (!strArray(commands)) errors.push("commands: array of strings");
  if (level >= 2 && strArray(events) && events.length === 0) warnings.push("events: level 2+ games should declare the events they emit");
  if (level === 3 && strArray(commands) && commands.length === 0) errors.push("commands: level 3 games must declare at least one command");
  if (level < 3 && strArray(commands) && commands.length > 0) warnings.push("commands: only used at sdk.level 3");
  if (strArray(events)) {
    for (const e of events) if (!/^[a-z][a-z0-9_]*$/.test(e) && !/^x-[a-z0-9-]+$/.test(e)) errors.push(`events: "${e}" must be snake_case or x-custom`);
  }

  const brandable = m.brandable === undefined ? (level >= 1 ? ["displayName", "accent"] : ["displayName"]) : m.brandable;
  if (!strArray(brandable) || !brandable.every((s) => (BRANDABLE_SLOTS as readonly string[]).includes(s))) {
    errors.push(`brandable: subset of ${BRANDABLE_SLOTS.join(", ")}`);
  }

  const packs = m.contentPacks === undefined ? [] : m.contentPacks;
  if (!Array.isArray(packs) || !packs.every((p) => isObj(p) && isStr(p.id) && isStr(p.name))) {
    errors.push("contentPacks: array of { id, name, description? }");
  }

  const kinds = display ? [] : m.sessionKinds === undefined ? [...SESSION_KINDS] : m.sessionKinds;
  if (display && m.sessionKinds !== undefined) warnings.push("sessionKinds: ignored for apps");
  if (!display && (!strArray(kinds) || kinds.length === 0 || !kinds.every((k) => (SESSION_KINDS as readonly string[]).includes(k)))) {
    errors.push(`sessionKinds: non-empty subset of ${SESSION_KINDS.join(", ")}`);
  }

  const res = isObj(m.resources) ? m.resources : {};
  const memory = res.memory === undefined ? "512m" : res.memory;
  const cpus = res.cpus === undefined ? 1 : res.cpus;
  if (!isStr(memory) || !MEMORY.test(memory)) errors.push('resources.memory: like "512m" or "1g"');
  if (typeof cpus !== "number" || cpus < 0.1 || cpus > 8) errors.push("resources.cpus: 0.1-8");

  const net = isObj(m.network) ? m.network : {};
  const internet = net.internet === undefined ? false : net.internet;
  if (typeof internet !== "boolean") errors.push("network.internet: boolean");

  const env = m.env === undefined ? {} : m.env;
  if (!isObj(env) || !Object.values(env).every((v) => typeof v === "string")) errors.push("env: object of string values");
  else for (const k of Object.keys(env)) if (k.startsWith("BG_")) errors.push(`env.${k}: BG_ variables are reserved for the box`);

  if (m.minBoxVersion !== undefined && (!isStr(m.minBoxVersion) || !SEMVER.test(m.minBoxVersion))) errors.push("minBoxVersion: semver");

  if (errors.length) return { ok: false, errors, warnings };

  const sdk = m.sdk as { version: string };
  const manifest: GameManifest = {
    id: m.id as string,
    name: m.name as string,
    kind: display ? "app" : (kind as ModuleKind),
    version: m.version as string,
    description: m.description as string | undefined,
    author: m.author as string | undefined,
    homepage: m.homepage as string | undefined,
    license: m.license as string | undefined,
    image: m.image as string,
    port: m.port as number,
    sdk: { version: sdk.version, level },
    routes: {
      player: routes!.player as string,
      table: routes!.table as string | undefined,
      host: routes!.host as string | undefined,
      admin: routes!.admin as string | undefined,
    },
    health: health as string,
    events: events as string[],
    commands: commands as string[],
    brandable: brandable as BrandableSlot[],
    contentPacks: packs as ContentPack[],
    sessionKinds: kinds as SessionKind[],
    resources: { memory: memory as string, cpus: cpus as number },
    network: { internet: internet as boolean },
    env: env as Record<string, string>,
    minBoxVersion: m.minBoxVersion as string | undefined,
  };
  return { ok: true, manifest, warnings };
}

/** The game's own admin page: routes.admin, or for an app its routes.host (where 0.6.0 apps put it). */
export const adminPath = (m: Pick<GameManifest, "kind" | "routes">): string | undefined => m.routes.admin ?? (isApp(m) ? m.routes.host : undefined);

/** True for apps (menus, signage…), including SDK 0.5.0's "display". No kind: a game. */
export const isApp = (m: Pick<GameManifest, "kind">): boolean => m.kind === "app" || m.kind === "display";

/** @deprecated SDK 0.5.0 name; use isApp. */
export const isDisplayModule = isApp;

/** Fills a table route template with a room code. */
export function tableUrl(manifest: Pick<GameManifest, "routes">, roomCode: string): string | undefined {
  return manifest.routes.table?.replace("{code}", encodeURIComponent(roomCode));
}

/**
 * The reverse of tableUrl: the room code in a table URL (path + query, origin
 * removed), or undefined when the URL isn't this game's table route.
 */
export function roomFromTableUrl(manifest: Pick<GameManifest, "routes">, pathAndQuery: string): string | undefined {
  const t = manifest.routes.table;
  if (!t || !t.includes("{code}")) return undefined;
  const [pre, post] = t.split("{code}");
  if (!pathAndQuery.startsWith(pre) || !pathAndQuery.endsWith(post) || pathAndQuery.length < pre.length + post.length + 1) return undefined;
  const raw = pathAndQuery.slice(pre.length, pathAndQuery.length - post.length);
  if (/[/?&#]/.test(raw)) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/** Compares semver strings (pre-release tags ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0].split(".").map(Number);
  const pb = b.split(/[-+]/)[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
