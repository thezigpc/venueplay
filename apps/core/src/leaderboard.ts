// Results and leaderboards (SDK 0.9.0): games report who won; the box keeps the last 30
// days and works out tonight's and all-time boards. "Tonight" starts at 4 AM venue time.
// Rewards (planned) will hook in here: onResult() is called for every recorded result.

import type { JsonStore } from "@bargames/common";
import type { GameResult, LeaderboardSummary } from "@bargames/sdk";

export interface ResultEntry {
  gameId: string;
  at: string;
  roomCode?: string;
  results: GameResult["results"];
}

const KEEP_DAYS = 30;
const MAX_ENTRIES = 5000;

/** Checks a game's report; returns a clean copy or a problem. */
export function cleanResult(r: unknown): GameResult | string {
  if (typeof r !== "object" || r === null) return "send { roomCode?, results: [{ player: { name }, place?, score? }] }";
  const v = r as Record<string, unknown>;
  if (!Array.isArray(v.results) || v.results.length === 0 || v.results.length > 100) return "results: 1-100 entries";
  const results: GameResult["results"] = [];
  for (const e of v.results as Record<string, unknown>[]) {
    const p = (e?.player ?? {}) as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.trim().slice(0, 40) : "";
    if (!name) return "every result needs player.name";
    const place = e.place === undefined ? undefined : Number(e.place);
    const score = e.score === undefined ? undefined : Number(e.score);
    if (place !== undefined && !(Number.isInteger(place) && place >= 1 && place <= 1000)) return "place: 1-1000";
    if (score !== undefined && !Number.isFinite(score)) return "score: a number";
    results.push({ player: { name, ...(typeof p.profileId === "string" ? { profileId: p.profileId.slice(0, 64) } : {}) }, ...(place !== undefined ? { place } : {}), ...(score !== undefined ? { score } : {}) });
  }
  return { ...(typeof v.roomCode === "string" ? { roomCode: v.roomCode.slice(0, 32) } : {}), results };
}

/** When the venue's current "night" began: the latest 4 AM in its time zone. */
export function nightStart(now: Date, timeZone = "UTC"): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  // The venue's wall clock as if it were UTC, to find the offset.
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = wall - now.getTime();
  const start = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, 4, 0, 0) - offset);
  if (+parts.hour < 4) start.setTime(start.getTime() - 24 * 3600e3);
  return start;
}

export interface Board {
  name: string;
  wins: number;
  games: number;
  best?: number;
}

/** Wins (place 1), games played and best score per player name (case-insensitive). */
export function board(entries: ResultEntry[]): Board[] {
  const by = new Map<string, Board>();
  for (const e of entries) {
    for (const r of e.results) {
      const key = r.player.name.toLowerCase();
      const b = by.get(key) ?? { name: r.player.name, wins: 0, games: 0 };
      b.games++;
      if (r.place === 1) b.wins++;
      if (r.score !== undefined) b.best = b.best === undefined ? r.score : Math.max(b.best, r.score);
      by.set(key, b);
    }
  }
  return [...by.values()].sort((a, b) => b.wins - a.wins || (b.best ?? -Infinity) - (a.best ?? -Infinity) || a.name.localeCompare(b.name));
}

export class Leaderboards {
  constructor(
    private readonly store: JsonStore<{ entries: ResultEntry[] }>,
    private readonly onResult: (entry: ResultEntry) => void = () => undefined,
  ) {}

  async record(gameId: string, r: GameResult, now = new Date()): Promise<ResultEntry> {
    const entry: ResultEntry = { gameId, at: now.toISOString(), ...(r.roomCode ? { roomCode: r.roomCode } : {}), results: r.results };
    const cutoff = now.getTime() - KEEP_DAYS * 24 * 3600e3;
    await this.store.update((s) => {
      s.entries = [...s.entries.filter((e) => Date.parse(e.at) >= cutoff), entry].slice(-MAX_ENTRIES);
    });
    try {
      this.onResult(entry);
    } catch {
      /* a rewards hook never breaks reporting */
    }
    return entry;
  }

  entries(gameId?: string, since?: Date): ResultEntry[] {
    return this.store.get().entries.filter((e) => (!gameId || e.gameId === gameId) && (!since || Date.parse(e.at) >= since.getTime()));
  }

  /** Tonight's top players per game (for the venue context, games list and idle screen). */
  tonight(names: Record<string, string>, timeZone?: string, now = new Date(), top = 5): LeaderboardSummary[] {
    const since = nightStart(now, timeZone);
    const games = [...new Set(this.entries(undefined, since).map((e) => e.gameId))].filter((id) => names[id]);
    return games
      .map((id) => ({ gameId: id, displayName: names[id], tonight: board(this.entries(id, since)).slice(0, top).map(({ name, wins, best }) => ({ name, wins, ...(best !== undefined ? { best } : {}) })) }))
      .filter((b) => b.tonight.some((p) => p.wins > 0 || p.best !== undefined));
  }

  async reset(gameId?: string): Promise<void> {
    await this.store.update((s) => {
      s.entries = gameId ? s.entries.filter((e) => e.gameId !== gameId) : [];
    });
  }
}
