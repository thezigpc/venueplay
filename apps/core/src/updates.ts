// "Update available" for installed games. Every few hours (and on demand) the box re-reads
// each game's bargames.json from where it was installed (its GitHub repo, usually) and
// compares versions. An update is only offered once its container image is really
// published, because a repo can bump its version before its image build has finished.

import type { Logger } from "@bargames/common";
import { compareVersions, type GameManifest } from "@bargames/sdk";
import type { InstalledGame } from "./state.js";

export type ImageState = "published" | "missing" | "private" | "unknown";

export interface UpdateInfo {
  gameId: string;
  checkedAt: string;
  installed: string;
  /** The version the source offers, if it could be read. */
  latest?: string;
  /** True when latest is newer and its image can be pulled. */
  available: boolean;
  image?: ImageState;
  /** Why there's no update to offer right now (plain words, for the Games tab). */
  note?: string;
  error?: string;
}

export interface UpdateCheckerDeps {
  games: () => InstalledGame[];
  fetchManifest: (ref: string) => Promise<{ manifest: GameManifest }>;
  imageState: (image: string) => Promise<ImageState>;
  boxVersion: string;
  log: Logger;
}

export class UpdateChecker {
  private results = new Map<string, UpdateInfo>();
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  lastRun?: string;

  constructor(private d: UpdateCheckerDeps) {}

  list(): UpdateInfo[] {
    const ids = new Set(this.d.games().map((g) => g.id));
    // A game updated or removed since the check: drop stale rows.
    for (const [id, r] of this.results) {
      const g = this.d.games().find((x) => x.id === id);
      if (!ids.has(id) || (g && g.manifest.version !== r.installed)) this.results.delete(id);
    }
    return [...this.results.values()];
  }

  get(gameId: string): UpdateInfo | undefined {
    return this.list().find((r) => r.gameId === gameId);
  }

  /** Checks every game installed from a URL. Concurrent calls share one run. */
  checkAll(): Promise<void> {
    this.running ??= (async () => {
      try {
        const games = this.d.games().filter((g) => g.source.kind === "url" && !g.devTarget);
        await Promise.all(games.map((g) => this.check(g)));
        this.lastRun = new Date().toISOString();
        const n = this.list().filter((r) => r.available).length;
        if (n) this.d.log.info("updates", "updates available", { count: n });
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  async check(g: InstalledGame): Promise<UpdateInfo> {
    const base = { gameId: g.id, checkedAt: new Date().toISOString(), installed: g.manifest.version, available: false };
    let info: UpdateInfo;
    try {
      const { manifest: m } = await this.d.fetchManifest(g.source.ref);
      info = { ...base, latest: m.version };
      if (m.id !== g.id) info.note = `the source now describes "${m.id}", not this game`;
      else if (compareVersions(m.version, g.manifest.version) <= 0) info.note = "up to date";
      else if (m.minBoxVersion && compareVersions(m.minBoxVersion, this.d.boxVersion) > 0) info.note = `${m.version} needs box ${m.minBoxVersion} or newer`;
      else {
        info.image = await this.d.imageState(m.image).catch(() => "unknown" as const);
        if (info.image === "published") info.available = true;
        else if (info.image === "missing") info.note = `${m.version} is announced but its image isn't published yet (the build may still be running)`;
        else if (info.image === "private") info.note = `${m.version}'s image can't be downloaded yet: its build may still be running, or the package is still private (make it public)`;
        else {
          // Registry unreachable or unusual: offer it anyway; the update itself will say if the pull fails.
          info.available = true;
          info.note = "couldn't confirm the image is published";
        }
      }
    } catch (e) {
      info = { ...base, error: (e as Error).message };
    }
    this.results.set(g.id, info);
    return info;
  }

  start(intervalMs = 6 * 3600_000, firstDelayMs = 60_000): void {
    const run = () => void this.checkAll().catch((err) => this.d.log.warn("updates", "check failed", { err: String(err) }));
    setTimeout(run, firstDelayMs).unref?.();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

// ---------------------------------------------------------------- registry

/** "ghcr.io/x/menu:1.0" → { registry: "ghcr.io", repo: "x/menu", ref: "1.0" }; Docker Hub names get library/ and registry-1. */
export function parseImage(image: string): { registry: string; repo: string; ref: string } {
  let rest = image;
  let ref = "latest";
  const at = rest.indexOf("@");
  if (at >= 0) {
    ref = rest.slice(at + 1);
    rest = rest.slice(0, at);
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon > rest.lastIndexOf("/")) {
      ref = rest.slice(colon + 1);
      rest = rest.slice(0, colon);
    }
  }
  const first = rest.split("/")[0];
  const hasRegistry = rest.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  let registry = hasRegistry ? first : "registry-1.docker.io";
  let repo = hasRegistry ? rest.slice(first.length + 1) : rest;
  if (registry === "docker.io") registry = "registry-1.docker.io";
  if (registry === "registry-1.docker.io" && !repo.includes("/")) repo = `library/${repo}`;
  return { registry, repo, ref };
}

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/**
 * Whether an image can be pulled anonymously (the box pulls without credentials).
 * Follows the registry's Bearer challenge for an anonymous pull token.
 */
export async function imageState(image: string, doFetch: typeof fetch = fetch): Promise<ImageState> {
  const { registry, repo, ref } = parseImage(image);
  const url = `https://${registry}/v2/${repo}/manifests/${ref}`;
  const head = (auth?: string) =>
    doFetch(url, { method: "HEAD", headers: { accept: ACCEPT, ...(auth ? { authorization: auth } : {}) }, signal: AbortSignal.timeout(10_000) });
  let res = await head();
  if (res.status === 401) {
    const challenge = res.headers.get("www-authenticate") ?? "";
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!/^Bearer/i.test(challenge) || !params.realm) return "unknown";
    const tokenUrl = new URL(params.realm);
    if (params.service) tokenUrl.searchParams.set("service", params.service);
    tokenUrl.searchParams.set("scope", params.scope ?? `repository:${repo}:pull`);
    const t = await doFetch(tokenUrl, { signal: AbortSignal.timeout(10_000) });
    if (t.status === 401 || t.status === 403) return "private";
    if (!t.ok) return "unknown";
    const body = (await t.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) return "unknown";
    res = await head(`Bearer ${token}`);
  }
  if (res.ok) return "published";
  if (res.status === 404) return "missing";
  // GHCR answers 401/403 (or "denied") for private packages even with an anonymous token.
  if (res.status === 401 || res.status === 403) return "private";
  return "unknown";
}
