import assert from "node:assert/strict";
import { test } from "node:test";
import { PasswordLimiter } from "./limiter.js";

const t0 = 5_000_000;

test("password limiter: 10 wrong per source, then a 15-minute lock", () => {
  const l = new PasswordLimiter();
  for (let i = 0; i < 9; i++) l.failed("198.51.100.1", {}, t0);
  assert.equal(l.allowed("198.51.100.1", {}, t0), true);
  l.failed("198.51.100.1", {}, t0);
  assert.equal(l.allowed("198.51.100.1", {}, t0), false);
  assert.equal(l.allowed("198.51.100.1", {}, t0 + 15 * 60_000 + 1), true, "the lock expires");
  l.succeeded("198.51.100.2");
  assert.equal(l.allowed("198.51.100.2", {}, t0), true);
});

test("password limiter: guests can't lock staff out from the venue LAN", () => {
  const l = new PasswordLimiter();
  // 50 wrong tries through a game's login form (different reported IPs, under the game's cap of 30 each).
  for (let i = 0; i < 25; i++) l.failed(`bingo:203.0.113.${i}`, { group: "bingo" }, t0);
  for (let i = 0; i < 25; i++) l.failed(`trivia:203.0.113.${i}`, { group: "trivia" }, t0);
  assert.equal(l.allowed("198.51.100.7", {}, t0), false, "remote logins: the box-wide lock applies");
  assert.equal(l.allowed("192.0.2.20", { lan: true }, t0), true, "a LAN login is never blocked by it");

  // A LAN IP's own wrong tries still lock that IP, and don't feed the box-wide count.
  const m = new PasswordLimiter();
  for (let i = 0; i < 10; i++) m.failed("192.0.2.20", { lan: true }, t0);
  assert.equal(m.allowed("192.0.2.20", { lan: true }, t0), false);
  assert.equal(m.allowed("192.0.2.21", { lan: true }, t0), true);
  assert.equal(m.allowed("198.51.100.7", {}, t0), true, "LAN failures don't count box-wide");

  // Changing address on the venue Wi-Fi doesn't give unlimited guesses: 100 wrong across the LAN locks LAN logins.
  const n = new PasswordLimiter();
  for (let i = 0; i < 99; i++) n.failed(`192.0.2.${i}`, { lan: true }, t0);
  assert.equal(n.allowed("192.0.2.200", { lan: true }, t0), true);
  n.failed("192.0.2.99", { lan: true }, t0);
  assert.equal(n.allowed("192.0.2.200", { lan: true }, t0), false, "a fresh LAN address is locked too");
  assert.equal(n.allowed("198.51.100.7", {}, t0), true, "remote logins have their own count");
  assert.equal(n.allowed("192.0.2.200", { lan: true }, t0 + 15 * 60_000 + 1), true, "and it expires");
});

test("password limiter: one game's login form has its own cap (the reported IP is the game's word)", () => {
  const l = new PasswordLimiter();
  for (let i = 0; i < 30; i++) l.failed(`bingo:203.0.113.${i}`, { group: "bingo" }, t0);
  assert.equal(l.allowed("bingo:203.0.113.200", { group: "bingo" }, t0), false, "a fresh 'IP' through the same game is locked");
  assert.equal(l.allowed("trivia:203.0.113.200", { group: "trivia" }, t0), true, "other games aren't");
  assert.equal(l.allowed("192.0.2.20", { lan: true }, t0), true);
});
