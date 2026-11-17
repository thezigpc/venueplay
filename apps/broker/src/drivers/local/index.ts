// Screens plugged straight into the box (HDMI / DisplayPort). Design: docs/LOCAL-SCREENS.md.
//
// A plugged-in screen shows up as a TV. Showing something starts a kiosk on it: cage (a
// one-app Wayland compositor) with Chromium full screen, on the real output, no encoder.
// Later pages are loaded into the same Chromium over DevTools (127.0.0.1 only), so a
// change of page doesn't blank the screen. "Off" shows black (no CEC yet).
//
// The container needs /dev/dri, the video and render groups, and seatd running as root
// (deploy/broker-start does that, then runs the broker as node). One screen at a time for
// now: the first connected output.
//
// Enable with DRIVERS=roku,airplay,local.

import { spawn as spawnChild } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { isErrorLoad, kioskScript, retryDelay } from "./kioskPage.js";
import { TOUCH_PAGE_SCRIPT } from "./touchPage.js";
import path from "node:path";
import type { Logger } from "@bargames/common";
import type { Proc, ProcRunner } from "../../airplay.js";
import type { Capabilities, DeliveryMethod, DisplayContent, DisplayDevice, DisplayDriver, Health, ShowResult, StreamState } from "../../types.js";
import { NotBuiltYet } from "../../types.js";

export interface Connector {
  /** e.g. "HDMI-A-1", "DP-2" */
  name: string;
  /** e.g. "card0" */
  card: string;
  connected: boolean;
  /** Modes the screen reports (EDID), best first, e.g. ["3840x2160", "1920x1080"]. */
  modes: string[];
}

/** Reads DRM connectors from sysfs ("card0-HDMI-A-1/status" = "connected"). */
export function readConnectors(drmDir = "/sys/class/drm"): Connector[] {
  let entries: string[];
  try {
    entries = readdirSync(drmDir).sort();
  } catch {
    return []; // no DRM (container without the GPU, or not Linux)
  }
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8").trim();
    } catch {
      return "";
    }
  };
  // Box 0.16.1: the firmware's boot framebuffer (simpledrm/efifb, "card0-Unknown-1") isn't a
  // screen: it shows up "connected" until a GPU driver takes over the display.
  const bootFb = (card: string) => {
    try {
      return /simple-framebuffer|simpledrm|efi-framebuffer/.test(readlinkSync(path.join(drmDir, card, "device", "driver")));
    } catch {
      return false;
    }
  };
  return entries
    .filter((e) => /^card\d+-/.test(e) && !bootFb(e.split("-")[0]))
    .map((e) => ({
      name: e.replace(/^card\d+-/, ""),
      card: e.split("-")[0],
      connected: read(path.join(drmDir, e, "status")) === "connected",
      modes: [...new Set(read(path.join(drmDir, e, "modes")).split("\n").filter(Boolean))],
    }));
}

/** Black, for "off" (and while nothing is assigned). */
export const BLACK_PAGE = "data:text/html,<html style='background:%23000;cursor:none'></html>";

/**
 * Box 0.19.1: Chromium's device scale factor for a screen, so TV pages lay out at 1920 CSS px
 * wide as on every other path (a 4K TV gets 2: 1920x1080 CSS drawn with 4K pixels). Screens
 * up to 1920 wide stay at 1. `mode` is the screen's preferred mode, the one cage uses.
 */
export function kioskScale(mode: string | undefined): number {
  const w = Number(mode?.split("x")[0]);
  return w > 1920 ? Math.round((w / 1920) * 100) / 100 : 1;
}

/**
 * Box 0.21.0: touchscreens plugged into the box, from /proc/bus/input/devices: devices that
 * report multi-touch positions (ABS_MT_POSITION_X, bit 53 of their ABS bits).
 */
export function touchDevices(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const name = /^N: Name="(.*)"$/m.exec(block)?.[1];
    const abs = /^B: ABS=([0-9a-f ]+)$/m.exec(block)?.[1];
    if (!name || !abs) continue;
    // The bitmap is 64-bit words, most significant first: bit 53 is in the last word.
    const words = abs.trim().split(/\s+/);
    const low = BigInt(`0x${words[words.length - 1]}`);
    if ((low >> 53n) & 1n) out.push(name);
  }
  return out;
}

/**
 * Box 0.22.1: how a touch screen answers a page's dialog (alert, confirm, prompt,
 * beforeunload): yes. Nobody can tap the dialog itself there (cage 0.1.4; Debian 13 fixes it).
 */
export function dialogAnswer(d: { type: string; defaultPrompt?: string }): { accept: boolean; promptText?: string } {
  return d.type === "prompt" ? { accept: true, promptText: d.defaultPrompt ?? "" } : { accept: true };
}

/** A page script that shows an alert's text as a notice for a few seconds. */
export function noticeScript(message: string): string {
  return `(() => { const n = document.createElement("div"); n.setAttribute("role", "status"); n.textContent = ${JSON.stringify(message.slice(0, 300))}; Object.assign(n.style, { position: "fixed", left: "50%", top: "4vh", transform: "translateX(-50%)", zIndex: "2147483002", maxWidth: "70vw", padding: "2vh 3vw", borderRadius: "1.5vh", background: "rgba(20,20,30,0.95)", color: "#fff", font: "600 3vh system-ui, sans-serif", boxShadow: "0 1vh 4vh rgba(0,0,0,0.5)", textAlign: "center" }); document.body.appendChild(n); setTimeout(() => n.remove(), 5000); })()`;
}

/** Chromium flags for a touch screen: touch events, no pinch zoom or swipe-back, no pop-ups. */
export const TOUCH_FLAGS = ["--touch-events=enabled", "--disable-pinch", "--overscroll-history-navigation=0", "--block-new-web-contents"];

/**
 * Box 0.21.0: the sites a touch screen may open: the venue's own (the domain of every page
 * the box sent it, e.g. play.example.com → example.com and its subdomains; an IP as is).
 */
export function siteOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    const host = u.hostname.toLowerCase();
    if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return host;
    return host.split(".").slice(-2).join(".");
  } catch {
    return undefined;
  }
}
export const allowedBy = (sites: Set<string>, url: string): boolean => {
  if (!/^https?:/i.test(url)) return true; // data:, about:blank: the box's own pages
  try {
    const host = new URL(url).hostname.toLowerCase();
    return [...sites].some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
};

export function kioskArgs(url: string, profileDir: string, debugPort: number, scale = 1, touch = false): string[] {
  return [
    "-d", // cage: no client-side decorations
    "--",
    "chromium",
    "--ozone-platform=wayland",
    ...(scale !== 1 ? [`--force-device-scale-factor=${scale}`] : []),
    ...(touch ? TOUCH_FLAGS : []),
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--kiosk",
    "--start-fullscreen",
    // As for the AirPlay channels: no user namespaces in the container; only venue pages.
    "--no-sandbox",
    "--no-first-run",
    "--noerrdialogs",
    "--disable-infobars",
    "--disable-session-crashed-bubble",
    "--disable-translate",
    "--disable-features=Translate,MediaRouter",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    "--hide-scrollbars",
    "--check-for-update-interval=31536000",
    `--user-data-dir=${profileDir}`,
    url,
  ];
}

export interface LocalOptions {
  runner?: ProcRunner;
  log?: Logger;
  /** Writable directory for the Chromium profile and the Wayland runtime dir. */
  runDir?: string;
  drmDir?: string;
  debugPort?: number;
  cage?: string;
  /** Box 0.21.0: where to read the input devices (tests). */
  inputDevices?: string;
  /**
   * Box 0.22.0: the touch reader (touch-reader.py prints one JSON line per touch frame).
   * Tests pass their own; absent here means the image's script under python3.
   */
  touchReader?: () => { lines: AsyncIterable<string>; kill(): void };
  /**
   * Box 0.23.0: how touch reaches the page. "native": cage reads the touchscreen (cage 0.2 /
   * wlroots 0.18, the Debian 13 image), so taps reach dropdowns and dialogs too. "devtools":
   * the broker reads it and sends DevTools touch events, answers dialogs and shows dropdowns
   * on the page (cage 0.1.4, whose touch never reaches Chromium). Default: LOCAL_TOUCH, else
   * "devtools".
   */
  touchMode?: "native" | "devtools";
}

/** A touch frame from touch-reader.py: 0..1 across and down the screen. */
export interface TouchFrame {
  points: { id: number; x: number; y: number }[];
}

/**
 * Box 0.22.0: a touch frame as a DevTools Input.dispatchTouchEvent, in the page's CSS
 * pixels (the screen's mode divided by its scale). Chromium works out which points went
 * down, moved or lifted from the list, so this only says whether the touch began or ended.
 */
export function touchEventFor(frame: TouchFrame, before: number, css: { width: number; height: number }): { type: "touchStart" | "touchMove" | "touchEnd"; touchPoints: { id: number; x: number; y: number; radiusX: number; radiusY: number; force: number }[] } | undefined {
  const n = frame.points.length;
  if (n === 0) return before ? { type: "touchEnd", touchPoints: [] } : undefined;
  return {
    type: before === 0 ? "touchStart" : "touchMove",
    touchPoints: frame.points.map((p) => ({ id: p.id, x: Math.round(p.x * css.width * 10) / 10, y: Math.round(p.y * css.height * 10) / 10, radiusX: 8, radiusY: 8, force: 1 })),
  };
}

const TOUCH_SCRIPT = "/usr/local/lib/bargames/touch-reader.py";
function defaultTouchReader(log?: Logger) {
  const child = spawnChild("python3", [TOUCH_SCRIPT], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => log?.warn("local", "touch reader", { err: String(d).trim().slice(0, 200) }));
  child.on("error", (err) => log?.warn("local", "touch reader didn't start", { err: err.message }));
  return { lines: createInterface({ input: child.stdout }), kill: () => child.kill() };
}

interface Session {
  connector: string;
  proc: Proc;
  url: string;
  touch: boolean;
  /** Box 0.21.0: sites a touch screen may open, and the DevTools guard that enforces it. */
  sites: Set<string>;
  guard?: WebSocket;
  /** Box 0.22.0: sends a DevTools command on the guard's connection. */
  send?: (method: string, params: Record<string, unknown>) => void;
  /** Box 0.22.0: the touch reader for this screen, and the page's size in CSS pixels. */
  reader?: { kill(): void };
  css?: { width: number; height: number };
  /** Box 0.25.0: points the kiosk's Home button at the page the box sent (touch screens). */
  setHome?: (url: string) => Promise<void>;
  /** Box 0.25.0: the box just sent a page: forget the history before it once it loads. */
  resetHistory?: boolean;
  /** Box 0.25.0: reloading an error page (Cloudflare 502, no network): the timer and the try. */
  retry?: ReturnType<typeof setTimeout>;
  attempts: number;
  /** Box 0.26.1: when the guard last blocked a page, and a notice for the next page to show. */
  blockedAt?: number;
  notice?: string;
}

export class LocalScreenDriver implements DisplayDriver {
  readonly id = "local";
  private session?: Session;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly drmDir: string;
  private readonly debugPort: number;
  private readonly runDir: string;

  constructor(private readonly o: LocalOptions = {}) {
    this.drmDir = o.drmDir ?? "/sys/class/drm";
    this.debugPort = o.debugPort ?? 9320;
    this.runDir = o.runDir ?? "/tmp/bargames-local";
  }

  async discover(): Promise<DisplayDevice[]> {
    return readConnectors(this.drmDir)
      .filter((c) => c.connected)
      .map((c) => ({
        id: `local:${c.name}`,
        driver: this.id,
        name: `Screen on ${c.name}`,
        address: `drm:${c.name}`,
        model: c.modes[0] ? `up to ${c.modes[0]}` : undefined,
        isTv: true,
        meta: { connector: c.name, card: c.card, modes: c.modes },
      }));
  }

  async capabilities(): Promise<Capabilities> {
    // Power and inputs come with an HDMI-CEC adapter (per screen); not built yet.
    let devices: string[] = [];
    try {
      devices = touchDevices(readFileSync(this.o.inputDevices ?? "/proc/bus/input/devices", "utf8"));
    } catch {
      /* no /proc here (tests) */
    }
    return { delivery: ["local" as DeliveryMethod], power: false, inputs: [], touch: { devices } };
  }

  async power(): Promise<void> {
    throw new NotBuiltYet("plugged-in screens: power control (HDMI-CEC adapter) isn't built yet");
  }

  async setInput(): Promise<void> {
    throw new NotBuiltYet("plugged-in screens: input switching (HDMI-CEC adapter) isn't built yet");
  }

  show(device: DisplayDevice, content: DisplayContent): Promise<ShowResult> {
    const run = this.queue.then(() => this.showNow(device, content));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async showNow(device: DisplayDevice, content: DisplayContent): Promise<ShowResult> {
    if (content.kind === "external") return { ok: false, message: "A plugged-in screen has no apps of its own." };
    const url = content.kind === "off" ? BLACK_PAGE : content.kind === "idle" ? content.url : content.url;
    if (!url) return { ok: false, message: "Nothing to show" };
    const runner = this.o.runner;
    if (!runner) return { ok: false, message: "Plugged-in screens need the broker image (cage and Chromium)." };
    const c = readConnectors(this.drmDir).find((x) => `local:${x.name}` === device.id);
    if (!c?.connected) return { ok: false, message: "That screen is unplugged or switched off." };

    const touch = device.touch === true;
    const s = this.session;
    if (s && s.proc.alive && s.connector === c.name && s.touch === touch) {
      const site = siteOf(url);
      if (site) s.sites.add(site);
      await s.setHome?.(url);
      this.stopRetry(s);
      s.resetHistory = true;
      if (await this.navigate(url)) {
        s.url = url;
        return { ok: true, delivery: "local" };
      }
      s.proc.kill(); // DevTools didn't answer: start over
      await runner.sleep(1500);
    } else if (s) {
      s.proc.kill();
      await runner.sleep(1500);
    }
    const env: Record<string, string> = {
      XDG_RUNTIME_DIR: `${this.runDir}/xdg`,
      LIBSEAT_BACKEND: "seatd",
      WLR_LIBINPUT_NO_DEVICES: "1",
      // Box 0.21.0: input only when the venue switched touch on for this screen.
      // Box 0.22.0: cage never takes input (its touch doesn't reach Chromium on wlroots 0.15);
      // a touch screen's touches come from touch-reader.py through DevTools instead.
      WLR_BACKENDS: touch && this.native ? "drm,libinput" : "drm",
      WLR_DRM_DEVICES: `/dev/dri/${c.card}`,
      HOME: this.runDir,
    };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    const proc = runner.spawn(`local:${c.name}`, this.o.cage ?? "cage", kioskArgs(url, `${this.runDir}/chromium`, this.debugPort, kioskScale(c.modes[0]), touch), env);
    const site = siteOf(url);
    const session: Session = { connector: c.name, proc, url, touch, sites: new Set(site ? [site] : []), attempts: 0 };
    this.session = session;
    // Ready once DevTools answers (Chromium is up on the screen).
    for (let i = 0; i < 40; i++) {
      await runner.sleep(250);
      if (!proc.alive) {
        this.o.log?.warn("local", "kiosk exited", { connector: c.name, tail: proc.tail().slice(-8) });
        return { ok: false, message: `The screen didn't start: ${proc.tail().slice(-2).join(" ") || "unknown error"}` };
      }
      if (await this.pageWs()) {
        this.watch(session, c.modes[0]);
        return { ok: true, delivery: "local" };
      }
    }
    this.watch(session, c.modes[0]);
    return { ok: true, delivery: "local", message: "Starting (slow)" };
  }

  /** Box 0.22.0: the navigation guard plus the touch reader, while this kiosk runs. */
  /** Box 0.23.0: cage takes the touchscreen itself (see LocalOptions.touchMode). */
  private get native(): boolean {
    return (this.o.touchMode ?? process.env.LOCAL_TOUCH) === "native";
  }

  /**
   * The DevTools watch on every plugged-in screen (error pages reload themselves); on a
   * touch screen also the navigation guard, the kiosk controls and (devtools mode) the
   * touch reader.
   */
  private watch(s: Session, mode: string | undefined): void {
    void this.guard(s);
    if (!s.touch || this.native) return;
    const [w, h] = (mode ?? "1920x1080").split("x").map(Number);
    const scale = kioskScale(mode);
    s.css = { width: Math.round((w || 1920) / scale), height: Math.round((h || 1080) / scale) };
    void this.readTouches(s);
  }

  private async readTouches(s: Session): Promise<void> {
    while (this.session === s && s.proc.alive) {
      const reader = (this.o.touchReader ?? (() => defaultTouchReader(this.o.log)))();
      s.reader = reader;
      let down = 0;
      try {
        for await (const line of reader.lines) {
          if (this.session !== s || !s.proc.alive) break;
          let msg: Partial<TouchFrame> & { ready?: string[]; error?: string };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.ready) this.o.log?.info("local", "reading touches", { devices: msg.ready });
          if (msg.error) this.o.log?.warn("local", "touch reader", { err: msg.error });
          if (!Array.isArray(msg.points)) continue;
          const ev = touchEventFor({ points: msg.points }, down, s.css ?? { width: 1920, height: 1080 });
          down = msg.points.length;
          if (ev) s.send?.("Input.dispatchTouchEvent", ev);
        }
      } catch {
        /* the reader went away */
      }
      reader.kill();
      if (s.reader === reader) s.reader = undefined;
      if (this.session !== s || !s.proc.alive) return;
      await this.o.runner?.sleep(5000); // unplugged, or no touchscreen yet: look again
    }
  }

  private stopRetry(s: Session): void {
    if (s.retry) clearTimeout(s.retry);
    s.retry = undefined;
    s.attempts = 0;
  }

  /**
   * Box 0.25.0: after each page load, a page that didn't load (Chromium's error page, or a
   * 5xx such as Cloudflare's 502 while a game restarts) reloads itself: 5 s, then doubling
   * up to a minute, until it loads. A good load forgets the history before a page the box
   * sent, so Back can't return to what was cast earlier.
   */
  private async afterLoad(s: Session, call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>): Promise<void> {
    const r = await call("Runtime.evaluate", { expression: `[performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0, location.href]`, returnByValue: true });
    const [status, href] = ((r?.result as { value?: unknown } | undefined)?.value ?? [0, ""]) as [number, string];
    if (this.session !== s) return;
    // Box 0.26.1: a link to another site on a touch screen lands on Chromium's "blocked" page.
    // Go back to the page it was on (or home) and say why, rather than reloading the block.
    if (String(href).startsWith("chrome-error://") && s.blockedAt && Date.now() - s.blockedAt < 5000) {
      s.blockedAt = undefined;
      const h = (await call("Page.getNavigationHistory", {})) as { currentIndex?: number; entries?: { id: number }[] } | undefined;
      const prev = h?.entries && typeof h.currentIndex === "number" && h.currentIndex > 0 ? h.entries[h.currentIndex - 1] : undefined;
      void call(prev ? "Page.navigateToHistoryEntry" : "Page.navigate", prev ? { entryId: prev.id } : { url: s.url });
      s.notice = "Only the venue's own pages open on this screen.";
      return;
    }
    if (isErrorLoad(status, String(href))) {
      if (s.retry) return;
      const wait = retryDelay(s.attempts);
      this.o.log?.info("local", "page didn't load; reloading", { status, url: String(href).slice(0, 120), in: wait / 1000 });
      s.retry = setTimeout(() => {
        s.retry = undefined;
        s.attempts++;
        if (this.session === s) void call("Page.reload", { ignoreCache: true });
      }, wait);
      s.retry.unref?.();
      return;
    }
    if (s.retry) clearTimeout(s.retry);
    s.retry = undefined;
    s.attempts = 0;
    if (s.notice) {
      void call("Runtime.evaluate", { expression: noticeScript(s.notice) });
      s.notice = undefined;
    }
    if (s.resetHistory) {
      s.resetHistory = false;
      void call("Page.resetNavigationHistory", {});
    }
  }

  /**
   * Box 0.21.0: on a touch screen, people can only open the venue's own pages. A DevTools
   * session pauses every page load (main page and frames) and fails those on other sites.
   * Reconnects while the kiosk runs. Box 0.25.0: on every plugged-in screen, for afterLoad.
   */
  private async guard(s: Session): Promise<void> {
    while (this.session === s && s.proc.alive && !s.guard) {
      const wsUrl = await this.pageWs();
      if (!wsUrl) {
        await this.o.runner?.sleep(2000);
        continue;
      }
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(wsUrl);
        s.guard = ws;
        let id = 10;
        const waiting = new Map<number, (r: Record<string, unknown> | undefined) => void>();
        const call = (method: string, params: Record<string, unknown>) =>
          new Promise<Record<string, unknown> | undefined>((done) => {
            if (ws.readyState !== WebSocket.OPEN) return done(undefined);
            const n = id++;
            const t = setTimeout(() => (waiting.delete(n), done(undefined)), 3000);
            t.unref?.();
            waiting.set(n, (r) => (clearTimeout(t), done(r)));
            ws.send(JSON.stringify({ id: n, method, params }));
          });
        s.send = (method, params) => void call(method, params);
        // Box 0.25.0: the kiosk controls (Back, Home, no pointer) on touch screens.
        let kioskId: string | undefined;
        s.setHome = async (url) => {
          if (!s.touch) return;
          if (kioskId) await call("Page.removeScriptToEvaluateOnNewDocument", { identifier: kioskId });
          const r = await call("Page.addScriptToEvaluateOnNewDocument", { source: kioskScript(url) });
          kioskId = typeof r?.identifier === "string" ? r.identifier : undefined;
        };
        ws.onopen = () => {
          if (s.touch) ws.send(JSON.stringify({ id: id++, method: "Fetch.enable", params: { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] } }));
          ws.send(JSON.stringify({ id: id++, method: "Page.enable", params: {} }));
          if (s.touch) {
            void s.setHome?.(s.url);
            ws.send(JSON.stringify({ id: id++, method: "Runtime.evaluate", params: { expression: kioskScript(s.url) } }));
          }
          // Box 0.22.1: dropdowns as on-page lists, in every page from now on and this one.
          if (s.touch && !this.native) {
            ws.send(JSON.stringify({ id: id++, method: "Page.addScriptToEvaluateOnNewDocument", params: { source: TOUCH_PAGE_SCRIPT } }));
            ws.send(JSON.stringify({ id: id++, method: "Runtime.evaluate", params: { expression: TOUCH_PAGE_SCRIPT } }));
          }
        };
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; method?: string; params?: { requestId: string; request: { url: string } } };
          if (msg.id !== undefined) {
            const w = waiting.get(msg.id);
            waiting.delete(msg.id);
            w?.(msg.result);
            return;
          }
          if (msg.method === "Page.loadEventFired") {
            void this.afterLoad(s, call);
            return;
          }
          // Box 0.22.1: alert/confirm/prompt/"leave this page?" open as a separate Chromium
          // window that touch can't reach, and the page is frozen until it's answered. Answer
          // it here (the tap on the button was the decision); show an alert's text on the page.
          if (msg.method === "Page.javascriptDialogOpening" && s.touch && !this.native) {
            const d = msg.params as unknown as { type: string; message: string; defaultPrompt?: string };
            const answer = dialogAnswer(d);
            ws.send(JSON.stringify({ id: id++, method: "Page.handleJavaScriptDialog", params: answer }));
            this.o.log?.info("local", "answered a dialog on the touch screen", { type: d.type, accept: answer.accept });
            if (d.type === "alert" && d.message) ws.send(JSON.stringify({ id: id++, method: "Runtime.evaluate", params: { expression: noticeScript(d.message) } }));
            return;
          }
          if (msg.method !== "Fetch.requestPaused" || !msg.params) return;
          const ok = allowedBy(s.sites, msg.params.request.url);
          if (!ok) {
            this.o.log?.info("local", "blocked a page on the touch screen", { url: msg.params.request.url.slice(0, 120) });
            s.blockedAt = Date.now();
          }
          ws.send(JSON.stringify({ id: id++, method: ok ? "Fetch.continueRequest" : "Fetch.failRequest", params: ok ? { requestId: msg.params.requestId } : { requestId: msg.params.requestId, errorReason: "BlockedByClient" } }));
        };
        ws.onerror = () => undefined;
        ws.onclose = () => {
          s.guard = undefined;
          s.send = undefined;
          s.setHome = undefined;
          for (const w of waiting.values()) w(undefined);
          waiting.clear();
          resolve();
        };
      });
      await this.o.runner?.sleep(2000);
    }
  }

  /**
   * Box 0.23.1: what the screen shows, for the TVs page: the box's own kiosk, so it's
   * "streaming" while it runs (that turns on the live preview).
   */
  streamState(device: DisplayDevice): StreamState | undefined {
    const s = this.session;
    if (!s || !s.proc.alive || `local:${s.connector}` !== device.id) return undefined;
    return { delivery: "local" as DeliveryMethod, url: s.url, state: "streaming", needsCode: false, settings: `plugged into the box${s.touch ? " · touch" : ""}` };
  }

  /** Box 0.23.1: the page on the screen now (also one someone opened by touch): its title. */
  async foregroundApp(device: DisplayDevice): Promise<{ id: string; name: string; home: boolean } | undefined> {
    const s = this.session;
    if (!s || !s.proc.alive || `local:${s.connector}` !== device.id) return undefined;
    try {
      const r = await fetch(`http://127.0.0.1:${this.debugPort}/json/list`, { signal: AbortSignal.timeout(1500) });
      const page = ((await r.json()) as { type: string; title?: string; url?: string }[]).find((p) => p.type === "page");
      if (!page?.url) return undefined;
      if (page.url.startsWith("data:")) return { id: "box", name: page.url === BLACK_PAGE ? "Black (off)" : "Idle screen", home: false };
      return { id: page.url, name: page.title?.trim() || new URL(page.url).host, home: false };
    } catch {
      return undefined;
    }
  }

  /** The page's DevTools WebSocket URL, once Chromium is up. */
  private async pageWs(): Promise<string | undefined> {
    try {
      const r = await fetch(`http://127.0.0.1:${this.debugPort}/json/list`, { signal: AbortSignal.timeout(1500) });
      const list = (await r.json()) as { type: string; webSocketDebuggerUrl?: string }[];
      return list.find((p) => p.type === "page")?.webSocketDebuggerUrl;
    } catch {
      return undefined;
    }
  }

  private async navigate(url: string): Promise<boolean> {
    const wsUrl = await this.pageWs();
    if (!wsUrl) return false;
    return new Promise<boolean>((resolve) => {
      const ws = new WebSocket(wsUrl);
      const done = (ok: boolean) => {
        clearTimeout(t);
        try {
          ws.close();
        } catch {
          /* closed */
        }
        resolve(ok);
      };
      const t = setTimeout(() => done(false), 5000);
      ws.onerror = () => done(false);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as { id?: number; error?: unknown };
        if (msg.id === 1) done(!msg.error);
      };
    });
  }

  async stop(device: DisplayDevice): Promise<void> {
    if (this.session && `local:${this.session.connector}` === device.id) {
      this.session.guard?.close();
      this.stopRetry(this.session);
      this.session.reader?.kill();
      this.session.reader = undefined;
      this.session.proc.kill();
      this.session = undefined;
    }
  }

  async health(device: DisplayDevice): Promise<Health> {
    const c = readConnectors(this.drmDir).find((x) => `local:${x.name}` === device.id);
    return c?.connected ? { online: true } : { online: false, detail: "unplugged or switched off" };
  }

  async preview(device: DisplayDevice): Promise<Buffer | undefined> {
    const s = this.session;
    if (!s || !s.proc.alive || `local:${s.connector}` !== device.id || !this.o.runner?.screenshot) return undefined;
    const c = readConnectors(this.drmDir).find((x) => x.name === s.connector);
    const [w, h] = (c?.modes[0] ?? "1920x1080").split("x").map(Number);
    return this.o.runner.screenshot(this.debugPort, { width: w || 1920, height: h || 1080 }, 480).catch(() => undefined);
  }
}
