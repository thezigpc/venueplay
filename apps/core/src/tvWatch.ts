// Keeps TVs from showing dead rooms. A TV casting a game's room goes to the venue idle
// screen when:
//   - the game emits room_closed for that room (immediate);
//   - a sweep finds the room missing from the game's status twice in a row (covers
//     crashes, restarts, and games that don't emit room_closed);
//   - the game is turned off or removed.
// TVs showing anything else (idle, pairing, off) are never touched.

import type { Logger } from "@bargames/common";
import type { GameStatus } from "@bargames/sdk";
import type { InstalledGame } from "./state.js";

export interface WatchedDisplay {
  id: string;
  content?: { kind: string; url?: string };
}

export interface IdleContent {
  kind: "idle";
  url?: string;
  title?: string;
}

export interface TvWatchDeps {
  games(): InstalledGame[];
  /** The game room a URL shows, if it's one of this game's table views. */
  roomOf(game: InstalledGame, url?: string): string | undefined;
  /** The game's status; undefined when it can't be read (don't clear on a guess). */
  status(game: InstalledGame): Promise<GameStatus | undefined>;
  displays(): Promise<WatchedDisplay[]>;
  show(displayIds: string[], content: IdleContent): Promise<unknown>;
  idle(): Promise<IdleContent>;
  log: Logger;
}

export class TvWatch {
  /** "<display>|<url>" → consecutive sweeps the room was missing. */
  private readonly misses = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly d: TvWatchDeps) {}

  start(intervalMs = 30_000): void {
    this.timer ??= setInterval(() => void this.sweep().catch((err) => this.d.log.warn("tvwatch", "sweep failed", { err: String(err) })), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Which game and room each casting TV shows. */
  private async casting(): Promise<{ id: string; url: string; game: InstalledGame; room: string }[]> {
    const games = this.d.games();
    const out: { id: string; url: string; game: InstalledGame; room: string }[] = [];
    for (const disp of await this.d.displays()) {
      const url = disp.content?.kind === "url" ? disp.content.url : undefined;
      if (!url) continue;
      for (const game of games) {
        const room = this.d.roomOf(game, url);
        if (room !== undefined) {
          out.push({ id: disp.id, url, game, room });
          break;
        }
      }
    }
    return out;
  }

  private async toIdle(ids: string[], why: string, detail: Record<string, unknown>): Promise<void> {
    if (!ids.length) return;
    this.d.log.info("tvwatch", why, { ...detail, displays: ids });
    await this.d.show(ids, await this.d.idle());
  }

  async roomClosed(gameId: string, roomCode: string): Promise<void> {
    const ids = (await this.casting()).filter((c) => c.game.id === gameId && c.room === roomCode).map((c) => c.id);
    await this.toIdle(ids, "room closed, TVs to idle", { game: gameId, room: roomCode });
  }

  /** Call before a game is removed, and when it's turned off. */
  async gameGone(gameId: string): Promise<void> {
    const ids = (await this.casting()).filter((c) => c.game.id === gameId).map((c) => c.id);
    await this.toIdle(ids, "game off, TVs to idle", { game: gameId });
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const casting = await this.casting();
      const seen = new Set<string>();
      const statuses = new Map<string, Promise<GameStatus | undefined>>();
      const stale: { id: string; game: string; room: string }[] = [];
      for (const c of casting) {
        const key = `${c.id}|${c.url}`;
        seen.add(key);
        if (!c.game.enabled) {
          stale.push({ id: c.id, game: c.game.id, room: c.room });
          continue;
        }
        if (!statuses.has(c.game.id)) statuses.set(c.game.id, this.d.status(c.game).catch(() => undefined));
        const st = await statuses.get(c.game.id);
        if (!st) continue; // unreadable: maybe restarting; decide next time
        if (st.rooms?.some((r) => r.code === c.room)) {
          this.misses.delete(key);
          continue;
        }
        const n = (this.misses.get(key) ?? 0) + 1;
        this.misses.set(key, n);
        if (n >= 2) stale.push({ id: c.id, game: c.game.id, room: c.room });
      }
      for (const key of [...this.misses.keys()]) if (!seen.has(key)) this.misses.delete(key);
      for (const s of stale) {
        this.misses.delete([...this.misses.keys()].find((k) => k.startsWith(`${s.id}|`)) ?? "");
        await this.toIdle([s.id], "room gone, TV to idle", { game: s.game, room: s.room });
      }
    } finally {
      this.running = false;
    }
  }
}
