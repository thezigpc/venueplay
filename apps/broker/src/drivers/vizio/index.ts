// Vizio SmartCast TVs. Found by mDNS (_viziocast._tcp). Content goes over AirPlay (the
// same pipeline as the Rokus; Vizios from 2016 on are AirPlay 2 receivers). Power, input
// and remote keys go over the SmartCast API, which needs a one-time PIN pairing:
// staff press "Pair TV control", the TV shows a PIN, staff type it in.
//
// Power-on over the network needs the TV's Power Mode set to Quick Start (Menu > System >
// Power Mode). In Eco mode the TV drops off the network when it's off.
//
// A Vizio also advertises AirPlay; the registry drops that duplicate and carries a TV
// saved earlier as "AirPlay" over to this driver (name, room, settings).

import { randomUUID } from "node:crypto";
import type { JsonStore } from "@bargames/common";
import type { Capabilities, DeliveryMethod, DisplayContent, DisplayDevice, DisplayDriver, Health, ShowResult, StreamService, StreamState } from "../../types.js";
import { mdnsBrowse, type MdnsService } from "../airplay/mdns.js";
import { POWER_OFF, POWER_ON, SmartCast, VIZIO_KEYS, VIZIO_PORT, VizioError, httpsTransport, type VizioTransport } from "./smartcast.js";

export const VIZIO_SERVICE = "_viziocast._tcp.local";

/** Pairing tokens per TV, and this box's id as the TV sees it. Kept out of displays.json (the admin API returns that). */
export interface VizioAuth {
  clientId: string;
  tokens: Record<string, string>;
}

const QUICK_START = "If it's off, set the TV's Power Mode to Quick Start (Menu > System > Power Mode); in Eco mode it leaves the network when it's off.";

/** The inputs worth offering, in the TV's order: SmartCast home, HDMI, composite, antenna. */
export function offeredInputs(inputs: unknown): string[] {
  const list = Array.isArray(inputs) ? (inputs as unknown[]).map(String) : [];
  if (!list.length) return ["cast", "hdmi1", "hdmi2", "hdmi3"];
  const keep = list.filter((i) => /^hdmi\d+$/.test(i) || i === "comp" || i === "tuner");
  return ["cast", ...new Set(keep)];
}

export class VizioDriver implements DisplayDriver {
  readonly id = "vizio";
  /** Pairing in progress: device id → the TV's request token. */
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly streams: StreamService,
    private readonly auth: JsonStore<VizioAuth>,
    private readonly o: { transport?: VizioTransport; browse?: (service: string, timeoutMs: number) => Promise<MdnsService[]>; clientName?: () => string } = {},
  ) {}

  private api(device: DisplayDevice): SmartCast {
    const url = new URL(device.address);
    return new SmartCast(url.hostname, Number(url.port) || VIZIO_PORT, this.o.transport ?? httpsTransport);
  }

  private token(device: DisplayDevice): string | undefined {
    return this.auth.get().tokens[device.id];
  }

  private async clientId(): Promise<string> {
    let id = this.auth.get().clientId;
    if (!id) {
      id = `bargames-${randomUUID()}`;
      await this.auth.update((s) => {
        s.clientId = id;
      });
    }
    return id;
  }

  async discover(timeoutMs = 3000): Promise<DisplayDevice[]> {
    const found = await (this.o.browse ?? mdnsBrowse)(VIZIO_SERVICE, timeoutMs);
    const devices = await Promise.all(found.filter((s) => s.address).map((s) => this.fromService(s).catch(() => undefined)));
    return devices.filter((d): d is DisplayDevice => Boolean(d));
  }

  private async fromService(svc: MdnsService): Promise<DisplayDevice> {
    const port = Number(svc.txt.hsp) || VIZIO_PORT;
    // Device info answers without pairing; mDNS alone is enough if it doesn't.
    const info = await new SmartCast(svc.address!, port, this.o.transport ?? httpsTransport).deviceInfo().catch(() => undefined);
    const key = (svc.txt.did || info?.diid || svc.address!).toLowerCase();
    return {
      id: `vizio:${key}`,
      driver: this.id,
      name: svc.txt.name || info?.name || svc.name,
      address: `https://${svc.address}:${port}`,
      model: `Vizio ${svc.txt.mdl || info?.model || ""}`.trim(),
      isTv: true,
      meta: { firmware: info?.firmware ?? svc.txt.fver, inputs: info?.inputs, supportsAirplay: info ? info.airplay : undefined },
    };
  }

  /** A TV added by IP (mDNS blocked, other subnet). */
  async probe(host: string): Promise<DisplayDevice> {
    const info = await new SmartCast(host, VIZIO_PORT, this.o.transport ?? httpsTransport).deviceInfo().catch((err: Error) => {
      throw new Error(`no Vizio answers on ${host}:${VIZIO_PORT} (${err.message}). ${QUICK_START}`);
    });
    return {
      id: `vizio:${(info.diid ?? host).toLowerCase()}`,
      driver: this.id,
      name: info.name,
      address: `https://${host}:${VIZIO_PORT}`,
      model: `Vizio ${info.model}`,
      isTv: true,
      meta: { firmware: info.firmware, inputs: info.inputs, supportsAirplay: info.airplay, manual: true },
    };
  }

  async capabilities(device: DisplayDevice): Promise<Capabilities> {
    const paired = Boolean(this.token(device));
    return {
      delivery: device.meta?.supportsAirplay === false ? [] : ["airplay"],
      power: paired,
      inputs: paired ? offeredInputs(device.meta?.inputs) : [],
      remoteKeys: paired ? Object.keys(VIZIO_KEYS) : [],
      control: { paired },
    };
  }

  private need(device: DisplayDevice): string {
    const t = this.token(device);
    if (!t) throw Object.assign(new Error(`${device.name} isn't paired for TV control yet: TV panel > Setup > Pair TV control`), { status: 400 });
    return t;
  }

  /** Turns "the TV said …" and network errors into something staff can act on. */
  private async control(device: DisplayDevice, fn: (api: SmartCast, token: string) => Promise<void>): Promise<void> {
    const token = this.need(device);
    try {
      await fn(this.api(device), token);
    } catch (err) {
      if (err instanceof VizioError && err.result === "REQUIRES_PAIRING") {
        await this.forget(device);
        throw Object.assign(new Error(`${device.name} no longer accepts the box's pairing (removed on the TV?). Pair TV control again.`), { status: 409 });
      }
      if (!(err instanceof VizioError)) throw Object.assign(new Error(`${device.name} isn't answering. ${QUICK_START}`), { status: 502 });
      throw err;
    }
  }

  async power(device: DisplayDevice, on: boolean): Promise<void> {
    await this.control(device, (api, t) => api.key(t, on ? POWER_ON : POWER_OFF));
  }

  async setInput(device: DisplayDevice, input: string): Promise<void> {
    await this.control(device, (api, t) => api.setInput(t, input));
  }

  async keypress(device: DisplayDevice, key: string): Promise<void> {
    const code = VIZIO_KEYS[key];
    if (!code) throw Object.assign(new Error(`${device.name} has no "${key}" key`), { status: 400 });
    await this.control(device, (api, t) => api.key(t, code));
  }

  async show(device: DisplayDevice, content: DisplayContent, delivery: DeliveryMethod): Promise<ShowResult> {
    if (content.kind === "off") {
      await this.stop(device);
      return { ok: true };
    }
    if (content.kind === "idle") return { ok: false, message: "idle screen is rendered by the broker (Phase 3)" };
    if (content.kind === "external") return { ok: false, message: "an app on the TV: nothing to cast" };
    if (delivery !== "airplay") return { ok: false, message: `Vizio TVs can't use ${delivery}` };
    return this.streams.startAirplay(device, content);
  }

  async stop(device: DisplayDevice): Promise<void> {
    await this.streams.stopFor(device.id);
  }

  /** AirPlay pairing (for casting), like any AirPlay TV. */
  async pair(device: DisplayDevice, code?: string): Promise<ShowResult> {
    if (!this.streams.pair) return { ok: false, message: "AirPlay isn't available on this box" };
    if (!code) return { ok: false, message: "no code" };
    return this.streams.pair(device, code);
  }

  /** TV-control pairing. Without a PIN the TV shows one; with it, the box keeps the TV's token. */
  async pairControl(device: DisplayDevice, pin?: string): Promise<ShowResult> {
    const api = this.api(device);
    const clientId = await this.clientId();
    try {
      if (!pin) {
        if (this.pending.has(device.id)) await api.cancelPairing(clientId);
        this.pending.set(device.id, await api.startPairing(clientId, this.o.clientName?.() ?? "Bar Games box"));
        return { ok: false, needsCode: true, message: "Enter the PIN the TV is showing." };
      }
      const req = this.pending.get(device.id);
      if (req === undefined) return { ok: false, message: "Start pairing first: the TV shows a new PIN." };
      const token = await api.finishPairing(clientId, req, pin);
      this.pending.delete(device.id);
      await this.auth.update((s) => {
        s.tokens[device.id] = token;
      });
      return { ok: true, message: "Paired. The box can now switch this TV on and off, change its input, and use its remote." };
    } catch (err) {
      if (err instanceof VizioError) return { ok: false, needsCode: Boolean(pin) && /PIN/.test(err.message), message: `${device.name}: ${err.message}` };
      return { ok: false, message: `${device.name} isn't answering. ${QUICK_START}` };
    }
  }

  /** Drops the TV's token (the TV forgotten, or unpaired on the TV). */
  async forget(device: DisplayDevice): Promise<void> {
    this.pending.delete(device.id);
    if (!this.token(device)) return;
    await this.auth.update((s) => {
      delete s.tokens[device.id];
    });
  }

  streamState(device: DisplayDevice): StreamState | undefined {
    return this.streams.state?.(device.id);
  }

  preview(device: DisplayDevice): Promise<Buffer | undefined> {
    return this.streams.preview?.(device.id) ?? Promise.resolve(undefined);
  }

  async health(device: DisplayDevice): Promise<Health> {
    try {
      const on = await this.api(device).powerOn();
      return { online: true, powerMode: on ? "PowerOn" : "DisplayOff", ...(this.token(device) ? {} : { detail: "not paired for TV control" }) };
    } catch (err) {
      return { online: false, detail: `${err instanceof Error ? err.message : String(err)}. ${QUICK_START}` };
    }
  }
}
