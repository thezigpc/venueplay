import { isSeek, redactUrls, type Capabilities, type DeliveryMethod, type DisplayContent, type DisplayDevice, type DisplayDriver, type Health, type ShowResult, type StreamService, type StreamState, type VideoAction, type VideoInfo, type VideoRequest, type VideoResult, type VideoStatus } from "../../types.js";
import { RokuEcp, type RokuPlayer } from "./ecp.js";
import { ssdpSearch } from "./ssdp.js";

/** Sideloaded dev channel id; our HLS player app (Phase 3) is installed as the dev app. */
export const ROKU_DEV_APP = "dev";

/** The remote's keys (ECP names). Power and inputs have their own controls. */
export const ROKU_REMOTE_KEYS = ["Home", "Back", "Up", "Down", "Left", "Right", "Select", "Play", "Rev", "Fwd", "InstantReplay", "Info", "Search", "Backspace", "Enter"] as const;
/** Volume and channel keys work on Roku TVs (a player sends volume over HDMI-CEC at best). */
/** TV apps media providers may start, by our name → Roku channel id. */
export const ROKU_APPS: Record<string, string> = { youtube: "837" };
/** Our app name → its DIAL application name. */
export const DIAL_NAMES: Record<string, string> = { youtube: "YouTube" };
export const ROKU_TV_KEYS = ["VolumeUp", "VolumeDown", "VolumeMute", "ChannelUp", "ChannelDown"] as const;

export class RokuDriver implements DisplayDriver {
  readonly id = "roku";

  constructor(
    private readonly streams: StreamService,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  ecp(device: DisplayDevice): RokuEcp {
    return new RokuEcp(device.address, this.doFetch);
  }

  async discover(timeoutMs = 3000): Promise<DisplayDevice[]> {
    const hits = await ssdpSearch("roku:ecp", timeoutMs);
    const devices = await Promise.all(
      hits.map(async (hit) => {
        const base = new URL(hit.location).origin;
        try {
          return await this.probe(base);
        } catch {
          return undefined; // seen but not answering ECP (asleep / blocked)
        }
      }),
    );
    return devices.filter((d): d is DisplayDevice => Boolean(d));
  }

  /** Builds a device from an ECP address (also used for manually added TVs). */
  async probe(base: string): Promise<DisplayDevice> {
    const info = await new RokuEcp(base, this.doFetch).deviceInfo();
    return {
      id: `roku:${info.serial || info.udn}`,
      driver: this.id,
      name: info.friendlyName,
      address: base,
      model: `${info.modelName} ${info.modelNumber}`.trim(),
      isTv: info.isTv,
      meta: { softwareVersion: info.softwareVersion, supportsAirplay: info.supportsAirplay, developerEnabled: info.developerEnabled, networkType: info.networkType, supportsSuspend: info.supportsSuspend },
    };
  }

  async capabilities(device: DisplayDevice): Promise<Capabilities> {
    const delivery: DeliveryMethod[] = [];
    // device-info doesn't always report AirPlay; unknown counts as "try it".
    if (device.meta?.supportsAirplay !== false) delivery.push("airplay");
    if (device.meta?.developerEnabled) delivery.push("roku-hls");
    return {
      delivery,
      // ECP PowerOn/PowerOff only work on Roku TVs and players that can sleep. An Express
      // or Stick accepts the keypress and ignores it, so don't offer a button that can't work.
      power: Boolean(device.isTv || device.meta?.supportsSuspend),
      inputs: device.isTv ? ["hdmi1", "hdmi2", "hdmi3", "hdmi4", "tuner"] : [],
      remoteKeys: [...ROKU_REMOTE_KEYS, ...(device.isTv ? ROKU_TV_KEYS : [])],
      apps: true,
      text: true,
      tvChannels: Boolean(device.isTv),
    };
  }

  async power(device: DisplayDevice, on: boolean): Promise<void> {
    if (!(await this.capabilities(device)).power) throw new Error(`${device.name} is a Roku player that can't be switched off over the network; switch the TV itself (its own remote or HDMI-CEC)`);
    const ecp = this.ecp(device);
    await (on ? ecp.powerOn() : ecp.powerOff());
  }

  launchableApps(): string[] {
    return Object.keys(ROKU_APPS);
  }

  async launchApp(device: DisplayDevice, app: string): Promise<{ ok: true } | { ok: false; reason: "unsupported" | "offline" | "ecp-blocked" | "error"; message: string }> {
    const channel = ROKU_APPS[app];
    if (!channel) return { ok: false, reason: "unsupported", message: `${device.name} can't start ${app}` };
    try {
      await this.ecp(device).launch(channel);
      return { ok: true };
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (/Permissive|403/.test(msg)) return { ok: false, reason: "ecp-blocked", message: `${device.name} refused: on the Roku, set Settings → System → Advanced system settings → Control by mobile apps → Network access to Permissive` };
      if (/no built-in video player/.test(msg)) return { ok: false, reason: "unsupported", message: `${device.name} has no built-in video player for links (its Roku OS answers 404). Installing "Roku Media Player" from the Roku channel store may add it; other TVs can play this` };
  if (/abort|timeout|ECONNREFUSED|EHOSTUNREACH|fetch failed/i.test(msg)) return { ok: false, reason: "offline", message: `${device.name} isn't answering` };
      return { ok: false, reason: "error", message: msg };
    }
  }

  /** YouTube's Lounge screen id over DIAL (GET http://roku:8060/dial/YouTube). Never launches anything. */
  async dialScreenId(device: DisplayDevice, app: string): Promise<string | undefined> {
    const dialName = DIAL_NAMES[app];
    if (!dialName) return undefined;
    try {
      // Roku's DIAL server answers 403 without an Origin; a "package:" origin (as a phone app
      // sends) is accepted. Ours names this box, not someone else's app.
      const res = await this.doFetch(`${device.address.replace(/\/$/, "")}/dial/${dialName}`, { headers: { origin: DIAL_ORIGIN }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) return undefined;
      const m = /<screenId>([^<]+)<\/screenId>/i.exec(await res.text());
      return m?.[1]?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** What's on screen: our app name when it's one we launch (837 → "youtube"), or "home". */
  async foregroundApp(device: DisplayDevice): Promise<{ id: string; name: string; app?: string; home: boolean } | undefined> {
    const a = await this.ecp(device).activeApp();
    if (!a) return undefined;
    const app = Object.entries(ROKU_APPS).find(([, ch]) => ch === a.id)?.[0];
    // The home screen is a "home" app (Roku Dynamic Menu); older firmware reports just "Roku".
    const home = a.id === "562859" || /^roku( dynamic menu)?$/i.test(a.name);
    return { id: a.id, name: a.name, ...(app ? { app } : {}), home };
  }

  /** Installed channels and the one on screen (remote's Apps list). */
  async listApps(device: DisplayDevice): Promise<{ apps: { id: string; name: string }[]; active?: string }> {
    const ecp = this.ecp(device);
    const [apps, active] = await Promise.all([ecp.apps(), ecp.activeApp().catch(() => undefined)]);
    return { apps, active: active?.id };
  }

  appIcon(device: DisplayDevice, appId: string): Promise<{ type: string; data: Buffer } | undefined> {
    return this.ecp(device).icon(appId);
  }

  /** Starts any installed channel by its Roku id (from listApps). */
  async launchChannel(device: DisplayDevice, appId: string): Promise<void> {
    await this.ecp(device).launch(appId);
  }

  async keypress(device: DisplayDevice, key: string): Promise<void> {
    if (!(await this.capabilities(device)).remoteKeys?.includes(key)) throw Object.assign(new Error(`${device.name} has no "${key}" key`), { status: 400 });
    await this.ecp(device).keypress(key);
  }

  /** ECP types one character per Lit_ keypress. */
  async typeText(device: DisplayDevice, text: string): Promise<void> {
    const ecp = this.ecp(device);
    for (const ch of text) await ecp.keypress(`Lit_${ch}`);
  }

  preview(device: DisplayDevice): Promise<Buffer | undefined> {
    return this.streams.preview?.(device.id) ?? Promise.resolve(undefined);
  }

  // ---- Box 0.27.0: a video URL the Roku plays itself (its built-in player, channel 15985)

  videoInfo(device: DisplayDevice): VideoInfo {
    // device.model is "Roku Express 3930X": the last word is the model number.
    return { kind: "roku", model: (device.model ?? "").split(/\s+/).pop() || "Roku" };
  }

  async playVideo(device: DisplayDevice, v: VideoRequest): Promise<VideoResult> {
    if (this.streams.state?.(device.id)) await this.streams.stopFor(device.id).catch(() => undefined);
    try {
      await this.ecp(device).playUrl({ url: v.url, title: v.title, poster: v.poster, format: rokuFormat(v.mime, v.url) });
    } catch (err) {
      return rokuFailure(device, err);
    }
    // The built-in player can't start part-way through or seek.
    return v.startAt ? { ok: true, message: `${device.name} starts from the beginning (a Roku can't start part-way through)` } : { ok: true };
  }

  async videoControl(device: DisplayDevice, action: VideoAction): Promise<VideoResult> {
    try {
      const ecp = this.ecp(device);
      if (typeof action === "object") return { ok: false, reason: "unsupported", message: isSeek(action) ? `${device.name} can't seek (a Roku's built-in player can't); use pause and resume` : `${device.name} can't switch tracks by itself` };
      if (action === "stop") {
        await ecp.keypress("Home");
        return { ok: true };
      }
      // Play is a toggle on a Roku: press it only when it would do what was asked.
      const p = await ecp.mediaPlayer();
      if (p.plugin !== ROKU_URL_PLAYER) return { ok: false, reason: "error", message: `${device.name} isn't playing the video any more` };
      const playing = ["play", "buffer", "startup"].includes(p.state);
      if ((action === "pause" && playing) || (action === "resume" && p.state === "pause")) await ecp.keypress("Play");
      return { ok: true };
    } catch (err) {
      return rokuFailure(device, err);
    }
  }

  async videoStatus(device: DisplayDevice): Promise<VideoStatus> {
    let p: RokuPlayer;
    try {
      p = await this.ecp(device).mediaPlayer();
    } catch (err) {
      return { state: "error", message: rokuFailure(device, err).message };
    }
    // Something else playing (another channel) means our video has stopped.
    if (p.plugin && p.plugin !== ROKU_URL_PLAYER) return { state: "stopped" };
    const times = { ...(p.position !== undefined ? { position: p.position } : {}), ...(p.duration ? { duration: p.duration } : {}) };
    if (p.error) return { state: "error", ...times, message: `${device.name} couldn't play the video (its format, or the server refused the TV)` };
    if (["play", "buffer", "startup", "open"].includes(p.state)) return { state: "playing", ...times };
    if (p.state === "pause") return { state: "paused", ...times };
    return { state: "stopped", ...times };
  }

  /** Live TV on a Roku TV's tuner: ECP launch tvinput.dtv?ch=7.1. */
  async tuneChannel(device: DisplayDevice, channel: string): Promise<void> {
    if (!device.isTv) throw Object.assign(new Error(`${device.name} is a Roku player; it has no TV tuner`), { status: 400 });
    if (!TV_CHANNEL.test(channel)) throw Object.assign(new Error("channel: like 7 or 7.1"), { status: 400 });
    await this.ecp(device).launch("tvinput.dtv", { ch: channel });
  }

  async setInput(device: DisplayDevice, input: string): Promise<void> {
    if (!device.isTv) throw new Error(`${device.name} is a Roku player; it has no inputs`);
    await this.ecp(device).setInput(input);
  }

  async show(device: DisplayDevice, content: DisplayContent, delivery: DeliveryMethod): Promise<ShowResult> {
    if (content.kind === "off") {
      await this.stop(device);
      return { ok: true };
    }
    if (content.kind === "idle") return { ok: false, message: "idle screen is rendered by the broker (Phase 3)" };
    if (content.kind === "external") return { ok: false, message: "an app on the TV: nothing to cast" };
    switch (delivery) {
      case "airplay":
        return this.streams.startAirplay(device, content);
      case "roku-hls": {
        const url = await this.streams.hlsUrl(content);
        await this.ecp(device).launch(ROKU_DEV_APP, { url });
        return { ok: true, delivery };
      }
      default:
        return { ok: false, message: `Roku cannot use ${delivery}` };
    }
  }

  async stop(device: DisplayDevice): Promise<void> {
    // Ending the AirPlay session returns the Roku to what it showed before. (The HLS
    // app, when built, will need an ECP Home keypress here.)
    await this.streams.stopFor(device.id);
  }

  /** AirPlay pairing: the screen to show while pairing is supplied by the registry. */
  async pair(device: DisplayDevice, code?: string): Promise<ShowResult> {
    if (!this.streams.pair) return { ok: false, message: "AirPlay isn't available on this box" };
    if (!code) return { ok: false, message: "no code" };
    return this.streams.pair(device, code);
  }

  streamState(device: DisplayDevice): StreamState | undefined {
    return this.streams.state?.(device.id);
  }

  async health(device: DisplayDevice): Promise<Health> {
    try {
      const info = await this.ecp(device).deviceInfo();
      return { online: true, powerMode: info.powerMode };
    } catch (err) {
      return { online: false, detail: String(err) };
    }
  }
}

/** Roku's built-in URL player ("Play on Roku"). */
export const ROKU_URL_PLAYER = "15985";

/** The built-in player's videoFormat, from the MIME type (or the URL's extension). */
export function rokuFormat(mime?: string, url?: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("mpegurl")) return "hls";
  if (m.includes("matroska")) return "mkv";
  if (m.includes("quicktime")) return "mov";
  if (m.includes("dash")) return "dash";
  if (m.startsWith("video/")) return "mp4";
  let path = "";
  try {
    path = new URL(url ?? "").pathname.toLowerCase();
  } catch {
    /* not a URL: the default below */
  }
  if (path.endsWith(".m3u8")) return "hls";
  if (path.endsWith(".mkv")) return "mkv";
  if (path.endsWith(".mov")) return "mov";
  return "mp4";
}

function rokuFailure(device: DisplayDevice, err: unknown): VideoResult {
  const msg = redactUrls(String(err instanceof Error ? err.message : err));
  if (/Permissive|403/.test(msg)) return { ok: false, reason: "not-allowed", message: `${device.name} refused: on the Roku, set Settings → System → Advanced system settings → Control by mobile apps → Network access to Permissive` };
  if (/no built-in video player/.test(msg)) return { ok: false, reason: "unsupported", message: `${device.name} has no built-in video player for links (its Roku OS answers 404). Installing "Roku Media Player" from the Roku channel store may add it; other TVs can play this` };
  if (/abort|timeout|ECONNREFUSED|EHOSTUNREACH|fetch failed|didn't answer/i.test(msg)) return { ok: false, reason: "offline", message: `${device.name} isn't answering` };
  return { ok: false, reason: "error", message: `${device.name}: ${msg}` };
}

/** A tuner channel: "7", "7.1", "1004". */
export const TV_CHANNEL = /^\d{1,4}(\.\d{1,3})?$/;

/** The Origin our DIAL requests carry (Roku refuses DIAL without one). */
export const DIAL_ORIGIN = "package:com.bargames.box";
