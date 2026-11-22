// Box 0.28.2: video links on a screen plugged into the box. mpv runs as a second Wayland
// client in the screen's cage session, full screen over the kiosk's Chromium (cage shows the
// newest window); when it ends or stops, mpv quits and the page is back. Same rules as the
// Venuebox desktop client's player (its src/video.ts), driven over mpv's JSON IPC.
//
// PRIVACY: the link (and poster) carry the media server's key. The link reaches mpv only over
// the IPC socket (loadfile), never its command line (process lists); it's never logged,
// stored or put in a message. mpv runs with no config and without the scripts that could show
// or pass it on (stats, console, file list, yt-dlp hook).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Logger } from "@bargames/common";
import { isSeek, type VideoAction, type VideoFormats, type VideoRequest, type VideoResult, type VideoStatus, type VideoTrack, type VideoTracks } from "../../types.js";
import { MpvIpc, type MpvEvent } from "./mpv-ipc.js";

export interface LocalVideoOptions {
  /** The mpv executable (absent: no player on this box). */
  mpv?: string;
  /** Tests: arguments put before mpv's own (a fake mpv script for node). */
  prefixArgs?: string[];
  log?: Logger;
  /** ALSA device for the sound ("plughw:0,3"), or undefined for mpv's default. */
  audioDevice?: () => string | undefined;
  /** How long play waits for mpv to take the link. */
  playMs?: number;
  /** Tests on Windows: the IPC endpoint (a named pipe); default a socket in cage's runtime dir. */
  socketPath?: () => string;
}

/** Where the screen's cage runs: its Wayland socket's directory and name. */
export interface Surface {
  xdg: string;
  display: string;
  /** For --fs on the right output (cage has one). */
  connector: string;
}

interface Player {
  proc: ChildProcess;
  ipc: MpvIpc;
  title: string;
  started: boolean;
  paused: boolean;
  buffering: boolean;
  position?: number;
  duration?: number;
  done: boolean;
  /** Box 0.29.0: the video's tracks, the ids on now, and a subtitle file to load once the video is open. */
  tracks?: VideoTracks;
  audio?: string;
  subtitle?: string | null;
  loaded: boolean;
  pendingSub?: VideoTrack;
  /** How it ended: shown by status until the next play. */
  end?: { state: "stopped" | "error"; message?: string };
}

const secs = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

/** What mpv's end-file errors mean, without the link. */
export function describeError(fileError: unknown): string {
  const e = String(fileError ?? "").toLowerCase();
  if (e.includes("loading failed")) return "couldn't open the stream (the server refused it or isn't reachable)";
  if (e.includes("unrecognized file format")) return "this video's format isn't supported";
  if (e.includes("no audio or video")) return "the stream had nothing to play";
  if (e.includes("output initialization")) return "the player couldn't open the screen or the sound";
  return "playback failed";
}

/** The Wayland socket cage made in its runtime dir ("wayland-0"; not the .lock). */
export function waylandSocket(xdg: string): string | undefined {
  try {
    return readdirSync(xdg).find((n) => /^wayland-\d+$/.test(n));
  } catch {
    return undefined;
  }
}

/**
 * `vainfo` output → codecs the GPU decodes (VAEntrypointVLD). Lines look like
 *   VAProfileHEVCMain               :	VAEntrypointVLD
 */
export function vaapiDecoders(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*VAProfile(\w+)\s*:\s*VAEntrypointVLD\s*$/.exec(line);
    if (!m) continue;
    const p = m[1];
    if (/^H264/.test(p)) out.add("h264");
    else if (/^HEVC/.test(p)) out.add("hevc");
    else if (/^VP9/.test(p)) out.add("vp9");
    else if (/^AV1/.test(p)) out.add("av1");
  }
  return out;
}

/**
 * What a plugged-in screen plays (hello.video's rules): h264 always; hevc/vp9/av1 only with a
 * hardware decoder; 4K when the screen has a 4K mode and the GPU decodes HEVC or H.264; SDR
 * only (cage has no HDR output; mpv tone-maps); no passthrough (plughw, decoded audio).
 */
export function localFormats(hw: Set<string>, tallestMode: number): VideoFormats {
  const video = ["h264", ...["hevc", "av1", "vp9"].filter((c) => hw.has(c))];
  return {
    containers: ["mp4", "mkv", "mov", "webm", "ts", "hls"],
    video,
    audio: ["aac", "mp3", "ac3", "eac3", "dts", "truehd", "opus", "flac"],
    maxHeight: tallestMode >= 2160 && (hw.has("hevc") || hw.has("h264")) ? 2160 : 1080,
    seek: true,
    ranges: ["sdr"],
    tracks: true,
  };
}

/** The box's hardware decoders: VA-API (Intel/AMD) and Nvidia's (when its devices are there). */
export function hardwareDecoders(): Set<string> {
  const hw = new Set<string>();
  for (const dev of ["/dev/dri/renderD128", "/dev/dri/renderD129"]) {
    if (!existsSync(dev)) continue;
    try {
      for (const c of vaapiDecoders(execFileSync("vainfo", ["--display", "drm", "--device", dev], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }))) hw.add(c);
    } catch {
      /* no VA-API driver for this device (Nvidia) */
    }
  }
  // Nvidia (NVDEC): every GPU since Pascal decodes H.264, HEVC and VP9.
  if (existsSync("/dev/nvidiactl")) for (const c of ["h264", "hevc", "vp9"]) hw.add(c);
  return hw;
}

export class LocalVideo {
  private player?: Player;
  private last?: Player;

  constructor(private readonly o: LocalVideoOptions) {}

  get available(): boolean {
    return Boolean(this.o.mpv);
  }

  get playing(): boolean {
    return Boolean(this.player && !this.player.done);
  }

  async play(surface: Surface, video: VideoRequest): Promise<VideoResult> {
    if (!this.o.mpv) return { ok: false, reason: "unsupported", message: "this box has no video player (mpv)" };
    await this.close();
    const sock = this.o.socketPath?.() ?? path.join(surface.xdg, `mpv-${randomBytes(6).toString("hex")}.sock`);
    const start = secs(video.startAt);
    const audio = this.o.audioDevice?.();
    const args = [
      ...(this.o.prefixArgs ?? []),
      "--no-config",
      "--no-terminal",
      "--idle=yes", // started empty: the link comes over IPC (loadfile), not argv
      "--force-window=immediate",
      "--fs",
      "--vo=gpu-next",
      "--gpu-context=wayland",
      "--hwdec=auto-safe",
      "--keep-open=no",
      `--input-ipc-server=${sock}`,
      "--ytdl=no",
      "--load-stats-overlay=no",
      "--load-console=no",
      "--load-select=no",
      "--load-commands=no",
      "--load-auto-profiles=no",
      "--osd-playing-msg=",
      "--cursor-autohide=always",
      "--title=Venuebox video",
      "--ao=alsa",
      ...(audio ? [`--audio-device=alsa/${audio}`] : []),
      ...(start ? [`--start=${start}`] : []),
    ];
    const env = { ...process.env, XDG_RUNTIME_DIR: surface.xdg, WAYLAND_DISPLAY: surface.display };
    const proc = spawn(this.o.mpv, args, { stdio: "ignore", env });
    const ipc = new MpvIpc();
    const title = video.title.slice(0, 200);
    const p: Player = { proc, ipc, title, started: false, paused: false, buffering: false, done: false, loaded: false, tracks: video.tracks };
    this.player = p;
    this.last = p;
    this.o.log?.info("local", "video: starting the player", { connector: surface.connector, title, startAt: start });
    proc.once("error", (err) => this.finish(p, "error", `the video player didn't start (${err.message})`));
    proc.once("exit", (code) => !p.done && this.finish(p, p.started ? "stopped" : "error", p.started ? undefined : `the video player closed (${code ?? "killed"})`));

    const ms = this.o.playMs ?? 12_000;
    const ready = (async () => {
      await ipc.connect(sock, ms);
      ipc.on("property", (name: string, value: unknown) => this.onProperty(p, name, value));
      ipc.on("event", (e: MpvEvent) => this.onEvent(p, e));
      ipc.on("close", () => !p.done && this.finish(p, p.started ? "stopped" : "error", p.started ? undefined : "the video player closed"));
      let id = 1;
      for (const prop of ["pause", "time-pos", "duration", "paused-for-cache"]) await ipc.observe(prop, id++);
      await ipc.command(["set_property", "force-media-title", title]);
      // Box 0.29.0: the tracks to start with (set before the file opens; a subtitle file loads after).
      const t = video.tracks;
      if (t?.audioId) await this.setAudio(p, t.audioId).catch(() => undefined);
      if (t?.subtitleId !== undefined) await this.setSubtitle(p, t.subtitleId).catch(() => undefined);
      await ipc.command(["loadfile", video.url, "replace"]);
    })();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([ready, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("the video player didn't start in time")), ms)))]);
    } catch (err) {
      await this.finish(p, "error", (err as Error).message);
      return { ok: false, reason: "error", message: (err as Error).message.replace(/\/\S+\.sock|\\\\[.?]\\pipe\\\S+/g, "").slice(0, 160) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (p.done) return { ok: false, reason: "error", message: p.end?.message ?? "the video player closed" };
    return { ok: true };
  }

  async control(action: VideoAction): Promise<VideoResult> {
    const p = this.player && !this.player.done ? this.player : undefined;
    if (action === "stop") {
      if (p) await this.finish(p, "stopped");
      return { ok: true };
    }
    if (!p) return { ok: false, reason: "error", message: "nothing is playing on this screen" };
    try {
      if (typeof action === "object" && !isSeek(action)) {
        const ok = "audio" in action ? await this.setAudio(p, action.audio) : await this.setSubtitle(p, action.subtitle);
        return ok ? { ok: true } : { ok: false, reason: "unsupported", message: "that track isn't in the stream that's playing" };
      }
      if (typeof action === "object") {
        await p.ipc.command(["seek", Math.max(0, Math.floor(action.seek)), "absolute"]);
        p.position = Math.max(0, Math.floor(action.seek));
      } else await p.ipc.command(["set_property", "pause", action === "pause"]);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: "error", message: (err as Error).message.slice(0, 120) };
    }
  }

  /** mpv numbers tracks of a kind from 1, in the file's order: aid/sid = index + 1. False: not in this stream. */
  private async setAudio(p: Player, id: string): Promise<boolean> {
    const t = p.tracks?.audio?.find((x) => x.id === id);
    if (t?.index === undefined) return false;
    await p.ipc.command(["set_property", "aid", t.index + 1]);
    p.audio = id;
    return true;
  }

  private async setSubtitle(p: Player, id: string | null): Promise<boolean> {
    if (id === null) {
      p.pendingSub = undefined;
      await p.ipc.command(["set_property", "sid", "no"]);
      p.subtitle = null;
      return true;
    }
    const t = p.tracks?.subtitles?.find((x) => x.id === id);
    if (!t || (t.index === undefined && !t.url)) return false;
    if (t.url) {
      // A side file: mpv can only add it to an open video. "cached" picks it again if it's already there.
      if (p.loaded) await p.ipc.command(["sub-add", t.url, "cached", t.label, ...(t.language ? [t.language] : [])]);
      else p.pendingSub = t;
    } else {
      p.pendingSub = undefined;
      await p.ipc.command(["set_property", "sid", t.index! + 1]);
    }
    p.subtitle = id;
    return true;
  }

  status(): VideoStatus {
    const p = this.player ?? this.last;
    if (!p) return { state: "stopped" };
    const pos = { ...(p.position !== undefined ? { position: p.position } : {}), ...(p.duration !== undefined ? { duration: p.duration } : {}) };
    if (p.done) return { state: p.end?.state ?? "stopped", ...pos, ...(p.end?.message ? { message: p.end.message } : {}) };
    return { state: p.paused && p.started ? "paused" : "playing", ...pos, ...(p.audio !== undefined ? { audio: p.audio } : {}), ...(p.subtitle !== undefined ? { subtitle: p.subtitle } : {}) };
  }

  /** A new page, off, or the kiosk stopping: close the player. */
  async close(): Promise<void> {
    if (this.player && !this.player.done) await this.finish(this.player, "stopped");
  }

  private onProperty(p: Player, name: string, value: unknown) {
    if (name === "time-pos") p.position = secs(value) ?? p.position;
    else if (name === "duration") p.duration = secs(value) ?? p.duration;
    else if (name === "pause") p.paused = value === true;
    else if (name === "paused-for-cache") p.buffering = value === true;
  }

  private onEvent(p: Player, e: MpvEvent) {
    if (p.done) return;
    if (e.event === "file-loaded") {
      p.loaded = true;
      const t = p.pendingSub;
      p.pendingSub = undefined;
      if (t?.url) void p.ipc.command(["sub-add", t.url, "cached", t.label, ...(t.language ? [t.language] : [])]).catch(() => this.o.log?.warn("local", "video: the subtitle file didn't load", { title: p.title }));
    } else if (e.event === "playback-restart" && !p.started) {
      p.started = true;
      this.o.log?.info("local", "video: playing", { title: p.title });
    } else if (e.event === "end-file") {
      const reason = String(e.reason ?? "");
      if (reason === "error") {
        const message = describeError(e.file_error);
        this.o.log?.warn("local", "video: failed", { title: p.title, error: message });
        void this.finish(p, "error", message);
      } else if (reason === "eof" || reason === "quit" || reason === "stop") {
        this.o.log?.info("local", "video: ended", { title: p.title, reason });
        void this.finish(p, "stopped");
      }
    }
  }

  private async finish(p: Player, state: "stopped" | "error", message?: string) {
    if (p.done) return;
    p.done = true;
    p.end = { state, ...(message ? { message } : {}) };
    if (this.player === p) this.player = undefined;
    if (p.ipc.open) await p.ipc.command(["quit"], 1000).catch(() => {});
    p.ipc.close();
    if (p.proc.exitCode === null) {
      const kill = setTimeout(() => p.proc.exitCode === null && p.proc.kill(), 2000);
      p.proc.once("exit", () => clearTimeout(kill));
    }
  }
}
