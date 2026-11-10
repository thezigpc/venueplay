import type { Logger } from "@bargames/common";
import { prefixCidr } from "./ipgate.js";

/**
 * Finds the venue's own public addresses, as Cloudflare sees them:
 * the IPv4 (/32) and the IPv6 /64 (phones on IPv6 each have their own address).
 */
export class VenueIpDetector {
  private current: string[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly log: Logger,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  cidrs(): string[] {
    return this.current;
  }

  async refresh(): Promise<string[]> {
    const [v4, v6] = await Promise.all([this.trace("https://1.1.1.1/cdn-cgi/trace"), this.trace("https://[2606:4700:4700::1111]/cdn-cgi/trace")]);
    const next = [v4 && `${v4}/32`, v6 && prefixCidr(v6, 64)].filter((x): x is string => Boolean(x));
    if (next.length && next.join() !== this.current.join()) {
      this.log.info("venue-ip", "public addresses changed", { from: this.current, to: next });
      this.current = next;
    }
    return this.current;
  }

  start(intervalMs = 5 * 60_000): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async trace(url: string): Promise<string | undefined> {
    try {
      const res = await this.doFetch(url, { signal: AbortSignal.timeout(5000) });
      const text = await res.text();
      return /^ip=(.+)$/m.exec(text)?.[1]?.trim();
    } catch {
      return undefined; // no IPv6 at the venue is normal
    }
  }
}
