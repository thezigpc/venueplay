// Hello Game: the smallest complete Bar Games integration (SDK level 3).
// Rooms with a code, a player page, a big-screen table page, events and commands.
// Runs standalone too: without BG_CORE_URL it uses default branding and emits nothing.

import { createBarGames, type GameStatus } from "@bargames/sdk/server";
import { SESSION_KINDS, type SessionKind } from "@bargames/sdk";
import express from "express";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sdkDist = path.dirname(require.resolve("@bargames/sdk"));

const bg = createBarGames({ gameId: "hello", defaultName: "Hello Game" });

interface Room {
  code: string;
  kind: SessionKind;
  players: Set<string>;
  round: number;
  phase: "lobby" | "playing" | "over";
  winner?: string;
}
const rooms = new Map<string, Room>();
const newCode = () => Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join("");

// ---- level 3: commands from the box (iPad, schedules, Home Assistant)
// "Cast -> New room": a venue room with no host phone; the box drives it with commands.
bg.onCreateRoom(({ kind }) => ({ roomCode: createRoom(kind).code }));
bg.onCommand("start", ({ roomCode }) => {
  const room = roomCode ? rooms.get(roomCode) : undefined;
  if (!room) return { ok: false, message: "no such room" };
  startRound(room);
  return { ok: true };
});
bg.onCommand("end", ({ roomCode }) => {
  const room = roomCode ? rooms.get(roomCode) : undefined;
  if (!room) return { ok: false, message: "no such room" };
  room.phase = "over";
  bg.emit({ type: "game_over", roomCode: room.code, sessionKind: room.kind });
  // Closing the room: it leaves status and the box takes it off the TVs.
  rooms.delete(room.code);
  bg.emit({ type: "room_closed", roomCode: room.code, sessionKind: room.kind });
  return { ok: true };
});
bg.setStatusProvider(
  (): GameStatus => ({
    rooms: [...rooms.values()].map((r) => ({ code: r.code, kind: r.kind, players: r.players.size, phase: r.phase })),
  }),
);

function startRound(room: Room) {
  room.round += 1;
  room.phase = "playing";
  room.winner = undefined;
  bg.emit({ type: "round_started", roomCode: room.code, sessionKind: room.kind, data: { round: room.round } });
}

const app = express();
app.use(express.json());
app.use(bg.middleware()); // serves /__bargames/* (venue.json, theme.css, command, status)
app.use("/sdk", express.static(sdkDist)); // browser SDK as plain ES modules
app.use(express.static(path.resolve(here, "../public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

function createRoom(kind: SessionKind): Room {
  const room: Room = { code: newCode(), kind, players: new Set(), round: 0, phase: "lobby" };
  rooms.set(room.code, room);
  bg.emit({ type: "room_created", roomCode: room.code, sessionKind: kind });
  return room;
}

app.post("/api/rooms", (req, res) => {
  const kind: SessionKind = SESSION_KINDS.includes(req.body?.kind) ? req.body.kind : "patron";
  res.json({ code: createRoom(kind).code });
});

app.post("/api/rooms/:code/join", (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return void res.status(404).json({ error: "no such room" });
  const name = String(req.body?.name ?? "").trim().slice(0, 20) || "Player";
  room.players.add(name);
  bg.emit({ type: "players_changed", roomCode: room.code, sessionKind: room.kind, data: { players: room.players.size } });
  res.json({ ok: true });
});

app.post("/api/rooms/:code/start", (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return void res.status(404).json({ error: "no such room" });
  startRound(room);
  res.json({ ok: true });
});

app.post("/api/rooms/:code/win", (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room || room.phase !== "playing") return void res.status(409).json({ error: "round not running" });
  room.winner = String(req.body?.name ?? "Someone").slice(0, 20);
  room.phase = "lobby";
  bg.emit({ type: "winner", roomCode: room.code, sessionKind: room.kind, data: { name: room.winner, round: room.round } });
  res.json({ ok: true });
});

app.get("/api/rooms/:code", (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return void res.status(404).json({ error: "no such room" });
  res.json({ code: room.code, kind: room.kind, players: [...room.players], round: room.round, phase: room.phase, winner: room.winner });
});

app.get("/table", (_req, res) => res.sendFile(path.resolve(here, "../public/table.html")));

const port = Number(process.env.PORT) || 7300;
app.listen(port, () => console.log(`hello-game on :${port} (${bg.connected ? "on a box" : "standalone"})`));
