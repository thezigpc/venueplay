// The display driver contract. Every TV platform (Roku, Google TV/Cast, Apple TV,
// Samsung, …) implements DisplayDriver; the rest of the box only sees displays,
// groups and content.

/**
 * native-url: the TV opens the page itself (Cast receiver, kiosk browser). Exact sync, no encoding.
 * airplay:    the box renders + encodes and mirrors over AirPlay (doubletake).
 * roku-hls:   the box renders + encodes HLS; a sideloaded Roku app plays it.
 */
export type DeliveryMethod = "native-url" | "airplay" | "roku-hls" | "local" | "mock";

/** How the box renders and encodes for a TV (AirPlay). TVs with the same page and settings share one encoder. */
export interface StreamSettings {
  /** 2160p: for 4K receivers (Apple TV 4K). Experimental: not yet tested on real TVs. */
  resolution: "720p" | "1080p" | "2160p";
  fps: 15 | 24 | 30 | 60;
  /** Video bitrate in kbps; 0 or absent: doubletake picks one for the resolution and frame rate. */
  bitrateKbps?: number;
}

/** Pixels the box renders and encodes. */
export const RESOLUTIONS = { "720p": [1280, 720], "1080p": [1920, 1080], "2160p": [3840, 2160] } as const;

/**
 * Chromium's device scale factor per resolution. 2160p lays pages out at 1920x1080 CSS
 * pixels and draws them at 2x, so games and menus keep their 1080p layout but text and
 * images are drawn at full 4K sharpness.
 */
export const PIXEL_SCALE: Record<StreamSettings["resolution"], number> = { "720p": 1, "1080p": 1, "2160p": 2 };
export const FRAME_RATES = [15, 24, 30, 60] as const;

/** Checks a settings object from the API; returns a problem or undefined. */
export function checkStreamSettings(s: unknown): string | undefined {
  if (typeof s !== "object" || s === null) return "streamSettings: { resolution, fps, bitrateKbps? }";
  const v = s as Record<string, unknown>;
  if (!(typeof v.resolution === "string" && v.resolution in RESOLUTIONS)) return "resolution: 720p, 1080p or 2160p";
  if (!(FRAME_RATES as readonly unknown[]).includes(v.fps)) return "fps: 15, 24, 30 or 60";
  if (v.bitrateKbps !== undefined && !(Number.isInteger(v.bitrateKbps) && (v.bitrateKbps === 0 || ((v.bitrateKbps as number) >= 500 && (v.bitrateKbps as number) <= 40_000)))) {
    return "bitrateKbps: 0 (automatic) or 500-40000";
  }
  return undefined;
}

export interface DisplayDevice {
  /** Stable id: "<driver>:<serial/udn>". */
  id: string;
  driver: string;
  name: string;
  /** Base address the driver talks to, e.g. http://192.168.1.50:8060 */
  address: string;
  model?: string;
  isTv?: boolean;
  meta?: Record<string, unknown>;
  /** The venue's choice for this TV; absent: the box default (1080p, 30 fps, automatic bitrate). */
  streamSettings?: StreamSettings;
  /**
   * Box 0.21.0, plugged-in screens: people may touch it (a touchscreen). Off: the screen
   * takes no input at all, even with a touchscreen or keyboard plugged in.
   */
  touch?: boolean;
  /**
   * Plugged-in screens (scaffolding): the HDMI-CEC adapter that controls this screen's
   * power and input, e.g. "/dev/ttyACM0" (Pulse-Eight USB-CEC). Not used yet.
   */
  cecAdapter?: string;
}

export interface Capabilities {
  /** Supported deliveries, best first. */
  delivery: DeliveryMethod[];
  power: boolean;
  /** Inputs that setInput accepts, e.g. ["hdmi1","hdmi2","hdmi3","tuner"]. */
  inputs: string[];
  /** Remote-control keys keypress() accepts (Roku: Home, Up, Select, …). Empty: no remote. */
  remoteKeys?: string[];
  /** listApps/launchChannel work (the panel's Apps tab). */
  apps?: boolean;
  /** typeText works (the remote's typing box). */
  text?: boolean;
  /** tuneChannel works: antenna/cable channels like "7.1" (Roku TVs). */
  tvChannels?: boolean;
  /** TV control (power, input, remote) needs a one-time PIN pairing (Vizio, Apple TV). */
  control?: { paired: boolean };
  /** Box 0.21.0, plugged-in screens: touch can be switched on; `devices`: touchscreens the box sees. */
  touch?: { devices: string[] };
}

export type DisplayContent =
  | { kind: "url"; url: string; title?: string }
  /** The venue's idle screen. `url` is the page core rendered for it (data: or http). */
  | { kind: "idle"; url?: string; title?: string }
  | { kind: "off" }
  /** An app on the TV itself is showing (e.g. YouTube started by a media provider). Recorded, never cast. */
  | { kind: "external"; provider: string; app: string; title?: string };

export interface ShowResult {
  ok: boolean;
  delivery?: DeliveryMethod;
  message?: string;
  /** The TV shows a pairing code that staff must enter (AirPlay, once per TV). */
  needsCode?: boolean;
}

/** What a display's stream is doing right now. */
export interface StreamState {
  delivery: DeliveryMethod;
  url: string;
  /** e.g. connecting, streaming, pin_required, dropped, error */
  state: string;
  needsCode: boolean;
  detail?: string;
  /** "1080p · 30 fps" (· bitrate when set). */
  settings?: string;
}

export interface Health {
  online: boolean;
  powerMode?: string;
  detail?: string;
}

export interface DisplayDriver {
  readonly id: string;
  discover(timeoutMs?: number): Promise<DisplayDevice[]>;
  capabilities(device: DisplayDevice): Promise<Capabilities>;
  power(device: DisplayDevice, on: boolean): Promise<void>;
  setInput(device: DisplayDevice, input: string): Promise<void>;
  show(device: DisplayDevice, content: DisplayContent, delivery: DeliveryMethod): Promise<ShowResult>;
  stop(device: DisplayDevice): Promise<void>;
  health(device: DisplayDevice): Promise<Health>;
  /**
   * One-time pairing (AirPlay code, ADB key, …). Without a code it starts pairing (the
   * TV shows its code); with one it completes it.
   */
  pair?(device: DisplayDevice, code?: string): Promise<ShowResult>;
  /** TV-control pairing (Vizio): without a code the TV shows a PIN; with it, completes. */
  pairControl?(device: DisplayDevice, code?: string): Promise<ShowResult>;
  /** The TV is being forgotten: drop anything kept for it (pairing tokens). */
  forget?(device: DisplayDevice): Promise<void>;
  /** Live stream state for the admin UI. */
  streamState?(device: DisplayDevice): StreamState | undefined;
  /** Presses a remote-control key (one of capabilities.remoteKeys). */
  keypress?(device: DisplayDevice, key: string): Promise<void>;
  /** What's on screen now (Roku: ECP active-app); app is our name for it when we know it. */
  foregroundApp?(device: DisplayDevice): Promise<{ id: string; name: string; app?: string; home: boolean } | undefined>;
  /** The TV's installed apps and the one on screen (Roku channels). */
  listApps?(device: DisplayDevice): Promise<{ apps: { id: string; name: string }[]; active?: string }>;
  appIcon?(device: DisplayDevice, appId: string): Promise<{ type: string; data: Buffer } | undefined>;
  /** Starts an installed app by the id listApps gave. */
  launchChannel?(device: DisplayDevice, appId: string): Promise<void>;
  /** Tunes the TV's own tuner to a channel ("7", "7.1"). */
  tuneChannel?(device: DisplayDevice, channel: string): Promise<void>;
  /** Types text into the TV's current text field (search boxes, Wi-Fi passwords). */
  typeText?(device: DisplayDevice, text: string): Promise<void>;
  /** A small JPEG of what the box is rendering for this TV, if it's casting. */
  preview?(device: DisplayDevice): Promise<Buffer | undefined>;
  /** TV apps this driver can start (media providers), e.g. ["youtube"]. */
  launchableApps?(device: DisplayDevice): string[];
  /** Starts a TV app. Returns once the TV accepted the request. */
  launchApp?(device: DisplayDevice, app: string): Promise<{ ok: true } | { ok: false; reason: "unsupported" | "offline" | "ecp-blocked" | "error"; message: string }>;
  /** DIAL: an app's screen id (YouTube's Lounge screen id). GET only, never launches. */
  dialScreenId?(device: DisplayDevice, app: string): Promise<string | undefined>;
  /** Box 0.27.0: the TV can be handed a video URL to play itself (undefined: it can't). */
  videoInfo?(device: DisplayDevice): VideoInfo | undefined;
  /** Hands the TV a video URL; the TV streams it straight from its server. Never log the URL. */
  playVideo?(device: DisplayDevice, video: VideoRequest): Promise<VideoResult>;
  videoControl?(device: DisplayDevice, action: VideoAction): Promise<VideoResult>;
  videoStatus?(device: DisplayDevice): Promise<VideoStatus>;
}

/** Box 0.27.0: what kind of player a TV has, for apps choosing a stream (bg.tvs().video). */
export interface VideoInfo {
  /** Box 0.28.2: "local", a screen plugged into the box (mpv). */
  kind: "appletv" | "roku" | "venuebox" | "local";
  model: string;
  /** Box 0.28.0, Venuebox apps: what the player plays (direct play vs transcode). */
  formats?: VideoFormats;
}
export interface VideoFormats {
  containers: string[];
  video: string[];
  audio: string[];
  maxHeight?: number;
  seek: boolean;
  passthrough?: string[];
  /** Box 0.28.1: "sdr" "hdr10" "hdr10plus" "hlg" "dovi" the device shows correctly. */
  ranges?: string[];
  /** Box 0.29.0: it takes tracks (picks audio and subtitles inside the stream, loads subtitle files). */
  tracks?: boolean;
}

/** A video for the TV to play itself. `url` and `poster` may carry the media server's key: never log or store them. */
export interface VideoRequest {
  url: string;
  /** application/vnd.apple.mpegurl (HLS), video/mp4, video/quicktime, video/x-matroska. */
  mime?: string;
  title: string;
  poster?: string;
  /** Resume point in seconds. */
  startAt?: number;
  /** Box 0.29.0: the audio tracks and subtitles staff can pick, and the ones on now. */
  tracks?: VideoTracks;
}

/** Box 0.29.0: one audio track or subtitle. A subtitle `url` carries the media server's key too: never log it. */
export interface VideoTrack {
  id: string;
  label: string;
  language?: string;
  /** Where it is inside the stream being played: 0-based among tracks of its kind. Absent: not in this stream. */
  index?: number;
  /** Subtitles only: a side file the player loads. */
  url?: string;
  format?: string;
  forced?: boolean;
  default?: boolean;
}
export interface VideoTracks {
  audio?: VideoTrack[];
  subtitles?: VideoTrack[];
  audioId?: string;
  subtitleId?: string | null;
}

/** pause, resume, stop, seek to a position in seconds from the start, or (0.29.0) another audio track / subtitle (null: off). */
export type VideoAction = "pause" | "resume" | "stop" | { seek: number } | { audio: string } | { subtitle: string | null };
/** Box 0.29.0: asked from the TV's own remote, for the app to do (the player couldn't). */
export type VideoRemote = "next" | "previous" | { audio: string } | { subtitle: string | null };
export const isSeek = (a: VideoAction): a is { seek: number } => typeof a === "object" && "seek" in a;

/** Box 0.29.0: the remote keys that drive a playing video, and what each does now. */
export const VIDEO_KEYS = ["Play", "Rev", "Fwd", "Back"] as const;
export function videoKeyAction(key: string, st: VideoStatus): VideoAction | undefined {
  if (st.state !== "playing" && st.state !== "paused") return undefined;
  if (key === "Play") return st.state === "paused" ? "resume" : "pause";
  if (key === "Back") return "stop";
  if (key === "Rev") return { seek: Math.max(0, (st.position ?? 0) - 30) };
  if (key === "Fwd") return { seek: (st.position ?? 0) + 30 };
  return undefined;
}

export interface VideoResult {
  ok: boolean;
  /** offline | unsupported | needs-pairing | not-allowed | error */
  reason?: string;
  message?: string;
}

export interface VideoStatus {
  state: "playing" | "paused" | "stopped" | "error";
  /** Seconds. */
  position?: number;
  duration?: number;
  message?: string;
  /** Box 0.29.0: the audio track and subtitle on now (ids from the request's tracks; null: subtitles off). */
  audio?: string;
  subtitle?: string | null;
  /** Box 0.29.0: asked from the TV's remote since the last status, for the app to do. Handed over once. */
  remote?: VideoRemote[];
}

const TRACK_ID = /^[\w.:-]{1,64}$/;
function checkTrackList(v: unknown, subtitles: boolean): VideoTrack[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 32) return "tracks: up to 32 audio tracks and 32 subtitles";
  const out: VideoTrack[] = [];
  for (const raw of v as Record<string, unknown>[]) {
    if (!raw || typeof raw.id !== "string" || !TRACK_ID.test(raw.id)) return "tracks: each needs an id (letters, digits, . : - _)";
    if (typeof raw.label !== "string" || !raw.label.trim()) return "tracks: each needs a label";
    const t: VideoTrack = { id: raw.id, label: raw.label.trim().slice(0, 80) };
    if (typeof raw.language === "string" && raw.language) t.language = raw.language.slice(0, 16);
    if (typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0 && raw.index < 64) t.index = raw.index;
    if (subtitles && raw.url !== undefined) {
      if (typeof raw.url !== "string" || raw.url.length > 4096 || !/^https?:\/\/[^\s]+$/i.test(raw.url)) return "tracks: a subtitle url must be an http or https link";
      t.url = raw.url;
      if (typeof raw.format === "string" && /^[a-z0-9]{1,8}$/.test(raw.format)) t.format = raw.format;
    }
    if (raw.forced === true) t.forced = true;
    if (raw.default === true) t.default = true;
    out.push(t);
  }
  return new Set(out.map((t) => t.id)).size === out.length ? out : "tracks: ids must be different";
}
function checkTracks(v: unknown): VideoTracks | undefined | string {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") return "tracks: { audio, subtitles, audioId, subtitleId }";
  const o = v as Record<string, unknown>;
  const audio = checkTrackList(o.audio, false);
  if (typeof audio === "string") return audio;
  const subtitles = checkTrackList(o.subtitles, true);
  if (typeof subtitles === "string") return subtitles;
  const t: VideoTracks = { audio, subtitles };
  if (typeof o.audioId === "string" && audio.some((a) => a.id === o.audioId)) t.audioId = o.audioId;
  if (o.subtitleId === null) t.subtitleId = null;
  else if (typeof o.subtitleId === "string" && subtitles.some((a) => a.id === o.subtitleId)) t.subtitleId = o.subtitleId;
  return audio.length || subtitles.length ? t : undefined;
}

/** A control request's action ({ action } | { seek } | { audio } | { subtitle }), or undefined if it's none of them. */
export function checkVideoAction(b: unknown): VideoAction | undefined {
  const o = (b ?? {}) as Record<string, unknown>;
  if (typeof o.seek === "number" && Number.isFinite(o.seek) && o.seek >= 0) return { seek: Math.floor(o.seek) };
  if (typeof o.audio === "string" && TRACK_ID.test(o.audio)) return { audio: o.audio };
  if (o.subtitle === null || (typeof o.subtitle === "string" && TRACK_ID.test(o.subtitle))) return { subtitle: o.subtitle };
  return o.action === "pause" || o.action === "resume" || o.action === "stop" ? o.action : undefined;
}

/** Checks a video request from core: the request, or what's wrong with it. */
export function checkVideo(b: unknown): { video: VideoRequest; provider: string } | string {
  if (typeof b !== "object" || b === null) return "url, title and provider required";
  const v = b as Record<string, unknown>;
  const httpUrl = (x: unknown) => typeof x === "string" && x.length <= 4096 && /^https?:\/\/[^\s]+$/i.test(x);
  if (!httpUrl(v.url)) return "url: an http or https link (up to 4096 characters)";
  if (typeof v.title !== "string" || !v.title.trim()) return "title required";
  if (typeof v.provider !== "string" || !v.provider) return "provider required";
  if (v.poster !== undefined && v.poster !== null && v.poster !== "" && !httpUrl(v.poster)) return "poster: an http or https link";
  if (v.mime !== undefined && (typeof v.mime !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(v.mime))) return "mime: like video/mp4";
  if (v.startAt !== undefined && !(typeof v.startAt === "number" && Number.isFinite(v.startAt) && v.startAt >= 0)) return "startAt: seconds";
  const tracks = checkTracks(v.tracks);
  if (typeof tracks === "string") return tracks;
  return {
    provider: v.provider,
    video: {
      url: v.url as string,
      title: v.title.trim().slice(0, 120),
      ...(typeof v.mime === "string" ? { mime: v.mime } : {}),
      ...(typeof v.poster === "string" && v.poster ? { poster: v.poster } : {}),
      ...(typeof v.startAt === "number" && v.startAt > 0 ? { startAt: Math.floor(v.startAt) } : {}),
      ...(tracks ? { tracks } : {}),
    },
  };
}

/** Strips anything that could carry a key from a message before it's logged or returned (ECP paths, URLs). */
export function redactUrls(s: string): string {
  return s.replace(/(?:https?|rtsp):\/\/[^\s"'<>]+/gi, "<url>").replace(/\/input\/15985\?[^\s"'<>]*/g, "/input/15985?…");
}

/**
 * Turns a URL into a stream a TV can receive (renderer + encoder + sender).
 * Implemented in Phase 3 (Chromium per group → QuickSync → doubletake / HLS).
 */
export interface StreamService {
  startAirplay(device: DisplayDevice, content: { url: string }): Promise<ShowResult>;
  /** Completes AirPlay pairing with the code the TV shows. */
  pair?(device: DisplayDevice, code: string): Promise<ShowResult>;
  state?(deviceId: string): StreamState | undefined;
  hlsUrl(content: { url: string }): Promise<string>;
  stopFor(deviceId: string): Promise<void>;
  /** A small JPEG of the page this TV's channel renders; undefined when it isn't casting. */
  preview?(deviceId: string): Promise<Buffer | undefined>;
}

export class NotBuiltYet extends Error {}
