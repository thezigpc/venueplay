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
import { AtvError, type AtvCall } from "./helper.js";
import { AppleTvDriver, type AppleTvAuth } from "./index.js";

/** A fake atv-helper: PIN 4321 gives credentials "creds-1". */
function fakeHelper() {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const state = { valid: new Set<string>(), pairing: false };
  const call: AtvCall = async (op, args = {}) => {
    calls.push({ op, args });
    switch (op) {
      case "scan":
        return [{ identifier: "AA:BB:CC:00:11:22", name: "Bar Apple TV", address: "192.0.2.50", model: "Apple TV 4K (gen 3)", version: "27.0" }];
      case "pair_begin":
        state.pairing = true;
        return { pin: true };
      case "pair_finish":
        if (!state.pairing) throw new AtvError("start pairing first", "error");
        if (args.pin !== "4321") throw new AtvError("that PIN didn't work", "pin");
        state.valid.add("creds-1");
        return { credentials: "creds-1" };
    }
    if (!state.valid.has(String(args.credentials))) throw new AtvError("refused", "auth");
    if (op === "apps") return [{ id: "com.zeta", name: "Zeta" }, { id: "com.alpha", name: "Alpha" }];
    return null;
  };
  return { calls, state, call };
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "atv-"));
  const fake = fakeHelper();
  const auth = new JsonStore<AppleTvAuth>(path.join(dir, "appletv-auth.json"), { credentials: {} }, 0o600);
  const atv = new AppleTvDriver(new PendingStreamService(), auth, { call: fake.call, reachable: async () => true });
  return { dir, fake, auth, atv };
}

test("apple tv: discovery, PIN pairing, remote, apps, typing", async () => {
  const { fake, auth, atv } = setup();
  const [dev] = await atv.discover(10);
  assert.ok(dev);
  assert.equal(dev.id, "appletv:aa:bb:cc:00:11:22");
  assert.equal(dev.address, "http://192.0.2.50:7000", "AirPlay goes to the Apple TV's host");
  assert.equal(dev.meta?.identifier, "AA:BB:CC:00:11:22", "the helper gets pyatv's identifier as it was");

  let caps = await atv.capabilities(dev);
  assert.deepEqual(caps, { delivery: ["airplay"], power: false, inputs: [], remoteKeys: [], apps: false, text: false, control: { paired: false } });
  await assert.rejects(atv.keypress(dev, "Up"), /isn't paired/);
  assert.deepEqual(await atv.health(dev), { online: true, detail: "not paired for TV control" });

  assert.equal((await atv.pairControl(dev)).needsCode, true);
  const wrong = await atv.pairControl(dev, "1111");
  assert.equal(wrong.ok, false);
  assert.equal(wrong.needsCode, true);
  assert.equal((await atv.pairControl(dev, "4321")).ok, true);
  assert.equal(auth.get().credentials[dev.id], "creds-1");

  caps = await atv.capabilities(dev);
  assert.equal(caps.power, true);
  assert.equal(caps.apps, true);
  assert.ok(caps.remoteKeys?.includes("Select") && caps.remoteKeys.includes("VolumeUp"));

  await atv.keypress(dev, "Select");
  await atv.power(dev, false);
  await atv.typeText(dev, "jazz");
  await atv.launchChannel(dev, "com.alpha");
  assert.deepEqual((await atv.listApps(dev)).apps.map((a) => a.name), ["Alpha", "Zeta"], "sorted by name");
  await assert.rejects(atv.keypress(dev, "Lit_a"), /no "Lit_a" key/);
  await assert.rejects(atv.setInput(dev), /no inputs/);
  const sent = fake.calls.filter((c) => ["key", "power", "text", "launch"].includes(c.op)).map((c) => ({ op: c.op, ...c.args }));
  assert.deepEqual(sent, [
    { op: "key", identifier: "AA:BB:CC:00:11:22", address: "192.0.2.50", credentials: "creds-1", key: "Select" },
    { op: "power", identifier: "AA:BB:CC:00:11:22", address: "192.0.2.50", credentials: "creds-1", on: false },
    { op: "text", identifier: "AA:BB:CC:00:11:22", address: "192.0.2.50", credentials: "creds-1", text: "jazz" },
    { op: "launch", identifier: "AA:BB:CC:00:11:22", address: "192.0.2.50", credentials: "creds-1", app: "com.alpha" },
  ]);

  // Pairing removed on the Apple TV: the box drops its credentials and says so.
  fake.state.valid.clear();
  await assert.rejects(atv.keypress(dev, "Up"), /no longer accepts/);
  assert.equal(auth.get().credentials[dev.id], undefined);
});

test("apple tv: one saved as AirPlay moves over; credentials stay out of displays.json and go when forgotten", async () => {
  const { dir, atv, auth } = setup();
  const drivers = new Map<string, DisplayDriver>([
    ["airplay", new AirplayDriver(new PendingStreamService(), async () => [])],
    ["appletv", atv],
  ]);
  const store = new JsonStore<{ displays: DisplayRecord[] }>(path.join(dir, "displays.json"), {
    displays: [{ id: "airplay:aa:bb:cc:00:11:22", driver: "airplay", name: "Bar Apple TV", label: "Bar TV", group: "Main", address: "http://192.0.2.50:7000" }],
  });
  const reg = new DisplayRegistry(store, drivers);
  assert.deepEqual((await reg.discover(10)).replaced, { "airplay:aa:bb:cc:00:11:22": "appletv:aa:bb:cc:00:11:22" });
  const moved = reg.get("appletv:aa:bb:cc:00:11:22")!;
  assert.equal(moved.label, "Bar TV");
  assert.equal(reg.list().length, 1);

  await reg.pairControl(moved.id);
  assert.equal((await reg.pairControl(moved.id, "4321")).ok, true);
  assert.ok(!readFileSync(path.join(dir, "displays.json"), "utf8").includes("creds-1"));
  await reg.remove(moved.id);
  assert.equal(auth.get().credentials[moved.id], undefined);
});
