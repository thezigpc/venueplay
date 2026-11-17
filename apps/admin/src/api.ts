import { bgUrl } from "@bargames/sdk";
import type { BarGamesEvent, GameBranding, IntegrationReport, GameManifest, VenueContext, VenueLocation, VenueTheme, WifiInfo } from "@bargames/sdk";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Box 0.19.3: the admin session for a browser that won't keep the sign-in cookie (an iPad:
 * right password, then signed out again). Only used then; normally the httpOnly cookie does it.
 */
const SESSION_KEY = "bg_admin_session";
const store = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};
let fallbackSession: string | undefined = (() => {
  try {
    return store()?.getItem(SESSION_KEY) ?? undefined;
  } catch {
    return undefined;
  }
})();
export function setFallbackSession(session: string | undefined): void {
  fallbackSession = session || undefined;
  try {
    if (fallbackSession) store()?.setItem(SESSION_KEY, fallbackSession);
    else store()?.removeItem(SESSION_KEY);
  } catch {
    /* private mode: kept for this page only */
  }
}
export const usingFallbackSession = () => Boolean(fallbackSession);
/** An /api URL for an <img> (it can't send the header). */
function imgUrl(path: string): string {
  const u = bgUrl(`/api${path}`);
  return fallbackSession ? `${u}${u.includes("?") ? "&" : "?"}bg_session=${encodeURIComponent(fallbackSession)}` : u;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (fallbackSession) headers["x-bargames-admin-session"] = fallbackSession;
  const res = await fetch(bgUrl(`/api${path}`), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Venue {
  name: string;
  theme: VenueTheme;
  wifi?: WifiInfo;
  domain: string;
  hostnamePattern: string;
  playLabel: string;
  adminLabel: string;
  /** The admin on its own hostname instead of /admin on the games list's (security recommendation). */
  adminOwnHost?: boolean;
  slug: string;
  publicScheme: "https" | "http";
  publicPort?: number | null;
  location?: VenueLocation | null;
  timezone?: string | null;
  units?: "imperial" | "metric" | null;
  idleModule?: string | null;
  /** The name at the top of this admin. Empty: "Bar Games". */
  adminTitle?: string | null;
}
export interface VenueView {
  venue: Venue;
  hosts: { play: string; admin: string };
  warnings: string[];
}
export interface Access {
  pinEnabled: boolean;
  pin: string;
  whitelist: { cidr: string; label?: string; expiresAt?: string }[];
  autoVenueIp: boolean;
  venueCidrs: string[];
  adminRemote: boolean;
  /** Anyone on the internet may play (the admin stays behind adminRemote). */
  open?: boolean;
}
/** The box's own Wi-Fi (Settings > Box Wi-Fi), as the host helper last saw it. */
export interface WifiAdapter {
  name: string;
  state: string;
  ssid?: string;
  signal?: number;
  band?: string;
  addresses: string[];
}
export interface WifiSeen {
  ssid: string;
  signal: number;
  band: string;
  secure: boolean;
  enterprise: boolean;
}
export interface WifiView {
  available: boolean;
  pending: boolean;
  networks: { ssid: string; hidden: boolean; secured: boolean; addedAt: string }[];
  status?: {
    at?: string;
    adapters?: WifiAdapter[];
    cables?: { name: string; plugged: boolean; addresses: string[] }[];
    internetVia?: string | null;
    apply?: { ok: boolean; at: string; error?: string; changed?: boolean };
    scan?: { at?: string; error?: string; networks?: WifiSeen[] };
  };
}
export interface Game {
  id: string;
  manifest: GameManifest;
  source: { kind: string; ref: string };
  verified: boolean;
  enabled: boolean;
  branding: GameBranding;
  hostnameAlias?: string;
  /** Path routing: keep this game on its own hostname. */
  ownHostname?: boolean;
  host: string;
  context: VenueContext;
  state: string;
}
export interface UpdateInfo {
  gameId: string;
  checkedAt: string;
  installed: string;
  latest?: string;
  available: boolean;
  note?: string;
  error?: string;
}
export interface Updates {
  lastRun?: string;
  games: UpdateInfo[];
}
export interface VenueboxDevice {
  id: string;
  name: string;
  platform: string;
  model?: string;
  appVersion?: string;
  screens: { id: string; name: string; w: number; h: number; hz?: number }[];
  pairedAt: string;
  lastSeen?: string;
  online: boolean;
}
export interface MediaItem {
  id: string;
  name: string;
  kind: "list" | "plan";
  thumbnailUrl?: string;
  count?: number;
}
export interface MediaProvider {
  gameId: string;
  displayName: string;
  targets: { displayId: string; label: string; state: string; nowPlaying?: { title: string; listName?: string }; itemId?: string }[];
}
/** Box 0.20.0: after a game step, the device that applied the scene opens its host controls ("ask": offers a button). */
export type HostMode = "open" | "ask";
/**
 * Box 0.26.0: what a scene does, top to bottom. A TV step acts on all its TVs at once; a game
 * step on several TVs is one room on all of them. Waits and extras are steps too.
 */
export type SceneStep =
  | { do: "wait"; seconds: number }
  | { do: "power"; tvs: string[]; on: boolean }
  | { do: "input"; tvs: string[]; input: string }
  | { do: "app"; tvs: string[]; appId: string; appName?: string }
  | { do: "channel"; tvs: string[]; channel: string }
  | { do: "game"; tvs: string[]; gameId: string; host?: HostMode }
  | { do: "media"; tvs: string[]; gameId: string; itemId: string }
  | { do: "idle"; tvs: string[] }
  | { do: "off"; tvs: string[] }
  | { do: "endRooms" }
  | { do: "announce"; text: string; minutes?: number }
  | { do: "clearAnnouncement" }
  | { do: "countdown"; label: string; minutes: number }
  | { do: "clearCountdown" }
  | { do: "stopSound" };
export interface Scene {
  id: string;
  name: string;
  steps: SceneStep[];
  /** Box 0.16.0: a sequence: apply another scene this many minutes later. */
  next?: { sceneId: string; afterMinutes: number };
}
/** Box 0.20.0: a scene being applied (waits run in the background). */
export interface SceneRun {
  id: string;
  sceneId: string;
  name: string;
  total: number;
  done: number;
  current?: string;
  finished: boolean;
  cancelled?: boolean;
  steps: { step: string; ok: boolean; message?: string }[];
  host?: { gameId: string; name: string; code?: string; url: string; mode: HostMode };
}
/** Box 0.16.0: closing time, Sunday night first; "" = not that night. */
export interface Closing {
  enabled: boolean;
  sceneId?: string;
  nights: string[];
}
export interface AnnouncementPreset {
  id: string;
  text: string;
  minutes?: number;
  show?: "everywhere" | "phones" | "tvs";
  position?: "top" | "bottom";
}
export interface StatusItem {
  level: "error" | "warn" | "info";
  text: string;
  page: "tvs" | "games" | "system" | "smart-home" | "tonight" | "scenes";
}
export interface Schedule {
  id: string;
  kind: "game" | "scene";
  gameId?: string;
  sceneId?: string;
  days: number[];
  time: string;
  displayIds?: string[];
  group?: string;
  title?: string;
  countdownMinutes?: number;
  enabled: boolean;
}
export interface LeaderRow {
  name: string;
  wins: number;
  games: number;
  best?: number;
}
export interface SystemStats {
  at: string;
  host: {
    hostname: string;
    cpuModel: string;
    cores: number;
    cpuPercent?: number;
    load: [number, number, number];
    memory: { totalBytes: number; availableBytes: number; usedPercent: number };
    disk?: { path: string; totalBytes: number; freeBytes: number; usedPercent: number };
    uptimeSec: number;
    temps: { label: string; celsius: number }[];
    gpu?: { curMhz: number; maxMhz: number };
  };
  containers?: { name: string; state: string; status: string; cpuPercent?: number; memBytes?: number; memLimitBytes?: number }[];
  network?: { name: string; rxBytes: number; txBytes: number }[];
  casting?: { tvs: number; streaming: number; pages: number };
  box: { version: string; latest?: string; coreUptimeSec: number; games: number; openRooms: number };
  update?: { available: boolean; running: boolean; lastExit?: number; logTail?: string[] };
  reboot: { available: boolean; pending: boolean };
  shutdown?: { available: boolean };
}
export interface Display {
  id: string;
  driver: string;
  name: string;
  /** Box 0.20.0: what the TV says it shows (its own app or input), Roku and Apple TV. */
  onScreen?: { id: string; name: string; home: boolean };
  label?: string;
  group?: string;
  model?: string;
  isTv?: boolean;
  delivery?: string;
  capabilities?: { delivery: string[]; power: boolean; inputs: string[]; remoteKeys?: string[]; apps?: boolean; text?: boolean; tvChannels?: boolean; control?: { paired: boolean }; touch?: { devices: string[] } };
  /** Box 0.21.0: a plugged-in screen people may touch. */
  touch?: boolean;
  streamSettings?: StreamSettings;
  health?: { online: boolean; powerMode?: string; detail?: string };
  content?: { kind: string; url?: string; title?: string; app?: string; provider?: string };
  stream?: { delivery: string; url: string; state: string; needsCode: boolean; detail?: string; settings?: string };
  /** Box 0.15.2: set aside (at the other site…): not contacted, not used. */
  ignored?: boolean;
}

export interface StreamSettings {
  resolution: "720p" | "1080p" | "2160p";
  fps: 15 | 24 | 30 | 60;
  bitrateKbps?: number;
}
export type StartupRule = { mode: "last" | "idle" | "off" } | { mode: "game"; gameId: string } | { mode: "media"; gameId: string; itemId: string };
export interface ShowResult {
  ok: boolean;
  message?: string;
  needsCode?: boolean;
  paired?: boolean;
}
export interface CastSettings {
  fromGames: boolean;
  pin: string;
}
export interface RoomSummary {
  code: string;
  kind: string;
  players: number;
  phase?: string;
  title?: string;
  hostConnected?: boolean;
  pendingClaims?: { id: string; player?: string; detail?: string; at?: string }[];
  createdAt?: string;
  lastActivityAt?: string;
  tables?: number;
  maxPlayers?: number;
  hostName?: string;
}

/** Box 0.19.0: a guest host or co-host link. */
export interface GuestLinkRow {
  id: string;
  gameId: string;
  label: string;
  role: "host" | "cohost";
  parentId?: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  active: boolean;
}

export interface GuestsOverview {
  apps: { gameId: string; name: string; enabled: boolean; cohostsSupported: boolean; cohosts: boolean }[];
  links: GuestLinkRow[];
  /** Tonight's closing time, when one is set: links last until then by default. */
  closingAt?: string;
  defaultHours: number;
}

export interface RoomsOverview {
  at: string;
  games: { id: string; name: string; publicUrl?: string; commands: string[]; error?: string; rooms: (RoomSummary & { tvs: { id: string; name: string }[]; /** Box 0.15.5: rooms the box created. */ hostUrl?: string })[] }[];
}

export interface CfZone {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
}
export interface CfHost {
  host: string;
  status: "ok" | "create" | "conflict";
  detail?: string;
}
export interface CfStatus {
  hasToken: boolean;
  tokenHint?: string;
  connected: boolean;
  account?: string;
  zone?: string;
  tunnel?: { id: string; name: string; status: string; connections: number };
  connector: string;
  lastSync?: { at: string; ok: boolean; hosts: CfHost[]; removed: string[]; errors: string[] };
}

export interface Announcement {
  id: string;
  text: string;
  until?: string;
  show?: "everywhere" | "phones" | "tvs";
  position?: "top" | "bottom";
}

export const api = {
  authStatus: () => call<{ setup: boolean; loggedIn: boolean; canSetup: boolean; title?: string }>("GET", "/auth/status"),
  setup: (password: string) => call("POST", "/auth/setup", { password }),
  login: (password: string, remember = false) => call<{ ok: boolean; session?: string }>("POST", "/auth/login", { password, remember }),
  logout: () => call("POST", "/auth/logout").finally(() => setFallbackSession(undefined)),
  changePassword: (current: string, next: string) =>
    call<{ ok: boolean; session?: string }>("POST", "/auth/password", { current, next }).then((r) => {
      if (usingFallbackSession() && r.session) setFallbackSession(r.session);
      return r;
    }),
  logoutEverywhere: () =>
    call<{ ok: boolean; session?: string }>("POST", "/auth/logout-everywhere", {}).then((r) => {
      if (usingFallbackSession() && r.session) setFallbackSession(r.session);
      return r;
    }),
  system: () => call<{ version: string; runtime: string; broker: boolean }>("GET", "/system"),
  venue: () => call<VenueView>("GET", "/venue"),
  saveVenue: (v: Partial<Venue>) => call<VenueView>("PUT", "/venue", v),
  access: () => call<Access>("GET", "/access"),
  saveAccess: (a: Partial<Access>) => call<Access>("PUT", "/access", a),
  wifi: () => call<WifiView>("GET", "/wifi"),
  saveWifi: (n: { ssid: string; password?: string; hidden?: boolean }) => call<WifiView>("POST", "/wifi/networks", n),
  forgetWifi: (ssid: string) => call<WifiView>("DELETE", `/wifi/networks/${encodeURIComponent(ssid)}`),
  scanWifi: () => call<WifiView>("POST", "/wifi/scan"),
  games: () => call<Game[]>("GET", "/games"),
  venuebox: () => call<{ devices: VenueboxDevice[]; pending: { code: string; name: string; platform: string; screens: number; expiresAt: string }[] }>("GET", "/broker/venuebox"),
  pairVenuebox: (code: string, name?: string) => call<VenueboxDevice>("POST", "/broker/venuebox/pair", { code, name: name || undefined }),
  renameVenuebox: (id: string, name: string) => call<VenueboxDevice>("PATCH", `/broker/venuebox/devices/${encodeURIComponent(id)}`, { name }),
  revokeVenuebox: (id: string) => call("DELETE", `/broker/venuebox/devices/${encodeURIComponent(id)}`),
  identify: (displayId: string) => call("POST", `/broker/displays/${encodeURIComponent(displayId)}/identify`),
  /** Stub: Tailscale from the venue's side (planned). */
  tailscale: () => call<{ built: boolean }>("GET", "/tailscale"),
  attention: () =>
    call<{ items: { source: string; sourceName: string; level: "info" | "warn" | "error"; message: string; actionPath?: string; hostUrl?: string; hostKey?: string; hostName?: string }[] }>("GET", "/attention"),
  countdown: () => call<{ id: string; label: string; endsAt: string; gameId?: string; joinUrl?: string } | null>("GET", "/countdown"),
  startCountdown: (label: string, minutes: number, gameId?: string) => call("PUT", "/countdown", { label, minutes, gameId }),
  clearCountdown: () => call("DELETE", "/countdown"),
  leaderboards: () =>
    call<{ tonightSince: string; games: { gameId: string; displayName: string; tonight: LeaderRow[]; allTime: LeaderRow[] }[] }>("GET", "/leaderboards"),
  resetLeaderboards: () => call("DELETE", "/leaderboards"),
  media: () => call<{ providers: MediaProvider[] }>("GET", "/media"),
  mediaItems: (gameId: string) => call<{ items: MediaItem[] }>("GET", `/media/${encodeURIComponent(gameId)}/items`),
  mediaPlay: (gameId: string, itemId: string, displayId?: string) =>
    call<{ ok: boolean; message?: string; pending?: boolean }>("POST", `/media/${encodeURIComponent(gameId)}/play`, { itemId, displayId }),
  mediaStop: (gameId: string, displayId: string) => call<{ ok: boolean; message?: string }>("POST", `/media/${encodeURIComponent(gameId)}/stop`, { displayId }),
  scenes: () => call<{ scenes: Scene[]; presets: Scene[] }>("GET", "/scenes"),
  saveScene: (s: Scene) => call<Scene>("PUT", `/scenes/${encodeURIComponent(s.id)}`, s),
  deleteScene: (id: string) => call("DELETE", `/scenes/${encodeURIComponent(id)}`),
  applyScene: (id: string) => call<SceneRun>("POST", `/scenes/${encodeURIComponent(id)}/apply`),
  sceneRun: (id: string) => call<SceneRun>("GET", `/scenes/runs/${encodeURIComponent(id)}`),
  cancelSceneRun: (id: string) => call("POST", `/scenes/runs/${encodeURIComponent(id)}/cancel`),
  dismissHost: (key: string) => call("DELETE", `/scenes/hosts/${encodeURIComponent(key)}`),
  schedules: () => call<{ schedules: Schedule[]; sequences?: { from: string; sceneId: string; at: string }[] }>("GET", "/schedules"),
  // Box 0.16.0
  closing: () => call<Closing>("GET", "/closing"),
  saveClosing: (c: Closing) => call<Closing>("PUT", "/closing", c),
  announcementPresets: () => call<{ presets: AnnouncementPreset[] }>("GET", "/announcement-presets"),
  saveAnnouncementPresets: (presets: AnnouncementPreset[]) => call<{ presets: AnnouncementPreset[] }>("PUT", "/announcement-presets", { presets }),
  status: () => call<{ at: string; items: StatusItem[] }>("GET", "/status"),
  /** A settings backup file, and what was left out of it. */
  backup: async (passphrase?: string) => {
    const res = await fetch(bgUrl("/api/backup"), { method: "POST", credentials: "same-origin", headers: passphrase ? { "x-backup-passphrase": encodeURIComponent(passphrase) } : undefined });
    if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "bargames-settings.bgbackup";
    const skipped = JSON.parse(decodeURIComponent(res.headers.get("x-backup-skipped") ?? "%5B%5D")) as string[];
    return { blob: await res.blob(), name, skipped };
  },
  restoreBackup: async (file: Blob, passphrase?: string) => {
    const res = await fetch(bgUrl("/api/backup/restore"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/octet-stream", ...(passphrase ? { "x-backup-passphrase": encodeURIComponent(passphrase) } : {}) },
      body: file,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
    return data as { ok: boolean; from: string; venue: string; box: string; core: number; broker: boolean; games: string[]; skipped: string[] };
  },
  saveSchedule: (s: Schedule) => call<Schedule>("PUT", `/schedules/${encodeURIComponent(s.id)}`, s),
  deleteSchedule: (id: string) => call("DELETE", `/schedules/${encodeURIComponent(id)}`),
  systemStats: () => call<SystemStats>("GET", "/system/stats"),
  updateBox: (version?: string) => call<{ ok: boolean; message?: string }>("POST", "/system/update", { version }),
  reboot: () => call<{ ok: boolean; message?: string }>("POST", "/system/reboot", { confirm: "reboot" }),
  shutdown: () => call<{ ok: boolean; message?: string }>("POST", "/system/shutdown", { confirm: "shutdown" }),
  updates: () => call<Updates>("GET", "/games/updates"),
  checkUpdates: () => call<Updates>("POST", "/games/updates/check"),
  updateGame: (id: string, force = false) => call<{ game: Game; from: string; warnings: string[] }>("POST", `/games/${encodeURIComponent(id)}/update`, force ? { force: true } : undefined),
  install: (url: string, hostnameAlias?: string) => call<{ game: Game; upgraded: boolean; warnings: string[] }>("POST", "/games/install", { url, hostnameAlias: hostnameAlias || undefined }),
  patchGame: (id: string, patch: { enabled?: boolean; branding?: GameBranding; hostnameAlias?: string | null; ownHostname?: boolean }) => call<Game>("PATCH", `/games/${id}`, patch),
  removeGame: (id: string) => call("DELETE", `/games/${id}`),
  events: () => call<BarGamesEvent[]>("GET", "/events/recent?limit=30"),
  displays: () => call<Display[]>("GET", "/broker/displays?health=1"),
  discover: () => call<{ found: number; errors: string[] }>("POST", "/broker/discover", {}),
  /** Every TV, ignored ones too (box 0.15.2): the TVs page. Elsewhere use displays(). */
  displaysAll: () => call<Display[]>("GET", "/broker/displays?health=1&all=1"),
  ignoreDisplay: (id: string, ignored: boolean) => call<Display>("PATCH", `/broker/displays/${encodeURIComponent(id)}`, { ignored }),
  detachAll: () => call<{ stopped: string[]; failed: Record<string, string>; audioStopped: number; media: { gameId: string; displayId: string; ok: boolean; message?: string }[] }>("POST", "/tvs/detach-all", {}),
  forgetDisplay: (id: string) => call<{ ok: boolean }>("DELETE", `/broker/displays/${encodeURIComponent(id)}`),
  addRoku: (host: string) => call<Display>("POST", "/broker/displays/roku", { host }),
  addAirplay: (host: string) => call<Display>("POST", "/broker/displays/airplay", { host }),
  addVizio: (host: string) => call<Display>("POST", "/broker/displays/vizio", { host }),
  addAppleTv: (host: string) => call<Display>("POST", "/broker/displays/appletv", { host }),
  /** Vizio TV control: no code → the TV shows a PIN; with the PIN → paired. */
  pairControl: (id: string, code?: string) => call<ShowResult>("POST", `/broker/displays/${encodeURIComponent(id)}/pair-control`, code ? { code } : {}),
  setInput: (id: string, input: string) => call("POST", `/broker/displays/${encodeURIComponent(id)}/input`, { input }),
  patchDisplay: (id: string, patch: { label?: string; group?: string; delivery?: string; streamSettings?: StreamSettings | null; touch?: boolean }) =>
    call<Display>("PATCH", `/broker/displays/${encodeURIComponent(id)}`, patch),
  tvStartup: () => call<Record<string, StartupRule>>("GET", "/tv-startup"),
  setTvStartup: (id: string, rule: StartupRule) => call<Record<string, StartupRule>>("PUT", `/tv-startup/${encodeURIComponent(id)}`, rule),
  runTvStartup: () => call<{ waiting: string[] }>("POST", "/tv-startup/run"),
  key: (id: string, key: string) => call("POST", `/broker/displays/${encodeURIComponent(id)}/key`, { key }),
  tvApps: (id: string) => call<{ apps: { id: string; name: string }[]; active?: string }>("GET", `/broker/displays/${encodeURIComponent(id)}/apps`),
  launchTvApp: (id: string, appId: string) => call("POST", `/broker/displays/${encodeURIComponent(id)}/apps/${encodeURIComponent(appId)}/launch`),
  tvAppIconUrl: (id: string, appId: string) => imgUrl(`/broker/displays/${encodeURIComponent(id)}/apps/${encodeURIComponent(appId)}/icon`),
  typeText: (id: string, text: string) => call("POST", `/broker/displays/${encodeURIComponent(id)}/text`, { text }),
  /** For <img src>: changes every call so the browser fetches a fresh picture. */
  previewUrl: (id: string) => imgUrl(`/broker/displays/${encodeURIComponent(id)}/preview?t=${Date.now()}`),
  power: (id: string, on: boolean) => call("POST", `/broker/displays/${encodeURIComponent(id)}/power`, { on }),
  pair: (id: string, code?: string) => call<ShowResult>("POST", `/broker/displays/${encodeURIComponent(id)}/pair`, code ? { code } : {}),
  /** Box 0.19.0: guest hosts (one app's controls for a guest). */
  guests: () => call<GuestsOverview>("GET", "/guests"),
  newGuest: (gameId: string, label: string, hours?: number) =>
    call<GuestLinkRow & { url: string; qrSvg: string }>("POST", "/guests", { gameId, label, ...(hours ? { hours } : {}) }),
  guestLink: (id: string) => call<{ url: string; qrSvg: string }>("GET", `/guests/${encodeURIComponent(id)}/link`),
  revokeGuest: (id: string) => call("DELETE", `/guests/${encodeURIComponent(id)}`),
  guestSettings: (gameId: string, cohosts: boolean) => call("PUT", `/guests/settings/${encodeURIComponent(gameId)}`, { cohosts }),
  /** Box 0.17.0: take over hosting, or invite a co-host; the link and its QR code (staff only). */
  roomLink: (gameId: string, code: string, kind: "host" | "cohost", minutes?: number) =>
    call<{ url: string; expiresAt?: string; message?: string; qrSvg: string }>("POST", `/rooms/${encodeURIComponent(gameId)}/${encodeURIComponent(code)}/link`, { kind, ...(minutes ? { minutes } : {}) }),
  command: (id: string, body: { command: string; roomCode?: string; args?: Record<string, unknown> }) =>
    call<{ ok: boolean; message?: string; data?: unknown }>("POST", `/games/${encodeURIComponent(id)}/command`, body),
  rooms: () => call<RoomsOverview>("GET", "/rooms"),
  hostQrUrl: (gameId: string, code: string) => imgUrl(`/rooms/${encodeURIComponent(gameId)}/${encodeURIComponent(code)}/host.svg`),
  announcement: () => call<Announcement | null>("GET", "/announcement"),
  announce: (text: string, minutes?: number, where: { show?: "everywhere" | "phones" | "tvs"; position?: "top" | "bottom" } = {}) => call<Announcement>("PUT", "/announcement", { text, minutes, ...where }),
  clearAnnouncement: () => call<null>("DELETE", "/announcement"),
  idleTvs: (target: { displayIds?: string[]; group?: string } = {}) => call<Record<string, ShowResult>>("POST", "/tvs/idle", target),
  gameStatus: (id: string) => call<{ rooms: RoomSummary[] }>("GET", `/games/${encodeURIComponent(id)}/status`),
  integrations: () => call<{ integrations: Integration[] }>("GET", "/integrations"),
  enableIntegration: (id: string, on: boolean, approve = false) => call<Integration>("POST", `/integrations/${encodeURIComponent(id)}/enable`, { on, approve }),
  integrationAction: (id: string, action: string) => call<{ ok: boolean }>("POST", `/integrations/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, {}),
  approveIntegration: (id: string) => call<Integration>("POST", `/integrations/${encodeURIComponent(id)}/approve`, {}),
  integrationSettings: (id: string, values: Record<string, string | null>) => call<Integration>("PUT", `/integrations/${encodeURIComponent(id)}/settings`, { values }),
  integrationQrUrl: (id: string, at?: string) => imgUrl(`/integrations/${encodeURIComponent(id)}/pairing.svg${at ? `?at=${encodeURIComponent(at)}` : ""}`),
  // Connected devices (box 0.15.0): sound outputs and Bluetooth speakers, kept by the broker.
  audio: () => call<AudioState>("GET", "/broker/audio"),
  audioOutput: (id: string, patch: { label?: string | null; volume?: number; default?: true }) => call<AudioOutputView>("PATCH", `/broker/audio/outputs/${encodeURIComponent(id)}`, patch),
  audioTest: (id: string) => call<AudioSessionView>("POST", `/broker/audio/outputs/${encodeURIComponent(id)}/test`, {}),
  audioStop: (sessionId: string) => call<AudioSessionView>("POST", `/broker/audio/sessions/${encodeURIComponent(sessionId)}/stop`, { by: "admin" }),
  bluetooth: () => call<{ status: BluetoothStatus; devices: BluetoothDevice[] }>("GET", "/broker/audio/bluetooth"),
  bluetoothScan: () => call<{ ok: boolean; seconds: number }>("POST", "/broker/audio/bluetooth/scan", { seconds: 20 }),
  bluetoothAction: (address: string, action: "pair" | "connect" | "disconnect") => call<{ ok: boolean }>("POST", `/broker/audio/bluetooth/${encodeURIComponent(address)}/${action}`, {}),
  bluetoothForget: (address: string) => call<{ ok: boolean }>("DELETE", `/broker/audio/bluetooth/${encodeURIComponent(address)}`),
  secrets: (gameId: string) => call<{ secrets: { name: string; length: number }[] }>("GET", `/games/${encodeURIComponent(gameId)}/secrets`),
  setSecret: (gameId: string, name: string, value: string | null) =>
    call("PUT", `/games/${encodeURIComponent(gameId)}/secrets/${encodeURIComponent(name)}`, { value }),
  staffLink: (gameId: string, path?: string) =>
    call<{ url: string; staffAware: boolean }>("GET", `/staff-link?gameId=${encodeURIComponent(gameId)}${path ? `&path=${encodeURIComponent(path)}` : ""}`),
  /** Box 0.24.0: the players' page or a game's own start page on TVs (kiosks, host screens). */
  castPage: (body: { page: "players" | "game"; gameId?: string; displayIds?: string[]; group?: string }) =>
    call<{ url: string; results: Record<string, ShowResult> }>("POST", "/cast/page", body),
  cast: (body: { gameId: string; roomCode?: string; displayIds?: string[]; group?: string; firstJoinerHosts?: boolean }) =>
    call<{ roomCode?: string; created?: boolean; hostUrl?: string; url: string; results: Record<string, ShowResult> }>("POST", "/cast", body),
  castSettings: () => call<CastSettings>("GET", "/cast-settings"),
  saveCastSettings: (s: CastSettings) => call<CastSettings>("PUT", "/cast-settings", s),
  cloudflare: () => call<CfStatus>("GET", "/cloudflare"),
  cloudflareToken: (token: string) => call<{ zones: CfZone[] }>("POST", "/cloudflare/token", { token }),
  cloudflareZones: () => call<CfZone[]>("GET", "/cloudflare/zones"),
  cloudflarePlan: (zoneId: string, hostnamePattern: string) => call<{ zone: CfZone; hosts: CfHost[]; warnings: string[] }>("POST", "/cloudflare/plan", { zoneId, hostnamePattern }),
  cloudflareConnect: (zoneId: string, hostnamePattern: string, adminRemote: boolean) => call<CfStatus>("POST", "/cloudflare/connect", { zoneId, hostnamePattern, adminRemote }),
  cloudflareSync: () => call("POST", "/cloudflare/sync"),
  cloudflareDisconnect: () => call("DELETE", "/cloudflare"),
  show: (target: { displayIds?: string[]; group?: string }, content: { kind: string; url?: string }) => call<Record<string, ShowResult>>("POST", "/broker/show", { ...target, content }),
};

/** SDK 0.12.0: an integration (Matter, Home Assistant…), as Settings → Smart home shows it. */
export interface AudioSessionView {
  id: string;
  output: string;
  /** "app:<id>" or "admin" (a test sound). */
  owner: string;
  state: "starting" | "playing" | "paused" | "ended" | "error";
  positionMs: number;
  title?: string;
  artist?: string;
  durationMs?: number;
  message?: string;
}
export interface AudioOutputView {
  id: string;
  kind: "box" | "bluetooth" | "tv";
  name: string;
  label?: string;
  available: boolean;
  detail?: string;
  volume: number;
  default: boolean;
  session?: AudioSessionView;
}
export interface BluetoothStatus {
  available: boolean;
  message?: string;
  powered: boolean;
  scanning: boolean;
}
export interface BluetoothDevice {
  address: string;
  name: string;
  paired: boolean;
  connected: boolean;
  audio: boolean;
  rssi?: number;
  job?: { state: "pairing" | "connecting" | "failed" | "done"; message?: string };
}
export interface AudioState {
  available: boolean;
  outputs: AudioOutputView[];
  sessions: AudioSessionView[];
  bluetooth: BluetoothStatus | null;
}

export interface Integration {
  id: string;
  name: string;
  version: string;
  description?: string;
  homepage?: string;
  source: string;
  trusted: boolean;
  enabled: boolean;
  state: string;
  permissions: { id: string; text: string; granted: boolean }[];
  needsApproval: string[];
  blocked: string[];
  settings: { name: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; help?: string; set: boolean; value?: string }[];
  report?: IntegrationReport;
  reportAt?: string;
  connected: boolean;
  update?: UpdateInfo;
}
