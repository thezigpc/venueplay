// IP parsing and the venue gate. No dependencies; IPv4, IPv6 and IPv4-mapped IPv6.

import type { WhitelistEntry } from "@bargames/common";
import type { AccessReason } from "@bargames/sdk";

export interface Ip {
  v: 4 | 6;
  bytes: Uint8Array;
}

function parseV4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseV6(input: string): Uint8Array | null {
  let s = input.split("%")[0];
  const lastColon = s.lastIndexOf(":");
  if (lastColon < 0) return null;
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseV4(last);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 255;
  }
  return out;
}

export function parseIp(s: string | undefined): Ip | null {
  if (!s) return null;
  const t = s.trim();
  const v4 = parseV4(t);
  if (v4) return { v: 4, bytes: v4 };
  const v6 = parseV6(t);
  if (!v6) return null;
  // ::ffff:a.b.c.d → IPv4
  if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 255 && v6[11] === 255) return { v: 4, bytes: v6.slice(12) };
  return { v: 6, bytes: v6 };
}

export interface Cidr extends Ip {
  bits: number;
}

export function parseCidr(s: string): Cidr | null {
  const [addr, bitsStr] = s.trim().split("/");
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const bits = bitsStr === undefined ? max : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  return { ...ip, bits };
}

export function inCidr(ip: Ip, cidr: Cidr): boolean {
  if (ip.v !== cidr.v) return false;
  const full = cidr.bits >> 3;
  for (let i = 0; i < full; i++) if (ip.bytes[i] !== cidr.bytes[i]) return false;
  const rest = cidr.bits & 7;
  if (!rest) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (ip.bytes[full] & mask) === (cidr.bytes[full] & mask);
}

/** "2001:db8:1:2:aaaa::1" → "2001:db8:1:2:0:0:0:0/64" */
export function prefixCidr(ipStr: string, bits: number): string | null {
  const ip = parseIp(ipStr);
  if (!ip) return null;
  const b = ip.bytes.slice();
  for (let i = 0; i < b.length; i++) {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    b[i] &= keep === 8 ? 0xff : (0xff << (8 - keep)) & 0xff;
  }
  if (ip.v === 4) return `${Array.from(b).join(".")}/${bits}`;
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
  return `${groups.join(":")}/${bits}`;
}

const PRIVATE = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "100.64.0.0/10", // CGNAT + Tailscale
  "169.254.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
].map((c) => parseCidr(c)!);

export function isPrivate(ipStr: string | undefined): boolean {
  const ip = parseIp(ipStr);
  return Boolean(ip && PRIVATE.some((c) => inCidr(ip, c)));
}

export interface AccessDecision {
  allowed: boolean;
  reason?: AccessReason;
  clientIp?: string;
}

/**
 * cfIp: CF-Connecting-IP (present on tunnel traffic). remote: the TCP peer.
 * Tunnel traffic is judged by the visitor's real IP; direct LAN traffic (TVs, the
 * broker, split-DNS phones) is "local" and allowed.
 */
export function checkAccess(
  input: { cfIp?: string; remote?: string },
  policy: { venueCidrs: string[]; whitelist: WhitelistEntry[]; /** Anyone may come in ("open"), after the venue/whitelist checks. */ open?: boolean },
  now = Date.now(),
): AccessDecision {
  if (!input.cfIp) {
    return isPrivate(input.remote) ? { allowed: true, reason: "local", clientIp: input.remote } : { allowed: false, clientIp: input.remote };
  }
  const ip = parseIp(input.cfIp);
  if (!ip) return { allowed: false, clientIp: input.cfIp };
  const match = (cidr: string) => {
    const c = parseCidr(cidr);
    return Boolean(c && inCidr(ip, c));
  };
  if (policy.venueCidrs.some(match)) return { allowed: true, reason: "venue-ip", clientIp: input.cfIp };
  const live = policy.whitelist.filter((w) => !w.expiresAt || Date.parse(w.expiresAt) > now);
  if (live.some((w) => match(w.cidr))) return { allowed: true, reason: "whitelist", clientIp: input.cfIp };
  if (policy.open) return { allowed: true, reason: "open", clientIp: input.cfIp };
  return { allowed: false, clientIp: input.cfIp };
}
