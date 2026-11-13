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

test("crash handlers: rejections are logged and survived; exceptions are logged and exit 1", async () => {
  const { installCrashHandlers, createLogger, errorText } = await import("./index.js");
  const before = { rej: process.listeners("unhandledRejection"), exc: process.listeners("uncaughtException") };
  const exits: number[] = [];
  const lines: string[] = [];
  const log = createLogger("t", "error");
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    installCrashHandlers(log, (c) => exits.push(c));
    const rej = process.listeners("unhandledRejection").filter((l) => !before.rej.includes(l))[0] as (r: unknown) => void;
    const exc = process.listeners("uncaughtException").filter((l) => !before.exc.includes(l))[0] as (e: Error) => void;
    rej(new Error("late promise"));
    assert.deepEqual(exits, []);
    exc(new Error("boom"));
    assert.deepEqual(exits, [1]);
    assert.match(lines.join(""), /unhandled promise rejection.*late promise/);
    assert.match(lines.join(""), /uncaught exception.*boom/);
    process.removeListener("unhandledRejection", rej);
    process.removeListener("uncaughtException", exc);
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(errorText("plain"), "plain");
});
