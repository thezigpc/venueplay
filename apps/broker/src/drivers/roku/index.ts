import type { Capabilities, DeliveryMethod, DisplayContent, DisplayDevice, DisplayDriver, Health, ShowResult, StreamService, StreamState } from "../../types.js";
import { RokuEcp } from "./ecp.js";
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
      if (/abort|timeout|ECONNREFUSED|EHOSTUNREACH|fetch failed/i.test(msg)) return { ok: false, reason: "offline", message: `${device.name} isn't answering` };
      return { ok: false, reason: "error", message: msg };
    }
  }

  /** YouTube's Lounge screen id over DIAL (GET http://roku:8060/dial/YouTube). Never launches anything. */
  async dialScreenId(device: DisplayDevice, app: string): Promise<string | undefined> {
    const dialName = DIAL_NAMES[app];
    if (!dialName) return undefined;
    try {
      const res = await this.doFetch(`${device.address.replace(/\/$/, "")}/dial/${dialName}`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return undefined;
      const m = /<screenId>([^<]+)<\/screenId>/i.exec(await res.text());
      return m?.[1]?.trim() || undefined;
    } catch {
      return undefined;
    }
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
