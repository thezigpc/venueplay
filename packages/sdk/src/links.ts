// The venue around a game: its games list, the other games on tonight, and staff
// announcements. Plain functions over the venue context, safe in browsers and Node
// (the box's gateway renders the same games link for games without the SDK).
// Off a box every helper returns "nothing", so a standalone game shows none of it.

import type { Announcement, VenueContext, VenueGameLink } from "./protocol.js";

const onBox = (ctx: VenueContext | null | undefined): ctx is VenueContext => Boolean(ctx && !ctx.standalone);

/** The venue's games list, or undefined off a box (or on a box older than SDK 0.4.0 that has none). */
export function gamesListUrl(ctx: VenueContext | null | undefined): string | undefined {
  return onBox(ctx) ? ctx.venue.playUrl : undefined;
}

/** The venue's other games on tonight (this one left out). Empty off a box. */
export function otherGames(ctx: VenueContext | null | undefined): VenueGameLink[] {
  return onBox(ctx) ? (ctx.venue.games ?? []).filter((g) => g.id !== ctx.game.id) : [];
}

/** The staff's current announcement, unless it has expired. Undefined off a box. */
export function activeAnnouncement(ctx: VenueContext | null | undefined, now = Date.now()): Announcement | undefined {
  const a = onBox(ctx) ? ctx.venue.announcement : undefined;
  if (!a?.text) return undefined;
  return a.until && Date.parse(a.until) <= now ? undefined : a;
}

/**
 * Hides an announcement element on shared screens (pages marked by tableMode() or
 * markSharedScreen()). For your own announcement markup: give it class "bargames-announcement".
 */
export const ANNOUNCEMENT_HIDE_CSS = "html[data-bargames-screen=shared] .bargames-announcement{display:none!important}";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface GamesLinkOptions {
  /** Link text. Default "← All games". */
  label?: string;
  /** Also list the other games on tonight ("Also playing: Bingo · Pool"). Default true. */
  alsoPlaying?: boolean;
}

/** CSS for the games link; scoped to .bargames-games-link and themed by the --venue-* variables. */
export const GAMES_LINK_CSS =
  ".bargames-games-link{display:block;margin:32px auto 16px;padding:0 16px;max-width:640px;text-align:center;font:500 15px/1.5 var(--venue-font,system-ui,sans-serif);color:var(--venue-text,inherit)}" +
  ".bargames-games-link[hidden]{display:none}.bargames-games-link a{color:inherit}" +
  ".bargames-games-link .bg-all{display:inline-block;padding:10px 18px;border-radius:var(--venue-radius,10px);background:var(--venue-surface,rgba(127,127,127,.15));text-decoration:none;font-weight:600}" +
  ".bargames-games-link .bg-also{margin:10px 0 0;opacity:.8;font-size:14px}";

/**
 * The games link's HTML (no wrapper element, no CSS), or "" off a box / when the box
 * didn't send a games list address. Escaped; safe to put in innerHTML.
 */
export function gamesLinkHtml(ctx: VenueContext | null | undefined, opts: GamesLinkOptions = {}): string {
  const url = gamesListUrl(ctx);
  if (!url) return "";
  const also = opts.alsoPlaying === false ? [] : otherGames(ctx);
  const alsoHtml = also.length ? `<p class="bg-also">Also playing: ${also.map((g) => `<a href="${esc(g.url)}">${esc(g.displayName)}</a>`).join(" · ")}</p>` : "";
  return `<a class="bg-all" href="${esc(url)}">${esc(opts.label ?? "← All games")}</a>${alsoHtml}`;
}
