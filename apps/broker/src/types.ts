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
  resolution: "720p" | "1080p";
  fps: 15 | 24 | 30 | 60;
  /** Video bitrate in kbps; 0 or absent: doubletake picks one for the resolution and frame rate. */
  bitrateKbps?: number;
}

export const RESOLUTIONS = { "720p": [1280, 720], "1080p": [1920, 1080] } as const;
export const FRAME_RATES = [15, 24, 30, 60] as const;

/** Checks a settings object from the API; returns a problem or undefined. */
export function checkStreamSettings(s: unknown): string | undefined {
  if (typeof s !== "object" || s === null) return "streamSettings: { resolution, fps, bitrateKbps? }";
  const v = s as Record<string, unknown>;
  if (!(typeof v.resolution === "string" && v.resolution in RESOLUTIONS)) return "resolution: 720p or 1080p";
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
  /** TV control (power, input, remote) needs a one-time PIN pairing (Vizio, Apple TV). */
  control?: { paired: boolean };
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
