import type { GatewayConfig, GatewayRoute, HubGame } from "@bargames/common";
import { PROTOCOL_VERSION, withAccent, type VenueContext, type VenueInfo } from "@bargames/sdk";
import { hostFor, publicUrl } from "./hostnames.js";
import type { AccessSettings, InstalledGame, VenueSettings } from "./state.js";

export function venueInfo(v: VenueSettings): VenueInfo {
  return { name: v.name, theme: v.theme, wifi: v.wifi, playUrl: publicUrl(v, hostFor(v, v.playLabel)) };
}

export function gameHost(v: VenueSettings, g: InstalledGame): string {
  return hostFor(v, g.hostnameAlias ?? g.id);
}

export function buildContext(v: VenueSettings, g: InstalledGame): VenueContext {
  return {
    protocol: PROTOCOL_VERSION,
    venue: venueInfo(v),
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
}): GatewayConfig {
  const { venue, access, games } = input;
  const routes: GatewayRoute[] = [
    { host: hostFor(venue, venue.adminLabel), kind: "admin", target: input.coreUrl, enabled: true, injectTheme: false },
    { host: hostFor(venue, venue.playLabel), kind: "hub", enabled: true, injectTheme: false },
  ];
  const contexts: Record<string, VenueContext> = {};
  const hub: HubGame[] = [];
  for (const g of games) {
    const host = gameHost(venue, g);
    routes.push({ host, kind: "game", gameId: g.id, target: gameTarget(g), enabled: g.enabled, injectTheme: g.manifest.sdk.level === 0 });
    const ctx = buildContext(venue, g);
    contexts[g.id] = ctx;
    hub.push({ id: g.id, displayName: ctx.game.displayName, tagline: ctx.game.tagline, iconUrl: ctx.game.iconUrl, url: ctx.game.publicUrl!, enabled: g.enabled });
  }
  contexts._hub = {
    protocol: PROTOCOL_VERSION,
    venue: venueInfo(venue),
    game: { id: "_hub", displayName: venue.name, theme: venue.theme },
    standalone: false,
    generatedAt: new Date().toISOString(),
  };
  return {
    boxVersion: input.boxVersion,
    domain: venue.domain,
    venue: venueInfo(venue),
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
