// Box 0.31.0: the box's own screens tell apps who they are (SDK 0.20.0 bg.screen(req)).
// The broker sets a signed cookie in its own Chromium for the site it shows; the gateway
// checks it with the same key (core derives it from the broker token and hands the gateway
// only the key), strips it, and sends the app x-bargames-screen.

import { SCREEN_COOKIE, signScreen } from "@bargames/common";
import type { DisplayDevice } from "./types.js";

/** Cookies last a month and are set again on every show and page load, so a screen never loses it. */
export const SCREEN_COOKIE_TTL_MS = 30 * 24 * 3600_000;

/** CDP Network.setCookie parameters for this screen on this page's site, or undefined (not http(s), no key). */
export function screenCookieParams(key: string | undefined, device: DisplayDevice, url: string, now = Date.now()): Record<string, unknown> | undefined {
  if (!key) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const label = (device as DisplayDevice & { label?: string }).label;
  const expiresAt = now + SCREEN_COOKIE_TTL_MS;
  return {
    name: SCREEN_COOKIE,
    value: signScreen(key, { id: device.id, name: label || device.name, touch: device.touch === true }, expiresAt),
    url: u.origin,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: u.protocol === "https:",
    expires: Math.floor(expiresAt / 1000),
  };
}
