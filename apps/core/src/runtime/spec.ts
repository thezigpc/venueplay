import { createHash } from "node:crypto";
// The sandbox every game runs in. Pure function so it can be unit-tested and reviewed.

import { ENV } from "@bargames/sdk";
import type { InstalledGame } from "../state.js";

export const names = (id: string) => ({
  container: `bg-game-${id}`,
  network: `bg-net-${id}`,
  volume: `bg-data-${id}`,
});

export function parseMemory(v: string): number {
  const m = /^(\d+)([kmg])$/i.exec(v);
  if (!m) throw new Error(`bad memory value ${v}`);
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as "k" | "m" | "g"];
  return Number(m[1]) * mult;
}

export interface ContainerSpec {
  name: string;
  network: { name: string; internal: boolean };
  volume: string;
  /** Body for POST /containers/create (Docker Engine API). */
  body: Record<string, unknown>;
}

export function containerSpec(game: InstalledGame, opts: { coreUrl: string; publicUrl: string; secrets?: Record<string, string> }): ContainerSpec {
  const m = game.manifest;
  const n = names(game.id);
  const env: Record<string, string> = {
    ...m.env,
    // Per-app secret settings from the box admin (never in the manifest). BG_* below win.
    ...opts.secrets,
    PORT: String(m.port),
    [ENV.gameId]: game.id,
    [ENV.coreUrl]: opts.coreUrl,
    [ENV.token]: game.token,
    [ENV.publicUrl]: opts.publicUrl,
    [ENV.dataDir]: "/data",
  };
  return {
    name: n.container,
    // internal: no route to the internet or the LAN; only core and the gateway are attached.
    network: { name: n.network, internal: !m.network.internet },
    volume: n.volume,
    body: {
      Image: m.image,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      ExposedPorts: { [`${m.port}/tcp`]: {} },
      // envhash: the whole env, so a changed *or removed* setting recreates the container.
      Labels: { "bargames.game": game.id, "bargames.version": m.version, "bargames.managed": "true", "bargames.envhash": envHash(env) },
      Healthcheck: {
        Test: ["CMD-SHELL", `node -e "fetch('http://127.0.0.1:${m.port}${m.health}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || wget -qO- http://127.0.0.1:${m.port}${m.health} >/dev/null`],
        Interval: 30e9,
        Timeout: 5e9,
        StartPeriod: 20e9,
        Retries: 3,
      },
      HostConfig: {
        NetworkMode: n.network,
        Memory: parseMemory(m.resources.memory),
        NanoCpus: Math.round(m.resources.cpus * 1e9),
        PidsLimit: 256,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Privileged: false,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
        Mounts: [{ Type: "volume", Source: n.volume, Target: "/data" }],
        RestartPolicy: { Name: "unless-stopped" },
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      },
    },
  };
}

export const TUNNEL_CONTAINER = "bargames-tunnel";

/**
 * The cloudflared connector. It joins the stack's network (it must reach the
 * gateway and Cloudflare) and nothing else; the token comes in by env, never argv.
 */
export function tunnelSpec(opts: { image: string; token: string; network: string }) {
  return {
    name: TUNNEL_CONTAINER,
    image: opts.image,
    body: {
      Image: opts.image,
      Cmd: ["tunnel", "--no-autoupdate", "run"],
      Env: [`TUNNEL_TOKEN=${opts.token}`],
      Labels: { "bargames.role": "tunnel", "bargames.managed": "true" },
      HostConfig: {
        NetworkMode: opts.network,
        Memory: 128 * 1024 ** 2,
        PidsLimit: 128,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        RestartPolicy: { Name: "unless-stopped" },
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      },
    } as Record<string, unknown>,
  };
}

/** A short fingerprint of a container's environment (values never leave core). */
export function envHash(env: Record<string, string>): string {
  const sorted = Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join(String.fromCharCode(10));
  return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}
