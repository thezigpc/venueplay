/**
 * Box 0.25.0: the kiosk controls on a touch screen plugged into the box. Runs in every page
 * the screen opens (Page.addScriptToEvaluateOnNewDocument), top frame only:
 * - hides the mouse pointer (cage shows one once a touchscreen is attached);
 * - Back and Home buttons, bottom left, only away from the page the box sent ("home");
 *   they sit above GameKit's on-screen keyboard (--bargames-keyboard);
 * - a swipe in from the left edge goes back.
 * Back with nowhere to go back to goes home. Pages on other sites stay blocked by the
 * broker's navigation guard, so Back and Home only ever move between the venue's pages.
 */
export function kioskScript(home: string): string {
  return `(() => {
  if (window.top !== window || window.__bgKioskControls) return;
  window.__bgKioskControls = true;
  const HOME = ${JSON.stringify(home)};
  const web = /^https?:/i.test(HOME);
  const norm = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\\/+$/, "") + x.search; } catch { return String(u); } };
  const atHome = () => !web || norm(location.href) === norm(HOME);
  const goHome = () => { if (web) location.href = HOME; };
  const goBack = () => { if (history.length > 1) history.back(); else goHome(); };
  window.__bgKioskBack = goBack;
  window.__bgKioskHome = goHome;
  const css = document.createElement("style");
  css.textContent = "html, html * { cursor: none !important; }";
  const mount = () => {
    (document.head || document.documentElement).appendChild(css);
    const host = document.createElement("div");
    host.setAttribute("data-bargames-kiosk", "");
    host.style.cssText = "all: initial; position: fixed; left: 1.5vh; bottom: calc(1.5vh + var(--bargames-keyboard, 0px)); z-index: 2147483001; display: none; gap: 1.2vh;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = "<style>button{all:unset;box-sizing:border-box;min-width:9vh;height:7vh;padding:0 2.2vh;border-radius:3.5vh;background:rgba(15,15,25,.72);color:#fff;font:600 2.6vh system-ui,sans-serif;display:inline-flex;align-items:center;gap:.8vh;box-shadow:0 .6vh 2vh rgba(0,0,0,.45);border:.2vh solid rgba(255,255,255,.25);-webkit-tap-highlight-color:transparent;touch-action:manipulation}button:active{background:rgba(60,60,90,.9)}</style><button part=back aria-label=Back>\\u2039 Back</button><button part=home aria-label=Home>\\u2302 Home</button>";
    const [back, homeBtn] = root.querySelectorAll("button");
    back.addEventListener("click", (e) => { e.stopPropagation(); goBack(); });
    homeBtn.addEventListener("click", (e) => { e.stopPropagation(); goHome(); });
    document.documentElement.appendChild(host);
    const sync = () => {
      if (!host.isConnected) document.documentElement.appendChild(host);
      host.style.display = atHome() ? "none" : "flex";
    };
    sync();
    setInterval(sync, 700);
    addEventListener("popstate", sync);
    addEventListener("hashchange", sync);
  };
  if (document.documentElement) mount(); else addEventListener("DOMContentLoaded", mount, { once: true });
  // Swipe in from the left edge: back.
  let start;
  addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    start = e.touches.length === 1 && t.clientX <= Math.max(24, innerWidth * 0.02) ? { x: t.clientX, y: t.clientY } : undefined;
  }, { capture: true, passive: true });
  addEventListener("touchend", (e) => {
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x, dy = Math.abs(t.clientY - start.y);
    start = undefined;
    if (dx > Math.max(100, innerWidth * 0.08) && dy < dx / 2 && !atHome()) goBack();
  }, { capture: true, passive: true });
  addEventListener("touchcancel", () => { start = undefined; }, { capture: true, passive: true });
})()`;
}

/** Box 0.25.0: how long to wait before reloading an error page (5 s, doubling, at most a minute). */
export function retryDelay(attempt: number): number {
  return Math.min(60_000, 5000 * 2 ** Math.max(0, attempt));
}

/** Box 0.25.0: a load that should be retried: Chromium's own error page, or a 5xx (Cloudflare's 502/530). */
export function isErrorLoad(status: number | undefined, href: string): boolean {
  return href.startsWith("chrome-error://") || (typeof status === "number" && status >= 500 && status < 600);
}
