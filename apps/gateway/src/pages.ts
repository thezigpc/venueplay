// Branded pages the gateway renders itself. Inline CSS only (no external requests).

import type { HubGame } from "@bargames/common";
import { activeAnnouncement, themeToCss, type VenueContext, type VenueInfo } from "@bargames/sdk";

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(venue: VenueInfo | undefined, title: string, body: string): string {
  const theme = venue ? themeToCss(venue.theme) : ":root{--venue-bg:#101528;--venue-surface:#1c2346;--venue-text:#f4f6ff;--venue-primary:#f2b33d;--venue-accent:#4cc9f0}";
  const logo = venue?.theme.logoUrl ? `<img class="logo" src="${esc(venue.theme.logoUrl)}" alt="">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${theme}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--venue-bg);color:var(--venue-text);font-family:var(--venue-font,system-ui,sans-serif)}
main{width:100%;max-width:440px;text-align:center}.logo{max-width:160px;max-height:80px;margin-bottom:16px}
h1{font-size:1.6rem;margin:0 0 8px}p{opacity:.85;line-height:1.5}.card{background:var(--venue-surface);border-radius:var(--venue-radius,12px);padding:20px;margin-top:16px}
.ssid{font-size:1.3rem;font-weight:700;color:var(--venue-primary)}input{font-size:1.6rem;letter-spacing:.3em;text-align:center;width:100%;padding:12px;border-radius:10px;border:0;margin:12px 0}
button,.btn{display:block;width:100%;padding:14px;border:0;border-radius:10px;background:var(--venue-primary);color:#111;font-weight:700;font-size:1.05rem;text-decoration:none}
.games{display:grid;gap:12px;margin-top:16px}.game{display:block;text-align:left;background:var(--venue-surface);border-radius:var(--venue-radius,12px);padding:16px;color:inherit;text-decoration:none;border-left:6px solid var(--venue-accent)}
.game b{font-size:1.15rem}.game span{display:block;opacity:.75;margin-top:4px}.err{color:#ff8a8a}
.entry{background:var(--venue-surface);border-radius:var(--venue-radius,12px);border-left:6px solid var(--venue-accent);overflow:hidden}.entry .game{border-left:0;background:none}
.rooms{list-style:none;margin:0;padding:0 16px 12px;text-align:left}.rooms li{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid rgba(127,127,127,.25)}
.rooms .code{font-weight:700;letter-spacing:.08em}.rooms .who{opacity:.75;flex:1}.rooms a{padding:6px 14px;border-radius:8px;background:var(--venue-primary);color:#111;font-weight:700;text-decoration:none}
.modules{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:12px 0}.module{background:var(--venue-primary);color:var(--venue-on-primary,#111);font-weight:700;text-decoration:none;border-radius:999px;padding:10px 20px}
.news{background:var(--venue-primary);color:var(--venue-on-primary,#111);font-weight:700;border-radius:var(--venue-radius,12px);padding:12px 16px;margin:12px 0}
</style></head><body><main>${logo}${body}</main></body></html>`;
}

export function joinWifiPage(venue: VenueInfo | undefined): string {
  const ssid = venue?.wifi?.ssid;
  return page(
    venue,
    "Join the Wi-Fi to play",
    `<h1>Join the Wi-Fi to play</h1><p>Games at ${esc(venue?.name ?? "this venue")} are only available on the venue's Wi-Fi.</p>` +
      (ssid ? `<div class="card"><p>Connect to</p><div class="ssid">${esc(ssid)}</div><p>then scan the Play code again.</p></div>` : ""),
  );
}

export function pinPage(venue: VenueInfo | undefined, returnTo: string, error = false): string {
  return page(
    venue,
    "Enter the venue PIN",
    `<h1>Enter the venue PIN</h1><p>You'll find it on the TV screens or ask the staff.</p>
<form class="card" method="post" action="/__bargames/pin"><input type="hidden" name="to" value="${esc(returnTo)}">
<input name="pin" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="8" autofocus required>
${error ? '<p class="err">That PIN didn\'t work.</p>' : ""}<button>Continue</button></form>`,
  );
}

export function closedPage(venue: VenueInfo | undefined, gameName: string, playUrl?: string): string {
  return page(
    venue,
    `${gameName}: not in session`,
    `<h1>${esc(gameName)} isn't running right now</h1><p>Check back during game time.</p>${playUrl ? `<a class="btn" href="${esc(playUrl)}">See what's on</a>` : ""}`,
  );
}

function hubRooms(g: HubGame): string {
  const rooms = g.rooms ?? [];
  if (!rooms.length) return "";
  const li = rooms
    .map(
      (r) =>
        `<li><span class="code">${esc(r.code)}</span><span class="who">${esc(r.title ? `${r.title} · ` : "")}${r.players} ${r.players === 1 ? "player" : "players"}</span>` +
        `${r.joinUrl ? `<a href="${esc(r.joinUrl)}">Join</a>` : ""}</li>`,
    )
    .join("");
  return `<ul class="rooms" aria-label="Open rooms">${li}</ul>`;
}

export function hubPage(venue: VenueInfo | undefined, games: HubGame[]): string {
  const isApp = (g: HubGame) => g.kind === "app" || g.kind === "display";
  const live = games.filter((g) => g.enabled && !isApp(g));
  const modules = games.filter((g) => g.enabled && isApp(g));
  const moduleLinks = modules.length
    ? `<nav class="modules">${modules.map((m) => `<a class="module" href="${esc(m.url)}">${esc(m.displayName)}</a>`).join("")}</nav>`
    : "";
  const list = live.length
    ? `<div class="games">${live
        .map((g) => `<div class="entry"><a class="game" href="${esc(g.url)}"><b>${esc(g.displayName)}</b>${g.tagline ? `<span>${esc(g.tagline)}</span>` : ""}</a>${hubRooms(g)}</div>`)
        .join("")}</div>`
    : `<div class="card"><p>No games are running right now.</p></div>`;
  const news = venue ? activeAnnouncement({ venue, standalone: false } as VenueContext) : undefined;
  return page(
    venue,
    venue?.name ?? "Games",
    `<h1>${esc(venue?.name ?? "Games")}</h1>${news ? `<div class="news" role="status">${esc(news.text)}</div>` : ""}${moduleLinks}<p>Pick a game to start a room, or join one that's open.</p>${list}`,
  );
}

export function simplePage(venue: VenueInfo | undefined, title: string, text: string): string {
  return page(venue, title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);
}
