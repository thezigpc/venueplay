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

async function boot(extraFetch?: (url: string, init?: RequestInit) => Response | undefined) {
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
    config: { gatewayToken: "gw", brokerUrl: "http://broker", brokerToken: "b", internalUrl: "http://core:7100", adminDist: path.join(dir, "none"), boxVersion: "0.5.0", opsToken: "ops-secret" },
    fetch: fakeFetch,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const cookie = (await json("POST", "/api/auth/setup", { password: "correct horse" })).headers.get("set-cookie")!.split(";")[0];
  return { json, base, authed: { cookie }, games, runtime, displays, shows, close: () => server.close() };
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
    assert.equal(cfg.hub.games.find((g) => g.id === "menu")?.kind, "display");
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
    if (url === raw) return reply(served);
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
    if (url === raw) return reply(bingo);
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
