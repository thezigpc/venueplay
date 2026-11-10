// server/src/bargames.ts: the game's single connection to a Bar Games box.
// Copy into the game's server, adapt the marked parts, import `bg` where needed.
//
// Off a box (no BG_CORE_URL / BG_GAME_TOKEN env) every call here is a no-op and
// the game behaves exactly as before. That's guaranteed by the SDK.

import { createBarGames, type GameStatus } from "@bargames/sdk/server";
import type { IncomingMessage } from "node:http";

export const bg = createBarGames({
  gameId: "bingo", //                         ← the "id" in bargames.json
  defaultName: process.env.GAME_NAME || "Bingo Night", // ← the game's existing default name
});

/** True when running on a box. Use it to guard any box-only behavior. */
export const onBox = bg.connected;

/**
 * Real player IP for rate limits and logs. Replaces
 *   req.get("cf-connecting-ip") ?? req.socket.remoteAddress
 * and for socket.io: clientIp(socket.request).
 * Off a box it returns exactly what that old expression returned.
 */
export const clientIp = (req: IncomingMessage): string => bg.clientIp(req);

/** Display name: the venue's rename on a box, otherwise the game's own GAME_NAME logic. */
export async function displayName(fallback: string): Promise<string> {
  return onBox ? (await bg.venue()).game.displayName : fallback;
}

// ---------------------------------------------------------------- level 3 (adapt)
// Register commands once the RoomManager exists, e.g. from index.ts:
//
//   registerBarGames(rooms);
//
// export function registerBarGames(rooms: RoomManager): void {
//   bg.onCommand("start", ({ roomCode }) => {
//     const room = roomCode ? rooms.get(roomCode) : undefined;
//     if (!room) return { ok: false, message: "no such room" };
//     return room.startFromBox();   // same code path as the host's "start" intent,
//   });                              // including the broadcast; returns { ok, message }
//
//   bg.setStatusProvider((): GameStatus => ({
//     rooms: rooms.list().map((r) => ({
//       code: r.code,
//       kind: r.kind,               // "venue" | "patron" | "private"
//       players: r.playerCount,     // players only: not tables/viewers
//       phase: r.phase,             // e.g. "lobby" | "playing"
//       title: r.title,
//       hostConnected: r.hostConnected,
//     })),
//   }));
// }
export type { GameStatus };
