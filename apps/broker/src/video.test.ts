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

test("video 0.28.0: a Venuebox app with a player gets the link over its channel; formats, seek, status, redaction", async () => {
  const { createLogger } = await import("@bargames/common");
  const { WebSocket } = await import("ws");
  const { DeviceStore, Pairings } = await import("./venuebox/devices.js");
  const { VenueboxHub } = await import("./venuebox/hub.js");
  const dir = mkdtempSync(path.join(tmpdir(), "video-vb-"));
  const drivers = new Map();
  const reg = new DisplayRegistry(new JsonStore<{ displays: DisplayRecord[] }>(path.join(dir, "displays.json"), { displays: [] }), drivers);
  const hub = new VenueboxHub({
    devices: new DeviceStore(new JsonStore(path.join(dir, "devices.json"), { devices: [] })),
    pairings: new Pairings(),
    log: createLogger("test", "error"),
    boxName: () => "Test box",
    displaysChanged: async (found, removed) => {
      await reg.merge(found);
      await reg.removeMany(removed);
    },
    reconnected: () => {},
  });
  drivers.set(hub.id, hub);
  const server = hub.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const screens = [{ id: "hdmi", name: "TV", w: 3840, h: 2160 }];
  try {
    const start = (await (await fetch(base + "/pair/start", { method: "POST", body: JSON.stringify({ name: "Den stick", platform: "android", model: "Chromecast with Google TV", screens }) })).json()) as { pairingId: string; code: string };
    const dev = await hub.approve(start.code);
    const { token } = (await (await fetch(`${base}/pair/status?id=${start.pairingId}`)).json()) as { token: string };
    const id = `venuebox:${dev.id}:hdmi`;

    const ws = new WebSocket(base.replace("http", "ws") + "/client");
    const got: Record<string, unknown>[] = [];
    let answer: (m: Record<string, unknown>) => Record<string, unknown> | undefined = () => undefined;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      got.push(m);
      const r = m.type === "video" ? answer(m) : undefined;
      if (r) ws.send(JSON.stringify({ type: "video-reply", requestId: m.requestId, ...r }));
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(
      JSON.stringify({
        type: "hello", v: 1, token, platform: "android", screens, deliveries: ["native-url"],
        video: { containers: ["MP4", "mkv", "hls", "bad name!"], video: ["h264", "hevc"], audio: ["aac", "eac3"], maxHeight: 2160, seek: true, passthrough: ["eac3"] },
      }),
    );
    await new Promise((r) => setTimeout(r, 80));

    const views = await reg.view();
    assert.deepEqual(views.find((v) => v.id === id)!.video, {
      kind: "venuebox",
      model: "android · Chromecast with Google TV",
      formats: { containers: ["mp4", "mkv", "hls"], video: ["h264", "hevc"], audio: ["aac", "eac3"], maxHeight: 2160, seek: true, passthrough: ["eac3"] },
    });

    answer = () => ({ ok: true });
    const r = await reg.playVideo(id, { url: LINK, title: "A movie", mime: "video/x-matroska", startAt: 30 }, "movies");
    assert.deepEqual(r, { ok: true });
    const play = got.find((m) => m.type === "video" && m.op === "play")!;
    assert.deepEqual({ ...play, requestId: "x" }, { type: "video", screen: "hdmi", requestId: "x", op: "play", url: LINK, title: "A movie", mime: "video/x-matroska", startAt: 30 });
    assert.deepEqual(reg.get(id)!.content, { kind: "external", provider: "movies", app: "video", title: "A movie" });
    assert.ok(!readFileSync(path.join(dir, "displays.json"), "utf8").includes("SECRET"), "the link is never stored");

    assert.deepEqual(await reg.videoControl(id, { seek: 600.4 }), { ok: true });
    assert.equal(got.at(-1)!.position, 600);
    answer = (m) => (m.op === "status" ? { ok: true, state: "playing", position: 612.9, duration: 5400 } : { ok: true });
    assert.deepEqual(await reg.videoStatus(id), { state: "playing", position: 612, duration: 5400 });

    // The player reports by itself (ended); a client that stops answering falls back to that.
    ws.send(JSON.stringify({ type: "video-state", screen: "hdmi", state: "stopped", position: 5400, duration: 5400 }));
    answer = () => undefined;
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(await reg.videoStatus(id), { state: "stopped", position: 5400, duration: 5400 });

    // A failure echoing the link: the link never comes back out.
    answer = () => ({ ok: false, reason: "error", message: `can't open ${LINK}` });
    const bad = await reg.playVideo(id, { url: LINK, title: "A movie" }, "movies");
    assert.equal(bad.ok, false);
    assert.doesNotMatch(JSON.stringify(bad), /SECRET|media\.example/);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await reg.view()).find((v) => v.id === id)!.video, undefined, "disconnected: no player to hand a link to");
  } finally {
    hub.close();
    server.close();
  }
});
