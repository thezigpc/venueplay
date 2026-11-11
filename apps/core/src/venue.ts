import type { GatewayConfig, GatewayRoute, HubGame, HubRoom } from "@bargames/common";
import { PROTOCOL_VERSION, withAccent, type Announcement, type VenueContext, type VenueGameLink, type VenueInfo } from "@bargames/sdk";
import { hostFor, publicUrl } from "./hostnames.js";
import type { AccessSettings, InstalledGame, VenueSettings } from "./state.js";

/** What every game hears about the venue around it (SDK 0.4.0): the lineup and the announcement. */
export interface VenueExtras {
  /** All installed games; only enabled ones are listed. */
  games?: InstalledGame[];
  announcement?: Partial<Announcement>;
}

export function venueInfo(v: VenueSettings, extras: VenueExtras = {}): VenueInfo {
  const info: VenueInfo = { name: v.name, theme: v.theme, wifi: v.wifi, playUrl: publicUrl(v, hostFor(v, v.playLabel)) };
  if (extras.games) info.games = extras.games.filter((g) => g.enabled).map((g) => gameLink(v, g));
  const a = liveAnnouncement(extras.announcement);
  if (a) info.announcement = a;
  return info;
}

/** The announcement, unless it's empty or past its time. */
export function liveAnnouncement(a: Partial<Announcement> | undefined, now = Date.now()): Announcement | undefined {
  if (!a?.id || !a.text) return undefined;
  if (a.until && Date.parse(a.until) <= now) return undefined;
  return { id: a.id, text: a.text, ...(a.until ? { until: a.until } : {}) };
}

function gameLink(v: VenueSettings, g: InstalledGame): VenueGameLink {
  const link: VenueGameLink = { id: g.id, displayName: g.branding.displayName ?? g.manifest.name, url: publicUrl(v, gameHost(v, g)) };
  if (g.branding.tagline) link.tagline = g.branding.tagline;
  if (g.branding.iconUrl) link.iconUrl = g.branding.iconUrl;
  return link;
}

export function gameHost(v: VenueSettings, g: InstalledGame): string {
  return hostFor(v, g.hostnameAlias ?? g.id);
}

export function buildContext(v: VenueSettings, g: InstalledGame, extras: VenueExtras = {}): VenueContext {
  return {
    protocol: PROTOCOL_VERSION,
    venue: venueInfo(v, extras),
    game: {
      id: g.id,
      displayName: g.branding.displayName ?? g.manifest.name,
      tagline: g.branding.tagline,
      iconUrl: g.branding.iconUrl,
      publicUrl: publicUrl(v, gameHost(v, g)),
      theme: withAccent(v.theme, g.branding.accent),
    },
    standalone: false,
    generatedAt: new Date().toISOString(),
  };
}

export function gameTarget(g: InstalledGame): string {
  return g.devTarget ?? `http://bg-game-${g.id}:${g.manifest.port}`;
}

export function buildGatewayConfig(input: {
  venue: VenueSettings;
  access: AccessSettings;
  games: InstalledGame[];
  coreUrl: string;
  boxVersion: string;
  setupRequired: boolean;
  announcement?: Partial<Announcement>;
  /** Open rooms per game id, for the games list (from the room cache). */
  rooms?: Record<string, HubRoom[]>;
}): GatewayConfig {
  const { venue, access, games } = input;
  const extras: VenueExtras = { games, announcement: input.announcement };
  const routes: GatewayRoute[] = [
    { host: hostFor(venue, venue.adminLabel), kind: "admin", target: input.coreUrl, enabled: true, injectTheme: false },
    { host: hostFor(venue, venue.playLabel), kind: "hub", enabled: true, injectTheme: false },
  ];
  const contexts: Record<string, VenueContext> = {};
  const hub: HubGame[] = [];
  for (const g of games) {
    const host = gameHost(venue, g);
    routes.push({ host, kind: "game", gameId: g.id, target: gameTarget(g), enabled: g.enabled, injectTheme: g.manifest.sdk.level === 0 });
    const ctx = buildContext(venue, g, extras);
    contexts[g.id] = ctx;
    hub.push({ id: g.id, displayName: ctx.game.displayName, tagline: ctx.game.tagline, iconUrl: ctx.game.iconUrl, url: ctx.game.publicUrl!, enabled: g.enabled, rooms: input.rooms?.[g.id] });
  }
  contexts._hub = {
    protocol: PROTOCOL_VERSION,
    venue: venueInfo(venue, extras),
    game: { id: "_hub", displayName: venue.name, theme: venue.theme },
    standalone: false,
    generatedAt: new Date().toISOString(),
  };
  return {
    boxVersion: input.boxVersion,
    domain: venue.domain,
    venue: venueInfo(venue, extras),
    routes,
    access,
    contexts,
    hub: { games: hub },
    setupRequired: input.setupRequired,
    adminUrl: publicUrl(venue, hostFor(venue, venue.adminLabel)),
  };
}

/** Every hostname the box serves: admin, landing page, then each game. */
export function allHosts(venue: VenueSettings, games: InstalledGame[]): string[] {
  return [...new Set([hostFor(venue, venue.adminLabel), hostFor(venue, venue.playLabel), ...games.map((g) => gameHost(venue, g))])];
}
