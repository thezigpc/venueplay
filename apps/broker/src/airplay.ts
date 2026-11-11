// AirPlay delivery: render a page on a virtual display and mirror it with doubletake.
//
// One "channel" per URL being shown:
//   Xvfb :N (1920x1080, no cursor) → Chromium --kiosk <url> → doubletake daemon (-socket)
// Every TV showing that URL is a target of the same daemon, so it is captured and
// encoded once (QuickSync via VA-API) however many TVs watch it. A TV moving to another
// URL leaves its channel; a channel with no TVs is torn down.
//
// Pairing: the first connection to a receiver that wants a code ends in "pin_required";
// the code the TV shows is sent with pair(). doubletake saves credentials to a file in
// /data, so it is needed once per TV.

import type { Logger } from "@bargames/common";
import type { DisplayDevice, ShowResult, StreamService, StreamState } from "./types.js";
import { NotBuiltYet } from "./types.js";

/** A child process the streamer started. */
export interface Proc {
  readonly alive: boolean;
  /** Recent stderr/stdout lines, for diagnostics. */
  tail(): string[];
  kill(): void;
}

export interface CtlStream {
  device?: string;
  device_ip?: string;
  state?: string;
  credential_kind?: string;
  error?: string;
}

/** doubletake-ctl's JSON reply (status, connect, disconnect). */
export interface CtlReply {
  ok: boolean;
  state?: string;
  error?: string;
  message?: string;
  streams?: CtlStream[];
  /** `devices`: the daemon's mDNS cache. */
  devices?: { ip?: string; port?: number }[];
}

export interface ProcRunner {
  spawn(tag: string, cmd: string, args: string[], env?: Record<string, string>): Proc;
  /** Runs doubletake-ctl against one daemon socket. */
  ctl(socket: string, args: string[]): Promise<CtlReply>;
  /** Resolves once X display :n accepts connections (its socket exists). */
  waitForDisplay(n: number, timeoutMs: number): Promise<void>;
  /** Removes stale X lock/socket files and old daemon sockets before reusing a slot. */
  cleanSlot(n: number, socket: string): void;
  sleep(ms: number): Promise<void>;
}

export interface AirplayOptions {
  runner: ProcRunner;
  log: Logger;
  /** Writable directory for sockets and Chromium profiles (e.g. /tmp/bargames-cast). */
  runDir: string;
  /** doubletake credentials file (persisted, e.g. /data/airplay-credentials.json). */
  credsFile: string;
  hwaccel?: string;
  chromium?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** First X display number; each channel takes the next free one. */
  firstDisplay?: number;
  /** First UDP port; each channel gets a block of 30 (doubletake needs 3 per TV). */
  firstPort?: number;
  /** How long show()/pair() wait for "streaming" before answering. */
  settleMs?: number;
  /** A TV missing from the daemon this long after connect counts as dropped (retried). */
  connectTimeoutMs?: number;
  /** How long to wait for doubletake to discover a receiver on a non-7000 port. */
  discoverWaitMs?: number;
}

interface Target {
  ip: string;
  /** AirPlay port when it isn't 7000 (UxPlay picks its own). */
  port?: number;
  name: string;
  /** Last state doubletake reported for this TV. */
  state: string;
  detail?: string;
  /** When the last connect was sent. */
  since: number;
  /** For reconnect backoff. */
  failures: number;
  nextRetry: number;
}

interface Channel {
  url: string;
  slot: number;
  socket: string;
  procs: { xvfb: Proc; chrome: Proc; daemon: Proc };
  targets: Map<string, Target>;
}

/** The standard AirPlay port; receivers on other ports are reached through discovery. */
export const AIRPLAY_PORT = 7000;

const STREAMING = "streaming";
const NEEDS_CODE = "pin_required";

export function chromiumArgs(url: string, profileDir: string, width: number, height: number): string[] {
  return [
    "--kiosk",
    `--window-size=${width},${height}`,
    "--window-position=0,0",
    "--force-device-scale-factor=1",
    // The container has no user namespaces for Chromium's sandbox; it only ever loads
    // the venue's own game pages, and runs as an unprivileged user.
    "--no-sandbox",
    "--no-first-run",
    "--noerrdialogs",
    "--disable-infobars",
    "--disable-session-crashed-bubble",
    "--disable-translate",
    "--disable-features=Translate,MediaRouter",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--autoplay-policy=no-user-gesture-required",
    "--hide-scrollbars",
    "--check-for-update-interval=31536000",
    `--user-data-dir=${profileDir}`,
    url,
  ];
}

export class AirplayStreams implements StreamService {
  private readonly channels = new Map<string, Channel>();
  /** deviceId → url of the channel it belongs to. */
  private readonly member = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private readonly o: Required<Omit<AirplayOptions, "runner" | "log">> & Pick<AirplayOptions, "runner" | "log">;

  constructor(opts: AirplayOptions) {
    this.o = {
      hwaccel: "auto",
      chromium: "chromium",
      width: 1920,
      height: 1080,
      fps: 30,
      firstDisplay: 90,
      firstPort: 60000,
      settleMs: 12_000,
      connectTimeoutMs: 30_000,
      discoverWaitMs: 15_000,
      ...opts,
    };
  }

  /** Serializes channel changes (many TVs are shown in parallel). */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async startAirplay(device: DisplayDevice, content: { url: string }): Promise<ShowResult> {
    const ip = new URL(device.address).hostname;
    // The AirPlay port comes from discovery (meta.port); a Roku's address is its ECP port, not AirPlay's.
    const port = Number(device.meta?.port) && Number(device.meta?.port) !== AIRPLAY_PORT ? Number(device.meta?.port) : undefined;
    const ch = await this.locked(async () => {
      const current = this.member.get(device.id);
      if (current && current !== content.url) await this.leave(device.id);
      const channel = this.channels.get(content.url) ?? (await this.open(content.url));
      if (!channel.targets.has(device.id)) {
        const t: Target = { ip, port, name: device.name, state: "connecting", since: Date.now(), failures: 0, nextRetry: 0 };
        channel.targets.set(device.id, t);
        this.member.set(device.id, content.url);
        await this.connect(channel, t);
      }
      return channel;
    });
    return this.settle(ch, device.id);
  }

  async pair(device: DisplayDevice, code: string): Promise<ShowResult> {
    const url = this.member.get(device.id);
    const ch = url ? this.channels.get(url) : undefined;
    const t = ch?.targets.get(device.id);
    if (!ch || !t) return { ok: false, message: `Cast something to ${device.name} first; its AirPlay code appears then.` };
    await this.awaitDiscovered(ch, t);
    await this.o.runner.ctl(ch.socket, ["connect", t.ip, code]);
    return this.settle(ch, device.id);
  }

  async hlsUrl(): Promise<string> {
    throw new NotBuiltYet("HLS delivery (for Rokus without AirPlay) is not built yet");
  }

  async stopFor(deviceId: string): Promise<void> {
    await this.locked(() => this.leave(deviceId));
  }

  state(deviceId: string): StreamState | undefined {
    const url = this.member.get(deviceId);
    const t = url ? this.channels.get(url)?.targets.get(deviceId) : undefined;
    if (!url || !t) return undefined;
    return { delivery: "airplay", url, state: t.state, needsCode: t.state === NEEDS_CODE, detail: t.detail };
  }

  /** Watchdog: restarts dead channels, reconnects TVs that dropped. */
  start(intervalMs = 5000): void {
    this.timer ??= setInterval(() => void this.locked(() => this.tick()).catch((err) => this.o.log.warn("airplay", "watchdog failed", { err: String(err) })), intervalMs);
    this.timer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.locked(async () => {
      for (const ch of [...this.channels.values()]) this.close(ch);
    });
  }

  // ---------------------------------------------------------------- internals

  private async open(url: string): Promise<Channel> {
    const used = new Set([...this.channels.values()].map((c) => c.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const display = this.o.firstDisplay + slot;
    const socket = `${this.o.runDir}/doubletake-${display}.sock`;
    const port = this.o.firstPort + slot * 30;
    const { runner, width, height } = this.o;
    runner.cleanSlot(display, socket);

    const xvfb = runner.spawn(`xvfb:${display}`, "Xvfb", [`:${display}`, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-nocursor"]);
    try {
      await runner.waitForDisplay(display, 5000);
    } catch (err) {
      xvfb.kill();
      throw new Error(`virtual display :${display} didn't start: ${xvfb.tail().slice(-3).join(" | ") || String(err)}`);
    }
    const env = { DISPLAY: `:${display}`, XDG_RUNTIME_DIR: this.o.runDir };
    const chrome = runner.spawn(`chromium:${display}`, this.o.chromium, chromiumArgs(url, `${this.o.runDir}/chromium-${display}`, width, height), env);
    const daemon = runner.spawn(
      `doubletake:${display}`,
      "doubletake",
      ["-daemonize", "-socket", socket, "-no-audio", "-hwaccel", this.o.hwaccel, "-fps", String(this.o.fps), "-creds", this.o.credsFile, "-port-range", `${port}-${port + 29}`],
      env,
    );
    const ch: Channel = { url, slot, socket, procs: { xvfb, chrome, daemon }, targets: new Map() };
    this.parkPointer(ch);
    // The daemon answers once its control socket is up.
    for (let i = 0; i < 25; i++) {
      const s = await runner.ctl(socket, ["status"]).catch(() => undefined);
      if (s?.ok) break;
      if (!daemon.alive || i === 24) {
        this.close(ch);
        throw new Error(`AirPlay sender didn't start: ${daemon.tail().slice(-3).join(" | ") || "no output"}`);
      }
      await runner.sleep(200);
    }
    this.channels.set(url, ch);
    this.o.log.info("airplay", "channel opened", { url, display });
    return ch;
  }

  /**
   * No mouse on a TV. -nocursor hides X's own cursor, but Chromium draws an arrow on its
   * window and centers the pointer when the window opens, so the watchdog keeps parking
   * it on the bottom-right pixel, where the arrow is drawn off-screen.
   */
  private parkPointer(ch: Channel): void {
    const display = this.o.firstDisplay + ch.slot;
    this.o.runner.spawn(`pointer:${display}`, "xdotool", ["mousemove", String(this.o.width - 1), String(this.o.height - 1)], { DISPLAY: `:${display}` });
  }

  private close(ch: Channel): void {
    for (const p of [ch.procs.daemon, ch.procs.chrome, ch.procs.xvfb]) p.kill();
    for (const id of ch.targets.keys()) this.member.delete(id);
    this.channels.delete(ch.url);
    this.o.log.info("airplay", "channel closed", { url: ch.url });
  }

  private async leave(deviceId: string): Promise<void> {
    const url = this.member.get(deviceId);
    const ch = url ? this.channels.get(url) : undefined;
    this.member.delete(deviceId);
    if (!ch) return;
    const t = ch.targets.get(deviceId);
    ch.targets.delete(deviceId);
    if (t) await this.o.runner.ctl(ch.socket, ["disconnect", t.ip]).catch(() => undefined);
    if (ch.targets.size === 0) this.close(ch);
  }

  /**
   * doubletake-ctl can't pass a port: the daemon uses the port from its own mDNS cache
   * for a known IP, else 7000. For a receiver on another port, wait until the daemon
   * has discovered it (its scan runs every few seconds).
   */
  private async awaitDiscovered(ch: Channel, t: Target): Promise<void> {
    if (!t.port) return;
    const deadline = Date.now() + this.o.discoverWaitMs;
    for (;;) {
      const r = await this.o.runner.ctl(ch.socket, ["devices"]).catch(() => undefined);
      if (r?.devices?.some((d) => d.ip === t.ip)) return;
      if (Date.now() >= deadline) {
        this.o.log.warn("airplay", "receiver not in doubletake's discovery; connecting on 7000", { tv: t.name, ip: t.ip, port: t.port });
        return;
      }
      await this.o.runner.sleep(500);
    }
  }

  private async connect(ch: Channel, t: Target): Promise<void> {
    await this.awaitDiscovered(ch, t);
    const r = await this.o.runner.ctl(ch.socket, ["connect", t.ip]).catch((err: Error) => ({ ok: false, error: err.message }) as CtlReply);
    if (!r.ok) Object.assign(t, { state: "error", detail: r.error ?? r.message });
  }

  /** Refreshes target states from the daemon. */
  private async refresh(ch: Channel): Promise<void> {
    const s = await this.o.runner.ctl(ch.socket, ["status"]).catch(() => undefined);
    if (!s?.ok) return;
    const byIp = new Map((s.streams ?? []).map((x) => [x.device_ip, x]));
    for (const t of ch.targets.values()) {
      const st = byIp.get(t.ip);
      const waiting = t.state === "connecting" && Date.now() - t.since < this.o.connectTimeoutMs;
      t.state = st?.state ?? (waiting ? "connecting" : "dropped");
      t.detail = st?.error;
      if (t.state === STREAMING) t.failures = 0;
    }
  }

  /** Waits briefly for a TV to stream (or to ask for its code), then answers. */
  private async settle(ch: Channel, deviceId: string): Promise<ShowResult> {
    const deadline = Date.now() + this.o.settleMs;
    for (;;) {
      await this.refresh(ch);
      const t = ch.targets.get(deviceId);
      if (!t) return { ok: false, message: "stopped" };
      if (t.state === STREAMING) return { ok: true, delivery: "airplay" };
      if (t.state === NEEDS_CODE) return { ok: false, delivery: "airplay", needsCode: true, message: `${t.name} is showing an AirPlay code. Enter it under TVs (needed once per TV).` };
      if (t.state === "error") return { ok: false, delivery: "airplay", message: t.detail ?? "AirPlay connection failed" };
      if (Date.now() >= deadline) return { ok: true, delivery: "airplay", message: `${t.name}: still connecting (${t.state})` };
      await this.o.runner.sleep(500);
    }
  }

  private async tick(): Promise<void> {
    for (const ch of [...this.channels.values()]) {
      const { xvfb, chrome, daemon } = ch.procs;
      if (!xvfb.alive || !chrome.alive || !daemon.alive) {
        const dead = Object.entries(ch.procs).filter(([, p]) => !p.alive).map(([k, p]) => `${k}: ${p.tail().slice(-2).join(" | ")}`);
        this.o.log.warn("airplay", "channel died, restarting", { url: ch.url, dead });
        const targets = [...ch.targets.entries()];
        this.close(ch);
        const fresh = await this.open(ch.url).catch((err: Error) => {
          this.o.log.error("airplay", "channel restart failed", { url: ch.url, err: err.message });
          return undefined;
        });
        if (!fresh) continue;
        for (const [id, t] of targets) {
          fresh.targets.set(id, { ...t, state: "connecting", since: Date.now() });
          this.member.set(id, ch.url);
          await this.connect(fresh, fresh.targets.get(id)!);
        }
        continue;
      }
      this.parkPointer(ch);
      await this.refresh(ch);
      const now = Date.now();
      for (const t of ch.targets.values()) {
        if (t.state !== "dropped" && t.state !== "error") continue;
        if (now < t.nextRetry) continue;
        t.failures++;
        t.nextRetry = now + Math.min(60_000, 5000 * 2 ** Math.min(t.failures - 1, 4));
        this.o.log.info("airplay", "reconnecting", { tv: t.name, ip: t.ip, attempt: t.failures });
        t.state = "connecting";
        t.since = now;
        await this.connect(ch, t);
      }
    }
  }
}
