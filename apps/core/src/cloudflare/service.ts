// Cloudflare setup: one tunnel per box, routes for every hostname the box serves,
// and a proxied CNAME per hostname. Re-runnable: every step finds what exists first.
//
// Ownership rule: a DNS record is "ours" only when it is a CNAME to OUR tunnel.
// We never modify or delete anything else in the venue's zone; a name that is
// already taken is reported as a conflict for the venue to resolve.

import type { JsonStore, Logger } from "@bargames/common";
import type { TunnelConnector } from "../runtime/types.js";
import { CloudflareApi, tunnelTarget, type CfDnsRecord, type CfZone, type IngressRule } from "./api.js";

export interface CloudflareSettings {
  apiToken?: string;
  accountId?: string;
  accountName?: string;
  zoneId?: string;
  zoneName?: string;
  tunnelId?: string;
  tunnelName?: string;
  tunnelToken?: string;
  connectedAt?: string;
  lastSync?: SyncReport;
}

export type HostStatus = "ok" | "create" | "conflict";
export interface HostPlan {
  host: string;
  status: HostStatus;
  detail?: string;
}
export interface SyncReport {
  at: string;
  ok: boolean;
  hosts: HostPlan[];
  removed: string[];
  errors: string[];
}

export interface CloudflareStatus {
  hasToken: boolean;
  tokenHint?: string;
  connected: boolean;
  account?: string;
  zone?: string;
  tunnel?: { id: string; name: string; status: string; connections: number };
  connector: string;
  lastSync?: SyncReport;
}

export interface CloudflareDeps {
  store: JsonStore<CloudflareSettings>;
  connector: TunnelConnector;
  /** Every hostname the box currently serves (admin, landing page, games). */
  desiredHosts: () => string[];
  /** Name for a new tunnel, e.g. "bargames-kava-1a2b3c". */
  tunnelName: () => string;
  /** Where cloudflared sends traffic: the gateway, inside the stack's network. */
  origin: string;
  log: Logger;
  fetch?: typeof fetch;
}

export class CloudflareService {
  private chain: Promise<unknown> = Promise.resolve();
  private lastSignature = "";
  private timer?: NodeJS.Timeout;

  constructor(private readonly d: CloudflareDeps) {}

  private get s(): CloudflareSettings {
    return this.d.store.get();
  }

  private api(token = this.s.apiToken): CloudflareApi {
    if (!token) throw new Error("add a Cloudflare API token first");
    return new CloudflareApi(token, this.d.fetch);
  }

  /** One provisioning operation at a time (wizard clicks, the watcher, boot). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- wizard steps

  /** Checks a token by listing the zones it can see; saves it only if that works. */
  async saveToken(token: string): Promise<CfZone[]> {
    token = token.trim();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error("that doesn't look like an API token (copy the whole token Cloudflare showed you)");
    const zones = await this.api(token).zones();
    if (!zones.length) throw new Error("the token works but can't see any domains: give it Zone › Zone › Read for your domain");
    await this.d.store.update((s) => void (s.apiToken = token));
    return zones;
  }

  zones(): Promise<CfZone[]> {
    return this.api().zones();
  }

  /** What connecting would do to each hostname, without changing anything. */
  async plan(zoneId: string, hosts: string[]): Promise<HostPlan[]> {
    const api = this.api();
    const zone = (await api.zones()).find((z) => z.id === zoneId);
    if (!zone) throw new Error("that domain isn't visible to this token");
    const tunnelId = this.s.zoneId === zoneId ? this.s.tunnelId : (await api.findTunnel(zone.account.id, this.s.tunnelName ?? this.d.tunnelName()))?.id;
    return planHosts(hosts, zone.name, await api.dnsRecords(zone.id), tunnelId);
  }

  /** Creates (or reuses) the tunnel, routes and DNS, then starts the connector. */
  connect(zoneId: string): Promise<CloudflareStatus> {
    return this.serial(async () => {
      const api = this.api();
      const zone = (await api.zones()).find((z) => z.id === zoneId);
      if (!zone) throw new Error("that domain isn't visible to this token");
      if (this.s.tunnelId && this.s.zoneId && this.s.zoneId !== zoneId) throw new Error(`already connected to ${this.s.zoneName}; disconnect first`);

      const name = this.s.tunnelName ?? this.d.tunnelName();
      const tunnel = (await api.findTunnel(zone.account.id, name)) ?? (await api.createTunnel(zone.account.id, name));
      const tunnelToken = await api.tunnelToken(zone.account.id, tunnel.id);
      await this.d.store.update((s) => {
        Object.assign(s, {
          accountId: zone.account.id,
          accountName: zone.account.name,
          zoneId: zone.id,
          zoneName: zone.name,
          tunnelId: tunnel.id,
          tunnelName: tunnel.name,
          tunnelToken,
          connectedAt: s.connectedAt ?? new Date().toISOString(),
        });
      });
      this.d.log.info("cloudflare", "tunnel ready", { tunnel: tunnel.name, zone: zone.name });

      await this.syncNow();
      await this.d.connector.ensureTunnel(tunnelToken);
      return this.status();
    });
  }

  sync(): Promise<SyncReport> {
    return this.serial(() => this.syncNow());
  }

  /** Stops the connector, removes our DNS records and deletes the tunnel. Keeps the API token. */
  disconnect(): Promise<{ errors: string[] }> {
    return this.serial(async () => {
      const s = this.s;
      const errors: string[] = [];
      await this.d.connector.removeTunnel().catch((e: Error) => errors.push(`connector: ${e.message}`));
      if (s.apiToken && s.zoneId && s.tunnelId && s.accountId) {
        const api = this.api();
        try {
          for (const r of await api.dnsRecords(s.zoneId)) {
            if (isOurs(r, s.tunnelId)) await api.deleteRecord(s.zoneId, r.id);
          }
        } catch (e) {
          errors.push(`DNS: ${(e as Error).message}`);
        }
        // Cloudflare refuses while connections linger for a few seconds after the connector stops.
        let deleted = false;
        for (let i = 0; i < 5 && !deleted; i++) {
          try {
            await api.deleteTunnel(s.accountId, s.tunnelId);
            deleted = true;
          } catch (e) {
            if (i === 4) errors.push(`tunnel: ${(e as Error).message} (delete "${s.tunnelName}" in the Cloudflare dashboard)`);
            else await new Promise((r) => setTimeout(r, 3000));
          }
        }
      }
      await this.d.store.set({ apiToken: s.apiToken });
      this.lastSignature = "";
      this.d.log.info("cloudflare", "disconnected", { errors });
      return { errors };
    });
  }

  async status(): Promise<CloudflareStatus> {
    const s = this.s;
    const out: CloudflareStatus = {
      hasToken: Boolean(s.apiToken),
      tokenHint: s.apiToken ? `…${s.apiToken.slice(-4)}` : undefined,
      connected: Boolean(s.tunnelId),
      account: s.accountName,
      zone: s.zoneName,
      connector: await this.d.connector.tunnelState(),
      lastSync: s.lastSync,
    };
    if (s.tunnelId && s.accountId) {
      const t = await this.api()
        .tunnel(s.accountId, s.tunnelId)
        .catch((e: Error) => ({ id: s.tunnelId!, name: s.tunnelName ?? "", status: `unknown (${e.message})`, connections: [] }));
      out.tunnel = { id: t.id, name: t.name, status: t.status ?? "unknown", connections: t.connections?.length ?? 0 };
    }
    return out;
  }

  // ---------------------------------------------------------------- keeping it in sync

  /** On boot: restart the connector, then re-sync whenever the box's hostnames change. */
  start(intervalMs = 15_000): void {
    if (this.s.tunnelToken) {
      this.d.connector.ensureTunnel(this.s.tunnelToken).catch((e: Error) => this.d.log.error("cloudflare", "connector failed to start", { err: e.message }));
    }
    const tick = () => {
      if (!this.s.tunnelId) return;
      const sig = this.d.desiredHosts().join(",");
      if (sig === this.lastSignature) return;
      this.sync().catch((e: Error) => this.d.log.warn("cloudflare", "sync failed", { err: e.message }));
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async syncNow(): Promise<SyncReport> {
    const s = this.s;
    if (!s.zoneId || !s.zoneName || !s.tunnelId || !s.accountId) throw new Error("not connected");
    const api = this.api();
    const hosts = this.d.desiredHosts();
    const report: SyncReport = { at: new Date().toISOString(), ok: true, hosts: [], removed: [], errors: [] };

    // 1. Tunnel routes: every hostname to the gateway; anything else 404s at Cloudflare.
    const ingress: IngressRule[] = [...hosts.map((hostname) => ({ hostname, service: this.d.origin })), { service: "http_status:404" }];
    try {
      await api.setIngress(s.accountId, s.tunnelId, ingress);
    } catch (e) {
      report.errors.push(`routes: ${(e as Error).message}`);
    }

    // 2. DNS: create what's missing, remove our records for names we no longer serve.
    try {
      const records = await api.dnsRecords(s.zoneId);
      report.hosts = planHosts(hosts, s.zoneName, records, s.tunnelId);
      for (const h of report.hosts.filter((h) => h.status === "create")) {
        try {
          await api.createCname(s.zoneId, h.host, tunnelTarget(s.tunnelId));
          h.status = "ok";
        } catch (e) {
          h.status = "conflict";
          h.detail = (e as Error).message;
        }
      }
      const wanted = new Set(hosts);
      for (const r of records.filter((r) => isOurs(r, s.tunnelId!) && !wanted.has(r.name))) {
        await api.deleteRecord(s.zoneId, r.id);
        report.removed.push(r.name);
      }
    } catch (e) {
      report.errors.push(`DNS: ${(e as Error).message}`);
    }

    report.ok = report.errors.length === 0 && report.hosts.every((h) => h.status === "ok");
    this.lastSignature = report.errors.length ? "" : hosts.join(",");
    await this.d.store.update((st) => void (st.lastSync = report));
    this.d.log.info("cloudflare", "synced", { ok: report.ok, hosts: hosts.length, removed: report.removed, errors: report.errors });
    return report;
  }
}

function isOurs(r: CfDnsRecord, tunnelId: string): boolean {
  return r.type === "CNAME" && r.content.toLowerCase() === tunnelTarget(tunnelId);
}

export function planHosts(hosts: string[], zone: string, records: CfDnsRecord[], tunnelId?: string): HostPlan[] {
  return hosts.map((host): HostPlan => {
    if (host !== zone && !host.endsWith(`.${zone}`)) return { host, status: "conflict", detail: `not inside ${zone}; check the domain and hostname pattern` };
    const existing = records.filter((r) => r.name.toLowerCase() === host);
    if (!existing.length) return { host, status: "create" };
    if (tunnelId && existing.every((r) => isOurs(r, tunnelId))) return { host, status: "ok" };
    const r = existing[0];
    return { host, status: "conflict", detail: `already used by a ${r.type} record (${r.content}); remove it in Cloudflare or pick another name` };
  });
}
