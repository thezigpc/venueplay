import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bearer, JsonStore, safeEqual } from "./index.js";

test("JsonStore persists atomically and merges defaults", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bg-store-"));
  const file = path.join(dir, "s.json");
  const s = new JsonStore(file, { a: 1, b: [] as number[] });
  await s.update((d) => void d.b.push(2));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1, b: [2] });
  const again = new JsonStore(file, { a: 1, b: [] as number[], c: "new" });
  assert.deepEqual(again.get(), { a: 1, b: [2], c: "new" });
});

test("token helpers", () => {
  assert.equal(bearer("Bearer abc"), "abc");
  assert.equal(bearer("Basic abc"), "");
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
});

test("JsonStore with a mode fixes an existing file's permissions when it opens it", { skip: process.platform === "win32" ? "no file modes on Windows" : false }, async () => {
  const { mkdtempSync, writeFileSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { JsonStore } = await import("./index.js");
  const dir = mkdtempSync(path.join(tmpdir(), "bg-store-"));
  const file = path.join(dir, "games.json");
  writeFileSync(file, JSON.stringify({ games: [] }), { mode: 0o644 });
  assert.equal(statSync(file).mode & 0o777, 0o644);
  new JsonStore(file, { games: [] }, 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o600, "fixed at open, before any write");
  new JsonStore(path.join(dir, "plain.json"), {});
});
