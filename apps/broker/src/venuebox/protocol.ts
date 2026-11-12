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
export type ClientMsg = HelloMsg | ScreensMsg | StateMsg | PreviewMsg;

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
export type BoxMsg =
  | WelcomeMsg
  | ShowMsg
  | { type: "off"; screen: string }
  | { type: "reload"; screen: string }
  | { type: "identify"; screen: string; label: string }
  | { type: "preview"; screen: string; requestId: string }
  | { type: "error"; code: "bad-hello" | "bad-token" | "revoked" | "version"; message: string };

/** WebSocket close codes the box uses. */
export const CLOSE = { badToken: 4401, revoked: 4403, protocol: 4400, replaced: 4409 } as const;

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
