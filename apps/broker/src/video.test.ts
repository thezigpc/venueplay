// Box 0.27.0: video links a TV plays itself (Roku's built-in player; the registry and routes).
import { JsonStore } from "@bargames/common";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseMediaPlayer } from "./drivers/roku/ecp.js";
import { RokuDriver, rokuFormat } from "./drivers/roku/index.js";
import { DisplayRegistry, type DisplayRecord } from "./registry.js";
import { PendingStreamService } from "./streams.js";
import { checkVideo, redactUrls } from "./types.js";

const LINK = "http://media.example:8096/Videos/abc/stream?static=true&api_key=SECRET";

test("video: Roku formats from the MIME type or the link; media-player XML; link redaction; request checks", () => {
  assert.equal(rokuFormat("application/vnd.apple.mpegurl"), "hls");
  assert.equal(rokuFormat("video/x-matroska"), "mkv");
  assert.equal(rokuFormat("video/quicktime"), "mov");
  assert.equal(rokuFormat("video/mp4"), "mp4");
  assert.equal(rokuFormat(undefined, "https://x/Videos/1/master.m3u8?api_key=k"), "hls");
  assert.equal(rokuFormat(undefined, "https://x/a.mkv"), "mkv");
  assert.equal(rokuFormat(undefined, "not a url"), "mp4");

  const p = parseMediaPlayer(
    '<?xml version="1.0"?><player error="false" state="play"><plugin bandwidth="1 bps" id="15985" name="Play on Roku"/><format audio="aac" video="mpeg4_10b"/><position>65432 ms</position><duration>5400000 ms</duration></player>',
  );
  assert.deepEqual(p, { state: "play", error: false, plugin: "15985", position: 65, duration: 5400 });
  assert.deepEqual(parseMediaPlayer('<player error="false" state="close"/>'), { state: "close", error: false, plugin: undefined, position: undefined, duration: undefined });

  assert.equal(redactUrls(`Roku POST /input/15985?t=v&u=${encodeURIComponent(LINK)}: HTTP 500`), "Roku POST /input/15985?… HTTP 500");
  assert.equal(redactUrls(`fetch ${LINK} failed`), "fetch <url> failed");

  assert.equal(checkVideo({ url: "file:///etc/passwd", title: "x", provider: "movies" }), "url: an http or https link (up to 4096 characters)");
  assert.equal(checkVideo({ url: LINK, title: " ", provider: "movies" }), "title required");
  assert.equal(checkVideo({ url: LINK, title: "x", provider: "movies", poster: "javascript:alert(1)" }), "poster: an http or https link");
  assert.deepEqual(checkVideo({ url: LINK, title: " A movie ", provider: "movies", mime: "video/mp4", startAt: 95.7, poster: "" }), {
    provider: "movies",
    video: { url: LINK, title: "A movie", mime: "video/mp4", startAt: 95 },
  });
});

test("video: a Roku gets the link through its built-in player; status, pause, stop; no seek; nothing stored", async () => {
  const calls: { method: string; path: string; query: URLSearchParams }[] = [];
  let player = '<player error="false" state="play"><plugin id="15985"/><position>1000 ms</position><duration>90000 ms</duration></player>';
  let refuse = 0;
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: u.pathname, query: u.searchParams });
    if (refuse) return new Response("", { status: refuse });
    if (u.pathname === "/query/media-player") return new Response(player);
    return new Response("");
  }) as typeof fetch;
  const stopped: string[] = [];
  const streams = Object.assign(new PendingStreamService(), { stopFor: async (id: string) => void stopped.push(id), state: () => ({ delivery: "airplay" as const, url: "x", state: "streaming", needsCode: false }) });
  const roku = new RokuDriver(streams, doFetch);
  const dir = mkdtempSync(path.join(tmpdir(), "video-"));
  const reg = new DisplayRegistry(
    new JsonStore<{ displays: DisplayRecord[] }>(path.join(dir, "displays.json"), {
      displays: [
        { id: "roku:P1", driver: "roku", name: "Stick", address: "http://192.0.2.61:8060", model: "Roku Express 3930X" },
        { id: "roku:GONE", driver: "roku", name: "Old", address: "http://192.0.2.62:8060", ignored: true },
      ],
    }),
    new Map([["roku", roku]]),
  );

  const views = await reg.view();
  assert.deepEqual(views[0].video, { kind: "roku", model: "3930X" });

  const r = await reg.playVideo("roku:P1", { url: LINK, title: "A movie", mime: "application/vnd.apple.mpegurl", poster: "http://media.example:8096/poster.jpg", startAt: 30 }, "movies");
  assert.equal(r.ok, true);
  assert.match(r.message!, /from the beginning/);
  assert.deepEqual(stopped, ["roku:P1"], "the box's own cast stops first");
  const play = calls.find((c) => c.path === "/input/15985")!;
  assert.equal(play.method, "POST");
  assert.equal(play.query.get("t"), "v");
  assert.equal(play.query.get("u"), LINK);
  assert.equal(play.query.get("videoFormat"), "hls");
  assert.equal(play.query.get("videoName"), "A movie");
  assert.equal(play.query.get("k"), "http://media.example:8096/poster.jpg");
  assert.deepEqual(reg.get("roku:P1")!.content, { kind: "external", provider: "movies", app: "video", title: "A movie" });
  assert.ok(!readFileSync(path.join(dir, "displays.json"), "utf8").includes("SECRET"), "the link is never stored");

  assert.deepEqual(await reg.videoStatus("roku:P1"), { state: "playing", position: 1, duration: 90 });
  calls.length = 0;
  assert.deepEqual(await reg.videoControl("roku:P1", "pause"), { ok: true });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /query/media-player", "POST /keypress/Play"]);
  calls.length = 0;
  assert.deepEqual(await reg.videoControl("roku:P1", "resume"), { ok: true });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /query/media-player"], "already playing: Play is a toggle, so not pressed");
  assert.equal((await reg.videoControl("roku:P1", { seek: 100 })).reason, "unsupported");
  calls.length = 0;
  assert.deepEqual(await reg.videoControl("roku:P1", "stop"), { ok: true });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /keypress/Home"]);

  player = '<player error="false" state="play"><plugin id="12"/></player>';
  assert.deepEqual(await reg.videoStatus("roku:P1"), { state: "stopped" }, "another channel playing: our video stopped");
  player = '<player error="true" state="stop"><plugin id="15985"/></player>';
  assert.equal((await reg.videoStatus("roku:P1")).state, "error");

  refuse = 403;
  const blocked = await reg.playVideo("roku:P1", { url: LINK, title: "A movie" }, "movies");
  assert.equal(blocked.reason, "not-allowed");
  refuse = 500;
  const failed = await reg.playVideo("roku:P1", { url: LINK, title: "A movie" }, "movies");
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /SECRET|media\.example/);

  await assert.rejects(reg.playVideo("roku:GONE", { url: LINK, title: "x" }, "movies"), /no display/, "ignored TVs are refused");
});
