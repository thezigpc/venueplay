import type { JsonStore } from "@bargames/common";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export { ADMIN_COOKIE } from "@bargames/common";
import { ADMIN_COOKIE } from "@bargames/common";
const SESSION_MS = 12 * 60 * 60 * 1000;
/** Bounds the work a login attempt costs (scrypt runs on whatever is sent). */
export const MAX_PASSWORD = 256;

export interface AuthRecord {
  passwordHash?: string;
  /**
   * Counts "sign everyone out" moments: a password change, or staff asking for it. Sessions
   * are signed with it, so raising it ends every session issued before. Absent: 0.
   */
  epoch?: number;
  /**
   * When the last such moment was (ms). The gateway refuses staff cookies issued before it
   * (GatewayConfig.staffNotBefore), so games' staff sign-ins end with the box's.
   */
  revokedAt?: number;
}

/** Admin login for the iPad/admin UI. One password for now; roles come later. */
export class AdminAuth {
  constructor(
    private readonly store: JsonStore<AuthRecord>,
    private readonly secret: string,
  ) {}

  isSetup(): boolean {
    return Boolean(this.store.get().passwordHash);
  }

  /**
   * Sets the password. Changing an existing one ends every session (the caller signs the
   * person who changed it back in).
   */
  async setPassword(password: string, now = Date.now()): Promise<void> {
    if (password.length < 8) throw new Error("password must be at least 8 characters");
    if (password.length > MAX_PASSWORD) throw new Error(`password must be at most ${MAX_PASSWORD} characters`);
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 32);
    const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
    await this.store.update((s) => {
      const changing = Boolean(s.passwordHash);
      s.passwordHash = passwordHash;
      if (changing) {
        s.epoch = (s.epoch ?? 0) + 1;
        s.revokedAt = now;
      }
    });
  }

  verify(password: string): boolean {
    const stored = this.store.get().passwordHash;
    if (!stored || password.length > MAX_PASSWORD) return false;
    const [, salt, hash] = stored.split("$");
    const want = Buffer.from(hash, "base64");
    const got = scryptSync(password, Buffer.from(salt, "base64"), want.length);
    return timingSafeEqual(got, want);
  }

  /** Ends every session: the box admin's, and (through the gateway) staff sign-ins in games. */
  async revokeAll(now = Date.now()): Promise<void> {
    await this.store.update((s) => {
      s.epoch = (s.epoch ?? 0) + 1;
      s.revokedAt = now;
    });
  }

  /** Staff cookies issued before this (ms) are no longer good. 0: never revoked. */
  staffNotBefore(): number {
    return this.store.get().revokedAt ?? 0;
  }

  issue(now = Date.now()): string {
    const exp = String(now + SESSION_MS);
    return `${exp}.${this.sign(exp)}`;
  }

  check(cookie: string | undefined, now = Date.now()): boolean {
    if (!cookie) return false;
    const [exp, sig] = cookie.split(".");
    if (!exp || !sig || Number(exp) < now) return false;
    const want = Buffer.from(this.sign(exp));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private sign(v: string): string {
    // Epoch 0 signs as boxes before 0.15.1 did, so updating doesn't sign anyone out.
    const epoch = this.store.get().epoch ?? 0;
    return createHmac("sha256", this.secret).update(epoch ? `admin:${v}:${epoch}` : `admin:${v}`).digest("base64url");
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
