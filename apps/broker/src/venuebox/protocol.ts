// Venuebox client protocol v1 (docs/NATIVE-CLIENTS.md): apps on TVs and PCs that pair with
// the box and show what it sends. Served by the broker on CLIENT_PORT (default 7210),
// for the venue LAN (never through the Cloudflare tunnel; Tailscale is for management and
// remote support, not a client path).
//
// HTTP (pairing):
//   POST /pair/start   { name, platform, model?, appVersion?, screens: Screen[] }
//                      → { pairingId, code, expiresAt, pollMs }
//   GET  /pair/status?id=<pairingId>
//                      → { status: "pending" } | { status: "approved", deviceId, token, wsPath }
//                        (the token is handed out once) | 404 { status: "expired" }
//   GET  /health       → { ok, box, protocol }
// WebSocket /client: JSON messages; the client's first message is "hello".

export const CLIENT_PROTOCOL = 1;

export interface Screen {
  /** Stable per device (e.g. the OS display id); 1-64 chars. */
  id: string;
  /** "Left HDMI", "DELL U2720Q". */
  name: string;
  w: number;
  h: number;
  hz?: number;
}

export type Delivery = "native-url" | "hls";

/**
 * Box 0.28.0: a client that can play a video link itself (full screen, over the page it was
 * showing) says what it plays. Lower-case names, as Jellyfin uses them: containers
 * "mp4" "mkv" "mov" "webm" "ts" "hls"; video "h264" "hevc" "av1" "vp9"; audio "aac" "mp3"
 * "ac3" "eac3" "dts" "truehd" "opus" "flac". Apps pick direct play or a transcode from it.
 */
export interface VideoCaps {
  containers: string[];
  video: string[];
  audio: string[];
  /** Tallest picture it plays (2160 for 4K). */
  maxHeight?: number;
  /** It can jump to a position (and start part-way). */
  seek: boolean;
  /** Surround audio passed through to the TV/receiver. */
  passthrough?: string[];
}

// ---------------------------------------------------------------- client → box

export interface HelloMsg {
  type: "hello";
  v: number;
  token: string;
  platform: string;
  model?: string;
  appVersion?: string;
  screens: Screen[];
  deliveries: Delivery[];
  /** Box 0.28.0: present when the client plays video links itself. */
  video?: VideoCaps;
}
/** A screen was plugged in or unplugged (desktop): the full current list. */
export interface ScreensMsg {
  type: "screens";
  screens: Screen[];
}
export interface StateMsg {
  type: "state";
  screen: string;
  /** What it's showing (the URL), or "" when off. */
  showing: string;
  status: "playing" | "loading" | "error" | "off";
  detail?: string;
}
export interface PreviewMsg {
  type: "preview";
  requestId: string;
  screen: string;
  /** Base64 JPEG, at most ~200 KB. */
  jpeg?: string;
  error?: string;
}
/** Box 0.28.0: the answer to a "video" message, same requestId. Never put the link in `message`. */
export interface VideoReplyMsg {
  type: "video-reply";
  requestId: string;
  ok: boolean;
  /** unsupported | not-allowed | error */
  reason?: string;
  message?: string;
  /** With op "status" (and allowed with any op): the player's state now. */
  state?: VideoState;
  position?: number;
  duration?: number;
}
export type VideoState = "loading" | "playing" | "paused" | "stopped" | "error";
/** Box 0.28.0: the player changed by itself (started, ended, failed, staff used the TV's remote). Send at most every few seconds while playing. */
export interface VideoStateMsg {
  type: "video-state";
  screen: string;
  state: VideoState;
  position?: number;
  duration?: number;
  message?: string;
}
export type ClientMsg = HelloMsg | ScreensMsg | StateMsg | PreviewMsg | VideoReplyMsg | VideoStateMsg;

// ---------------------------------------------------------------- box → client

export interface WelcomeMsg {
  type: "welcome";
  v: number;
  deviceId: string;
  /** The name staff gave the device. */
  name: string;
  /** Each screen and the name the box shows for it. */
  screens: { id: string; label: string }[];
}
export interface ShowMsg {
  type: "show";
  screen: string;
  url: string;
  kind: Delivery;
  title?: string;
}
/**
 * Box 0.28.0: play a video link full screen over the page (play), or control it. The client
 * answers with a video-reply (same requestId) as soon as it has accepted the op: for play,
 * once the player is loading, not when the picture starts. When the video ends or is
 * stopped, the page it was showing comes back. `url` and `poster` carry the media server's
 * key: never log them, store them or report them in "state".showing.
 */
export type VideoMsg =
  | { type: "video"; screen: string; requestId: string; op: "play"; url: string; title: string; mime?: string; poster?: string; startAt?: number }
  | { type: "video"; screen: string; requestId: string; op: "pause" | "resume" | "stop" | "status" }
  | { type: "video"; screen: string; requestId: string; op: "seek"; position: number };
export type BoxMsg =
  | WelcomeMsg
  | ShowMsg
  | VideoMsg
  | { type: "off"; screen: string }
  | { type: "reload"; screen: string }
  | { type: "identify"; screen: string; label: string }
  | { type: "preview"; screen: string; requestId: string }
  | { type: "error"; code: "bad-hello" | "bad-token" | "revoked" | "version"; message: string };

/** WebSocket close codes the box uses. */
export const CLOSE = { badToken: 4401, revoked: 4403, protocol: 4400, replaced: 4409 } as const;

const NAMES = /^[a-z0-9][a-z0-9.+-]{0,23}$/;
const names = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()).filter((x) => NAMES.test(x)))].slice(0, 24) : []);
/** A hello's video abilities, cleaned up; undefined when it can't play anything. */
export function checkVideoCaps(v: unknown): VideoCaps | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const caps: VideoCaps = { containers: names(o.containers), video: names(o.video), audio: names(o.audio), seek: o.seek === true };
  if (!caps.containers.length || !caps.video.length) return undefined;
  const h = Number(o.maxHeight);
  if (Number.isInteger(h) && h >= 144 && h <= 4320) caps.maxHeight = h;
  const pass = names(o.passthrough);
  if (pass.length) caps.passthrough = pass;
  return caps;
}

export function checkScreens(v: unknown): Screen[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > 16) return undefined;
  const out: Screen[] = [];
  for (const s of v as Record<string, unknown>[]) {
    if (!s || typeof s.id !== "string" || !/^[\w.:-]{1,64}$/.test(s.id)) return undefined;
    const w = Number(s.w);
    const h = Number(s.h);
    if (!(w > 0 && w <= 16384 && h > 0 && h <= 16384)) return undefined;
    const hz = s.hz === undefined ? undefined : Number(s.hz);
    out.push({ id: s.id, name: typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 60) : s.id, w, h, ...(hz && hz > 0 && hz <= 500 ? { hz } : {}) });
  }
  return new Set(out.map((s) => s.id)).size === out.length ? out : undefined;
}
