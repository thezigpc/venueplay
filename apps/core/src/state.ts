import { JsonStore, type GatewayAccess } from "@bargames/common";
import { DEFAULT_THEME, type Announcement, type Countdown, type GameBranding, type GameManifest, type VenueLocation, type VenueTheme, type WifiInfo } from "@bargames/sdk";
import path from "node:path";
import type { CloudflareSettings } from "./cloudflare/service.js";
import type { StartupRule } from "./startup.js";
import type { ResultEntry } from "./leaderboard.js";
import type { Scene, Schedule } from "./scenes.js";

export interface VenueSettings {
  name: string;
  theme: VenueTheme;
  wifi?: WifiInfo;
  /** Cloudflare zone, e.g. example.com ("localhost" in development). */
  domain: string;
  /**
   * Hostname pattern. Tokens: {game} {venue} {domain}.
   * "{game}.{domain}" → pool.example.com; "{game}.internal.{domain}" → pool.internal.example.com
   */
  hostnamePattern: string;
  /** {game} value used for the landing page and the admin UI. */
  playLabel: string;
  adminLabel: string;
  /**
   * The admin on its own hostname (adminLabel, e.g. "pachakava-admin") instead of /admin on the
   * games list's hostname (the default). Recommended for security: on one hostname any game
   * page can act as signed-in staff (browsers isolate by hostname, not path).
   */
  adminOwnHost?: boolean;
  /** Short venue slug for the {venue} token. */
  slug: string;
  /**
   * Public scheme/port; https and none behind Cloudflare, http + 7080 in dev.
   * "No port" is null, not undefined: undefined is dropped from the JSON file, and the
   * default (7080) would come back on the next load.
   */
  publicScheme: "https" | "http";
  publicPort?: number | null;
  /** Where the venue is (weather on menus). null: not set. SDK 0.5.0. */
  location?: VenueLocation | null;
  /** IANA time zone, e.g. "America/New_York". */
  timezone?: string | null;
  units?: "imperial" | "metric" | null;
  /** A display module (menu) idle TVs show instead of the box's idle screen. null: the box's. */
  idleModule?: string | null;
}

export type AccessSettings = GatewayAccess;

export interface InstalledGame {
  id: string;
  manifest: GameManifest;
  source: { kind: "market" | "url" | "local"; ref: string };
  /** Signed market package vs. unverified URL install. */
  verified: boolean;
  installedAt: string;
  updatedAt: string;
  enabled: boolean;
  branding: GameBranding;
  /** Replaces the {game} label in the hostname (e.g. "kavabingo"). */
  hostnameAlias?: string;
  /**
   * Path routing (SDK 0.10.0): games that support it live at <play host>/<alias or id>.
   * true keeps this one on its own hostname instead (one more DNS record and tunnel route).
   */
  ownHostname?: boolean;
  /** Per-game secret for events/commands. Never sent to browsers. */
  token: string;
  /** Development only: reach the game here instead of its container. */
  devTarget?: string;
}

export const DEFAULT_VENUE: VenueSettings = {
  name: "Bar Games",
  theme: DEFAULT_THEME,
  domain: "localhost",
  hostnamePattern: "{game}.{domain}",
  playLabel: "play",
  adminLabel: "admin",
  slug: "venue",
  publicScheme: "http",
  publicPort: 7080,
};

export const DEFAULT_ACCESS: AccessSettings = {
  pinEnabled: false,
  pin: "",
  whitelist: [],
  autoVenueIp: true,
  venueCidrs: [],
  adminRemote: false,
};

/** Whether game hosts may put their rooms on the venue's TVs (from inside the game). */
export interface CastSettings {
  fromGames: boolean;
  /** Optional TV PIN a game host must enter to cast; empty = none. */
  pin: string;
}
export const DEFAULT_CAST: CastSettings = { fromGames: false, pin: "" };

export function openState(dataDir: string) {
  return {
    venue: new JsonStore<VenueSettings>(path.join(dataDir, "venue.json"), DEFAULT_VENUE),
    access: new JsonStore<AccessSettings>(path.join(dataDir, "access.json"), DEFAULT_ACCESS),
    games: new JsonStore<{ games: InstalledGame[] }>(path.join(dataDir, "games.json"), { games: [] }),
    cast: new JsonStore<CastSettings>(path.join(dataDir, "cast.json"), DEFAULT_CAST),
    /** The staff's current announcement (none: {}). */
    announcement: new JsonStore<Partial<Announcement>>(path.join(dataDir, "announcement.json"), {}),
    /** The venue's lobby countdown (SDK 0.9.0; none: {}). */
    countdown: new JsonStore<Partial<Countdown>>(path.join(dataDir, "countdown.json"), {}),
    /** Saved scenes (SDK 0.9.0). */
    scenes: new JsonStore<{ scenes: Scene[] }>(path.join(dataDir, "scenes.json"), { scenes: [] }),
    /** Scheduled sessions, and when each last fired (id|kind → local date). */
    schedules: new JsonStore<{ schedules: Schedule[]; fired: Record<string, string> }>(path.join(dataDir, "schedules.json"), { schedules: [], fired: {} }),
    /** Game results for the leaderboards (last 30 days). */
    results: new JsonStore<{ entries: ResultEntry[] }>(path.join(dataDir, "results.json"), { entries: [] }),
    /** Per-app secret settings (game id → NAME → value), injected as container env. Owner-only. */
    appSecrets: new JsonStore<Record<string, Record<string, string>>>(path.join(dataDir, "app-secrets.json"), {}, 0o600),
    /** What each TV shows when the box boots (display id → rule; absent: what it showed last). */
    tvStartup: new JsonStore<Record<string, StartupRule>>(path.join(dataDir, "tv-startup.json"), {}),
    auth: new JsonStore<{ passwordHash?: string }>(path.join(dataDir, "auth.json"), {}),
    // Holds the Cloudflare API token and tunnel token: owner-only.
    cloudflare: new JsonStore<CloudflareSettings>(path.join(dataDir, "cloudflare.json"), {}, 0o600),
  };
}
export type State = ReturnType<typeof openState>;
