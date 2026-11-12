// Paired Venuebox devices (persisted) and pending pairings (in memory, 10 minutes).

import type { JsonStore } from "@bargames/common";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Screen } from "./protocol.js";

export interface Device {
  id: string;
  name: string;
  platform: string;
  model?: string;
  appVersion?: string;
  /** sha256 of the device token (the token itself lives only on the device). */
  tokenHash: string;
  screens: Screen[];
  pairedAt: string;
  lastSeen?: string;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class DeviceStore {
  constructor(private readonly store: JsonStore<{ devices: Device[] }>) {}

  list(): Device[] {
    return this.store.get().devices;
  }

  get(id: string): Device | undefined {
    return this.list().find((d) => d.id === id);
  }

  /** The device a token belongs to (constant-time compare). */
  byToken(token: string): Device | undefined {
    if (typeof token !== "string" || token.length < 20) return undefined;
    const want = Buffer.from(hash(token), "hex");
    return this.list().find((d) => {
      const got = Buffer.from(d.tokenHash, "hex");
      return got.length === want.length && timingSafeEqual(got, want);
    });
  }

  /** Creates a device; returns it and its token (shown to the device once). */
  async add(info: Omit<Device, "id" | "tokenHash" | "pairedAt" | "lastSeen">): Promise<{ device: Device; token: string }> {
    const token = randomBytes(32).toString("base64url");
    const device: Device = { ...info, id: randomBytes(6).toString("hex"), tokenHash: hash(token), pairedAt: new Date().toISOString() };
    await this.store.update((s) => void s.devices.push(device));
    return { device, token };
  }

  async update(id: string, patch: Partial<Pick<Device, "name" | "screens" | "model" | "appVersion" | "lastSeen">>): Promise<Device | undefined> {
    let out: Device | undefined;
    await this.store.update((s) => {
      s.devices = s.devices.map((d) => (d.id === id ? (out = { ...d, ...patch }) : d));
    });
    return out;
  }

  async remove(id: string): Promise<boolean> {
    let found = false;
    await this.store.update((s) => {
      found = s.devices.some((d) => d.id === id);
      s.devices = s.devices.filter((d) => d.id !== id);
    });
    return found;
  }
}

export interface PairingRequest {
  name: string;
  platform: string;
  model?: string;
  appVersion?: string;
  screens: Screen[];
}

interface Pending {
  id: string;
  code: string;
  request: PairingRequest;
  from: string;
  expiresAt: number;
  approved?: { deviceId: string; token: string };
}

/** Codes staff type on the TVs page. Few at a time, short-lived, one use. */
export class Pairings {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly o: { ttlMs?: number; max?: number; perSource?: number } = {}) {}

  private sweep(now = Date.now()) {
    for (const [id, p] of this.pending) if (p.expiresAt < now) this.pending.delete(id);
  }

  start(request: PairingRequest, from: string): Pending | undefined {
    this.sweep();
    const mine = [...this.pending.values()].filter((p) => p.from === from && !p.approved);
    if (mine.length >= (this.o.perSource ?? 3) || this.pending.size >= (this.o.max ?? 20)) return undefined;
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    while ([...this.pending.values()].some((p) => p.code === code));
    const p: Pending = { id: randomBytes(12).toString("base64url"), code, request, from, expiresAt: Date.now() + (this.o.ttlMs ?? 10 * 60_000) };
    this.pending.set(p.id, p);
    return p;
  }

  /** Staff typed a code: the pending request, if the code is live and not yet used. */
  byCode(code: string): Pending | undefined {
    this.sweep();
    const c = String(code).replace(/\D/g, "");
    return [...this.pending.values()].find((p) => p.code === c && !p.approved);
  }

  approve(id: string, deviceId: string, token: string): void {
    const p = this.pending.get(id);
    if (p) p.approved = { deviceId, token };
  }

  /** The client polls: pending, approved (handed out once), or gone. */
  status(id: string): { status: "pending" } | { status: "approved"; deviceId: string; token: string } | undefined {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) return undefined;
    if (!p.approved) return { status: "pending" };
    this.pending.delete(id);
    return { status: "approved", ...p.approved };
  }

  list(): { code: string; name: string; platform: string; screens: number; expiresAt: string }[] {
    this.sweep();
    return [...this.pending.values()].filter((p) => !p.approved).map((p) => ({ code: p.code, name: p.request.name, platform: p.request.platform, screens: p.request.screens.length, expiresAt: new Date(p.expiresAt).toISOString() }));
  }
}
