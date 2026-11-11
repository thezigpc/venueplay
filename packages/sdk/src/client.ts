// @bargames/sdk/client: browser helpers. No framework dependency; see docs/SDK.md
// for a 10-line React hook built on these.

import { PATHS, type VenueContext } from "./protocol.js";
import { themeCssVars } from "./theme.js";
import { activeAnnouncement, GAMES_LINK_CSS, gamesLinkHtml, type GamesLinkOptions } from "./links.js";

let cache: Promise<VenueContext | null> | undefined;

export interface VenueOptions {
  /**
   * Origin of the game server when the page isn't served by it (e.g. a Vite dev
   * server on another port). Default: the page's own origin.
   */
  base?: string;
}

/**
 * Loads the venue context from the game server. Resolves null when the server
 * doesn't run the SDK middleware or can't be reached.
 */
export function getVenue(opts: VenueOptions & { refresh?: boolean } = {}): Promise<VenueContext | null> {
  if (!cache || opts.refresh) {
    const url = opts.base ? new URL(PATHS.venue, opts.base).toString() : PATHS.venue;
    cache = fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<VenueContext>) : null))
      .catch(() => null);
  }
  return cache;
}

/** True when the game is running on a Bar Games box (not standalone). */
export function isOnBox(ctx: VenueContext | null | undefined): ctx is VenueContext {
  return Boolean(ctx && !ctx.standalone);
}

/**
 * Sets the --venue-* CSS variables (and optionally the page title) from the context.
 * Does nothing standalone, so a game off a box keeps its own look (your CSS
 * fallbacks apply). Pass force: true to apply the default theme anyway.
 */
export function applyTheme(ctx: VenueContext | null | undefined, opts: { root?: HTMLElement; title?: boolean; force?: boolean } = {}): void {
  if (!ctx || (ctx.standalone && !opts.force)) return;
  const root = opts.root ?? document.documentElement;
  for (const [k, v] of Object.entries(themeCssVars(ctx.game.theme))) root.style.setProperty(k, v);
  if (opts.title) document.title = ctx.game.displayName;
}

/** The venue's name for this game, or the fallback when unbranded. */
export function gameName(ctx: VenueContext | null, fallback: string): string {
  return ctx && !ctx.standalone ? ctx.game.displayName : fallback;
}

/**
 * Calls fn with the venue context now and whenever branding changes (polls every
 * intervalMs). Only on a box: standalone, fn is never called. Returns a stop function.
 */
export function watchVenue(fn: (ctx: VenueContext) => void, opts: number | (VenueOptions & { intervalMs?: number }) = {}): () => void {
  const { intervalMs = 60_000, base } = typeof opts === "number" ? { intervalMs: opts, base: undefined } : opts;
  let last = "";
  let stopped = false;
  const tick = async (refresh: boolean) => {
    const ctx = await getVenue({ refresh, base });
    if (stopped || !isOnBox(ctx)) return;
    const key = JSON.stringify({ v: ctx.venue, g: ctx.game });
    if (key !== last) {
      last = key;
      fn(ctx);
    }
  };
  void tick(false);
  const timer = setInterval(() => void tick(true), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Absolute join link for a room, using the game's public origin when known. */
export function joinUrl(ctx: VenueContext | null, path: string): string {
  const base = ctx?.game.publicUrl ?? location.origin;
  return new URL(path, base).toString();
}

export type TableState = "connected" | "reconnecting" | "closed";

export interface TableModeController {
  /** Show the standard banner: "reconnecting" (top strip) or "closed" (full screen). */
  setState(state: TableState, message?: string): void;
  /** Undo everything tableMode did. */
  stop(): void;
}

const NOOP: TableModeController = { setState: () => undefined, stop: () => undefined };

/**
 * For the table (TV) view. On a box it:
 *  - hides the mouse pointer (nobody can use one on a cast TV);
 *  - keeps the screen awake (Wake Lock, re-taken when the page becomes visible);
 *  - sets --bg-safe-x / --bg-safe-y (5% margins) for your layout;
 *  - gives you a standard "Reconnecting…" strip and "Room closed" screen via setState().
 * Off a box it does nothing and setState is a no-op (rule 1), unless always: true.
 */
export function tableMode(ctx: VenueContext | null | undefined, opts: { always?: boolean; doc?: Document } = {}): TableModeController {
  if (!isOnBox(ctx) && !opts.always) return NOOP;
  const doc = opts.doc ?? document;
  const style = doc.createElement("style");
  style.dataset.bargames = "table";
  style.textContent = [
    ":root{--bg-safe-x:5vw;--bg-safe-y:5vh}",
    "html,body,*{cursor:none!important}",
    "#bargames-table-banner{position:fixed;z-index:2147483647;left:0;right:0;font:600 3.2vh/1.3 system-ui,sans-serif;text-align:center;color:#fff;pointer-events:none}",
    "#bargames-table-banner[data-state=reconnecting]{top:0;padding:1.2vh;background:rgba(180,90,0,.92)}",
    "#bargames-table-banner[data-state=closed]{inset:0;display:flex;align-items:center;justify-content:center;font-size:6vh;background:var(--venue-bg,#101528)}",
  ].join("\n");
  doc.head.appendChild(style);
  const banner = doc.createElement("div");
  banner.id = "bargames-table-banner";
  banner.hidden = true;
  doc.body.appendChild(banner);

  type Sentinel = { release(): Promise<void> };
  let lock: Sentinel | undefined;
  const nav = (doc.defaultView?.navigator ?? (globalThis as { navigator?: Navigator }).navigator) as (Navigator & { wakeLock?: { request(t: "screen"): Promise<Sentinel> } }) | undefined;
  const wake = () => {
    if (doc.visibilityState !== "visible" || !nav?.wakeLock) return;
    nav.wakeLock.request("screen").then((l) => (lock = l), () => undefined);
  };
  wake();
  doc.addEventListener("visibilitychange", wake);

  return {
    setState(state, message) {
      banner.hidden = state === "connected";
      banner.dataset.state = state;
      banner.textContent = state === "connected" ? "" : (message ?? (state === "reconnecting" ? "Reconnecting…" : "This room has closed"));
    },
    stop() {
      doc.removeEventListener("visibilitychange", wake);
      void lock?.release().catch(() => undefined);
      style.remove();
      banner.remove();
    },
  };
}

export interface GamesLinkController {
  /** Re-render from a newer context (e.g. from watchVenue). */
  update(ctx: VenueContext | null | undefined): void;
  /** Remove the link and its CSS. */
  remove(): void;
}

/**
 * For your landing page only (not during play, never on the TV view): adds a
 * "← All games" link back to the venue's games list, with "Also playing: …" under it,
 * at the end of `container` (default document.body). Styled from the venue theme.
 * Off a box it adds nothing (rule 1); it also stays empty on a box that sent no games
 * list address. Prefer your own markup? Use gamesListUrl() / otherGames() instead.
 */
export function gamesLink(
  ctx: VenueContext | null | undefined,
  opts: GamesLinkOptions & { container?: HTMLElement; doc?: Document } = {},
): GamesLinkController {
  const doc = opts.doc ?? document;
  let nav: HTMLElement | undefined;
  let style: HTMLStyleElement | undefined;
  const render = (c: VenueContext | null | undefined) => {
    const html = gamesLinkHtml(c, opts);
    if (!html) return void (nav && (nav.hidden = true));
    if (!nav) {
      style = doc.createElement("style");
      style.dataset.bargames = "games-link";
      style.textContent = GAMES_LINK_CSS;
      doc.head.appendChild(style);
      nav = doc.createElement("nav");
      nav.className = "bargames-games-link";
      nav.setAttribute("aria-label", "Venue games");
      (opts.container ?? doc.body).appendChild(nav);
    }
    nav.hidden = false;
    nav.innerHTML = html;
  };
  render(ctx);
  return {
    update: render,
    remove() {
      nav?.remove();
      style?.remove();
      nav = style = undefined;
    },
  };
}

export interface AnnouncementController {
  update(ctx: VenueContext | null | undefined): void;
  remove(): void;
}

/**
 * Shows the staff's announcement as a strip at the top of the page (sticky, so it stays
 * in view and never covers your layout), with a close
 * button (dismissed per message, for this browser tab's session). Hides itself when the
 * announcement expires or the staff take it down. Feed it newer contexts with update()
 * (watchVenue). Off a box it shows nothing (rule 1).
 */
export function announcementBanner(ctx: VenueContext | null | undefined, opts: { doc?: Document; storage?: Pick<Storage, "getItem" | "setItem"> } = {}): AnnouncementController {
  const doc = opts.doc ?? document;
  const store = opts.storage ?? (() => {
    try {
      return sessionStorage;
    } catch {
      return undefined;
    }
  })();
  const KEY = "bargames.dismissed";
  const dismissed = () => {
    try {
      return store?.getItem(KEY) ?? "";
    } catch {
      return "";
    }
  };
  let el: HTMLElement | undefined;
  let style: HTMLStyleElement | undefined;
  let current: VenueContext | null | undefined = ctx;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const render = () => {
    if (timer) clearTimeout(timer);
    const a = activeAnnouncement(current);
    if (!a || dismissed() === a.id) return void (el && (el.hidden = true));
    if (!el) {
      style = doc.createElement("style");
      style.dataset.bargames = "announcement";
      style.textContent =
        "#bargames-announcement{position:sticky;z-index:2147483646;top:0;margin:0;display:flex;gap:12px;align-items:center;justify-content:center;padding:10px 48px 10px 16px;" +
        "background:var(--venue-primary,#f2b33d);color:#111;font:600 15px/1.4 var(--venue-font,system-ui,sans-serif);text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)}" +
        "#bargames-announcement[hidden]{display:none}#bargames-announcement button{all:unset;box-sizing:border-box;position:absolute;right:6px;top:50%;transform:translateY(-50%);width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:50%;color:inherit;font:400 24px/1 system-ui,sans-serif;cursor:pointer}#bargames-announcement button:focus-visible{outline:2px solid currentColor}";
      doc.head.appendChild(style);
      el = doc.createElement("div");
      el.id = "bargames-announcement";
      el.setAttribute("role", "status");
      // First in the page and sticky: pushes the game down instead of covering it.
      if (typeof doc.body.prepend === "function") doc.body.prepend(el);
      else doc.body.appendChild(el);
    }
    el.hidden = false;
    el.textContent = a.text;
    const close = doc.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.onclick = () => {
      try {
        store?.setItem(KEY, a.id);
      } catch {
        /* storage blocked: dismissed until reload */
      }
      if (el) el.hidden = true;
    };
    el.appendChild(close);
    if (a.until) timer = setTimeout(render, Math.min(Math.max(Date.parse(a.until) - Date.now(), 0) + 50, 2 ** 31 - 1));
  };
  render();
  return {
    update(c) {
      current = c;
      render();
    },
    remove() {
      if (timer) clearTimeout(timer);
      el?.remove();
      style?.remove();
      el = style = undefined;
    },
  };
}

export { activeAnnouncement, gamesLinkHtml, gamesListUrl, otherGames, GAMES_LINK_CSS, type GamesLinkOptions } from "./links.js";
export type { Announcement, VenueGameLink } from "./protocol.js";
export type { VenueContext } from "./protocol.js";
