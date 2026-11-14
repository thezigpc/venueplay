// SDK 0.12.0 on the box: integrations (Matter, Home Assistant…). Installed like apps, kept
// out of everything players and TVs see, turned on only with the venue's approval, and
// limited to what was approved.

import { createLogger } from "@bargames/common";
import { validateManifest, type IntegrationCatalog, type IntegrationMessage } from "@bargames/sdk";
import { createIntegration } from "@bargames/sdk/integration";
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
import { cleanReport, isTrusted } from "./integrations.js";
import { containerSpec, envHash } from "./runtime/spec.js";
import { NoopRuntime } from "./runtime/types.js";
import { openState, type InstalledGame } from "./state.js";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const bingo = { id: "bingo", name: "Bingo", version: "1.0.0", image: "ghcr.io/acme/bingo:1.0.0", port: 3002, sdk: { version: "0.9.0", level: 2 }, routes: { player: "/", table: "/room/{code}" }, events: ["winner"] };
const ha = {
  id: "homeassistant",
  name: "Home Assistant",
  kind: "integration",
  version: "0.1.0",
  image: "ghcr.io/acme/ha:0.1.0",
  sdk: { version: "0.12.0", level: 0 },
  network: { internet: true },
  integration: {
    permissions: ["scenes", "tvs", "events"],
    settings: [
      { name: "MQTT_URL", label: "Broker address", required: true },
      { name: "MQTT_PASSWORD", label: "Password", secret: true },
    ],
  },
};

test("manifest: integrations need no port or pages, and declare permissions and settings", () => {
  const ok = validateManifest(ha);
  assert.ok(ok.ok, JSON.stringify(ok));
  if (!ok.ok) return;
  assert.equal(ok.manifest.kind, "integration");
  assert.equal(ok.manifest.port, 0);
  assert.equal(ok.manifest.health, "");
  assert.deepEqual(ok.manifest.integration?.permissions, ["scenes", "tvs", "events"]);
  assert.deepEqual(ok.manifest.brandable, []);
  assert.ok(!ok.warnings.some((w) => w.startsWith("routes.table")), "no TV-view nag for integrations");

  const bad = validateManifest({ ...ha, integration: { permissions: ["everything"] } });
  assert.ok(!bad.ok);
  const badSetting = validateManifest({ ...ha, integration: { permissions: [], settings: [{ name: "BG_TOKEN", label: "x" }] } });
  assert.ok(!badSetting.ok);
  assert.ok(!validateManifest({ ...ha, integration: undefined }).ok, "kind integration needs an integration block");
  // A game still needs its port.
  assert.ok(!validateManifest({ ...bingo, port: undefined }).ok);
});

test("trust: only integrations from trusted GitHub owners may use the host network", () => {
  const g = (ref: string, kind: "url" | "local" = "url") => ({ source: { kind, ref } }) as InstalledGame;
  assert.ok(isTrusted(g("https://raw.githubusercontent.com/thezigpc/matter/HEAD/bargames.json"), ["thezigpc"]));
  assert.ok(isTrusted(g("https://raw.githubusercontent.com/TheZigPC/matter/HEAD/bargames.json"), ["thezigpc"]));
  assert.ok(!isTrusted(g("https://raw.githubusercontent.com/someone/matter/HEAD/bargames.json"), ["thezigpc"]));
  assert.ok(!isTrusted(g("https://evil.example/thezigpc/bargames.json"), ["thezigpc"]));
  assert.ok(!isTrusted(g("upload", "local"), ["thezigpc"]));
  assert.ok(isTrusted(g("upload", "local"), ["*"]));
});

test("report: cleaned and capped", () => {
  assert.equal(typeof cleanReport({ state: "great" }), "string");
  const r = cleanReport({ state: "setup", message: "Scan to pair", pairing: { qr: "MT:Y.K90AFN00KA0648G00", code: "34970112332" }, details: [{ label: "Fabrics", value: "0" }, { nope: 1 }] });
  assert.deepEqual(r, { state: "setup", message: "Scan to pair", pairing: { qr: "MT:Y.K90AFN00KA0648G00", code: "34970112332" }, details: [{ label: "Fabrics", value: "0" }] });
  // SDK 0.13.1: a pairing expiry is kept (normalized); a bad one is dropped.
  const exp = cleanReport({ state: "setup", pairing: { code: "1", expiresAt: "2030-01-01T00:15:00+00:00" } }) as { pairing: { expiresAt?: string } };
  assert.equal(exp.pairing.expiresAt, "2030-01-01T00:15:00.000Z");
  assert.equal((cleanReport({ state: "setup", pairing: { code: "1", expiresAt: "soon" } }) as { pairing: { expiresAt?: string } }).pairing.expiresAt, undefined);
});

test("container: an approved lan integration runs on the host network; games are unchanged", () => {
  const r = validateManifest({ ...ha, integration: { permissions: ["scenes", "lan"] } });
  assert.ok(r.ok);
  if (!r.ok) return;
  const base = { id: "matter", manifest: r.manifest, source: { kind: "url", ref: "x" }, verified: false, installedAt: "", updatedAt: "", enabled: true, branding: {}, token: "t" } as InstalledGame;
  const opts = { coreUrl: "http://bargames-core:7100", hostCoreUrl: "http://127.0.0.1:7100", publicUrl: "http://x" };

  const notYet = containerSpec(base, opts);
  assert.equal((notYet.body.HostConfig as { NetworkMode: string }).NetworkMode, "bg-net-matter", "lan not approved: its own network");
  const host = containerSpec({ ...base, granted: ["scenes", "lan"] }, opts);
  const env = host.body.Env as string[];
  assert.equal((host.body.HostConfig as { NetworkMode: string }).NetworkMode, "host");
  assert.ok(env.includes("BG_CORE_URL=http://127.0.0.1:7100"));
  assert.ok(env.includes("BG_PERMISSIONS=scenes,lan"));
  assert.ok(!env.some((e) => e.startsWith("PORT=")), "no web server: no PORT");
  assert.equal(host.body.Healthcheck, undefined);
  assert.notEqual((host.body.Labels as Record<string, string>)["bargames.envhash"], (notYet.body.Labels as Record<string, string>)["bargames.envhash"]);

  // Games keep the same fingerprint as before integrations existed (no mass restart on upgrade).
  const g = validateManifest(bingo);
  assert.ok(g.ok);
  if (!g.ok) return;
  const game = { ...base, id: "bingo", manifest: g.manifest };
  const spec = containerSpec(game, opts);
  const genv = Object.fromEntries((spec.body.Env as string[]).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
  assert.equal((spec.body.Labels as Record<string, string>)["bargames.envhash"], envHash(genv));
});

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-int-"));
  const state = openState(dir);
  const games = new GameRegistry(state.games);
  const runtime = new NoopRuntime();
  const power: { id: string; on: boolean }[] = [];
  const displays = [
    { id: "tv1", name: "Bar", label: "Bar TV", group: "Main", capabilities: { power: true }, content: { kind: "idle" } },
    { id: "tv2", name: "Patio", capabilities: { power: false } },
  ];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://broker/displays?") || url === "http://broker/displays") return reply(displays.map((x) => ({ ...x, health: { online: x.id === "tv1" } })));
    const m = /^http:\/\/broker\/displays\/([^/]+)\/power$/.exec(url);
    if (m) {
      power.push({ id: decodeURIComponent(m[1]), on: JSON.parse(String(init?.body)).on });
      return reply({ ok: true });
    }
    if (url === "http://broker/show") return reply({});
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const bus = new EventBus();
  const app = createApp({
    state,
    games,
    runtime,
    bus,
    auth: new AdminAuth(state.auth, "secret"),
    cloudflare: new CloudflareService({ store: state.cloudflare, connector: new NoopRuntime(), desiredHosts: () => [], tunnelName: () => "t", origin: "http://gw", log: createLogger("test", "error") }),
    log: createLogger("test", "error"),
    config: { gatewayToken: "gw", brokerUrl: "http://broker", brokerToken: "b", internalUrl: "http://core:7100", adminDist: path.join(dir, "none"), boxVersion: "0.14.0", integrationBoxId: "abcdef0123456789", trustedOwners: ["thezigpc"], integrationPollMs: 50 },
    fetch: fakeFetch,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const cookie = (await json("POST", "/api/auth/setup", { password: "correct horse" })).headers.get("set-cookie")!.split(";")[0];
  return { json, base, authed: { cookie }, games, runtime, displays, power, state, close: () => server.close() };
}

test("integrations: installed apart from games, approved, limited, and fed live", async () => {
  const b = await boot();
  try {
    for (const m of [bingo, ha]) assert.equal((await b.json("POST", "/api/games/install", { manifest: m, devTarget: `http://${m.id}` }, b.authed)).status, 200);
    await b.json("PATCH", "/api/games/bingo", { enabled: true }, b.authed);
    await b.json("PUT", "/api/scenes/bingo-night", { name: "Bingo night", actions: [{ displayId: "tv1", do: "power", on: true }] }, b.authed);

    // Not a game: not on the games list, the gateway or DNS.
    const listed = (await (await b.json("GET", "/api/games", undefined, b.authed)).json()) as { id: string }[];
    assert.deepEqual(listed.map((g) => g.id), ["bingo"]);
    const cfg = (await (await b.json("GET", "/internal/gateway-config", undefined, { authorization: "Bearer gw" })).json()) as { routes: { gameId?: string }[]; hub: { games: { id: string }[] } };
    assert.ok(!JSON.stringify(cfg).includes("homeassistant"), "no route, hub entry or hostname");

    // Smart home: it asks for permissions; turning it on needs them approved.
    type View = { id: string; enabled: boolean; needsApproval: string[]; settings: { name: string; set: boolean; value?: string }[]; report?: { state: string }; connected: boolean };
    const list = async () => ((await (await b.json("GET", "/api/integrations", undefined, b.authed)).json()) as { integrations: View[] }).integrations;
    assert.deepEqual((await list())[0].needsApproval, ["scenes", "tvs", "events"]);
    assert.equal((await b.json("PATCH", "/api/games/homeassistant", { enabled: true }, b.authed)).status, 400, "not through the games route");
    assert.equal((await b.json("POST", "/api/integrations/homeassistant/enable", { on: true }, b.authed)).status, 409);
    assert.equal((await b.json("POST", "/api/integrations/homeassistant/enable", { on: true, approve: true }, b.authed)).status, 200);
    assert.equal(await b.runtime.state("homeassistant"), "running");
    assert.deepEqual((await list())[0].needsApproval, []);

    // Settings: only what it declares; secrets are never shown again.
    assert.equal((await b.json("PUT", "/api/integrations/homeassistant/settings", { values: { OTHER: "x" } }, b.authed)).status, 400);
    assert.equal((await b.json("PUT", "/api/integrations/homeassistant/settings", { values: { MQTT_URL: "mqtt://192.0.2.5:1883", MQTT_PASSWORD: "hunter2" } }, b.authed)).status, 200);
    const s = (await list())[0].settings;
    assert.deepEqual(s.find((x) => x.name === "MQTT_URL"), { name: "MQTT_URL", label: "Broker address", required: true, set: true, value: "mqtt://192.0.2.5:1883" });
    assert.equal(s.find((x) => x.name === "MQTT_PASSWORD")?.value, undefined);
    assert.equal(s.find((x) => x.name === "MQTT_PASSWORD")?.set, true);
    assert.equal(b.state.appSecrets.get().homeassistant.MQTT_PASSWORD, "hunter2");

    // Its token is not a game token, and a game token is not an integration token.
    const token = b.games.get("homeassistant")!.token;
    assert.equal((await b.json("GET", "/internal/venue", undefined, { authorization: `Bearer ${token}` })).status, 401);
    assert.equal((await b.json("GET", "/internal/integration/catalog", undefined, { authorization: `Bearer ${b.games.get("bingo")!.token}` })).status, 401);

    // The SDK helper against the real routes.
    const box = createIntegration({ coreUrl: b.base, token });
    const cat = await box.catalog();
    assert.deepEqual(cat.box, { id: "abcdef0123456789", version: "0.14.0", venue: "Bar Games" });
    assert.deepEqual(cat.scenes, [{ id: "bingo-night", name: "Bingo night" }]);
    assert.deepEqual(cat.tvs, [
      { id: "tv1", name: "Bar TV", group: "Main", online: true, power: true },
      { id: "tv2", name: "Patio", online: false, power: false },
    ]);
    assert.equal(cat.games, undefined, "no status permission: no games");

    // The live stream: hello, game events, scene runs, catalog changes.
    const got: IntegrationMessage[] = [];
    const catalogs: IntegrationCatalog[] = [];
    const stop = box.connect({ onCatalog: (c) => catalogs.push(c), onEvent: (e) => got.push({ type: "event", event: e }), onScene: (m) => got.push(m) });
    const until = async (fn: () => boolean) => {
      for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(fn());
    };
    await until(() => catalogs.length === 1);
    assert.equal((await b.json("POST", "/internal/events", { type: "winner", roomCode: "ABCD", data: { name: "Sam" } }, { authorization: `Bearer ${b.games.get("bingo")!.token}` })).status, 204);
    await until(() => got.some((m) => m.type === "event"));

    const run = await box.runScene("bingo-night");
    assert.equal(run.ok, true);
    assert.deepEqual(b.power, [{ id: "tv1", on: true }]);
    await until(() => got.some((m) => m.type === "scene" && m.by === "homeassistant"));
    assert.equal((await b.json("POST", "/api/scenes/bingo-night/apply", {}, b.authed)).status, 200);
    await until(() => got.some((m) => m.type === "scene" && m.by === "admin"));

    await b.json("PUT", "/api/scenes/last-call", { name: "Last call", actions: [] }, b.authed);
    await until(() => catalogs.length === 2);
    assert.deepEqual(catalogs[1].scenes?.map((x) => x.id), ["bingo-night", "last-call"]);
    b.displays[0].label = "Main bar";
    await until(() => catalogs.length === 3);
    assert.equal(catalogs[2].tvs?.[0].name, "Main bar", "TV changes reach it by polling");

    // TV power: only TVs the box can switch.
    await box.tvPower("tv1", false);
    await assert.rejects(box.tvPower("tv2", true), /can't be switched/);

    // Its report shows in the admin, with a QR for pairing.
    await box.report({ state: "setup", message: "Scan to pair", pairing: { qr: "MT:Y.K90AFN00KA0648G00", code: "34970112332" } });
    const v = (await list())[0];
    assert.equal(v.report?.state, "setup");
    assert.equal(v.connected, true);
    const svg = await b.json("GET", "/api/integrations/homeassistant/pairing.svg", undefined, b.authed);
    assert.equal(svg.status, 200);
    assert.match(await svg.text(), /<svg/);
    // Its buttons: offered in the report, pressed in the admin, delivered on the stream.
    const actions: string[] = [];
    const stop2 = box.connect({ onAction: (a) => actions.push(a) });
    await box.report({ state: "ok", actions: [{ id: "reset", label: "Forget all pairings", confirm: "Sure?" }, { id: "BAD ID", label: "x" }] });
    assert.deepEqual((await list())[0].report, { state: "ok", actions: [{ id: "reset", label: "Forget all pairings", confirm: "Sure?" }] });
    assert.equal((await b.json("POST", "/api/integrations/homeassistant/actions/nope", {}, b.authed)).status, 404);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await b.json("POST", "/api/integrations/homeassistant/actions/reset", {}, b.authed)).status, 200);
    await until(() => actions.length > 0);
    assert.deepEqual(actions.slice(0, 1), ["reset"]);
    stop();
    stop2();

    // Off: its token stops working.
    assert.equal((await b.json("POST", "/api/integrations/homeassistant/enable", { on: false }, b.authed)).status, 200);
    assert.equal((await b.json("GET", "/internal/integration/catalog", undefined, { authorization: `Bearer ${token}` })).status, 403);
  } finally {
    b.close();
  }
});

test("integrations: an update asking for more keeps the old grant until approved; lan needs a trusted source", async () => {
  const b = await boot();
  try {
    await b.json("POST", "/api/games/install", { manifest: ha }, b.authed);
    await b.json("POST", "/api/integrations/homeassistant/enable", { on: true, approve: true }, b.authed);
    // A new version wants "status" too.
    await b.json("POST", "/api/games/install", { manifest: { ...ha, version: "0.2.0", integration: { ...ha.integration, permissions: [...ha.integration.permissions, "status"] } } }, b.authed);
    const token = b.games.get("homeassistant")!.token;
    const cat = (await (await b.json("GET", "/internal/integration/catalog", undefined, { authorization: `Bearer ${token}` })).json()) as IntegrationCatalog;
    assert.deepEqual(cat.permissions, ["events", "scenes", "tvs"]);
    assert.equal(cat.games, undefined);
    assert.equal((await b.json("POST", "/api/integrations/homeassistant/approve", {}, b.authed)).status, 200);
    const after = (await (await b.json("GET", "/internal/integration/catalog", undefined, { authorization: `Bearer ${token}` })).json()) as IntegrationCatalog;
    assert.deepEqual(after.games, []);

    // Uploaded (not from a trusted GitHub owner): "lan" can't be approved.
    await b.json("POST", "/api/games/install", { manifest: { ...ha, id: "matter", name: "Matter", integration: { permissions: ["scenes", "lan"] } } }, b.authed);
    const r = await b.json("POST", "/api/integrations/matter/enable", { on: true, approve: true }, b.authed);
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /trusted source/);
  } finally {
    b.close();
  }
});
