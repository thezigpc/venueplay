// Open rooms for the venue's games list ("Bingo: room KQ7P, 6 players → Join").
// The gateway pulls its config every few seconds, so rooms come from this cache, never
// a live status call per page view. Refreshed on a timer and right after room events.

import type { HubRoom, Logger } from "@bargames/common";
import type { GameStatus, RoomSummary } from "@bargames/sdk";
import type { InstalledGame } from "./state.js";

const MAX_ROOMS_PER_GAME = 12;

export interface RoomCacheDeps {
  games: () => InstalledGame[];
  status: (game: InstalledGame) => Promise<GameStatus | undefined>;
  /** The game's public origin (joinPath is resolved against it). */
  publicUrl: (game: InstalledGame) => string | undefined;
  log: Logger;
}

/** Venue/patron rooms only; a Join link only for a same-origin joinPath. */
export function hubRooms(rooms: RoomSummary[], publicUrl: string | undefined): HubRoom[] {
  return rooms
    .filter((r) => r && typeof r.code === "string" && r.kind !== "private")
    .slice(0, MAX_ROOMS_PER_GAME)
    .map((r) => {
      const out: HubRoom = { code: r.code, players: typeof r.players === "number" ? r.players : 0 };
      if (typeof r.title === "string" && r.title) out.title = r.title;
      const join = joinUrl(r.joinPath, publicUrl);
      if (join) out.joinUrl = join;
      return out;
    });
}

function joinUrl(joinPath: unknown, base: string | undefined): string | undefined {
  if (!base || typeof joinPath !== "string" || !joinPath.startsWith("/") || joinPath.startsWith("//")) return undefined;
  try {
    const u = new URL(joinPath, base);
    return u.origin === new URL(base).origin ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export class RoomCache {
  private rooms = new Map<string, HubRoom[]>();
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private d: RoomCacheDeps) {}

  /** Rooms per game id; a game whose status couldn't be read is left out. */
  snapshot(): Record<string, HubRoom[]> {
    return Object.fromEntries(this.rooms);
  }

  async refresh(gameId?: string): Promise<void> {
    const games = this.d.games().filter((g) => g.enabled && g.manifest.sdk.level >= 2 && (!gameId || g.id === gameId));
    const live = new Set(this.d.games().filter((g) => g.enabled && g.manifest.sdk.level >= 2).map((g) => g.id));
    for (const id of this.rooms.keys()) if (!live.has(id)) this.rooms.delete(id);
    await Promise.all(
      games.map(async (g) => {
        try {
          const st = await this.d.status(g);
          if (st && Array.isArray(st.rooms)) this.rooms.set(g.id, hubRooms(st.rooms, this.d.publicUrl(g)));
          else this.rooms.delete(g.id);
        } catch {
          // Unknown is better than stale Join links.
          this.rooms.delete(g.id);
        }
      }),
    );
  }

  /** A room event arrived: refresh that game soon (collapses bursts of players_changed). */
  touched(gameId: string, delayMs = 750): void {
    if (this.pending.has(gameId)) return;
    const t = setTimeout(() => {
      this.pending.delete(gameId);
      void this.refresh(gameId).catch(() => undefined);
    }, delayMs);
    t.unref?.();
    this.pending.set(gameId, t);
  }

  start(intervalMs = 15_000): void {
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
