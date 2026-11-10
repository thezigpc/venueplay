import { createSocket } from "node:dgram";

export interface SsdpHit {
  location: string;
  usn?: string;
  st?: string;
  server?: string;
}

/** Parses one SSDP response datagram (HTTP-like headers). */
export function parseSsdpResponse(msg: string): SsdpHit | null {
  const lines = msg.split(/\r?\n/);
  if (!/^HTTP\/1\.1 200/i.test(lines[0] ?? "")) return null;
  const h: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h.location ? { location: h.location, usn: h.usn, st: h.st, server: h.server } : null;
}

/** Multicast M-SEARCH. Needs host networking in Docker. */
export function ssdpSearch(st: string, timeoutMs = 3000): Promise<SsdpHit[]> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const hits = new Map<string, SsdpHit>();
    const msg = Buffer.from(["M-SEARCH * HTTP/1.1", "HOST: 239.255.255.250:1900", 'MAN: "ssdp:discover"', `ST: ${st}`, "MX: 2", "", ""].join("\r\n"));
    socket.on("message", (buf) => {
      const hit = parseSsdpResponse(buf.toString());
      if (hit) hits.set(hit.usn ?? hit.location, hit);
    });
    socket.on("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(0, () => {
      // Send twice; UDP on busy Wi-Fi drops packets.
      socket.send(msg, 1900, "239.255.255.250");
      setTimeout(() => socket.send(msg, 1900, "239.255.255.250"), 300);
      setTimeout(() => {
        socket.close();
        resolve([...hits.values()]);
      }, timeoutMs);
    });
  });
}
