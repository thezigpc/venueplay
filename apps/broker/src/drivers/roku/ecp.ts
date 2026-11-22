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

export interface RokuPlayer {
  /** none, startup, buffer, play, pause, stop, close, finished… (as the Roku says it). */
  state: string;
  error: boolean;
  /** The channel playing it ("15985" for the built-in URL player). */
  plugin?: string;
  /** Seconds. */
  position?: number;
  duration?: number;
}

/** ECP's media-player XML: <player error="false" state="play"><plugin id="…"/><position>12345 ms</position>… */
export function parseMediaPlayer(xml: string): RokuPlayer {
  const attr = (tag: string, name: string) => new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`, "i").exec(xml)?.[1];
  const ms = (tag: string) => {
    const m = new RegExp(`<${tag}>\\s*(\\d+)\\s*ms\\s*</${tag}>`, "i").exec(xml);
    return m ? Math.round(Number(m[1]) / 1000) : undefined;
  };
  return { state: (attr("player", "state") ?? "none").toLowerCase(), error: attr("player", "error") === "true", plugin: attr("plugin", "id"), position: ms("position"), duration: ms("duration") };
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

  /** A channel's icon (PNG/JPEG bytes), or undefined when it has none. */
  async icon(appId: string): Promise<{ type: string; data: Buffer } | undefined> {
    const res = await this.doFetch(`${this.base.replace(/\/$/, "")}/query/icon/${encodeURIComponent(appId)}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 403) throw new Error("Roku refused /query/icon: enable Control by mobile apps → Permissive");
    if (!res.ok) return undefined;
    return { type: res.headers.get("content-type") ?? "image/png", data: Buffer.from(await res.arrayBuffer()) };
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

  /**
   * Box 0.27.0: Roku's built-in URL player (the hidden "Play on Roku" channel, 15985).
   * The query carries the video and poster URLs, which may hold the media server's key, so
   * errors from here never include the path.
   */
  async playUrl(o: { url: string; title: string; poster?: string; format: string }): Promise<void> {
    const qs = new URLSearchParams({ t: "v", u: o.url, videoName: o.title, k: o.poster || "(null)", videoFormat: o.format }).toString();
    let res: Response;
    try {
      res = await this.doFetch(`${this.base.replace(/\/$/, "")}/input/15985?${qs}`, { method: "POST", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new Error(`Roku didn't answer (${err instanceof Error ? err.name : "error"})`);
    }
    if (res.status === 403) throw new Error("Roku refused: enable Control by mobile apps → Permissive");
    // Box 0.29.6: some Roku TVs (seen on a TCL with Roku OS 15.3) answer 404: no built-in player.
    if (res.status === 404) throw new Error("no built-in video player (ECP /input/15985: 404)");
    if (!res.ok) throw new Error(`Roku refused the video: HTTP ${res.status}`);
  }

  /** What the Roku's player is doing (ECP query/media-player). */
  async mediaPlayer(): Promise<RokuPlayer> {
    return parseMediaPlayer(await this.req("GET", "/query/media-player"));
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
