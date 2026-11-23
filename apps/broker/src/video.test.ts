// Box 0.27.0: video links a TV plays itself (Roku's built-in player; the registry and routes).
import { JsonStore } from "@bargames/common";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseMediaPlayer } from "./drivers/roku/ecp.js";
import { AtvError } from "./drivers/appletv/helper.js";
import { RokuDriver, rokuFormat, type RokuAirplayAuth } from "./drivers/roku/index.js";
import { DisplayRegistry, type DisplayRecord } from "./registry.js";
import { PendingStreamService } from "./streams.js";
import { checkVideo, redactUrls, type DisplayDevice } from "./types.js";

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
  const roku = new RokuDriver(streams, doFetch, { movies: true });
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
        video: { containers: ["MP4", "mkv", "hls", "bad name!"], video: ["h264", "hevc"], audio: ["aac", "eac3"], maxHeight: 2160, seek: true, passthrough: ["eac3"], ranges: ["SDR", "hdr10", "HLG"], tracks: true },
        keys: ["Up", "Select", "Nonsense"],
      }),
    );
    await new Promise((r) => setTimeout(r, 80));

    const views = await reg.view();
    assert.deepEqual(views.find((v) => v.id === id)!.video, {
      kind: "venuebox",
      model: "android · Chromecast with Google TV",
      formats: { containers: ["mp4", "mkv", "hls"], video: ["h264", "hevc"], audio: ["aac", "eac3"], maxHeight: 2160, seek: true, passthrough: ["eac3"], ranges: ["sdr", "hdr10", "hlg"], tracks: true },
    });
    assert.deepEqual(views.find((v) => v.id === id)!.capabilities!.remoteKeys, ["Up", "Select", "Play", "Rev", "Fwd", "Back"], "its own keys plus the video keys");

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

    // Box 0.29.0: tracks go with play; the player switches by itself; the remote's keys drive the video.
    const TRACKS = { audio: [{ id: "a1", label: "English", index: 0 }, { id: "a2", label: "Commentary", index: 1 }], subtitles: [{ id: "s1", label: "English", url: "http://media.example/sub.vtt?api_key=SECRET", format: "vtt" }], audioId: "a1", subtitleId: null };
    answer = () => ({ ok: true });
    assert.deepEqual(await reg.playVideo(id, { url: LINK, title: "A movie", tracks: TRACKS }, "movies"), { ok: true });
    assert.deepEqual(got.findLast((m) => m.op === "play")!.tracks, TRACKS);
    assert.deepEqual(await reg.videoControl(id, { audio: "a2" }), { ok: true });
    assert.deepEqual({ op: got.at(-1)!.op, id: got.at(-1)!.id }, { op: "audio", id: "a2" });
    answer = (m) => (m.op === "status" ? { ok: true, state: "playing", position: 100, duration: 5400 } : { ok: true });
    assert.deepEqual(await reg.videoStatus(id), { state: "playing", position: 100, duration: 5400, audio: "a2", subtitle: null });
    await hub.keypress(reg.get(id)!, "Fwd");
    assert.deepEqual({ op: got.at(-1)!.op, position: got.at(-1)!.position }, { op: "seek", position: 130 });
    await hub.keypress(reg.get(id)!, "Play");
    assert.equal(got.at(-1)!.op, "pause");
    await hub.keypress(reg.get(id)!, "Up");
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(got.at(-1), { type: "key", screen: "hdmi", key: "Up" }, "a key the client takes goes to it");
    // Asked on the device: the app hears it once; a switch made there shows as the new track.
    ws.send(JSON.stringify({ type: "video-remote", screen: "hdmi", action: "next" }));
    ws.send(JSON.stringify({ type: "video-state", screen: "hdmi", state: "playing", position: 101, subtitle: "s1" }));
    await new Promise((r) => setTimeout(r, 30));
    const asked = await reg.videoStatus(id);
    assert.deepEqual(asked.remote, ["next"]);
    assert.equal((await reg.videoStatus(id)).remote, undefined, "handed over once");
    answer = () => undefined;
    await new Promise((r) => setTimeout(r, 10));

    // The player reports by itself (ended); a client that stops answering falls back to that.
    ws.send(JSON.stringify({ type: "video-state", screen: "hdmi", state: "stopped", position: 5400, duration: 5400 }));
    answer = () => undefined;
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(await reg.videoStatus(id), { state: "stopped", position: 5400, duration: 5400, audio: "a2", subtitle: "s1" });
    await assert.rejects(hub.keypress(reg.get(id)!, "Play"), /Nothing is playing/);

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

test("video 0.28.2: a screen plugged into the box plays links in mpv (in its cage); formats from the GPU; the link only over IPC", async () => {
  const { localFormats, vaapiDecoders, LocalVideo, waylandSocket } = await import("./drivers/local/video.js");
  const { randomBytes } = await import("node:crypto");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");

  const hw = vaapiDecoders("vainfo: Driver version: Intel iHD driver\n      VAProfileH264Main               :\tVAEntrypointVLD\n      VAProfileH264Main               :\tVAEntrypointEncSliceLP\n      VAProfileHEVCMain10             :\tVAEntrypointVLD\n      VAProfileVP9Profile0            :\tVAEntrypointVLD\n      VAProfileAV1Profile0            :\tVAEntrypointEncSlice\n");
  assert.deepEqual([...hw].sort(), ["h264", "hevc", "vp9"], "decoders only (VLD), not encoders");
  assert.deepEqual(localFormats(hw, 2160), { containers: ["mp4", "mkv", "mov", "webm", "ts", "hls"], video: ["h264", "hevc", "vp9"], audio: ["aac", "mp3", "ac3", "eac3", "dts", "truehd", "opus", "flac"], maxHeight: 2160, seek: true, ranges: ["sdr"], tracks: true });
  assert.equal(localFormats(new Set(), 2160).maxHeight, 1080, "4K needs a hardware decoder");
  assert.deepEqual(localFormats(new Set(), 1080).video, ["h264"]);

  const dir = mkdtempSync(path.join(tmpdir(), "video-local-"));
  const xdg = path.join(dir, "xdg");
  mkdirSync(xdg);
  writeFileSync(path.join(xdg, "wayland-0"), "");
  writeFileSync(path.join(xdg, "wayland-0.lock"), "");
  assert.equal(waylandSocket(xdg), "wayland-0");

  const fake = fileURLToPath(new URL("./drivers/local/fake-mpv.ts", import.meta.url));
  const logFile = path.join(dir, "mpv.log");
  process.env.FAKE_MPV_LOG = logFile;
  const sock = () => (process.platform === "win32" ? `\\\\.\\pipe\\bg-mpv-${randomBytes(6).toString("hex")}` : path.join(dir, `m-${randomBytes(4).toString("hex")}.sock`));
  const v = new LocalVideo({ mpv: process.execPath, prefixArgs: ["--import", "tsx", fake], socketPath: sock, audioDevice: () => "plughw:0,3" });
  const surface = { xdg, display: "wayland-0", connector: "HDMI-A-1" };
  try {
    assert.deepEqual(await v.play(surface, { url: LINK, title: "A movie", startAt: 20 }), { ok: true });
    await new Promise((r) => setTimeout(r, 250));
    const st = v.status();
    assert.equal(st.state, "playing");
    assert.ok(st.position! >= 20 && st.duration === 120);
    assert.deepEqual(await v.control("pause"), { ok: true });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(v.status().state, "paused");
    assert.deepEqual(await v.control({ seek: 90.6 }), { ok: true });
    assert.equal(v.status().position, 90);
    assert.deepEqual(await v.control("stop"), { ok: true });
    assert.equal(v.status().state, "stopped");

    const log = readFileSync(logFile, "utf8");
    const argv = log.split("\n").filter((l) => l.startsWith("ARGV")).join("\n");
    assert.ok(!argv.includes("SECRET"), "the link is never on mpv's command line");
    assert.match(argv, /--gpu-context=wayland/);
    assert.match(argv, /--audio-device=alsa\/plughw:0,3/);
    assert.match(argv, /--start=20/);
    assert.match(log, /CMD \["loadfile","http:\/\/media\.example/, "it goes over IPC");

    // Box 0.29.0: tracks: aid/sid by position in the file, a subtitle file once the video is open.
    const tracks = { audio: [{ id: "a1", label: "English", index: 0 }, { id: "a2", label: "Commentary", index: 1 }, { id: "a3", label: "Not in this stream" }], subtitles: [{ id: "s1", label: "PGS", index: 0 }, { id: "s2", label: "English", url: "http://media.example/sub.vtt?api_key=SECRET" }], audioId: "a2", subtitleId: "s2" };
    assert.deepEqual(await v.play(surface, { url: LINK, title: "A movie", tracks }), { ok: true });
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual({ audio: v.status().audio, subtitle: v.status().subtitle }, { audio: "a2", subtitle: "s2" });
    assert.deepEqual(await v.control({ subtitle: "s1" }), { ok: true });
    assert.deepEqual(await v.control({ subtitle: null }), { ok: true });
    assert.equal((await v.control({ audio: "a3" })).reason, "unsupported");
    assert.equal(v.status().subtitle, null);
    const cmds = readFileSync(logFile, "utf8");
    assert.match(cmds, /CMD \["set_property","aid",2\]/);
    assert.match(cmds, /CMD \["sub-add","http:\/\/media\.example\/sub\.vtt\?api_key=SECRET","cached","English"\]/);
    assert.match(cmds, /CMD \["set_property","sid",1\]/);
    assert.match(cmds, /CMD \["set_property","sid","no"\]/);
    await v.control("stop");

    // A link the server refuses: the player closes and says why, without the link.
    assert.deepEqual(await v.play(surface, { url: "http://media.example/fail?api_key=SECRET", title: "Bad" }), { ok: true });
    await new Promise((r) => setTimeout(r, 300));
    const failed = v.status();
    assert.equal(failed.state, "error");
    assert.match(failed.message!, /couldn't open the stream/);
    assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
    assert.equal((await v.control("pause")).ok, false, "nothing playing");

    // No mpv on the box: not offered.
    assert.equal((await new LocalVideo({}).play(surface, { url: LINK, title: "x" })).reason, "unsupported");
  } finally {
    await v.close();
    delete process.env.FAKE_MPV_LOG;
  }
});

test("video 0.29.8: a Roku without a built-in player (404) gets the movie over AirPlay; pairing; controls; nothing echoed", async () => {
  const ecp: string[] = [];
  const doFetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    ecp.push(u.pathname);
    if (u.pathname === "/input/15985") return new Response("", { status: 404 });
    return new Response("");
  }) as typeof fetch;
  const dir = mkdtempSync(path.join(tmpdir(), "video-"));
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  let paired = false;
  const fake = (helper: string) => async (op: string, args: Record<string, unknown> = {}) => {
    calls.push({ op: `${helper}:${op}`, args });
    if (op === "pair_begin") return { pin: true };
    if (op === "pair_finish") {
      if (args.pin !== "1234") throw new AtvError("that PIN didn't work", "pin");
      paired = true;
      return { credentials: "roku-air" };
    }
    if (op === "video_play" && args.airplay !== "roku-air") throw new AtvError("the Apple TV wants the box paired for AirPlay video", "needs-pairing");
    if (op === "video_status") return { state: "playing", position: 12, duration: 5400 };
    return { ok: true };
  };
  const auth = new JsonStore<RokuAirplayAuth>(path.join(dir, "roku-airplay.json"), { airplay: {} }, 0o600);
  const roku = new RokuDriver(new PendingStreamService(), doFetch, { atv: fake("main"), video: fake("video"), auth, movies: true });
  const dev = { id: "roku:T1", driver: "roku", name: "Bar TV", address: "http://192.0.2.71:8060", isTv: true, meta: { supportsAirplay: true } } as DisplayDevice;

  assert.deepEqual((await roku.capabilities(dev)).moviePairing, { paired: false });
  const first = await roku.playVideo(dev, { url: LINK, title: "A movie", mime: "video/mp4" });
  assert.equal(first.reason, "needs-pairing");
  assert.match(first.message!, /Movies over AirPlay/);
  assert.doesNotMatch(JSON.stringify(first), /SECRET/);
  assert.equal(ecp.filter((p) => p === "/input/15985").length, 1);

  assert.deepEqual(await roku.pairControl(dev), { ok: false, needsCode: true, message: "Enter the PIN the TV is showing." });
  assert.equal((await roku.pairControl(dev, "9999")).needsCode, true);
  assert.equal((await roku.pairControl(dev, "1234")).ok, true);
  assert.ok(paired);
  assert.deepEqual((await roku.capabilities(dev)).moviePairing, { paired: true });
  assert.ok(calls.filter((c) => c.op.endsWith(":pair_begin") || c.op.endsWith(":pair_finish")).every((c) => c.op.startsWith("main:")), "pairing on stock pyatv");
  assert.equal(calls.find((c) => c.op === "main:pair_begin")!.args.address, "192.0.2.71");

  assert.deepEqual(await roku.playVideo(dev, { url: LINK, title: "A movie", mime: "video/mp4", startAt: 95 }), { ok: true });
  assert.equal(ecp.filter((p) => p === "/input/15985").length, 1, "no second try of the missing player");
  const play = calls.filter((c) => c.op === "video:video_play").pop()!;
  assert.deepEqual([play.args.address, play.args.url, play.args.startAt, play.args.airplay], ["192.0.2.71", LINK, 95, "roku-air"]);

  assert.deepEqual(await roku.videoStatus(dev), { state: "playing", position: 12, duration: 5400 });
  assert.deepEqual(await roku.videoControl(dev, { seek: 300 }), { ok: true }, "seek works over AirPlay");
  assert.deepEqual(await roku.videoControl(dev, "pause"), { ok: true });
  assert.deepEqual(await roku.videoControl(dev, "stop"), { ok: true });
  assert.deepEqual(calls.filter((c) => c.op === "video:video_control").map((c) => c.args.action), ["seek", "pause", "stop"]);
  assert.ok(!ecp.includes("/keypress/Home"), "stop goes over AirPlay, not ECP");
  assert.equal(readFileSync(path.join(dir, "roku-airplay.json"), "utf8").includes("SECRET"), false);
});

test("video 0.30.2: Rokus aren't offered for movies unless ROKU_VIDEO=on (no player there yet)", async () => {
  let calls = 0;
  const doFetch = (async () => (calls++, new Response(""))) as typeof fetch;
  const roku = new RokuDriver(new PendingStreamService(), doFetch, { atv: async () => ({}), video: async () => ({}) });
  const dev = { id: "roku:P1", driver: "roku", name: "Stick", address: "http://192.0.2.61:8060", model: "Roku Express 3930X" };
  assert.equal(roku.videoInfo(dev), undefined);
  const r = await roku.playVideo(dev, { url: "http://media.example/v.mp4", title: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unsupported");
  assert.match(r.message ?? "", /Roku channel/);
  assert.equal(calls, 0);
  assert.equal((await roku.capabilities(dev)).moviePairing, undefined);
});
