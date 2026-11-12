// The venue idle screen: what a TV shows when its room closes or staff choose "Idle".
// Rendered as a self-contained data: page (no network needed by the casting browser):
// venue name, "Next game soon", the Play QR, and the Wi-Fi QR when the venue set one.
// Static on purpose: a still frame costs almost nothing to encode and stream.

import { wifiQrPayload, type VenueInfo } from "@bargames/sdk";
import QRCode from "qrcode";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function qrSvg(text: string, dark: string, light: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark, light } });
}

export interface IdleScreenInput {
  venue: VenueInfo;
  /** Display names of the games that are on. */
  games: string[];
}

export async function idleScreenHtml({ venue, games }: IdleScreenInput): Promise<string> {
  const c = venue.theme.colors;
  const news = venue.announcement && (!venue.announcement.until || Date.parse(venue.announcement.until) > Date.now()) ? venue.announcement.text : "";
  const play = venue.playUrl ? await qrSvg(venue.playUrl, "#000000", "#ffffff") : "";
  const wifi = venue.wifi?.ssid ? await qrSvg(wifiQrPayload(venue.wifi), "#000000", "#ffffff") : "";
  const logo = venue.theme.logoDarkUrl ?? venue.theme.logoUrl;
  // SDK 0.9.0: the lobby countdown ticks on the TV by itself (a tiny script; the page is otherwise static).
  const cd = venue.countdown && Date.parse(venue.countdown.endsAt) > Date.now() ? venue.countdown : undefined;
  const count = cd
    ? `<p class="count">${esc(cd.label)} <b id="cd" data-ends="${Date.parse(cd.endsAt)}"></b></p>` +
      `<script>(function(){var e=document.getElementById("cd"),t=+e.dataset.ends;function f(){var s=Math.max(0,Math.ceil((t-Date.now())/1000));e.textContent=Math.floor(s/60)+":"+String(s%60).padStart(2,"0");if(s>0)setTimeout(f,250)}f()})()</script>`
    : "";
  const champs = (venue.leaderboards ?? []).map((b) => ({ game: b.displayName, top: b.tonight.filter((p) => p.wins > 0).slice(0, 3) })).filter((b) => b.top.length);
  const winners = champs.length
    ? `<p class="winners">Tonight's winners: ${champs.map((b) => `${esc(b.game)}: ${b.top.map((p) => `<b>${esc(p.name)}</b>${p.wins > 1 ? ` ×${p.wins}` : ""}`).join(", ")}`).join(" · ")}</p>`
    : "";
  const card = (svg: string, title: string, sub: string) =>
    `<figure><div class="qr">${svg}</div><figcaption><b>${esc(title)}</b><span>${esc(sub)}</span></figcaption></figure>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(venue.name)}</title><style>
*{box-sizing:border-box;margin:0}
html,body{width:100%;height:100%;overflow:hidden;cursor:none}
body{background:${c.background};color:${c.text};font-family:${venue.theme.font ?? "system-ui, sans-serif"};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5vh;padding:5vh 5vw;text-align:center}
header img{max-height:14vh;max-width:40vw}
h1{font-size:8vh;line-height:1.1}
p.lead{font-size:4.2vh;color:${c.accent}}
p.count{font-size:5vh;font-weight:800}p.count b{color:${c.primary};font-variant-numeric:tabular-nums}
p.winners{font-size:3vh;opacity:.9}p.winners b{color:${c.primary}}
p.news{font-size:4.6vh;font-weight:700;background:${c.primary};color:#111;padding:1.6vh 3vw;border-radius:${venue.theme.radius ?? 16}px;max-width:80vw}
.row{display:flex;gap:6vw;justify-content:center}
figure{display:flex;flex-direction:column;align-items:center;gap:2vh}
.qr{background:#fff;border-radius:${venue.theme.radius ?? 16}px;padding:1.2vh;width:30vh;height:30vh}
.qr svg{width:100%;height:100%;display:block}
figcaption{display:flex;flex-direction:column;gap:.6vh}
figcaption b{font-size:3.4vh;color:${c.primary}}
figcaption span{font-size:2.6vh;opacity:.85}
footer{font-size:2.6vh;opacity:.8}
</style></head><body>
<header>${logo ? `<img src="${esc(logo)}" alt="">` : ""}<h1>${esc(venue.name)}</h1></header>
${news ? `<p class="news">${esc(news)}</p>` : count ? "" : `<p class="lead">Next game starting soon</p>`}
${count}${winners}
<div class="row">${play ? card(play, "Play", venue.playUrl!.replace(/^https?:\/\//, "")) : ""}${wifi ? card(wifi, "Wi-Fi", venue.wifi!.ssid) : ""}</div>
${games.length ? `<footer>Tonight: ${games.map(esc).join(" · ")}</footer>` : ""}
</body></html>`;
}

/** The idle page as a data: URL the broker can stream. */
export async function idleScreenUrl(input: IdleScreenInput): Promise<string> {
  return `data:text/html;charset=utf-8,${encodeURIComponent(await idleScreenHtml(input))}`;
}
