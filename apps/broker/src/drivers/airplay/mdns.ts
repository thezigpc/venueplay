// Minimal mDNS (DNS-SD) browser: one PTR query, parse the answers. No dependencies.
//
// It sends from an ephemeral port, so responders answer by unicast to us ("legacy
// unicast", RFC 6762 §6.7). Nothing binds :5353, so it never fights avahi or Home
// Assistant for the port. Needs host networking in Docker, like SSDP.

import { createSocket } from "node:dgram";

export interface MdnsService {
  /** Instance name, e.g. "Living Room" (from "Living Room._airplay._tcp.local"). */
  name: string;
  /** Full instance name. */
  fqdn: string;
  host?: string;
  port?: number;
  /** IPv4 address: an A record for the SRV target, or the packet's source. */
  address?: string;
  txt: Record<string, string>;
}

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;

/** Encodes a PTR query for `service` (e.g. "_airplay._tcp.local"). */
export function encodeQuery(service: string): Buffer {
  const labels = service.split(".").filter(Boolean);
  const name = Buffer.concat([...labels.map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE.PTR, 0);
  tail.writeUInt16BE(1, 2); // class IN
  return Buffer.concat([header, name, tail]);
}

function readName(buf: Buffer, start: number): [string, number] {
  const labels: string[] = [];
  let off = start;
  let end = -1;
  for (let jumps = 0; jumps < 64; jumps++) {
    const len = buf[off];
    if (len === undefined) throw new Error("truncated name");
    if (len === 0) {
      off += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1]!;
      continue;
    }
    labels.push(buf.toString("utf8", off + 1, off + 1 + len));
    off += 1 + len;
  }
  return [labels.join("."), end >= 0 ? end : off];
}

interface Rr {
  name: string;
  type: number;
  data: Buffer;
  dataOff: number;
}

/** Parses every record (answers, authority, additional) of one DNS message. */
export function parseRecords(buf: Buffer): Rr[] {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off)[1] + 4;
  const out: Rr[] = [];
  for (let i = 0; i < total && off < buf.length; i++) {
    const [name, next] = readName(buf, off);
    const type = buf.readUInt16BE(next);
    const len = buf.readUInt16BE(next + 8);
    const dataOff = next + 10;
    out.push({ name: name.toLowerCase(), type, data: buf.subarray(dataOff, dataOff + len), dataOff });
    off = dataOff + len;
  }
  return out;
}

function parseTxt(data: Buffer): Record<string, string> {
  const txt: Record<string, string> = {};
  for (let i = 0; i < data.length; ) {
    const len = data[i]!;
    const s = data.toString("utf8", i + 1, i + 1 + len);
    const eq = s.indexOf("=");
    if (s) txt[(eq < 0 ? s : s.slice(0, eq)).toLowerCase()] = eq < 0 ? "" : s.slice(eq + 1);
    i += 1 + len;
  }
  return txt;
}

/** Folds DNS messages (with their source IPs) into service instances of `service`. */
export function collectServices(service: string, messages: { buf: Buffer; from: string }[]): MdnsService[] {
  const suffix = `.${service.toLowerCase()}`;
  const instances = new Map<string, MdnsService>();
  const a = new Map<string, string>();
  const from = new Map<string, string>();
  const get = (fqdn: string, display?: string) => {
    let s = instances.get(fqdn.toLowerCase());
    if (!s) {
      const nice = display ?? fqdn;
      s = { name: nice.endsWith(suffix) || nice.toLowerCase().endsWith(suffix) ? nice.slice(0, -suffix.length) : nice, fqdn: nice, txt: {} };
      instances.set(fqdn.toLowerCase(), s);
    }
    return s;
  };
  for (const { buf, from: ip } of messages) {
    let records: Rr[];
    try {
      records = parseRecords(buf);
    } catch {
      continue;
    }
    for (const r of records) {
      if (r.type === TYPE.PTR && r.name === service.toLowerCase()) {
        const [target] = readName(buf, r.dataOff);
        from.set(target.toLowerCase(), ip);
        get(target, target);
      } else if (r.type === TYPE.SRV && r.name.endsWith(suffix)) {
        const s = get(r.name);
        s.port = r.data.readUInt16BE(4);
        s.host = readName(buf, r.dataOff + 6)[0].toLowerCase();
        if (!from.has(r.name)) from.set(r.name, ip);
      } else if (r.type === TYPE.TXT && r.name.endsWith(suffix)) {
        get(r.name).txt = parseTxt(r.data);
      } else if (r.type === TYPE.A && r.data.length === 4) {
        a.set(r.name, [...r.data].join("."));
      }
    }
  }
  for (const [key, s] of instances) s.address = (s.host && a.get(s.host)) || from.get(key);
  return [...instances.values()];
}

/** Browses `service` for `timeoutMs` and returns what answered. */
export function mdnsBrowse(service: string, timeoutMs = 3000): Promise<MdnsService[]> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const messages: { buf: Buffer; from: string }[] = [];
    const query = encodeQuery(service);
    socket.on("message", (buf, rinfo) => messages.push({ buf, from: rinfo.address }));
    socket.on("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(0, () => {
      // Twice: UDP on busy Wi-Fi drops packets.
      socket.send(query, 5353, "224.0.0.251");
      setTimeout(() => socket.send(query, 5353, "224.0.0.251"), 400);
      setTimeout(() => {
        socket.close();
        resolve(collectServices(service, messages));
      }, timeoutMs);
    });
  });
}
