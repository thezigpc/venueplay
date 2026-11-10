// Minimal Cloudflare v4 API client: just what the setup wizard needs.
// Token permissions: Account › Cloudflare Tunnel › Edit, Zone › DNS › Edit, Zone › Zone › Read.

export const CF_API = "https://api.cloudflare.com/client/v4";

export interface CfZone {
  id: string;
  name: string;
  status: string; // "active" once the nameservers point at Cloudflare
  account: { id: string; name: string };
}

export interface CfTunnel {
  id: string;
  name: string;
  status?: string; // inactive | degraded | healthy | down
  connections?: { colo_name?: string; is_pending_reconnect?: boolean }[];
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  comment?: string | null;
}

export interface IngressRule {
  hostname?: string;
  service: string;
}

export class CloudflareError extends Error {
  constructor(
    readonly status: number,
    readonly codes: number[],
    message: string,
  ) {
    super(message);
  }
}

/** Plain-language hints for the errors people actually hit while setting this up. */
function hint(status: number, codes: number[], path: string): string {
  if (status === 401 || codes.includes(1000) || codes.includes(6003) || codes.includes(6111)) return "the API token is invalid or was revoked; create a new one";
  if (status === 403 || codes.includes(10000) || codes.includes(9109)) {
    if (path.includes("/cfd_tunnel")) return "the token is missing the permission Account › Cloudflare Tunnel › Edit (or doesn't include this account)";
    if (path.includes("/dns_records")) return "the token is missing the permission Zone › DNS › Edit for this domain";
    return "the token is missing a permission; check Zone › Zone › Read";
  }
  return "";
}

export class CloudflareApi {
  constructor(
    private readonly token: string,
    private readonly doFetch: typeof fetch = fetch,
    private readonly base = CF_API,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ result: T; info?: { page: number; total_pages: number } }> {
    let res: Response;
    try {
      res = await this.doFetch(this.base + path, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new CloudflareError(0, [], `can't reach Cloudflare (${String((err as Error).message ?? err)}); check the box's internet connection`);
    }
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      errors?: { code: number; message: string }[];
      result?: T;
      result_info?: { page: number; total_pages: number };
    };
    if (!res.ok || data.success === false) {
      const codes = (data.errors ?? []).map((e) => e.code);
      const msg = (data.errors ?? []).map((e) => e.message).join("; ") || `HTTP ${res.status}`;
      const h = hint(res.status, codes, path);
      throw new CloudflareError(res.status, codes, h ? `${msg}: ${h}` : msg);
    }
    return { result: data.result as T, info: data.result_info };
  }

  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 50; page++) {
      const { result, info } = await this.call<T[]>("GET", `${path}${sep}page=${page}`);
      out.push(...result);
      if (!info || page >= info.total_pages) break;
    }
    return out;
  }

  zones(): Promise<CfZone[]> {
    return this.all<CfZone>("/zones?per_page=50");
  }

  async findTunnel(accountId: string, name: string): Promise<CfTunnel | undefined> {
    const { result } = await this.call<CfTunnel[]>("GET", `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`);
    return result.find((t) => t.name === name);
  }

  async createTunnel(accountId: string, name: string): Promise<CfTunnel> {
    // config_src "cloudflare": routes live in Cloudflare, so the connector needs only its token.
    return (await this.call<CfTunnel>("POST", `/accounts/${accountId}/cfd_tunnel`, { name, config_src: "cloudflare" })).result;
  }

  async tunnel(accountId: string, id: string): Promise<CfTunnel> {
    return (await this.call<CfTunnel>("GET", `/accounts/${accountId}/cfd_tunnel/${id}`)).result;
  }

  async tunnelToken(accountId: string, id: string): Promise<string> {
    return (await this.call<string>("GET", `/accounts/${accountId}/cfd_tunnel/${id}/token`)).result;
  }

  async setIngress(accountId: string, id: string, ingress: IngressRule[]): Promise<void> {
    await this.call("PUT", `/accounts/${accountId}/cfd_tunnel/${id}/configurations`, { config: { ingress } });
  }

  async deleteTunnel(accountId: string, id: string): Promise<void> {
    await this.call("DELETE", `/accounts/${accountId}/cfd_tunnel/${id}`);
  }

  dnsRecords(zoneId: string): Promise<CfDnsRecord[]> {
    return this.all<CfDnsRecord>(`/zones/${zoneId}/dns_records?per_page=1000`);
  }

  async createCname(zoneId: string, name: string, target: string): Promise<CfDnsRecord> {
    return (await this.call<CfDnsRecord>("POST", `/zones/${zoneId}/dns_records`, { type: "CNAME", name, content: target, proxied: true, ttl: 1, comment: "Bar Games box (managed)" })).result;
  }

  async deleteRecord(zoneId: string, id: string): Promise<void> {
    await this.call("DELETE", `/zones/${zoneId}/dns_records/${id}`);
  }
}

export const tunnelTarget = (tunnelId: string) => `${tunnelId}.cfargotunnel.com`;
