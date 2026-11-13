// Vizio SmartCast local API (TVs from about 2016 on): HTTPS on port 7345 (9000 on old
// firmware), JSON bodies, an AUTH header once paired. The TV's certificate is self-signed,
// so this one client skips certificate checks; it only ever talks to a TV's LAN address.
//
// Without pairing a TV answers device info and power state. Keys, inputs and settings
// need a token, which pairing gives: the TV shows a 4-digit PIN, staff type it in.
//
// Remote keys are (codeset, code) pairs, as Vizio's own app sends them.

import { request } from "node:https";

export const VIZIO_PORT = 7345;

export interface VizioResponse {
  status: number;
  body: Record<string, unknown>;
}

/** One HTTPS request to the TV. Injectable for tests. */
export type VizioTransport = (req: { host: string; port: number; method: "GET" | "PUT"; path: string; auth?: string; body?: unknown; timeoutMs?: number }) => Promise<VizioResponse>;

export const httpsTransport: VizioTransport = ({ host, port, method, path, auth, body, timeoutMs = 5000 }) =>
  new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host,
        port,
        method,
        path,
        rejectUnauthorized: false, // the TV's certificate is self-signed
        headers: { ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...(auth ? { AUTH: auth } : {}) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
          } catch {
            /* not JSON: keep {} */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });

/** Keys the box's remote offers, by our (Roku-style) names → Vizio codeset/code. */
export const VIZIO_KEYS: Record<string, [number, number]> = {
  Up: [3, 8],
  Down: [3, 0],
  Left: [3, 1],
  Right: [3, 7],
  Select: [3, 2],
  Back: [4, 0],
  Info: [4, 6],
  Home: [4, 15],
  Play: [2, 3],
  VolumeUp: [5, 1],
  VolumeDown: [5, 0],
  VolumeMute: [5, 4],
  ChannelUp: [8, 1],
  ChannelDown: [8, 0],
};
export const POWER_ON: [number, number] = [11, 1];
export const POWER_OFF: [number, number] = [11, 0];

/** Our input names → the names the TV's input menu uses. */
export function vizioInputName(input: string): string {
  const m = /^hdmi-?(\d+)$/i.exec(input);
  if (m) return `HDMI-${m[1]}`;
  const map: Record<string, string> = { comp: "COMP", tuner: "TV", tv: "TV", cast: "CAST", smartcast: "CAST" };
  return map[input.toLowerCase()] ?? input;
}

export interface VizioInfo {
  model: string;
  name: string;
  /** The TV's own id (also its mDNS "did"). */
  diid?: string;
  serial?: string;
  firmware?: string;
  inputs: string[];
  airplay: boolean;
}

export class VizioError extends Error {
  constructor(
    message: string,
    readonly result?: string,
  ) {
    super(message);
  }
}

const resultOf = (body: Record<string, unknown>) => String((body.STATUS as { RESULT?: string } | undefined)?.RESULT ?? "");

export class SmartCast {
  constructor(
    readonly host: string,
    readonly port = VIZIO_PORT,
    private readonly transport: VizioTransport = httpsTransport,
  ) {}

  private async call(method: "GET" | "PUT", path: string, opts: { auth?: string; body?: unknown } = {}): Promise<Record<string, unknown>> {
    const r = await this.transport({ host: this.host, port: this.port, method, path, ...opts });
    const result = resultOf(r.body);
    if (result === "SUCCESS" || (!result && r.status >= 200 && r.status < 300)) return r.body;
    if (result === "REQUIRES_PAIRING" || r.status === 403) throw new VizioError("the TV needs pairing (or its pairing was removed on the TV)", "REQUIRES_PAIRING");
    throw new VizioError(`the TV said ${result || `HTTP ${r.status}`}`, result || undefined);
  }

  async deviceInfo(): Promise<VizioInfo> {
    const body = await this.call("GET", "/state/device/deviceinfo");
    const v = ((body.ITEMS as { VALUE?: Record<string, unknown> }[] | undefined)?.[0]?.VALUE ?? {}) as Record<string, unknown>;
    const sys = (v.SYSTEM_INFO ?? {}) as Record<string, unknown>;
    const inputs = Array.isArray(v.INPUTS) ? (v.INPUTS as unknown[]).map(String) : [];
    return {
      model: String(v.MODEL_NAME ?? sys.MODEL_NAME ?? "Vizio TV"),
      name: String(v.CAST_NAME ?? v.MODEL_NAME ?? "Vizio TV"),
      diid: sys.DIID ? String(sys.DIID) : undefined,
      serial: sys.SERIAL_NUMBER ? String(sys.SERIAL_NUMBER) : undefined,
      firmware: sys.VERSION ? String(sys.VERSION) : undefined,
      inputs,
      airplay: inputs.includes("airplay") || Boolean((v.CAPABILITIES as Record<string, unknown> | undefined)?.AppleTVSupported),
    };
  }

  /** True when the screen is on (Quick Start keeps the API answering in standby). */
  async powerOn(): Promise<boolean> {
    const body = await this.call("GET", "/state/device/power_mode");
    return Number((body.ITEMS as { VALUE?: unknown }[] | undefined)?.[0]?.VALUE) === 1;
  }

  /** Starts pairing: the TV shows a PIN. Returns the request token for finishPairing. */
  async startPairing(clientId: string, clientName: string): Promise<number> {
    try {
      const body = await this.call("PUT", "/pairing/start", { body: { DEVICE_ID: clientId, DEVICE_NAME: clientName } });
      return Number((body.ITEM as { PAIRING_REQ_TOKEN?: unknown } | undefined)?.PAIRING_REQ_TOKEN ?? 0);
    } catch (err) {
      if (err instanceof VizioError && err.result === "BLOCKED") throw new VizioError("the TV is already pairing with something; wait a minute or press Back on the TV's remote, then try again", "BLOCKED");
      throw err;
    }
  }

  /** Completes pairing with the PIN on the TV. Returns the auth token. */
  async finishPairing(clientId: string, reqToken: number, pin: string): Promise<string> {
    let body: Record<string, unknown>;
    try {
      body = await this.call("PUT", "/pairing/pair", { body: { DEVICE_ID: clientId, CHALLENGE_TYPE: 1, RESPONSE_VALUE: pin, PAIRING_REQ_TOKEN: reqToken } });
    } catch (err) {
      if (err instanceof VizioError && /INVALID_PIN|INVALID_PARAMETER|CHALLENGE/i.test(err.result ?? "")) throw new VizioError("that PIN didn't work", err.result);
      throw err;
    }
    const token = (body.ITEM as { AUTH_TOKEN?: unknown } | undefined)?.AUTH_TOKEN;
    if (!token) throw new VizioError("the TV didn't return a token");
    return String(token);
  }

  async cancelPairing(clientId: string): Promise<void> {
    await this.call("PUT", "/pairing/cancel", { body: { DEVICE_ID: clientId, CHALLENGE_TYPE: 1, RESPONSE_VALUE: "1111", PAIRING_REQ_TOKEN: 0 } }).catch(() => undefined);
  }

  async key(auth: string, [codeset, code]: [number, number]): Promise<void> {
    await this.call("PUT", "/key_command/", { auth, body: { KEYLIST: [{ CODESET: codeset, CODE: code, ACTION: "KEYPRESS" }] } });
  }

  async currentInput(auth: string): Promise<{ name: string; hash: unknown }> {
    const body = await this.call("GET", "/menu_native/dynamic/tv_settings/devices/current_input", { auth });
    const item = (body.ITEMS as { VALUE?: unknown; HASHVAL?: unknown }[] | undefined)?.[0];
    return { name: String(item?.VALUE ?? ""), hash: item?.HASHVAL };
  }

  async setInput(auth: string, input: string): Promise<void> {
    const cur = await this.currentInput(auth);
    await this.call("PUT", "/menu_native/dynamic/tv_settings/devices/current_input", { auth, body: { REQUEST: "MODIFY", VALUE: vizioInputName(input), HASHVAL: cur.hash } });
  }
}
