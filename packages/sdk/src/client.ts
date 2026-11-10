// @bargames/sdk/client: browser helpers. No framework dependency; see docs/SDK.md
// for a 10-line React hook built on these.

import { PATHS, type VenueContext } from "./protocol.js";
import { themeCssVars } from "./theme.js";

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

export type { VenueContext } from "./protocol.js";
