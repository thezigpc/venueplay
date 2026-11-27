import { screenKey, verifyScreen } from "@bargames/common";
import assert from "node:assert/strict";
import { test } from "node:test";
import { screenCookieParams } from "./screenCookie.js";
import { VirtualScreenDriver } from "./drivers/virtual.js";

test("screen cookie (box 0.31.0): signed for the page's site, carries the screen, only for http(s)", () => {
  const key = screenKey("broker-tok");
  const dev = { id: "local:HDMI-A-1", driver: "local", name: "HDMI-A-1", label: "Door", touch: true } as never;
  const p = screenCookieParams(key, dev, "https://play.example.com/checkin/kiosk?x=1", 1_000_000)!;
  assert.equal(p.name, "bg_screen");
  assert.equal(p.url, "https://play.example.com");
  assert.equal(p.secure, true);
  assert.equal(p.httpOnly, true);
  assert.deepEqual(verifyScreen(key, p.value as string, 1_000_000), { id: "local:HDMI-A-1", name: "Door", touch: true }, "the venue's name for it");
  assert.equal(verifyScreen(screenKey("other"), p.value as string, 1_000_000), undefined);
  assert.equal(screenCookieParams(key, dev, "data:text/html,x"), undefined);
  assert.equal(screenCookieParams(undefined, dev, "https://play.example.com/"), undefined);
  assert.equal(screenCookieParams(key, dev, "http://192.0.2.1/")!.secure, false);
});

test("virtual TV: show still works without a browser when it has a screen key", async () => {
  const v = new VirtualScreenDriver({ noBrowser: true, screenKey: screenKey("t") });
  v.on(5);
  const [d] = await v.discover();
  assert.deepEqual(await v.show(d, { kind: "url", url: "https://play.example.com/checkin/kiosk" }), { ok: true, delivery: "mock" });
  v.off();
});
