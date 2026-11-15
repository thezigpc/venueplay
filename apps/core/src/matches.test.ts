// Box 0.18.0 (SDK 0.15.0): a tournament app starts a match in a compatible game; the game's
// result (or its room closing) goes back to the app as "match_result".

import { createLogger } from "@bargames/common";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "./app.js";
import { AdminAuth } from "./auth.js";
import { CloudflareService } from "./cloudflare/service.js";
import { EventBus } from "./events.js";
import { GameRegistry } from "./games.js";
import { cleanMatchStart } from "./matches.js";
import { NoopRuntime } from "./runtime/types.js";
import { openState } from "./state.js";

test("matches: start validation", () => {
  assert.equal(typeof cleanMatchStart({ gameId: "pool", matchId: "bad id!", players: [{ name: "A" }] }), "string");
  assert.equal(typeof cleanMatchStart({ gameId: "pool", matchId: "qf-1", players: [{ name: "" }] }), "string");
  assert.deepEqual(cleanMatchStart({ gameId: "pool", matchId: "qf-1", players: [{ name: " Ann ", id: "p1" }, { name: "Bo" }], title: "QF 1", displayIds: ["tv1", 3] }), {
    gameId: "pool",
    matchId: "qf-1",
    players: [{ name: "Ann", id: "p1" }, { name: "Bo" }],
    title: "QF 1",
    displayIds: ["tv1"],
  });
});

test("matches: tournament → game room → result back to the tournament; a closed room cancels", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-matches-"));
  const state = openState(dir);
  const games = new GameRegistry(state.games);
  const calls: { to: string; body: { command: string; roomCode?: string; args?: Record<string, unknown> } }[] = [];
  let room = 0;
  const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === "http://pool/__bargames/command") {
      calls.push({ to: "pool", body });
      if (body.command === "create_room") return reply({ ok: true, data: { roomCode: `R${++room}` } });
    }
    if (url === "http://pool/__bargames/status") return reply({ rooms: [{ code: "R1", kind: "venue", players: 2, joinPath: "/join/R1" }] });
    if (url === "http://tourney/__bargames/command") {
      calls.push({ to: "tourney", body });
      return reply({ ok: true });
    }
    if (url.startsWith("http://broker/")) return reply([]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const app = createApp({
    state,
    games,
    runtime: new NoopRuntime(),
    bus: new EventBus(),
    auth: new AdminAuth(state.auth, "secret"),
    cloudflare: new CloudflareService({ store: state.cloudflare, connector: new NoopRuntime(), desiredHosts: () => [], tunnelName: () => "t", origin: "http://gw", log: createLogger("test", "error") }),
    log: createLogger("test", "error"),
    config: { gatewayToken: "gw", brokerUrl: "http://broker", brokerToken: "b", internalUrl: "http://core:7100", adminDist: path.join(dir, "none"), boxVersion: "0.18.0" },
    fetch: fakeFetch,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  try {
    const cookie = (await json("POST", "/api/auth/setup", { password: "correct horse" })).headers.get("set-cookie")!.split(";")[0];
    const authed = { cookie };
    const pool = { id: "pool", name: "Pool", version: "1.0.0", image: "x/pool:1", port: 3000, sdk: { version: "0.15.0", level: 3 }, routes: { player: "/", table: "/room/{code}?role=table" }, events: ["game_over"], commands: ["create_room", "end"], matches: { players: [2, 2] } };
    const tourney = { id: "tourney", name: "Tournament", kind: "app", version: "1.0.0", image: "x/t:1", port: 3000, sdk: { version: "0.15.0", level: 3 }, routes: { player: "/" }, commands: ["match_result"], tournaments: true };
    for (const [m, target] of [[pool, "http://pool"], [tourney, "http://tourney"]] as const) {
      assert.equal((await json("POST", "/api/games/install", { manifest: m, devTarget: target }, authed)).status, 200);
      await json("PATCH", `/api/games/${m.id}`, { enabled: true }, authed);
    }
    const t = { authorization: `Bearer ${games.get("tourney")!.token}` };
    const p = { authorization: `Bearer ${games.get("pool")!.token}` };

    // Only tournament apps may.
    assert.equal((await json("GET", "/internal/matches/games", undefined, p)).status, 403);
    assert.deepEqual(await (await json("GET", "/internal/matches/games", undefined, t)).json(), [{ id: "pool", name: "Pool", players: { min: 2, max: 2 } }]);
    assert.equal((await json("POST", "/internal/matches", { gameId: "pool", matchId: "qf-1", players: [{ name: "Ann" }] }, t)).status, 400, "pool matches are 2 players");

    const started = (await (await json("POST", "/internal/matches", { gameId: "pool", matchId: "qf-1", players: [{ name: "Ann" }, { name: "Bo" }], title: "QF 1" }, t)).json()) as { roomCode: string; status: string; joinUrl?: string };
    assert.equal(started.roomCode, "R1");
    assert.equal(started.status, "playing");
    assert.equal(started.joinUrl, "http://pool.localhost:7080/join/R1");
    const create = calls.find((c) => c.to === "pool" && c.body.command === "create_room")!;
    assert.deepEqual(create.body.args?.match, { id: "qf-1", players: [{ name: "Ann" }, { name: "Bo" }], title: "QF 1", by: "tourney" });
    // Asked again while playing: the same room, no second create_room.
    assert.equal(((await (await json("POST", "/internal/matches", { gameId: "pool", matchId: "qf-1", players: [{ name: "Ann" }, { name: "Bo" }] }, t)).json()) as { roomCode: string }).roomCode, "R1");
    assert.equal(calls.filter((c) => c.body.command === "create_room").length, 1);

    // The game reports the result with the match id → the tournament hears it.
    assert.equal((await json("POST", "/internal/results", { roomCode: "R1", matchId: "qf-1", results: [{ player: { name: "Bo" }, place: 1 }, { player: { name: "Ann" }, place: 2 }] }, p)).status, 200);
    const told = calls.find((c) => c.to === "tourney" && c.body.command === "match_result")!;
    const rec = (told.body.args as { match: { status: string; result: { results: { player: { name: string } }[] } } }).match;
    assert.equal(rec.status, "done");
    assert.equal(rec.result.results[0].player.name, "Bo");
    assert.equal(((await (await json("GET", "/internal/matches/qf-1", undefined, t)).json()) as { status: string }).status, "done");
    assert.equal((await json("GET", "/internal/matches/qf-1", undefined, p)).status, 404, "another app's matches stay private");

    // A second match whose room closes without a result → cancelled (after the grace delay).
    await json("POST", "/internal/matches", { gameId: "pool", matchId: "qf-2", players: [{ name: "Cy" }, { name: "Di" }] }, t);
    assert.equal((await json("POST", "/internal/events", { type: "room_closed", roomCode: "R2" }, p)).status, 204);
    await new Promise((r) => setTimeout(r, 3300));
    assert.equal(((await (await json("GET", "/internal/matches/qf-2", undefined, t)).json()) as { status: string }).status, "cancelled");
    assert.ok(calls.some((c) => c.to === "tourney" && (c.body.args as { match?: { matchId: string; status: string } })?.match?.matchId === "qf-2"));
  } finally {
    server.close();
  }
});
