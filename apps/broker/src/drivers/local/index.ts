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

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import type { Logger } from "@bargames/common";
import type { Proc, ProcRunner } from "../../airplay.js";
import type { Capabilities, DeliveryMethod, DisplayContent, DisplayDevice, DisplayDriver, Health, ShowResult } from "../../types.js";
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

export function kioskArgs(url: string, profileDir: string, debugPort: number): string[] {
  return [
    "-d", // cage: no client-side decorations
    "--",
    "chromium",
    "--ozone-platform=wayland",
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
}

interface Session {
  connector: string;
  proc: Proc;
  url: string;
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
    return { delivery: ["local" as DeliveryMethod], power: false, inputs: [] };
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

    const s = this.session;
    if (s && s.proc.alive && s.connector === c.name) {
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
      WLR_DRM_DEVICES: `/dev/dri/${c.card}`,
      HOME: this.runDir,
    };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    const proc = runner.spawn(`local:${c.name}`, this.o.cage ?? "cage", kioskArgs(url, `${this.runDir}/chromium`, this.debugPort), env);
    this.session = { connector: c.name, proc, url };
    // Ready once DevTools answers (Chromium is up on the screen).
    for (let i = 0; i < 40; i++) {
      await runner.sleep(250);
      if (!proc.alive) {
        this.o.log?.warn("local", "kiosk exited", { connector: c.name, tail: proc.tail().slice(-8) });
        return { ok: false, message: `The screen didn't start: ${proc.tail().slice(-2).join(" ") || "unknown error"}` };
      }
      if (await this.pageWs()) return { ok: true, delivery: "local" };
    }
    return { ok: true, delivery: "local", message: "Starting (slow)" };
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
