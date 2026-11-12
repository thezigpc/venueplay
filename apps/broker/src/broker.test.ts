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
    assert.deepEqual(await (await call("POST", "/discover")).json(), { found: 3, errors: [] });
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

test("local screens (scaffolding): connected outputs from sysfs, nothing shown yet", async () => {
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
  const drv = new LocalScreenDriver(drm);
  const [screen] = await drv.discover();
  assert.equal(screen.id, "local:HDMI-A-1");
  assert.equal(screen.model, "up to 3840x2160");
  assert.equal((await drv.show(screen, { kind: "url", url: "http://x" })).ok, false);
  assert.equal((await drv.health(screen)).online, true);
});

test("system: host network interfaces from /proc/net/dev (bridges and veths left out)", async () => {
  const { hostInterfaces } = await import("./app.js");
  const dev = "Inter-|   Receive\n face |bytes    packets\n    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n  eno1: 5000 10 0 0 0 0 0 0 7000 9 0 0 0 0 0 0\ntailscale0: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0\ndocker0: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\nveth12ab: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n";
  assert.deepEqual(hostInterfaces(dev), [
    { name: "eno1", rxBytes: 5000, txBytes: 7000 },
    { name: "tailscale0", rxBytes: 300, txBytes: 400 },
  ]);
});
