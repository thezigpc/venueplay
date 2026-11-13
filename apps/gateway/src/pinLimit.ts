// Wrong venue-PIN limits (box 0.15.1). A 4-digit PIN falls in minutes without them when
// the venue is open to the internet.
//   - Per client IP: internet ("open") clients get 10 wrong tries per 15 minutes; venue
//     and whitelisted clients 30, because a whole room shares one public IP and one guest
//     mustn't lock everyone out.
//   - Across all "open" clients: 100 wrong tries per 15 minutes locks PIN entry for "open"
//     clients only. Venue and whitelisted clients are never locked by it.

import type { AccessReason } from "@bargames/sdk";

export interface PinLimitOptions {
  openPerIp?: number;
  venuePerIp?: number;
  openTotal?: number;
  windowMs?: number;
  lockMs?: number;
  /** Most IPs tracked at once (oldest dropped first). */
  maxEntries?: number;
}

interface Bucket {
  fails: number;
  since: number;
  lockedUntil: number;
}

const OPEN_KEY = "*open";

export class PinLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly o: Required<PinLimitOptions>;

  constructor(o: PinLimitOptions = {}) {
    this.o = { openPerIp: 10, venuePerIp: 30, openTotal: 100, windowMs: 15 * 60_000, lockMs: 15 * 60_000, maxEntries: 5000, ...o };
  }

  private isOpen(reason: AccessReason | undefined): boolean {
    return reason === "open";
  }

  private bucket(key: string, now: number, create: boolean): Bucket | undefined {
    let b = this.buckets.get(key);
    if (b && now - b.since > this.o.windowMs && b.lockedUntil <= now) {
      this.buckets.delete(key);
      b = undefined;
    }
    if (!b && create) {
      b = { fails: 0, since: now, lockedUntil: 0 };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** False while this client may not try a PIN. */
  allowed(ip: string, reason: AccessReason | undefined, now = Date.now()): boolean {
    const own = this.bucket(`ip:${ip}`, now, false);
    if (own && own.lockedUntil > now) return false;
    if (this.isOpen(reason)) {
      const all = this.bucket(OPEN_KEY, now, false);
      if (all && all.lockedUntil > now) return false;
    }
    return true;
  }

  failed(ip: string, reason: AccessReason | undefined, now = Date.now()): void {
    const open = this.isOpen(reason);
    const own = this.bucket(`ip:${ip}`, now, true)!;
    if (++own.fails >= (open ? this.o.openPerIp : this.o.venuePerIp)) own.lockedUntil = now + this.o.lockMs;
    if (open) {
      const all = this.bucket(OPEN_KEY, now, true)!;
      if (++all.fails >= this.o.openTotal) all.lockedUntil = now + this.o.lockMs;
    }
    this.trim(now);
  }

  succeeded(ip: string): void {
    this.buckets.delete(`ip:${ip}`);
  }

  private trim(now: number): void {
    if (this.buckets.size <= this.o.maxEntries) return;
    for (const [k, b] of this.buckets) if (b.lockedUntil <= now && now - b.since > this.o.windowMs) this.buckets.delete(k);
    // Still too many: drop the oldest (Map keeps insertion order), never the "open" total.
    for (const k of this.buckets.keys()) {
      if (this.buckets.size <= this.o.maxEntries) break;
      if (k !== OPEN_KEY) this.buckets.delete(k);
    }
  }
}
