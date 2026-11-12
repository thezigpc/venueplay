// Generic AirPlay receivers: Apple TV, AirPlay smart TVs (Samsung, LG, Vizio, …),
// software receivers (UxPlay). Found by mDNS (_airplay._tcp), streamed with the same
// AirPlay pipeline as the Rokus. No power or input control: AirPlay has none.
//
// Rokus also advertise AirPlay; the registry drops those duplicates so a Roku keeps
// its richer Roku driver (power, inputs).

import { connect } from "node:net";
import type { Capabilities, DeliveryMethod, DisplayContent, DisplayDevice, DisplayDriver, Health, ShowResult, StreamService, StreamState } from "../../types.js";
import { AIRPLAY_PORT } from "../../airplay.js";
import { mdnsBrowse, type MdnsService } from "./mdns.js";

export const AIRPLAY_SERVICE = "_airplay._tcp.local";
export { AIRPLAY_PORT } from "../../airplay.js";

/** Features is "0xLOW" or "0xLOW,0xHIGH"; bit 0 = video, bit 7 = screen mirroring. */
export function featureBits(features?: string): bigint | undefined {
  if (!features) return undefined;
  const [lo, hi] = features.split(",").map((x) => x.trim());
  try {
    return (BigInt(hi ?? "0") << 32n) | BigInt(lo ?? "0");
  } catch {
    return undefined;
  }
}

/** False for receivers that can't show video (HomePod, AirPort, speakers). */
export function canShowVideo(svc: Pick<MdnsService, "txt">): boolean {
  const model = svc.txt.model ?? "";
  if (/^(AudioAccessory|AirPort|AirReceiver)/i.test(model)) return false;
  const bits = featureBits(svc.txt.features ?? svc.txt.ft);
  if (bits === undefined) return true; // unknown: let staff try
  return (bits & 1n) !== 0n || (bits & 0x80n) !== 0n;
}

export function deviceFromService(svc: MdnsService): DisplayDevice | undefined {
  if (!svc.address) return undefined;
  const key = (svc.txt.deviceid || svc.txt.pi || svc.address).toLowerCase();
  const port = svc.port ?? AIRPLAY_PORT;
  return {
    id: `airplay:${key}`,
    driver: "airplay",
    name: svc.name,
    address: `http://${svc.address}:${port}`,
    model: svc.txt.model || undefined,
    meta: { deviceId: svc.txt.deviceid, features: svc.txt.features, srcvers: svc.txt.srcvers, manufacturer: svc.txt.manufacturer, port },
  };
}

export class AirplayDriver implements DisplayDriver {
  readonly id = "airplay";

  constructor(
    private readonly streams: StreamService,
    private readonly browse: (service: string, timeoutMs: number) => Promise<MdnsService[]> = mdnsBrowse,
  ) {}

  async discover(timeoutMs = 3000): Promise<DisplayDevice[]> {
    const found = await this.browse(AIRPLAY_SERVICE, timeoutMs);
    return found.filter(canShowVideo).map(deviceFromService).filter((d): d is DisplayDevice => Boolean(d));
  }

  /** A receiver added by IP (other subnet, mDNS blocked). Uses its mDNS identity if it answers. */
  async probe(host: string, timeoutMs = 2500): Promise<DisplayDevice> {
    const seen = (await this.browse(AIRPLAY_SERVICE, timeoutMs).catch(() => [])).find((s) => s.address === host);
    if (seen) {
      const dev = deviceFromService(seen);
      if (dev) return dev;
    }
    if (!(await reachable(host, AIRPLAY_PORT, 2500))) throw new Error(`nothing answers AirPlay on ${host}:${AIRPLAY_PORT}; if it uses another port (UxPlay does), make it visible to "Find TVs" instead`);
    return { id: `airplay:${host}`, driver: this.id, name: `AirPlay ${host}`, address: `http://${host}:${AIRPLAY_PORT}`, meta: { port: AIRPLAY_PORT, manual: true } };
  }

  async capabilities(): Promise<Capabilities> {
    return { delivery: ["airplay"], power: false, inputs: [] };
  }

  async power(device: DisplayDevice): Promise<void> {
    throw new Error(`${device.name} is an AirPlay receiver; the box can't switch it on or off`);
  }

  async setInput(device: DisplayDevice): Promise<void> {
    throw new Error(`${device.name} is an AirPlay receiver; it has no inputs the box can change`);
  }

  async show(device: DisplayDevice, content: DisplayContent, delivery: DeliveryMethod): Promise<ShowResult> {
    if (content.kind === "off") {
      await this.stop(device);
      return { ok: true };
    }
    if (content.kind === "idle") return { ok: false, message: "idle screen is rendered by the broker (Phase 3)" };
    if (delivery !== "airplay") return { ok: false, message: `AirPlay receivers can't use ${delivery}` };
    return this.streams.startAirplay(device, content);
  }

  async stop(device: DisplayDevice): Promise<void> {
    await this.streams.stopFor(device.id);
  }

  async pair(device: DisplayDevice, code?: string): Promise<ShowResult> {
    if (!this.streams.pair) return { ok: false, message: "AirPlay isn't available on this box" };
    if (!code) return { ok: false, message: "no code" };
    return this.streams.pair(device, code);
  }

  streamState(device: DisplayDevice): StreamState | undefined {
    return this.streams.state?.(device.id);
  }

  preview(device: DisplayDevice): Promise<Buffer | undefined> {
    return this.streams.preview?.(device.id) ?? Promise.resolve(undefined);
  }

  async health(device: DisplayDevice): Promise<Health> {
    const url = new URL(device.address);
    const online = await reachable(url.hostname, Number(url.port || AIRPLAY_PORT), 2000);
    return online ? { online } : { online, detail: "AirPlay port not answering (asleep, off, or receiver app closed)" };
  }
}

function reachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}
