import { createLogger } from "@bargames/common";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AirplayStreams, chromiumArgs, type CtlReply, type Proc, type ProcRunner } from "./airplay.js";
import type { DisplayDevice } from "./types.js";

/** Pretends to be Xvfb/Chromium/doubletake. TVs in `needCode` ask for "1234" until paired. */
class FakeRunner implements ProcRunner {
  procs: { tag: string; cmd: string; args: string[]; env: Record<string, string>; alive: boolean }[] = [];
  daemons = new Map<string, Map<string, string>>(); // socket → ip → state
  paired = new Set<string>();
  discovered = new Set<string>();
  ctlCalls: string[][] = [];
  constructor(readonly needCode = new Set<string>()) {}

  spawn(tag: string, cmd: string, args: string[], env: Record<string, string> = {}): Proc {
    const p = { tag, cmd, args, env, alive: true };
    this.procs.push(p);
    if (cmd === "doubletake") this.daemons.set(args[args.indexOf("-socket") + 1], new Map());
    return {
      get alive() {
        return p.alive;
      },
      tail: () => [],
      kill: () => void (p.alive = false),
    };
  }
  async ctl(socket: string, args: string[]): Promise<CtlReply> {
    this.ctlCalls.push([socket, ...args]);
    const d = this.daemons.get(socket);
    const daemon = this.procs.findLast((p) => p.cmd === "doubletake" && p.args.includes(socket));
    if (!d || !daemon?.alive) throw new Error("no daemon");
    const [cmd, ip, code] = args;
    if (cmd === "connect") {
      if (code === "1234") this.paired.add(ip);
      d.set(ip, this.needCode.has(ip) && !this.paired.has(ip) ? "pin_required" : "streaming");
    }
    if (cmd === "disconnect") d.delete(ip);
    if (cmd === "devices") return { ok: true, devices: [...this.discovered].map((x) => ({ ip: x, port: 63333 })) };
    return { ok: true, streams: [...d].map(([device_ip, state]) => ({ device_ip, state })) };
  }
  async waitForDisplay() {}
  cleanSlot() {}
  async sleep() {}
  alive(cmd: string) {
    return this.procs.filter((p) => p.cmd === cmd && p.alive);
  }
}

const tv = (n: number): DisplayDevice => ({ id: `roku:${n}`, driver: "roku", name: `TV ${n}`, address: `http://10.0.0.${n}:8060` });
const make = (runner: FakeRunner) =>
  new AirplayStreams({ runner, log: createLogger("test", "error"), runDir: "/run/cast", credsFile: "/data/creds.json", settleMs: 0, connectTimeoutMs: 0, hwaccel: "vaapi" });

test("airplay: TVs on the same page share one channel; moving a TV opens another", async () => {
  const runner = new FakeRunner();
  const s = make(runner);
  assert.deepEqual(await s.startAirplay(tv(1), { url: "https://bingo.x/join/AB?as=table" }), { ok: true, delivery: "airplay" });
  assert.equal((await s.startAirplay(tv(2), { url: "https://bingo.x/join/AB?as=table" })).ok, true);
  assert.equal(runner.alive("doubletake").length, 1, "one encoder for both TVs");
  const dt = runner.alive("doubletake")[0];
  assert.ok(dt.args.includes("-no-audio") && dt.args.includes("vaapi") && dt.args.includes("/data/creds.json"));
  assert.equal(dt.env.DISPLAY, runner.alive("Xvfb")[0].args[0]);
  assert.ok(runner.alive("chromium")[0].args.includes("https://bingo.x/join/AB?as=table"));
  assert.deepEqual(runner.procs.find((p) => p.cmd === "xdotool")?.args, ["mousemove", "1919", "1079"], "the mouse is parked off-screen");
  assert.equal(s.state("roku:1")?.state, "streaming");

  await s.startAirplay(tv(2), { url: "https://pool.x/table/CD" });
  assert.equal(runner.alive("doubletake").length, 2);
  assert.equal(runner.alive("Xvfb")[1].args[0], ":91", "second channel gets the next display");
  assert.equal(s.state("roku:2")?.url, "https://pool.x/table/CD");

  await s.stopFor("roku:1");
  assert.equal(runner.alive("doubletake").length, 1, "an empty channel is torn down");
  assert.equal(runner.alive("chromium").length, 1);
  assert.equal(s.state("roku:1"), undefined);
});

test("airplay: a TV that wants a code reports it, and pair() completes it", async () => {
  const runner = new FakeRunner(new Set(["10.0.0.5"]));
  const s = make(runner);
  const r = await s.startAirplay(tv(5), { url: "https://x/t" });
  assert.equal(r.ok, false);
  assert.equal(r.needsCode, true);
  assert.equal(s.state("roku:5")?.needsCode, true);
  assert.deepEqual(await s.pair(tv(5), "1234"), { ok: true, delivery: "airplay" });
  assert.ok(runner.ctlCalls.some((c) => c.slice(1).join(" ") === "connect 10.0.0.5 1234"));
  assert.equal((await s.pair(tv(6), "1234")).ok, false, "pairing needs a cast in progress");
});

test("airplay: the watchdog restarts a dead channel and reconnects its TVs", async () => {
  const runner = new FakeRunner();
  const s = make(runner);
  await s.startAirplay(tv(1), { url: "https://x/t" });
  runner.alive("chromium")[0].alive = false; // Chromium crashed
  await (s as unknown as { tick(): Promise<void> }).tick();
  assert.equal(runner.alive("chromium").length, 1);
  assert.equal(runner.alive("doubletake").length, 1);
  assert.equal(runner.procs.filter((p) => p.cmd === "doubletake").length, 2, "a fresh daemon was started");
  assert.equal(s.state("roku:1")?.state, "connecting");
  assert.ok(runner.ctlCalls.at(-1)?.includes("connect"));

  // A TV that dropped (e.g. turned off) is reconnected.
  const socket = runner.alive("doubletake")[0].args[runner.alive("doubletake")[0].args.indexOf("-socket") + 1];
  runner.daemons.get(socket)!.delete("10.0.0.1");
  await (s as unknown as { tick(): Promise<void> }).tick();
  assert.deepEqual(runner.ctlCalls.at(-1)?.slice(1), ["connect", "10.0.0.1"]);
});

test("chromium runs as a kiosk on the page", () => {
  const args = chromiumArgs("https://x/t", "/run/p", 1920, 1080);
  assert.equal(args.at(-1), "https://x/t");
  assert.ok(args.includes("--kiosk") && args.includes("--window-size=1920,1080") && args.includes("--user-data-dir=/run/p"));
  assert.ok(args.includes("--force-device-scale-factor=1"));
});

test("airplay: 2160p renders 4K pixels with a 1080p layout (scale 2)", async () => {
  const runner = new FakeRunner();
  const s = make(runner);
  await s.startAirplay({ ...tv(1), streamSettings: { resolution: "2160p", fps: 30, bitrateKbps: 20000 } }, { url: "https://menu.x/tv" });
  await s.startAirplay(tv(2), { url: "https://menu.x/tv" });
  assert.equal(runner.alive("doubletake").length, 2, "4K and 1080p TVs don't share an encoder");
  assert.deepEqual(runner.alive("Xvfb").map((p) => p.args[3]).sort(), ["1920x1080x24", "3840x2160x24"]);
  const chromes = runner.alive("chromium");
  const fourK = chromes.find((p) => p.args.includes("--force-device-scale-factor=2"));
  assert.ok(fourK && fourK.args.includes("--window-size=1920,1080"), "window in CSS pixels, drawn at 2x");
  assert.ok(chromes.some((p) => p.args.includes("--force-device-scale-factor=1") && p.args.includes("--window-size=1920,1080")));
  assert.match(s.state("roku:1")!.settings!, /2160p · 30 fps · 20000 kbps/);
});

test("airplay: a receiver on another port waits for doubletake's discovery; Rokus don't", async () => {
  const runner = new FakeRunner();
  const s = make(runner);
  await s.startAirplay(tv(1), { url: "https://x/a" });
  assert.ok(!runner.ctlCalls.some((c) => c[1] === "devices"), "a Roku (ECP :8060) connects straight away");

  runner.discovered.add("10.0.0.105");
  const ux: DisplayDevice = { id: "airplay:ux", driver: "airplay", name: "UxPlay", address: "http://10.0.0.105:63333", meta: { port: 63333 } };
  assert.equal((await s.startAirplay(ux, { url: "https://x/a" })).ok, true);
  const calls = runner.ctlCalls.map((c) => c.slice(1).join(" "));
  assert.ok(calls.indexOf("devices") >= 0 && calls.indexOf("devices") < calls.indexOf("connect 10.0.0.105"), "checks discovery before connecting");
});

test("airplay: each TV's resolution and frame rate; same settings share an encoder; previews", async () => {
  const runner = new FakeRunner();
  const shots: number[] = [];
  Object.assign(runner, {
    async screenshot(port: number, size: { width: number; height: number }, out: number) {
      shots.push(port);
      return Buffer.from(`jpeg ${port} ${size.width}x${size.height} -> ${out}`);
    },
  });
  const s = make(runner);
  const url = "https://menu.x/tv";
  const slow = { resolution: "720p", fps: 15, bitrateKbps: 2000 } as const;
  await s.startAirplay({ ...tv(1), streamSettings: slow }, { url });
  await s.startAirplay({ ...tv(2), streamSettings: slow }, { url });
  await s.startAirplay(tv(3), { url });
  const daemons = runner.alive("doubletake");
  assert.equal(daemons.length, 2, "720p15 TVs share one encoder; the default TV gets its own");
  const lo = daemons.find((p) => p.args.includes("15"))!;
  assert.deepEqual([lo.args[lo.args.indexOf("-fps") + 1], lo.args[lo.args.indexOf("-bitrate") + 1]], ["15", "2000"]);
  const hi = daemons.find((p) => p !== lo)!;
  assert.equal(hi.args[hi.args.indexOf("-fps") + 1], "30");
  assert.ok(!hi.args.includes("-bitrate"), "automatic bitrate: no flag");
  assert.deepEqual(runner.alive("Xvfb").map((p) => p.args[3]).sort(), ["1280x720x24", "1920x1080x24"]);
  const chromes = runner.alive("chromium");
  assert.ok(chromes.every((p) => p.args.includes("--remote-debugging-address=127.0.0.1")), "DevTools on loopback only");
  assert.ok(chromes.some((p) => p.args.includes("--window-size=1280,720")));
  assert.match(s.state("roku:1")!.settings!, /720p · 15 fps · 2000 kbps/);

  // Previews: one capture per channel, reused for a moment.
  assert.match(String(await s.preview("roku:1")), /1280x720 -> 480/);
  await s.preview("roku:2");
  assert.equal(shots.length, 1, "same channel, cached");
  assert.match(String(await s.preview("roku:3")), /1920x1080/);
  assert.equal(await s.preview("roku:9"), undefined, "not casting");

  // A TV that changes settings moves to the matching channel.
  await s.startAirplay(tv(1), { url });
  assert.equal(runner.alive("doubletake").length, 2);
  await s.startAirplay(tv(2), { url });
  assert.equal(runner.alive("doubletake").length, 1, "the 720p channel closed when its last TV left");
});
