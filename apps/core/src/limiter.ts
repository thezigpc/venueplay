// Wrong-password limits for the box admin password: the box's own login, and game/app
// logins that fall back to it (SDK 0.8.0). Per source (an IP, or game + IP) and box-wide,
// so a guest can't hammer it through a game's login form.

export interface LimiterOptions {
  /** Failures per source before it's locked out. */
  perSource?: number;
  /** Failures across all sources before everyone is locked out for a while. */
  global?: number;
  windowMs?: number;
  lockMs?: number;
}

interface Bucket {
  fails: number;
  since: number;
  lockedUntil: number;
}

export class PasswordLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly o: Required<LimiterOptions>;

  constructor(o: LimiterOptions = {}) {
    this.o = { perSource: 10, global: 50, windowMs: 15 * 60_000, lockMs: 15 * 60_000, ...o };
  }

  private bucket(key: string, now: number): Bucket {
    let b = this.buckets.get(key);
    if (!b || (now - b.since > this.o.windowMs && b.lockedUntil < now)) {
      b = { fails: 0, since: now, lockedUntil: 0 };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** False while this source (or the whole box) is locked out. */
  allowed(source: string, now = Date.now()): boolean {
    return this.bucket(source, now).lockedUntil <= now && this.bucket("*", now).lockedUntil <= now;
  }

  failed(source: string, now = Date.now()): void {
    for (const [key, max] of [
      [source, this.o.perSource],
      ["*", this.o.global],
    ] as const) {
      const b = this.bucket(key, now);
      if (++b.fails >= max) b.lockedUntil = now + this.o.lockMs;
    }
    if (this.buckets.size > 5000) for (const [k, b] of this.buckets) if (k !== "*" && b.lockedUntil < now && now - b.since > this.o.windowMs) this.buckets.delete(k);
  }

  succeeded(source: string): void {
    this.buckets.delete(source);
  }
}
