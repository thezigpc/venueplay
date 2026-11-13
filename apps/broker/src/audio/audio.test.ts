import { createLogger, JsonStore } from "@bargames/common";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Bluetooth, btProblem, parseDeviceList, parseInfo, type CtlRunner } from "./bluetooth.js";
import { parseAplayList } from "./boxOutputs.js";
import { AudioEngine, gstArgs } from "./engine.js";
import { applyGain, gainFor, SampleAligner, wavHeader } from "./pcm.js";
import type { AudioSettings, OutputTarget } from "./types.js";

const log = createLogger("test", "error");
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(10);
  }
}

// The bench box's `aplay -l` (Lenovo M720q, SOF HDA DSP), as the broker container sees it.
const APLAY = `**** List of PLAYBACK Hardware Devices ****
card 0: sofhdadsp [sof-hda-dsp], device 0: HDA Analog (*) []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 0: sofhdadsp [sof-hda-dsp], device 3: HDMI1 (*) [HDMI 1]
  Subdevices: 1/1
card 0: sofhdadsp [sof-hda-dsp], device 4: HDMI2 (*) [HDMI 2]
card 0: sofhdadsp [sof-hda-dsp], device 5: HDMI3 (*) [HDMI 3]
card 0: sofhdadsp [sof-hda-dsp], device 31: HDA Analog Deep Buffer (*) []
  Subdevices: 1/1`;

test("box outputs: the jack and each HDMI port; deep-buffer duplicates left out", () => {
  const none = parseAplayList(APLAY, false);
  assert.deepEqual(
    none.map((o) => [o.id, o.name, o.address, o.available]),
    [
      ["box:0-0", "Box headphone jack", "plughw:0,0", true],
      ["box:0-3", "Box HDMI/DisplayPort 1", "plughw:0,3", false],
      ["box:0-4", "Box HDMI/DisplayPort 2", "plughw:0,4", false],
      ["box:0-5", "Box HDMI/DisplayPort 3", "plughw:0,5", false],
    ],
  );
  assert.equal(parseAplayList(APLAY, true)[1].available, true);
  assert.deepEqual(parseAplayList("aplay: device_list:274: no soundcards found...", false), []);
});

test("pcm helpers: gain, sample alignment, WAV header", () => {
  assert.equal(gainFor(100), 1);
  assert.equal(gainFor(0), 0);
  assert.equal(gainFor(50), 0.25);
  const b = Buffer.alloc(4);
  b.writeInt16LE(1000, 0);
  b.writeInt16LE(-1000, 2);
  applyGain(b, 0.5);
  assert.deepEqual([b.readInt16LE(0), b.readInt16LE(2)], [500, -500]);
  const a = new SampleAligner();
  assert.equal(a.push(Buffer.from([1, 2, 3])).length, 2);
  assert.equal(a.push(Buffer.from([4])).length, 2);
  const w = wavHeader();
  assert.equal(w.length, 44);
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.readUInt32LE(24), 44100);
});

test("gstreamer gets the URL as one argument (no pipeline injection) ", () => {
  const args = gstArgs("http://127.0.0.1:7100/internal/audio/source/abc");
  assert.equal(args.filter((x) => x.startsWith("location=")).length, 1);
  assert.equal(args.at(-1), "fd=1");
});

// ---------------------------------------------------------------- bluetooth

const INFO_SPEAKER = `Device 11:22:33:44:55:66 (public)
\tName: Patio Speaker
\tAlias: Patio Speaker
\tClass: 0x00240414
\tIcon: audio-card
\tPaired: yes
\tTrusted: yes
\tConnected: no
\tUUID: Audio Sink                (0000110b-0000-1000-8000-00805f9b34fb)
\tRSSI: -61`;
const INFO_PHONE = `Device AA:BB:CC:DD:EE:01 (public)
\tName: Someone's phone
\tClass: 0x005a020c
\tIcon: phone
\tPaired: no
\tConnected: no`;

test("bluetoothctl parsing: device list, info, problems in plain words", () => {
  assert.deepEqual(parseDeviceList("\x1b[0;94m[bluetooth]\x1b[0m# \rDevice 11:22:33:44:55:66 Patio Speaker\nDevice AA:BB:CC:DD:EE:01 Someone's phone\nnoise"), [
    { address: "11:22:33:44:55:66", name: "Patio Speaker" },
    { address: "AA:BB:CC:DD:EE:01", name: "Someone's phone" },
  ]);
  const sp = parseInfo("11:22:33:44:55:66", INFO_SPEAKER)!;
  assert.deepEqual([sp.name, sp.paired, sp.connected, sp.audio, sp.rssi], ["Patio Speaker", true, false, true, -61]);
  assert.equal(parseInfo("AA:BB:CC:DD:EE:01", INFO_PHONE)!.audio, false);
  assert.equal(parseInfo("AA:BB:CC:DD:EE:02", "Device AA:BB:CC:DD:EE:02 not available"), undefined);
  assert.match(btProblem("Failed to pair: org.bluez.Error.AuthenticationFailed"), /pairing mode/);
  assert.match(btProblem("Failed to connect: org.bluez.Error.Failed br-connection-profile-unavailable"), /audio service/);
});

test("bluetooth pairing: pair, trust, connect in the background; failures explained", async () => {
  const calls: string[] = [];
  let pairOut = { code: 0, out: "Attempting to pair with 11:22:33:44:55:66\nPairing successful" };
  const run: CtlRunner = async (args) => {
    calls.push(args.join(" "));
    if (args.includes("pair")) return pairOut;
    if (args[0] === "devices") return { code: 0, out: "Device 11:22:33:44:55:66 Patio Speaker" };
    if (args[0] === "info") return { code: 0, out: INFO_SPEAKER };
    return { code: 0, out: "" };
  };
  const bt = new Bluetooth(run);
  bt.pair("11:22:33:44:55:66");
  await until(() => calls.includes("connect 11:22:33:44:55:66"));
  assert.deepEqual(calls.slice(0, 3), ["--agent NoInputNoOutput pair 11:22:33:44:55:66", "trust 11:22:33:44:55:66", "connect 11:22:33:44:55:66"]);
  await tick();
  assert.equal((await bt.devices())[0].job?.state, "done");

  pairOut = { code: 1, out: "Failed to pair: org.bluez.Error.AuthenticationFailed" };
  bt.pair("11:22:33:44:55:66");
  await until(() => calls.filter((c) => c.includes("pair")).length === 2);
  await tick();
  const job = (await bt.devices())[0].job!;
  assert.equal(job.state, "failed");
  assert.match(job.message!, /pairing mode/);
  assert.throws(() => bt.pair("not-an-address"), /bad Bluetooth address/);

  // Outputs ask for paired devices only, and cache the answer briefly.
  const before = calls.length;
  assert.deepEqual((await bt.paired()).map((d) => d.address), ["11:22:33:44:55:66"]);
  await bt.paired();
  assert.equal(calls.filter((c, i) => i >= before && c.startsWith("devices")).length, 1, "cached");
  assert.ok(calls.slice(before).includes("devices Paired"));
});

// ---------------------------------------------------------------- engine

/** A fake child process: the sink collects what it's sent; the source plays what the test pushes. */
class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  received: Buffer[] = [];
  killed = false;
  constructor(
    readonly cmd: string,
    readonly args: string[],
  ) {
    super();
    this.stdin.on("data", (d: Buffer) => this.received.push(d));
    this.stdin.on("end", () => setImmediate(() => this.emit("close", 0)));
  }
  kill() {
    this.killed = true;
    this.stdout.end();
    setImmediate(() => this.emit("close", 143));
    return true;
  }
  bytes() {
    return this.received.reduce((n, b) => n + b.length, 0);
  }
}

function engineWith(targets: OutputTarget[], spawnHook?: (p: FakeProc) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-audio-"));
  const procs: FakeProc[] = [];
  const settings = new JsonStore<AudioSettings>(path.join(dir, "audio.json"), { volumes: {}, labels: {} });
  const engine = new AudioEngine({
    settings,
    targets: async () => targets,
    log,
    keepEndedMs: 60_000,
    spawn: (cmd, args) => {
      const p = new FakeProc(cmd, args);
      procs.push(p);
      spawnHook?.(p);
      return p as unknown as ChildProcess;
    },
    airplay: { python: "/py", script: "/atv-stream.py" },
  });
  return { engine, procs, settings };
}

const JACK: OutputTarget = { id: "box:0-0", kind: "box", name: "Box headphone jack", address: "plughw:0,0", available: true };
const HDMI: OutputTarget = { id: "box:0-3", kind: "box", name: "Box HDMI/DisplayPort 1", address: "plughw:0,3", available: false, detail: "No screen is plugged into the box" };
const TV: OutputTarget = { id: "tv:roku:1", kind: "tv", name: "Bar TV", address: "192.0.2.20", available: true };

test("engine: a URL plays through gstreamer into aplay on the default output, then ends", async () => {
  const { engine, procs } = engineWith([JACK, HDMI]);
  const s = await engine.play({ url: "http://127.0.0.1:7100/internal/audio/source/tok", owner: "app:music", title: "Song" });
  assert.equal(s.output, "box:0-0", "default: the first output that can play");
  assert.equal(s.state, "starting");
  const [sink, src] = procs;
  assert.equal(sink.cmd, "aplay");
  assert.ok(sink.args.includes("plughw:0,0"));
  assert.equal(src.cmd, "gst-launch-1.0");

  src.stdout.write(Buffer.alloc(176_400, 1)); // one second
  await until(() => sink.bytes() >= 176_400);
  assert.equal(engine.get(s.id)!.state, "playing");
  assert.equal(engine.get(s.id)!.positionMs, 1000);
  src.stdout.end();
  src.emit("close", 0);
  await until(() => engine.get(s.id)!.state === "ended");
  assert.equal(engine.get(s.id)!.message, undefined);
  assert.equal(engine.list("app:music").length, 1, "ended sessions stay visible for a while");
  assert.equal(engine.list("app:other").length, 0);
});

test("engine: volume scales samples; pause sends silence and holds the position", async () => {
  const { engine, procs, settings } = engineWith([JACK]);
  await settings.update((s) => void (s.volumes["box:0-0"] = 0));
  const s = await engine.play({ url: "http://127.0.0.1/x", owner: "app:music" });
  const [sink, src] = procs;
  const loud = Buffer.alloc(4410 * 4);
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(20_000, i);
  src.stdout.write(loud);
  await until(() => sink.bytes() >= loud.length);
  assert.ok(sink.received.every((b) => b.every((x) => x === 0)), "volume 0: silence");

  await settings.update((s) => void (s.volumes["box:0-0"] = 100));
  engine.pause(s.id);
  const before = engine.get(s.id)!.positionMs;
  const sent = sink.bytes();
  await until(() => sink.bytes() > sent + 17_640); // silence keeps flowing while paused
  assert.equal(engine.get(s.id)!.state, "paused");
  assert.equal(engine.get(s.id)!.positionMs, before);
  engine.resume(s.id);
  assert.equal(engine.get(s.id)!.state, "playing");
  const stopped = engine.stop(s.id);
  assert.equal(stopped.state, "ended");
  assert.ok(sink.killed && src.killed);
  assert.throws(() => engine.pause(s.id), /finished/);
});

test("engine: one session per output; a new one replaces the old", async () => {
  const { engine } = engineWith([JACK]);
  const a = await engine.play({ url: "http://127.0.0.1/a", owner: "app:music" });
  const b = await engine.play({ tone: true, owner: "admin", title: "Test sound" });
  assert.equal(engine.get(a.id)!.state, "ended");
  assert.match(engine.get(a.id)!.message!, /Replaced/);
  assert.equal((await engine.outputs())[0].session?.id, b.id);
  engine.stop(b.id);
});

test("engine: outputs that can't play, bad URLs and unknown outputs are refused in words", async () => {
  const { engine } = engineWith([JACK, HDMI]);
  await assert.rejects(engine.play({ url: "http://x/a", owner: "admin", output: "box:0-3" }), /No screen is plugged/);
  await assert.rejects(engine.play({ url: "file:///etc/passwd", owner: "admin" }), /url/);
  await assert.rejects(engine.play({ url: "http://x/a b ! filesrc", owner: "admin" }), /url/);
  await assert.rejects(engine.play({ url: "http://x/a", owner: "admin", output: "bt:00:00:00:00:00:00" }), /isn't on this box/);
});

test("engine: AirPlay gets a WAV stream and track names; a failing helper's message reaches the session", async () => {
  const { engine, procs } = engineWith([TV], (p) => {
    if (p.cmd === "/py") {
      setTimeout(() => {
        p.stderr.write('{"error": "The TV didn\'t answer over AirPlay. Check it\'s on and AirPlay is turned on."}\n');
        p.stdin.destroy();
        p.emit("close", 1);
      }, 30);
    }
  });
  const s = await engine.play({ url: "http://127.0.0.1/a", owner: "app:music", output: "tv:roku:1", title: "Song" });
  const [sink, src] = procs;
  assert.equal(sink.args[0], "/atv-stream.py");
  assert.deepEqual(JSON.parse(sink.args[1]), { host: "192.0.2.20", title: "Song" });
  src.stdout.write(Buffer.alloc(8820)); // then the source goes quiet while the TV fails
  await until(() => engine.get(s.id)!.state === "error");
  assert.ok(src.killed, "the decoder is stopped too");
  assert.equal(sink.received[0].toString("ascii", 0, 4), "RIFF");
  assert.match(engine.get(s.id)!.message!, /didn't answer over AirPlay/);
});

test("engine: a sink that can't start (missing program) fails the session instead of the broker", async () => {
  const { engine } = engineWith([JACK], (p) => {
    setImmediate(() => {
      p.stdin.destroy();
      p.emit("error", new Error("spawn aplay ENOENT"));
    });
  });
  const s = await engine.play({ tone: true, owner: "admin" });
  await until(() => engine.get(s.id)!.state === "error");
});

test("engine: venue settings (default, label, volume) show on the outputs", async () => {
  const { engine } = engineWith([JACK, TV]);
  await engine.setDefault("tv:roku:1");
  await engine.setLabel("box:0-0", "  Bar amp  ");
  await engine.setVolume("box:0-0", 35);
  const outs = await engine.outputs();
  assert.deepEqual(
    outs.map((o) => [o.id, o.default, o.label, o.volume]),
    [
      ["box:0-0", false, "Bar amp", 35],
      ["tv:roku:1", true, undefined, 60],
    ],
  );
  await assert.rejects(engine.setVolume("box:0-0", 101), /0-100/);
  await assert.rejects(engine.setDefault("nope"), /no such output/);
});
