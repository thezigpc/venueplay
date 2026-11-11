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
  const play = venue.playUrl ? await qrSvg(venue.playUrl, "#000000", "#ffffff") : "";
  const wifi = venue.wifi?.ssid ? await qrSvg(wifiQrPayload(venue.wifi), "#000000", "#ffffff") : "";
  const logo = venue.theme.logoDarkUrl ?? venue.theme.logoUrl;
  const card = (svg: string, title: string, sub: string) =>
    `<figure><div class="qr">${svg}</div><figcaption><b>${esc(title)}</b><span>${esc(sub)}</span></figcaption></figure>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(venue.name)}</title><style>
*{box-sizing:border-box;margin:0}
html,body{width:100%;height:100%;overflow:hidden;cursor:none}
body{background:${c.background};color:${c.text};font-family:${venue.theme.font ?? "system-ui, sans-serif"};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5vh;padding:5vh 5vw;text-align:center}
header img{max-height:14vh;max-width:40vw}
h1{font-size:8vh;line-height:1.1}
p.lead{font-size:4.2vh;color:${c.accent}}
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
<p class="lead">Next game starting soon</p>
<div class="row">${play ? card(play, "Play", venue.playUrl!.replace(/^https?:\/\//, "")) : ""}${wifi ? card(wifi, "Wi-Fi", venue.wifi!.ssid) : ""}</div>
${games.length ? `<footer>Tonight: ${games.map(esc).join(" · ")}</footer>` : ""}
</body></html>`;
}

/** The idle page as a data: URL the broker can stream. */
export async function idleScreenUrl(input: IdleScreenInput): Promise<string> {
  return `data:text/html;charset=utf-8,${encodeURIComponent(await idleScreenHtml(input))}`;
}
