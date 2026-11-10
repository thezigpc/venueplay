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
