import type { InstalledGame } from "../state.js";
import type { ContainerStat } from "../systemStats.js";

export type GameState = "running" | "stopped" | "missing" | "unknown";

/** Runs game containers. "docker" on a box, "noop" in development. */
export interface GameRuntime {
  readonly kind: string;
  ensureRunning(game: InstalledGame): Promise<void>;
  stop(gameId: string): Promise<void>;
  remove(gameId: string, opts: { keepData: boolean }): Promise<void>;
  state(gameId: string): Promise<GameState>;
  /** CPU and memory of the box's containers (System page). Docker only. */
  containerStats?(): Promise<ContainerStat[]>;
  /** The container's health check: "none" when it has none (Docker only). */
  health?(gameId: string): Promise<"healthy" | "unhealthy" | "starting" | "none" | "missing" | "unknown">;
  /**
   * Removes an image no container uses any more (Docker only). False when it's still in
   * use or already gone; never forced.
   */
  removeImage?(image: string): Promise<boolean>;
  /** Box 0.16.0: the game's /data as a tar (settings backup). Docker only; the container must exist. */
  exportData?(gameId: string): Promise<Buffer>;
  /** Box 0.16.0: puts a tar from exportData back into /data (restore). The game is restarted after. */
  importData?(gameId: string, tar: Buffer): Promise<void>;
}

/** Runs the Cloudflare Tunnel connector (cloudflared) next to the gateway. */
export interface TunnelConnector {
  ensureTunnel(token: string): Promise<void>;
  removeTunnel(): Promise<void>;
  tunnelState(): Promise<GameState>;
}

export class NoopRuntime implements GameRuntime, TunnelConnector {
  readonly kind = "noop";
  private readonly running = new Set<string>();
  async ensureRunning(game: InstalledGame) {
    this.running.add(game.id);
  }
  async stop(id: string) {
    this.running.delete(id);
  }
  async remove(id: string) {
    this.running.delete(id);
  }
  async state(id: string): Promise<GameState> {
    return this.running.has(id) ? "running" : "stopped";
  }
  // Development: no connector container; the wizard still creates the tunnel and DNS.
  private tunnel = false;
  async ensureTunnel() {
    this.tunnel = true;
  }
  async removeTunnel() {
    this.tunnel = false;
  }
  async tunnelState(): Promise<GameState> {
    return this.tunnel ? "running" : "missing";
  }
}
