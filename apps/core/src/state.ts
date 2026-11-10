import { JsonStore, type GatewayAccess } from "@bargames/common";
import { DEFAULT_THEME, type GameBranding, type GameManifest, type VenueTheme, type WifiInfo } from "@bargames/sdk";
import path from "node:path";
import type { CloudflareSettings } from "./cloudflare/service.js";

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
  /** Short venue slug for the {venue} token. */
  slug: string;
  /** Public scheme/port; https and none behind Cloudflare, http + 7080 in dev. */
  publicScheme: "https" | "http";
  publicPort?: number;
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

export function openState(dataDir: string) {
  return {
    venue: new JsonStore<VenueSettings>(path.join(dataDir, "venue.json"), DEFAULT_VENUE),
    access: new JsonStore<AccessSettings>(path.join(dataDir, "access.json"), DEFAULT_ACCESS),
    games: new JsonStore<{ games: InstalledGame[] }>(path.join(dataDir, "games.json"), { games: [] }),
    auth: new JsonStore<{ passwordHash?: string }>(path.join(dataDir, "auth.json"), {}),
    // Holds the Cloudflare API token and tunnel token: owner-only.
    cloudflare: new JsonStore<CloudflareSettings>(path.join(dataDir, "cloudflare.json"), {}, 0o600),
  };
}
export type State = ReturnType<typeof openState>;
