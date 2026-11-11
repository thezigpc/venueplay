// Roku External Control Protocol (ECP), port 8060.
// Requires Settings → System → Advanced system settings → Control by mobile apps →
// Network access: Permissive (newer Roku OS blocks most commands on "Default").

export interface RokuDeviceInfo {
  udn: string;
  serial: string;
  friendlyName: string;
  modelName: string;
  modelNumber: string;
  isTv: boolean;
  softwareVersion: string;
  powerMode?: string;
  networkType?: string;
  developerEnabled: boolean;
  supportsAirplay?: boolean;
  /** Players that can sleep (most can't: Express, Stick). Roku TVs always can. */
  supportsSuspend?: boolean;
  /** Everything ECP returned, for diagnostics. */
  raw: Record<string, string>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]);

/** Flat XML → map of child element text (enough for ECP's device-info / active-app). */
export function parseFlatXml(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<([a-z0-9-]+)(?:\s[^>]*)?>([^<]*)<\/\1>/gi)) out[m[1].toLowerCase()] = decode(m[2].trim());
  return out;
}

export function parseDeviceInfo(xml: string): RokuDeviceInfo {
  const r = parseFlatXml(xml);
  const bool = (k: string) => (r[k] === undefined ? undefined : r[k] === "true");
  return {
    udn: r.udn ?? "",
    serial: r["serial-number"] ?? r["device-id"] ?? "",
    friendlyName: r["user-device-name"] || r["friendly-device-name"] || r["friendly-model-name"] || "Roku",
    modelName: r["friendly-model-name"] ?? r["model-name"] ?? "",
    modelNumber: r["model-number"] ?? "",
    isTv: r["is-tv"] === "true",
    softwareVersion: r["software-version"] ?? "",
    powerMode: r["power-mode"],
    networkType: r["network-type"],
    developerEnabled: r["developer-enabled"] === "true",
    supportsAirplay: bool("supports-airplay"),
    supportsSuspend: bool("supports-suspend"),
    raw: r,
  };
}

export interface RokuApp {
  id: string;
  name: string;
}

export function parseApps(xml: string): RokuApp[] {
  return [...xml.matchAll(/<app\s+id="([^"]+)"[^>]*>([^<]*)<\/app>/g)].map((m) => ({ id: m[1], name: decode(m[2]) }));
}

/** Input name → ECP key. Roku TVs only. */
export function inputKey(input: string): string {
  const s = input.toLowerCase();
  const hdmi = /^hdmi([1-4])$/.exec(s);
  if (hdmi) return `InputHDMI${hdmi[1]}`;
  if (s === "tuner") return "InputTuner";
  if (s === "av" || s === "av1") return "InputAV1";
  throw new Error(`unknown input "${input}"`);
}

export class RokuEcp {
  constructor(
    readonly base: string,
    private readonly doFetch: typeof fetch = fetch,
    private readonly timeoutMs = 4000,
  ) {}

  private async req(method: "GET" | "POST", path: string): Promise<string> {
    const res = await this.doFetch(`${this.base.replace(/\/$/, "")}${path}`, { method, signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 403) throw new Error(`Roku refused ${path}: enable Control by mobile apps → Permissive`);
    if (!res.ok) throw new Error(`Roku ${method} ${path}: HTTP ${res.status}`);
    return res.text();
  }

  async deviceInfo(): Promise<RokuDeviceInfo> {
    return parseDeviceInfo(await this.req("GET", "/query/device-info"));
  }

  async apps(): Promise<RokuApp[]> {
    return parseApps(await this.req("GET", "/query/apps"));
  }

  async activeApp(): Promise<RokuApp | undefined> {
    return parseApps(await this.req("GET", "/query/active-app"))[0];
  }

  keypress(key: string): Promise<string> {
    return this.req("POST", `/keypress/${encodeURIComponent(key)}`);
  }

  launch(appId: string, params: Record<string, string> = {}): Promise<string> {
    const qs = new URLSearchParams(params).toString();
    return this.req("POST", `/launch/${encodeURIComponent(appId)}${qs ? `?${qs}` : ""}`);
  }

  powerOn(): Promise<string> {
    return this.keypress("PowerOn");
  }

  powerOff(): Promise<string> {
    return this.keypress("PowerOff");
  }

  setInput(input: string): Promise<string> {
    return this.keypress(inputKey(input));
  }
}
