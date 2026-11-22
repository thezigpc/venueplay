import { createLogger, JsonStore } from "@bargames/common";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBrokerApp } from "./app.js";
import { MockDriver } from "./drivers/mock.js";
import { safeUrl, VirtualScreenDriver, VIRTUAL_TV } from "./drivers/virtual.js";
import { DisplayRegistry, type DisplayRecord } from "./registry.js";

test("virtual test TV: hidden while off, a TV like any other while on, gone again after", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-virtual-"));
  const virtual = new VirtualScreenDriver({ noBrowser: true });
  const registry = new DisplayRegistry(
    new JsonStore<{ displays: DisplayRecord[] }>(path.join(dir, "d.json"), { displays: [] }),
    new Map<string, MockDriver | VirtualScreenDriver>([
      ["mock", new MockDriver(1)],
      ["virtual", virtual],
    ]),
  );
  const server = createBrokerApp({ registry, virtual, token: "tk", log: createLogger("t", "error") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, p: string, body?: unknown) =>
    fetch(base + p, { method, headers: { authorization: "Bearer tk", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const ids = async (q = "") => ((await (await call("GET", `/displays${q}`)).json()) as { id: string }[]).map((d) => d.id).sort();
  const tv = encodeURIComponent(VIRTUAL_TV);
  try {
    await call("POST", "/discover");
    assert.deepEqual(await ids("?all=1"), ["mock:tv1"]);
    assert.equal((await fetch(`${base}/virtual`)).status, 401);

    const on = (await (await call("POST", "/virtual", { minutes: 5 })).json()) as { active: boolean; until: string };
    assert.equal(on.active, true);
    assert.deepEqual(await ids(), ["mock:tv1", VIRTUAL_TV]);
    const shown = (await (await call("POST", "/show", { displayIds: [VIRTUAL_TV], content: { kind: "url", url: "http://bingo.localhost/join/ABCD?as=table" } })).json()) as Record<string, { ok: boolean }>;
    assert.equal(shown[VIRTUAL_TV]!.ok, true);

    // The pretend player keeps time; stop really stops it.
    assert.equal((await call("POST", `/displays/${tv}/video`, { url: "http://media.example/v.m3u8?api_key=secret", title: "2 Guns", provider: "movies" })).status, 200);
    let st = (await (await call("GET", `/displays/${tv}/video`)).json()) as { state: string };
    assert.equal(st.state, "playing");
    await call("POST", `/displays/${tv}/video/control`, { action: "pause" });
    assert.equal(((await (await call("GET", `/displays/${tv}/video`)).json()) as { state: string }).state, "paused");
    await call("POST", `/displays/${tv}/video/control`, { action: "stop" });
    st = (await (await call("GET", `/displays/${tv}/video`)).json()) as { state: string };
    assert.equal(st.state, "stopped");

    await call("POST", "/virtual", { off: true });
    assert.deepEqual(await ids("?all=1"), ["mock:tv1"]);
    const refused = (await (await call("POST", "/show", { displayIds: [VIRTUAL_TV], content: { kind: "url", url: "http://bingo.localhost/" } })).json()) as Record<string, { ok: boolean }>;
    assert.notEqual(refused[VIRTUAL_TV]?.ok, true);
    assert.equal((await call("POST", "/virtual/phone/open", { url: "http://bingo.localhost/" })).status, 409);
  } finally {
    await virtual.off();
    server.close();
  }
});

test("virtual test TV: page addresses hide seat tokens and keys", () => {
  assert.equal(safeUrl("https://play.example/bingo/join/ABCD?as=table&key=s3cret"), "https://play.example/bingo/join/ABCD?as=table&key=%E2%80%A6");
  assert.equal(safeUrl("https://play.example/bingo/join/ABCD?host=tok"), "https://play.example/bingo/join/ABCD?host=%E2%80%A6");
});
