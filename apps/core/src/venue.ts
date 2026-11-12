import type { GatewayConfig, GatewayRoute, HubGame, HubRoom } from "@bargames/common";
import { isApp, PROTOCOL_VERSION, withAccent, type Announcement, type Countdown, type LeaderboardSummary, type VenueContext, type VenueGameLink, type VenueInfo } from "@bargames/sdk";
import { hostFor, publicUrl } from "./hostnames.js";
import type { AccessSettings, InstalledGame, VenueSettings } from "./state.js";

/** What every game hears about the venue around it (SDK 0.4.0): the lineup and the announcement. */
export interface VenueExtras {
  /** All installed games; only enabled ones are listed. */
  games?: InstalledGame[];
  announcement?: Partial<Announcement>;
  /** SDK 0.9.0 */
  countdown?: Partial<Countdown>;
  leaderboards?: LeaderboardSummary[];
}

export function venueInfo(v: VenueSettings, extras: VenueExtras = {}): VenueInfo {
  const info: VenueInfo = { name: v.name, theme: v.theme, wifi: v.wifi, playUrl: publicUrl(v, hostFor(v, v.playLabel)), adminUrl: adminUrl(v) };
  if (extras.games) {
    const on = extras.games.filter((g) => g.enabled);
    // Apps (menus…) are listed apart, so games' "Also playing" skips them.
    info.games = on.filter((g) => !isApp(g.manifest)).map((g) => gameLink(v, g));
    info.apps = on.filter((g) => isApp(g.manifest)).map((g) => gameLink(v, g));
    info.modules = info.apps; // SDK 0.5.0 name
  }
  if (v.location) info.location = v.location;
  if (v.timezone) info.timezone = v.timezone;
  if (v.units) info.units = v.units;
  const a = liveAnnouncement(extras.announcement);
  if (a) info.announcement = a;
  const c = extras.countdown;
  if (c?.id && c.label && c.endsAt && Date.parse(c.endsAt) > Date.now()) info.countdown = c as Countdown;
  if (extras.leaderboards?.length) info.leaderboards = extras.leaderboards;
  return info;
}

/** The announcement, unless it's empty or past its time. */
export function liveAnnouncement(a: Partial<Announcement> | undefined, now = Date.now()): Announcement | undefined {
  if (!a?.id || !a.text) return undefined;
  if (a.until && Date.parse(a.until) <= now) return undefined;
  return { id: a.id, text: a.text, ...(a.until ? { until: a.until } : {}), ...(a.show ? { show: a.show } : {}), ...(a.position ? { position: a.position } : {}) };
}

function gameLink(v: VenueSettings, g: InstalledGame): VenueGameLink {
  const link: VenueGameLink = { id: g.id, displayName: g.branding.displayName ?? g.manifest.name, url: gameUrl(v, g) };
  if (g.branding.tagline) link.tagline = g.branding.tagline;
  if (g.branding.iconUrl) link.iconUrl = g.branding.iconUrl;
  return link;
}

/**
 * Path routing (SDK 0.10.0): the prefix a game is served under on the play hostname
 * ("/bingo"), or undefined when it has its own hostname (no support declared, or the venue
 * chose a hostname for it).
 */
export function gamePath(g: InstalledGame): string | undefined {
  return g.manifest.routing?.basePath && !g.ownHostname ? `/${g.hostnameAlias ?? g.id}` : undefined;
}

/** The hostname that serves a game: the play hostname for path-routed games. */
export function gameHost(v: VenueSettings, g: InstalledGame): string {
  return gamePath(g) ? hostFor(v, v.playLabel) : hostFor(v, g.hostnameAlias ?? g.id);
}

/** The game's own subdomain, whether or not it's served there now (old links redirect from it). */
export function gameSubdomain(v: VenueSettings, g: InstalledGame): string {
  return hostFor(v, g.hostnameAlias ?? g.id);
}

/** The game's address: https://play.example.com/bingo, or https://bingo.example.com. */
export function gameUrl(v: VenueSettings, g: InstalledGame): string {
  return publicUrl(v, gameHost(v, g)) + (gamePath(g) ?? "");
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
      publicUrl: gameUrl(v, g),
      ...(gamePath(g) ? { basePath: gamePath(g) } : {}),
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
  countdown?: Partial<Countdown>;
  leaderboards?: LeaderboardSummary[];
  /** Open rooms per game id, for the games list (from the room cache). */
  rooms?: Record<string, HubRoom[]>;
}): GatewayConfig {
  const { venue, access, games } = input;
  const extras: VenueExtras = { games, announcement: input.announcement, countdown: input.countdown, leaderboards: input.leaderboards };
  const routes: GatewayRoute[] = [
    // The admin: /admin on the games list's hostname (default), or its own hostname.
    venue.adminOwnHost
      ? { host: hostFor(venue, venue.adminLabel), kind: "admin", target: input.coreUrl, enabled: true, injectTheme: false }
      : { host: hostFor(venue, venue.playLabel), path: "/admin", kind: "admin", target: input.coreUrl, enabled: true, injectTheme: false },
    { host: hostFor(venue, venue.playLabel), kind: "hub", enabled: true, injectTheme: false },
  ];
  // The admin moved to /admin: its old hostname redirects there while it still resolves.
  if (!venue.adminOwnHost && hostFor(venue, venue.adminLabel) !== hostFor(venue, venue.playLabel)) {
    routes.push({ host: hostFor(venue, venue.adminLabel), kind: "admin", enabled: true, injectTheme: false, redirectTo: adminUrl(venue) });
  }
  const contexts: Record<string, VenueContext> = {};
  const hub: HubGame[] = [];
  for (const g of games) {
    const host = gameHost(venue, g);
    const path = gamePath(g);
    routes.push({ host, ...(path ? { path } : {}), kind: "game", gameId: g.id, target: gameTarget(g), enabled: g.enabled, injectTheme: g.manifest.sdk.level === 0 });
    // Moved to a path: its old subdomain redirects there while it still resolves (its DNS
    // record is no longer kept, so this only lasts on a LAN name or a wildcard record).
    const old = gameSubdomain(venue, g);
    if (path && old !== host) routes.push({ host: old, kind: "game", gameId: g.id, enabled: g.enabled, injectTheme: false, redirectTo: gameUrl(venue, g) });
    const ctx = buildContext(venue, g, extras);
    contexts[g.id] = ctx;
    hub.push({ id: g.id, displayName: ctx.game.displayName, tagline: ctx.game.tagline, iconUrl: ctx.game.iconUrl, url: ctx.game.publicUrl!, enabled: g.enabled, kind: isApp(g.manifest) ? "app" : "game", rooms: input.rooms?.[g.id] });
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
    adminUrl: adminUrl(venue),
  };
}

/** Every hostname the box serves: admin, landing page, then each game. */
export function allHosts(venue: VenueSettings, games: InstalledGame[]): string[] {
  return [...new Set([...(venue.adminOwnHost ? [hostFor(venue, venue.adminLabel)] : []), hostFor(venue, venue.playLabel), ...games.map((g) => gameHost(venue, g))])];
}

/** The admin's address: https://play.example.com/admin, or its own hostname. */
export function adminUrl(venue: VenueSettings): string {
  return venue.adminOwnHost ? publicUrl(venue, hostFor(venue, venue.adminLabel)) : `${publicUrl(venue, hostFor(venue, venue.playLabel))}/admin`;
}
