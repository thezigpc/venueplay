// Docker Engine API client, reached through a socket proxy (never the raw socket).
// UNTESTED against a live daemon yet: first run on bg-box is part of Phase 2.

import type { Logger } from "@bargames/common";
import type { InstalledGame } from "../state.js";
import { containerCpuPercent, type ContainerStat } from "../systemStats.js";
import { containerSpec, names, onHostNetwork, TUNNEL_CONTAINER, tunnelSpec } from "./spec.js";
import type { GameRuntime, GameState, TunnelConnector } from "./types.js";

export class DockerRuntime implements GameRuntime, TunnelConnector {
  readonly kind = "docker";

  constructor(
    private readonly base: string,
    private readonly opts: {
      coreUrl: string;
      /** Core as an integration on the host network reaches it (loopback-published port). */
      hostCoreUrl?: string;
      attach: string[];
      publicUrlFor: (g: InstalledGame) => string;
      /** Path routing (SDK 0.10.0): the game's prefix, or undefined on its own hostname. */
      basePathFor?: (g: InstalledGame) => string | undefined;
      /** Per-app secret settings from the box admin, injected as env. */
      secretsFor?: (gameId: string) => Record<string, string>;
      log: Logger;
      tunnel?: { image: string; network: string };
    },
  ) {}

  private async call(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<Response> {
    const res = await fetch(`${this.base}/v1.45${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new Error(`docker ${method} ${path}: ${res.status} ${await res.text()}`);
    }
    return res;
  }

  async ensureRunning(game: InstalledGame): Promise<void> {
    const spec = containerSpec(game, {
      coreUrl: this.opts.coreUrl,
      hostCoreUrl: this.opts.hostCoreUrl,
      publicUrl: this.opts.publicUrlFor(game),
      basePath: this.opts.basePathFor?.(game),
      secrets: this.opts.secretsFor?.(game.id),
    });

    // 1. Image.
    const imageId = await this.ensureImage(game.manifest.image);

    // 2. Network, and attach core + gateway so they can reach the game. An integration on
    // the host network ("lan") has no network of its own.
    if (!onHostNetwork(game)) {
      const net = await this.call("GET", `/networks/${spec.network.name}`, undefined, [404]);
      if (net.status === 404) {
        await this.call("POST", "/networks/create", {
          Name: spec.network.name,
          Internal: spec.network.internal,
          Labels: { "bargames.game": game.id, "bargames.managed": "true" },
        });
      }
      for (const c of this.opts.attach) {
        // 403/409 = already connected.
        await this.call("POST", `/networks/${spec.network.name}/connect`, { Container: c }, [403, 409]);
      }
    }

    // 3. Container.
    if (await this.ensureContainer(spec.name, spec.body, imageId)) this.opts.log.info("runtime", "game started", { game: game.id, image: game.manifest.image });
  }

  /**
   * Uses a local copy when present (versions are new tags/digests); otherwise pulls and
   * waits. Returns the image ID, so a container on an older build of the same tag is
   * recreated.
   */
  private async ensureImage(image: string): Promise<string | undefined> {
    const local = await this.call("GET", `/images/${encodeURIComponent(image)}/json`, undefined, [404]);
    if (local.status !== 404) return ((await local.json()) as { Id?: string }).Id;
    const [repo, digestOrTag] = splitImage(image);
    const pull = await this.call("POST", `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(digestOrTag)}`);
    const progress = await pull.text();
    if (/"error"/.test(progress)) throw new Error(`pull ${image} failed: ${progress.slice(-300)}`);
    const pulled = await this.call("GET", `/images/${encodeURIComponent(image)}/json`, undefined, [404]);
    return pulled.status === 404 ? undefined : ((await pulled.json()) as { Id?: string }).Id;
  }

  /** Starts the container, recreating it when the image (name or build) or env changed. True when (re)created. */
  private async ensureContainer(name: string, body: Record<string, unknown>, imageId?: string): Promise<boolean> {
    const inspect = await this.call("GET", `/containers/${name}/json`, undefined, [404]);
    if (inspect.status !== 404) {
      const info = (await inspect.json()) as { Image?: string; Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> } };
      const wantHash = (body.Labels as Record<string, string> | undefined)?.["bargames.envhash"];
      // Containers from before the fingerprint have no label: judge them the old way (no
      // mass restart on upgrade); they get the label the next time they're recreated.
      const haveHash = info.Config?.Labels?.["bargames.envhash"];
      const sameHash = !wantHash || !haveHash || haveHash === wantHash;
      const sameBuild = !imageId || !info.Image || info.Image === imageId;
      if (info.Config?.Image === body.Image && sameBuild && sameHash && sameEnv(info.Config?.Env, body.Env as string[])) {
        await this.call("POST", `/containers/${name}/start`, undefined, [304]);
        return false;
      }
      await this.call("DELETE", `/containers/${name}?force=true`);
    }
    await this.call("POST", `/containers/create?name=${name}`, body);
    await this.call("POST", `/containers/${name}/start`, undefined, [304]);
    return true;
  }

  async ensureTunnel(token: string): Promise<void> {
    if (!this.opts.tunnel) throw new Error("tunnel connector not configured");
    const spec = tunnelSpec({ ...this.opts.tunnel, token });
    const imageId = await this.ensureImage(spec.image);
    if (await this.ensureContainer(spec.name, spec.body, imageId)) this.opts.log.info("runtime", "tunnel connector started", { image: spec.image });
  }

  async removeTunnel(): Promise<void> {
    await this.call("DELETE", `/containers/${TUNNEL_CONTAINER}?force=true`, undefined, [404]);
  }

  async tunnelState(): Promise<GameState> {
    return this.containerState(TUNNEL_CONTAINER);
  }

  async stop(id: string): Promise<void> {
    await this.call("POST", `/containers/${names(id).container}/stop?t=10`, undefined, [304, 404]);
  }

  async remove(id: string, opts: { keepData: boolean }): Promise<void> {
    const n = names(id);
    await this.call("DELETE", `/containers/${n.container}?force=true`, undefined, [404]);
    for (const c of this.opts.attach) await this.call("POST", `/networks/${n.network}/disconnect`, { Container: c, Force: true }, [404, 500]);
    await this.call("DELETE", `/networks/${n.network}`, undefined, [404]);
    if (!opts.keepData) await this.call("DELETE", `/volumes/${n.volume}`, undefined, [404]);
  }

  async state(id: string): Promise<GameState> {
    return this.containerState(names(id).container);
  }

  /** Every container on the box (the stack, the games, cloudflared), with CPU and memory. */
  async containerStats(): Promise<ContainerStat[]> {
    const list = (await (await this.call("GET", "/containers/json?all=1")).json()) as { Id: string; Names?: string[]; State?: string; Status?: string }[];
    return Promise.all(
      list.map(async (c) => {
        const row: ContainerStat = { name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""), state: c.State ?? "", status: c.Status ?? "" };
        if (c.State !== "running") return row;
        try {
          // One sample; Docker fills precpu_stats from ~1 s earlier, so CPU % works.
          const s = (await (await this.call("GET", `/containers/${c.Id}/stats?stream=false`)).json()) as Parameters<typeof containerCpuPercent>[0] & {
            memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number } };
          };
          row.cpuPercent = containerCpuPercent(s);
          const m = s.memory_stats;
          if (m?.usage !== undefined) row.memBytes = m.usage - (m.stats?.inactive_file ?? 0);
          if (m?.limit) row.memLimitBytes = m.limit;
        } catch {
          /* stats unavailable: keep the row */
        }
        return row;
      }),
    );
  }

  private async containerState(name: string): Promise<GameState> {
    try {
      const res = await this.call("GET", `/containers/${name}/json`, undefined, [404]);
      if (res.status === 404) return "missing";
      const info = (await res.json()) as { State?: { Running?: boolean } };
      return info.State?.Running ? "running" : "stopped";
    } catch {
      return "unknown";
    }
  }
}

/** "ghcr.io/x/pool:1.0@sha256:abc" → ["ghcr.io/x/pool", "sha256:abc"]; "x/pool:1.0" → ["x/pool","1.0"] */
export function splitImage(image: string): [string, string] {
  const at = image.indexOf("@");
  if (at > 0) return [image.slice(0, at).replace(/:[^/:]+$/, ""), image.slice(at + 1)];
  const colon = image.lastIndexOf(":");
  return colon > image.lastIndexOf("/") ? [image.slice(0, colon), image.slice(colon + 1)] : [image, "latest"];
}

function sameEnv(actual: string[] | undefined, wanted: string[]): boolean {
  if (!actual) return false;
  const set = new Set(actual);
  return wanted.every((e) => set.has(e));
}
