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
  const seenArgs: unknown[] = [];
  bg.onCreateRoom((args) => {
    seenArgs.push(args);
    if (full) throw new Error("too many rooms");
    return { roomCode: `R-${args.kind}-${args.title ?? ""}`, hostUrl: "/host?key=k" };
  });
  const create = (args: unknown) =>
    fetch(`${gameUrl}/__bargames/command`, { method: "POST", headers: { authorization: "Bearer t0k" }, body: JSON.stringify({ command: "create_room", args }) }).then((r) => r.json());
  assert.deepEqual(await create({ kind: "venue", purpose: "display", title: "Fri" }), { ok: true, data: { roomCode: "R-venue-Fri", hostUrl: "/host?key=k" } });
  assert.deepEqual(await create(undefined), { ok: true, data: { roomCode: "R-venue-", hostUrl: "/host?key=k" } });
  // SDK 0.7.1: the box's "first joiner hosts" flag reaches the game (0.7.0 dropped it).
  await create({ kind: "venue", purpose: "display", firstJoinerHosts: true });
  assert.equal((seenArgs.at(-1) as { firstJoinerHosts?: boolean }).firstJoinerHosts, true);
  await create({ kind: "venue", firstJoinerHosts: "yes" });
  assert.equal((seenArgs.at(-1) as { firstJoinerHosts?: boolean }).firstJoinerHosts, undefined, "only a real true counts");
  full = true;
  assert.deepEqual(await create({ kind: "venue" }), { ok: false, message: "too many rooms" });

  core.close();
  game.close();
});

test("server sdk: gateway headers are trusted only on a box", async () => {
  const req = (headers: Record<string, string>) =>
    ({ headers, socket: { remoteAddress: "10.0.0.9" } }) as unknown as import("node:http").IncomingMessage;
  const spoof = { "x-bargames-via": "1", "x-bargames-client-ip": "6.6.6.6", "x-bargames-access": "pin" };

  const standalone = createBarGames({ gameId: "pool", coreUrl: "", token: "" });
  assert.equal(standalone.clientIp(req(spoof)), "10.0.0.9", "standalone ignores spoofable gateway headers");
  assert.equal(standalone.gateway(req(spoof)).viaGateway, false);
  assert.equal(standalone.clientIp(req({ "cf-connecting-ip": "203.0.113.5" })), "203.0.113.5", "standalone keeps the old cf-connecting-ip behavior");

  const onBox = createBarGames({ gameId: "pool", coreUrl: "http://core", token: "t" });
  assert.equal(onBox.clientIp(req(spoof)), "6.6.6.6");
  assert.deepEqual(onBox.gateway(req(spoof)), { viaGateway: true, clientIp: "6.6.6.6", access: "pin", staff: false });
  // Staff (SDK 0.7.0): only from the gateway, only on a box.
  const staff = { ...spoof, "x-bargames-staff": "1" };
  assert.equal(onBox.isStaff(req(staff)), true);
  assert.equal(onBox.isStaff(req({ "x-bargames-staff": "1" })), false, "not via the gateway");
  assert.equal(standalone.isStaff(req(staff)), false, "standalone never trusts it");
  assert.equal(await standalone.checkVenuePassword("anything"), false, "standalone: never the box password");
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
    assert.deepEqual(tvs.displays.map((d) => d.id), ["fake-bar", "fake-patio", "fake-unpaired"]);
    const unpaired = await bg.cast("ABCD", ["fake-unpaired"], { pin: "4321" });
    assert.equal(unpaired.results?.["fake-unpaired"]?.needsCode, true);
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

test("server sdk: publicUrl follows the box's address, undefined standalone", async () => {
  const off = createBarGames({ gameId: "pool", coreUrl: "", token: "" });
  assert.equal(await off.publicUrl("/join/AB"), undefined);
  const ctx = { protocol: 1, standalone: false, venue: { name: "V", theme: DEFAULT_THEME }, game: { id: "pool", displayName: "P", theme: DEFAULT_THEME, publicUrl: "https://billiards.kava.example" }, generatedAt: "" };
  const on = createBarGames({ gameId: "pool", coreUrl: "http://core", token: "t", fetch: (async () => new Response(JSON.stringify(ctx))) as typeof fetch });
  assert.equal(await on.publicUrl("/join/AB"), "https://billiards.kava.example/join/AB");
});

test("client sdk: tableMode is inert standalone, hides the pointer and shows banners on a box", async () => {
  const { tableMode, isSharedScreen } = await import("./client.js");
  const { standaloneContext } = await import("./context.js");
  const added: { id?: string; hidden?: boolean; textContent?: string; dataset: Record<string, string>; remove(): void }[] = [];
  const el = () => {
    const e = { hidden: false, textContent: "", dataset: {} as Record<string, string>, remove: () => void added.splice(added.indexOf(e), 1) } as (typeof added)[number];
    return e;
  };
  const attrs = new Map<string, string>();
  const doc = {
    visibilityState: "hidden",
    documentElement: { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) },
    createElement: el,
    head: { appendChild: (e: (typeof added)[number]) => added.push(e) },
    body: { appendChild: (e: (typeof added)[number]) => added.push(e) },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Document;
  const ctx = standaloneContext("pool", "Pool");
  tableMode(ctx, { doc }).setState("closed");
  assert.equal(added.length, 0, "standalone: nothing added");

  assert.equal(isSharedScreen(doc), false, "standalone: not marked");
  const tm = tableMode({ ...ctx, standalone: false }, { doc });
  assert.equal(isSharedScreen(doc), true, "on a box the TV page is marked shared");
  assert.equal(added.length, 2);
  assert.match(String(added[0].textContent), /cursor:none/);
  tm.setState("reconnecting");
  assert.deepEqual([added[1].hidden, added[1].textContent], [false, "Reconnecting…"]);
  tm.setState("connected");
  assert.equal(added[1].hidden, true);
  tm.stop();
  assert.equal(added.length, 0, "stop removes everything");
  assert.equal(isSharedScreen(doc), false, "stop unmarks the page");
});

test("manifest: roomFromTableUrl reverses tableUrl", () => {
  const m = { routes: { player: "/", table: "/join/{code}?as=table" } };
  assert.equal(roomFromTableUrl(m, "/join/AB%20C?as=table"), "AB C");
  assert.equal(roomFromTableUrl(m, "/join/ABCD?as=player"), undefined);
  assert.equal(roomFromTableUrl(m, "/join/A/B?as=table"), undefined);
  assert.equal(roomFromTableUrl({ routes: { player: "/", table: "/table?code={code}" } }, "/table?code=XY"), "XY");
});

// ---------------------------------------------------------------- 0.4.0: games list, also playing, announcements

const boxCtx = (venue: Record<string, unknown> = {}) => ({
  protocol: 1,
  standalone: false,
  venue: { name: "V", theme: DEFAULT_THEME, playUrl: "https://play.kava.example", ...venue },
  game: { id: "pool", displayName: "Pool", theme: DEFAULT_THEME, publicUrl: "https://pool.kava.example" },
  generatedAt: "",
});

test("links: games list, other games and announcements only on a box", async () => {
  const { gamesListUrl, otherGames, activeAnnouncement, gamesLinkHtml } = await import("./links.js");
  const { standaloneContext } = await import("./context.js");
  const off = standaloneContext("pool", "Pool");
  assert.equal(gamesListUrl(off), undefined);
  assert.deepEqual(otherGames(off), []);
  assert.equal(gamesLinkHtml(off), "");
  assert.equal(gamesLinkHtml(null), "");

  const games = [
    { id: "pool", displayName: "Pool", url: "https://pool.kava.example" },
    { id: "bingo", displayName: "Kava <Bingo>", url: "https://bingo.kava.example" },
  ];
  const on = boxCtx({ games, announcement: { id: "a1", text: "Last call", until: "2026-01-01T02:00:00Z" } });
  assert.equal(gamesListUrl(on), "https://play.kava.example");
  assert.deepEqual(otherGames(on).map((g) => g.id), ["bingo"]);
  const html = gamesLinkHtml(on);
  assert.match(html, /href="https:\/\/play\.kava\.example"/);
  assert.match(html, /Also playing: <a href="https:\/\/bingo\.kava\.example">Kava &lt;Bingo&gt;<\/a>/);
  assert.doesNotMatch(gamesLinkHtml(on, { alsoPlaying: false }), /Also playing/);
  assert.equal(activeAnnouncement(on, Date.parse("2026-01-01T01:00:00Z"))?.text, "Last call");
  assert.equal(activeAnnouncement(on, Date.parse("2026-01-01T03:00:00Z")), undefined, "expired");
});

test("links: a 0.3.0-era box context (no games, no announcement) still works", async () => {
  const { gamesListUrl, otherGames, activeAnnouncement, gamesLinkHtml } = await import("./links.js");
  const old = boxCtx();
  assert.equal(gamesListUrl(old), "https://play.kava.example");
  assert.deepEqual(otherGames(old), []);
  assert.equal(activeAnnouncement(old), undefined);
  assert.doesNotMatch(gamesLinkHtml(old), /Also playing/);
  assert.equal(gamesLinkHtml(boxCtx({ playUrl: undefined })), "", "no games list address: no link");
});

function fakeDoc() {
  type El = { id?: string; className?: string; hidden: boolean; textContent: string; innerHTML: string; dataset: Record<string, string>; children: El[]; attrs: Record<string, string>; onclick?: () => void; type?: string; remove(): void; appendChild(e: El): void; setAttribute(k: string, v: string): void };
  const added: El[] = [];
  const el = (): El => {
    const e: El = {
      hidden: false,
      textContent: "",
      innerHTML: "",
      dataset: {},
      children: [],
      attrs: {},
      remove: () => void (added.includes(e) && added.splice(added.indexOf(e), 1)),
      appendChild: (c: El) => void e.children.push(c),
      setAttribute: (k, v) => void (e.attrs[k] = v),
    };
    Object.defineProperty(e, "textContent", { get: () => e.attrs._text ?? "", set: (v: string) => ((e.attrs._text = v), (e.children = [])) });
    return e;
  };
  const vars = new Map<string, string>();
  const doc = { createElement: el, head: { appendChild: (e: El) => added.push(e) }, body: { appendChild: (e: El) => added.push(e) }, documentElement: { style: { setProperty: (k: string, v: string) => void vars.set(k, v) } } } as unknown as Document;
  return { doc, added, vars };
}

test("client sdk: gamesLink adds nothing standalone, renders and updates on a box", async () => {
  const { gamesLink } = await import("./client.js");
  const { standaloneContext } = await import("./context.js");
  const { doc, added } = fakeDoc();
  gamesLink(standaloneContext("pool", "Pool"), { doc });
  assert.equal(added.length, 0);
  const ctl = gamesLink(boxCtx(), { doc });
  assert.equal(added.length, 2, "style + nav");
  const nav = added[1];
  assert.match(nav.innerHTML, /All games/);
  ctl.update(boxCtx({ games: [{ id: "bingo", displayName: "Bingo", url: "https://b" }] }));
  assert.match(nav.innerHTML, /Also playing/);
  ctl.update(null);
  assert.equal(nav.hidden, true);
  ctl.remove();
  assert.equal(added.length, 0);
});

test("client sdk: announcementBanner shows, dismisses per message, and follows updates", async () => {
  const { announcementBanner } = await import("./client.js");
  const { doc, added } = fakeDoc();
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const ctl = announcementBanner(boxCtx(), { doc, storage });
  assert.equal(added.length, 0, "no announcement: nothing");
  ctl.update(boxCtx({ announcement: { id: "a1", text: "Last call at 1:30" } }));
  const bar = added[1];
  assert.equal(bar.hidden, false);
  assert.equal(bar.textContent, "Last call at 1:30");
  bar.children[0].onclick!();
  assert.equal(bar.hidden, true);
  ctl.update(boxCtx({ announcement: { id: "a1", text: "Last call at 1:30" } }));
  assert.equal(bar.hidden, true, "same message stays dismissed");
  ctl.update(boxCtx({ announcement: { id: "a2", text: "Trivia at 9" } }));
  assert.equal(bar.hidden, false, "a new message shows again");
  ctl.remove();
  assert.equal(added.length, 0);
});

test("mock box: venue context carries the games list, a second game and the announcement", async () => {
  const { mockContext, MOCK_GAMES_PATH } = await import("./devbox.js");
  const ctx = mockContext("pool", "Pool (mock)", "http://localhost:7080", { announcement: "Hi" });
  assert.equal(ctx.venue.playUrl, `http://localhost:7080${MOCK_GAMES_PATH}`);
  assert.deepEqual(ctx.venue.games?.map((g) => g.id), ["pool", "other-game"]);
  assert.equal(ctx.venue.announcement?.text, "Hi");
  assert.equal(mockContext("pool", "P", "http://localhost:7080").venue.announcement, undefined);
  // 0.11.1: a pretend box admin and the announcement's placement.
  assert.equal(ctx.venue.adminUrl, "http://localhost:7080/__bargames/dev/admin");
  const placed = mockContext("pool", "P", "http://localhost:7080", { announcement: "Hi", announcementShow: "tvs", announcementPosition: "bottom" });
  assert.deepEqual([placed.venue.announcement?.show, placed.venue.announcement?.position], ["tvs", "bottom"]);
});

// ---------------------------------------------------------------- 0.5.0: display modules, venue location, on-primary

test("manifest: apps (SDK 0.6.0) have no rooms; \"display\" still works and reads as app; games are the default", async () => {
  const { isApp, isDisplayModule } = await import("./manifest.js");
  const g = validateManifest(base);
  assert.ok(g.ok && g.manifest.kind === "game" && !isApp(g.manifest));
  const a = validateManifest({ ...base, kind: "app", sdk: { version: "0.6.0", level: 1 }, routes: { player: "/", table: "/tv" }, events: [] });
  assert.ok(a.ok, JSON.stringify(a));
  if (a.ok) {
    assert.equal(a.manifest.kind, "app");
    assert.deepEqual(a.manifest.sessionKinds, []);
    assert.ok(isApp(a.manifest));
  }
  const d = validateManifest({ ...base, kind: "display", sdk: { version: "0.5.0", level: 1 }, routes: { player: "/", table: "/tv" }, events: [] });
  assert.ok(d.ok && d.manifest.kind === "app", "0.5.0 display modules are apps");
  assert.ok(d.warnings.some((w) => w.includes('"display" is now "app"')));
  assert.ok(isApp({ kind: "display" }) && isDisplayModule({ kind: "app" }), "a manifest saved by a 0.5.0 box still counts");
  const noTv = validateManifest({ ...base, kind: "app", routes: { player: "/" }, events: [] });
  assert.ok(noTv.ok && noTv.warnings.some((w) => w.startsWith("routes.table: no TV view")), "an app without a TV view is fine, with a note");
  const code = validateManifest({ ...base, kind: "app", routes: { player: "/", table: "/tv/{code}" } });
  assert.ok(!code.ok && code.errors.some((e) => e.includes("{code}")));
  const bad = validateManifest({ ...base, kind: "kiosk" });
  assert.ok(!bad.ok && bad.errors.some((e) => e.startsWith("kind")));
});

test("theme: --venue-on-primary picks a readable ink unless the venue set one", async () => {
  const { onPrimary, themeCssVars } = await import("./theme.js");
  assert.equal(onPrimary({ primary: "#f2b33d" }), "#111111");
  assert.equal(onPrimary({ primary: "#1a237e" }), "#ffffff");
  assert.equal(onPrimary({ primary: "#1a237e", onPrimary: "#ffeb3b" }), "#ffeb3b");
  assert.equal(themeCssVars(DEFAULT_THEME)["--venue-on-primary"], "#111111");
  const t = { ...DEFAULT_THEME, colors: { ...DEFAULT_THEME.colors, onPrimary: "#f2b33d" } };
  assert.ok(checkTheme(t).some((p) => p.startsWith("onPrimary on primary")), "unreadable onPrimary is flagged");
  assert.deepEqual(checkTheme(DEFAULT_THEME), [], "no onPrimary: nothing to check");
});

test("devbox: mock context carries location, time zone, units; display modules list under modules", async () => {
  const { mockContext } = await import("./devbox.js");
  const { otherGames } = await import("./links.js");
  const g = mockContext("menu", "Menu", "http://localhost:7080");
  assert.equal(g.venue.timezone, "America/New_York");
  assert.equal(g.venue.units, "imperial");
  assert.equal(typeof g.venue.location?.latitude, "number");
  const d = mockContext("menu", "Menu", "http://localhost:7080", { app: true });
  assert.deepEqual(d.venue.apps?.map((m) => m.id), ["menu"]);
  assert.deepEqual(d.venue.modules?.map((m) => m.id), ["menu"], "0.5.0 name, same list");
  assert.ok(!d.venue.games?.some((x) => x.id === "menu"), "a display module is not in the game lineup");
  assert.deepEqual(otherGames(d).map((x) => x.id), ["other-game"]);
});

test("0.9.0: off a box the new calls do nothing; on the mock box they work; manifest media", async () => {
  const { mockBox, DEV_TOKEN } = await import("./devbox.js");
  const { activeCountdown, formatCountdown } = await import("./links.js");
  // Off a box: inert (rule 1).
  const off = createBarGames({ gameId: "yt", coreUrl: "", token: "" });
  await off.setAttention([{ level: "warn", message: "x" }]);
  assert.equal(await off.startCountdown({ label: "x", minutes: 1 }), undefined);
  assert.deepEqual(await off.tvs(), []);
  assert.equal((await off.launchApp("tv", "youtube")).ok, false);
  assert.equal(await off.profile({} as import("node:http").IncomingMessage), undefined);
  assert.deepEqual(await off.audioOutputs(), []);
  assert.deepEqual(await off.playSound("ding"), { ok: false, reason: "standalone" });

  // Manifest: media needs level 3 (warning), launch names are checked.
  const m = validateManifest({ ...base, kind: "app", sdk: { version: "0.9.0", level: 3 }, routes: { player: "/" }, commands: ["media_list", "media_play", "media_stop"], media: { launch: ["youtube"] } });
  assert.ok(m.ok && m.manifest.media?.launch[0] === "youtube");
  assert.ok(!validateManifest({ ...base, media: { launch: ["You Tube!"] } }).ok);
  assert.ok((validateManifest({ ...base, sdk: { version: "0.9.0", level: 1 }, media: { launch: ["youtube"] } }) as { warnings: string[] }).warnings.some((w) => w.startsWith("media:")));

  // On the mock box.
  const game = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((r) => game.listen(0, "127.0.0.1", r));
  const box = mockBox({ gameId: "yt", displayName: "YouTube (mock)", gameUrl: `http://127.0.0.1:${(game.address() as AddressInfo).port}`, corePort: 0, gatewayPort: 0, manifest: m.ok ? m.manifest : undefined });
  await new Promise((r) => box.core.once("listening", r));
  const bg = createBarGames({ gameId: "yt", coreUrl: `http://127.0.0.1:${(box.core.address() as AddressInfo).port}`, token: DEV_TOKEN });
  const log = console.log;
  console.log = () => undefined;
  try {
    const tvs = await bg.tvs();
    assert.deepEqual(tvs[0].canLaunch, ["youtube"]);
    assert.equal(tvs[0].youtubeScreenId, "fake-screen-id-bar");
    assert.equal(tvs[0].activeApp, "home", "0.10.4: the fake Roku starts on its home screen");
    assert.deepEqual(await bg.launchApp(tvs[0].id, "youtube"), { ok: true });
    assert.equal((await bg.tvs())[0].activeApp, "youtube", "and shows the app after a launch");
    assert.equal((await bg.launchApp(tvs[0].id, "netflix")).ok, false);
    const cd = await bg.startCountdown({ label: "Trivia starts in", minutes: 5 });
    assert.equal(cd?.label, "Trivia starts in");
    const ctx = await (await fetch(`http://127.0.0.1:${(box.core.address() as AddressInfo).port}/internal/venue`, { headers: { authorization: `Bearer ${DEV_TOKEN}` } })).json();
    const live = activeCountdown(ctx);
    assert.ok(live && live.secondsLeft > 290 && live.secondsLeft <= 300);
    assert.equal(formatCountdown(245), "4:05");
    await bg.reportResults({ results: [{ player: { name: "Ann" }, place: 1 }] });
    await bg.setAttention([]);
  } finally {
    console.log = log;
    box.core.close();
    box.gateway.close();
    game.close();
  }
});

test("0.10.0: base path helpers, manifest routing, publicUrl keeps the prefix", async () => {
  const { normalizeBasePath, injectBasePath, joinUrl, basePath, bgUrl, socketIoPath, basePathFromEnv } = await import("./base.js");
  assert.equal(normalizeBasePath("bingo/"), "/bingo");
  assert.equal(normalizeBasePath("/a/b//"), "/a/b");
  assert.equal(normalizeBasePath("/"), "");
  assert.equal(normalizeBasePath(undefined), "");
  assert.equal(normalizeBasePath('/x"><script>'), "");
  assert.equal(basePathFromEnv({ BASE_PATH: "/pool" }), "/pool");
  assert.equal(basePathFromEnv({ BG_BASE_PATH: "/bingo", BASE_PATH: "/pool" }), "/bingo");
  assert.equal(basePathFromEnv({}), "");

  const html = "<!doctype html><html><head><title>x</title></head></html>";
  assert.equal(injectBasePath(html, ""), html.replace("<head>", '<head><base href="/">'), "root: <base href=/> so deep links find relative assets");
  assert.equal(injectBasePath('<html><head><base href="/x/"></head></html>', ""), '<html><head><base href="/x/"></head></html>', "the page's own <base> stays");
  assert.equal(injectBasePath(injectBasePath(html, ""), ""), injectBasePath(html, ""));
  const once = injectBasePath(html, "/bingo");
  assert.ok(once.includes('<head><meta name="bargames-base" content="/bingo"><base href="/bingo/">'));
  assert.equal(injectBasePath(once, "/bingo"), once);

  assert.equal(joinUrl("https://v.example.com/bingo", "/join/AB"), "https://v.example.com/bingo/join/AB");
  assert.equal(joinUrl("https://v.example.com/", "/join/AB"), "https://v.example.com/join/AB");
  assert.equal(joinUrl("https://v.example.com/bingo/", "/"), "https://v.example.com/bingo/");

  const fakeDoc = (content?: string) => ({ querySelector: () => (content === undefined ? null : { getAttribute: () => content }) }) as unknown as Document;
  assert.equal(basePath(fakeDoc("/bingo")), "/bingo");
  assert.equal(bgUrl("/api/rooms", fakeDoc("/bingo")), "/bingo/api/rooms");
  assert.equal(bgUrl("//cdn.example/x", fakeDoc("/bingo")), "//cdn.example/x");
  assert.equal(bgUrl("/api/rooms", fakeDoc()), "/api/rooms");
  assert.equal(socketIoPath(fakeDoc("/bingo")), "/bingo/socket.io");
  assert.equal(basePath(), ""); // no document in Node
  const { joinUrl: clientJoin } = await import("./client.js");
  assert.equal(clientJoin({ game: { publicUrl: "https://v.example.com/bingo" } } as never, "/join/AB"), "https://v.example.com/bingo/join/AB");

  const m = validateManifest({ ...base, routing: { basePath: true } });
  assert.ok(m.ok && m.manifest.routing?.basePath === true);
  assert.ok(!validateManifest({ ...base, routing: { basePath: "yes" } }).ok);
  assert.ok(validateManifest(base).ok && !(validateManifest(base) as { manifest: { routing?: unknown } }).manifest.routing);
});

test("0.10.0: the mock box serves a game under a prefix (strip, redirect, Location, publicUrl)", async () => {
  const { mockBox, DEV_TOKEN } = await import("./devbox.js");
  const seen: string[] = [];
  const game = createServer((req, res) => {
    seen.push(req.url ?? "");
    if (req.url === "/old") return void res.writeHead(302, { location: "/new" }).end();
    res.end("ok");
  });
  await new Promise<void>((r) => game.listen(0, "127.0.0.1", r));
  const box = mockBox({ gameId: "pool", displayName: "Pool (mock)", gameUrl: `http://127.0.0.1:${(game.address() as AddressInfo).port}`, corePort: 0, gatewayPort: 0, basePath: "pool/" });
  await Promise.all([new Promise((r) => box.core.once("listening", r)), new Promise((r) => box.gateway.once("listening", r))]);
  const gw = `http://127.0.0.1:${(box.gateway.address() as AddressInfo).port}`;
  try {
    assert.ok(box.publicUrl.endsWith("/pool"));
    let r = await fetch(`${gw}/pool/api/x?y=1`);
    assert.equal(await r.text(), "ok");
    assert.equal(seen.at(-1), "/api/x?y=1");
    r = await fetch(`${gw}/`, { redirect: "manual" });
    assert.equal(r.headers.get("location"), "/pool/");
    r = await fetch(`${gw}/pool?a=1`, { redirect: "manual" });
    assert.equal(r.headers.get("location"), "/pool/?a=1");
    r = await fetch(`${gw}/other/thing`);
    assert.equal(r.status, 404);
    r = await fetch(`${gw}/pool/old`, { redirect: "manual" });
    assert.equal(r.headers.get("location"), "/pool/new");
    const log = console.log;
    console.log = () => undefined;
    try {
      r = await fetch(`${gw}/pool/__bargames/staff?next=/admin`, { redirect: "manual" });
      assert.equal(r.headers.get("location"), "/pool/admin");
      r = await fetch(`${gw}/__bargames/staff?next=/pool/admin`, { redirect: "manual" });
      assert.equal(r.headers.get("location"), "/pool/admin");
    } finally {
      console.log = log;
    }

    const bg = createBarGames({ gameId: "pool", coreUrl: `http://127.0.0.1:${(box.core.address() as AddressInfo).port}`, token: DEV_TOKEN });
    assert.equal(await bg.publicUrl("/join/ABCD"), `${box.publicUrl}/join/ABCD`);
    assert.equal((await bg.venue()).game.basePath, "/pool");
  } finally {
    box.core.close();
    box.gateway.close();
    game.close();
  }
});

test("0.11.0: announcement where/position, boxAdminUrl, and watchVenue follows a held venue.json", async () => {
  const { announcementBanner, watchVenue, boxAdminUrl } = await import("./client.js");
  const { doc, added, vars } = fakeDoc();
  const ctl = announcementBanner(boxCtx({ announcement: { id: "b1", text: "TVs only", show: "tvs", position: "bottom" } }), { doc });
  const bar = added[1];
  assert.deepEqual([bar.dataset.show, bar.dataset.position], ["tvs", "bottom"]);
  // 0.11.2: a bottom strip publishes its height for games' bottom-fixed bars.
  (bar as unknown as { offsetHeight: number }).offsetHeight = 44;
  ctl.update(boxCtx({ announcement: { id: "b1", text: "TVs only", show: "tvs", position: "bottom" } }));
  assert.equal(vars.get("--bargames-announcement-bottom"), "44px");
  ctl.update(boxCtx({ announcement: { id: "b2", text: "Plain" } }));
  assert.deepEqual([bar.dataset.show, bar.dataset.position], ["everywhere", "top"], "defaults");
  assert.equal(vars.get("--bargames-announcement-bottom"), "0px", "a top strip: 0px at the bottom");
  assert.equal(vars.get("--bargames-announcement-top"), "44px", "0.11.3: and its height at the top");
  ctl.remove();
  assert.equal(boxAdminUrl(boxCtx({ adminUrl: "https://play.example.com/admin" })), "https://play.example.com/admin");
  assert.equal(boxAdminUrl(null), undefined);

  // A gateway that holds ?wait=<tag>: the change arrives without waiting out intervalMs.
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  let version = 1;
  const ctxV = () => boxCtx({ announcement: version > 1 ? { id: "n", text: "New" } : undefined });
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    if (String(url).includes("wait=v1")) {
      await new Promise((r) => setTimeout(r, 50));
      version = 2;
    }
    return new Response(JSON.stringify(ctxV()), { headers: { "x-bargames-etag": `v${version}`, "x-bargames-wait": "1" } });
  }) as typeof fetch;
  try {
    const seen: (string | undefined)[] = [];
    const stop = watchVenue((c) => seen.push(c.venue.announcement?.text), { intervalMs: 60_000, base: "http://box.test" });
    await new Promise((r) => setTimeout(r, 1500));
    stop();
    assert.deepEqual(seen, [undefined, "New"], "the change arrived in well under intervalMs");
    assert.ok(asked.some((u) => u.includes("?wait=v1")), "held requests carry the last tag");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("integration helper against the mock box: catalog, permissions, scenes, TV power, stream", async () => {
  const { createIntegration } = await import("./integration.js");
  const { mockBox, DEV_TOKEN } = await import("./devbox.js");
  const m = validateManifest({ id: "ha", name: "HA", kind: "integration", version: "0.1.0", image: "x/ha:0.1.0", sdk: { version: "0.12.0", level: 0 }, integration: { permissions: ["scenes", "events"] } });
  assert.ok(m.ok);
  const box = mockBox({ gameId: "ha", displayName: "HA (mock)", gameUrl: "http://127.0.0.1:9", corePort: 0, gatewayPort: 0, manifest: m.ok ? m.manifest : undefined });
  await new Promise((r) => box.core.once("listening", r));
  const log = console.log;
  console.log = () => undefined;
  try {
    const it = createIntegration({ coreUrl: `http://127.0.0.1:${(box.core.address() as AddressInfo).port}`, token: DEV_TOKEN });
    const cat = await it.catalog();
    assert.deepEqual(cat.permissions, ["events", "scenes"]);
    assert.equal(cat.tvs, undefined, "no tvs permission");
    assert.equal((await it.runScene("bingo-night")).ok, true);
    await assert.rejects(it.tvPower("fake-bar", true), /hasn't allowed "tvs"/);
    assert.deepEqual(await it.report({ state: "ok", message: "fine" }), { ok: true });
    const first = await new Promise<number>((resolve) => {
      const stop = it.connect({ onCatalog: (c) => (stop(), resolve(c.scenes?.length ?? 0)) });
    });
    assert.equal(first, 3);
    // Off a box: nothing to call.
    const off = createIntegration({ coreUrl: "", token: "" });
    assert.equal(off.onBox, false);
    await assert.rejects(off.catalog(), /not running on a Bar Games box/);
  } finally {
    console.log = log;
    box.core.close();
    box.gateway.close();
  }
});

test("audio against the mock box: outputs, play (file fetched with the app's token), pause, volume, end; playSound off a box", async () => {
  const { createAudio } = await import("./audio.js");
  const { mockBox, DEV_TOKEN } = await import("./devbox.js");
  const { createBarGames } = await import("./server.js");
  const fetched: { path: string; auth?: string; marker?: string }[] = [];
  const game = createServer((req, res) => {
    fetched.push({ path: req.url ?? "", auth: req.headers.authorization, marker: String(req.headers["x-bargames-audio"] ?? "") });
    if (req.url === "/tracks/1.mp3") return void res.writeHead(200, { "content-type": "audio/mpeg" }).end("ID3");
    res.writeHead(404).end();
  }).listen(0);
  await new Promise((r) => game.once("listening", r));
  const m = validateManifest({ id: "music", name: "Music", kind: "app", version: "0.1.0", image: "x/music:0.1.0", port: 3009, sdk: { version: "0.13.0", level: 1 }, routes: { player: "/" }, audio: { play: true } });
  assert.ok(m.ok);
  const box = mockBox({ gameId: "music", displayName: "Music (mock)", gameUrl: `http://127.0.0.1:${(game.address() as AddressInfo).port}`, corePort: 0, gatewayPort: 0, manifest: m.ok ? m.manifest : undefined });
  await new Promise((r) => box.core.once("listening", r));
  const log = console.log;
  console.log = () => undefined;
  try {
    const coreUrl = `http://127.0.0.1:${(box.core.address() as AddressInfo).port}`;
    const audio = createAudio({ coreUrl, token: DEV_TOKEN });
    const outs = await audio.outputs();
    assert.deepEqual(outs.map((o) => o.kind), ["box", "bluetooth", "tv"]);
    assert.equal(outs.find((o) => o.default)?.id, "box:0-0");

    // Polls instead of fixed sleeps, so a slow CI machine doesn't fail it.
    const until = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
      const end = Date.now() + ms;
      while (!(await cond())) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    const stateOf = async (id: string) => (await audio.sessions()).find((x) => x.id === id)?.state;
    const changes: string[] = [];
    const stopWatch = audio.watch((list) => changes.push(list.map((s) => s.state).join(",")), 20);
    const s = await audio.play({ path: "/tracks/1.mp3", title: "Song", durationMs: 300 });
    assert.equal(s.state, "starting");
    await until(async () => (await stateOf(s.id)) === "playing");
    assert.deepEqual(fetched[0], { path: "/tracks/1.mp3", auth: `Bearer ${DEV_TOKEN}`, marker: "1" });
    assert.equal((await audio.pause(s.id)).state, "paused");
    assert.equal((await audio.setVolume("box:0-0", 25)).volume, 25);
    await assert.rejects(audio.setVolume("tv:fake-bar", 25), /Only the app playing/);
    assert.equal((await audio.resume(s.id)).state, "playing");
    await until(async () => (await stateOf(s.id)) === "ended");
    assert.equal((await audio.sessions()).find((x) => x.id === s.id)?.endReason, "finished", "SDK 0.13.1: endReason");
    await until(() => changes.some((c) => c.includes("ended")));
    stopWatch();
    assert.ok(changes.some((c) => c.includes("ended")), "watch saw the end");

    const missing = await audio.play({ path: "/tracks/nope.mp3" });
    await until(async () => (await stateOf(missing.id)) === "error");
    const failed = (await audio.sessions()).find((x) => x.id === missing.id)!;
    assert.equal(failed.state, "error");
    assert.match(failed.message!, /wasn't found/);
    assert.equal(failed.endReason, "error");

    // bg.audio / playSound / fromBox
    const bg = createBarGames({ coreUrl, token: DEV_TOKEN, gameId: "music" });
    assert.equal((await bg.audioOutputs()).length, 3);
    const ps = await bg.playSound("/tracks/1.mp3", { outputId: "tv:fake-bar" });
    assert.equal(ps.ok, true);
    await until(async () => (await stateOf(ps.sessionId!)) === "playing"); // settled before the servers close
    assert.equal(bg.fromBox({ headers: { authorization: `Bearer ${DEV_TOKEN}` } } as never), true);
    assert.equal(bg.fromBox({ headers: {} } as never), false);
    const off = createBarGames({ coreUrl: "", token: "", gameId: "music" });
    assert.deepEqual(await off.playSound("/x.mp3"), { ok: false, reason: "standalone" });
    assert.deepEqual(await off.audioOutputs(), []);
    await assert.rejects(createAudio({ coreUrl: "", token: "" }).outputs(), /not running on a Bar Games box/);
  } finally {
    console.log = log;
    box.core.close();
    box.gateway.close();
    game.close();
  }
});

test("SDK 0.13.1: shortAddress / joinUrl for 'Join at' lines; apps that declare events aren't warned about level 2", async () => {
  const { shortAddress, joinUrl } = await import("./base.js");
  assert.equal(shortAddress("https://play.example.net/bingo"), "play.example.net/bingo");
  assert.equal(shortAddress("https://play.example.net/bingo/"), "play.example.net/bingo");
  assert.equal(shortAddress("http://localhost:7082/"), "localhost:7082");
  assert.equal(joinUrl("https://play.example.net/bingo", "/join/AB"), "https://play.example.net/bingo/join/AB");
  const app = (events: string[]) => validateManifest({ id: "music", name: "Music", kind: "app", version: "0.1.0", image: "x/music:0.1.0", port: 3009, sdk: { version: "0.13.1", level: 2 }, routes: { player: "/" }, events });
  const quiet = app(["x-track-started"]);
  assert.ok(quiet.ok && !quiet.warnings.some((w) => /apps have no rooms/.test(w)), "events declared: no warning");
  const loud = app([]);
  assert.ok(loud.ok && loud.warnings.some((w) => /apps have no rooms/.test(w)), "no events: still warned");
});

test("SDK 0.13.1 mock box: --public-url reaches venue.json; integration controls (press, drop, catalog), pairing expiry", async () => {
  const { createIntegration } = await import("./integration.js");
  const { mockBox, DEV_TOKEN, MOCK_INTEGRATION_PATH } = await import("./devbox.js");
  const log = console.log;
  console.log = () => undefined;
  // --public-url: the game's address in the venue context; links to the mock box stay local.
  const g = validateManifest({ id: "bingo", name: "Bingo", version: "0.1.0", image: "x/bingo:0.1.0", port: 3002, sdk: { version: "0.13.1", level: 1 }, routes: { player: "/", table: "/room/{code}?role=table" } });
  const gameBox = mockBox({ gameId: "bingo", displayName: "Bingo (mock)", gameUrl: "http://127.0.0.1:9", corePort: 0, gatewayPort: 0, manifest: g.ok ? g.manifest : undefined, basePath: "/bingo", publicUrl: "https://play.example.net/bingo/" });
  await new Promise((r) => gameBox.core.once("listening", r));
  const m = validateManifest({ id: "matter", name: "Matter", kind: "integration", version: "0.1.0", image: "x/matter:0.1.0", sdk: { version: "0.13.1", level: 0 }, integration: { permissions: ["scenes", "tvs"] } });
  assert.ok(m.ok);
  const box = mockBox({ gameId: "matter", displayName: "Matter (mock)", gameUrl: "http://127.0.0.1:9", corePort: 0, gatewayPort: 0, manifest: m.ok ? m.manifest : undefined });
  await Promise.all([new Promise((r) => box.core.once("listening", r)), new Promise((r) => box.gateway.once("listening", r))]);
  const until = async (cond: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  let stop: (() => void) | undefined;
  try {
    const venue = (await (await fetch(`http://127.0.0.1:${(gameBox.core.address() as AddressInfo).port}/internal/venue`, { headers: { authorization: `Bearer ${DEV_TOKEN}` } })).json()) as { game: { publicUrl: string; basePath?: string }; venue: { adminUrl: string } };
    assert.equal(venue.game.publicUrl, "https://play.example.net/bingo");
    assert.equal(venue.game.basePath, "/bingo");
    assert.match(venue.venue.adminUrl, /^http:\/\/localhost:/, "box links still open locally");

    const ctl = (sub: string, method = "POST", body?: unknown) =>
      fetch(`http://127.0.0.1:${(box.gateway.address() as AddressInfo).port}${MOCK_INTEGRATION_PATH}${sub}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    const it = createIntegration({ coreUrl: `http://127.0.0.1:${(box.core.address() as AddressInfo).port}`, token: DEV_TOKEN });
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await it.report({ state: "setup", pairing: { qr: "MT:TEST", code: "12345678901", expiresAt }, actions: [{ id: "pair-another", label: "Pair another app" }] });
    assert.equal(((await (await ctl("", "GET")).json()) as { report: { pairing: { expiresAt: string } } }).report.pairing.expiresAt, expiresAt);
    assert.equal((await ctl("/action/pair-another")).status, 409, "no stream yet: the press would be lost");

    const actions: string[] = [];
    const catalogs: string[][] = [];
    let ups = 0;
    stop = it.connect({ onAction: (a) => actions.push(a), onCatalog: (c) => catalogs.push((c.scenes ?? []).map((s) => s.id)), onConnection: (up) => void (up && ups++) });
    await until(() => catalogs.length === 1);
    assert.equal((await ctl("/action/nope")).status, 404, "only buttons from the report");
    assert.equal((await ctl("/action/pair-another")).status, 200);
    await until(() => actions.length === 1);
    assert.deepEqual(actions, ["pair-another"]);

    assert.equal((await ctl("/catalog", "PUT", { scenes: [{ id: "trivia", name: "Trivia night" }] })).status, 200);
    await until(() => catalogs.length === 2);
    assert.deepEqual(catalogs[1], ["trivia"]);
    assert.equal((await ctl("/catalog", "PUT", { tvs: [{ name: "no id" }] })).status, 400);
    assert.equal((await ctl("/catalog", "DELETE")).status, 200);
    await until(() => catalogs.length === 3);
    assert.equal(catalogs[2].length, 3, "back to the pretend scenes");

    assert.equal(((await (await ctl("/drop")).json()) as { dropped: number }).dropped, 1);
    await until(() => ups >= 2, 15_000); // the helper reconnects on its own
  } finally {
    stop?.();
    console.log = log;
    for (const b of [box, gameBox]) {
      b.core.closeAllConnections?.();
      b.core.close();
      b.gateway.close();
    }
  }
});
