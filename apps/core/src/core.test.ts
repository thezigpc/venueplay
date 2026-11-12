import { createLogger } from "@bargames/common";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "./app.js";
import { AdminAuth } from "./auth.js";
import { EventBus } from "./events.js";
import { GameRegistry } from "./games.js";
import { certificateWarning, checkPattern, hostFor, publicUrl, renderHostname } from "./hostnames.js";
import { resolveManifestUrl } from "./manifestSource.js";
import { splitImage } from "./runtime/docker.js";
import { containerSpec, parseMemory } from "./runtime/spec.js";
import { CloudflareService } from "./cloudflare/service.js";
import { NoopRuntime } from "./runtime/types.js";
import { openState, type InstalledGame } from "./state.js";

const manifest = {
  id: "bingo",
  name: "Bingo",
  version: "1.0.0",
  image: "ghcr.io/x/bingo:1.0.0",
  port: 3002,
  sdk: { version: "0.1.0", level: 3 },
  routes: { player: "/", table: "/room/{code}?role=table" },
  events: ["winner"],
  commands: ["start"],
};

test("hostnames: patterns and certificate depth", () => {
  assert.equal(renderHostname("{game}.{domain}", { game: "pool", venue: "kava", domain: "example.com" }), "pool.example.com");
  assert.equal(renderHostname("{game}-{venue}.{domain}", { game: "pool", venue: "kava", domain: "example.com" }), "pool-kava.example.com");
  assert.equal(certificateWarning("pool.example.com", "example.com"), undefined);
  assert.match(certificateWarning("pool.internal.example.com", "example.com")!, /2 levels/);
  assert.deepEqual(checkPattern("{game}.{domain}"), []);
  assert.ok(checkPattern("{domain}").length > 0);
  assert.throws(() => renderHostname("{game}.{domain}", { game: "bad_label", venue: "", domain: "example.com" }));
});

test("manifest URLs resolve from GitHub and plain URLs", () => {
  assert.equal(resolveManifestUrl("https://github.com/acme/pool"), "https://raw.githubusercontent.com/acme/pool/HEAD/bargames.json");
  assert.equal(resolveManifestUrl("https://github.com/acme/pool/tree/v1.2/game"), "https://raw.githubusercontent.com/acme/pool/v1.2/game/bargames.json");
  assert.equal(resolveManifestUrl("https://example.com/pool/"), "https://example.com/pool/bargames.json");
  assert.throws(() => resolveManifestUrl("http://example.com/x.json"));
});

test("container spec is sandboxed", () => {
  const game = { id: "bingo", token: "t", manifest: { ...manifest, env: { A: "1" }, health: "/health", resources: { memory: "256m", cpus: 0.5 }, network: { internet: false } } } as unknown as InstalledGame;
  const spec = containerSpec(game, { coreUrl: "http://core:7100", publicUrl: "https://bingo.example.com" });
  const hc = spec.body.HostConfig as Record<string, unknown>;
  assert.equal(spec.network.internal, true);
  assert.equal(hc.ReadonlyRootfs, true);
  assert.deepEqual(hc.CapDrop, ["ALL"]);
  assert.equal(hc.Memory, 256 * 1024 * 1024);
  assert.equal(hc.NanoCpus, 5e8);
  assert.ok((spec.body.Env as string[]).includes("BG_GAME_TOKEN=t"));
  assert.equal(parseMemory("1g"), 1024 ** 3);
  assert.deepEqual(splitImage("ghcr.io/x/pool:1.0@sha256:abc"), ["ghcr.io/x/pool", "sha256:abc"]);
  assert.deepEqual(splitImage("localhost:5000/pool"), ["localhost:5000/pool", "latest"]);
});

test("venue: a cleared public port stays cleared after a restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-core-"));
  await openState(dir).venue.update((v) => Object.assign(v, { domain: "example.com", publicScheme: "https", publicPort: null }));
  const venue = openState(dir).venue.get();
  assert.equal(venue.publicPort, null);
  assert.equal(publicUrl(venue, hostFor(venue, "bingo")), "https://bingo.example.com");
});

test("api: setup, install, brand, events, gateway config", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-core-"));
  const state = openState(dir);
  const games = new GameRegistry(state.games);
  const bus = new EventBus();
  const app = createApp({
    state,
    games,
    runtime: new NoopRuntime(),
    bus,
    auth: new AdminAuth(state.auth, "secret"),
    cloudflare: new CloudflareService({
      store: state.cloudflare,
      connector: new NoopRuntime(),
      desiredHosts: () => [],
      tunnelName: () => "t",
      origin: "http://gw",
      log: createLogger("test", "error"),
    }),
    log: createLogger("test", "error"),
    config: { gatewayToken: "gw", brokerUrl: "http://127.0.0.1:1", brokerToken: "b", internalUrl: "http://core:7100", adminDist: path.join(dir, "none"), boxVersion: "0.1.0" },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });

  try {
    assert.equal((await json("GET", "/api/games")).status, 401);
    // Setup only from the LAN: a gateway-forwarded tunnel request, or a forged proof, is refused.
    assert.equal((await json("POST", "/api/auth/setup", { password: "correct horse" }, { "x-bargames-gateway": "gw", "x-bargames-access": "venue-ip" })).status, 403);
    assert.equal((await json("POST", "/api/auth/setup", { password: "correct horse" }, { "x-bargames-gateway": "forged", "x-bargames-access": "local" })).status, 403);
    const gwCfg = (await (await json("GET", "/internal/gateway-config", undefined, { authorization: "Bearer gw" })).json()) as { setupRequired: boolean };
    assert.equal(gwCfg.setupRequired, true);
    const setup = await json("POST", "/api/auth/setup", { password: "correct horse" });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const authed = { cookie };
    assert.match(setup.headers.get("set-cookie")!, /bg_admin=[^;]+;.*Path=\/;/);
    // Under /admin on the games list's hostname, the session cookie is scoped to /admin/.
    const underAdmin = await json("POST", "/api/auth/login", { password: "correct horse" }, { "x-forwarded-prefix": "/admin" });
    assert.equal(underAdmin.status, 200);
    assert.match(underAdmin.headers.get("set-cookie")!, /bg_admin=[^;]+;.*Path=\/admin\/;/);

    const inst = await json("POST", "/api/games/install", { manifest, devTarget: "http://127.0.0.1:7300" }, authed);
    assert.equal(inst.status, 200);
    const installed = (await inst.json()) as { game: { token?: string; host: string } };
    assert.equal(installed.game.token, undefined, "token must never reach the admin UI");
    assert.equal(installed.game.host, "bingo.localhost");

    const patched = await json("PATCH", "/api/games/bingo", { enabled: true, branding: { displayName: "Kava Bingo", tagline: "ignored: not brandable" }, hostnameAlias: "kavabingo" }, authed);
    const pg = (await patched.json()) as { host: string; state: string; branding: Record<string, string> };
    assert.equal(pg.host, "kavabingo.localhost");
    assert.equal(pg.state, "running");
    assert.deepEqual(pg.branding, { displayName: "Kava Bingo" });

    const token = games.get("bingo")!.token;
    assert.equal((await json("POST", "/internal/events", { type: "winner" }, { authorization: "Bearer nope" })).status, 401);
    assert.equal((await json("POST", "/internal/events", { type: "winner", roomCode: "AB12", data: { name: "Sam" } }, { authorization: `Bearer ${token}` })).status, 204);
    assert.equal(bus.latest()[0].gameId, "bingo");

    const ctx = (await (await json("GET", "/internal/venue", undefined, { authorization: `Bearer ${token}` })).json()) as { game: { displayName: string; publicUrl: string } };
    assert.equal(ctx.game.displayName, "Kava Bingo");
    assert.equal(ctx.game.publicUrl, "http://kavabingo.localhost:7080");
    const lineup = ctx as unknown as { venue: { games: { id: string; displayName: string; url: string }[]; announcement?: unknown } };
    assert.deepEqual(lineup.venue.games, [{ id: "bingo", displayName: "Kava Bingo", url: "http://kavabingo.localhost:7080" }], "SDK 0.4.0: the venue's lineup");
    assert.equal(lineup.venue.announcement, undefined);

    // Announcements: validated, on every game's context and the gateway's, then taken down.
    assert.equal((await json("PUT", "/api/announcement", { text: "  " }, authed)).status, 400);
    assert.equal((await json("PUT", "/api/announcement", { text: "x", minutes: 0 }, authed)).status, 400);
    assert.equal((await json("PUT", "/api/announcement", { text: "Last call" })).status, 401);
    const posted = (await (await json("PUT", "/api/announcement", { text: "Last  call at 1:30", minutes: 60 }, authed)).json()) as { id: string; text: string; until: string };
    assert.equal(posted.text, "Last call at 1:30");
    assert.ok(Date.parse(posted.until) > Date.now());
    const withNews = (await (await json("GET", "/internal/venue", undefined, { authorization: `Bearer ${token}` })).json()) as { venue: { announcement?: { text: string } } };
    assert.equal(withNews.venue.announcement?.text, "Last call at 1:30");
    const gwNews = (await (await json("GET", "/internal/gateway-config", undefined, { authorization: "Bearer gw" })).json()) as { contexts: Record<string, { venue: { announcement?: unknown } }> };
    assert.ok(gwNews.contexts._hub.venue.announcement && gwNews.contexts.bingo.venue.announcement);
    // 0.12.0: where and position.
    assert.equal((await json("PUT", "/api/announcement", { text: "x", show: "ceiling" }, authed)).status, 400);
    const placed = (await (await json("PUT", "/api/announcement", { text: "TVs only", show: "tvs", position: "bottom" }, authed)).json()) as { show?: string; position?: string };
    assert.deepEqual([placed.show, placed.position], ["tvs", "bottom"]);
    const placedCtx = (await (await json("GET", "/internal/venue", undefined, { authorization: `Bearer ${token}` })).json()) as { venue: { announcement?: { show?: string; position?: string }; adminUrl?: string } };
    assert.deepEqual([placedCtx.venue.announcement?.show, placedCtx.venue.announcement?.position], ["tvs", "bottom"]);
    assert.match(placedCtx.venue.adminUrl ?? "", /\/admin$/, "games get the box admin's address");
    assert.equal((await json("DELETE", "/api/announcement", undefined, authed)).status, 200);
    assert.equal(await (await json("GET", "/api/announcement", undefined, authed)).json(), null);

    assert.equal((await json("GET", "/internal/gateway-config")).status, 401);
    const gw = (await (await json("GET", "/internal/gateway-config", undefined, { authorization: "Bearer gw" })).json()) as { routes: { host: string; kind: string; path?: string; target?: string; redirectTo?: string }[]; adminUrl: string };
    // Admin at /admin on the games list's hostname (default); its old hostname redirects there.
    assert.deepEqual(
      gw.routes.map((r) => [r.host, r.kind, r.path ?? "", r.redirectTo ?? ""]),
      [
        ["play.localhost", "admin", "/admin", ""],
        ["play.localhost", "hub", "", ""],
        ["admin.localhost", "admin", "", "http://play.localhost:7080/admin"],
        ["kavabingo.localhost", "game", "", ""],
      ],
    );
    assert.equal(gw.adminUrl, "http://play.localhost:7080/admin");
    assert.equal(gw.routes[3].target, "http://127.0.0.1:7300");

    const badVenue = await json("PUT", "/api/venue", { hostnamePattern: "{domain}" }, authed);
    assert.equal(badVenue.status, 400);
    const deep = (await (await json("PUT", "/api/venue", { domain: "example.com", hostnamePattern: "{game}.internal.{domain}" }, authed)).json()) as { warnings: string[] };
    assert.ok(deep.warnings.some((w) => w.includes("Advanced Certificate Manager")));
  } finally {
    server.close();
  }
});

test("casting: new room from the admin, and casting from inside a game (gated, PIN)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-core-"));
  const state = openState(dir);
  const games = new GameRegistry(state.games);
  const shows: { displayIds?: string[]; content: { kind: string; url?: string } }[] = [];
  const displays = [
    { id: "tv1", name: "Roku 1", label: "Bar left", content: undefined as undefined | { kind: string; url?: string } },
    { id: "tv2", name: "Roku 2", content: { kind: "url", url: "https://other.example.com/x" } },
  ];
  const rooms = ["ROOM1"];
  const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === "http://broker/displays") return reply(displays);
    if (url === "http://broker/show") {
      shows.push(body);
      for (const id of body.displayIds ?? []) {
        const disp = displays.find((x) => x.id === id);
        if (disp) disp.content = body.content.kind === "off" ? undefined : body.content;
      }
      return reply(Object.fromEntries((body.displayIds ?? []).map((id: string) => [id, { ok: true }])));
    }
    if (url === "http://game/__bargames/status") return reply({ rooms: rooms.map((code) => ({ code, kind: "venue", players: 0 })) });
    if (url === "http://game/__bargames/command" && body.command === "create_room") {
      rooms.push("NEW1");
      return reply({ ok: true, data: { roomCode: "NEW1", hostUrl: "/host/NEW1?key=s3cret" } });
    }
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
    config: { gatewayToken: "gw", brokerUrl: "http://broker", brokerToken: "b", internalUrl: "http://core:7100", adminDist: path.join(dir, "none"), boxVersion: "0.2.0" },
    fetch: fakeFetch,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  try {
    const cookie = (await json("POST", "/api/auth/setup", { password: "correct horse" })).headers.get("set-cookie")!.split(";")[0];
    const authed = { cookie };
    const m = { ...manifest, sdk: { version: "0.2.0", level: 3 }, commands: ["create_room", "start"] };
    assert.equal((await json("POST", "/api/games/install", { manifest: m, devTarget: "http://game" }, authed)).status, 200);
    await json("PATCH", "/api/games/bingo", { enabled: true }, authed);

    // Admin: "New room" → the game creates it, its table view goes on the TV.
    const cast = (await (await json("POST", "/api/cast", { gameId: "bingo", displayIds: ["tv1"] }, authed)).json()) as { roomCode: string; created: boolean; hostUrl: string; url: string };
    assert.equal(cast.roomCode, "NEW1");
    assert.equal(cast.created, true);
    assert.equal(cast.url, "http://bingo.localhost:7080/room/NEW1?role=table");
    assert.equal(cast.hostUrl, "http://bingo.localhost:7080/host/NEW1?key=s3cret");
    assert.equal(shows.at(-1)!.content.url, cast.url);

    // From the game: off until the venue allows it.
    const g = { authorization: `Bearer ${games.get("bingo")!.token}` };
    assert.deepEqual(await (await json("GET", "/internal/displays", undefined, g)).json(), { enabled: false, pinRequired: false, displays: [] });
    assert.equal((await json("POST", "/internal/cast", { roomCode: "ROOM1", displayIds: ["tv1"] }, g)).status, 403);
    assert.equal((await json("PUT", "/api/cast-settings", { fromGames: true, pin: "12" }, authed)).status, 400);
    await json("PUT", "/api/cast-settings", { fromGames: true, pin: "4321" }, authed);

    const targets = (await (await json("GET", "/internal/displays", undefined, g)).json()) as { enabled: boolean; pinRequired: boolean; displays: { id: string; name: string; showingThisGame: boolean; roomCode?: string; busy: boolean }[] };
    assert.equal(targets.pinRequired, true);
    assert.deepEqual(targets.displays[0], { id: "tv1", name: "Bar left", busy: true, showingThisGame: true, roomCode: "NEW1" });
    assert.equal(targets.displays[1].showingThisGame, false);
    assert.equal(JSON.stringify(targets).includes("other.example.com"), false, "games never see what other games show");

    assert.equal((await json("POST", "/internal/cast", { roomCode: "ROOM1", displayIds: ["tv2"], pin: "0000" }, g)).status, 403);
    assert.equal((await json("POST", "/internal/cast", { roomCode: "NOPE", displayIds: ["tv2"], pin: "4321" }, g)).status, 404, "only rooms the game has");
    const ok = (await (await json("POST", "/internal/cast", { roomCode: "ROOM1", displayIds: ["tv2"], pin: "4321" }, g)).json()) as { ok: boolean };
    assert.equal(ok.ok, true);
    assert.equal(displays[1].content?.url, "http://bingo.localhost:7080/room/ROOM1?role=table");

    // Stop only clears TVs showing this game.
    displays[0].content = { kind: "url", url: "https://other.example.com/y" };
    await json("POST", "/internal/cast/stop", { displayIds: ["tv1", "tv2"], pin: "4321" }, g);
    assert.deepEqual(shows.at(-1), { displayIds: ["tv2"], content: { kind: "off" } });
    assert.equal(displays[0].content?.url, "https://other.example.com/y");

    // Wrong PINs get rate limited.
    for (let i = 0; i < 5; i++) await json("POST", "/internal/cast", { roomCode: "ROOM1", displayIds: ["tv2"], pin: "1111" }, g);
    assert.equal((await json("POST", "/internal/cast", { roomCode: "ROOM1", displayIds: ["tv2"], pin: "4321" }, g)).status, 429);
  } finally {
    server.close();
  }
});

test("room cache: games list rooms skip private ones and only link same-origin join paths", async () => {
  const { hubRooms, RoomCache } = await import("./roomCache.js");
  const rooms = [
    { code: "KQ7P", kind: "patron", players: 6, joinPath: "/join/KQ7P", title: "Friday" },
    { code: "PRIV", kind: "private", players: 3, joinPath: "/join/PRIV" },
    { code: "EVIL", kind: "venue", players: 1, joinPath: "//evil.example/x" },
    { code: "ABS", kind: "venue", players: 2, joinPath: "https://evil.example/x" },
    { code: "NOJ", kind: "venue", players: 0 },
  ] as Parameters<typeof hubRooms>[0];
  assert.deepEqual(hubRooms(rooms, "https://bingo.kava.example"), [
    { code: "KQ7P", players: 6, title: "Friday", joinUrl: "https://bingo.kava.example/join/KQ7P" },
    { code: "EVIL", players: 1 },
    { code: "ABS", players: 2 },
    { code: "NOJ", players: 0 },
  ]);

  let fail = false;
  const game = { id: "bingo", enabled: true, manifest: { sdk: { level: 2 } } } as unknown as InstalledGame;
  const cache = new RoomCache({
    games: () => [game],
    status: async () => {
      if (fail) throw new Error("down");
      return { rooms: [{ code: "KQ7P", kind: "venue", players: 2, joinPath: "/j/KQ7P" }] };
    },
    publicUrl: () => "https://bingo.kava.example",
    log: createLogger("t", "error"),
  });
  await cache.refresh();
  assert.equal(cache.snapshot().bingo[0].joinUrl, "https://bingo.kava.example/j/KQ7P");
  fail = true;
  await cache.refresh("bingo");
  assert.equal(cache.snapshot().bingo, undefined, "unreadable status: no stale Join links");
  cache.stop();
});

test("path routing (SDK 0.10.0): games that support it live at <play host>/<id>, off the DNS list", async () => {
  const { allHosts, buildContext, buildGatewayConfig, gamePath, gameUrl } = await import("./venue.js");
  const { RESERVED_PATHS } = await import("./games.js");
  const dir = mkdtempSync(path.join(tmpdir(), "bg-core-"));
  await openState(dir).venue.update((v) => Object.assign(v, { domain: "example.com", publicScheme: "https", publicPort: null }));
  const venue = openState(dir).venue.get();
  const mk = (id: string, routing?: boolean, extra: Partial<InstalledGame> = {}): InstalledGame => ({
    id,
    manifest: { ...manifest, id, health: "/health", resources: { memory: "256m", cpus: 0.5 }, network: { internet: false }, ...(routing ? { routing: { basePath: true } } : {}) } as unknown as InstalledGame["manifest"],
    source: { kind: "url", ref: "x" },
    verified: false,
    installedAt: "",
    updatedAt: "",
    enabled: true,
    branding: {},
    token: "t",
    ...extra,
  });
  const play = hostFor(venue, venue.playLabel);
  const bingo = mk("bingo", true);
  const pool = mk("pool");
  const menu = mk("menu", true, { hostnameAlias: "eats" });
  const kept = mk("trivia", true, { ownHostname: true });

  assert.equal(gamePath(bingo), "/bingo");
  assert.equal(gamePath(menu), "/eats", "the alias names the path too");
  assert.equal(gamePath(pool), undefined, "no support declared: its own hostname");
  assert.equal(gamePath(kept), undefined, "the venue chose a hostname for it");
  assert.equal(gameUrl(venue, bingo), `https://${play}/bingo`);
  assert.equal(gameUrl(venue, pool), "https://pool.example.com");
  assert.equal(buildContext(venue, bingo).game.basePath, "/bingo");
  assert.equal(buildContext(venue, pool).game.basePath, undefined);

  const hosts = allHosts(venue, [bingo, pool, menu, kept]);
  assert.ok(!hosts.includes("bingo.example.com") && !hosts.includes("eats.example.com"), "path games need no DNS record");
  assert.ok(hosts.includes("pool.example.com") && hosts.includes("trivia.example.com"));

  const gw = buildGatewayConfig({ venue, access: openState(dir).access.get(), games: [bingo, pool], coreUrl: "http://core", boxVersion: "x", setupRequired: false });
  const r = gw.routes.find((x) => x.gameId === "bingo" && !x.redirectTo)!;
  assert.deepEqual([r.host, r.path], [play, "/bingo"]);
  assert.equal(gw.routes.find((x) => x.host === "bingo.example.com")?.redirectTo, `https://${play}/bingo`);
  assert.equal(gw.hub.games.find((g) => g.id === "bingo")?.url, `https://${play}/bingo`);

  const spec = containerSpec(bingo, { coreUrl: "http://core:7100", publicUrl: gameUrl(venue, bingo), basePath: gamePath(bingo) });
  assert.ok((spec.body.Env as string[]).includes("BG_BASE_PATH=/bingo"));
  assert.ok((spec.body.Env as string[]).includes(`BG_PUBLIC_URL=https://${play}/bingo`));
  assert.ok(!(containerSpec(pool, { coreUrl: "http://core:7100", publicUrl: gameUrl(venue, pool) }).body.Env as string[]).some((e) => e.startsWith("BG_BASE_PATH=")));
  assert.ok(RESERVED_PATHS.includes("admin"));

  // Admin: /admin on the games list's hostname by default (no DNS record), or its own hostname.
  const { adminUrl } = await import("./venue.js");
  assert.equal(adminUrl(venue), `https://${play}/admin`);
  assert.ok(!allHosts(venue, []).includes(hostFor(venue, venue.adminLabel)));
  const own = { ...venue, adminOwnHost: true, adminLabel: "pachakava-admin" };
  assert.equal(adminUrl(own), "https://pachakava-admin.example.com");
  assert.ok(allHosts(own, []).includes("pachakava-admin.example.com"));
  const ownCfg = buildGatewayConfig({ venue: own, access: openState(dir).access.get(), games: [], coreUrl: "http://core", boxVersion: "x", setupRequired: false });
  assert.deepEqual(ownCfg.routes.filter((x) => x.kind === "admin").map((x) => [x.host, x.path]), [["pachakava-admin.example.com", undefined]]);
});
