import { PROTOCOL_VERSION, type VenueContext } from "./protocol.js";
import { DEFAULT_THEME } from "./theme.js";

/** The context a game sees when it runs on its own (not on a box). */
export function standaloneContext(gameId: string, displayName: string): VenueContext {
  return {
    protocol: PROTOCOL_VERSION,
    venue: { name: displayName, theme: DEFAULT_THEME },
    game: { id: gameId, displayName, theme: DEFAULT_THEME },
    standalone: true,
    generatedAt: new Date().toISOString(),
  };
}

/** Builds a WIFI: QR payload (the format phone cameras understand). */
export function wifiQrPayload(wifi: { ssid: string; password?: string; security?: string }): string {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, "\\$1");
  const type = wifi.password ? wifi.security ?? "WPA" : "nopass";
  return `WIFI:T:${type};S:${esc(wifi.ssid)};${wifi.password ? `P:${esc(wifi.password)};` : ""};`;
}
