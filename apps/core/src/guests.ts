// Box 0.19.0 (SDK 0.16.0): guest staff links. Staff give someone (a patron guest-hosting
// karaoke, a visiting KJ) the controls of one app, and nothing else on the box. The app
// declares "guests" in its manifest; the gateway turns a valid link into a cookie for that
// app only and tells the app "x-bargames-guest" (never staff). Links end at closing time (or
// after some hours), when staff revoke them, or when the admin password changes.

import type { GuestRole } from "@bargames/sdk";
import { nightStart } from "./leaderboard.js";
import type { ClosingSettings } from "./scenes.js";

export interface GuestLink {
  id: string;
  gameId: string;
  /** Who it's for, as staff typed it ("Dana – karaoke"). */
  label: string;
  role: GuestRole;
  /** A co-host's guest host (revoking the host ends the co-host too). */
  parentId?: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface GuestStore {
  links: GuestLink[];
  /** App id → guest hosts may add a co-host (venue's choice; off by default). */
  cohosts: Record<string, boolean>;
}

export const DEFAULT_GUESTS: GuestStore = { links: [], cohosts: {} };
/** Co-hosts one guest host may have at once. */
export const MAX_COHOSTS = 5;
/** Without a closing time for tonight, a link lasts this long. */
export const DEFAULT_GUEST_HOURS = 6;

const ms = (iso: string) => new Date(iso).getTime();

/** Still good: not revoked, not expired, issued after the last sign-out, and so is its host. */
export function guestActive(s: GuestStore, l: GuestLink | undefined, now = Date.now(), notBefore = 0): boolean {
  if (!l || l.revokedAt || ms(l.expiresAt) <= now || ms(l.createdAt) < notBefore) return false;
  return l.parentId ? guestActive(s, s.links.find((p) => p.id === l.parentId), now, notBefore) : true;
}

export function activeGuests(s: GuestStore, gameId?: string, now = Date.now(), notBefore = 0): GuestLink[] {
  return s.links.filter((l) => (!gameId || l.gameId === gameId) && guestActive(s, l, now, notBefore));
}

/** Drop links that ended more than a day ago (keeps the file small; recent ones stay listed). */
export function pruneGuests(s: GuestStore, now = Date.now()): GuestLink[] {
  const cut = now - 24 * 3600e3;
  return s.links.filter((l) => ms(l.expiresAt) > cut && (!l.revokedAt || ms(l.revokedAt) > cut));
}

/** Tonight's closing time (venue time zone), if one is set and still ahead. */
export function closingTonight(c: ClosingSettings | undefined, now: Date, timeZone?: string): Date | undefined {
  if (!c?.enabled) return undefined;
  const start = nightStart(now, timeZone); // 4 AM of this night's day
  const day = new Date(start.getTime() + 12 * 3600e3); // safely inside the same date
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timeZone ?? "UTC", weekday: "short" }).format(day);
  const night = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  const time = c.nights[night];
  if (!time) return undefined;
  const [h, m] = time.split(":").map(Number);
  // Same rule as the closing schedules: before noon means after midnight (the next day).
  const at = new Date(start.getTime() + ((h * 60 + m - 240) * 60e3) + (time < "12:00" ? 24 * 3600e3 : 0));
  return at.getTime() > now.getTime() ? at : undefined;
}

/** { label, hours? } from staff. hours: 1-24; absent: until closing time (or 6 hours). */
export function cleanGuestRequest(v: unknown): { label: string; hours?: number } | string {
  if (typeof v !== "object" || v === null) return "{ label, hours? }";
  const b = v as Record<string, unknown>;
  const label = typeof b.label === "string" ? b.label.trim().slice(0, 60) : "";
  if (!label) return "label: who the link is for";
  if (b.hours === undefined || b.hours === null) return { label };
  if (typeof b.hours !== "number" || !Number.isFinite(b.hours) || b.hours < 0.25 || b.hours > 24) return "hours: 0.25-24";
  return { label, hours: b.hours };
}
