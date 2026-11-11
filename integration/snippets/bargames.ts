// server/src/bargames.ts: the game's single connection to a Bar Games box.
// Copy into the game's server, adapt the marked parts, import `bg` where needed.
//
// Off a box (no BG_CORE_URL / BG_GAME_TOKEN env) every call here is a no-op and
// the game behaves exactly as before. That's guaranteed by the SDK.

import { createBarGames, type ClaimArgs, type GameStatus } from "@bargames/sdk/server";
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

/**
 * Room link for QR codes and "join" text. On a box: the venue's address for this game
 * (follows a subdomain rename). Off a box: the game's own link, exactly as before.
 */
export async function roomLink(code: string, ownLink: () => string): Promise<string> {
  return (await bg.publicUrl(`/join/${encodeURIComponent(code)}`)) ?? ownLink(); // ← the game's join path
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
//   // SDK 0.2.0: "Put a game on the TVs → New room" from the box. No host phone.
//   bg.onCreateRoom(({ kind, title }) => {
//     const room = rooms.createVenueRoom({ kind, title });   // stays open until "end"
//     return { roomCode: room.code, hostUrl: `/join/${room.code}?key=${room.hostKey}` };
//   });
//
//   // SDK 0.2.1, games with claims only: staff confirm/reject from the box's iPad.
//   bg.onCommand("confirm_claim", ({ roomCode, args }) => {
//     const room = roomCode ? rooms.get(roomCode) : undefined;
//     if (!room) return { ok: false, message: "no such room" };
//     return room.confirmClaimFromBox((args as ClaimArgs | undefined)?.claimId); // oldest when omitted
//   });
//   bg.onCommand("reject_claim", ({ roomCode, args }) => { /* same, with args.reason */ });
//
//   bg.setStatusProvider((): GameStatus => ({
//     rooms: rooms.list().map((r) => ({
//       code: r.code,
//       kind: r.kind,               // "venue" | "patron" | "private"
//       players: r.playerCount,     // players only: not tables/viewers
//       phase: r.phase,             // e.g. "lobby" | "playing"
//       joinPath: r.kind === "private" ? undefined : `/join/${r.code}`, // SDK 0.4.0: "Join" on the games list
//       title: r.title,
//       hostConnected: r.hostConnected,
//       createdAt: r.createdAt, lastActivityAt: r.lastActivityAt,   // SDK 0.3.0: Rooms page
//       tables: r.tableCount, maxPlayers: MAX_PLAYERS, hostName: r.host?.name,
//       pendingClaims: r.pendingClaims.map((c) => ({ id: c.id, player: c.name, detail: c.summary, at: c.at })),
//     })),
//   }));
// }

// ---------------------------------------------------------------- casting (SDK 0.2.0, box only)
// For the HOST's socket intents only (check the requester hosts the room first).
// Off a box: displays() → { enabled: false, … } (hide the TVs control), cast() refuses.
//
//   socket.on("tvs:list", async (_, ack) => ack(await bg.displays()));
//   socket.on("tvs:cast", async ({ ids, pin }, ack) => ack(await bg.cast(room.code, ids, { pin })));
//   socket.on("tvs:stop", async ({ ids, pin }, ack) => ack(await bg.stopCast(ids, { pin })));
export type { ClaimArgs, GameStatus };
