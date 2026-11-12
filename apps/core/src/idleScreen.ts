// The venue idle screen: what a TV shows when its room closes or staff choose "Idle".
// Rendered as a self-contained data: page the broker streams: venue name, "Next game
// soon", the Play QR, and the Wi-Fi QR when the venue set one.
//
// Box 0.12.0: the announcement and the lobby countdown are filled in live by a small script
// that follows the gateway's /__bargames/live.json (held until something changes). The page
// itself stays the same, so an announcement no longer restarts the TV's stream. Without a
// public address to follow (no playUrl), they're written into the page as before.

import { PATHS, wifiQrPayload, type VenueInfo } from "@bargames/sdk";
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

/** Keeps the announcement and countdown current from the live feed (ES5: the casting browser runs anything, but keep it plain). */
const LIVE_SCRIPT = `(function(){
var L=document.body.getAttribute("data-live"),tag="",d={},n=document.getElementById("news"),c=document.getElementById("count"),cl=document.getElementById("cdl"),cv=document.getElementById("cd"),lead=document.getElementById("lead");
function paint(){var now=Date.now(),a=d.announcement,k=d.countdown,showA=!!(a&&a.text&&(!a.until||Date.parse(a.until)>now)&&a.show!=="phones"),showC=!!(k&&k.endsAt&&Date.parse(k.endsAt)>now);
if(showA){n.textContent=a.text;n.className="news"+(a.position==="bottom"?" bottom":"");}n.hidden=!showA;
if(showC){var s=Math.max(0,Math.ceil((Date.parse(k.endsAt)-now)/1000));cl.textContent=k.label+" ";cv.textContent=Math.floor(s/60)+":"+("0"+s%60).slice(-2);}c.hidden=!showC;
lead.hidden=showA&&a.position!=="bottom"||showC;}
function poll(){fetch(L+(tag?"?wait="+encodeURIComponent(tag):""),{cache:"no-store"}).then(function(r){tag=r.headers.get("x-bargames-etag")||"";return r.json();}).then(function(x){d=x||{};paint();setTimeout(poll,tag?300:15000);}).catch(function(){tag="";setTimeout(poll,15000);});}
setInterval(paint,500);poll();})()`;

export async function idleScreenHtml({ venue, games }: IdleScreenInput): Promise<string> {
  const c = venue.theme.colors;
  const live = venue.playUrl ? `${venue.playUrl.replace(/\/$/, "")}${PATHS.live}` : "";
  const play = venue.playUrl ? await qrSvg(venue.playUrl, "#000000", "#ffffff") : "";
  const wifi = venue.wifi?.ssid ? await qrSvg(wifiQrPayload(venue.wifi), "#000000", "#ffffff") : "";
  const logo = venue.theme.logoDarkUrl ?? venue.theme.logoUrl;
  // Without a live feed: what's up now, written in (the page then changes with it).
  const a = !live && venue.announcement && (!venue.announcement.until || Date.parse(venue.announcement.until) > Date.now()) && venue.announcement.show !== "phones" ? venue.announcement : undefined;
  const cd = !live && venue.countdown && Date.parse(venue.countdown.endsAt) > Date.now() ? venue.countdown : undefined;
  const staticCount = cd
    ? `<script>(function(){var e=document.getElementById("cd"),t=${Date.parse(cd.endsAt)};function f(){var s=Math.max(0,Math.ceil((t-Date.now())/1000));e.textContent=Math.floor(s/60)+":"+("0"+s%60).slice(-2);if(s>0)setTimeout(f,250)}f()})()</script>`
    : "";
  const champs = (venue.leaderboards ?? []).map((b) => ({ game: b.displayName, top: b.tonight.filter((p) => p.wins > 0).slice(0, 3) })).filter((b) => b.top.length);
  const winners = champs.length
    ? `<p class="winners">Tonight's winners: ${champs.map((b) => `${esc(b.game)}: ${b.top.map((p) => `<b>${esc(p.name)}</b>${p.wins > 1 ? ` ×${p.wins}` : ""}`).join(", ")}`).join(" · ")}</p>`
    : "";
  const card = (svg: string, title: string, sub: string) =>
    `<figure><div class="qr">${svg}</div><figcaption><b>${esc(title)}</b><span>${esc(sub)}</span></figcaption></figure>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(venue.name)}</title><style>
*{box-sizing:border-box;margin:0}
[hidden]{display:none!important}
html,body{width:100%;height:100%;overflow:hidden;cursor:none}
body{background:${c.background};color:${c.text};font-family:${venue.theme.font ?? "system-ui, sans-serif"};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5vh;padding:5vh 5vw;text-align:center}
header img{max-height:14vh;max-width:40vw}
h1{font-size:8vh;line-height:1.1}
p.lead{font-size:4.2vh;color:${c.accent}}
p.count{font-size:5vh;font-weight:800}p.count b{color:${c.primary};font-variant-numeric:tabular-nums}
p.winners{font-size:3vh;opacity:.9}p.winners b{color:${c.primary}}
p.news{font-size:4.6vh;font-weight:700;background:${c.primary};color:#111;padding:1.6vh 3vw;border-radius:${venue.theme.radius ?? 16}px;max-width:80vw}
p.news.bottom{position:fixed;left:5vw;right:5vw;bottom:3vh;max-width:none}
.row{display:flex;gap:6vw;justify-content:center}
figure{display:flex;flex-direction:column;align-items:center;gap:2vh}
.qr{background:#fff;border-radius:${venue.theme.radius ?? 16}px;padding:1.2vh;width:30vh;height:30vh}
.qr svg{width:100%;height:100%;display:block}
figcaption{display:flex;flex-direction:column;gap:.6vh}
figcaption b{font-size:3.4vh;color:${c.primary}}
figcaption span{font-size:2.6vh;opacity:.85}
footer{font-size:2.6vh;opacity:.8}
</style></head><body${live ? ` data-live="${esc(live)}"` : ""}>
<header>${logo ? `<img src="${esc(logo)}" alt="">` : ""}<h1>${esc(venue.name)}</h1></header>
<p id="news" class="news${a?.position === "bottom" ? " bottom" : ""}"${a ? "" : " hidden"}>${a ? esc(a.text) : ""}</p>
<p id="lead" class="lead"${(a && a.position !== "bottom") || cd ? " hidden" : ""}>Next game starting soon</p>
<p id="count" class="count"${cd ? "" : " hidden"}><span id="cdl">${cd ? `${esc(cd.label)} ` : ""}</span><b id="cd"></b></p>${staticCount}
${winners}
<div class="row">${play ? card(play, "Play", venue.playUrl!.replace(/^https?:\/\//, "")) : ""}${wifi ? card(wifi, "Wi-Fi", venue.wifi!.ssid) : ""}</div>
${games.length ? `<footer>Tonight: ${games.map(esc).join(" · ")}</footer>` : ""}
${live ? `<script>${LIVE_SCRIPT}</script>` : ""}
</body></html>`;
}

/** The idle page as a data: URL the broker can stream. */
export async function idleScreenUrl(input: IdleScreenInput): Promise<string> {
  return `data:text/html;charset=utf-8,${encodeURIComponent(await idleScreenHtml(input))}`;
}
