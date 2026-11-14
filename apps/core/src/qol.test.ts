// Box 0.16.0: closing time, scene sequences and extras, announcement presets, the status
// bar, and settings backup / restore.

import { createLogger } from "@bargames/common";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "./app.js";
import { AdminAuth } from "./auth.js";
import { createBackup, isEncrypted, packBackup, PENDING_FILE, resumePendingRestore, unpackBackup, writeCoreFiles } from "./backup.js";
import { CloudflareService } from "./cloudflare/service.js";
import { EventBus } from "./events.js";
import { GameRegistry } from "./games.js";
import { cleanClosing, cleanScene, closingSchedules, dueNow } from "./scenes.js";
import { NoopRuntime } from "./runtime/types.js";
import { openState } from "./state.js";

test("closing time: one scene per night; after-midnight times run the next morning", () => {
  const exists = (id: string) => id === "closing";
  assert.equal(typeof cleanClosing({ enabled: true, nights: ["", "", "", "", "", "02:00", "02:00"] }, exists), "string", "needs a scene");
  assert.match(String(cleanClosing({ enabled: true, sceneId: "closing", nights: ["", "", "", "", "", "", ""] }, exists)), /at least one night/);
  assert.match(String(cleanClosing({ enabled: false, nights: ["25:00", "", "", "", "", "", ""] }, exists)), /HH:MM/);
  const c = cleanClosing({ enabled: true, sceneId: "closing", nights: ["23:00", "", "", "", "", "02:00", ""] }, exists);
  assert.ok(typeof c !== "string");
  const s = closingSchedules(c);
  assert.deepEqual(
    s.map((x) => [x.days, x.time]),
    [
      [[0], "23:00"],
      [[6], "02:00"],
    ],
    "Sunday night at 23:00; Friday night's 02:00 is early Saturday",
  );
  // Saturday 02:00 New York time is due; Friday 02:00 isn't.
  const sat = new Date("2026-11-21T07:00:00Z");
  assert.equal(dueNow(s, sat, "America/New_York", {}).start.length, 1);
  assert.equal(dueNow(s, new Date("2026-11-20T07:00:00Z"), "America/New_York", {}).start.length, 0);
  assert.deepEqual(closingSchedules({ ...c, enabled: false }), []);
});

test("scenes: sequence and extras are validated", () => {
  const exists = { game: () => false, display: () => true, scene: (id: string) => id === "closing" };
  const ok = cleanScene({ id: "last-call", name: "Last call", actions: [], announcement: { text: "Last call!" }, stopSound: true, clearCountdown: true, next: { sceneId: "closing", afterMinutes: 15 } }, exists);
  assert.ok(typeof ok !== "string");
  assert.deepEqual([ok.stopSound, ok.clearCountdown, ok.next], [true, true, { sceneId: "closing", afterMinutes: 15 }]);
  assert.equal(ok.clearAnnouncement, undefined);
  assert.match(String(cleanScene({ id: "a", name: "A", actions: [], next: { sceneId: "a", afterMinutes: 5 } }, exists)), /follow itself/);
  assert.match(String(cleanScene({ id: "a", name: "A", actions: [], next: { sceneId: "nope", afterMinutes: 5 } }, exists)), /saved scene/);
  assert.match(String(cleanScene({ id: "a", name: "A", actions: [], next: { sceneId: "closing", afterMinutes: 0 } }, exists)), /1-240/);
});

test("backup: pack, encrypt, unpack, write back; game data waits for the game", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-backup-"));
  writeFileSync(path.join(dir, "venue.json"), JSON.stringify({ name: "Kava" }));
  writeFileSync(path.join(dir, "host-hooks.json"), "{}");
  writeFileSync(path.join(dir, "ops.token"), "secret");
  const b = await createBackup({
    dataDir: dir,
    boxVersion: "0.16.0",
    venueName: () => "Kava",
    gameIds: () => ["bingo", "gone"],
    brokerFiles: async () => ({ "displays.json": Buffer.from('{"displays":[]}').toString("base64") }),
    exportData: async (id) => {
      if (id === "gone") throw new Error("no container");
      return Buffer.from("tar-bytes");
    },
  });
  assert.deepEqual(Object.keys(b.core), ["venue.json"], "machine files (ops.token, host-hooks) stay out");
  assert.deepEqual(Object.keys(b.games), ["bingo"]);
  assert.equal(b.skipped.length, 1);

  const plain = packBackup(b);
  assert.equal(isEncrypted(plain), false);
  assert.equal(unpackBackup(plain).venue, "Kava");
  const locked = packBackup(b, "correct horse");
  assert.equal(isEncrypted(locked), true);
  assert.equal(locked.includes(Buffer.from("Kava")), false, "nothing readable without the passphrase");
  assert.throws(() => unpackBackup(locked), /passphrase/);
  assert.throws(() => unpackBackup(locked, "wrong horse"), /Wrong passphrase/);
  assert.equal(unpackBackup(locked, "correct horse").core["venue.json"], '{"name":"Kava"}');
  assert.throws(() => unpackBackup(Buffer.from("hello")), /isn't a Bar Games/);

  const target = mkdtempSync(path.join(tmpdir(), "bg-restore-"));
  assert.deepEqual(writeCoreFiles(target, unpackBackup(locked, "correct horse")), ["venue.json"]);
  assert.equal(readFileSync(path.join(target, "venue.json"), "utf8"), '{"name":"Kava"}');
  assert.ok(existsSync(path.join(target, PENDING_FILE)));

  // After the restart: bingo's container appears on the second look.
  const states = ["missing", "running"];
  const imported: string[] = [];
  const restarted: string[] = [];
  await resumePendingRestore({
    dataDir: target,
    state: async () => states.shift() ?? "running",
    importData: async (id, tar) => void imported.push(`${id}:${tar.toString()}`),
    restart: async (id) => void restarted.push(id),
    log: createLogger("t", "error"),
    pollMs: 5,
  });
  assert.deepEqual(imported, ["bingo:tar-bytes"]);
  assert.deepEqual(restarted, ["bingo"]);
  assert.equal(existsSync(path.join(target, PENDING_FILE)), false);
});

test("api: closing time, announcement presets, the status bar, backup download and restore", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-qol-"));
  const state = openState(dir);
  const games = new GameRegistry(state.games);
  const brokerPosts: { url: string; body: unknown }[] = [];
  const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.startsWith("http://broker/displays")) return reply([{ id: "tv1", name: "Bar", health: { online: true } }, { id: "tv2", name: "Patio", health: { online: false } }]);
    if (url === "http://broker/audio/sessions") return reply([{ id: "s1", state: "playing" }]);
    if (url === "http://broker/backup") return reply({ files: { "displays.json": Buffer.from("{}").toString("base64") } });
    if (init?.method === "POST" && url.startsWith("http://broker/")) {
      brokerPosts.push({ url, body });
      return reply({ ok: true });
    }
    if (url.includes("api.github.com")) return new Response("{}", { status: 404 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const app = createApp({
    state,
    games,
    runtime: new NoopRuntime(),
    bus: new EventBus(),
    auth: new AdminAuth(state.auth, "secret"),
    cloudflare: new CloudflareService({ store: state.cloudflare, connector: new NoopRuntime(), desiredHosts: () => [], tunnelName: () => "t", origin: "http://gw", log: createLogger("test", "error") }),
    log: createLogger("test", "error"),
    config: { gatewayToken: "gw", brokerUrl: "http://broker", brokerToken: "b", internalUrl: "http://core:7100", adminDist: path.join(dir, "none"), boxVersion: "0.16.0", dataDir: dir },
    fetch: fakeFetch,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const exit = process.exit;
  try {
    const cookie = (await call("POST", "/api/auth/setup", { password: "correct horse" })).headers.get("set-cookie")!.split(";")[0];
    const authed = { cookie };

    // Presets: three to start with; replaced as a list.
    assert.equal(((await (await call("GET", "/api/announcement-presets", undefined, authed)).json()) as { presets: unknown[] }).presets.length, 3);
    assert.equal((await call("PUT", "/api/announcement-presets", { presets: [{ text: "" }] }, authed)).status, 400);
    const saved = (await (await call("PUT", "/api/announcement-presets", { presets: [{ text: "Kitchen closes at 11", minutes: 30, show: "tvs" }] }, authed)).json()) as { presets: { id: string; text: string; show: string }[] };
    assert.deepEqual(saved.presets[0], { id: "preset-1", text: "Kitchen closes at 11", minutes: 30, show: "tvs" });

    // A sequence: "Last call" stops the music and queues "Closing".
    assert.equal((await call("PUT", "/api/scenes/closing", { name: "Closing", actions: [], endRooms: true }, authed)).status, 200);
    assert.equal((await call("PUT", "/api/scenes/last-call", { name: "Last call", actions: [], announcement: { text: "Last call!" }, stopSound: true, next: { sceneId: "closing", afterMinutes: 15 } }, authed)).status, 200);
    const steps = (await (await call("POST", "/api/scenes/last-call/apply", {}, authed)).json()) as { steps: { step: string }[] };
    assert.ok(steps.steps.some((s) => s.step === "sound stopped (s1)"));
    assert.ok(steps.steps.some((s) => s.step === "next: closing in 15 min"));
    assert.ok(brokerPosts.some((p) => p.url === "http://broker/audio/sessions/s1/stop"));
    const sched = (await (await call("GET", "/api/schedules", undefined, authed)).json()) as { sequences: { sceneId: string }[] };
    assert.deepEqual(sched.sequences.map((s) => s.sceneId), ["closing"]);

    // Closing time.
    assert.equal((await call("PUT", "/api/closing", { enabled: true, sceneId: "nope", nights: ["", "", "", "", "", "02:00", "02:00"] }, authed)).status, 400);
    assert.equal((await call("PUT", "/api/closing", { enabled: true, sceneId: "closing", nights: ["", "", "", "", "", "02:00", "02:00"] }, authed)).status, 200);

    // Status bar: the offline TV, the queued sequence.
    const status = (await (await call("GET", "/api/status", undefined, authed)).json()) as { items: { level: string; text: string; page: string }[] };
    assert.ok(status.items.some((i) => i.page === "tvs" && /Patio is offline/.test(i.text)));
    assert.ok(status.items.some((i) => i.page === "scenes" && /Closing in 15 min/.test(i.text)));
    assert.equal((await call("GET", "/api/status")).status, 401, "admins only");

    // Backup: download (encrypted), then restore it.
    assert.equal((await call("POST", "/api/backup", undefined, { ...authed, "x-backup-passphrase": "short" })).status, 400);
    const dl = await call("POST", "/api/backup", undefined, { ...authed, "x-backup-passphrase": encodeURIComponent("correct horse battery") });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-disposition")!, /bargames-settings-.*\.bgbackup/);
    const file = Buffer.from(await dl.arrayBuffer());
    assert.equal(isEncrypted(file), true);
    assert.ok(unpackBackup(file, "correct horse battery").core["closing.json"]);

    let exited = false;
    (process as { exit: unknown }).exit = () => void (exited = true);
    const bad = await fetch(base + "/api/backup/restore", { method: "POST", headers: { ...authed, "content-type": "application/octet-stream", "x-backup-passphrase": encodeURIComponent("wrong horse battery") }, body: file });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /Wrong passphrase/);
    const ok = await fetch(base + "/api/backup/restore", { method: "POST", headers: { ...authed, "content-type": "application/octet-stream", "x-backup-passphrase": encodeURIComponent("correct horse battery") }, body: file });
    assert.equal(ok.status, 200);
    const r = (await ok.json()) as { ok: boolean; broker: boolean; core: number };
    assert.equal(r.ok && r.broker, true);
    assert.ok(r.core > 3);
    assert.ok(brokerPosts.some((p) => p.url === "http://broker/backup/restore"));
    await new Promise((res) => setTimeout(res, 1100));
    assert.equal(exited, true, "core restarts to load the restored files");
  } finally {
    (process as { exit: unknown }).exit = exit;
    server.close();
  }
});
