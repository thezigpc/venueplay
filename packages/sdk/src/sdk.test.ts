import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { checkTheme, contrastRatio, DEFAULT_THEME, roomFromTableUrl, tableUrl, themeToCss, validateManifest, wifiQrPayload } from "./index.js";
import { createBarGames } from "./server.js";

const base = {
  id: "pool",
  name: "Pool",
  version: "1.0.0",
  image: "ghcr.io/x/pool:1.0.0",
  port: 3000,
  sdk: { version: "0.1.0", level: 2 },
  routes: { player: "/", table: "/room/{code}?role=table" },
  events: ["winner", "x-break"],
};

test("manifest: valid with defaults filled", () => {
  const r = validateManifest(base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.manifest.health, "/health");
  assert.deepEqual(r.manifest.sessionKinds, ["venue", "patron", "private"]);
  assert.equal(r.manifest.network.internet, false);
  assert.ok(r.warnings.some((w) => w.includes("digest")));
  assert.equal(tableUrl(r.manifest, "AB 12"), "/room/AB%2012?role=table");
});

test("manifest: rejects bad fields and reserved env", () => {
  const r = validateManifest({ ...base, id: "Pool!", port: 0, env: { BG_GAME_ID: "x" }, events: ["Bad Event"] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.startsWith("id")));
  assert.ok(r.errors.some((e) => e.startsWith("port")));
  assert.ok(r.errors.some((e) => e.includes("reserved")));
  assert.ok(r.errors.some((e) => e.includes("Bad Event")));
});

test("manifest: level 3 requires commands", () => {
  const r = validateManifest({ ...base, sdk: { version: "0.1.0", level: 3 } });
  assert.equal(r.ok, false);
});

test("theme: default passes contrast, bad theme flagged", () => {
  assert.deepEqual(checkTheme(DEFAULT_THEME), []);
  assert.ok(contrastRatio("#000000", "#ffffff") > 20);
  const bad = { ...DEFAULT_THEME, colors: { ...DEFAULT_THEME.colors, text: "#202640" } };
  assert.ok(checkTheme(bad).some((p) => p.startsWith("text on background")));
  assert.match(themeToCss(DEFAULT_THEME), /--venue-bg: #101528;/);
});

test("wifi QR payload escapes specials", () => {
  assert.equal(wifiQrPayload({ ssid: "Kava;Bar", password: "a:b" }), "WIFI:T:WPA;S:Kava\\;Bar;P:a\\:b;;");
  assert.equal(wifiQrPayload({ ssid: "Open" }), "WIFI:T:nopass;S:Open;;");
});

test("server sdk: standalone serves defaults and ignores emit", async () => {
  const bg = createBarGames({ gameId: "pool", defaultName: "Pool Night", coreUrl: "", token: "" });
  assert.equal(bg.connected, false);
  const ctx = await bg.venue();
  assert.equal(ctx.standalone, true);
  assert.equal(ctx.game.displayName, "Pool Night");
  bg.emit({ type: "winner" }); // no throw, no network

  // Box-only features stay invisible and inert off a box, and never touch the network.
  let fetched = false;
  const off = createBarGames({ gameId: "pool", coreUrl: "", token: "", fetch: (async () => ((fetched = true), new Response("{}"))) as typeof fetch });
  assert.deepEqual(await off.displays(), { enabled: false, pinRequired: false, displays: [] });
  assert.equal((await off.cast("ABCD", ["tv1"])).ok, false);
  assert.equal((await off.stopCast(["tv1"])).ok, false);
  let created = false;
  off.onCreateRoom(() => ((created = true), { roomCode: "X" }));
  const res = { statusCode: 0, writeHead(s: number) { this.statusCode = s; return this; }, setHeader() {}, end() {} };
  off.middleware()({ url: "/__bargames/command", method: "POST", headers: { authorization: "Bearer " } } as never, res as never);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(res.statusCode, 401, "nobody can create rooms through a standalone game");
  assert.equal(created, false);
  assert.equal(fetched, false);
});

test("server sdk: connected flow (venue, emit, command auth)", async () => {
  const received: unknown[] = [];
  const core = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer t0k") return void res.writeHead(401).end();
    if (req.url === "/internal/venue") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ protocol: 1, standalone: false, venue: { name: "Kava", theme: DEFAULT_THEME }, game: { id: "pool", displayName: "Kava Pool", theme: DEFAULT_THEME }, generatedAt: "" }));
    }
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => core.listen(0, "127.0.0.1", r));
  const coreUrl = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;

  const bg = createBarGames({ gameId: "pool", coreUrl, token: "t0k" });
  assert.equal((await bg.venue()).game.displayName, "Kava Pool");
  bg.emit({ type: "winner", roomCode: "ABCD", data: { name: "Sam" } });
  await bg.flush();
  assert.equal((received[0] as { type: string; gameId: string }).gameId, "pool");

  bg.onCommand("start", (req) => ({ ok: true, data: req.roomCode }));
  const game = createServer((req, res) => bg.middleware()(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((r) => game.listen(0, "127.0.0.1", r));
  const gameUrl = `http://127.0.0.1:${(game.address() as AddressInfo).port}`;

  const denied = await fetch(`${gameUrl}/__bargames/command`, { method: "POST", body: "{}" });
  assert.equal(denied.status, 401);
  const ok = await fetch(`${gameUrl}/__bargames/command`, {
    method: "POST",
    headers: { authorization: "Bearer t0k" },
    body: JSON.stringify({ command: "start", roomCode: "ABCD" }),
  });
  assert.deepEqual(await ok.json(), { ok: true, data: "ABCD" });
  const css = await fetch(`${gameUrl}/__bargames/theme.css`);
  assert.match(await css.text(), /--venue-primary/);

  // create_room: the helper wraps the result and turns a throw into a refusal.
  let full = false;
  bg.onCreateRoom(({ kind, title }) => {
    if (full) throw new Error("too many rooms");
    return { roomCode: `R-${kind}-${title ?? ""}`, hostUrl: "/host?key=k" };
  });
  const create = (args: unknown) =>
    fetch(`${gameUrl}/__bargames/command`, { method: "POST", headers: { authorization: "Bearer t0k" }, body: JSON.stringify({ command: "create_room", args }) }).then((r) => r.json());
  assert.deepEqual(await create({ kind: "venue", purpose: "display", title: "Fri" }), { ok: true, data: { roomCode: "R-venue-Fri", hostUrl: "/host?key=k" } });
  assert.deepEqual(await create(undefined), { ok: true, data: { roomCode: "R-venue-", hostUrl: "/host?key=k" } });
  full = true;
  assert.deepEqual(await create({ kind: "venue" }), { ok: false, message: "too many rooms" });

  core.close();
  game.close();
});

test("server sdk: gateway headers are trusted only on a box", () => {
  const req = (headers: Record<string, string>) =>
    ({ headers, socket: { remoteAddress: "10.0.0.9" } }) as unknown as import("node:http").IncomingMessage;
  const spoof = { "x-bargames-via": "1", "x-bargames-client-ip": "6.6.6.6", "x-bargames-access": "pin" };

  const standalone = createBarGames({ gameId: "pool", coreUrl: "", token: "" });
  assert.equal(standalone.clientIp(req(spoof)), "10.0.0.9", "standalone ignores spoofable gateway headers");
  assert.equal(standalone.gateway(req(spoof)).viaGateway, false);
  assert.equal(standalone.clientIp(req({ "cf-connecting-ip": "203.0.113.5" })), "203.0.113.5", "standalone keeps the old cf-connecting-ip behavior");

  const onBox = createBarGames({ gameId: "pool", coreUrl: "http://core", token: "t" });
  assert.equal(onBox.clientIp(req(spoof)), "6.6.6.6");
  assert.deepEqual(onBox.gateway(req(spoof)), { viaGateway: true, clientIp: "6.6.6.6", access: "pin" });
});

test("client sdk: standalone context never restyles the game", async () => {
  const { applyTheme, isOnBox, gameName } = await import("./client.js");
  const { standaloneContext } = await import("./context.js");
  const set: string[] = [];
  const root = { style: { setProperty: (k: string) => set.push(k) } } as unknown as HTMLElement;
  const ctx = standaloneContext("pool", "Pool");
  applyTheme(ctx, { root });
  applyTheme(null, { root });
  assert.equal(set.length, 0);
  assert.equal(isOnBox(ctx), false);
  assert.equal(gameName(ctx, "8-Ball Night"), "8-Ball Night");
  applyTheme({ ...ctx, standalone: false }, { root });
  assert.ok(set.includes("--venue-bg"));
});

test("mock-box: fake TVs answer displays/cast/stopCast like the real box", async () => {
  const { mockBox, DEV_TOKEN } = await import("./devbox.js");
  const game = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ rooms: [{ code: "ABCD", kind: "venue", players: 0 }] }));
  });
  await new Promise<void>((r) => game.listen(0, "127.0.0.1", r));
  const manifest = validateManifest({ ...base, sdk: { version: "0.2.1", level: 2 } });
  assert.ok(manifest.ok);
  const log = console.log;
  console.log = () => {};
  const box = mockBox({ gameId: "pool", displayName: "Pool (mock)", gameUrl: `http://127.0.0.1:${(game.address() as AddressInfo).port}`, corePort: 0, gatewayPort: 0, manifest: manifest.manifest, tvPin: "4321" });
  try {
    await new Promise((r) => box.core.once("listening", r));
    const bg = createBarGames({ gameId: "pool", coreUrl: `http://127.0.0.1:${(box.core.address() as AddressInfo).port}`, token: DEV_TOKEN });
    const tvs = await bg.displays();
    assert.equal(tvs.enabled, true);
    assert.equal(tvs.pinRequired, true);
    assert.deepEqual(tvs.displays.map((d) => d.id), ["fake-bar", "fake-patio"]);
    assert.match(String((await bg.cast("ABCD", ["fake-bar"])).message), /PIN required/);
    assert.match(String((await bg.cast("ABCD", ["fake-bar"], { pin: "0000" })).message), /wrong/);
    assert.match(String((await bg.cast("NOPE", ["fake-bar"], { pin: "4321" })).message), /no room/);
    assert.equal((await bg.cast("ABCD", ["fake-bar"], { pin: "4321" })).ok, true);
    const after = (await bg.displays()).displays.find((d) => d.id === "fake-bar");
    assert.deepEqual([after?.showingThisGame, after?.roomCode], [true, "ABCD"]);
    assert.equal((await bg.stopCast(["fake-bar"], { pin: "4321" })).ok, true);
    assert.equal(box.showing.size, 0);
  } finally {
    console.log = log;
    box.core.close();
    box.gateway.close();
    game.close();
  }
});

test("manifest: claim commands are standard", async () => {
  const { STANDARD_COMMANDS } = await import("./protocol.js");
  assert.ok(STANDARD_COMMANDS.includes("confirm_claim") && STANDARD_COMMANDS.includes("reject_claim"));
  const r = validateManifest({ ...base, sdk: { version: "0.2.1", level: 3 }, commands: ["confirm_claim", "reject_claim"] });
  assert.equal(r.ok, true);
});

test("manifest: roomFromTableUrl reverses tableUrl", () => {
  const m = { routes: { player: "/", table: "/join/{code}?as=table" } };
  assert.equal(roomFromTableUrl(m, "/join/AB%20C?as=table"), "AB C");
  assert.equal(roomFromTableUrl(m, "/join/ABCD?as=player"), undefined);
  assert.equal(roomFromTableUrl(m, "/join/A/B?as=table"), undefined);
  assert.equal(roomFromTableUrl({ routes: { player: "/", table: "/table?code={code}" } }, "/table?code=XY"), "XY");
});
