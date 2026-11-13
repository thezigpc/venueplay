// Plays audio on the box's outputs. One session per output: a source (GStreamer decoding a
// URL core hands over, or the test chime) → this process (volume, pause) → an output
// process (aplay for the box's jack/HDMI and Bluetooth speakers, pyatv for AirPlay TVs).
//
//   source ──S16LE 44.1k stereo──▶ pump (gain, silence while paused) ──▶ sink stdin
//
// Sinks pull at real time, so pipe back-pressure paces everything; a paused session keeps
// the sink fed with silence so speakers and AirPlay sessions stay connected.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { JsonStore, Logger } from "@bargames/common";
import { applyGain, BYTES_PER_SEC, gainFor, SampleAligner, SILENCE, toneStream, wavHeader } from "./pcm.js";
import { DEFAULT_VOLUME, type AudioSettings, type OutputTarget, type OutputView, type SessionView, type TrackInfo } from "./types.js";

export type Spawn = (cmd: string, args: string[]) => ChildProcess;

export interface EngineOptions {
  settings: JsonStore<AudioSettings>;
  /** Every output the box has right now (box, Bluetooth, TVs). */
  targets: () => Promise<OutputTarget[]>;
  /** Connects a paired Bluetooth speaker before playing (throws with a plain message). */
  ensureBluetooth?: (address: string) => Promise<void>;
  log: Logger;
  spawn?: Spawn;
  /** pyatv's Python and the AirPlay audio helper (atv-stream.py). Absent: no TV outputs. */
  airplay?: { python: string; script: string };
  /** How long an ended session stays visible (apps poll for "ended"). */
  keepEndedMs?: number;
}

export interface PlayRequest extends TrackInfo {
  /** Output id; absent: the venue's default output. */
  output?: string;
  /** http(s) URL of the audio (core's one-time source URL). */
  url?: string;
  /** The test chime instead of a URL. */
  tone?: boolean;
  owner: string;
}

interface Session {
  view: SessionView;
  kind: OutputTarget["kind"];
  paused: boolean;
  stopped: boolean;
  bytes: number;
  source?: ChildProcess;
  sink?: ChildProcess;
  abort: AbortController;
  sourceErr: string;
  sinkErr: string;
  /** Wakes the pump while it waits for the source (pause, stop, output gone). */
  wake?: () => void;
}

const WOKEN = Symbol("woken");

const URL_OK = /^https?:\/\/[^\s!"'\\]+$/;
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

export class AudioEngine {
  private sessions = new Map<string, Session>();
  private readonly spawn: Spawn;

  constructor(private readonly o: EngineOptions) {
    this.spawn = o.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }));
  }

  // ---------------------------------------------------------------- outputs

  async outputs(): Promise<OutputView[]> {
    const s = this.o.settings.get();
    const targets = await this.o.targets();
    const def = this.defaultOf(targets);
    return targets.map((t) => {
      const session = this.current(t.id);
      return {
        ...t,
        ...(s.labels[t.id] ? { label: s.labels[t.id] } : {}),
        volume: s.volumes[t.id] ?? DEFAULT_VOLUME,
        default: t.id === def,
        ...(session ? { session: this.view(session) } : {}),
      };
    });
  }

  /** The venue's default, or the first output that can play (the box's jack). */
  private defaultOf(targets: OutputTarget[]): string | undefined {
    const want = this.o.settings.get().defaultOutput;
    if (want && targets.some((t) => t.id === want)) return want;
    return targets.find((t) => t.available)?.id;
  }

  async setDefault(id: string): Promise<void> {
    if (!(await this.o.targets()).some((t) => t.id === id)) throw httpError(404, "no such output");
    await this.o.settings.update((s) => {
      s.defaultOutput = id;
    });
  }

  async setVolume(id: string, volume: number): Promise<void> {
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw httpError(400, "volume: 0-100");
    await this.o.settings.update((s) => {
      s.volumes[id] = Math.round(volume);
    });
  }

  async setLabel(id: string, label: string | null): Promise<void> {
    await this.o.settings.update((s) => {
      const l = (label ?? "").trim().slice(0, 40);
      if (l) s.labels[id] = l;
      else delete s.labels[id];
    });
  }

  // ---------------------------------------------------------------- sessions

  /** Sessions now (and ended ones for a minute), optionally only one owner's. */
  list(owner?: string): SessionView[] {
    this.prune();
    return [...this.sessions.values()].filter((s) => !owner || s.view.owner === owner).map((s) => this.view(s));
  }

  get(id: string): SessionView | undefined {
    const s = this.sessions.get(id);
    return s ? this.view(s) : undefined;
  }

  async play(req: PlayRequest): Promise<SessionView> {
    if (!req.tone && !(req.url && URL_OK.test(req.url))) throw httpError(400, "url: an http(s) address");
    const targets = await this.o.targets();
    const id = req.output ?? this.defaultOf(targets);
    const target = targets.find((t) => t.id === id);
    if (!target) throw httpError(404, req.output ? "That output isn't on this box any more." : "This box has no sound output.");
    if (!target.available) throw httpError(409, `${target.name} can't play right now${target.detail ? `: ${target.detail}` : ""}.`);
    if (target.kind === "tv" && !this.o.airplay) throw httpError(409, "Playing on TVs isn't available on this box.");

    const old = this.current(target.id);
    if (old) this.stop(old.view.id, `Replaced by something else on ${target.name}.`);
    if (target.kind === "bluetooth") await this.o.ensureBluetooth?.(target.address);

    const s: Session = {
      view: {
        id: randomBytes(8).toString("hex"),
        output: target.id,
        owner: req.owner,
        state: "starting",
        positionMs: 0,
        startedAt: new Date().toISOString(),
        ...pickTrack(req),
      },
      kind: target.kind,
      paused: false,
      stopped: false,
      bytes: 0,
      abort: new AbortController(),
      sourceErr: "",
      sinkErr: "",
    };
    this.sessions.set(s.view.id, s);

    try {
      s.sink = this.startSink(target, req);
      s.sink.stderr?.on("data", (d: Buffer) => (s.sinkErr = (s.sinkErr + d.toString("utf8")).slice(-2000)));
      let source: Readable;
      if (req.tone) source = toneStream();
      else {
        s.source = this.spawn("gst-launch-1.0", gstArgs(req.url!));
        s.source.stderr?.on("data", (d: Buffer) => (s.sourceErr = (s.sourceErr + d.toString("utf8")).slice(-2000)));
        source = s.source.stdout!;
      }
      void this.pump(s, source);
    } catch (err) {
      this.finish(s, "error", `Couldn't start playing: ${(err as Error).message}`);
    }
    this.o.log.info("audio", "playing", { session: s.view.id, output: target.id, owner: req.owner });
    return this.view(s);
  }

  pause(id: string): SessionView {
    const s = this.live(id);
    s.paused = true;
    if (s.view.state === "playing" || s.view.state === "starting") s.view.state = "paused";
    s.wake?.();
    return this.view(s);
  }

  resume(id: string): SessionView {
    const s = this.live(id);
    s.paused = false;
    if (s.view.state === "paused") s.view.state = s.bytes ? "playing" : "starting";
    return this.view(s);
  }

  stop(id: string, message = "Stopped."): SessionView {
    const s = this.sessions.get(id);
    if (!s) throw httpError(404, "no such session");
    if (s.view.state !== "ended" && s.view.state !== "error") {
      s.stopped = true;
      s.abort.abort();
      s.wake?.();
      s.source?.kill("SIGTERM");
      s.sink?.kill("SIGTERM");
      this.finish(s, "ended", message);
    }
    return this.view(s);
  }

  /** Stops everything (broker shutting down). */
  shutdown(): void {
    for (const s of this.sessions.values()) if (s.view.state !== "ended" && s.view.state !== "error") this.stop(s.view.id, "The box is restarting.");
  }

  // ---------------------------------------------------------------- internals

  private startSink(t: OutputTarget, track: TrackInfo): ChildProcess {
    const raw = ["-q", "-t", "raw", "-f", "S16_LE", "-r", "44100", "-c", "2"];
    if (t.kind === "box") return this.spawn("aplay", [...raw, "-D", t.address, "-"]);
    if (t.kind === "bluetooth") return this.spawn("aplay", [...raw, "-D", `bluealsa:DEV=${t.address},PROFILE=a2dp`, "-"]);
    const a = this.o.airplay!;
    return this.spawn(a.python, [a.script, JSON.stringify({ host: t.address, title: track.title, artist: track.artist, album: track.album })]);
  }

  private async pump(s: Session, source: Readable): Promise<void> {
    const sink = s.sink!.stdin as Writable;
    let sinkGone = false;
    sink.on("error", () => (sinkGone = true));
    const sinkExit = exitOf(s.sink!, (m) => (s.sinkErr += m));
    void sinkExit.then(() => {
      sinkGone = true;
      s.wake?.();
    });
    const sourceExit = s.source ? exitOf(s.source, (m) => (s.sourceErr += m)) : Promise.resolve(0);
    const it = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    const align = new SampleAligner();
    const drained = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          sink.off("drain", done);
          sink.off("close", done);
          s.abort.signal.removeEventListener("abort", done);
          resolve();
        };
        sink.once("drain", done);
        sink.once("close", done);
        s.abort.signal.addEventListener("abort", done, { once: true });
      });

    // The source's next chunk, kept across a pause (the read was already asked for).
    let pending: Promise<IteratorResult<Buffer>> | undefined;
    const woken = () => new Promise<typeof WOKEN>((resolve) => (s.wake = () => resolve(WOKEN)));

    try {
      if (s.kind === "tv") sink.write(wavHeader());
      while (!s.stopped && !sinkGone) {
        let chunk: Buffer;
        if (s.paused) {
          // 100 ms of silence about every 90 ms: keeps the output open without racing ahead.
          if (!sink.write(Buffer.from(SILENCE))) await drained();
          await Promise.race([new Promise((r) => setTimeout(r, 90)), woken()]);
          s.wake = undefined;
          continue;
        } else {
          pending ??= it.next();
          const r = await Promise.race([pending, woken()]);
          s.wake = undefined;
          if (r === WOKEN) continue;
          pending = undefined;
          if (r.done || s.stopped) break;
          chunk = align.push(r.value);
          if (!chunk.length) continue;
          s.bytes += chunk.length;
          if (s.view.state === "starting") s.view.state = "playing";
        }
        applyGain(chunk, gainFor(this.o.settings.get().volumes[s.view.output] ?? DEFAULT_VOLUME));
        if (!sink.write(chunk)) await drained();
      }
    } catch {
      // the source was killed (stop) or broke; handled below
    }
    if (s.stopped) return;

    if (sinkGone) {
      s.source?.kill("SIGTERM");
      return this.finish(s, "error", sinkProblem(s.kind, s.sinkErr));
    }
    sink.end();
    const [srcCode, sinkCode] = await Promise.all([sourceExit, sinkExit]);
    if (s.stopped) return;
    if (srcCode !== 0 && s.bytes === 0) return this.finish(s, "error", `Couldn't play that audio${gstProblem(s.sourceErr)}`);
    // aplay and the AirPlay helper exit 0 at the end of the stream; anything else is a failure.
    if (sinkCode !== 0) return this.finish(s, "error", sinkProblem(s.kind, s.sinkErr));
    this.finish(s, "ended", srcCode !== 0 ? `Stopped early${gstProblem(s.sourceErr)}` : undefined);
  }

  private finish(s: Session, state: "ended" | "error", message?: string) {
    if (s.view.state === "ended" || s.view.state === "error") return;
    s.view.positionMs = positionOf(s);
    s.view.state = state;
    s.view.endedAt = new Date().toISOString();
    if (message) s.view.message = message;
    if (state === "error") this.o.log.warn("audio", "playback failed", { session: s.view.id, output: s.view.output, message });
  }

  private current(outputId: string): Session | undefined {
    return [...this.sessions.values()].find((s) => s.view.output === outputId && s.view.state !== "ended" && s.view.state !== "error");
  }

  private live(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw httpError(404, "no such session");
    if (s.view.state === "ended" || s.view.state === "error") throw httpError(409, "That has finished playing.");
    return s;
  }

  private view(s: Session): SessionView {
    return { ...s.view, positionMs: s.view.endedAt ? s.view.positionMs : positionOf(s) };
  }

  private prune() {
    const keep = this.o.keepEndedMs ?? 60_000;
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.view.endedAt && now - Date.parse(s.view.endedAt) > keep) this.sessions.delete(id);
  }
}

/** A process's exit code; a process that couldn't start (missing program) counts as 127. */
function exitOf(p: ChildProcess, onError: (message: string) => void): Promise<number> {
  return new Promise((resolve) => {
    p.once("error", (err) => {
      onError(String(err));
      resolve(127);
    });
    p.once("close", (code) => resolve(code ?? 1));
  });
}

const positionOf = (s: Session) => Math.round((s.bytes / BYTES_PER_SEC) * 1000);

function pickTrack(t: TrackInfo): TrackInfo {
  const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
  const out: TrackInfo = {};
  const title = str(t.title, 120);
  const artist = str(t.artist, 120);
  const album = str(t.album, 120);
  if (title) out.title = title;
  if (artist) out.artist = artist;
  if (album) out.album = album;
  if (Number.isFinite(t.durationMs) && (t.durationMs as number) > 0) out.durationMs = Math.round(t.durationMs as number);
  return out;
}

/** GStreamer: fetch, decode anything it knows (MP3, AAC/M4A, FLAC, Ogg, WAV), convert to the box's PCM. */
export function gstArgs(url: string): string[] {
  return ["-q", "souphttpsrc", `location=${url}`, "!", "decodebin", "!", "audioconvert", "!", "audioresample", "!", "audio/x-raw,format=S16LE,rate=44100,channels=2,layout=interleaved", "!", "fdsink", "fd=1"];
}

function gstProblem(err: string): string {
  if (/Not Found|404/.test(err)) return ": the app's audio file wasn't found.";
  if (/Forbidden|401|403/.test(err)) return ": the app refused the box's request for its audio.";
  if (/Could not connect|Connection refused|Cannot resolve/i.test(err)) return ": the app didn't answer.";
  if (/decoder|demux|type/i.test(err)) return ": the box can't decode that kind of file.";
  return ".";
}

function sinkProblem(kind: OutputTarget["kind"], err: string): string {
  if (kind === "tv") {
    const m = /"error":\s*"([^"]+)"/.exec(err);
    return m ? m[1] : "The TV stopped taking audio over AirPlay.";
  }
  if (kind === "bluetooth") return /not connected|No such device|Device or resource busy|unavailable/i.test(err) ? "The speaker disconnected." : "The speaker stopped playing.";
  return /busy/i.test(err) ? "The box's sound output is busy." : "The box's sound output stopped.";
}
