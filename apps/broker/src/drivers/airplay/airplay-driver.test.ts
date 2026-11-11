import assert from "node:assert/strict";
import { test } from "node:test";
import { dropAirplayDuplicates } from "../../registry.js";
import type { DisplayDevice, StreamService } from "../../types.js";
import { AirplayDriver, canShowVideo } from "./index.js";
import { collectServices, encodeQuery, parseRecords } from "./mdns.js";

// ------------------------------------------------------------ a tiny DNS writer for fixtures

const name = (n: string) => Buffer.concat([...n.split(".").map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const rr = (owner: Buffer, type: number, data: Buffer) => Buffer.concat([owner, u16(type), u16(0x8001), Buffer.from([0, 0, 0x11, 0x94]), u16(data.length), data]);
const txt = (kv: Record<string, string>) => Buffer.concat(Object.entries(kv).map(([k, v]) => Buffer.concat([Buffer.from([Buffer.byteLength(`${k}=${v}`)]), Buffer.from(`${k}=${v}`)])));

function response(instance: string, host: string, ip: string, port: number, t: Record<string, string>): Buffer {
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 3]);
  const svc = "_airplay._tcp.local";
  const full = `${instance}.${svc}`;
  // The PTR's data points (compression) back at the instance name inside the SRV record? Keep it simple: write names in full.
  const ptr = rr(name(svc), 12, name(full));
  const srv = rr(name(full), 33, Buffer.concat([u16(0), u16(0), u16(port), name(host)]));
  const tx = rr(name(full), 16, txt(t));
  const a = rr(name(host), 1, Buffer.from(ip.split(".").map(Number)));
  return Buffer.concat([header, ptr, srv, tx, a]);
}

test("mdns: query encodes a PTR question", () => {
  const q = encodeQuery("_airplay._tcp.local");
  assert.equal(q.readUInt16BE(4), 1);
  assert.equal(q.subarray(12, 21).toString("latin1"), "\x08_airplay");
  assert.equal(q.readUInt16BE(q.length - 4), 12);
});

test("mdns: parses PTR/SRV/TXT/A into services, with compression pointers", () => {
  const buf = response("Living Room", "uxplay-pc.local", "192.168.77.40", 7000, { deviceid: "AA:BB:CC:DD:EE:FF", model: "AppleTV3,2", features: "0x5A7FFFF7,0x1E" });
  assert.equal(parseRecords(buf).length, 4);

  // Hand-made compressed message: PTR data = "Den" + pointer to "_airplay._tcp.local" at offset 12.
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  const owner = name("_airplay._tcp.local");
  const data = Buffer.concat([Buffer.from([3]), Buffer.from("Den"), Buffer.from([0xc0, 12])]);
  const compressed = Buffer.concat([header, rr(owner, 12, data)]);

  const svcs = collectServices("_airplay._tcp.local", [
    { buf, from: "192.168.77.40" },
    { buf: compressed, from: "192.168.77.41" },
  ]);
  const lr = svcs.find((s) => s.name === "Living Room");
  assert.deepEqual([lr?.address, lr?.port, lr?.host, lr?.txt.deviceid], ["192.168.77.40", 7000, "uxplay-pc.local", "AA:BB:CC:DD:EE:FF"]);
  const den = svcs.find((s) => s.name === "Den");
  assert.equal(den?.address, "192.168.77.41", "falls back to the packet's source address");
});

test("airplay: video receivers only, ids from deviceid", async () => {
  assert.equal(canShowVideo({ txt: { model: "AudioAccessory5,1", features: "0x4A7FDFD5,0xBC157FDE" } }), false, "HomePod");
  assert.equal(canShowVideo({ txt: { features: "0x400" } }), false, "audio-only feature bits");
  assert.equal(canShowVideo({ txt: { model: "AppleTV11,1", features: "0x4A7FDFD5,0xBC177FDE" } }), true);
  assert.equal(canShowVideo({ txt: {} }), true, "unknown: let staff try");

  const drv = new AirplayDriver({} as StreamService, async () => [
    { name: "Bar TV", fqdn: "Bar TV._airplay._tcp.local", address: "192.168.77.50", port: 7000, txt: { deviceid: "11:22:33:44:55:66", model: "AppleTV6,2", features: "0x5A7FFFF7,0x1E" } },
    { name: "Kitchen", fqdn: "Kitchen._airplay._tcp.local", address: "192.168.77.51", port: 7000, txt: { model: "AudioAccessory1,1" } },
  ]);
  const found = await drv.discover();
  assert.deepEqual(
    found.map((d) => [d.id, d.address, d.name]),
    [["airplay:11:22:33:44:55:66", "http://192.168.77.50:7000", "Bar TV"]],
  );
  assert.deepEqual(await drv.capabilities(), { delivery: ["airplay"], power: false, inputs: [] });
});

test("airplay: a Roku's AirPlay advert never becomes a second display", () => {
  const roku: DisplayDevice = { id: "roku:X1", driver: "roku", name: "Express", address: "http://192.168.77.132:8060" };
  const rokuAirplay: DisplayDevice = { id: "airplay:aa", driver: "airplay", name: "Express", address: "http://192.168.77.132:7000" };
  const atv: DisplayDevice = { id: "airplay:bb", driver: "airplay", name: "Apple TV", address: "http://192.168.77.60:7000" };
  assert.deepEqual(dropAirplayDuplicates([rokuAirplay, atv], [roku]).map((d) => d.id), ["airplay:bb"], "known Roku");
  assert.deepEqual(dropAirplayDuplicates([roku, rokuAirplay, atv], []).map((d) => d.id), ["roku:X1", "airplay:bb"], "found in the same scan");
});
