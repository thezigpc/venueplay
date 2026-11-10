import type { JsonStore } from "@bargames/common";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "bg_admin";
const SESSION_MS = 12 * 60 * 60 * 1000;

/** Admin login for the iPad/admin UI. One password for now; roles come later. */
export class AdminAuth {
  constructor(
    private readonly store: JsonStore<{ passwordHash?: string }>,
    private readonly secret: string,
  ) {}

  isSetup(): boolean {
    return Boolean(this.store.get().passwordHash);
  }

  async setPassword(password: string): Promise<void> {
    if (password.length < 8) throw new Error("password must be at least 8 characters");
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 32);
    await this.store.set({ passwordHash: `scrypt$${salt.toString("base64")}$${hash.toString("base64")}` });
  }

  verify(password: string): boolean {
    const stored = this.store.get().passwordHash;
    if (!stored) return false;
    const [, salt, hash] = stored.split("$");
    const want = Buffer.from(hash, "base64");
    const got = scryptSync(password, Buffer.from(salt, "base64"), want.length);
    return timingSafeEqual(got, want);
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
    return createHmac("sha256", this.secret).update(`admin:${v}`).digest("base64url");
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
