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
  const state = { valid: new Set<string>(), pairing: false, protocol: "companion", videoError: "" };
  const call: AtvCall = async (op, args = {}) => {
    calls.push({ op, args });
    switch (op) {
      case "scan":
        return [{ identifier: "AA:BB:CC:00:11:22", name: "Bar Apple TV", address: "192.0.2.50", model: "Apple TV 4K (gen 3)", version: "27.0" }];
      case "pair_begin":
        state.pairing = true;
        state.protocol = args.protocol === "airplay" ? "airplay" : "companion";
        return { pin: true };
      case "pair_finish":
        if (!state.pairing) throw new AtvError("start pairing first", "error");
        if (args.pin !== "4321") throw new AtvError("that PIN didn't work", "pin");
        if (state.protocol === "airplay") return { credentials: "air-1" };
        state.valid.add("creds-1");
        return { credentials: "creds-1" };
      // Box 0.27.0: video over AirPlay needs the AirPlay credentials.
      case "video_play":
        if (args.airplay !== "air-1") throw new AtvError("the Apple TV wants the box paired for AirPlay video", "needs-pairing");
        if (state.videoError) throw new AtvError(state.videoError, "error");
        return { ok: true };
      case "video_status":
        return { state: "playing", position: 12, duration: 5400 };
      case "video_control":
        return { ok: true };
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
  const first = await atv.pairControl(dev, "4321");
  assert.equal(first.ok, false, "box 0.27.0: then a second PIN, for AirPlay video");
  assert.equal(first.needsCode, true);
  assert.match(first.message!, /second PIN/);
  assert.equal(auth.get().credentials[dev.id], "creds-1", "TV control works after the first PIN");
  assert.equal((await atv.pairControl(dev, "4321")).ok, true);
  assert.equal(auth.get().airplay?.[dev.id], "air-1");

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
  assert.equal((await reg.pairControl(moved.id, "4321")).needsCode, true);
  assert.equal((await reg.pairControl(moved.id, "4321")).ok, true);
  const saved = readFileSync(path.join(dir, "displays.json"), "utf8");
  assert.ok(!saved.includes("creds-1") && !saved.includes("air-1"));
  await reg.remove(moved.id);
  assert.equal(auth.get().credentials[moved.id], undefined);
  assert.equal(auth.get().airplay?.[moved.id], undefined);
});

test("apple tv 0.27.0: video links over AirPlay; asks for the second pairing; never echoes the link", async () => {
  const { fake, atv } = setup();
  const [dev] = await atv.discover(10);
  const video = { url: "http://media.example:8096/Videos/1/stream?static=true&api_key=SECRET", title: "A movie", mime: "video/mp4", startAt: 95 };
  assert.deepEqual(atv.videoInfo(dev), { kind: "appletv", model: "Apple TV 4K (gen 3)" });

  const unpaired = await atv.playVideo(dev, video);
  assert.equal(unpaired.reason, "needs-pairing");
  assert.doesNotMatch(JSON.stringify(unpaired), /SECRET/);

  await atv.pairControl(dev);
  await atv.pairControl(dev, "4321");
  await atv.pairControl(dev, "4321");
  assert.deepEqual(await atv.playVideo(dev, video), { ok: true });
  const play = fake.calls.find((c) => c.op === "video_play" && c.args.airplay === "air-1")!;
  assert.equal(play.args.url, video.url);
  assert.equal(play.args.startAt, 95);
  assert.equal(play.args.credentials, "creds-1", "Companion too, so the same connection serves the remote");

  assert.deepEqual(await atv.videoStatus(dev), { state: "playing", position: 12, duration: 5400 });
  assert.deepEqual(await atv.videoControl(dev, { seek: 600 }), { ok: true });
  assert.deepEqual(fake.calls.at(-1)?.args.action, "seek");
  assert.equal(fake.calls.at(-1)?.args.position, 600);

  fake.state.videoError = "couldn't fetch http://media.example:8096/x?api_key=SECRET";
  const failed = await atv.playVideo(dev, video);
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.message!, /SECRET|media\.example/, "links are cut out of messages");
});

test("apple tv 0.29.7: video ops go to the video helper (patched pyatv); pairing and the remote stay on the main one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "atv-"));
  const main = fakeHelper();
  const video = fakeHelper();
  const auth = new JsonStore<AppleTvAuth>(path.join(dir, "appletv-auth.json"), { credentials: {} }, 0o600);
  const atv = new AppleTvDriver(new PendingStreamService(), auth, { call: main.call, videoCall: video.call, reachable: async () => true });
  const [dev] = await atv.discover(10);
  await atv.pairControl(dev);
  await atv.pairControl(dev, "4321");
  await atv.pairControl(dev, "4321");
  assert.deepEqual(await atv.playVideo(dev, { url: "http://media.example/v.mp4", title: "A movie", mime: "video/mp4" }), { ok: true });
  await atv.videoControl(dev, "pause");
  await atv.videoStatus(dev);
  const ops = (calls: { op: string }[]) => calls.map((c) => c.op);
  assert.deepEqual(ops(video.calls).filter((op) => op.startsWith("video_")), ["video_play", "video_control", "video_status"]);
  assert.equal(ops(main.calls).some((op) => op.startsWith("video_")), false);
  assert.ok(ops(main.calls).includes("pair_finish"));
  assert.equal(video.calls.find((c) => c.op === "video_play")!.args.airplay, "air-1", "the stored AirPlay pairing goes with it");
});

test("atv-helper.py: no two Helper methods share a name (0.29.8's key() shadowed the key op and lost video sessions)", () => {
  const src = readFileSync(new URL("../../../atv/atv-helper.py", import.meta.url), "utf8");
  const body = src.split(/^class /m).find((c) => c.startsWith("Helper")) ?? "";
  const names = [...body.matchAll(/^ {4}(?:async )?def (\w+)\(/gm)].map((m) => m[1]);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, []);
  assert.ok(names.includes("dev_key") && names.includes("key"));
});
