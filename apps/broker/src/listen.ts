// Where the broker's API listens (box 0.15.1). Only core needs it: core reaches it at
// host.docker.internal, which is the docker0 bridge's address. HOST is a comma-separated
// list of IP addresses and network interface names ("127.0.0.1,docker0"); a name means
// that interface's IPv4 address. If any entry can't be resolved the broker listens on
// 0.0.0.0 (token-protected, as before), so a box never loses its broker over this.
//
// docker0 usually has no carrier (the box's containers are all on their own networks), and
// Node's os.networkInterfaces() leaves such interfaces out. So a name Node doesn't list is
// looked up in the kernel's tables: its subnet from /proc/net/route, and the host's own
// address inside that subnet from /proc/net/fib_trie.

import { readFileSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { isIP } from "node:net";

export type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;
/** The kernel's route and address tables as text (absent off Linux). */
export interface ProcNet {
  route?: string;
  fibTrie?: string;
}

const readProc = (): ProcNet => {
  const read = (f: string) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return undefined;
    }
  };
  return { route: read("/proc/net/route"), fibTrie: read("/proc/net/fib_trie") };
};

/** /proc/net/route prints addresses as little-endian hex: "000011AC" is 172.17.0.0. */
const leHex = (h: string): number | undefined => (/^[0-9A-Fa-f]{8}$/.test(h) ? (((parseInt(h.slice(6, 8), 16) << 24) | (parseInt(h.slice(4, 6), 16) << 16) | (parseInt(h.slice(2, 4), 16) << 8) | parseInt(h.slice(0, 2), 16)) >>> 0) : undefined);
const toInt = (ip: string): number => ip.split(".").reduce((n, p) => ((n << 8) | Number(p)) >>> 0, 0);

/** An interface's own IPv4 address from the kernel's tables, even when it has no carrier. */
export function addressFromProc(iface: string, proc: ProcNet): string | undefined {
  if (!proc.route || !proc.fibTrie) return undefined;
  const subnets: { net: number; mask: number }[] = [];
  for (const line of proc.route.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== iface) continue;
    const net = leHex(f[1] ?? "");
    const mask = leHex(f[7] ?? "");
    if (net === undefined || mask === undefined || mask === 0) continue; // not the default route
    subnets.push({ net, mask });
  }
  if (!subnets.length) return undefined;
  // fib_trie lists each of the host's own addresses as "|-- a.b.c.d" then "/32 host LOCAL".
  for (const m of proc.fibTrie.matchAll(/\|-- (\d+\.\d+\.\d+\.\d+)\r?\n\s+\/32 host LOCAL/g)) {
    const ip = toInt(m[1]);
    if (subnets.some((s) => ((ip & s.mask) >>> 0) === s.net)) return m[1];
  }
  return undefined;
}

export function listenHosts(spec: string | undefined, ifaces: Interfaces = networkInterfaces(), proc: () => ProcNet = readProc): { hosts: string[]; problem?: string } {
  const entries = (spec ?? "0.0.0.0")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!entries.length) return { hosts: ["0.0.0.0"] };
  const hosts: string[] = [];
  for (const e of entries) {
    if (isIP(e)) {
      hosts.push(e);
      continue;
    }
    const address = (ifaces[e] ?? []).find((a) => a.family === "IPv4")?.address ?? addressFromProc(e, proc());
    if (!address) return { hosts: ["0.0.0.0"], problem: `no network interface "${e}" with an IPv4 address; listening on 0.0.0.0` };
    hosts.push(address);
  }
  // 0.0.0.0 already covers everything else.
  return { hosts: hosts.includes("0.0.0.0") ? ["0.0.0.0"] : [...new Set(hosts)] };
}
