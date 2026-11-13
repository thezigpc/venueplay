import { bgUrl } from "@bargames/sdk";
import type { BarGamesEvent, GameBranding, GameManifest, VenueContext, VenueLocation, VenueTheme, WifiInfo } from "@bargames/sdk";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(bgUrl(`/api${path}`), {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
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
export type SceneAction =
  | { displayId: string; do: "game"; gameId: string }
  | { displayId: string; do: "media"; gameId: string; itemId: string }
  | { displayId: string; do: "idle" | "off" }
  | { displayId: string; do: "power"; on: boolean }
  | { displayId: string; do: "input"; input: string }
  | { displayId: string; do: "app"; appId: string; appName?: string }
  | { displayId: string; do: "channel"; channel: string };
export interface Scene {
  id: string;
  name: string;
  actions: SceneAction[];
  endRooms?: boolean;
  announcement?: { text: string; minutes?: number };
  countdown?: { label: string; minutes: number };
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
  label?: string;
  group?: string;
  model?: string;
  isTv?: boolean;
  delivery?: string;
  capabilities?: { delivery: string[]; power: boolean; inputs: string[]; remoteKeys?: string[]; apps?: boolean; text?: boolean; tvChannels?: boolean; control?: { paired: boolean } };
  streamSettings?: StreamSettings;
  health?: { online: boolean; powerMode?: string; detail?: string };
  content?: { kind: string; url?: string; title?: string; app?: string; provider?: string };
  stream?: { delivery: string; url: string; state: string; needsCode: boolean; detail?: string; settings?: string };
}

export interface StreamSettings {
  resolution: "720p" | "1080p";
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

export interface RoomsOverview {
  at: string;
  games: { id: string; name: string; publicUrl?: string; commands: string[]; error?: string; rooms: (RoomSummary & { tvs: { id: string; name: string }[] })[] }[];
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
  login: (password: string) => call("POST", "/auth/login", { password }),
  logout: () => call("POST", "/auth/logout"),
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
  attention: () => call<{ items: { source: string; sourceName: string; level: "info" | "warn" | "error"; message: string; actionPath?: string }[] }>("GET", "/attention"),
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
  applyScene: (id: string) => call<{ steps: { step: string; ok: boolean; message?: string }[] }>("POST", `/scenes/${encodeURIComponent(id)}/apply`),
  schedules: () => call<{ schedules: Schedule[] }>("GET", "/schedules"),
  saveSchedule: (s: Schedule) => call<Schedule>("PUT", `/schedules/${encodeURIComponent(s.id)}`, s),
  deleteSchedule: (id: string) => call("DELETE", `/schedules/${encodeURIComponent(id)}`),
  systemStats: () => call<SystemStats>("GET", "/system/stats"),
  updateBox: (version?: string) => call<{ ok: boolean; message?: string }>("POST", "/system/update", { version }),
  reboot: () => call<{ ok: boolean; message?: string }>("POST", "/system/reboot", { confirm: "reboot" }),
  shutdown: () => call<{ ok: boolean; message?: string }>("POST", "/system/shutdown", { confirm: "shutdown" }),
  updates: () => call<Updates>("GET", "/games/updates"),
  checkUpdates: () => call<Updates>("POST", "/games/updates/check"),
  updateGame: (id: string) => call<{ game: Game; from: string; warnings: string[] }>("POST", `/games/${encodeURIComponent(id)}/update`),
  install: (url: string, hostnameAlias?: string) => call<{ game: Game; upgraded: boolean; warnings: string[] }>("POST", "/games/install", { url, hostnameAlias: hostnameAlias || undefined }),
  patchGame: (id: string, patch: { enabled?: boolean; branding?: GameBranding; hostnameAlias?: string | null; ownHostname?: boolean }) => call<Game>("PATCH", `/games/${id}`, patch),
  removeGame: (id: string) => call("DELETE", `/games/${id}`),
  events: () => call<BarGamesEvent[]>("GET", "/events/recent?limit=30"),
  displays: () => call<Display[]>("GET", "/broker/displays?health=1"),
  discover: () => call<{ found: number; errors: string[] }>("POST", "/broker/discover", {}),
  forgetDisplay: (id: string) => call<{ ok: boolean }>("DELETE", `/broker/displays/${encodeURIComponent(id)}`),
  addRoku: (host: string) => call<Display>("POST", "/broker/displays/roku", { host }),
  addAirplay: (host: string) => call<Display>("POST", "/broker/displays/airplay", { host }),
  addVizio: (host: string) => call<Display>("POST", "/broker/displays/vizio", { host }),
  addAppleTv: (host: string) => call<Display>("POST", "/broker/displays/appletv", { host }),
  /** Vizio TV control: no code → the TV shows a PIN; with the PIN → paired. */
  pairControl: (id: string, code?: string) => call<ShowResult>("POST", `/broker/displays/${encodeURIComponent(id)}/pair-control`, code ? { code } : {}),
  setInput: (id: string, input: string) => call("POST", `/broker/displays/${encodeURIComponent(id)}/input`, { input }),
  patchDisplay: (id: string, patch: { label?: string; group?: string; delivery?: string; streamSettings?: StreamSettings | null }) =>
    call<Display>("PATCH", `/broker/displays/${encodeURIComponent(id)}`, patch),
  tvStartup: () => call<Record<string, StartupRule>>("GET", "/tv-startup"),
  setTvStartup: (id: string, rule: StartupRule) => call<Record<string, StartupRule>>("PUT", `/tv-startup/${encodeURIComponent(id)}`, rule),
  runTvStartup: () => call<{ waiting: string[] }>("POST", "/tv-startup/run"),
  key: (id: string, key: string) => call("POST", `/broker/displays/${encodeURIComponent(id)}/key`, { key }),
  tvApps: (id: string) => call<{ apps: { id: string; name: string }[]; active?: string }>("GET", `/broker/displays/${encodeURIComponent(id)}/apps`),
  launchTvApp: (id: string, appId: string) => call("POST", `/broker/displays/${encodeURIComponent(id)}/apps/${encodeURIComponent(appId)}/launch`),
  tvAppIconUrl: (id: string, appId: string) => bgUrl(`/api/broker/displays/${encodeURIComponent(id)}/apps/${encodeURIComponent(appId)}/icon`),
  typeText: (id: string, text: string) => call("POST", `/broker/displays/${encodeURIComponent(id)}/text`, { text }),
  /** For <img src>: changes every call so the browser fetches a fresh picture. */
  previewUrl: (id: string) => bgUrl(`/api/broker/displays/${encodeURIComponent(id)}/preview?t=${Date.now()}`),
  power: (id: string, on: boolean) => call("POST", `/broker/displays/${encodeURIComponent(id)}/power`, { on }),
  pair: (id: string, code?: string) => call<ShowResult>("POST", `/broker/displays/${encodeURIComponent(id)}/pair`, code ? { code } : {}),
  command: (id: string, body: { command: string; roomCode?: string; args?: Record<string, unknown> }) =>
    call<{ ok: boolean; message?: string; data?: unknown }>("POST", `/games/${encodeURIComponent(id)}/command`, body),
  rooms: () => call<RoomsOverview>("GET", "/rooms"),
  announcement: () => call<Announcement | null>("GET", "/announcement"),
  announce: (text: string, minutes?: number, where: { show?: "everywhere" | "phones" | "tvs"; position?: "top" | "bottom" } = {}) => call<Announcement>("PUT", "/announcement", { text, minutes, ...where }),
  clearAnnouncement: () => call<null>("DELETE", "/announcement"),
  idleTvs: (target: { displayIds?: string[]; group?: string } = {}) => call<Record<string, ShowResult>>("POST", "/tvs/idle", target),
  gameStatus: (id: string) => call<{ rooms: RoomSummary[] }>("GET", `/games/${encodeURIComponent(id)}/status`),
  secrets: (gameId: string) => call<{ secrets: { name: string; length: number }[] }>("GET", `/games/${encodeURIComponent(gameId)}/secrets`),
  setSecret: (gameId: string, name: string, value: string | null) =>
    call("PUT", `/games/${encodeURIComponent(gameId)}/secrets/${encodeURIComponent(name)}`, { value }),
  staffLink: (gameId: string, path?: string) =>
    call<{ url: string; staffAware: boolean }>("GET", `/staff-link?gameId=${encodeURIComponent(gameId)}${path ? `&path=${encodeURIComponent(path)}` : ""}`),
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
