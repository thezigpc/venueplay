// SDK 0.5.0 on the box: display modules (menus), venue location, idle TVs showing a menu,
// and game updates (check, image published, update with restart and rollback).

import { createLogger } from "@bargames/common";
import type { VenueContext } from "@bargames/sdk";
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
import { NoopRuntime } from "./runtime/types.js";
import { openState, type InstalledGame } from "./state.js";
import { opsClient, runOps } from "./ops.js";
import { StartupRunner, type StartupRule } from "./startup.js";
import { imageState, parseImage, UpdateChecker } from "./updates.js";

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const bingo = {
  id: "bingo",
  name: "Bingo",
  version: "1.0.0",
  image: "ghcr.io/acme/bingo:1.0.0",
  port: 3002,
  sdk: { version: "0.4.0", level: 1 },
  routes: { player: "/", table: "/room/{code}?role=table" },
};
const menu = {
  id: "menu",
  name: "Menu",
  kind: "display",
  version: "1.0.0",
  image: "ghcr.io/acme/menu:1.0.0",
  port: 3000,
  sdk: { version: "0.5.0", level: 1 },
  routes: { player: "/", table: "/tv", host: "/admin" },
  network: { internet: true },
};

/** A runtime that can be told to fail starting a given image. */
class SpyRuntime extends NoopRuntime {
  started: string[] = [];
  failImage?: string;
  override async ensureRunning(game: InstalledGame) {
    if (game.manifest.image === this.failImage) throw new Error("pull failed: manifest unknown");
    this.started.push(game.manifest.image);
    await super.ensureRunning(game);
  }
}

async function boot(extraFetch?: (url: string, init?: RequestInit) => Response | undefined, opts: { showDelayMs?: number; castAnswerMs?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-menus-"));
  const state = openState(dir);
  const games = new GameRegistry(state.games);
  const runtime = new SpyRuntime();
  const displays = [
    { id: "tv1", name: "Bar", content: { kind: "idle", url: "data:text/html,idle" } as { kind: string; url?: string } | undefined },
    { id: "tv2", name: "Patio", content: undefined as { kind: string; url?: string } | undefined },
  ];
  const shows: { displayIds?: string[]; content: { kind: string; url?: string; title?: string } }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === "http://broker/displays" || url === "http://broker/displays?health=1") return reply(displays.map((x) => ({ ...x, health: { online: x.id !== "tv-offline" } })));
    if (url === "http://broker/show") {
      if (opts.showDelayMs) await new Promise((r) => setTimeout(r, opts.showDelayMs));
      shows.push(body);
      for (const id of body.displayIds ?? []) {
        const disp = displays.find((x) => x.id === id);
        if (disp) disp.content = body.content;
      }
      return reply(Object.fromEntries((body.displayIds ?? []).map((id: string) => [id, { ok: true }])));
    }
    return extraFetch?.(url, init) ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  const app = createApp({
    state,
    games,
    runtime,
    bus: new EventBus(),
    auth: new AdminAuth(state.auth, "secret"),
    cloudflare: new CloudflareService({ store: state.cloudflare, connector: new NoopRuntime(), desiredHosts: () => [], tunnelName: () => "t", origin: "http://gw", log: createLogger("test", "error") }),
    log: createLogger("test", "error"),
    config: { gatewayToken: "gw", brokerUrl: "http://broker", brokerToken: "b", internalUrl: "http://core:7100", adminDist: path.join(dir, "none"), boxVersion: "0.5.0", opsToken: "ops-secret", castAnswerMs: opts.castAnswerMs, dataDir: dir },
    fetch: fakeFetch,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const cookie = (await json("POST", "/api/auth/setup", { password: "correct horse" })).headers.get("set-cookie")!.split(";")[0];
  return { app, json, base, dir, authed: { cookie }, games, runtime, displays, shows, close: () => server.close() };
}

test("menus: listed apart from games, venue location reaches games, cast without a room", async () => {
  const b = await boot();
  try {
    for (const m of [bingo, menu]) {
      assert.equal((await b.json("POST", "/api/games/install", { manifest: m, devTarget: `http://${m.id}` }, b.authed)).status, 200);
      await b.json("PATCH", `/api/games/${m.id}`, { enabled: true }, b.authed);
    }

    // Venue settings: validated.
    assert.equal((await b.json("PUT", "/api/venue", { timezone: "Mars/Olympus" }, b.authed)).status, 400);
    assert.equal((await b.json("PUT", "/api/venue", { location: { latitude: 120, longitude: 0 } }, b.authed)).status, 400);
    assert.equal((await b.json("PUT", "/api/venue", { idleModule: "bingo" }, b.authed)).status, 400, "only display modules can be the idle screen");
    const ok = await b.json("PUT", "/api/venue", { location: { latitude: 35.6, longitude: -82.55, label: "Test Town" }, timezone: "America/New_York", units: "imperial" }, b.authed);
    assert.equal(ok.status, 200);

    // What a game hears: the menu is a module, not a game; the location is there.
    const ctx = (await (await b.json("GET", "/internal/venue", undefined, { authorization: `Bearer ${b.games.get("bingo")!.token}` })).json()) as VenueContext;
    assert.deepEqual(ctx.venue.games?.map((g) => g.id), ["bingo"]);
    assert.deepEqual(ctx.venue.modules?.map((g) => g.id), ["menu"]);
    assert.equal(ctx.venue.location?.label, "Test Town");
    assert.equal(ctx.venue.timezone, "America/New_York");
    assert.equal(ctx.venue.units, "imperial");

    // Gateway config marks it for the games list.
    const cfg = (await (await b.json("GET", "/internal/gateway-config", undefined, { authorization: "Bearer gw" })).json()) as { hub: { games: { id: string; kind?: string }[] } };
    assert.equal(cfg.hub.games.find((g) => g.id === "menu")?.kind, "app", "a 0.5.0 \"display\" manifest is an app");
    assert.equal(cfg.hub.games.find((g) => g.id === "bingo")?.kind, "game");

    // Casting a menu: its TV view, no room.
    const cast = (await (await b.json("POST", "/api/cast", { gameId: "menu", displayIds: ["tv2"] }, b.authed)).json()) as { url: string; roomCode?: string };
    assert.equal(cast.url, "http://menu.localhost:7080/tv");
    assert.equal(cast.roomCode, undefined);
    assert.equal(b.displays[1].content?.url, "http://menu.localhost:7080/tv");
  } finally {
    b.close();
  }
});

test("menus: idle TVs show the chosen menu, and fall back when it's turned off", async () => {
  const b = await boot();
  try {
    for (const m of [bingo, menu]) {
      await b.json("POST", "/api/games/install", { manifest: m, devTarget: `http://${m.id}` }, b.authed);
      await b.json("PATCH", `/api/games/${m.id}`, { enabled: true }, b.authed);
    }
    // Picking the menu repaints TVs that are idle (tv1), and leaves others alone.
    assert.equal((await b.json("PUT", "/api/venue", { idleModule: "menu" }, b.authed)).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(b.displays[0].content, { kind: "idle", title: "Menu", url: "http://menu.localhost:7080/tv" });
    assert.equal(b.displays[1].content, undefined);

    // "Idle screen" from the admin: the menu.
    await b.json("POST", "/api/tvs/idle", { displayIds: ["tv2"] }, b.authed);
    assert.equal(b.displays[1].content?.url, "http://menu.localhost:7080/tv");

    // Announcements don't reload a menu (it shows them itself).
    const before = b.shows.length;
    await b.json("PUT", "/api/announcement", { text: "Last call" }, b.authed);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(b.shows.length, before);

    // Menu off: its TVs go to the box's own idle screen.
    await b.json("PATCH", "/api/games/menu", { enabled: false }, b.authed);
    for (const d of b.displays) {
      assert.equal(d.content?.kind, "idle");
      assert.match(String(d.content?.url), /^data:text\/html/);
    }
  } finally {
    b.close();
  }
});

test("updates: image references and the anonymous registry check", async () => {
  assert.deepEqual(parseImage("ghcr.io/acme/menu:1.2.0"), { registry: "ghcr.io", repo: "acme/menu", ref: "1.2.0" });
  assert.deepEqual(parseImage("ghcr.io/acme/menu@sha256:abc"), { registry: "ghcr.io", repo: "acme/menu", ref: "sha256:abc" });
  assert.deepEqual(parseImage("nginx"), { registry: "registry-1.docker.io", repo: "library/nginx", ref: "latest" });
  assert.deepEqual(parseImage("localhost:5000/x/y:2"), { registry: "localhost:5000", repo: "x/y", ref: "2" });

  const registry = (tags: Record<string, number>, tokenStatus = 200) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://ghcr.io/token")) {
        assert.match(url, /scope=repository%3Aacme%2Fmenu%3Apull/);
        return tokenStatus === 200 ? reply({ token: "anon" }) : reply({}, tokenStatus);
      }
      const auth = new Headers(init?.headers).get("authorization");
      if (!auth) return reply({}, 401, { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/menu:pull"' });
      const tag = url.split("/manifests/")[1];
      return new Response(null, { status: tags[tag] ?? 404 });
    }) as typeof fetch;
  assert.equal(await imageState("ghcr.io/acme/menu:1.1.0", registry({ "1.1.0": 200 })), "published");
  assert.equal(await imageState("ghcr.io/acme/menu:1.2.0", registry({ "1.1.0": 200 })), "missing");
  assert.equal(await imageState("ghcr.io/acme/menu:1.1.0", registry({ "1.1.0": 401 })), "private");
  assert.equal(await imageState("ghcr.io/acme/menu:1.1.0", registry({}, 403)), "private");
});

test("updates: offered only when newer and published; Update restarts it, a bad release rolls back", async () => {
  let served = { ...bingo, image: "ghcr.io/acme/bingo:1.0.0" } as Record<string, unknown>;
  const published = new Set(["ghcr.io/acme/bingo:1.0.0"]);
  const raw = "https://raw.githubusercontent.com/acme/bingo/HEAD/bargames.json";
  const b = await boot((url) => (url === raw ? reply(served) : undefined));
  const checker = new UpdateChecker({
    games: () => b.games.list(),
    fetchManifest: async () => ({ manifest: { ...(served as never), kind: "game" } }),
    imageState: async (image) => (published.has(image) ? "published" : "missing"),
    boxVersion: "0.5.0",
    log: createLogger("test", "error"),
  });
  try {
    assert.equal((await b.json("POST", "/api/games/install", { url: "https://github.com/acme/bingo" }, b.authed)).status, 200);
    await b.json("PATCH", "/api/games/bingo", { enabled: true }, b.authed);
    const game = () => b.games.get("bingo")!;

    assert.equal((await checker.check(game())).note, "up to date");
    served = { ...bingo, version: "1.1.0", image: "ghcr.io/acme/bingo:1.1.0" };
    const pending = await checker.check(game());
    assert.equal(pending.available, false, "not offered before the image exists");
    assert.match(pending.note!, /isn't published yet/);
    published.add("ghcr.io/acme/bingo:1.1.0");
    assert.deepEqual([(await checker.check(game())).available, checker.get("bingo")?.latest], [true, "1.1.0"]);
    served = { ...bingo, version: "1.2.0", image: "ghcr.io/acme/bingo:1.2.0", minBoxVersion: "0.9.0" };
    assert.match((await checker.check(game())).note!, /needs box 0.9.0/);

    // Update through the API: installs 1.1.0 and restarts the running game on it.
    served = { ...bingo, version: "1.1.0", image: "ghcr.io/acme/bingo:1.1.0" };
    const up = await b.json("POST", "/api/games/bingo/update", undefined, b.authed);
    assert.equal(up.status, 200);
    assert.equal(game().manifest.version, "1.1.0");
    assert.equal(b.runtime.started.at(-1), "ghcr.io/acme/bingo:1.1.0");
    assert.equal((await b.json("POST", "/api/games/bingo/update", undefined, b.authed)).status, 409, "already current");

    // A release whose image won't start: back on 1.1.0, still running, and the admin is told.
    served = { ...bingo, version: "1.2.0", image: "ghcr.io/acme/bingo:1.2.0" };
    b.runtime.failImage = "ghcr.io/acme/bingo:1.2.0";
    const bad = await b.json("POST", "/api/games/bingo/update", undefined, b.authed);
    assert.equal(bad.status, 502);
    assert.match(((await bad.json()) as { error: string }).error, /back on 1\.1\.0/);
    assert.equal(game().manifest.version, "1.1.0");
    assert.equal(b.runtime.started.at(-1), "ghcr.io/acme/bingo:1.1.0");

    // Re-pasting the URL (the old way to update) now restarts the game too.
    b.runtime.failImage = undefined;
    assert.equal((await b.json("POST", "/api/games/install", { url: "https://github.com/acme/bingo" }, b.authed)).status, 200);
    assert.equal(b.runtime.started.at(-1), "ghcr.io/acme/bingo:1.2.0");
  } finally {
    b.close();
  }
});

test("bgctl: ops endpoints need the ops token; update waits for a building image, then updates", async () => {
  let served = { ...bingo } as Record<string, unknown>;
  const raw = "https://raw.githubusercontent.com/acme/bingo/HEAD/bargames.json";
  let published = new Set(["1.0.0"]);
  const b = await boot((url, init) => {
    if (url.split("?")[0] === raw) return reply(served);
    // The registry: anonymous token, then the manifest by tag.
    if (url.startsWith("https://ghcr.io/token")) return reply({ token: "anon" });
    if (url.startsWith("https://ghcr.io/v2/acme/bingo/manifests/")) {
      if (!new Headers(init?.headers).get("authorization")) return reply({}, 401, { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' });
      return new Response(null, { status: published.has(url.split("/manifests/")[1]) ? 200 : 404 });
    }
    return undefined;
  });
  try {
    await b.json("POST", "/api/games/install", { url: "https://github.com/acme/bingo" }, b.authed);
    await b.json("PATCH", "/api/games/bingo", { enabled: true }, b.authed);
    assert.equal((await b.json("GET", "/internal/ops/games")).status, 401);
    assert.equal((await b.json("GET", "/internal/ops/games", undefined, { authorization: "Bearer wrong-token" })).status, 401);
    assert.equal((await b.json("GET", "/internal/ops/games", undefined, { authorization: `Bearer ${b.games.get("bingo")!.token}` })).status, 401, "a game's token isn't enough");

    const client = opsClient(b.base, "ops-secret");
    const lines: string[] = [];
    assert.equal(await runOps(["status"], client, (l) => lines.push(l)), 0);
    assert.match(lines.join(" | "), /bingo\s+1\.0\.0/);

    assert.equal(await runOps(["update", "nope"], client, () => undefined), 1, "unknown game");
    lines.length = 0;
    assert.equal(await runOps(["update", "bingo"], client, (l) => lines.push(l)), 0);
    assert.match(lines.at(-1)!, /bingo: up to date/);

    // 1.1.0 announced, image still building: --wait keeps checking, then updates.
    served = { ...bingo, version: "1.1.0", image: "ghcr.io/acme/bingo:1.1.0" };
    lines.length = 0;
    let naps = 0;
    const code = await runOps(["update", "bingo", "--wait", "5"], client, (l) => lines.push(l), async () => {
      naps++;
      published = new Set(["1.0.0", "1.1.0"]);
    });
    assert.equal(code, 0, lines.join(" | "));
    assert.equal(naps, 1);
    assert.match(lines.join(" | "), /waiting for bingo/);
    assert.match(lines.at(-1)!, /ok\s+bingo: updated 1\.0\.0 → 1\.1\.0/);
    assert.equal(b.games.get("bingo")!.manifest.version, "1.1.0");
    assert.equal(b.runtime.started.at(-1), "ghcr.io/acme/bingo:1.1.0");

    // Without --wait a building image is reported, not waited on.
    served = { ...bingo, version: "1.2.0", image: "ghcr.io/acme/bingo:1.2.0" };
    lines.length = 0;
    assert.equal(await runOps(["update", "--all"], client, (l) => lines.push(l)), 0);
    assert.match(lines.join(" | "), /nothing to update/);
  } finally {
    b.close();
  }
});

test("bgctl install: waits for the image, installs, and turns the game on", async () => {
  const raw = "https://raw.githubusercontent.com/acme/bingo/HEAD/bargames.json";
  let published = false;
  const b = await boot((url, init) => {
    if (url.split("?")[0] === raw) return reply(bingo);
    if (url.startsWith("https://ghcr.io/token")) return reply({ token: "anon" });
    if (url.startsWith("https://ghcr.io/v2/acme/bingo/manifests/")) {
      if (!new Headers(init?.headers).get("authorization")) return reply({}, 401, { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' });
      return new Response(null, { status: published ? 200 : 404 });
    }
    return undefined;
  });
  try {
    const client = opsClient(b.base, "ops-secret");
    const lines: string[] = [];
    assert.equal(await runOps(["install", "https://github.com/acme/bingo", "--enable"], client, (l) => lines.push(l)), 1, "no --wait: fails while building");
    assert.match(lines.join(" | "), /FAIL install: image not available yet/);
    assert.equal(b.games.get("bingo"), undefined, "nothing installed");

    lines.length = 0;
    const code = await runOps(["install", "https://github.com/acme/bingo", "--enable", "--wait", "5"], client, (l) => lines.push(l), async () => {
      published = true;
    });
    assert.equal(code, 0, lines.join(" | "));
    assert.match(lines.join(" | "), /waiting: .*bingo:1\.0\.0/);
    assert.match(lines.join(" | "), /ok\s+bingo: installed 1\.0\.0, on \(running\)/);
    assert.equal(b.games.get("bingo")?.enabled, true);
    assert.equal(b.runtime.started.at(-1), "ghcr.io/acme/bingo:1.0.0");
  } finally {
    b.close();
  }
});

test("tv startup: rules are validated, and running them puts the menu on its TV", async () => {
  const b = await boot();
  try {
    for (const m of [bingo, menu]) {
      await b.json("POST", "/api/games/install", { manifest: m, devTarget: `http://${m.id}` }, b.authed);
      await b.json("PATCH", `/api/games/${m.id}`, { enabled: true }, b.authed);
    }
    assert.equal((await b.json("PUT", "/api/tv-startup/tv2", { mode: "game", gameId: "nope" }, b.authed)).status, 400);
    assert.equal((await b.json("PUT", "/api/tv-startup/tv2", { mode: "dance" }, b.authed)).status, 400);
    assert.equal((await b.json("PUT", "/api/tv-startup/tv2", { mode: "game", gameId: "menu" }, b.authed)).status, 200);
    assert.equal((await b.json("PUT", "/api/tv-startup/tv1", { mode: "off" }, b.authed)).status, 200);
    assert.deepEqual(await (await b.json("PUT", "/api/tv-startup/tv1", { mode: "last" }, b.authed)).json(), { tv2: { mode: "game", gameId: "menu" } }, "last removes the rule");

    const r = (await (await b.json("POST", "/api/tv-startup/run", undefined, b.authed)).json()) as { waiting: string[] };
    assert.deepEqual(r.waiting, ["tv2"]);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(b.displays[1].content?.url, "http://menu.localhost:7080/tv");
    assert.equal(b.displays[0].content?.kind, "idle", "a TV without a rule is left alone");
  } finally {
    b.close();
  }
});

test("tv startup runner: waits for TVs to come online, retries, gives up", async () => {
  const online = new Set<string>();
  const applied: string[] = [];
  let failNext = 1;
  const rules: Record<string, StartupRule> = { a: { mode: "idle" }, b: { mode: "game", gameId: "menu" }, c: { mode: "last" } };
  const runner = new StartupRunner(
    {
      rules: () => rules,
      displays: async () => ["a", "b", "c"].map((id) => ({ id, online: online.has(id) })),
      apply: async (id) => {
        if (id === "b" && failNext-- > 0) throw new Error("AirPlay still waking");
        applied.push(id);
      },
      log: createLogger("test", "error"),
    },
    { intervalMs: 3_600_000, windowMs: 60_000 },
  );
  runner.start();
  runner.stop(); // drive ticks by hand
  assert.deepEqual(runner.waiting.sort(), ["a", "b"], "last needs nothing");
  await runner.tick();
  assert.deepEqual(applied, [], "nothing online yet");
  online.add("a").add("b");
  await runner.tick();
  assert.deepEqual(applied, ["a"]);
  assert.deepEqual(runner.waiting, ["b"], "b failed once; retried");
  await runner.tick();
  assert.deepEqual(applied, ["a", "b"]);
  assert.deepEqual(runner.waiting, []);
});

test("casting from a game: a slow TV gets \"starting\" before the phone gives up, and still comes on", async () => {
  const b = await boot((url) => (url === "http://bingo/__bargames/status" ? reply({ rooms: [{ code: "ROOM1", kind: "venue", players: 0 }] }) : undefined), { showDelayMs: 300, castAnswerMs: 50 });
  try {
    const m = { ...bingo, sdk: { version: "0.6.0", level: 3 }, commands: ["start"] };
    await b.json("POST", "/api/games/install", { manifest: m, devTarget: "http://bingo" }, b.authed);
    await b.json("PATCH", "/api/games/bingo", { enabled: true }, b.authed);
    await b.json("PUT", "/api/cast-settings", { fromGames: true, pin: "" }, b.authed);
    const g = { authorization: `Bearer ${b.games.get("bingo")!.token}` };
    const t0 = Date.now();
    const r = (await (await b.json("POST", "/internal/cast", { roomCode: "ROOM1", displayIds: ["tv2"] }, g)).json()) as { ok: boolean; message?: string; results: Record<string, { ok: boolean; message?: string }> };
    assert.ok(Date.now() - t0 < 250, "answered before the TV finished");
    assert.equal(r.ok, true);
    assert.equal(r.results.tv2.message, "starting");
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(b.displays[1].content?.url, "http://bingo.localhost:7080/room/ROOM1?role=table", "the cast carried on");
  } finally {
    b.close();
  }
});

test("box password: logging in signs staff in venue-wide; games can check it; guesses are limited", async () => {
  const b = await boot();
  try {
    await b.json("PUT", "/api/venue", { domain: "example.com", publicScheme: "https", publicPort: null }, b.authed);
    // Logging in on the venue's admin address also sets the venue-wide staff cookie.
    const r = await b.json("POST", "/api/auth/login", { password: "correct horse" }, { "x-forwarded-host": "admin.example.com" });
    const cookies = r.headers.getSetCookie().join(" | ");
    assert.match(cookies, /bg_staff=staff\.\d+\.[\w-]+\.[\w-]+; Max-Age=43200; Domain=example\.com; Path=\/;/);
    // From an IP address there's no shared domain: no staff cookie (the Settings hand-off covers it).
    const ip = await b.json("POST", "/api/auth/login", { password: "correct horse" }, { "x-forwarded-host": "192.168.77.13" });
    assert.doesNotMatch(ip.headers.getSetCookie().join(" | "), /bg_staff=/);
    const out = await b.json("POST", "/api/auth/logout", undefined, { "x-forwarded-host": "admin.example.com" });
    assert.match(out.headers.getSetCookie().join(" | "), /bg_staff=;.*Domain=example\.com/, "logout clears it");

    // A game asks whether what was typed is the box password.
    await b.json("POST", "/api/games/install", { manifest: menu, devTarget: "http://menu" }, b.authed);
    const g = { authorization: `Bearer ${b.games.get("menu")!.token}` };
    const check = async (password: string, clientIp = "10.0.0.5") => ((await (await b.json("POST", "/internal/venue-password", { password, clientIp }, g)).json()) as { ok: boolean; reason?: string });
    assert.equal((await b.json("POST", "/internal/venue-password", { password: "correct horse" })).status, 401, "games only");
    assert.deepEqual(await check("correct horse"), { ok: true });
    assert.deepEqual(await check("nope"), { ok: false, reason: "wrong" });
    for (let i = 0; i < 10; i++) await check("guess", "10.0.0.66");
    assert.deepEqual(await check("correct horse", "10.0.0.66"), { ok: false, reason: "blocked" }, "that guest is locked out");
    assert.deepEqual(await check("correct horse", "10.0.0.5"), { ok: true }, "others aren't");

    // The box's own login is limited too.
    for (let i = 0; i < 10; i++) await b.json("POST", "/api/auth/login", { password: "x" });
    assert.equal((await b.json("POST", "/api/auth/login", { password: "correct horse" })).status, 429);
  } finally {
    b.close();
  }
});

test("system: stats from /proc and /sys, container CPU, and a reboot only with the host helper", async () => {
  const { HostSampler, containerCpuPercent, parseMeminfo, parseProcStat } = await import("./systemStats.js");
  const { mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  assert.deepEqual(parseProcStat("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3"), { total: 1000, idle: 800 });
  assert.deepEqual(parseMeminfo("MemTotal:       1000 kB\nMemFree: 1 kB\nMemAvailable:    250 kB\n"), { totalBytes: 1024000, availableBytes: 256000 });
  assert.equal(containerCpuPercent({ cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 4 }, precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 } }), 80);
  assert.equal(containerCpuPercent({}), undefined);

  const root = mkdtempSync(path.join(tmpdir(), "bg-sys-"));
  const put = (p: string, v: string) => {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), v);
  };
  put("proc/stat", "cpu  100 0 100 700 100 0 0 0 0 0\n");
  put("proc/meminfo", "MemTotal: 1000 kB\nMemAvailable: 250 kB\n");
  put("proc/loadavg", "0.50 0.25 0.10 1/500 99\n");
  put("sys/thermal/thermal_zone0/type", "x86_pkg_temp\n");
  put("sys/thermal/thermal_zone0/temp", "51000\n");
  put("sys/hwmon/hwmon1/name", "nvme\n");
  put("sys/hwmon/hwmon1/temp1_input", "38850\n");
  put("sys/hwmon/hwmon1/temp1_label", "Composite\n");
  put("sys/drm/card1/gt_cur_freq_mhz", "350\n");
  put("sys/drm/card1/gt_max_freq_mhz", "1050\n");
  const sampler = new HostSampler({ proc: path.join(root, "proc"), sys: path.join(root, "sys"), diskPath: root });
  const first = sampler.read();
  assert.equal(first.cpuPercent, undefined, "first reading: nothing to compare yet");
  assert.deepEqual(first.load, [0.5, 0.25, 0.1]);
  assert.equal(first.memory.usedPercent, 75);
  assert.deepEqual(first.temps, [{ label: "CPU package", celsius: 51 }, { label: "NVMe Composite", celsius: 38.9 }]);
  assert.deepEqual(first.gpu, { curMhz: 350, maxMhz: 1050 });
  assert.ok(first.disk && first.disk.totalBytes > 0);
  put("proc/stat", "cpu  400 0 100 900 100 0 0 0 0 0\n");
  assert.equal(sampler.read().cpuPercent, 60, "300 of 500 jiffies busy");

  // The API: stats, and reboot only with the host helper installed.
  const b = await boot();
  try {
    const st = (await (await b.json("GET", "/api/system/stats", undefined, b.authed)).json()) as { host: { cores: number }; reboot: { available: boolean } };
    assert.ok(st.host.cores > 0);
    assert.equal(st.reboot.available, false);
    assert.equal((await b.json("GET", "/api/system/stats")).status, 401, "admin only");
    assert.equal((await b.json("POST", "/api/system/reboot", {}, b.authed)).status, 400, "needs the explicit confirm");
    assert.equal((await b.json("POST", "/api/system/reboot", { confirm: "reboot" }, b.authed)).status, 409, "no host helper yet");
    writeFileSync(path.join(b.dir, "host-hooks.json"), JSON.stringify({ reboot: true }));
    assert.equal((await b.json("POST", "/api/system/reboot", { confirm: "reboot" })).status, 401, "admin only");
    assert.equal((await b.json("POST", "/api/system/reboot", { confirm: "reboot" }, b.authed)).status, 200);
    assert.ok(existsSync(path.join(b.dir, "reboot.request")), "the request the host helper watches for");
    assert.match(readFileSync(path.join(b.dir, "reboot.request"), "utf8"), /"at":/);
    assert.equal(((await (await b.json("GET", "/api/system/stats", undefined, b.authed)).json()) as { reboot: { pending: boolean } }).reboot.pending, true);
  } finally {
    b.close();
  }
});

test("manifests from GitHub: read through the API (uncached), raw as the fallback", async () => {
  const { fetchManifest, githubApiUrl } = await import("./manifestSource.js");
  assert.equal(githubApiUrl("https://raw.githubusercontent.com/acme/menu/HEAD/bargames.json"), "https://api.github.com/repos/acme/menu/contents/bargames.json");
  assert.equal(githubApiUrl("https://raw.githubusercontent.com/acme/menu/v1.2/app/bargames.json"), "https://api.github.com/repos/acme/menu/contents/app/bargames.json?ref=v1.2");
  assert.equal(githubApiUrl("https://example.com/bargames.json"), undefined);
  const fresh = { ...menu, version: "0.4.0" };
  const stale = { ...menu, version: "0.3.2" };
  let apiUp = true;
  const seen: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url.split("/")[2]);
    if (url.startsWith("https://api.github.com/")) return apiUp ? reply(fresh) : reply({ message: "API rate limit exceeded" }, 403);
    return reply(stale);
  }) as typeof fetch;
  assert.equal((await fetchManifest("https://github.com/acme/menu", fake)).manifest.version, "0.4.0", "the API's current file");
  apiUp = false;
  assert.equal((await fetchManifest("https://github.com/acme/menu", fake)).manifest.version, "0.3.2", "rate-limited: raw still works");
  assert.deepEqual(seen, ["api.github.com", "api.github.com", "raw.githubusercontent.com"]);
});

test("secret settings: write-only in the admin, injected as env, a removal recreates the container", async () => {
  const { containerSpec, envHash } = await import("./runtime/spec.js");
  const b = await boot();
  try {
    await b.json("POST", "/api/games/install", { manifest: menu, devTarget: "http://menu" }, b.authed);
    await b.json("PATCH", "/api/games/menu", { enabled: true }, b.authed);
    const before = b.runtime.started.length;
    assert.equal((await b.json("PUT", "/api/games/menu/secrets/GOOGLE_FALLBACK_CLIENT_ID", { value: "abc.apps.googleusercontent.com" }, b.authed)).status, 200);
    assert.equal((await b.json("PUT", "/api/games/menu/secrets/GOOGLE_FALLBACK_CLIENT_SECRET", { value: "s3cr3t-value" }, b.authed)).status, 200);
    assert.equal(b.runtime.started.length, before + 2, "a running app restarts with each change");
    const listed = await (await b.json("GET", "/api/games/menu/secrets", undefined, b.authed)).text();
    assert.ok(!listed.includes("s3cr3t") && !listed.includes("abc.apps"), "values never come back");
    assert.deepEqual(JSON.parse(listed).secrets.map((s: { name: string }) => s.name), ["GOOGLE_FALLBACK_CLIENT_ID", "GOOGLE_FALLBACK_CLIENT_SECRET"]);
    assert.equal((await b.json("PUT", "/api/games/menu/secrets/BG_GAME_TOKEN", { value: "x" }, b.authed)).status, 400, "the box's own names are off limits");
    assert.equal((await b.json("PUT", "/api/games/menu/secrets/lower", { value: "x" }, b.authed)).status, 400);
    assert.equal((await b.json("GET", "/api/games/menu/secrets")).status, 401, "admin only");

    // In the container env; BG_* can't be overridden.
    const game = b.games.get("menu")!;
    const env = (s: ReturnType<typeof containerSpec>) => s.body.Env as string[];
    const withSecrets = containerSpec(game, { coreUrl: "http://core", publicUrl: "https://menu.x", secrets: { GOOGLE_FALLBACK_CLIENT_SECRET: "s3cr3t-value", BG_GAME_ID: "evil" } });
    assert.ok(env(withSecrets).includes("GOOGLE_FALLBACK_CLIENT_SECRET=s3cr3t-value"));
    assert.ok(env(withSecrets).includes("BG_GAME_ID=menu"));
    const without = containerSpec(game, { coreUrl: "http://core", publicUrl: "https://menu.x" });
    const label = (s: ReturnType<typeof containerSpec>) => (s.body.Labels as Record<string, string>)["bargames.envhash"];
    assert.notEqual(label(withSecrets), label(without), "a removed setting changes the fingerprint");
    assert.equal(envHash({ A: "1", B: "2" }), envHash({ B: "2", A: "1" }));

    assert.equal((await b.json("DELETE", "/api/games/menu/secrets/GOOGLE_FALLBACK_CLIENT_SECRET", undefined, b.authed)).status, 200);
    assert.deepEqual(((await (await b.json("GET", "/api/games/menu/secrets", undefined, b.authed)).json()) as { secrets: { name: string }[] }).secrets.map((s) => s.name), ["GOOGLE_FALLBACK_CLIENT_ID"]);
  } finally {
    b.close();
  }
});

test("0.9.0: attention, TV health, countdown, results and leaderboards, profiles stub", async () => {
  const { nightStart, board } = await import("./leaderboard.js");
  const { idleScreenHtml } = await import("./idleScreen.js");
  // "Tonight" starts at 4 AM venue time.
  assert.equal(nightStart(new Date("2026-11-12T03:00:00Z"), "America/New_York").toISOString(), "2026-11-11T09:00:00.000Z", "10 PM in New York: since 4 AM that day");
  assert.equal(nightStart(new Date("2026-11-12T10:00:00Z"), "America/New_York").toISOString(), "2026-11-12T09:00:00.000Z", "5 AM: a new night");
  assert.deepEqual(
    board([{ gameId: "g", at: "", results: [{ player: { name: "Ann" }, place: 1, score: 5 }, { player: { name: "bo" }, place: 2 }] }, { gameId: "g", at: "", results: [{ player: { name: "ann" }, place: 1, score: 9 }] }]),
    [{ name: "Ann", wins: 2, games: 2, best: 9 }, { name: "bo", wins: 0, games: 1 }],
    "names merge case-insensitively",
  );

  const b = await boot();
  try {
    await b.json("POST", "/api/games/install", { manifest: { ...bingo, sdk: { version: "0.9.0", level: 1 } }, devTarget: "http://bingo" }, b.authed);
    await b.json("PATCH", "/api/games/bingo", { enabled: true }, b.authed);
    const g = { authorization: `Bearer ${b.games.get("bingo")!.token}` };

    // Attention: a game's list replaces its last one; the admin sees them all.
    await b.json("POST", "/internal/attention", { items: [{ level: "warn", message: "Google disconnected", actionPath: "/admin#google" }, { level: "nope", message: "x" }] }, g);
    let att = ((await (await b.json("GET", "/api/attention", undefined, b.authed)).json()) as { items: { source: string; sourceName: string; message: string; actionPath?: string }[] }).items;
    assert.deepEqual(att.map((i) => [i.sourceName, i.message, i.actionPath]), [["Bingo", "Google disconnected", "/admin#google"]]);
    await b.json("POST", "/internal/attention", { items: [] }, g);
    assert.equal(((await (await b.json("GET", "/api/attention", undefined, b.authed)).json()) as { items: unknown[] }).items.length, 0);

    // TV health: offline for 10+ minutes becomes a box item; back online clears it.
    b.displays.push({ id: "tv-offline", name: "Patio", content: undefined });
    const sweep = b.app.locals.sweepTvHealth as (now?: number) => Promise<void>;
    const t0 = Date.now();
    await sweep(t0);
    assert.equal(((await (await b.json("GET", "/api/attention", undefined, b.authed)).json()) as { items: unknown[] }).items.length, 0, "not yet: just went offline");
    await sweep(t0 + 11 * 60_000);
    att = ((await (await b.json("GET", "/api/attention", undefined, b.authed)).json()) as { items: { source: string; sourceName: string; message: string; actionPath?: string }[] }).items;
    assert.deepEqual(att.map((i) => [i.sourceName, i.message]), [["Box", "Patio has been offline for 11 minutes."]]);
    b.displays.pop();
    await sweep(t0 + 12 * 60_000);
    assert.equal(((await (await b.json("GET", "/api/attention", undefined, b.authed)).json()) as { items: unknown[] }).items.length, 0, "gone or back: cleared");

    // Countdown from a game: in the venue context, on the idle screen, cleared by the game.
    const c = (await (await b.json("POST", "/internal/countdown", { label: "Bingo starts in", minutes: 5 }, g)).json()) as { id: string; endsAt: string; joinUrl?: string; gameId?: string };
    assert.equal(c.gameId, "bingo");
    assert.equal(c.joinUrl, "http://bingo.localhost:7080");
    const ctx = (await (await b.json("GET", "/internal/venue", undefined, g)).json()) as { venue: { countdown?: { label: string } } };
    assert.equal(ctx.venue.countdown?.label, "Bingo starts in");
    assert.equal((await b.json("POST", "/internal/countdown", { label: "", minutes: 5 }, g)).status, 400);
    await b.json("DELETE", "/internal/countdown", undefined, g);
    assert.equal(await (await b.json("GET", "/api/countdown", undefined, b.authed)).json(), null);
    // Staff countdown.
    assert.equal((await b.json("PUT", "/api/countdown", { label: "Trivia at", minutes: 2 }, b.authed)).status, 200);
    assert.equal(((await (await b.json("GET", "/api/countdown", undefined, b.authed)).json()) as { label: string }).label, "Trivia at");

    // Results → tonight's winners in the venue context; leaderboards for the admin.
    assert.equal((await b.json("POST", "/internal/results", { results: [] }, g)).status, 400);
    assert.equal((await b.json("POST", "/internal/results", { roomCode: "AB", results: [{ player: { name: "Ann" }, place: 1 }, { player: { name: "Bo" }, place: 2 }] }, g)).status, 200);
    await b.json("POST", "/internal/results", { results: [{ player: { name: "ann" }, place: 1 }] }, g);
    const ctx2 = (await (await b.json("GET", "/internal/venue", undefined, g)).json()) as { venue: { leaderboards?: { gameId: string; tonight: { name: string; wins: number }[] }[] } };
    assert.deepEqual(ctx2.venue.leaderboards?.[0].tonight.slice(0, 1), [{ name: "Ann", wins: 2 }]);
    const lb = (await (await b.json("GET", "/api/leaderboards", undefined, b.authed)).json()) as { games: { gameId: string; allTime: { name: string; wins: number; games: number }[] }[] };
    assert.deepEqual(lb.games[0].allTime[0], { name: "Ann", wins: 2, games: 2 });
    const html = await idleScreenHtml({ venue: (await (await b.json("GET", "/internal/venue", undefined, g)).json() as { venue: Parameters<typeof idleScreenHtml>[0]["venue"] }).venue, games: ["Bingo"] });
    assert.match(html, /Tonight's winners: Bingo: <b>Ann<\/b> ×2/);
    assert.match(html, /Trivia at <b id="cd" data-ends="\d+"><\/b>/, "the staff countdown ticks on idle TVs");
    await b.json("DELETE", "/api/leaderboards", undefined, b.authed);
    assert.equal(((await (await b.json("GET", "/api/leaderboards", undefined, b.authed)).json()) as { games: unknown[] }).games.length, 0);

    // Profiles: a stub.
    assert.equal((await b.json("GET", "/internal/profiles/abc", undefined, g)).status, 501);
  } finally {
    b.close();
  }
});

test("0.9.0 media providers: TVs for providers, launch rules, play/stop from the box", async () => {
  const commands: { command: string; args?: Record<string, unknown> }[] = [];
  const brokerCalls: string[] = [];
  let targets = [{ displayId: "tv1", label: "Bar", state: "linked" }];
  const b = await boot((url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === "http://yt/__bargames/status") return reply({ rooms: [], media: { targets } });
    if (url === "http://yt/__bargames/command") {
      commands.push(body);
      if (body.command === "media_list") return reply({ ok: true, data: { items: [{ id: "L1", name: "Friday mix", kind: "list" }, { id: "P1", name: "Saturday", kind: "plan" }] } });
      if (body.command === "media_play" && (body.args as { itemId?: string } | undefined)?.itemId === "BAD") return reply({ ok: false, message: "no such list" });
      if (body.command === "media_play") return reply({ ok: true, data: { ok: true, pending: true, launched: true } });
      if (body.command === "media_stop") return reply({ ok: true });
    }
    if (url.startsWith("http://broker/displays/tv1/")) {
      brokerCalls.push(url.replace("http://broker", ""));
      if (url.endsWith("/dial/youtube")) return reply({ screenId: "SCREEN-1" });
      return reply({ ok: true });
    }
    return undefined;
  });
  try {
    Object.assign(b.displays[0], { driver: "roku", launchable: ["youtube"] });
    Object.assign(b.displays[1], { driver: "airplay", launchable: [] });
    const yt = { id: "youtube", name: "YouTube", kind: "app", version: "0.1.0", image: "ghcr.io/x/youtube:0.1.0", port: 3006, sdk: { version: "0.9.0", level: 3 }, routes: { player: "/" }, commands: ["media_list", "media_play", "media_stop"], events: [], media: { launch: ["youtube"] }, network: { internet: true } };
    assert.equal((await b.json("POST", "/api/games/install", { manifest: yt, devTarget: "http://yt" }, b.authed)).status, 200);
    await b.json("PATCH", "/api/games/youtube", { enabled: true }, b.authed);
    await b.json("POST", "/api/games/install", { manifest: bingo, devTarget: "http://bingo" }, b.authed);
    const g = { authorization: `Bearer ${b.games.get("youtube")!.token}` };
    const notMedia = { authorization: `Bearer ${b.games.get("bingo")!.token}` };

    // TVs: only for media providers; the screen id only for a Roku when the app launches youtube.
    assert.equal((await b.json("GET", "/internal/tvs", undefined, notMedia)).status, 403);
    const tvs = ((await (await b.json("GET", "/internal/tvs", undefined, g)).json()) as { tvs: { id: string; canLaunch: string[]; youtubeScreenId?: string; kind: string }[] }).tvs;
    assert.deepEqual(tvs.map((t) => [t.id, t.kind, t.canLaunch, t.youtubeScreenId]), [["tv1", "roku", ["youtube"], "SCREEN-1"], ["tv2", "airplay", [], undefined]]);

    // Launch: declared apps only, on TVs the app reports as its targets.
    const launch = (displayId: string, app: string) => b.json("POST", "/internal/launch-app", { displayId, app }, g).then((r) => r.json() as Promise<{ ok: boolean; reason?: string }>);
    assert.deepEqual(await launch("tv1", "netflix"), { ok: false, reason: "not-allowed", message: "netflix isn't in media.launch in bargames.json" });
    assert.equal((await launch("tv2", "youtube")).reason, "not-allowed", "tv2 isn't a target");
    assert.equal((await launch("tv1", "youtube")).ok, true);
    assert.ok(brokerCalls.includes("/displays/tv1/launch"));

    // The box: providers and targets, items, play (records external, polls fast), stop (idle screen).
    const media = (await (await b.json("GET", "/api/media", undefined, b.authed)).json()) as { providers: { gameId: string; targets: { displayId: string }[] }[] };
    assert.deepEqual(media.providers.map((p) => [p.gameId, p.targets.map((t) => t.displayId)]), [["youtube", ["tv1"]]]);
    const items = (await (await b.json("GET", "/api/media/youtube/items", undefined, b.authed)).json()) as { items: { id: string; kind: string }[] };
    assert.deepEqual(items.items.map((i) => i.kind), ["list", "plan"]);
    const played = (await (await b.json("POST", "/api/media/youtube/play", { displayId: "tv1", itemId: "L1" }, b.authed)).json()) as { ok: boolean; pending: boolean };
    assert.deepEqual([played.ok, played.pending], [true, true]);
    assert.deepEqual(commands.at(-1), { command: "media_play", args: { itemId: "L1", takeBack: true, displayId: "tv1" } });
    assert.ok(brokerCalls.includes("/displays/tv1/external"), "the TV is recorded as showing YouTube");
    await b.json("POST", "/api/media/youtube/play", { itemId: "P1" }, b.authed);
    assert.deepEqual(commands.at(-1)?.args, { itemId: "P1", takeBack: true }, "plans have no displayId");
    // A failed play on a TV: the box's cast was stopped first, so the idle screen goes back.
    const before = b.shows.length;
    assert.equal(((await (await b.json("POST", "/api/media/youtube/play", { displayId: "tv1", itemId: "BAD" }, b.authed)).json()) as { ok: boolean }).ok, false);
    assert.equal(b.shows.length, before + 1);
    assert.equal(b.shows.at(-1)?.content.kind, "idle");

    const shows = b.shows.length;
    assert.equal(((await (await b.json("POST", "/api/media/youtube/stop", { displayId: "tv1" }, b.authed)).json()) as { ok: boolean }).ok, true);
    assert.equal(b.shows.length, shows + 1, "after a stop the box shows its idle screen");
    assert.equal(b.shows.at(-1)?.content.kind, "idle");
    // Never over local control.
    targets = [{ displayId: "tv1", label: "Bar", state: "local" }];
    await b.json("GET", "/api/media", undefined, b.authed);
    await (b.app.locals.roomCache as { refresh(id?: string): Promise<void> }).refresh("youtube");
    await b.json("POST", "/api/media/youtube/stop", { displayId: "tv1" }, b.authed);
    assert.equal(b.shows.length, shows + 1, "local: left alone");

    // A media startup choice.
    assert.equal((await b.json("PUT", "/api/tv-startup/tv1", { mode: "media", gameId: "youtube", itemId: "L1" }, b.authed)).status, 200);
    assert.equal((await b.json("PUT", "/api/tv-startup/tv1", { mode: "media", gameId: "youtube" }, b.authed)).status, 400);
  } finally {
    b.close();
  }
});

test("0.9.0 scenes and schedules: closing time, scheduled bingo with a countdown", async () => {
  const { dueNow, localNow, minusMinutes } = await import("./scenes.js");
  assert.deepEqual(localNow(new Date("2026-11-13T01:00:00Z"), "America/New_York"), { day: 4, time: "20:00", date: "2026-11-12" }, "Thursday 8 PM in New York");
  assert.equal(minusMinutes("20:00", 5), "19:55");
  assert.equal(minusMinutes("00:03", 5), undefined);
  const sch = { id: "bingo-8", kind: "game" as const, gameId: "bingo", days: [4], time: "20:00", displayIds: ["tv1"], countdownMinutes: 5, enabled: true };
  assert.deepEqual(dueNow([sch], new Date("2026-11-13T00:55:00Z"), "America/New_York", {}).countdown.map((s) => s.id), ["bingo-8"]);
  assert.deepEqual(dueNow([sch], new Date("2026-11-13T01:00:30Z"), "America/New_York", {}).start.map((s) => s.id), ["bingo-8"]);
  assert.equal(dueNow([sch], new Date("2026-11-13T01:00:30Z"), "America/New_York", { "bingo-8|start": "2026-11-12" }).start.length, 0, "once a day");

  const ended: string[] = [];
  const b = await boot((url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === "http://bingo/__bargames/status") return reply({ rooms: [{ code: "R1", kind: "venue", players: 3 }, { code: "R2", kind: "private", players: 2 }] });
    if (url === "http://bingo/__bargames/command") {
      if (body.command === "end") ended.push(body.roomCode);
      if (body.command === "create_room") return reply({ ok: true, data: { roomCode: "NEW" } });
      return reply({ ok: true });
    }
    return undefined;
  });
  try {
    const m = { ...bingo, sdk: { version: "0.9.0", level: 3 }, commands: ["create_room", "end"], events: ["room_closed"] };
    await b.json("POST", "/api/games/install", { manifest: m, devTarget: "http://bingo" }, b.authed);
    await b.json("PATCH", "/api/games/bingo", { enabled: true }, b.authed);
    await b.json("PUT", "/api/venue", { timezone: "America/New_York" }, b.authed);

    // Closing time from the preset.
    const list = (await (await b.json("GET", "/api/scenes", undefined, b.authed)).json()) as { scenes: unknown[]; presets: { id: string; actions: { displayId: string; do: string }[]; endRooms?: boolean }[] };
    const preset = list.presets[0];
    assert.equal(preset.id, "closing-time");
    assert.deepEqual(preset.actions.map((a) => [a.displayId, a.do]), [["tv1", "idle"], ["tv2", "idle"]]);
    assert.equal((await b.json("PUT", "/api/scenes/closing-time", preset, b.authed)).status, 200);
    assert.equal((await b.json("PUT", "/api/scenes/bad", { name: "x", actions: [{ displayId: "nope", do: "idle" }] }, b.authed)).status, 400);
    const applied = (await (await b.json("POST", "/api/scenes/closing-time/apply", undefined, b.authed)).json()) as { steps: { step: string; ok: boolean }[] };
    assert.deepEqual(ended, ["R1", "R2"], "every room ends, private ones too");
    assert.ok(applied.steps.some((s) => s.step === "announcement"));
    assert.equal(b.displays[0].content?.kind, "idle");
    assert.match(((await (await b.json("GET", "/api/announcement", undefined, b.authed)).json()) as { text: string }).text, /closing/i);

    // Scheduled bingo: countdown at 19:55, room on the TV at 20:00, once.
    assert.equal((await b.json("PUT", "/api/schedules/bingo-8", { kind: "game", gameId: "bingo", days: [4], time: "25:00", displayIds: ["tv1"] }, b.authed)).status, 400);
    assert.equal((await b.json("PUT", "/api/schedules/bingo-8", { kind: "game", gameId: "bingo", days: [4], time: "20:00", displayIds: ["tv1"], countdownMinutes: 5, title: "Thursday Bingo" }, b.authed)).status, 200);
    const run = b.app.locals.runSchedules as (now: Date) => Promise<void>;
    await run(new Date("2026-11-13T00:55:10Z"));
    assert.equal(((await (await b.json("GET", "/api/countdown", undefined, b.authed)).json()) as { label: string } | null)?.label, "Thursday Bingo starts in");
    const showsBefore = b.shows.length;
    await run(new Date("2026-11-13T01:00:10Z"));
    assert.equal(b.displays[0].content?.url, "http://bingo.localhost:7080/room/NEW?role=table");
    await run(new Date("2026-11-13T01:00:40Z"));
    assert.equal(b.shows.length, showsBefore + 1, "fires once");
    await run(new Date("2026-11-14T01:00:10Z"));
    assert.equal(b.shows.length, showsBefore + 1, "not on Friday");
  } finally {
    b.close();
  }
});

test("box self-update: the admin button only works with the host helper, one at a time", async () => {
  const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const b = await boot();
  try {
    assert.equal((await b.json("POST", "/api/system/update", { version: "0.9.1" }, b.authed)).status, 409, "no host helper yet");
    writeFileSync(path.join(b.dir, "host-hooks.json"), JSON.stringify({ reboot: true, update: true }));
    assert.equal((await b.json("POST", "/api/system/update", { version: "bad" }, b.authed)).status, 400);
    assert.equal((await b.json("POST", "/api/system/update", { version: "0.9.1" })).status, 401, "admin only");
    assert.equal((await b.json("POST", "/api/system/update", { version: "0.9.1" }, b.authed)).status, 200);
    assert.ok(existsSync(path.join(b.dir, "update.request")));
    assert.equal(readFileSync(path.join(b.dir, "update.request"), "utf8"), "0.9.1");
    assert.equal((await b.json("POST", "/api/system/update", {}, b.authed)).status, 409, "already running");
    const st = (await (await b.json("GET", "/api/system/stats", undefined, b.authed)).json()) as { update: { available: boolean; running: boolean } };
    assert.deepEqual([st.update.available, st.update.running], [true, true]);
  } finally {
    b.close();
  }
});
