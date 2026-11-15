// Box 0.18.0 (SDK 0.15.0): bracket matches between apps and games.
//
// A tournament app ("tournaments": true, e.g. Tournament & Leaderboard) runs a bracket. For a
// match it asks the box (POST /internal/matches) for a room in a compatible game (one that
// declares "matches"). The box sends that game "create_room" with args.match, optionally
// puts the room on TVs, and keeps a match record. When the game reports results with the
// match id (or for that room), or the room closes without a result, the record ends and the
// box tells the app with the standard "match_result" command. The app can also poll.

import type { Logger } from "@bargames/common";
import type { CommandRequest, CommandResult, CreatedRoom, GameResult, MatchGame, MatchPlayer, MatchRecord, MatchStart } from "@bargames/sdk";
import type { JsonStore } from "@bargames/common";
import { HttpError } from "./games.js";
import type { InstalledGame } from "./state.js";

const ID = /^[\w.:-]{1,64}$/;
const KEEP = 500;

export interface MatchesDeps {
  store: JsonStore<{ matches: MatchRecord[] }>;
  games: () => InstalledGame[];
  game: (id: string) => InstalledGame | undefined;
  command: (game: InstalledGame, body: CommandRequest) => Promise<{ status: number; result: CommandResult }>;
  /** Puts the match room's table view on these TVs. */
  cast?: (gameId: string, roomCode: string, displayIds: string[]) => Promise<unknown>;
  /** The absolute join link for a room, when the game's status gives a joinPath. */
  joinUrl?: (game: InstalledGame, roomCode: string) => Promise<string | undefined>;
  log: Logger;
}

export function cleanMatchStart(v: unknown): MatchStart | string {
  if (typeof v !== "object" || v === null) return "send { gameId, matchId, players: [{ name }], title?, displayIds? }";
  const b = v as Record<string, unknown>;
  if (typeof b.gameId !== "string" || !b.gameId) return "gameId: a game that declares matches";
  if (typeof b.matchId !== "string" || !ID.test(b.matchId)) return "matchId: 1-64 letters, digits, . _ : -";
  if (!Array.isArray(b.players) || b.players.length < 1 || b.players.length > 64) return "players: 1-64 of { name, id? }";
  const players: MatchPlayer[] = [];
  for (const p of b.players as Record<string, unknown>[]) {
    const name = typeof p?.name === "string" ? p.name.trim().slice(0, 40) : "";
    if (!name) return "every player needs a name";
    players.push({ name, ...(typeof p.id === "string" && p.id ? { id: p.id.slice(0, 64) } : {}) });
  }
  const out: MatchStart = { gameId: b.gameId, matchId: b.matchId, players };
  if (typeof b.title === "string" && b.title.trim()) out.title = b.title.trim().slice(0, 60);
  if (Array.isArray(b.displayIds)) out.displayIds = (b.displayIds as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 32);
  return out;
}

export class Matches {
  constructor(private readonly d: MatchesDeps) {}

  /** Games a tournament can start matches in: on, level 3 with create_room, declaring "matches". */
  compatible(): MatchGame[] {
    return this.d
      .games()
      .filter((g) => g.enabled && g.manifest.matches && g.manifest.sdk.level >= 3 && g.manifest.commands.includes("create_room"))
      .map((g) => ({ id: g.id, name: g.manifest.name, players: { min: g.manifest.matches!.players[0], max: g.manifest.matches!.players[1] } }));
  }

  get(appId: string, matchId: string): MatchRecord | undefined {
    return this.d.store.get().matches.find((m) => m.appId === appId && m.matchId === matchId);
  }

  async start(app: InstalledGame, m: MatchStart): Promise<MatchRecord> {
    if (!app.manifest.tournaments) throw new HttpError(403, 'add "tournaments": true to bargames.json to start matches');
    const game = this.d.game(m.gameId);
    const fit = this.compatible().find((g) => g.id === m.gameId);
    if (!game || !fit) throw new HttpError(404, `${m.gameId} can't play matches here (it's off, or doesn't declare "matches")`);
    if (m.players.length < fit.players.min || m.players.length > fit.players.max) throw new HttpError(400, `${fit.name} plays matches of ${fit.players.min}-${fit.players.max} players`);
    const existing = this.get(app.id, m.matchId);
    if (existing?.status === "playing") return existing; // asked twice: same room
    const r = await this.d.command(game, {
      command: "create_room",
      args: { kind: "venue", ...(m.displayIds?.length ? { purpose: "display" } : {}), ...(m.title ? { title: m.title } : {}), match: { id: m.matchId, players: m.players, ...(m.title ? { title: m.title } : {}), by: app.id } },
    });
    const created = r.result.data as CreatedRoom | undefined;
    if (!r.result.ok || typeof created?.roomCode !== "string" || !created.roomCode) throw new HttpError(502, `${fit.name} didn't create the match room: ${r.result.message ?? `HTTP ${r.status}`}`);
    const rec: MatchRecord = {
      matchId: m.matchId,
      appId: app.id,
      gameId: game.id,
      roomCode: created.roomCode,
      players: m.players,
      ...(m.title ? { title: m.title } : {}),
      status: "playing",
      createdAt: new Date().toISOString(),
    };
    const join = await this.d.joinUrl?.(game, created.roomCode).catch(() => undefined);
    if (join) rec.joinUrl = join;
    await this.save(rec);
    if (m.displayIds?.length && this.d.cast) await this.d.cast(game.id, created.roomCode, m.displayIds).catch((err: Error) => this.d.log.warn("matches", "couldn't put the match on TVs", { match: m.matchId, err: err.message }));
    this.d.log.info("matches", "match started", { app: app.id, game: game.id, match: m.matchId, room: created.roomCode });
    return rec;
  }

  /** A game reported results: the match it belongs to (by matchId, else by room) is done. */
  async resultReported(game: InstalledGame, r: GameResult): Promise<void> {
    const rec = this.d.store
      .get()
      .matches.find((m) => m.gameId === game.id && m.status === "playing" && ((r.matchId && m.matchId === r.matchId) || (!r.matchId && r.roomCode && m.roomCode === r.roomCode)));
    if (!rec) return;
    await this.finish({ ...rec, status: "done", endedAt: new Date().toISOString(), result: r });
  }

  /** A match room closed without a result: cancelled. */
  async roomClosed(gameId: string, roomCode: string): Promise<void> {
    const rec = this.d.store.get().matches.find((m) => m.gameId === gameId && m.roomCode === roomCode && m.status === "playing");
    if (rec) await this.finish({ ...rec, status: "cancelled", endedAt: new Date().toISOString() });
  }

  private async finish(rec: MatchRecord): Promise<void> {
    await this.save(rec);
    this.d.log.info("matches", `match ${rec.status}`, { app: rec.appId, match: rec.matchId });
    const app = this.d.game(rec.appId);
    if (!app?.enabled || !app.manifest.commands.includes("match_result")) return; // it polls
    await this.d.command(app, { command: "match_result", args: { match: rec } }).catch((err: Error) => this.d.log.warn("matches", "couldn't tell the tournament", { app: rec.appId, match: rec.matchId, err: err.message }));
  }

  private async save(rec: MatchRecord): Promise<void> {
    await this.d.store.update((s) => {
      s.matches = [...s.matches.filter((m) => !(m.appId === rec.appId && m.matchId === rec.matchId)), rec].slice(-KEEP);
    });
  }
}
