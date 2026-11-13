// Where the broker's API listens (box 0.15.1). Only core needs it: core reaches it at
// host.docker.internal, which is the docker0 bridge's address. HOST is a comma-separated
// list of IP addresses and network interface names ("127.0.0.1,docker0"); a name means
// that interface's IPv4 address. If any entry can't be resolved the broker listens on
// 0.0.0.0 (token-protected, as before), so a box never loses its broker over this.

import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { isIP } from "node:net";

export type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

export function listenHosts(spec: string | undefined, ifaces: Interfaces = networkInterfaces()): { hosts: string[]; problem?: string } {
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
    const v4 = (ifaces[e] ?? []).find((a) => a.family === "IPv4");
    if (!v4) return { hosts: ["0.0.0.0"], problem: `no network interface "${e}" with an IPv4 address; listening on 0.0.0.0` };
    hosts.push(v4.address);
  }
  // 0.0.0.0 already covers everything else.
  return { hosts: hosts.includes("0.0.0.0") ? ["0.0.0.0"] : [...new Set(hosts)] };
}
