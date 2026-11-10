import type { VenueSettings } from "./state.js";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const isLabel = (s: string) => LABEL.test(s);

export function renderHostname(pattern: string, vars: { game: string; venue: string; domain: string }): string {
  const host = pattern
    .replace(/\{game\}/g, vars.game)
    .replace(/\{venue\}/g, vars.venue)
    .replace(/\{domain\}/g, vars.domain)
    .toLowerCase();
  const labels = host.split(".");
  if (!labels.every(isLabel)) throw new Error(`invalid hostname "${host}" from pattern "${pattern}"`);
  return host;
}

/** Problems with a pattern, e.g. missing tokens. */
export function checkPattern(pattern: string): string[] {
  const problems: string[] = [];
  if (!pattern.includes("{game}")) problems.push("pattern must contain {game}");
  if (!pattern.endsWith("{domain}")) problems.push("pattern must end with {domain}");
  const unknown = pattern.match(/\{(?!game\}|venue\}|domain\})[^}]*\}/g);
  if (unknown) problems.push(`unknown tokens: ${unknown.join(", ")}`);
  return problems;
}

/**
 * Cloudflare's free Universal SSL covers the zone and one level below it
 * (*.example.com). Deeper names need Advanced Certificate Manager.
 */
export function certificateWarning(hostname: string, zone: string): string | undefined {
  if (zone === "localhost") return undefined;
  if (!hostname.endsWith(`.${zone}`)) return `${hostname} is not inside the zone ${zone}`;
  const depth = hostname.slice(0, -zone.length - 1).split(".").length;
  return depth > 1
    ? `${hostname} is ${depth} levels below ${zone}; Cloudflare's free certificate only covers one level. Use Advanced Certificate Manager or a one-level pattern.`
    : undefined;
}

export function hostFor(venue: VenueSettings, label: string): string {
  return renderHostname(venue.hostnamePattern, { game: label, venue: venue.slug, domain: venue.domain });
}

export function publicUrl(venue: VenueSettings, host: string): string {
  const port = venue.publicPort ? `:${venue.publicPort}` : "";
  return `${venue.publicScheme}://${host}${port}`;
}
