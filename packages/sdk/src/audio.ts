// @bargames/sdk/audio: play your app's audio on the box's sound outputs (SDK 0.13.0).
// Node-only (server side). createBarGames() exposes the same thing as bg.audio.
//
//   import { createAudio } from "@bargames/sdk/audio";
//   const audio = createAudio();                       // reads BG_CORE_URL and BG_GAME_TOKEN
//   const outs = await audio.outputs();               // the venue's outputs, default marked
//   const s = await audio.play({ path: "/tracks/12.mp3", title: "Song", artist: "Band" });
//   const stop = audio.watch((sessions) => { if (sessions.find((x) => x.id === s.id)?.state === "ended") playNext(); });
//
// Needs "audio": { "play": true } in bargames.json. Off a box (no BG_CORE_URL) onBox is
// false and every call rejects with AudioUnavailable: play through your own fallback (a
// browser "speaker page", say). `bargames mock-box` pretends to play.

import { AUDIO_PATHS, ENV, type AudioOutput, type AudioPlayOptions, type AudioSession } from "./protocol.js";

export interface AudioClientOptions {
  /** Default: process.env.BG_CORE_URL. */
  coreUrl?: string;
  /** Default: process.env.BG_GAME_TOKEN. */
  token?: string;
  fetch?: typeof fetch;
}

/** Not on a box: no outputs to play on. */
export class AudioUnavailable extends Error {}
/** The box said no (status 403: the manifest lacks audio.play; 409: output busy or can't play). */
export class AudioError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const env = (k: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[k];

export function createAudio(opts: AudioClientOptions = {}) {
  const coreUrl = (opts.coreUrl ?? env(ENV.coreUrl) ?? "").replace(/\/$/, "");
  const token = opts.token ?? env(ENV.token) ?? "";
  const doFetch = opts.fetch ?? fetch;
  const onBox = Boolean(coreUrl && token);

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (!onBox) throw new AudioUnavailable("not running on a Bar Games box (no BG_CORE_URL / BG_GAME_TOKEN)");
    const res = await doFetch(coreUrl + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new AudioError(res.status, data.error ?? `HTTP ${res.status}`);
    return data;
  };

  const sessions = () => call<AudioSession[]>("GET", AUDIO_PATHS.sessions);

  return {
    /** True on a box. */
    onBox,
    /** The box's outputs. The venue names them and picks the default. */
    outputs: () => call<AudioOutput[]>("GET", AUDIO_PATHS.outputs),
    /** Starts playing; resolves once the box has started (state "starting"), not when it ends. */
    play: (o: AudioPlayOptions) => call<AudioSession>("POST", AUDIO_PATHS.play, o),
    /** Your sessions: playing ones, and ended ones for about a minute. */
    sessions,
    pause: (id: string) => call<AudioSession>("POST", AUDIO_PATHS.control(id, "pause")),
    resume: (id: string) => call<AudioSession>("POST", AUDIO_PATHS.control(id, "resume")),
    stop: (id: string) => call<AudioSession>("POST", AUDIO_PATHS.control(id, "stop")),
    /** 0-100. Only while you play on that output; otherwise it's the venue's setting. */
    setVolume: (outputId: string, volume: number) => call<AudioOutput>("PUT", AUDIO_PATHS.volume(outputId), { volume }),
    /**
     * Polls your sessions (every `everyMs`, default 1000) and calls `onChange` when any
     * session's state or message changes (positions alone don't count). Use it to start
     * the next song when one ends. Returns a function that stops watching. No-op off a box.
     */
    watch(onChange: (sessions: AudioSession[]) => void, everyMs = 1000, onError?: (err: Error) => void): () => void {
      if (!onBox) return () => undefined;
      let last = "";
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          const list = await sessions();
          const key = list.map((s) => `${s.id}:${s.state}:${s.message ?? ""}`).join("|");
          if (key !== last) {
            last = key;
            onChange(list);
          }
        } catch (err) {
          onError?.(err as Error);
        }
        if (!stopped) timer = setTimeout(tick, everyMs);
      };
      let timer = setTimeout(tick, 0);
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  };
}

export type Audio = ReturnType<typeof createAudio>;
