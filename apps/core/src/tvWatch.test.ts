import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "@bargames/common";
import type { GameStatus } from "@bargames/sdk";
import { idleScreenHtml } from "./idleScreen.js";
import type { InstalledGame } from "./state.js";
import { TvWatch, type WatchedDisplay } from "./tvWatch.js";

const game = (id: string, enabled = true) => ({ id, enabled, manifest: { sdk: { level: 3 } } }) as unknown as InstalledGame;

function setup(rooms: Record<string, string[] | undefined>) {
  const games = [game("bingo"), game("pool")];
  const displays: WatchedDisplay[] = [
    { id: "tv1", content: { kind: "url", url: "https://bingo.x/join/AAAA?as=table" } },
    { id: "tv2", content: { kind: "url", url: "https://bingo.x/join/BBBB?as=table" } },
    { id: "tv3", content: { kind: "url", url: "https://pool.x/room/CCCC" } },
    { id: "tv4", content: { kind: "idle" } },
  ];
  const shown: string[][] = [];
  const watch = new TvWatch({
    games: () => games,
    roomOf: (g, url) => (url?.startsWith(`https://${g.id}.x/`) ? url.match(/\/(?:join|room)\/([A-Z]+)/)?.[1] : undefined),
    status: async (g) => (rooms[g.id] ? ({ rooms: rooms[g.id]!.map((code) => ({ code, kind: "venue", players: 0 })) } as GameStatus) : undefined),
    displays: async () => displays,
    show: async (ids) => {
      shown.push(ids);
      for (const d of displays) if (ids.includes(d.id)) d.content = { kind: "idle" };
    },
    idle: async () => ({ kind: "idle" }),
    log: createLogger("test", "error"),
  });
  return { watch, shown, games };
}

test("tvwatch: room_closed sends only that room's TVs to idle", async () => {
  const { watch, shown } = setup({});
  await watch.roomClosed("bingo", "AAAA");
  assert.deepEqual(shown, [["tv1"]]);
  await watch.roomClosed("bingo", "ZZZZ");
  assert.equal(shown.length, 1, "no TVs, no call");
});

test("tvwatch: sweep clears a room missing twice, never on an unreadable status", async () => {
  const rooms: Record<string, string[] | undefined> = { bingo: ["AAAA"], pool: undefined };
  const { watch, shown } = setup(rooms);
  await watch.sweep();
  assert.deepEqual(shown, [], "first miss of BBBB only counts");
  await watch.sweep();
  assert.deepEqual(shown, [["tv2"]], "second miss clears BBBB; pool unreadable, left alone");
});

test("tvwatch: a game turned off or removed clears its TVs", async () => {
  const { watch, shown, games } = setup({ bingo: ["AAAA", "BBBB"], pool: ["CCCC"] });
  await watch.gameGone("pool");
  assert.deepEqual(shown, [["tv3"]]);
  (games[0] as { enabled: boolean }).enabled = false;
  await watch.sweep();
  assert.deepEqual(shown.slice(1).flat().sort(), ["tv1", "tv2"], "a disabled game's TVs go idle on the next sweep");
});

test("idle screen: escapes the venue name and includes the Play QR", async () => {
  const html = await idleScreenHtml({
    venue: { name: "Kava <Bar>", theme: { colors: { background: "#000", surface: "#111", text: "#fff", primary: "#f0f", accent: "#ff0" } }, playUrl: "https://play.example.com" },
    games: ["Bingo"],
  });
  assert.match(html, /Kava &lt;Bar&gt;/);
  assert.match(html, /<svg/);
  assert.match(html, /play\.example\.com/);
  assert.match(html, /Tonight: Bingo/);
});
