// Apple TVs (tvOS). Content goes over AirPlay, like any AirPlay TV. The remote, power,
// apps and typing go over Apple's Companion protocol (what the iPhone's remote uses),
// through atv-helper.py (pyatv). That needs a one-time PIN pairing: staff press "Pair TV
// control", the Apple TV shows a 4-digit PIN, staff type it in.
//
// An Apple TV saved earlier as plain "AirPlay" moves over to this driver (the registry
// carries its name, room and settings).

import type { JsonStore } from "@bargames/common";
import { connect } from "node:net";
import { redactUrls, type Capabilities, type DeliveryMethod, type DisplayContent, type DisplayDevice, type DisplayDriver, type Health, type ShowResult, type StreamService, type StreamState, type VideoAction, type VideoInfo, type VideoRequest, type VideoResult, type VideoStatus } from "../../types.js";
import { AtvError, type AtvCall } from "./helper.js";

/** Pairing credentials per Apple TV (Companion). Kept out of displays.json. */
export interface AppleTvAuth {
  credentials: Record<string, string>;
  /** Box 0.27.0: AirPlay credentials (pyatv), for handing the Apple TV video links. */
  airplay?: Record<string, string>;
}

/** The box's remote keys an Apple TV takes (the helper maps them to Companion commands). */
export const APPLETV_KEYS = ["Up", "Down", "Left", "Right", "Select", "Back", "Home", "Play", "Rev", "Fwd", "VolumeUp", "VolumeDown"] as const;

interface Found {
  identifier: string;
  name: string;
  address: string;
  model?: string;
  version?: string;
}

export function deviceFromScan(f: Found): DisplayDevice {
  return {
    id: `appletv:${f.identifier.toLowerCase()}`,
    driver: "appletv",
    name: f.name,
    // AirPlay goes to the address's host (port 7000); Companion is found by the helper.
    address: `http://${f.address}:7000`,
    model: f.model || "Apple TV",
    isTv: false,
    meta: { identifier: f.identifier, tvos: f.version },
  };
}

export class AppleTvDriver implements DisplayDriver {
  readonly id = "appletv";

  constructor(
    private readonly streams: StreamService,
    private readonly auth: JsonStore<AppleTvAuth>,
    private readonly o: { call: AtvCall; clientName?: () => string; reachable?: (host: string) => Promise<boolean> },
  ) {}

  /** Box 0.27.0: which PIN the Apple TV is showing now (Companion first, then AirPlay). */
  private readonly pairing = new Map<string, "companion" | "airplay">();

  private airplayCreds(device: DisplayDevice): string | undefined {
    return this.auth.get().airplay?.[device.id];
  }

  private creds(device: DisplayDevice): string | undefined {
    return this.auth.get().credentials[device.id];
  }

  private target(device: DisplayDevice) {
    return { identifier: String(device.meta?.identifier ?? device.id.replace(/^appletv:/, "")), address: new URL(device.address).hostname };
  }

  async discover(timeoutMs = 3000): Promise<DisplayDevice[]> {
    const found = (await this.o.call("scan", { timeout: Math.max(2, Math.ceil(timeoutMs / 1000)) }, timeoutMs + 8000)) as Found[];
    return found.map(deviceFromScan);
  }

  /** An Apple TV added by IP (mDNS blocked). */
  async probe(host: string): Promise<DisplayDevice> {
    const found = (await this.o.call("scan", { timeout: 4, hosts: [host] }, 15_000)) as Found[];
    if (!found[0]) throw new Error(`no Apple TV answers at ${host}`);
    return deviceFromScan(found[0]);
  }

  async capabilities(device: DisplayDevice): Promise<Capabilities> {
    const paired = Boolean(this.creds(device));
    return {
      delivery: ["airplay"],
      power: paired,
      inputs: [],
      remoteKeys: paired ? [...APPLETV_KEYS] : [],
      apps: paired,
      text: paired,
      control: { paired },
    };
  }

  /** One Companion call; turns helper errors into something staff can act on. */
  private async control(device: DisplayDevice, op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const credentials = this.creds(device);
    if (!credentials) throw Object.assign(new Error(`${device.name} isn't paired for TV control yet: TV panel > Setup > Pair TV control`), { status: 400 });
    try {
      return await this.o.call(op, { ...this.target(device), credentials, ...args });
    } catch (err) {
      if (!(err instanceof AtvError)) throw err;
      if (err.code === "auth") {
        await this.forget(device);
        throw Object.assign(new Error(`${device.name} no longer accepts the box's pairing (removed in the Apple TV's Settings > Remotes and Devices?). Pair TV control again.`), { status: 409 });
      }
      if (err.code === "offline") throw Object.assign(new Error(`${device.name} isn't answering (${err.message})`), { status: 502 });
      if (err.code === "unsupported") throw Object.assign(new Error(`${device.name}: ${err.message}`), { status: 400 });
      throw Object.assign(new Error(`${device.name}: ${err.message}`), { status: 502 });
    }
  }

  async power(device: DisplayDevice, on: boolean): Promise<void> {
    await this.control(device, "power", { on });
  }

  async setInput(device: DisplayDevice): Promise<void> {
    throw Object.assign(new Error(`${device.name} is an Apple TV; it has no inputs (change the TV's input with the TV's own remote, or HDMI-CEC)`), { status: 400 });
  }

  async keypress(device: DisplayDevice, key: string): Promise<void> {
    if (!(APPLETV_KEYS as readonly string[]).includes(key)) throw Object.assign(new Error(`${device.name} has no "${key}" key`), { status: 400 });
    await this.control(device, "key", { key });
  }

  async listApps(device: DisplayDevice): Promise<{ apps: { id: string; name: string }[]; active?: string }> {
    const apps = (await this.control(device, "apps")) as { id: string; name: string }[];
    return { apps: apps.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /** Box 0.20.0: the app in front (pyatv metadata over the paired connection); undefined if it can't say. */
  async foregroundApp(device: DisplayDevice): Promise<{ id: string; name: string; home: boolean } | undefined> {
    if (!this.creds(device)) return undefined;
    const a = (await this.control(device, "now")) as { id?: string; name?: string; unknown?: boolean } | null;
    if (a?.unknown) return undefined;
    if (!a?.id) return { id: "home", name: "Home screen", home: true };
    return { id: a.id, name: a.name || a.id, home: false };
  }

  async launchChannel(device: DisplayDevice, appId: string): Promise<void> {
    await this.control(device, "launch", { app: appId });
  }

  async typeText(device: DisplayDevice, text: string): Promise<void> {
    await this.control(device, "text", { text });
  }

  async show(device: DisplayDevice, content: DisplayContent, delivery: DeliveryMethod): Promise<ShowResult> {
    if (content.kind === "off") {
      await this.stop(device);
      return { ok: true };
    }
    if (content.kind === "idle") return { ok: false, message: "idle screen is rendered by the broker (Phase 3)" };
    if (content.kind === "external") return { ok: false, message: "an app on the TV: nothing to cast" };
    if (delivery !== "airplay") return { ok: false, message: `Apple TVs can't use ${delivery}` };
    return this.streams.startAirplay(device, content);
  }

  async stop(device: DisplayDevice): Promise<void> {
    await this.streams.stopFor(device.id);
  }

  /** AirPlay pairing (for casting). */
  async pair(device: DisplayDevice, code?: string): Promise<ShowResult> {
    if (!this.streams.pair) return { ok: false, message: "AirPlay isn't available on this box" };
    if (!code) return { ok: false, message: "no code" };
    return this.streams.pair(device, code);
  }

  /** Companion pairing. Without a PIN the Apple TV shows one; with it, the box keeps the credentials. */
  async pairControl(device: DisplayDevice, pin?: string): Promise<ShowResult> {
    const name = this.o.clientName?.() ?? "Bar Games box";
    try {
      if (!pin) {
        this.pairing.set(device.id, "companion");
        await this.o.call("pair_begin", { ...this.target(device), name });
        return { ok: false, needsCode: true, message: "Enter the PIN the Apple TV is showing." };
      }
      const step = this.pairing.get(device.id) ?? "companion";
      const r = (await this.o.call("pair_finish", { identifier: this.target(device).identifier, pin })) as { credentials: string };
      if (step === "airplay") {
        this.pairing.delete(device.id);
        await this.auth.update((s) => {
          (s.airplay ??= {})[device.id] = r.credentials;
        });
        return { ok: true, message: "Paired. The box can now use this Apple TV's remote, open its apps, type into it, put it to sleep or wake it, and hand it movies to play." };
      }
      await this.auth.update((s) => {
        s.credentials[device.id] = r.credentials;
      });
      // Box 0.27.0: then AirPlay, so apps can hand it video links. A second PIN; skippable.
      try {
        await this.o.call("pair_begin", { ...this.target(device), name, protocol: "airplay" });
        this.pairing.set(device.id, "airplay");
        return { ok: false, needsCode: true, message: "TV control is paired. The Apple TV now shows a second PIN, so the box can hand it movies to play: enter it too (or leave it; the remote works already)." };
      } catch {
        this.pairing.delete(device.id);
        return { ok: true, message: "Paired. The box can now use this Apple TV's remote, open its apps, type into it, and put it to sleep or wake it." };
      }
    } catch (err) {
      if (err instanceof AtvError) return { ok: false, needsCode: err.code === "pin", message: `${device.name}: ${err.message}` };
      throw err;
    }
  }

  // ---- Box 0.27.0: video links the Apple TV plays itself (AirPlay)

  videoInfo(device: DisplayDevice): VideoInfo {
    return { kind: "appletv", model: device.model || "Apple TV" };
  }

  private async videoCall(device: DisplayDevice, op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.o.call(op, { ...this.target(device), credentials: this.creds(device), airplay: this.airplayCreds(device), ...args }, timeoutMs);
  }

  private videoFailure(device: DisplayDevice, err: unknown): VideoResult {
    if (err instanceof AtvError) {
      const message = redactUrls(err.message);
      if (err.code === "needs-pairing" || err.code === "auth")
        return { ok: false, reason: "needs-pairing", message: `${device.name} needs the box paired for movies: TVs > ${device.name} > Setup > Pair TV control (it shows two PINs)` };
      if (err.code === "offline") return { ok: false, reason: "offline", message: `${device.name} isn't answering` };
      if (err.code === "unsupported") return { ok: false, reason: "unsupported", message: `${device.name}: ${message}` };
      return { ok: false, reason: "error", message: `${device.name}: ${message}` };
    }
    return { ok: false, reason: "error", message: `${device.name}: ${redactUrls(String(err instanceof Error ? err.message : err))}` };
  }

  async playVideo(device: DisplayDevice, v: VideoRequest): Promise<VideoResult> {
    // The box's own AirPlay mirror would fight the video for the screen.
    if (this.streams.state?.(device.id)) await this.streams.stopFor(device.id).catch(() => undefined);
    try {
      await this.videoCall(device, "video_play", { url: v.url, ...(v.startAt ? { startAt: v.startAt } : {}) }, 40_000);
      return { ok: true };
    } catch (err) {
      return this.videoFailure(device, err);
    }
  }

  async videoControl(device: DisplayDevice, action: VideoAction): Promise<VideoResult> {
    try {
      await this.videoCall(device, "video_control", typeof action === "object" ? { action: "seek", position: action.seek } : { action });
      return { ok: true };
    } catch (err) {
      return this.videoFailure(device, err);
    }
  }

  async videoStatus(device: DisplayDevice): Promise<VideoStatus> {
    try {
      return (await this.videoCall(device, "video_status", {})) as VideoStatus;
    } catch (err) {
      return { state: "error", message: this.videoFailure(device, err).message };
    }
  }

  async forget(device: DisplayDevice): Promise<void> {
    if (!this.creds(device) && !this.airplayCreds(device)) return;
    await this.auth.update((s) => {
      delete s.credentials[device.id];
      if (s.airplay) delete s.airplay[device.id];
    });
  }

  streamState(device: DisplayDevice): StreamState | undefined {
    return this.streams.state?.(device.id);
  }

  preview(device: DisplayDevice): Promise<Buffer | undefined> {
    return this.streams.preview?.(device.id) ?? Promise.resolve(undefined);
  }

  async health(device: DisplayDevice): Promise<Health> {
    const online = await (this.o.reachable ?? airplayReachable)(new URL(device.address).hostname);
    if (!online) return { online, detail: "not answering (unplugged, or off the network)" };
    return this.creds(device) ? { online } : { online, detail: "not paired for TV control" };
  }
}

function airplayReachable(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port: 7000 });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(2000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}
