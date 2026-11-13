import { JsonStore } from "@bargames/common";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DisplayRegistry, type DisplayRecord } from "../../registry.js";
import { PendingStreamService } from "../../streams.js";
import type { DisplayDriver } from "../../types.js";
import { AirplayDriver } from "../airplay/index.js";
import { offeredInputs, VizioDriver, type VizioAuth } from "./index.js";
import { vizioInputName, type VizioTransport } from "./smartcast.js";

const ok = (extra: Record<string, unknown> = {}) => ({ status: 200, body: { STATUS: { RESULT: "SUCCESS", DETAIL: "Success" }, ...extra } });

/** A fake SmartCast TV: PIN 1234, token "tok-1", input HDMI-1. */
function fakeTv() {
  const calls: { method: string; path: string; auth?: string; body?: unknown }[] = [];
  const tv = { paired: new Set<string>(), input: "HDMI-1", on: true };
  const transport: VizioTransport = async ({ method, path: p, auth, body }) => {
    calls.push({ method, path: p, auth, body });
    if (p === "/state/device/deviceinfo")
      return ok({ ITEMS: [{ VALUE: { MODEL_NAME: "V435-J01", CAST_NAME: "Patio TV", INPUTS: ["hwtuner", "comp", "hdmi1", "hdmi2", "hdmi3", "cast", "airplay", "tuner"], SYSTEM_INFO: { DIID: "0000aaaa-1111-2222-3333-444455556666", VERSION: "1.0.0" } } }] });
    if (p === "/state/device/power_mode") return ok({ ITEMS: [{ VALUE: tv.on ? 1 : 0 }] });
    if (p === "/pairing/start") return ok({ ITEM: { PAIRING_REQ_TOKEN: 42, CHALLENGE_TYPE: 1 } });
    if (p === "/pairing/pair") {
      const b = body as { RESPONSE_VALUE: string; PAIRING_REQ_TOKEN: number };
      if (b.RESPONSE_VALUE !== "1234" || b.PAIRING_REQ_TOKEN !== 42) return { status: 400, body: { STATUS: { RESULT: "INVALID_PIN" } } };
      tv.paired.add("tok-1");
      return ok({ ITEM: { AUTH_TOKEN: "tok-1" } });
    }
    if (!auth || !tv.paired.has(auth)) return { status: 403, body: { STATUS: { RESULT: "REQUIRES_PAIRING" } } };
    if (p === "/key_command/") return ok();
    if (p.endsWith("/current_input")) {
      if (method === "PUT") tv.input = (body as { VALUE: string }).VALUE;
      return ok({ ITEMS: [{ VALUE: tv.input, HASHVAL: 777 }] });
    }
    return { status: 404, body: {} };
  };
  return { calls, tv, transport };
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "vizio-"));
  const fake = fakeTv();
  const auth = new JsonStore<VizioAuth>(path.join(dir, "vizio-auth.json"), { clientId: "", tokens: {} }, 0o600);
  const browse = async () => [{ name: "Patio TV", fqdn: "Patio TV._viziocast._tcp.local", address: "192.0.2.40", port: 7345, txt: { did: "0000AAAA-1111-2222-3333-444455556666", name: "Patio TV", mdl: "V435-J01", hsp: "7345" } }];
  const vizio = new VizioDriver(new PendingStreamService(), auth, { transport: fake.transport, browse });
  return { dir, fake, auth, vizio };
}

test("vizio input names", () => {
  assert.equal(vizioInputName("hdmi2"), "HDMI-2");
  assert.equal(vizioInputName("tuner"), "TV");
  assert.equal(vizioInputName("cast"), "CAST");
  assert.deepEqual(offeredInputs(["hwtuner", "comp", "hdmi1", "hdmi2", "usb", "cast", "airplay", "tuner", "Player 1"]), ["cast", "comp", "hdmi1", "hdmi2", "tuner"]);
  assert.deepEqual(offeredInputs(undefined), ["cast", "hdmi1", "hdmi2", "hdmi3"]);
});

test("vizio: discovery, PIN pairing, power, input, keys", async () => {
  const { fake, auth, vizio } = setup();
  const [dev] = await vizio.discover(10);
  assert.ok(dev);
  assert.equal(dev.id, "vizio:0000aaaa-1111-2222-3333-444455556666");
  assert.equal(dev.address, "https://192.0.2.40:7345");
  assert.equal(dev.model, "Vizio V435-J01");
  assert.equal(dev.meta?.port, undefined, "meta.port is AirPlay's; the API port lives in the address");

  let caps = await vizio.capabilities(dev);
  assert.deepEqual(caps.delivery, ["airplay"]);
  assert.equal(caps.power, false, "no power control until paired");
  assert.deepEqual(caps.control, { paired: false });
  await assert.rejects(vizio.power(dev, true), /isn't paired/);
  assert.deepEqual(await vizio.health(dev), { online: true, powerMode: "PowerOn", detail: "not paired for TV control" });

  assert.equal((await vizio.pairControl(dev, "1234")).ok, false, "a PIN before pairing started is refused");
  const start = await vizio.pairControl(dev);
  assert.equal(start.needsCode, true);
  const wrong = await vizio.pairControl(dev, "9999");
  assert.equal(wrong.ok, false);
  assert.match(wrong.message ?? "", /PIN didn't work/);
  const done = await vizio.pairControl(dev, "1234");
  assert.equal(done.ok, true);
  assert.equal(auth.get().tokens[dev.id], "tok-1");
  assert.match(auth.get().clientId, /^bargames-/);

  caps = await vizio.capabilities(dev);
  assert.equal(caps.power, true);
  assert.deepEqual(caps.inputs, ["cast", "comp", "hdmi1", "hdmi2", "hdmi3", "tuner"]);
  assert.ok(caps.remoteKeys?.includes("VolumeUp"));

  await vizio.power(dev, false);
  await vizio.setInput(dev, "hdmi2");
  await vizio.keypress(dev, "Select");
  await assert.rejects(vizio.keypress(dev, "Lit_a"), /no "Lit_a" key/);
  const keys = fake.calls.filter((c) => c.path === "/key_command/").map((c) => ({ auth: c.auth, body: c.body }));
  assert.deepEqual(keys, [
    { auth: "tok-1", body: { KEYLIST: [{ CODESET: 11, CODE: 0, ACTION: "KEYPRESS" }] } },
    { auth: "tok-1", body: { KEYLIST: [{ CODESET: 3, CODE: 2, ACTION: "KEYPRESS" }] } },
  ]);
  assert.equal(fake.tv.input, "HDMI-2");
  assert.deepEqual(fake.calls.find((c) => c.method === "PUT" && c.path.endsWith("/current_input"))?.body, { REQUEST: "MODIFY", VALUE: "HDMI-2", HASHVAL: 777 });

  // Unpaired on the TV: the box drops its token and says so.
  fake.tv.paired.clear();
  await assert.rejects(vizio.power(dev, true), /no longer accepts/);
  assert.equal(auth.get().tokens[dev.id], undefined);
});

test("vizio: a TV saved as AirPlay moves to the Vizio driver with its name and room; forgetting drops the token", async () => {
  const { dir, vizio, auth } = setup();
  const airplay = new AirplayDriver(new PendingStreamService(), async () => []);
  const drivers = new Map<string, DisplayDriver>([
    ["airplay", airplay],
    ["vizio", vizio],
  ]);
  const store = new JsonStore<{ displays: DisplayRecord[] }>(path.join(dir, "displays.json"), {
    displays: [
      { id: "airplay:aa:bb:cc:dd:ee:ff", driver: "airplay", name: "Patio TV", label: "Quiet corner", group: "Patio", address: "http://192.0.2.40:7000", content: { kind: "off" } },
      { id: "airplay:11:22:33:44:55:66", driver: "airplay", name: "Other", address: "http://192.0.2.41:7000" },
    ],
  });
  const reg = new DisplayRegistry(store, drivers);
  const r = await reg.discover(10);
  assert.deepEqual(r.replaced, { "airplay:aa:bb:cc:dd:ee:ff": "vizio:0000aaaa-1111-2222-3333-444455556666" });
  const ids = reg.list().map((d) => d.id).sort();
  assert.deepEqual(ids, ["airplay:11:22:33:44:55:66", "vizio:0000aaaa-1111-2222-3333-444455556666"]);
  const moved = reg.get("vizio:0000aaaa-1111-2222-3333-444455556666")!;
  assert.equal(moved.label, "Quiet corner");
  assert.equal(moved.group, "Patio");
  assert.deepEqual(moved.content, { kind: "off" });

  // A second scan changes nothing.
  assert.deepEqual((await reg.discover(10)).replaced, {});

  // Pair, then forget: the token goes with the TV, and never lands in displays.json.
  await vizio.pairControl(moved);
  await vizio.pairControl(moved, "1234");
  assert.ok(!readFileSync(path.join(dir, "displays.json"), "utf8").includes("tok-1"));
  await reg.remove(moved.id);
  assert.equal(auth.get().tokens[moved.id], undefined);
});
