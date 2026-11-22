// Box 0.30.1: a virtual TV for testing on a real box, never shown to the venue.
//
// Off by default. POST /virtual { minutes } turns it on for a while: "Virtual TV (test)" is
// then a TV like any other (the admin's TV lists, games' TV pickers, casts, videos), shown by
// a headless Chromium inside the broker, and it turns itself off when the time is up. While
// it's off the registry hides its record everywhere (DisplayDriver.hidden), so staff and
// games never see it.
//
// The same Chromium can open other test pages ("phone", any name) in their own browser
// profile (separate cookies and storage, as on separate devices), to drive a flow from a
// phone and watch the TV at the same time. Pages are driven over the DevTools protocol:
// open a URL, run a script, take a screenshot, read the console. Only the broker token
// reaches it (core's loopback API), and nothing it sees is logged.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import type { Logger } from "@bargames/common";
import type { Capabilities, DisplayContent, DisplayDevice, DisplayDriver, Health, ShowResult, VideoAction, VideoInfo, VideoRequest, VideoResult, VideoStatus } from "../types.js";
import { isSeek } from "../types.js";

export const VIRTUAL_TV = "virtual:tv1";
const MAX_MINUTES = 240;
const CONSOLE_KEEP = 60;
const TV_SIZE = { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false };
const PHONE_SIZE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
interface Page {
  name: string;
  contextId: string;
  targetId: string;
  sessionId: string;
  console: string[];
}
interface Video {
  title: string;
  state: "playing" | "paused";
  /** Position when `since` was taken. */
  at: number;
  since: number;
  duration?: number;
}

export interface VirtualOptions {
  chromium?: string;
  runDir?: string;
  log?: Logger;
  /** Tests: no browser at all (show and video still work, screenshots are empty). */
  noBrowser?: boolean;
}

/** Links can carry keys (a media server's, a host seat): never keep them in console lines. */
const redact = (s: string) => s.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<link>").slice(0, 400);

const pathOf = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.origin === "null" ? x.protocol : ""}${x.pathname}${x.search ? "?…" : ""}`;
  } catch {
    return "";
  }
};

/** A page's address with secret-looking query values (seat tokens, keys) blanked. */
const SECRET = /^(host|key|cohost|token|t|api_key|apikey|sig|signature|access_token|auth|x-plex-token)$/i;
export const safeUrl = (u: string) => {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (SECRET.test(k)) x.searchParams.set(k, "…");
    return x.toString();
  } catch {
    return "";
  }
};

export class VirtualScreenDriver implements DisplayDriver {
  readonly id = "virtual";
  private until = 0;
  private timer?: NodeJS.Timeout;
  private proc?: ChildProcess;
  private ws?: WebSocket;
  private starting?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly pages = new Map<string, Page>();
  private video?: Video;
  private shown?: DisplayContent;
  private readonly port = 9333;

  constructor(private readonly o: VirtualOptions = {}) {}

  // ---- on and off

  active(): boolean {
    return Date.now() < this.until;
  }

  /** The registry leaves hidden drivers' TVs out of every list and lookup. */
  hidden(): boolean {
    return !this.active();
  }

  /** Turns the virtual TV on for `minutes` (1..240). Returns when it'll turn off. */
  on(minutes: number): Date {
    const m = Math.min(MAX_MINUTES, Math.max(1, Math.round(minutes)));
    this.until = Date.now() + m * 60_000;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.off(), m * 60_000);
    this.timer.unref?.();
    this.o.log?.info("virtual", "on", { minutes: m });
    return new Date(this.until);
  }

  async off(): Promise<void> {
    const was = this.until > 0;
    this.until = 0;
    clearTimeout(this.timer);
    this.video = undefined;
    this.shown = undefined;
    this.stopBrowser();
    if (was) this.o.log?.info("virtual", "off", {});
  }

  // ---- DisplayDriver

  async discover(): Promise<DisplayDevice[]> {
    if (!this.active()) return [];
    return [{ id: VIRTUAL_TV, driver: this.id, name: "Virtual TV (test)", address: "virtual://tv1", model: "Headless Chromium", isTv: true }];
  }

  async capabilities(): Promise<Capabilities> {
    return { delivery: ["mock"], power: false, inputs: [] };
  }

  async power() {}
  async setInput() {}

  async show(_d: DisplayDevice, content: DisplayContent): Promise<ShowResult> {
    if (!this.active()) return { ok: false, message: "The virtual TV is off." };
    const url = content.kind === "url" || content.kind === "idle" ? content.url : undefined;
    this.shown = content;
    this.video = undefined;
    if (url) await this.open("tv", url);
    return { ok: true, delivery: "mock" };
  }

  async stop() {
    this.shown = undefined;
    this.video = undefined;
    if (this.pages.has("tv")) await this.open("tv", "about:blank").catch(() => undefined);
  }

  async health(): Promise<Health> {
    return this.active() ? { online: true, powerMode: "PowerOn" } : { online: false, detail: "The virtual TV is off." };
  }

  async preview(): Promise<Buffer | undefined> {
    return this.pages.has("tv") ? this.screenshot("tv") : undefined;
  }

  // ---- video: a pretend player that keeps time, so stop, pause and seek can be checked

  videoInfo(): VideoInfo {
    return { kind: "local", model: "Virtual TV (test)", formats: { containers: ["mp4", "mkv", "hls", "mov"], video: ["h264", "hevc"], audio: ["aac", "ac3", "eac3", "mp3", "opus"], seek: true } };
  }

  async playVideo(_d: DisplayDevice, v: VideoRequest): Promise<VideoResult> {
    if (!this.active()) return { ok: false, reason: "offline", message: "The virtual TV is off." };
    this.video = { title: v.title, state: "playing", at: Math.max(0, v.startAt ?? 0), since: Date.now(), duration: 7200 };
    this.o.log?.info("virtual", "video play", { title: v.title });
    await this.paintVideo();
    return { ok: true };
  }

  async videoControl(_d: DisplayDevice, a: VideoAction): Promise<VideoResult> {
    const v = this.video;
    if (a === "stop") {
      this.video = undefined;
      this.o.log?.info("virtual", "video stop", {});
      if (this.pages.has("tv")) await this.open("tv", "about:blank").catch(() => undefined);
      return { ok: true };
    }
    if (!v) return { ok: false, reason: "error", message: "nothing is playing" };
    const pos = this.position(v);
    if (a === "pause") Object.assign(v, { state: "paused", at: pos, since: Date.now() });
    else if (a === "resume") Object.assign(v, { state: "playing", at: pos, since: Date.now() });
    else if (isSeek(a)) Object.assign(v, { at: Math.max(0, a.seek), since: Date.now() });
    this.o.log?.info("virtual", "video control", { action: typeof a === "string" ? a : Object.keys(a)[0] });
    await this.paintVideo();
    return { ok: true };
  }

  async videoStatus(): Promise<VideoStatus> {
    const v = this.video;
    if (!v) return { state: "stopped" };
    return { state: v.state, position: Math.round(this.position(v)), duration: v.duration };
  }

  private position(v: Video): number {
    return v.state === "playing" ? v.at + (Date.now() - v.since) / 1000 : v.at;
  }

  /** What a viewer would see: the title and the player's state, on the TV page. */
  private async paintVideo() {
    if (this.o.noBrowser) return;
    const v = this.video;
    if (!v) return;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const html = `<body style="margin:0;background:#000;color:#fff;font:48px sans-serif;display:grid;place-items:center;height:100vh"><div>${v.state === "playing" ? "▶" : "⏸"} ${esc(v.title)}<br><small style="font-size:28px;opacity:.7">virtual player · from ${Math.round(v.at)} s</small></div></body>`;
    await this.open("tv", `data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined);
  }

  // ---- test pages

  /** What each page shows: its address (links redacted), title and recent console lines. */
  async inspect(): Promise<{ active: boolean; until?: string; video?: VideoStatus & { title?: string }; pages: Record<string, { url: string; title: string; console: string[] }> }> {
    const pages: Record<string, { url: string; title: string; console: string[] }> = {};
    for (const p of this.pages.values()) {
      const r = (await this.send("Runtime.evaluate", { expression: "[location.href, document.title]", returnByValue: true }, p.sessionId).catch(() => undefined)) as { result?: { value?: [string, string] } } | undefined;
      const [href, title] = r?.result?.value ?? ["", ""];
      pages[p.name] = { url: href.startsWith("data:") ? "data:…" : safeUrl(href), title, console: [...p.console] };
    }
    const video = this.video ? { ...(await this.videoStatus()), title: this.video.title } : undefined;
    return { active: this.active(), ...(this.active() ? { until: new Date(this.until).toISOString() } : {}), ...(video ? { video } : {}), pages };
  }

  /** Opens a URL in a test page ("tv" is the virtual TV; anything else is a phone-sized page). */
  async open(name: string, url: string): Promise<void> {
    if (!this.active()) throw Object.assign(new Error("The virtual TV is off: POST /virtual { minutes } first."), { status: 409 });
    if (this.o.noBrowser) return;
    const p = await this.page(name);
    await this.send("Page.navigate", { url }, p.sessionId);
  }

  /** Runs a script in a test page and returns its value (promises are awaited). */
  async evaluate(name: string, expression: string): Promise<unknown> {
    const p = this.pages.get(name);
    if (!p) throw Object.assign(new Error(`no test page ${name}`), { status: 404 });
    const r = (await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }, p.sessionId)) as { result?: { value?: unknown; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (r.exceptionDetails) throw Object.assign(new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "script failed"), { status: 400 });
    return r.result && "value" in r.result ? r.result.value : r.result?.description;
  }

  async screenshot(name: string): Promise<Buffer | undefined> {
    const p = this.pages.get(name);
    if (!p) return undefined;
    const r = (await this.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, p.sessionId)) as { data?: string };
    return r.data ? Buffer.from(r.data, "base64") : undefined;
  }

  async closePage(name: string): Promise<void> {
    const p = this.pages.get(name);
    if (!p) return;
    this.pages.delete(name);
    await this.send("Target.disposeBrowserContext", { browserContextId: p.contextId }).catch(() => undefined);
  }

  // ---- the browser

  private async page(name: string): Promise<Page> {
    const have = this.pages.get(name);
    if (have) return have;
    await this.browser();
    // Each page its own profile: separate cookies and storage, like separate devices.
    const { browserContextId } = (await this.send("Target.createBrowserContext", { disposeOnDetach: true })) as { browserContextId: string };
    const { targetId } = (await this.send("Target.createTarget", { url: "about:blank", browserContextId })) as { targetId: string };
    const { sessionId } = (await this.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    const p: Page = { name, contextId: browserContextId, targetId, sessionId, console: [] };
    this.pages.set(name, p);
    await this.send("Page.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    await this.send("Log.enable", {}, sessionId);
    const size = name === "tv" ? TV_SIZE : PHONE_SIZE;
    await this.send("Emulation.setDeviceMetricsOverride", size, sessionId);
    if (size.mobile) {
      await this.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);
      await this.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" }, sessionId);
    }
    return p;
  }

  private browser(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    return (this.starting ??= this.launch().finally(() => (this.starting = undefined)));
  }

  private async launch(): Promise<void> {
    const dir = `${this.o.runDir ?? "/tmp/bargames-virtual"}/chromium`;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const proc = spawn(
      this.o.chromium ?? "chromium",
      [
        "--headless=new",
        "--no-sandbox",
        "--no-first-run",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--mute-audio",
        "--hide-scrollbars",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=Translate,MediaRouter",
        `--remote-debugging-port=${this.port}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${dir}`,
        "--window-size=1920,1080",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    this.proc = proc;
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = undefined;
    });
    let wsUrl: string | undefined;
    for (let i = 0; i < 50 && !wsUrl; i++) {
      await new Promise((r) => setTimeout(r, 200));
      wsUrl = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1000) })
        .then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>)
        .then((j) => j.webSocketDebuggerUrl)
        .catch(() => undefined);
    }
    if (!wsUrl) {
      this.stopBrowser();
      throw new Error("the virtual TV's Chromium didn't start");
    }
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("couldn't reach the virtual TV's Chromium"));
    });
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.pages.clear();
      for (const p of this.pending.values()) p.reject(new Error("the virtual TV's Chromium closed"));
      this.pending.clear();
    };
    this.ws = ws;
  }

  private onMessage(raw: string) {
    const m = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
      return;
    }
    const page = [...this.pages.values()].find((p) => p.sessionId === m.sessionId);
    if (!page || !m.params) return;
    let line: string | undefined;
    if (m.method === "Runtime.consoleAPICalled") {
      const args = (m.params.args as { value?: unknown; description?: string }[]) ?? [];
      line = `${String(m.params.type)}: ${args.map((a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : (a.description ?? ""))).join(" ")}`;
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails as { text?: string; exception?: { description?: string } };
      line = `exception: ${d.exception?.description ?? d.text ?? ""}`;
    } else if (m.method === "Log.entryAdded") {
      const e = m.params.entry as { level?: string; text?: string };
      line = `${e.level ?? "log"}: ${e.text ?? ""}`;
    } else if (m.method === "Page.frameNavigated") {
      const f = m.params.frame as { parentId?: string; url?: string };
      // The path only: the query can hold a seat token or a media key.
      if (!f.parentId) line = `navigated to ${f.url?.startsWith("data:") ? "data:…" : pathOf(f.url ?? "")}`;
    }
    if (line) {
      page.console.push(m.method === "Page.frameNavigated" ? line : redact(line));
      if (page.console.length > CONSOLE_KEEP) page.console.splice(0, page.console.length - CONSOLE_KEEP);
    }
  }

  private send(method: string, params: object, sessionId?: string): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("the virtual TV's Chromium isn't running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 20_000);
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  private stopBrowser() {
    const ws = this.ws;
    this.ws = undefined;
    this.pages.clear();
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    this.proc?.kill("SIGKILL");
    this.proc = undefined;
  }
}
