import { createLogger, JsonStore } from "@bargames/common";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBrokerApp } from "./app.js";
import { MockDriver } from "./drivers/mock.js";
import { inputKey, parseApps, parseDeviceInfo, RokuEcp } from "./drivers/roku/ecp.js";
import { RokuDriver } from "./drivers/roku/index.js";
import { parseSsdpResponse } from "./drivers/roku/ssdp.js";
import { DisplayRegistry, type DisplayRecord } from "./registry.js";
import { PendingStreamService } from "./streams.js";

const DEVICE_INFO = `<?xml version="1.0" encoding="UTF-8" ?>
<device-info>
  <udn>29380007-0800-1025-80a4-d83134a1b2c3</udn>
  <serial-number>X0123456789</serial-number>
  <model-name>3930RW</model-name>
  <model-number>3930RW</model-number>
  <friendly-model-name>Roku Express</friendly-model-name>
  <user-device-name>Bench Roku &amp; Co</user-device-name>
  <is-tv>false</is-tv>
  <software-version>14.1.4</software-version>
  <power-mode>PowerOn</power-mode>
  <network-type>wifi</network-type>
  <developer-enabled>true</developer-enabled>
</device-info>`;

test("ssdp response parsing", () => {
  const hit = parseSsdpResponse("HTTP/1.1 200 OK\r\nCache-Control: max-age=3600\r\nST: roku:ecp\r\nLOCATION: http://192.168.1.50:8060/\r\nUSN: uuid:roku:ecp:X0123456789\r\n\r\n");
  assert.deepEqual(hit, { location: "http://192.168.1.50:8060/", usn: "uuid:roku:ecp:X0123456789", st: "roku:ecp", server: undefined });
  assert.equal(parseSsdpResponse("NOTIFY * HTTP/1.1\r\n"), null);
});

test("ecp parsing", () => {
  const info = parseDeviceInfo(DEVICE_INFO);
  assert.equal(info.friendlyName, "Bench Roku & Co");
  assert.equal(info.isTv, false);
  assert.equal(info.developerEnabled, true);
  assert.equal(info.supportsAirplay, undefined);
  assert.deepEqual(parseApps('<apps><app id="12" type="appl" version="1">Netflix</app><app id="dev" type="appl">Bar Games</app></apps>'), [
    { id: "12", name: "Netflix" },
    { id: "dev", name: "Bar Games" },
  ]);
  assert.equal(inputKey("HDMI3"), "InputHDMI3");
  assert.throws(() => inputKey("hdmi9"));
});

test("roku tv: input and antenna channel stop the cast and are recorded as what the TV shows", async () => {
  const calls: string[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}${new URL(String(input)).search}`);
    return new Response("");
  }) as typeof fetch;
  const stopped: string[] = [];
  const streams = Object.assign(new PendingStreamService(), { stopFor: async (id: string) => void stopped.push(id), state: () => ({ delivery: "airplay" as const, url: "x", state: "streaming", needsCode: false }) });
  const roku = new RokuDriver(streams, doFetch);
  const dir = mkdtempSync(path.join(tmpdir(), "roku-tv-"));
  const reg = new DisplayRegistry(
    new JsonStore<{ displays: DisplayRecord[] }>(path.join(dir, "d.json"), {
      displays: [
        { id: "roku:TV1", driver: "roku", name: "Bar TV", address: "http://192.0.2.60:8060", isTv: true },
        { id: "roku:P1", driver: "roku", name: "Stick", address: "http://192.0.2.61:8060", isTv: false },
      ],
    }),
    new Map([["roku", roku]]),
  );
  assert.equal((await roku.capabilities(reg.get("roku:TV1")!)).tvChannels, true);
  assert.equal((await roku.capabilities(reg.get("roku:P1")!)).tvChannels, false);
  await reg.tuneChannel("roku:TV1", "7.1");
  await reg.setInput("roku:TV1", "hdmi2");
  assert.deepEqual(calls, ["POST /launch/tvinput.dtv?ch=7.1", "POST /keypress/InputHDMI2"]);
  assert.deepEqual(stopped, ["roku:TV1", "roku:TV1"], "the cast stops first");
  assert.deepEqual(reg.get("roku:TV1")!.content, { kind: "external", provider: "remote", app: "HDMI 2" });
  await assert.rejects(reg.tuneChannel("roku:P1", "7"), /can't tune/);
  await assert.rejects(reg.setInput("roku:TV1", "hdmi9"), /no input/);
});

test("ecp client against a fake Roku", async () => {
  const calls: string[] = [];
  const fake = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === "/query/device-info") return void res.end(DEVICE_INFO);
    if (req.url === "/keypress/PowerOff") return void res.writeHead(403).end();
    res.end("");
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  try {
    const ecp = new RokuEcp(base);
    assert.equal((await ecp.deviceInfo()).modelNumber, "3930RW");
    await ecp.launch("dev", { url: "http://box/x.m3u8" });
    await ecp.setInput("hdmi3");
    await assert.rejects(ecp.powerOff(), /Permissive/);
    assert.deepEqual(calls.slice(1, 3), ["POST /launch/dev?url=http%3A%2F%2Fbox%2Fx.m3u8", "POST /keypress/InputHDMI3"]);

    const drv = new RokuDriver(new PendingStreamService());
    const dev = await drv.probe(base);
    assert.equal(dev.id, "roku:X0123456789");
    const caps = await drv.capabilities(dev);
    assert.deepEqual(caps.delivery, ["airplay", "roku-hls"]);
    assert.deepEqual(caps.inputs, [], "players have no inputs");
    const r = await drv.show(dev, { kind: "url", url: "http://x" }, "airplay");
    assert.equal(r.ok, false, "airplay is stubbed until Phase 3");
  } finally {
    fake.close();
  }
});

test("broker api with mock displays", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-broker-"));
  const mock = new MockDriver(3);
  const registry = new DisplayRegistry(new JsonStore<{ displays: DisplayRecord[] }>(path.join(dir, "d.json"), { displays: [] }), new Map([["mock", mock]]));
  const server = createBrokerApp({ registry, token: "tk", log: createLogger("t", "error") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, p: string, body?: unknown) =>
    fetch(base + p, { method, headers: { authorization: "Bearer tk", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await fetch(`${base}/displays`)).status, 401);
    assert.deepEqual(await (await call("POST", "/discover")).json(), { found: 3, errors: [], replaced: {} });
    await call("PATCH", "/displays/mock:tv1", { label: "Bar left", group: "main" });
    await call("PATCH", "/displays/mock:tv2", { group: "main" });
    const shown = (await (await call("POST", "/show", { group: "main", content: { kind: "url", url: "http://bingo.localhost:7080/room/AB12?role=table" } })).json()) as Record<string, { ok: boolean }>;
    assert.deepEqual(Object.keys(shown).sort(), ["mock:tv1", "mock:tv2"]);
    assert.equal(mock.shown.size, 2);
    assert.equal((await call("POST", "/show", { group: "main", content: { kind: "url", url: "javascript:alert(1)" } })).status, 400);
    await call("POST", "/displays/mock:tv3/power", { on: false });
    const list = (await (await call("GET", "/displays?health=1")).json()) as { id: string; label?: string; health: { powerMode: string } }[];
    assert.equal(list.find((d) => d.id === "mock:tv1")!.label, "Bar left");
    assert.equal(list.find((d) => d.id === "mock:tv3")!.health.powerMode, "DisplayOff");
  } finally {
    server.close();
  }
});

test("roku remote: only its own keys, volume on TVs only, typing; the broker routes", async () => {
  const calls: string[] = [];
  const fake = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === "/query/device-info") return void res.end(DEVICE_INFO);
    res.end("");
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "bg-broker-"));
  const roku = new RokuDriver(new PendingStreamService());
  const registry = new DisplayRegistry(new JsonStore<{ displays: DisplayRecord[] }>(path.join(dir, "displays.json"), { displays: [] }), new Map([["roku", roku]]));
  const app = createBrokerApp({ registry, roku, token: "t", log: createLogger("test", "error") });
  const server = app.listen(0);
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, body: unknown) => fetch(api + p, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const dev = await roku.probe(base);
    const caps = await roku.capabilities(dev);
    assert.ok(caps.remoteKeys?.includes("Select") && caps.remoteKeys.includes("Home"));
    assert.ok(!caps.remoteKeys?.includes("VolumeUp"), "a player has no volume");
    assert.ok((await roku.capabilities({ ...dev, isTv: true })).remoteKeys?.includes("VolumeUp"));

    await registry.merge([dev]);
    const id = encodeURIComponent(dev.id);
    calls.length = 0;
    assert.equal((await post(`/displays/${id}/key`, { key: "Up" })).status, 200);
    assert.equal((await post(`/displays/${id}/key`, { key: "PowerOff" })).status, 400, "power has its own control");
    assert.equal((await post(`/displays/${id}/key`, { key: "../launch/dev" })).status, 400);
    assert.equal((await post(`/displays/${id}/text`, { text: "ab c" })).status, 200);
    assert.equal((await post(`/displays/${id}/text`, { text: "" })).status, 400);
    assert.deepEqual(
      calls.filter((c) => c.startsWith("POST")),
      ["POST /keypress/Up", "POST /keypress/Lit_a", "POST /keypress/Lit_b", "POST /keypress/Lit_%20", "POST /keypress/Lit_c"],
    );

    // Not casting: no preview (204). Settings: validated, saved, cleared with null.
    const pv = await fetch(`${api}/displays/${id}/preview`, { headers: { authorization: "Bearer t" } });
    assert.equal(pv.status, 204);
    const patch = (body: unknown) => fetch(`${api}/displays/${id}`, { method: "PATCH", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await patch({ streamSettings: { resolution: "4k", fps: 30 } })).status, 400);
    assert.equal((await patch({ streamSettings: { resolution: "720p", fps: 45 } })).status, 400);
    assert.equal((await patch({ streamSettings: { resolution: "720p", fps: 15, bitrateKbps: 100 } })).status, 400);
    assert.deepEqual(((await (await patch({ streamSettings: { resolution: "720p", fps: 15, bitrateKbps: 2000 } })).json()) as DisplayRecord).streamSettings, { resolution: "720p", fps: 15, bitrateKbps: 2000 });
    assert.equal(((await (await patch({ streamSettings: null })).json()) as DisplayRecord).streamSettings, undefined);
  } finally {
    server.close();
    fake.close();
  }
});

test("local screens: connected outputs from sysfs; showing starts cage + Chromium on that output", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { LocalScreenDriver, readConnectors } = await import("./drivers/local/index.js");
  const drm = mkdtempSync(path.join(tmpdir(), "bg-drm-"));
  const port = (name: string, status: string, modes: string) => {
    mkdirSync(path.join(drm, name));
    writeFileSync(path.join(drm, name, "status"), `${status}\n`);
    writeFileSync(path.join(drm, name, "modes"), modes);
  };
  port("card0-HDMI-A-1", "connected", "3840x2160\n1920x1080\n1920x1080\n");
  port("card0-DP-1", "disconnected", "");
  mkdirSync(path.join(drm, "renderD128"));
  assert.deepEqual(readConnectors(drm).map((c) => [c.name, c.connected, c.modes]), [
    ["DP-1", false, []],
    ["HDMI-A-1", true, ["3840x2160", "1920x1080"]],
  ]);
  assert.deepEqual(readConnectors(path.join(drm, "missing")), [], "no DRM: nothing");
  const bare = new LocalScreenDriver({ drmDir: drm });
  const [screen] = await bare.discover();
  assert.equal(screen.id, "local:HDMI-A-1");
  assert.equal(screen.model, "up to 3840x2160");
  assert.equal((await bare.show(screen, { kind: "url", url: "http://x" })).ok, false, "no cage in this image: says so");
  assert.equal((await bare.health(screen)).online, true);

  const spawned: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  const runner = {
    spawn: (_tag: string, cmd: string, args: string[], env: Record<string, string> = {}) => {
      spawned.push({ cmd, args, env });
      return { alive: true, tail: () => [], kill: () => undefined };
    },
    ctl: async () => ({ ok: true }),
    waitForDisplay: async () => undefined,
    cleanSlot: () => undefined,
    sleep: async () => undefined,
  };
  const drv = new LocalScreenDriver({ drmDir: drm, runner, runDir: mkdtempSync(path.join(tmpdir(), "bg-local-")), debugPort: 1 });
  const r = await drv.show(screen, { kind: "url", url: "http://play.example.com/bingo/tv" });
  assert.equal(r.ok, true);
  assert.equal(spawned[0].cmd, "cage");
  assert.equal(spawned[0].args.at(-1), "http://play.example.com/bingo/tv");
  assert.ok(spawned[0].args.includes("--ozone-platform=wayland"));
  assert.equal(spawned[0].env.WLR_DRM_DEVICES, "/dev/dri/card0");
  assert.equal(spawned[0].env.LIBSEAT_BACKEND, "seatd");
  assert.equal((await drv.show(screen, { kind: "external", provider: "youtube", app: "youtube" })).ok, false);
  const [dp] = [{ ...screen, id: "local:DP-1" }];
  assert.equal((await drv.show(dp, { kind: "off" })).ok, false, "unplugged screen");
});

test("system: host network interfaces from /proc/net/dev (bridges and veths left out)", async () => {
  const { hostInterfaces } = await import("./app.js");
  const dev = "Inter-|   Receive\n face |bytes    packets\n    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n  eno1: 5000 10 0 0 0 0 0 0 7000 9 0 0 0 0 0 0\ntailscale0: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0\ndocker0: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\nveth12ab: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n";
  assert.deepEqual(hostInterfaces(dev), [
    { name: "eno1", rxBytes: 5000, txBytes: 7000 },
    { name: "tailscale0", rxBytes: 300, txBytes: 400 },
  ]);
});

test("venuebox: pair by code, connect, get shows per screen, hotplug, preview, revoke", async () => {
  const { WebSocket } = await import("ws");
  const { DeviceStore, Pairings } = await import("./venuebox/devices.js");
  const { VenueboxHub } = await import("./venuebox/hub.js");
  const { playable } = await import("./registry.js");
  const dir = mkdtempSync(path.join(tmpdir(), "bg-vb-"));
  const drivers = new Map();
  const registry = new DisplayRegistry(new JsonStore<{ displays: DisplayRecord[] }>(path.join(dir, "displays.json"), { displays: [] }), drivers);
  const hub = new VenueboxHub({
    devices: new DeviceStore(new JsonStore(path.join(dir, "devices.json"), { devices: [] })),
    pairings: new Pairings(),
    log: createLogger("test", "error"),
    boxName: () => "Test box",
    displaysChanged: async (found, removed) => {
      await registry.merge(found);
      await registry.removeMany(removed);
    },
    reconnected: (ids) => {
      for (const id of ids) {
        const d = registry.get(id);
        if (d?.content && playable(d.content).kind === "url") void registry.show({ displayIds: [id] }, d.content);
      }
    },
  });
  drivers.set(hub.id, hub);
  const server = hub.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = createBrokerApp({ registry, venuebox: hub, token: "t", log: createLogger("test", "error") });
  const api = app.listen(0);
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const admin = (method: string, p: string, body?: unknown) =>
    fetch(apiBase + p, { method, headers: { authorization: "Bearer t", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const screens = [{ id: "1", name: "HDMI 1", w: 1920, h: 1080, hz: 60 }];
  try {
    assert.equal(((await (await fetch(base + "/health")).json()) as { protocol: number }).protocol, 1);
    assert.equal((await fetch(base + "/pair/start", { method: "POST", body: JSON.stringify({ name: "Bar PC" }) })).status, 400, "screens required");
    const start = (await (await fetch(base + "/pair/start", { method: "POST", body: JSON.stringify({ name: "Bar PC", platform: "windows", screens }) })).json()) as { pairingId: string; code: string };
    assert.match(start.code, /^\d{6}$/);
    assert.deepEqual(await (await fetch(`${base}/pair/status?id=${start.pairingId}`)).json(), { status: "pending" });
    assert.equal((await admin("POST", "/venuebox/pair", { code: "000000" === start.code ? "111111" : "000000" })).status, 404, "wrong code");
    const paired = (await (await admin("POST", "/venuebox/pair", { code: start.code, name: "Patio PC" })).json()) as { id: string; name: string };
    assert.equal(paired.name, "Patio PC");
    const approved = (await (await fetch(`${base}/pair/status?id=${start.pairingId}`)).json()) as { status: string; token: string; wsPath: string };
    assert.equal(approved.status, "approved");
    assert.equal((await fetch(`${base}/pair/status?id=${start.pairingId}`)).status, 404, "the token is handed out once");
    const displayId = `venuebox:${paired.id}:1`;
    assert.ok(registry.get(displayId), "its screen is a display right away");

    // Bad token: refused.
    const bad = new WebSocket(base.replace("http", "ws") + "/client");
    const badClose = new Promise<number>((r) => bad.on("close", (code) => r(code)));
    bad.on("open", () => bad.send(JSON.stringify({ type: "hello", v: 1, token: "x".repeat(40), platform: "windows", screens, deliveries: ["native-url"] })));
    assert.equal(await badClose, 4401);

    // The real client.
    const ws = new WebSocket(base.replace("http", "ws") + approved.wsPath);
    const inbox: Record<string, unknown>[] = [];
    const next = (type: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const hit = inbox.find((m) => m.type === type);
        if (hit) return resolve(inbox.splice(inbox.indexOf(hit), 1)[0]);
        const on = (raw: Buffer) => {
          const m = JSON.parse(String(raw));
          if (m.type !== type) return void inbox.push(m);
          ws.off("message", on);
          resolve(m);
        };
        ws.on("message", on);
      });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", v: 1, token: approved.token, platform: "windows", appVersion: "0.1.0", screens, deliveries: ["native-url"] }));
    const welcome = await next("welcome");
    assert.equal(welcome.name, "Patio PC");
    assert.equal(((await hub.health(registry.get(displayId)!)) as { online: boolean }).online, true);

    // Casting to the screen sends it a show.
    const shown = registry.show({ displayIds: [displayId] }, { kind: "url", url: "https://bingo.example.com/room/AB?role=table", title: "Bingo · AB" });
    const show = await next("show");
    assert.deepEqual(show, { type: "show", screen: "1", url: "https://bingo.example.com/room/AB?role=table", kind: "native-url", title: "Bingo · AB" });
    assert.equal((await shown)[displayId].ok, true);
    ws.send(JSON.stringify({ type: "state", screen: "1", showing: "https://bingo.example.com/room/AB?role=table", status: "playing" }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hub.streamState(registry.get(displayId)!)?.state, "streaming");

    // Preview round trip.
    const pv = hub.preview(registry.get(displayId)!);
    const req = await next("preview");
    ws.send(JSON.stringify({ type: "preview", requestId: req.requestId, screen: "1", jpeg: Buffer.from("JPEGDATA").toString("base64") }));
    assert.equal(String(await pv), "JPEGDATA");

    // A second TV plugged into the PC: a new display; the first one is untouched.
    ws.send(JSON.stringify({ type: "screens", screens: [...screens, { id: "2", name: "HDMI 2", w: 1280, h: 720 }] }));
    await next("welcome");
    assert.ok(registry.get(`venuebox:${paired.id}:2`), "the new screen is a display");
    assert.equal(((await (await admin("GET", "/venuebox")).json()) as { devices: { online: boolean; screens: unknown[] }[] }).devices[0].screens.length, 2);

    // Revoked: told, disconnected, its displays gone, and its token no longer works.
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    assert.equal((await admin("DELETE", `/venuebox/devices/${paired.id}`)).status, 200);
    assert.equal(await closed, 4403);
    assert.equal(registry.get(displayId), undefined);
    assert.equal(registry.get(`venuebox:${paired.id}:2`), undefined);
  } finally {
    hub.close();
    server.close();
    api.close();
  }
});

test("0.9.0: Roku launches YouTube (837), explains a 403, and reads YouTube's DIAL screen id", async () => {
  const calls: string[] = [];
  let block = false;
  const fake = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === "/query/device-info") return void res.end(DEVICE_INFO);
    // Like a real Roku: DIAL without an Origin is refused.
    if (req.url === "/dial/YouTube" && !req.headers.origin) return void res.writeHead(403).end();
    if (req.url === "/dial/YouTube") return void res.end('<?xml version="1.0"?><service xmlns="urn:dial-multiscreen-org:schemas:dial"><name>YouTube</name><state>running</state><additionalData><screenId>abc123screen</screenId></additionalData></service>');
    if (req.url === "/query/apps") return void res.end('<apps><app id="837" type="appl" version="2">YouTube</app><app id="12" type="appl" version="1">Netflix &amp; Co</app></apps>');
    if (req.url === "/query/active-app") return void res.end('<active-app><app id="12">Netflix</app></active-app>');
    if (req.url === "/query/icon/12") return void res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([0x89, 0x50]));
    if (req.url?.startsWith("/query/icon/")) return void res.writeHead(404).end();
    if (req.url?.startsWith("/launch/")) return void (block ? res.writeHead(403).end() : res.end(""));
    res.end("");
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "bg-launch-"));
  const roku = new RokuDriver(new PendingStreamService());
  const registry = new DisplayRegistry(new JsonStore<{ displays: DisplayRecord[] }>(path.join(dir, "displays.json"), { displays: [] }), new Map([["roku", roku]]));
  try {
    const dev = await roku.probe(base);
    await registry.merge([dev]);
    assert.deepEqual(roku.launchableApps(), ["youtube"]);
    assert.deepEqual(await registry.launchApp(dev.id, "youtube", "youtube-app", "Friday mix"), { ok: true });
    assert.ok(calls.includes("POST /launch/837"));
    assert.deepEqual(registry.get(dev.id)?.content, { kind: "external", provider: "youtube-app", app: "youtube", title: "Friday mix" });
    assert.equal((await registry.launchApp(dev.id, "netflix", "x")).ok, false);
    block = true;
    const blocked = await registry.launchApp(dev.id, "youtube", "youtube-app");
    assert.equal(blocked.ok, false);
    assert.equal(!blocked.ok && blocked.reason, "ecp-blocked");
    assert.equal(await registry.dialScreenId(dev.id, "youtube"), "abc123screen");
    const dialCalls = calls.filter((c) => c === "GET /dial/YouTube").length;
    await registry.dialScreenId(dev.id, "youtube");
    assert.equal(calls.filter((c) => c === "GET /dial/YouTube").length, dialCalls, "cached");
    assert.ok(!calls.some((c) => c.startsWith("POST /dial")), "DIAL is read-only: never launches");

    // The remote's Apps list: installed channels, the one on screen, icons, launching any of them.
    block = false;
    assert.deepEqual(await registry.listApps(dev.id), { apps: [{ id: "837", name: "YouTube" }, { id: "12", name: "Netflix & Co" }], active: "12" });
    assert.deepEqual(await registry.appIcon(dev.id, "12"), { type: "image/png", data: Buffer.from([0x89, 0x50]) });
    const iconCalls = calls.filter((c) => c === "GET /query/icon/12").length;
    await registry.appIcon(dev.id, "12");
    assert.equal(calls.filter((c) => c === "GET /query/icon/12").length, iconCalls, "icons are cached");
    assert.equal(await registry.appIcon(dev.id, "999"), undefined);
    assert.deepEqual(await roku.foregroundApp(registry.get(dev.id)!), { id: "12", name: "Netflix", home: false });
    await registry.launchChannel(dev.id, "12");
    assert.ok(calls.includes("POST /launch/12"));
    assert.deepEqual(registry.get(dev.id)?.content, { kind: "external", provider: "remote", app: "Netflix & Co" });
  } finally {
    fake.close();
  }
});

test("broker listen hosts: IPs and interface names; anything unresolved falls back to all", async () => {
  const { listenHosts } = await import("./listen.js");
  const ifaces = {
    lo: [{ address: "127.0.0.1", family: "IPv4" }],
    docker0: [{ address: "fe80::1", family: "IPv6" }, { address: "172.17.0.1", family: "IPv4" }],
    tun0: [{ address: "fd00::1", family: "IPv6" }],
  } as unknown as Parameters<typeof listenHosts>[1];
  const none = () => ({});
  assert.deepEqual(listenHosts("127.0.0.1,docker0", ifaces, none), { hosts: ["127.0.0.1", "172.17.0.1"] });
  assert.deepEqual(listenHosts(" 127.0.0.1 , 127.0.0.1 ", ifaces, none), { hosts: ["127.0.0.1"] });
  assert.deepEqual(listenHosts(undefined, ifaces, none), { hosts: ["0.0.0.0"] });
  assert.deepEqual(listenHosts("127.0.0.1,0.0.0.0", ifaces, none), { hosts: ["0.0.0.0"] });
  const missing = listenHosts("127.0.0.1,docker9", ifaces, none);
  assert.deepEqual(missing.hosts, ["0.0.0.0"], "never lose the broker: listen everywhere");
  assert.match(missing.problem!, /docker9/);
  assert.deepEqual(listenHosts("tun0", ifaces, none).hosts, ["0.0.0.0"], "IPv6-only interface: not usable");

  // The real case: docker0 has no carrier (no container on the default bridge), so Node
  // doesn't list it. Its address comes from the kernel's tables (as read on the bench box).
  const { addressFromProc } = await import("./listen.js");
  const proc = {
    route: `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
eno1	00000000	010200C0	0003	0	0	100	00000000	0	0	0
eno1	000200C0	00000000	0001	0	0	100	00FFFFFF	0	0	0
docker0	000011AC	00000000	0001	0	0	0	0000FFFF	0	0	0
`,
    fibTrie: `Main:
  +-- 0.0.0.0/0 3 0 5
     |-- 0.0.0.0
        /0 universe UNICAST
Local:
  +-- 0.0.0.0/0 2 0 2
     +-- 127.0.0.0/8 2 0 2
        |-- 127.0.0.1
           /32 host LOCAL
     +-- 172.17.0.0/16 2 0 2
        |-- 172.17.0.1
           /32 host LOCAL
        |-- 172.17.255.255
           /32 link BROADCAST
     |-- 192.0.2.13
        /32 host LOCAL
`,
  };
  const noDocker0 = { lo: ifaces!.lo } as typeof ifaces;
  assert.equal(addressFromProc("docker0", proc), "172.17.0.1");
  assert.equal(addressFromProc("eno1", proc), "192.0.2.13", "the default route's line is skipped");
  assert.equal(addressFromProc("wlan9", proc), undefined);
  assert.equal(addressFromProc("docker0", {}), undefined, "off Linux: no tables");
  assert.deepEqual(listenHosts("127.0.0.1,docker0", noDocker0, () => proc), { hosts: ["127.0.0.1", "172.17.0.1"] });
});

test("ignored TVs (box 0.15.2): left out, never contacted, refused for casting; detach-all stops every TV", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-ignore-"));
  const mock = new MockDriver(3);
  let healthCalls = 0;
  const health = mock.health.bind(mock);
  mock.health = async (d) => (healthCalls++, health(d));
  const registry = new DisplayRegistry(new JsonStore<{ displays: DisplayRecord[] }>(path.join(dir, "displays.json"), { displays: [] }), new Map([["mock", mock]]));
  await registry.discover();
  await registry.patch("mock:tv1", { group: "Bar" });
  await registry.patch("mock:tv2", { group: "Bar" });
  await registry.show({ displayIds: ["mock:tv1", "mock:tv2", "mock:tv3"] }, { kind: "url", url: "http://x/tv" });

  const ig = await registry.setIgnored("mock:tv2", true);
  assert.equal(ig.ignored, true);
  assert.equal(ig.content, undefined, "what it showed is cleared");
  assert.equal(mock.shown.has("mock:tv2"), false, "its cast stopped");

  healthCalls = 0;
  const views = await registry.view(true);
  assert.deepEqual(views.map((v) => v.id), ["mock:tv1", "mock:tv3"], "left out of lists");
  assert.equal(healthCalls, 2, "and never checked on");
  const withIgnored = await registry.view(true, true);
  assert.equal(withIgnored.find((v) => v.id === "mock:tv2")?.ignored, true);
  assert.equal(healthCalls, 4, "still not checked on when listed for the TVs page");

  assert.match((await registry.show({ displayIds: ["mock:tv2"] }, { kind: "url", url: "http://x/y" }))["mock:tv2"].message!, /ignored/);
  assert.deepEqual(Object.keys(await registry.show({ group: "Bar" }, { kind: "idle", url: "http://x/idle" })), ["mock:tv1"], "a room skips it");

  // Rediscovery keeps it ignored; un-ignoring brings it back with its name and room.
  await registry.discover();
  assert.equal(registry.get("mock:tv2")?.ignored, true);
  const back = await registry.setIgnored("mock:tv2", false);
  assert.equal(back.ignored, undefined);
  assert.equal(back.group, "Bar");

  // Detach from every TV: all casts stop, nothing is powered off, nothing comes back after a restart.
  await registry.show({ displayIds: ["mock:tv1", "mock:tv2", "mock:tv3"] }, { kind: "url", url: "http://x/tv" });
  const r = await registry.detachAll();
  assert.equal(r.stopped.length, 3);
  assert.equal(mock.shown.size, 0);
  assert.equal(mock.powered.size, 0, "no power commands");
  assert.ok(registry.list().every((d) => !d.content));
  await registry.resume();
  assert.equal(mock.shown.size, 0);
});
