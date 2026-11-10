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
    hub: { games: [{ id: "pool", displayName: "Kava Pool", url: "https://pool.example.com", enabled: true }, { id: "bingo", displayName: "Bingo", url: "https://bingo.example.com", enabled: false }] },
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
    assert.match(await local.text(), /theme\.css/, "level-0 route gets the theme injected");
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
