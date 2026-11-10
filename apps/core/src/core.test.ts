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
import { certificateWarning, checkPattern, renderHostname } from "./hostnames.js";
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

    assert.equal((await json("GET", "/internal/gateway-config")).status, 401);
    const gw = (await (await json("GET", "/internal/gateway-config", undefined, { authorization: "Bearer gw" })).json()) as { routes: { host: string; kind: string; target?: string }[] };
    assert.deepEqual(
      gw.routes.map((r) => [r.host, r.kind]),
      [
        ["admin.localhost", "admin"],
        ["play.localhost", "hub"],
        ["kavabingo.localhost", "game"],
      ],
    );
    assert.equal(gw.routes[2].target, "http://127.0.0.1:7300");

    const badVenue = await json("PUT", "/api/venue", { hostnamePattern: "{domain}" }, authed);
    assert.equal(badVenue.status, 400);
    const deep = (await (await json("PUT", "/api/venue", { domain: "example.com", hostnamePattern: "{game}.internal.{domain}" }, authed)).json()) as { warnings: string[] };
    assert.ok(deep.warnings.some((w) => w.includes("Advanced Certificate Manager")));
  } finally {
    server.close();
  }
});
