import { createLogger } from "@bargames/common";
import { validateManifest, type GameManifest } from "@bargames/sdk";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type NextFunction, type Request, type Response } from "express";
import { AppAudio, checkAudioPath } from "./audio.js";
import { HttpError, type GameRegistry } from "./games.js";
import type { InstalledGame } from "./state.js";

function manifest(extra: Record<string, unknown> = {}): GameManifest {
  const r = validateManifest({ id: "music", name: "Music", kind: "app", version: "0.1.0", image: "x/music:0.1.0", port: 3009, sdk: { version: "0.13.0", level: 1 }, routes: { player: "/" }, audio: { play: true }, ...extra });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.manifest;
}

function game(id: string, m: GameManifest, enabled = true): InstalledGame {
  return { id, manifest: m, source: { kind: "url", ref: "x" }, verified: false, installedAt: "", updatedAt: "", enabled, branding: {}, token: `tok-${id}` } as InstalledGame;
}

interface Broker {
  calls: { method: string; sub: string; body?: unknown }[];
  outputs: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
}

async function setup(games: InstalledGame[], appFetch?: typeof fetch) {
  const broker: Broker = {
    calls: [],
    outputs: [
      { id: "box:0-0", kind: "box", name: "Box headphone jack", label: "Bar amp", available: true, default: true, volume: 60 },
      { id: "bt:11:22:33:44:55:66", kind: "bluetooth", name: "Patio Speaker", available: true, default: false, volume: 40 },
    ],
    sessions: [],
  };
  const registry = {
    get: (id: string) => games.find((g) => g.id === id),
    byToken: (t: string) => games.find((g) => g.token === t),
  } as unknown as GameRegistry;
  const audio = new AppAudio({
    games: registry,
    sourceBase: "http://127.0.0.1:7100",
    target: (g) => `http://bg-game-${g.id}:${g.manifest.port}`,
    fetch: appFetch ?? (async () => new Response("")),
    log: createLogger("t", "error"),
    brokerCall: async (method, sub, body) => {
      broker.calls.push({ method, sub, body });
      if (sub === "/audio/outputs") return broker.outputs;
      if (sub.startsWith("/audio/sessions?owner=")) return broker.sessions.filter((s) => s.owner === decodeURIComponent(sub.split("=")[1]));
      if (sub === "/audio/play") return { id: "s1", state: "starting", ...(body as object) };
      if (method === "PATCH") return { ...broker.outputs[0], ...(body as object) };
      return { ok: true };
    },
  });
  const app = express();
  app.use(express.json());
  audio.mount(app, (req) => {
    const g = registry.byToken(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!g) throw new HttpError(401, "bad game token");
    return g;
  });
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => res.status(err.status ?? 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token: string | undefined, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON (audio bytes)
    }
    return { status: r.status, json: json as Record<string, unknown> & Record<string, unknown>[], headers: r.headers, text };
  };
  return { broker, call, close: () => server.close() };
}

test("manifest: audio.play is validated, kept for apps and games, ignored for integrations", () => {
  assert.deepEqual(manifest().audio, { play: true });
  assert.equal(manifest({ audio: undefined }).audio, undefined);
  const bad = validateManifest({ ...manifest(), audio: { play: "yes" } });
  assert.equal(bad.ok, false);
  const integ = validateManifest({ id: "ha", name: "HA", kind: "integration", version: "0.1.0", image: "x/ha:0.1.0", sdk: { version: "0.13.0", level: 0 }, integration: { permissions: [] }, audio: { play: true } });
  assert.ok(integ.ok && integ.manifest.audio === undefined && integ.warnings.some((w) => w.startsWith("audio:")));
});

test("audio paths: only paths on the app's own server", () => {
  assert.equal(checkAudioPath("/tracks/12.mp3?v=2"), "/tracks/12.mp3?v=2");
  for (const bad of ["http://evil/x.mp3", "//evil/x.mp3", "tracks/1.mp3", "/a/../../etc", "/a b", "", 12]) assert.throws(() => checkAudioPath(bad), /path/);
});

test("app audio: needs audio.play and the app on; others get a 403 that says what to add", async () => {
  const t = await setup([game("music", manifest()), game("bingo", manifest({ id: "bingo", audio: undefined })), game("off", manifest({ id: "off" }), false)]);
  try {
    assert.equal((await t.call("GET", "/internal/audio/outputs", undefined)).status, 401);
    const no = await t.call("GET", "/internal/audio/outputs", "tok-bingo");
    assert.equal(no.status, 403);
    assert.match(String(no.json.error), /"audio": \{ "play": true \}/);
    assert.equal((await t.call("GET", "/internal/audio/outputs", "tok-off")).status, 403);
    const ok = await t.call("GET", "/internal/audio/outputs", "tok-music");
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json[0], { id: "box:0-0", name: "Bar amp", kind: "box", available: true, default: true, volume: 60 });
  } finally {
    t.close();
  }
});

test("app audio: play hands the broker a one-time source on core's loopback; busy outputs need replace", async () => {
  const t = await setup([game("music", manifest()), game("trivia", manifest({ id: "trivia", name: "Trivia" }))]);
  try {
    const r = await t.call("POST", "/internal/audio/play", "tok-music", { path: "/tracks/1.mp3", title: "Song", durationMs: 1000 });
    assert.equal(r.status, 200);
    const play = t.broker.calls.find((c) => c.sub === "/audio/play")!.body as Record<string, string>;
    assert.match(play.url, /^http:\/\/127\.0\.0\.1:7100\/internal\/audio\/source\/[0-9a-f]{48}$/);
    assert.equal(play.owner, "app:music");
    assert.equal(play.output, "box:0-0", "the venue's default");
    assert.equal(play.title, "Song");

    assert.equal((await t.call("POST", "/internal/audio/play", "tok-music", { path: "http://evil/x.mp3" })).status, 400);
    assert.equal((await t.call("POST", "/internal/audio/play", "tok-music", { path: "/a.mp3", output: "tv:nope" })).status, 404);

    t.broker.outputs[0].session = { id: "s9", owner: "app:trivia", state: "playing" };
    const busy = await t.call("POST", "/internal/audio/play", "tok-music", { path: "/a.mp3" });
    assert.equal(busy.status, 409);
    assert.match(String(busy.json.error), /Trivia is playing on Bar amp/);
    const outs = await t.call("GET", "/internal/audio/outputs", "tok-music");
    assert.equal(outs.json[0].busy, true);
    assert.equal((await t.call("POST", "/internal/audio/play", "tok-music", { path: "/a.mp3", replace: true })).status, 200);
  } finally {
    t.close();
  }
});

test("app audio: the source route fetches from the app with its token, passes Range, and dies with the app", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const apps = [game("music", manifest())];
  const t = await setup(apps, async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response("ID3audio", { status: 206, headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-7/100", "x-secret": "no" } });
  });
  try {
    await t.call("POST", "/internal/audio/play", "tok-music", { path: "/tracks/1.mp3" });
    const url = (t.broker.calls.find((c) => c.sub === "/audio/play")!.body as { url: string }).url;
    const path = new URL(url).pathname;
    const r = await t.call("GET", path, undefined, undefined, { range: "bytes=0-7" });
    assert.equal(r.status, 206);
    assert.equal(r.text, "ID3audio");
    assert.equal(r.headers.get("content-type"), "audio/mpeg");
    assert.equal(r.headers.get("content-range"), "bytes 0-7/100");
    assert.equal(r.headers.get("x-secret"), null, "only audio headers pass");
    assert.equal(seen[0].url, "http://bg-game-music:3009/tracks/1.mp3");
    assert.equal(seen[0].headers.get("authorization"), "Bearer tok-music");
    assert.equal(seen[0].headers.get("x-bargames-audio"), "1");
    assert.equal(seen[0].headers.get("range"), "bytes=0-7");

    assert.equal((await t.call("GET", "/internal/audio/source/" + "0".repeat(48), undefined)).status, 404);
    apps[0].enabled = false;
    assert.equal((await t.call("GET", path, undefined)).status, 404);
  } finally {
    t.close();
  }
});

test("app audio: apps control only their own sessions, and volume only where they play", async () => {
  const t = await setup([game("music", manifest()), game("trivia", manifest({ id: "trivia" }))]);
  try {
    t.broker.sessions.push({ id: "mine", owner: "app:music", state: "playing", output: "box:0-0" }, { id: "theirs", owner: "app:trivia", state: "playing", output: "bt:11:22:33:44:55:66" });
    assert.equal((await t.call("POST", "/internal/audio/sessions/theirs/stop", "tok-music")).status, 404);
    assert.equal((await t.call("POST", "/internal/audio/sessions/mine/pause", "tok-music")).status, 200);
    assert.ok(t.broker.calls.some((c) => c.sub === "/audio/sessions/mine/pause"));
    assert.equal(((await t.call("GET", "/internal/audio/sessions", "tok-music")).json as unknown[]).length, 1);

    assert.equal((await t.call("PUT", "/internal/audio/outputs/box:0-0/volume", "tok-music", { volume: 30 })).status, 403);
    t.broker.outputs[0].session = { id: "mine", owner: "app:music", state: "playing" };
    const v = await t.call("PUT", "/internal/audio/outputs/box:0-0/volume", "tok-music", { volume: 30 });
    assert.equal(v.status, 200);
    assert.equal(v.json.volume, 30);
    assert.equal((await t.call("PUT", "/internal/audio/outputs/box:0-0/volume", "tok-music", { volume: 300 })).status, 400);
  } finally {
    t.close();
  }
});
