// Box 0.19.0 (SDK 0.16.0): guest hosts. Staff make a link to one app's controls; a guest host
// may add co-hosts when the app supports it and the venue allows it; links end on revoke
// (co-hosts with their host), at their time, or when staff sign everyone out.

import { createLogger, type GatewayConfig } from "@bargames/common";
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
import { cleanGuestRequest, closingTonight, guestActive, type GuestStore } from "./guests.js";
import { NoopRuntime } from "./runtime/types.js";
import { openState } from "./state.js";

test("guests: rules", () => {
  const now = Date.parse("2026-11-20T20:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const s: GuestStore = {
    cohosts: {},
    links: [
      { id: "h", gameId: "signup", label: "Dana", role: "host", createdAt: iso(now - 1000), expiresAt: iso(now + 3600e3) },
      { id: "c", gameId: "signup", label: "Sam", role: "cohost", parentId: "h", createdAt: iso(now - 500), expiresAt: iso(now + 3600e3) },
    ],
  };
  assert.ok(guestActive(s, s.links[1], now));
  assert.ok(!guestActive(s, s.links[1], now, now), "signed out everywhere after it was made");
  s.links[0].revokedAt = iso(now);
  assert.ok(!guestActive(s, s.links[1], now), "a co-host ends with their host");
  assert.ok(!guestActive(s, s.links[0], now + 7200e3));

  assert.equal(typeof cleanGuestRequest({ label: "" }), "string");
  assert.equal(typeof cleanGuestRequest({ label: "Dana", hours: 48 }), "string");
  assert.deepEqual(cleanGuestRequest({ label: " Dana ", hours: 2 }), { label: "Dana", hours: 2 });

  // Closing time: Friday night 01:30 means Saturday 01:30 (America/New_York, UTC-5 in November).
  const closing = { enabled: true, sceneId: "x", nights: ["", "", "", "", "", "01:30", ""] };
  const fri8pm = new Date("2026-11-21T01:00:00Z"); // Friday 20:00 local
  assert.equal(closingTonight(closing, fri8pm, "America/New_York")?.toISOString(), "2026-11-21T06:30:00.000Z");
  const sat1am = new Date("2026-11-21T06:00:00Z"); // still Friday's night (before 4 AM)
  assert.equal(closingTonight(closing, sat1am, "America/New_York")?.toISOString(), "2026-11-21T06:30:00.000Z");
  assert.equal(closingTonight({ ...closing, enabled: false }, fri8pm, "America/New_York"), undefined);
  assert.equal(closingTonight(closing, new Date("2026-11-20T01:00:00Z"), "America/New_York"), undefined, "no closing time on Thursday");
});

test("guests: staff link → gateway config; a guest host adds a co-host; revoking ends both", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-guests-"));
  const state = openState(dir);
  const games = new GameRegistry(state.games);
  const app = createApp({
    state,
    games,
    runtime: new NoopRuntime(),
    bus: new EventBus(),
    auth: new AdminAuth(state.auth, "secret"),
    cloudflare: new CloudflareService({ store: state.cloudflare, connector: new NoopRuntime(), desiredHosts: () => [], tunnelName: () => "t", origin: "http://gw", log: createLogger("test", "error") }),
    log: createLogger("test", "error"),
    config: { gatewayToken: "gw", brokerUrl: "http://broker", brokerToken: "b", internalUrl: "http://core:7100", adminDist: path.join(dir, "none"), boxVersion: "0.19.0" },
    fetch: (async () => new Response("[]", { headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const gatewayGuests = async () => ((await (await json("GET", "/internal/gateway-config", undefined, { authorization: "Bearer gw" })).json()) as GatewayConfig).guests ?? [];
  try {
    const cookie = (await json("POST", "/api/auth/setup", { password: "correct horse" })).headers.get("set-cookie")!.split(";")[0];
    const authed = { cookie };
    const signup = { id: "signup", name: "Stage Signup", kind: "app", version: "0.2.0", image: "x/s:1", port: 3000, sdk: { version: "0.16.0", level: 1 }, routes: { player: "/", host: "/kj" }, guests: { cohosts: true } };
    const menu = { id: "menu", name: "Menu", kind: "app", version: "1.0.0", image: "x/m:1", port: 3000, sdk: { version: "0.16.0", level: 1 }, routes: { player: "/" } };
    for (const m of [signup, menu]) {
      assert.equal((await json("POST", "/api/games/install", { manifest: m, devTarget: `http://${m.id}` }, authed)).status, 200);
      await json("PATCH", `/api/games/${m.id}`, { enabled: true }, authed);
    }
    const appAuth = { authorization: `Bearer ${games.get("signup")!.token}` };

    assert.equal((await json("POST", "/api/guests", { gameId: "menu", label: "X" }, authed)).status, 400, "the menu doesn't take guests");
    assert.equal((await json("POST", "/api/guests", { gameId: "signup", label: "Dana" })).status, 401, "staff only");
    const made = (await (await json("POST", "/api/guests", { gameId: "signup", label: "Dana – karaoke", hours: 2 }, authed)).json()) as { id: string; url: string; qrSvg: string; expiresAt: string; role: string };
    assert.equal(made.role, "host");
    assert.match(made.url, /\/__bargames\/guest\?t=guest\./);
    assert.match(made.qrSvg, /<svg/);
    assert.ok(Math.abs(Date.parse(made.expiresAt) - Date.now() - 2 * 3600e3) < 60_000);
    assert.deepEqual((await gatewayGuests()).map((g) => [g.id, g.gameId, g.role, g.landing]), [[made.id, "signup", "host", "/kj"]]);

    // The app adds a co-host for its guest host: only once the venue allows it.
    assert.equal((await json("POST", "/internal/guests/cohost", { guestId: made.id, label: "Sam" }, appAuth)).status, 403);
    assert.equal((await json("PUT", "/api/guests/settings/signup", { cohosts: true }, authed)).status, 200);
    const co = (await (await json("POST", "/internal/guests/cohost", { guestId: made.id, label: "Sam" }, appAuth)).json()) as { id: string; role: string; parentId: string; expiresAt: string; url: string };
    assert.equal(co.role, "cohost");
    assert.equal(co.parentId, made.id);
    assert.equal(co.expiresAt, made.expiresAt, "ends with the host");
    assert.equal((await json("POST", "/internal/guests/cohost", { guestId: co.id, label: "Lee" }, appAuth)).status, 403, "a co-host can't add anyone");
    assert.equal(((await (await json("GET", "/internal/guests", undefined, appAuth)).json()) as unknown[]).length, 2);
    assert.equal((await json("GET", "/internal/guests", undefined, { authorization: `Bearer ${games.get("menu")!.token}` })).status, 403);

    const overview = (await (await json("GET", "/api/guests", undefined, authed)).json()) as { apps: { gameId: string; cohosts: boolean }[]; links: { id: string; active: boolean }[] };
    assert.deepEqual(overview.apps.map((a) => [a.gameId, a.cohosts]), [["signup", true]]);
    assert.equal(overview.links.filter((l) => l.active).length, 2);

    // Staff turn the host off: the co-host goes too.
    assert.equal((await json("DELETE", `/api/guests/${made.id}`, undefined, authed)).status, 200);
    assert.deepEqual(await gatewayGuests(), []);
    assert.equal((await json("GET", `/api/guests/${co.id}/link`, undefined, authed)).status, 404);
  } finally {
    server.close();
  }
});
