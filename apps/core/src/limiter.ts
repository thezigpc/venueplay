// Wrong-password limits for the box admin password: the box's own login, and game/app
// logins that fall back to it (SDK 0.8.0).
//   - Per source (an IP, or game + IP): 10 wrong in 15 minutes locks that source.
//   - Box-wide: 50 wrong in 15 minutes from remote sources locks remote sources out. Logins
//     from the venue LAN (`lan: true`) neither count toward it nor are blocked by it, so
//     wrong tries from the internet or through a game's login form can't lock staff out of
//     their own box (box 0.15.1).
//   - Venue LAN: 100 wrong in 15 minutes across all LAN sources locks LAN logins. Without
//     it, someone on the venue Wi-Fi could change address after every 10 tries and guess
//     without bound. Locking staff out this way takes 100 tries from 10 or more addresses.
//   - Per group (a game id): 30 wrong in 15 minutes through one game's login form locks that
//     game's checks. The client IP a game reports is only the game's word, so the per-source
//     key alone could be dodged by varying it.

export interface LimiterOptions {
  /** Failures per source before it's locked out. */
  perSource?: number;
  /** Failures from remote sources before every remote source is locked out for a while. */
  global?: number;
  /** Failures within one group (a game's login form) before that group is locked out. */
  perGroup?: number;
  /** Failures across all venue-LAN sources before LAN logins are locked out. */
  lanTotal?: number;
  windowMs?: number;
  lockMs?: number;
}

/** Where an attempt comes from, beyond its source key. */
export interface AttemptScope {
  /** From the venue LAN (the gateway's proven "local" decision): its own limit and the LAN-wide one, never the box-wide one. */
  lan?: boolean;
  /** A game's login form: its id. */
  group?: string;
}

interface Bucket {
  fails: number;
  since: number;
  lockedUntil: number;
}

const GLOBAL = "*";
const LAN = "*lan";

export class PasswordLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly o: Required<LimiterOptions>;

  constructor(o: LimiterOptions = {}) {
    this.o = { perSource: 10, global: 50, perGroup: 30, lanTotal: 100, windowMs: 15 * 60_000, lockMs: 15 * 60_000, ...o };
  }

  private bucket(key: string, now: number): Bucket {
    let b = this.buckets.get(key);
    if (!b || (now - b.since > this.o.windowMs && b.lockedUntil < now)) {
      b = { fails: 0, since: now, lockedUntil: 0 };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** The buckets an attempt counts against, with their limits. */
  private keys(source: string, scope: AttemptScope): [string, number][] {
    const out: [string, number][] = [[`src:${source}`, this.o.perSource]];
    out.push(scope.lan ? [LAN, this.o.lanTotal] : [GLOBAL, this.o.global]);
    if (scope.group) out.push([`grp:${scope.group}`, this.o.perGroup]);
    return out;
  }

  /** False while this source (or its group, or for remote sources the whole box) is locked out. */
  allowed(source: string, scope: AttemptScope = {}, now = Date.now()): boolean {
    return this.keys(source, scope).every(([key]) => this.bucket(key, now).lockedUntil <= now);
  }

  failed(source: string, scope: AttemptScope = {}, now = Date.now()): void {
    for (const [key, max] of this.keys(source, scope)) {
      const b = this.bucket(key, now);
      if (++b.fails >= max) b.lockedUntil = now + this.o.lockMs;
    }
    if (this.buckets.size > 5000) for (const [k, b] of this.buckets) if (k !== GLOBAL && k !== LAN && b.lockedUntil < now && now - b.since > this.o.windowMs) this.buckets.delete(k);
  }

  succeeded(source: string): void {
    this.buckets.delete(`src:${source}`);
  }
}
