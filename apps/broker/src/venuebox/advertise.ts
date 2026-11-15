// Box 0.16.2: Venuebox discovery. The box answers mDNS (DNS-SD) queries for
// "_venuebox._tcp.local" on the venue LAN, so Venuebox apps (desktop, Android, Roku) find
// it without anyone typing an IP that DHCP can change. Pairing still needs the 6-digit
// code: discovery only tells an app where the box is.
//
//   PTR  _venuebox._tcp.local            → <Box name>._venuebox._tcp.local
//   SRV  <Box name>._venuebox._tcp.local → <host>.local : 7210
//   TXT  v=1  id=<box id>  name=<Box name>  path=/venuebox
//   A    <host>.local                    → each LAN IPv4 address of the box
//
// It binds :5353 with SO_REUSEADDR, so it shares the port with avahi or Matter if they
// run, and answers by multicast, or by unicast to a querier that didn't send from 5353
// ("legacy unicast", RFC 6762 §6.7). It also announces itself when it starts.
// No dependencies; needs host networking in Docker (the broker has it).

import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import type { Logger } from "@bargames/common";
import { parseRecords } from "../drivers/airplay/mdns.js";

export const VENUEBOX_SERVICE = "_venuebox._tcp.local";
const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;
const TTL = 120;

export interface AdvertiseInfo {
  /** Shown in apps' box lists ("Kava Bar"). */
  name: string;
  /** Stable id for this box (apps remember the box by it, not by IP). */
  id: string;
  port: number;
  /** The box's IPv4 LAN addresses (no Docker, no Tailscale). */
  addresses: string[];
}

/** DNS label for the instance name: no dots, at most 63 bytes. */
export function instanceLabel(name: string): string {
  let s = name.replace(/\./g, " ").trim() || "Bar Games box";
  while (Buffer.byteLength(s) > 63) s = s.slice(0, -1);
  return s;
}

/** "bargames-<id>.local": the SRV target; ours, so it never clashes with the host's own name. */
export function hostLabel(id: string): string {
  return `bargames-${id.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "box"}`;
}

function encName(name: string): Buffer {
  const labels = name.split(".").filter(Boolean);
  return Buffer.concat([...labels.map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
}

function rr(name: string, type: number, data: Buffer, cacheFlush: boolean): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(cacheFlush ? 0x8001 : 1, 2); // class IN (+ cache-flush for unique records)
  head.writeUInt32BE(TTL, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([encName(name), head, data]);
}

function txtData(kv: Record<string, string>): Buffer {
  return Buffer.concat(
    Object.entries(kv).map(([k, v]) => {
      const s = Buffer.from(`${k}=${v}`);
      return Buffer.concat([Buffer.from([Math.min(255, s.length)]), s.subarray(0, 255)]);
    }),
  );
}

/** The full answer set: PTR, SRV, TXT and A records. `id` is echoed for legacy unicast. */
export function encodeAnswer(info: AdvertiseInfo, id = 0, questions?: Buffer): Buffer {
  const inst = `${instanceLabel(info.name)}.${VENUEBOX_SERVICE}`;
  const host = `${hostLabel(info.id)}.local`;
  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(0, 0); // priority
  srv.writeUInt16BE(0, 2); // weight
  srv.writeUInt16BE(info.port, 4);
  const records = [
    rr(VENUEBOX_SERVICE, TYPE.PTR, encName(inst), false),
    rr(inst, TYPE.SRV, Buffer.concat([srv, encName(host)]), true),
    rr(inst, TYPE.TXT, txtData({ v: "1", id: info.id, name: info.name.slice(0, 100), path: "/venuebox" }), true),
    ...info.addresses.map((ip) => rr(host, TYPE.A, Buffer.from(ip.split(".").map(Number)), true)),
  ];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(questions ? 1 : 0, 4);
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...(questions ? [questions] : []), ...records]);
}

/** Does this message ask for our service (PTR/ANY for _venuebox, or our instance/host)? */
export function asksForUs(buf: Buffer, info: AdvertiseInfo): { yes: boolean; question?: Buffer } {
  if (buf.length < 12 || buf.readUInt16BE(2) & 0x8000) return { yes: false }; // a response, not a query
  const qd = buf.readUInt16BE(4);
  const want = new Set([VENUEBOX_SERVICE, `${instanceLabel(info.name)}.${VENUEBOX_SERVICE}`.toLowerCase(), `${hostLabel(info.id)}.local`, "_services._dns-sd._udp.local"]);
  let off = 12;
  for (let i = 0; i < qd; i++) {
    const start = off;
    const labels: string[] = [];
    while (off < buf.length) {
      const len = buf[off]!;
      if (len === 0) {
        off += 1;
        break;
      }
      if ((len & 0xc0) === 0xc0) return { yes: false }; // compressed questions: rare in queries; skip
      labels.push(buf.toString("utf8", off + 1, off + 1 + len));
      off += 1 + len;
    }
    const name = labels.join(".").toLowerCase();
    const type = buf.readUInt16BE(off);
    off += 4;
    if (want.has(name) && [TYPE.PTR, TYPE.SRV, TYPE.TXT, TYPE.A, TYPE.ANY].includes(type as 1)) return { yes: true, question: buf.subarray(start, off) };
  }
  return { yes: false };
}

/** The box's IPv4 LAN addresses: not loopback, Docker, bridges, veths or Tailscale. */
export function lanAddresses(ifaces = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (/^(lo|docker|br-|veth|tailscale|virbr|cni|flannel|zt)/.test(name)) continue;
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("100.") && !a.address.startsWith("169.254.")) out.push(a.address);
  }
  return out;
}

/** Starts answering and announces once (then again after 1 s). Returns a stop function. */
export function advertiseVenuebox(o: { info: () => AdvertiseInfo; log?: Logger }): () => void {
  let socket: Socket | undefined;
  let stopped = false;
  const send = (buf: Buffer, port = MDNS_PORT, addr = MDNS_ADDR) => socket?.send(buf, port, addr, () => undefined);
  const joined = new Set<string>();
  /** Joins the mDNS group on each LAN address (new ones too: Wi-Fi to cable, a new lease). */
  const join = (addresses: string[]) => {
    for (const ip of addresses) {
      if (joined.has(ip)) continue;
      try {
        socket?.addMembership(MDNS_ADDR, ip);
        joined.add(ip);
      } catch {
        // not ready on that interface yet: try again at the next announce
      }
    }
  };
  const announce = () => {
    const info = o.info();
    join(info.addresses);
    if (info.addresses.length) send(encodeAnswer(info));
  };
  const s = createSocket({ type: "udp4", reuseAddr: true });
  socket = s;
  s.on("error", (err) => {
    o.log?.warn("venuebox", "discovery (mDNS) stopped", { err: err.message });
    s.close();
    socket = undefined;
  });
  s.on("message", (buf, from) => {
    const info = o.info();
    const q = asksForUs(buf, info);
    if (!q.yes || !info.addresses.length) return;
    if (from.port !== MDNS_PORT) send(encodeAnswer(info, buf.readUInt16BE(0), q.question), from.port, from.address); // legacy unicast
    else send(encodeAnswer(info));
  });
  s.bind(MDNS_PORT, () => {
    if (stopped) return;
    try {
      s.setMulticastTTL(255);
    } catch {
      /* fine */
    }
    announce();
    setTimeout(announce, 1000).unref?.();
    o.log?.info("venuebox", "discoverable on the LAN", { service: VENUEBOX_SERVICE, addresses: o.info().addresses });
  });
  // Addresses change (Wi-Fi to cable, a new DHCP lease): re-announce every 2 minutes.
  const t = setInterval(announce, 120_000);
  t.unref?.();
  return () => {
    stopped = true;
    clearInterval(t);
    socket?.close();
    socket = undefined;
  };
}
