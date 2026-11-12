import { createLogger, type GatewayConfig } from "@bargames/common";
import { DEFAULT_THEME } from "@bargames/sdk";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { checkAccess, inCidr, isPrivate, parseCidr, parseIp, prefixCidr } from "./ipgate.js";
import { createGateway, injectTheme } from "./server.js";

test("ip parsing: v4, v6, mapped, compressed", () => {
  assert.deepEqual(Array.from(parseIp("192.168.1.5")!.bytes), [192, 168, 1, 5]);
  assert.equal(parseIp("::ffff:10.0.0.1")!.v, 4);
  assert.equal(parseIp("2001:db8::1")!.v, 6);
  assert.equal(parseIp("fe80::1%eth0")!.v, 6);
  assert.equal(parseIp("1.2.3.256"), null);
  assert.equal(parseIp("2001:db8::1::2"), null);
  assert.equal(parseIp("not an ip"), null);
});

test("cidr matching and prefixes", () => {
  assert.ok(inCidr(parseIp("203.0.113.9")!, parseCidr("203.0.113.0/24")!));
  assert.ok(!inCidr(parseIp("203.0.114.9")!, parseCidr("203.0.113.0/24")!));
  assert.ok(inCidr(parseIp("2001:db8:1:2:abcd::9")!, parseCidr("2001:db8:1:2::/64")!));
  assert.ok(!inCidr(parseIp("2001:db8:1:3::9")!, parseCidr("2001:db8:1:2::/64")!));
  assert.equal(prefixCidr("2001:db8:1:2:aaaa:bbbb:cccc:dddd", 64), "2001:db8:1:2:0:0:0:0/64");
  assert.equal(prefixCidr("203.0.113.77", 24), "203.0.113.0/24");
  assert.ok(isPrivate("192.168.77.13") && isPrivate("::1") && isPrivate("100.101.1.2"));
  assert.ok(!isPrivate("8.8.8.8"));
});

test("access decisions", () => {
  const policy = { venueCidrs: ["203.0.113.10/32", "2001:db8:1:2::/64"], whitelist: [{ cidr: "198.51.100.0/24" }, { cidr: "192.0.2.1/32", expiresAt: "2000-01-01T00:00:00Z" }] };
  assert.deepEqual(checkAccess({ remote: "192.168.1.20" }, policy), { allowed: true, reason: "local", clientIp: "192.168.1.20" });
  assert.equal(checkAccess({ remote: "8.8.8.8" }, policy).allowed, false);
  assert.equal(checkAccess({ cfIp: "203.0.113.10", remote: "172.18.0.5" }, policy).reason, "venue-ip");
  assert.equal(checkAccess({ cfIp: "2001:db8:1:2:9::1", remote: "172.18.0.5" }, policy).reason, "venue-ip");
  assert.equal(checkAccess({ cfIp: "198.51.100.7", remote: "172.18.0.5" }, policy).reason, "whitelist");
  assert.equal(checkAccess({ cfIp: "192.0.2.1", remote: "172.18.0.5" }, policy).allowed, false, "expired whitelist entry");
  assert.equal(checkAccess({ cfIp: "8.8.8.8", remote: "172.18.0.5" }, policy).allowed, false, "mobile data is blocked");
});

test("theme injection", () => {
  assert.equal(injectTheme("<html><head><title>x</title></head>"), '<html><head><title>x</title><link rel="stylesheet" href="/__bargames/theme.css" data-bargames></head>');
});

test("gateway: routing, gate, PIN, closed games, headers", async () => {
  const seen: Record<string, string | undefined>[] = [];
  const upstream = createServer((req, res) => {
    seen.push({
      via: req.headers["x-bargames-via"] as string,
      access: req.headers["x-bargames-access"] as string,
      ip: req.headers["x-bargames-client-ip"] as string,
      proof: req.headers["x-bargames-gateway"] as string,
      url: req.url,
    });
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head></head><body>game</body></html>");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const venue = { name: "Kava", theme: DEFAULT_THEME, wifi: { ssid: "KavaGuest" }, playUrl: "https://play.example.com" };
  const ctx = (id: string) => ({ protocol: 1, venue, game: { id, displayName: id === "pool" ? "Kava Pool" : id, theme: DEFAULT_THEME }, standalone: false, generatedAt: "" });
  const cfg: GatewayConfig = {
    boxVersion: "0.1.0",
    domain: "example.com",
    venue,
    routes: [
      { host: "pool.example.com", kind: "game", gameId: "pool", target, enabled: true, injectTheme: true },
      { host: "bingo.example.com", kind: "game", gameId: "bingo", target, enabled: false, injectTheme: false },
      { host: "play.example.com", kind: "hub", enabled: true, injectTheme: false },
      { host: "admin.example.com", kind: "admin", target, enabled: true, injectTheme: false },
    ],
    access: { pinEnabled: false, pin: "4321", whitelist: [], autoVenueIp: true, venueCidrs: [], adminRemote: false },
    contexts: { pool: ctx("pool"), bingo: ctx("bingo"), _hub: ctx("_hub") },
    hub: { games: [{ id: "pool", displayName: "Kava Pool", url: "https://pool.example.com", enabled: true, rooms: [{ code: "KQ7P", players: 6, joinUrl: "https://pool.example.com/join/KQ7P" }, { code: "ZZ9", players: 1 }] }, { id: "bingo", displayName: "Bingo", url: "https://bingo.example.com", enabled: false }] },
    setupRequired: false,
    adminUrl: "https://admin.example.com",
  };
  const gw = createGateway({ config: () => cfg, detectedCidrs: () => ["203.0.113.10/32"], secret: "s", coreToken: "core-tok", log: createLogger("t", "error") });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
  // node:http, not fetch: fetch drops a custom Host header.
  type Res = { status: number; headers: Record<string, string | string[] | undefined>; text: () => Promise<string>; json: () => Promise<unknown> };
  const send = (method: string, host: string, p: string, headers: Record<string, string>, body?: string) =>
    new Promise<Res>((resolve, reject) => {
      const req = request(base + p, { method, headers: { ...headers, host } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c)).on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, text: async () => data, json: async () => JSON.parse(data) }),
        );
      });
      req.on("error", reject);
      req.end(body);
    });
  const get = (host: string, p = "/", headers: Record<string, string> = {}) => send("GET", host, p, headers);
  const form = { "content-type": "application/x-www-form-urlencoded" };
  const venueIp = { "cf-connecting-ip": "203.0.113.10" };

  try {
    // Local (no CF header, loopback) is allowed; spoofed bargames headers are replaced.
    const local = await get("pool.example.com", "/", { "x-bargames-access": "pin" });
    assert.equal(local.status, 200);
    const landing = await local.text();
    assert.match(landing, /theme\.css/, "level-0 route gets the theme injected");
    assert.match(landing, /class="bargames-games-link".*href="https:\/\/play\.example\.com".*<\/nav><\/body>/, "and the games link at the end of its landing page");
    assert.doesNotMatch(await (await get("pool.example.com", "/room/AB")).text(), /bargames-games-link/, "never during play");
    assert.equal(seen.at(-1)!.access, "local");
    assert.equal(seen.at(-1)!.proof, undefined, "games never see the core proof token");

    // Tunnel traffic from the venue's IP passes; from elsewhere gets the Wi-Fi page.
    assert.equal((await get("pool.example.com", "/", venueIp)).status, 200);
    assert.equal(seen.at(-1)!.access, "venue-ip");
    const outside = await get("pool.example.com", "/", { "cf-connecting-ip": "8.8.8.8" });
    assert.equal(outside.status, 403);
    assert.match(await outside.text(), /KavaGuest/);

    // /internal is never reachable; disabled games show the closed page; hub lists live games.
    assert.equal((await get("pool.example.com", "/internal/venue", venueIp)).status, 404);
    assert.equal((await get("bingo.example.com", "/", venueIp)).status, 503);
    const hub = await (await get("play.example.com", "/", venueIp)).text();
    assert.match(hub, /Kava Pool/);
    assert.doesNotMatch(hub, /bingo\.example\.com/);
    assert.match(hub, /KQ7P.*6 players.*href="https:\/\/pool\.example\.com\/join\/KQ7P">Join/, "open rooms with Join links");
    assert.match(hub, /ZZ9.*1 player<\/span><\/li>/, "no joinPath: listed without a Join link");
    assert.doesNotMatch(hub, /class="news"/);
    (venue as typeof venue & { announcement?: unknown }).announcement = { id: "a1", text: "Last call at 1:30" };
    assert.match(await (await get("play.example.com", "/", venueIp)).text(), /class="news" role="status">Last call at 1:30/);
    delete (venue as typeof venue & { announcement?: unknown }).announcement;
    assert.equal(((await (await get("pool.example.com", "/__bargames/venue.json", venueIp)).json()) as { game: { displayName: string } }).game.displayName, "Kava Pool");

    // PIN: required for tunnel traffic, cookie unlocks it.
    cfg.access.pinEnabled = true;
    assert.equal((await get("pool.example.com", "/", venueIp)).status, 401);
    const wrong = await send("POST", "pool.example.com", "/__bargames/pin", { ...venueIp, ...form }, "pin=0000&to=/");
    assert.equal(wrong.status, 401);
    const right = await send("POST", "pool.example.com", "/__bargames/pin", { ...venueIp, ...form }, "pin=4321&to=//evil.com");
    assert.equal(right.status, 303);
    assert.equal(right.headers.location, "/", "no open redirect");
    const cookie = String(right.headers["set-cookie"]);
    assert.match(cookie, /Domain=example\.com/);
    assert.equal((await get("pool.example.com", "/", { ...venueIp, cookie: cookie.split(";")[0] })).status, 200);
    assert.equal((await get("pool.example.com", "/")).status, 200, "local traffic skips the PIN");
    cfg.access.pinEnabled = false;

    // LAN console: an unknown hostname (the box's IP) from the LAN gets the admin UI,
    // with the proof header; never through the tunnel.
    const consoleRes = await get("192.168.77.13", "/", { "x-bargames-gateway": "spoofed" });
    assert.equal(consoleRes.status, 200);
    assert.equal(seen.at(-1)!.proof, "core-tok");
    assert.equal(seen.at(-1)!.access, "local");
    assert.equal((await get("192.168.77.13", "/", venueIp)).status, 404, "no console via the tunnel");

    // First run: the landing page sends LAN visitors to setup; tunnel visitors just wait.
    cfg.setupRequired = true;
    const firstRun = await get("play.example.com", "/");
    assert.equal(firstRun.status, 302);
    assert.equal(firstRun.headers.location, "https://admin.example.com");
    assert.equal((await get("play.example.com", "/", venueIp)).status, 503);
  } finally {
    gw.close();
    upstream.close();
  }
});

test("games list: menus get their own link, not a game card (SDK 0.5.0)", async () => {
  const { hubPage } = await import("./pages.js");
  const html = hubPage({ name: "Kava", theme: DEFAULT_THEME }, [
    { id: "bingo", displayName: "Bingo", url: "https://bingo.example.com", enabled: true, kind: "game" },
    { id: "menu", displayName: "Menu", url: "https://menu.example.com", enabled: true, kind: "display" },
    { id: "pool", displayName: "Pool", url: "https://pool.example.com", enabled: true },
  ]);
  assert.match(html, /<a class="module" href="https:\/\/menu.example.com">Menu<\/a>/);
  assert.doesNotMatch(html, /class="game" href="https:\/\/menu/);
  assert.match(html, /class="game" href="https:\/\/pool/, "no kind (older core): a game");
});

test("staff sign-in: a box-signed link sets the staff cookie; games get the header, never the cookie", async () => {
  const { signToken, verifyToken } = await import("@bargames/common");
  // Tokens: right secret and kind only, not expired.
  const t = signToken("k", "staff-link", Date.now() + 60_000, "n1");
  assert.equal(verifyToken("k", "staff-link", t)?.nonce, "n1");
  assert.equal(verifyToken("other", "staff-link", t), undefined);
  assert.equal(verifyToken("k", "staff", t), undefined, "a link isn't a cookie");
  assert.equal(verifyToken("k", "staff-link", signToken("k", "staff-link", Date.now() - 1, "n")), undefined, "expired");

  const seen: { staff?: string; cookie?: string }[] = [];
  const upstream = createServer((req, res) => {
    seen.push({ staff: req.headers["x-bargames-staff"] as string | undefined, cookie: req.headers.cookie });
    res.end("ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const venue = { name: "Kava", theme: DEFAULT_THEME };
  const cfg = {
    boxVersion: "0.1.0",
    domain: "example.com",
    venue,
    routes: [{ host: "menu.example.com", kind: "game", gameId: "menu", target, enabled: true, injectTheme: false }],
    access: { pinEnabled: true, pin: "4321", whitelist: [], autoVenueIp: true, venueCidrs: [], adminRemote: false },
    contexts: {},
    hub: { games: [] },
    setupRequired: false,
    adminUrl: "https://admin.example.com",
  } as unknown as GatewayConfig;
  const gw = createGateway({ config: () => cfg, detectedCidrs: () => ["203.0.113.10/32"], secret: "core-tok", coreToken: "core-tok", log: createLogger("t", "error") });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
  const get = (p: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const req = request(base + p, { headers: { ...headers, host: "menu.example.com", "cf-connecting-ip": "203.0.113.10" } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers }));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    // A forged header from the outside never reaches the game.
    await get("/", { "x-bargames-staff": "1", cookie: "bg_pin=x" });
    assert.equal(seen.at(-1), undefined, "PIN page: nothing proxied");

    const link = signToken("core-tok", "staff-link", Date.now() + 60_000, "abc");
    const r = await get(`/__bargames/staff?t=${encodeURIComponent(link)}&next=/admin`);
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, "/admin");
    const setCookie = String(r.headers["set-cookie"]);
    assert.match(setCookie, /^bg_staff=staff\./);
    assert.match(setCookie, /Domain=example\.com/);
    assert.match(setCookie, /HttpOnly/);
    assert.equal((await get(`/__bargames/staff?t=${encodeURIComponent(link)}&next=/admin`)).status, 403, "one use only");
    assert.equal((await get(`/__bargames/staff?t=bogus`)).status, 403);
    assert.equal((await get(`/__bargames/staff?t=${encodeURIComponent(link)}&next=//evil.example`)).status, 403);

    const cookie = setCookie.split(";")[0];
    seen.length = 0;
    await get("/admin", { cookie: `${cookie}; other=1` });
    assert.deepEqual(seen.at(-1), { staff: "1", cookie: "other=1" }, "staff header, cookie stripped, and the PIN is skipped for staff");
    seen.length = 0;
    const forged = await get("/admin", { cookie: "bg_staff=staff.9999999999999.x.forged" });
    assert.equal(forged.status, 401, "a forged cookie isn't staff: the venue PIN is still asked");
    assert.equal(seen.length, 0);
  } finally {
    gw.close();
    upstream.close();
  }
});

test("path routing (SDK 0.10.0): a game under /<id> on the venue hostname, WebSockets, old subdomain redirects", async () => {
  const { signToken } = await import("@bargames/common");
  const { stripPrefix } = await import("./server.js");
  assert.deepEqual(stripPrefix("/bingo", "/bingo/x?y=1"), { url: "/x?y=1" });
  assert.deepEqual(stripPrefix("/bingo", "/bingo?y=1"), { redirect: "/bingo/?y=1" });
  assert.deepEqual(stripPrefix("/bingo", "/bingoextra/x"), {});

  const seen: { url?: string; prefix?: string; cookie?: string; proof?: string }[] = [];
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url, prefix: req.headers["x-forwarded-prefix"] as string | undefined, cookie: req.headers.cookie, proof: req.headers["x-bargames-gateway"] as string | undefined });
    if (req.url === "/old") return void res.writeHead(302, { location: "/new" }).end();
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("game");
  });
  upstream.on("upgrade", (req, socket) => {
    seen.push({ url: req.url });
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const venue = { name: "Kava", theme: DEFAULT_THEME, wifi: { ssid: "KavaGuest" }, playUrl: "https://play.example.com" };
  const ctx = (id: string) => ({ protocol: 1, venue, game: { id, displayName: id, theme: DEFAULT_THEME, basePath: id === "_hub" ? undefined : `/${id}` }, standalone: false, generatedAt: "" });
  const cfg: GatewayConfig = {
    boxVersion: "0.1.0",
    domain: "example.com",
    venue,
    routes: [
      { host: "play.example.com", kind: "hub", enabled: true, injectTheme: false },
      { host: "play.example.com", path: "/admin", kind: "admin", target, enabled: true, injectTheme: false },
      { host: "play.example.com", path: "/bingo", kind: "game", gameId: "bingo", target, enabled: true, injectTheme: false },
      { host: "bingo.example.com", kind: "game", gameId: "bingo", enabled: true, injectTheme: false, redirectTo: "https://play.example.com/bingo" },
      { host: "admin.example.com", kind: "admin", target, enabled: true, injectTheme: false },
    ],
    access: { pinEnabled: false, pin: "", whitelist: [], autoVenueIp: true, venueCidrs: [], adminRemote: false },
    contexts: { bingo: ctx("bingo"), _hub: ctx("_hub") },
    hub: { games: [{ id: "bingo", displayName: "Bingo", url: "https://play.example.com/bingo", enabled: true }] },
    setupRequired: false,
    adminUrl: "https://admin.example.com",
  };
  const gw = createGateway({ config: () => cfg, detectedCidrs: () => [], secret: "s", coreToken: "core-tok", log: createLogger("t", "error") });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  const port = (gw.address() as AddressInfo).port;
  const get = (host: string, p: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}${p}`, { headers: { ...headers, host } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    let r = await get("play.example.com", "/bingo/api/rooms?x=1", { "x-forwarded-prefix": "/evil" });
    assert.equal(r.body, "game");
    assert.deepEqual(seen.at(-1), { url: "/api/rooms?x=1", prefix: "/bingo", cookie: undefined, proof: undefined });
    r = await get("play.example.com", "/bingo?a=1");
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/bingo/?a=1");
    r = await get("play.example.com", "/bingo/old");
    assert.equal(r.headers.location, "/bingo/new", "the game's redirect gets its prefix back");
    r = await get("play.example.com", "/bingo/__bargames/venue.json");
    assert.equal((JSON.parse(r.body) as { game: { id: string } }).game.id, "bingo");
    r = await get("play.example.com", "/");
    assert.match(r.body, /Bingo/, "the games list stays at the root");
    const before = seen.length;
    r = await get("play.example.com", "/bingox/");
    assert.equal(seen.length, before, "a near-miss doesn't reach the game");
    r = await get("bingo.example.com", "/join/AB?x=1");
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, "https://play.example.com/bingo/join/AB?x=1");

    // Admin at /admin on the same hostname: core gets the prefix, the proof and its cookie...
    r = await get("play.example.com", "/admin/api/venue", { cookie: "bg_admin=sess; x=1" });
    assert.deepEqual(seen.at(-1), { url: "/api/venue", prefix: "/admin", cookie: "bg_admin=sess; x=1", proof: "core-tok" });
    // ...and a game never sees the admin's session cookie.
    r = await get("play.example.com", "/bingo/", { cookie: "bg_admin=sess; x=1" });
    assert.equal(seen.at(-1)!.cookie, "x=1");
    // By IP from the LAN: the admin at the root, and at /admin.
    r = await get("192.168.77.13", "/admin/api/venue");
    assert.deepEqual([seen.at(-1)!.url, seen.at(-1)!.prefix], ["/api/venue", "/admin"]);
    r = await get("192.168.77.13", "/api/venue");
    assert.deepEqual([seen.at(-1)!.url, seen.at(-1)!.prefix], ["/api/venue", undefined]);

    // Staff sign-in link on a path: lands back on the game's own path.
    const t = signToken("core-tok", "staff-link", Date.now() + 60_000, "n-path");
    r = await get("play.example.com", `/bingo/__bargames/staff?t=${encodeURIComponent(t)}&next=/admin`);
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, "/bingo/admin");
    const t2 = signToken("core-tok", "staff-link", Date.now() + 60_000, "n-path2");
    r = await get("play.example.com", `/bingo/__bargames/staff?t=${encodeURIComponent(t2)}&next=/bingo/admin`);
    assert.equal(r.headers.location, "/bingo/admin", "a prefixed next isn't doubled");

    // WebSocket upgrade under the prefix reaches the game with the prefix stripped.
    const upgraded = await new Promise<number>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}/bingo/socket.io/?EIO=4&transport=websocket`, {
        headers: { host: "play.example.com", connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(upgraded, 101);
    assert.equal(seen.at(-1)!.url, "/socket.io/?EIO=4&transport=websocket");
  } finally {
    gw.close();
    upstream.close();
  }
});

test("0.12.0: venue.json is held until the venue changes; live.json answers without a PIN, with CORS", async () => {
  const { contentTag } = await import("./server.js");
  const venue = { name: "Kava", theme: DEFAULT_THEME, playUrl: "https://play.example.com" } as GatewayConfig["venue"];
  const ctx = (v: GatewayConfig["venue"], at: string) => ({ protocol: 1, venue: v, game: { id: "_hub", displayName: "Kava", theme: DEFAULT_THEME }, standalone: false, generatedAt: at });
  let cfg: GatewayConfig = {
    boxVersion: "0.1.0",
    domain: "example.com",
    venue,
    routes: [{ host: "play.example.com", kind: "hub", enabled: true, injectTheme: false }],
    access: { pinEnabled: true, pin: "4321", whitelist: [], autoVenueIp: true, venueCidrs: [], adminRemote: false },
    contexts: { _hub: ctx(venue, "a") },
    hub: { games: [] },
    setupRequired: false,
    adminUrl: "https://play.example.com/admin",
  };
  assert.equal(contentTag(ctx(venue, "a")), contentTag(ctx(venue, "b")), "generatedAt doesn't change the tag");
  const gw = createGateway({ config: () => cfg, detectedCidrs: () => [], secret: "s", coreToken: "core-tok", log: createLogger("t", "error") });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  const port = (gw.address() as AddressInfo).port;
  const get = (p: string) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string; ms: number }>((resolve, reject) => {
      const t0 = Date.now();
      const req = request(`http://127.0.0.1:${port}${p}`, { headers: { host: "play.example.com" } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body, ms: Date.now() - t0 }));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    // live.json: no PIN needed (the venue PIN is on), CORS for the data: idle page.
    let r = await get("/__bargames/live.json");
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], "*");
    assert.deepEqual(JSON.parse(r.body), { announcement: null, countdown: null });
    const liveTag = String(r.headers["x-bargames-etag"]);
    // Held: an announcement posted 1.2 s later answers the waiting request.
    setTimeout(() => {
      const v = { ...venue, announcement: { id: "a1", text: "Last call", show: "tvs" as const } };
      cfg = { ...cfg, venue: v, contexts: { _hub: ctx(v, "c") } };
    }, 1200);
    r = await get(`/__bargames/live.json?wait=${liveTag}`);
    assert.ok(r.ms >= 1000 && r.ms < 5000, `held ${r.ms} ms`);
    assert.equal(JSON.parse(r.body).announcement.text, "Last call");
    assert.notEqual(r.headers["x-bargames-etag"], liveTag);
    // venue.json: a stale tag answers at once (LAN requests skip the PIN anyway).
    r = await get("/__bargames/venue.json?wait=stale");
    assert.ok(r.ms < 500);
    assert.equal(r.headers["x-bargames-wait"], "1");
    assert.equal(JSON.parse(r.body).venue.announcement.text, "Last call");
  } finally {
    gw.close();
  }
});
