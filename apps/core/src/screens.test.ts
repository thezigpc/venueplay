import { screenKey } from "@bargames/common";
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkVenueExtras } from "./app.js";
import { DEFAULT_VENUE, type InstalledGame } from "./state.js";
import { buildGatewayConfig, buildContext } from "./venue.js";

const kiosk = { id: "checkin", enabled: true, manifest: { id: "checkin", name: "Check-in", kind: "app", routes: { player: "/", table: "/kiosk" }, kiosk: true } } as unknown as InstalledGame;
const menu = { id: "menu", enabled: true, manifest: { id: "menu", name: "Menu", kind: "app", routes: { player: "/", table: "/tv" } } } as unknown as InstalledGame;

test("box 0.31.0: venue country, kiosk apps never idle, the gateway gets the screen key", () => {
  const games = (id: string) => [kiosk, menu].find((g) => g.id === id);
  assert.equal(checkVenueExtras({ ...DEFAULT_VENUE, country: "US" }, games), undefined);
  assert.match(checkVenueExtras({ ...DEFAULT_VENUE, country: "usa" }, games)!, /two-letter/);
  assert.equal(checkVenueExtras({ ...DEFAULT_VENUE, country: null }, games), undefined);
  assert.match(checkVenueExtras({ ...DEFAULT_VENUE, idleModule: "checkin" }, games)!, /touch screens/);
  assert.equal(checkVenueExtras({ ...DEFAULT_VENUE, idleModule: "menu" }, games), undefined);

  assert.equal(buildContext({ ...DEFAULT_VENUE, country: "CA" }, { ...menu, branding: {} } as InstalledGame).venue.country, "CA");
  const key = screenKey("broker-tok");
  const cfg = buildGatewayConfig({ venue: DEFAULT_VENUE, access: {} as never, games: [], coreUrl: "http://core", boxVersion: "0.31.0", setupRequired: false, screenKey: key });
  assert.equal(cfg.screenKey, key);
  assert.notEqual(key, "broker-tok", "never the broker token itself");
});
