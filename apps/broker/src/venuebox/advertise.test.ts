import assert from "node:assert/strict";
import { test } from "node:test";
import { collectServices, encodeQuery } from "../drivers/airplay/mdns.js";
import { asksForUs, encodeAnswer, hostLabel, instanceLabel, lanAddresses, VENUEBOX_SERVICE } from "./advertise.js";

const info = { name: "Kava Bar", id: "a1b2c3d4e5f6", port: 7210, addresses: ["192.0.2.30", "198.51.100.7"] };

test("discovery (box 0.16.2): the answer reads back as the box, its port, address and id", () => {
  const found = collectServices(VENUEBOX_SERVICE, [{ buf: encodeAnswer(info), from: "192.0.2.30" }]);
  assert.equal(found.length, 1);
  const s = found[0];
  assert.equal(s.name, "Kava Bar");
  assert.equal(s.port, 7210);
  assert.equal(s.host, "bargames-a1b2c3d4e5f6.local");
  assert.ok(info.addresses.includes(s.address!), "one of the box's LAN addresses (every one is an A record)");
  assert.deepEqual(s.txt, { v: "1", id: "a1b2c3d4e5f6", name: "Kava Bar", path: "/venuebox" });
});

test("discovery: answers queries for our service, instance or host; ignores the rest and responses", () => {
  assert.equal(asksForUs(encodeQuery(VENUEBOX_SERVICE), info).yes, true);
  assert.equal(asksForUs(encodeQuery("_services._dns-sd._udp.local"), info).yes, true);
  assert.equal(asksForUs(encodeQuery("_airplay._tcp.local"), info).yes, false);
  assert.equal(asksForUs(encodeAnswer(info), info).yes, false, "our own announcement isn't a question");
  // Legacy unicast: the reply echoes the query's id and question.
  const q = encodeQuery(VENUEBOX_SERVICE);
  q.writeUInt16BE(0x1234, 0);
  const a = asksForUs(q, info);
  const reply = encodeAnswer(info, 0x1234, a.question);
  assert.equal(reply.readUInt16BE(0), 0x1234);
  assert.equal(reply.readUInt16BE(4), 1, "question echoed");
  assert.equal(collectServices(VENUEBOX_SERVICE, [{ buf: reply, from: "192.0.2.30" }])[0].port, 7210);
});

test("discovery: names and addresses", () => {
  assert.equal(instanceLabel("Pacha.Kava"), "Pacha Kava", "no dots in a DNS label");
  assert.equal(Buffer.byteLength(instanceLabel("x".repeat(100))), 63);
  assert.equal(hostLabel("A1B2"), "bargames-a1b2");
  const ifaces = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    tailscale0: [{ address: "100.64.0.5", family: "IPv4", internal: false }],
    wlo1: [
      { address: "192.0.2.30", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
    eno2: [{ address: "169.254.3.3", family: "IPv4", internal: false }],
  } as unknown as Parameters<typeof lanAddresses>[0];
  assert.deepEqual(lanAddresses(ifaces), ["192.0.2.30"]);
});
