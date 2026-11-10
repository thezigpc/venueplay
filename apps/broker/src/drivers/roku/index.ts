import type { Capabilities, DeliveryMethod, DisplayContent, DisplayDevice, DisplayDriver, Health, ShowResult, StreamService } from "../../types.js";
import { RokuEcp } from "./ecp.js";
import { ssdpSearch } from "./ssdp.js";

/** Sideloaded dev channel id; our HLS player app (Phase 3) is installed as the dev app. */
export const ROKU_DEV_APP = "dev";

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
      meta: { softwareVersion: info.softwareVersion, supportsAirplay: info.supportsAirplay, developerEnabled: info.developerEnabled, networkType: info.networkType },
    };
  }

  async capabilities(device: DisplayDevice): Promise<Capabilities> {
    const delivery: DeliveryMethod[] = [];
    // device-info doesn't always report AirPlay; unknown counts as "try it".
    if (device.meta?.supportsAirplay !== false) delivery.push("airplay");
    if (device.meta?.developerEnabled) delivery.push("roku-hls");
    return {
      delivery,
      power: true,
      inputs: device.isTv ? ["hdmi1", "hdmi2", "hdmi3", "hdmi4", "tuner"] : [],
    };
  }

  async power(device: DisplayDevice, on: boolean): Promise<void> {
    const ecp = this.ecp(device);
    await (on ? ecp.powerOn() : ecp.powerOff());
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
    await this.streams.stopFor(device.id);
    await this.ecp(device).keypress("Home");
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
