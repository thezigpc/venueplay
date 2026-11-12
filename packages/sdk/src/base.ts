// Running a game under a path prefix (SDK 0.10.0): https://venue.example.com/bingo/…
//
// The reverse proxy in front (the Bar Games box gateway, or a self-hoster's own nginx /
// Caddy / Traefik) strips the prefix, so the game's server keeps its routes ("/api",
// "/admin", "/socket.io"). The pages need the prefix for the links they build:
//   - server: inject it into the HTML it serves  → injectBasePath(html, base)
//   - client: read it back                         → basePath(), bgUrl("/api/x")
// The prefix comes from one setting: BG_BASE_PATH (set by the box) or BASE_PATH (set by a
// self-hoster). Unset: "" (the root), exactly as before.

/** The meta tag carrying the prefix in a game's HTML. */
export const BASE_META = "bargames-base";

/** "bingo", "/bingo/", "/a/b" → "/bingo", "/bingo", "/a/b"; "", "/", junk → "". */
export function normalizeBasePath(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  if (!s || s === "/") return "";
  const withSlash = (s.startsWith("/") ? s : `/${s}`).replace(/\/+$/, "");
  return /^(\/[A-Za-z0-9._~-]+)+$/.test(withSlash) ? withSlash : "";
}

/** The prefix from the environment (server): BG_BASE_PATH, else BASE_PATH, else "". */
export function basePathFromEnv(env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}): string {
  return normalizeBasePath(env.BG_BASE_PATH || env.BASE_PATH);
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Adds `<meta name="bargames-base" content="/bingo">` and `<base href="/bingo/">` right after
 * `<head>`, so the page knows its prefix and relative asset URLs resolve under it. With no
 * prefix the HTML is returned untouched. Safe to call twice.
 */
export function injectBasePath(html: string, base: string): string {
  const b = normalizeBasePath(base);
  if (!b || html.includes(`name="${BASE_META}"`)) return html;
  const tags = `<meta name="${BASE_META}" content="${escAttr(b)}"><base href="${escAttr(b)}/">`;
  const m = /<head[^>]*>/i.exec(html);
  return m ? html.slice(0, m.index + m[0].length) + tags + html.slice(m.index + m[0].length) : tags + html;
}

/** The page's prefix (browser), from the meta tag the server injected. "" when there's none. */
export function basePath(doc?: Document): string {
  const d = doc ?? (typeof document === "undefined" ? undefined : document);
  const meta = d?.querySelector?.(`meta[name="${BASE_META}"]`);
  return normalizeBasePath(meta?.getAttribute("content"));
}

/** An absolute path on this game, with its prefix: bgUrl("/api/rooms") → "/bingo/api/rooms". Other URLs pass through. */
export function bgUrl(path: string, doc?: Document): string {
  return path.startsWith("/") && !path.startsWith("//") ? basePath(doc) + path : path;
}

/** socket.io's path option for this game: "/bingo/socket.io" (or "/socket.io" at the root). */
export function socketIoPath(doc?: Document): string {
  return `${basePath(doc)}/socket.io`;
}

/**
 * A path on an address that may carry a prefix: joinUrl("https://v.example.com/bingo", "/join/AB")
 * → "https://v.example.com/bingo/join/AB". (new URL("/join/AB", base) would drop "/bingo".)
 */
export function joinUrl(base: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) return new URL(path, base).toString();
  const u = new URL(base);
  return u.origin + u.pathname.replace(/\/+$/, "") + path;
}
