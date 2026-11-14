// The contract between a game and the Bar Games box. Everything here is plain data,
// safe to import from browser code, Node code, and the box itself.

export const SDK_VERSION = "0.13.2";
/** Bumped only on breaking changes to VenueContext, events or commands. */
export const PROTOCOL_VERSION = 1;

/**
 * How deeply a game integrates (declared in bargames.json as sdk.level).
 * 0 hosted · 1 branded · 2 connected (events) · 3 controllable (commands)
 */
export type IntegrationLevel = 0 | 1 | 2 | 3;

/**
 * venue:   run by the venue (host / iPad / schedule), shown on the venue's TVs
 * patron:  started by a guest from the landing page; phones or a claimed TV
 * private: a booked party; assigned TVs
 */
export type SessionKind = "venue" | "patron" | "private";
export const SESSION_KINDS: readonly SessionKind[] = ["venue", "patron", "private"];

// ---------------------------------------------------------------- branding

export interface ThemeColors {
  background: string;
  surface: string;
  text: string;
  primary: string;
  accent: string;
  /** Text on the primary color (SDK 0.5.0+). Absent: pick #111 or #fff by contrast; themeCssVars does. */
  onPrimary?: string;
}

export interface VenueTheme {
  colors: ThemeColors;
  /** CSS font-family stack. */
  font?: string;
  /** Corner radius in px. */
  radius?: number;
  logoUrl?: string;
  /** Logo for dark backgrounds, if different. */
  logoDarkUrl?: string;
}

export interface WifiInfo {
  ssid: string;
  password?: string;
  security?: "WPA" | "WEP" | "nopass";
}

export interface VenueInfo {
  name: string;
  theme: VenueTheme;
  wifi?: WifiInfo;
  /** The venue's games list (landing page), e.g. https://play.example.com */
  playUrl?: string;
  /**
   * SDK 0.13.2 (box 0.15.6): short room links work: playUrl + "/" + a room code
   * (https://play.example.com/AB12) opens that room's join page, for rooms whose status has
   * a joinPath. Use joinDisplay(ctx, path, code).roomShort to print it.
   */
  roomLinks?: boolean;
  /** SDK 0.11.0: the box admin's address (e.g. https://play.example.com/admin), for a "Box admin" link on staff pages. */
  adminUrl?: string;
  /** Every game that's on tonight, this one included (SDK 0.4.0+ boxes). */
  games?: VenueGameLink[];
  /** A message from the staff for every game page ("Last call at 1:30"), if one is up. */
  announcement?: Announcement;
  /** Apps on the box (menus, signage…): not games, listed apart (SDK 0.6.0+). */
  apps?: VenueGameLink[];
  /** @deprecated SDK 0.5.0 name for `apps` (same list). */
  modules?: VenueGameLink[];
  /** Where the venue is, if the staff set it (weather, sunset times). SDK 0.5.0+. */
  location?: VenueLocation;
  /** The venue's IANA time zone, e.g. "America/New_York". SDK 0.5.0+. */
  timezone?: string;
  /** Units the venue prefers. SDK 0.5.0+. */
  units?: "imperial" | "metric";
  /** A lobby countdown, if one is running (SDK 0.9.0). */
  countdown?: Countdown;
  /** Tonight's winners per game that reports results (SDK 0.9.0). */
  leaderboards?: LeaderboardSummary[];
}

export interface VenueLocation {
  latitude: number;
  longitude: number;
  /** "Asheville, NC" */
  label?: string;
}

/** One game on the venue's games list. */
export interface VenueGameLink {
  id: string;
  displayName: string;
  tagline?: string;
  iconUrl?: string;
  /** The game's public address. */
  url: string;
}

export interface Announcement {
  /** Changes with every new message, so a dismissed message stays dismissed. */
  id: string;
  text: string;
  /** ISO time it comes down on its own, if set. */
  until?: string;
  /**
   * SDK 0.11.0: where it shows. "everywhere" (default): phones and TVs; "phones": players'
   * own screens only; "tvs": shared screens (TV views, idle TVs) only.
   */
  show?: "everywhere" | "phones" | "tvs";
  /** SDK 0.11.0: "top" (default) or "bottom" of the page. */
  position?: "top" | "bottom";
}

/** What a venue may override per game (only slots the manifest marks brandable). */
export interface GameBranding {
  displayName?: string;
  tagline?: string;
  iconUrl?: string;
  /** Accent color override for this game only. */
  accent?: string;
}

/** Served to games at PATHS.venue and from the server SDK's venue(). */
export interface VenueContext {
  protocol: number;
  venue: VenueInfo;
  game: {
    id: string;
    displayName: string;
    tagline?: string;
    iconUrl?: string;
    /** This game's public address, e.g. https://bingo.example.com or https://venue.example.com/bingo */
    publicUrl?: string;
    /** SDK 0.10.0: the path prefix when the game is served under one ("/bingo"), else absent. */
    basePath?: string;
    /** Venue theme with the game's overrides applied. */
    theme: VenueTheme;
  };
  /** True when the game runs on its own, not on a Bar Games box. */
  standalone: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------- events

export const STANDARD_EVENTS = [
  "room_created",
  "room_closed",
  "players_changed",
  "round_started",
  "round_ended",
  "claim_pending",
  "winner",
  "game_over",
  /** SDK 0.9.0: data is a GameResult (bg.reportResults sends it). */
  "game_result",
] as const;
export type StandardEventType = (typeof STANDARD_EVENTS)[number];

/** Custom events are allowed; prefix them with "x-" (e.g. "x-pool-break"). */
export type EventType = StandardEventType | `x-${string}`;

/** What a game sends. */
export interface GameEventInput<T = Record<string, unknown>> {
  type: EventType;
  roomCode?: string;
  sessionKind?: SessionKind;
  data?: T;
}

/** What the box stores and fans out (Home Assistant, admin UI, webhooks). */
export interface BarGamesEvent<T = Record<string, unknown>> extends GameEventInput<T> {
  gameId: string;
  at: string;
}

// ---------------------------------------------------------------- commands

export const STANDARD_COMMANDS = ["create_room", "start", "pause", "resume", "next_round", "end", "confirm_claim", "reject_claim", "media_list", "media_play", "media_stop"] as const;
export type StandardCommand = (typeof STANDARD_COMMANDS)[number];

export interface CommandRequest {
  command: string;
  roomCode?: string;
  args?: Record<string, unknown>;
}

export interface CommandResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}

/**
 * args of the standard "create_room" command. The box sends it when staff put a game
 * on the TVs without an existing room ("Cast → New room"). The new room has no host
 * phone: the box runs it with commands, and staff can open `hostUrl` on the iPad.
 */
export interface CreateRoomArgs {
  /** "venue" when the box creates it. */
  kind: SessionKind;
  /** Why: "display" = its table view is about to be cast to TVs. */
  purpose?: "display";
  /** Optional title, e.g. "Friday Bingo". */
  title?: string;
  /**
   * SDK 0.7.0: staff put the room on a TV with nobody to host it yet. The first player who
   * joins (scanning the TV's QR code) should become the host. Games without a host role
   * can ignore it.
   */
  firstJoinerHosts?: boolean;
}

/** `data` of a successful "create_room". */
export interface CreatedRoom {
  roomCode: string;
  /**
   * Where staff control the room, as a path on the game's origin ("/join/ABCD?key=…")
   * or a full URL. It may carry a host secret: the box only shows it to admins.
   */
  hostUrl?: string;
}

// ---------------------------------------------------------------- casting from a game

/** A venue TV a game host can cast to. */
export interface CastDisplay {
  id: string;
  /** The venue's name for it, e.g. "Bar left". */
  name: string;
  group?: string;
  /** Showing something right now. */
  busy: boolean;
  /** Showing a room of this game; `roomCode` says which. */
  showingThisGame: boolean;
  roomCode?: string;
}

/** What bg.displays() returns. Off a box, or when the venue turned it off: enabled false. */
export interface CastTargets {
  enabled: boolean;
  /** The venue requires its TV PIN for casting. */
  pinRequired: boolean;
  displays: CastDisplay[];
}

export interface CastResult {
  ok: boolean;
  message?: string;
  /** Per TV id. needsCode: the TV wants AirPlay pairing; staff do that in the box admin. */
  results?: Record<string, { ok: boolean; message?: string; needsCode?: boolean }>;
}

/**
 * A win/claim waiting for a human decision (e.g. a BINGO call). List it in the room's
 * status so staff can resolve it from the box's iPad with "confirm_claim" / "reject_claim".
 */
export interface PendingClaim {
  /** Stable id the game recognises in ClaimArgs. */
  id: string;
  /** Who claimed, as shown to staff. */
  player?: string;
  /** Short text for staff, e.g. "Line on row 3". */
  detail?: string;
  /** ISO time the claim was made. */
  at?: string;
}

/** args of the standard "confirm_claim" / "reject_claim" commands (roomCode is on the request). */
export interface ClaimArgs {
  /** Which claim. Omitted: the room's oldest pending claim. */
  claimId?: string;
  /** reject_claim: optional reason shown to the player. */
  reason?: string;
}

export interface RoomSummary {
  code: string;
  kind: SessionKind;
  players: number;
  phase?: string;
  title?: string;
  hostConnected?: boolean;
  /** Claims waiting for a decision. Games with confirm_claim / reject_claim should list them. */
  pendingClaims?: PendingClaim[];
  /** ISO time the room opened (bird's-eye view: "Opened 20 min ago"). */
  createdAt?: string;
  /** ISO time of the last player or host action. */
  lastActivityAt?: string;
  /** Table/TV clients connected to the room right now. */
  tables?: number;
  /** The room's player cap, if it has one. */
  maxPlayers?: number;
  /** The host's display name, if the room has a host. */
  hostName?: string;
  /**
   * Where a new player joins this room, as a path on the game's address (e.g. "/join/KQ7P").
   * The venue's games list shows a "Join" link for venue and patron rooms that set it;
   * private rooms are never listed.
   */
  joinPath?: string;
}

export interface GameStatus {
  rooms: RoomSummary[];
  /** Media providers (SDK 0.9.0): the box TVs this app can play on. */
  media?: { targets: MediaTarget[] };
}

// ---------------------------------------------------------------- wiring

/** Environment variables the box sets on every game container. */
export const ENV = {
  gameId: "BG_GAME_ID",
  coreUrl: "BG_CORE_URL",
  token: "BG_GAME_TOKEN",
  publicUrl: "BG_PUBLIC_URL",
  dataDir: "BG_DATA_DIR",
  /** SDK 0.10.0: the path prefix the box serves the game under ("/bingo"), when it does. */
  basePath: "BG_BASE_PATH",
} as const;

/** Reserved paths on every game hostname. */
export const PATHS = {
  venue: "/__bargames/venue.json",
  themeCss: "/__bargames/theme.css",
  command: "/__bargames/command",
  status: "/__bargames/status",
  pin: "/__bargames/pin",
  /** Staff sign-in hand-off from the box admin (the gateway handles it; SDK 0.7.0). */
  staff: "/__bargames/staff",
  /** SDK 0.11.0: the announcement and countdown only, for idle screens (no PIN; CORS). */
  live: "/__bargames/live.json",
} as const;

/** Headers the gateway adds to every proxied request. */
export const HEADERS = {
  via: "x-bargames-via",
  clientIp: "x-bargames-client-ip",
  access: "x-bargames-access",
  /** "1": the request comes from staff signed in to the box admin (SDK 0.7.0). */
  staff: "x-bargames-staff",
} as const;

/** Why the gateway let a request in. */
/** "open": the venue lets anyone play (open mode); the player may be anywhere. */
export type AccessReason = "local" | "venue-ip" | "whitelist" | "pin" | "open";

// ---------------------------------------------------------------- SDK 0.9.0

/** Something staff should look at, shown on the box's Tonight page with a link into the game. */
export interface AttentionItem {
  level: "info" | "warn" | "error";
  message: string;
  /** A path on the game's own address, e.g. "/admin#google". */
  actionPath?: string;
}

/** "Trivia starts in 5:00": one at a time per venue, on phones, the games list and idle TVs. */
export interface Countdown {
  id: string;
  label: string;
  /** ISO time it reaches zero. */
  endsAt: string;
  /** The game it's for, and where to join (when a room is waiting). */
  gameId?: string;
  joinUrl?: string;
}

/** One finished game: who placed or scored. */
export interface GameResult {
  roomCode?: string;
  results: { player: { name: string; profileId?: string }; place?: number; score?: number }[];
}

/** A game's board on the venue's games list and idle screen. */
export interface LeaderboardSummary {
  gameId: string;
  displayName: string;
  /** Since the venue's day started (4 AM local). Most wins first. */
  tonight: { name: string; wins: number; best?: number }[];
}

/** STUB (planned): a player's venue profile, shared across games on the box. */
export interface PlayerProfile {
  id: string;
  nickname: string;
  avatarUrl?: string;
  stats?: Record<string, number>;
}

// ---------------------------------------------------------------- audio (SDK 0.13.0)
// Apps and games that declare "audio": { "play": true } can play their own audio on the
// box's sound outputs, which the venue sets up under Settings → Connected devices: the
// box's own jack or HDMI, paired Bluetooth speakers, and TVs over AirPlay.
// Server helper: bg.audio (createBarGames), or createAudio() from "@bargames/sdk/audio".

/**
 * A place the box can play sound.
 *   box        the box's own headphone jack, or a screen plugged into its HDMI/DisplayPort
 *   bluetooth  a Bluetooth speaker the venue paired
 *   tv         a TV (or AirPlay speaker) over AirPlay; it stops whatever the box casts to that TV
 */
export interface AudioOutput {
  id: string;
  /** The venue's name for it. */
  name: string;
  kind: "box" | "bluetooth" | "tv";
  /** False when it can't play now (e.g. no screen plugged into that HDMI port). */
  available: boolean;
  /** The venue's default output (used when play() names none). */
  default: boolean;
  /** 0-100, set by the venue (and by the app while it plays there). */
  volume: number;
  /** Something else (another app) is playing on it now. */
  busy?: boolean;
  detail?: string;
}

export type AudioSessionState = "starting" | "playing" | "paused" | "ended" | "error";

/** One thing playing on one output. Ended sessions stay listed for about a minute. */
export interface AudioSession {
  id: string;
  output: string;
  /** "app:<your id>" for yours. */
  owner: string;
  state: AudioSessionState;
  /** How far it has played (ms), pauses excluded. */
  positionMs: number;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  startedAt: string;
  endedAt?: string;
  /** Why it ended early or failed, in plain words (show it to staff). */
  message?: string;
  /**
   * SDK 0.13.1 (box 0.15.4): why it ended, for code. "finished": played to the end;
   * "stopped": an app or staff stopped it (or the box restarted); "replaced": something
   * else started on that output; "disconnected": the speaker or TV went away; "error":
   * it couldn't play. A queue moves on after "finished", and usually after "error".
   * Absent on older boxes: fall back to `state`.
   */
  endReason?: AudioEndReason;
}

export type AudioEndReason = "finished" | "stopped" | "replaced" | "disconnected" | "error";

export interface AudioPlayOptions {
  /**
   * The audio, as a path on your own server: "/tracks/12.mp3". The box fetches it from
   * your container with `Authorization: Bearer <BG_GAME_TOKEN>` and `x-bargames-audio: 1`
   * (bg.fromBox(req) checks), so you can keep the route off the public internet. MP3,
   * AAC/M4A, FLAC, Ogg and WAV work; answer Range requests for M4A.
   */
  path: string;
  /** An output id from outputs(); absent: the venue's default. */
  output?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  /** Take the output over when another app is playing on it (it gets "Replaced…"). */
  replace?: boolean;
}

/** The box's audio API for apps, on BG_CORE_URL (game token). */
export const AUDIO_PATHS = {
  /** GET: AudioOutput[]. */
  outputs: "/internal/audio/outputs",
  /** POST AudioPlayOptions → AudioSession. */
  play: "/internal/audio/play",
  /** GET: your sessions (AudioSession[]). */
  sessions: "/internal/audio/sessions",
  /** POST: pause, resume or stop one of your sessions. */
  control: (id: string, action: "pause" | "resume" | "stop") => `/internal/audio/sessions/${encodeURIComponent(id)}/${action}`,
  /** PUT { volume }: while you play on that output. */
  volume: (outputId: string) => `/internal/audio/outputs/${encodeURIComponent(outputId)}/volume`,
} as const;

// Media providers (apps such as YouTube that put their own content on TVs).

export interface MediaItem {
  id: string;
  name: string;
  /** "list": plays on one TV. "plan": starts several TVs at once (no displayId). */
  kind: "list" | "plan";
  thumbnailUrl?: string;
  count?: number;
}

export type MediaTargetState = "linked" | "starting" | "playing" | "paused" | "local" | "unlinked" | "error";

/** One box TV the provider can play on (it mapped its own link to this display). */
export interface MediaTarget {
  displayId: string;
  label: string;
  state: MediaTargetState;
  nowPlaying?: { title: string; listName?: string };
  itemId?: string;
}

export interface MediaPlayArgs {
  /** Required for lists; ignored for plans. */
  displayId?: string;
  itemId: string;
  /** A staff pick: take the TV back from local control. */
  takeBack?: boolean;
}

export interface MediaPlayResult {
  ok: boolean;
  message?: string;
  /** The provider asked the box to start its TV app. */
  launched?: boolean;
  /** Still starting: watch status (the box polls every 3 s for up to 60 s). */
  pending?: boolean;
}

/** A venue TV as media providers see it (bg.tvs()). */
export interface BoxTv {
  id: string;
  name: string;
  group?: string;
  kind: string;
  online: boolean;
  /** TV apps the box can start on it for this provider, e.g. ["youtube"]. */
  canLaunch: string[];
  /** Only for providers declaring media.launch ["youtube"]: the TV's YouTube screen id, read over DIAL. */
  youtubeScreenId?: string;
  /**
   * SDK 0.10.4: what the TV shows now, asked of the TV itself (Roku): one of your
   * media.launch apps ("youtube"), "home", or "other". Absent when the TV can't say.
   * Trust it over a link's own idea of "open": a YouTube link can stay "connected" after
   * the app closed on the TV.
   */
  activeApp?: string;
}

export type LaunchResult = { ok: true } | { ok: false; reason: "not-allowed" | "unsupported" | "offline" | "ecp-blocked" | "error"; message: string };

// ---------------------------------------------------------------- integrations (SDK 0.12.0)
// Connectors to other systems (Matter, Home Assistant, a POS). Node helper:
// "@bargames/sdk/integration". Each call carries the integration's BG_GAME_TOKEN and is
// limited to the permissions the venue approved (403 otherwise).

/** The box's integration API, on BG_CORE_URL. */
export const INTEGRATION_PATHS = {
  /** GET: what the integration may see (IntegrationCatalog). */
  catalog: "/internal/integration/catalog",
  /** GET: server-sent events, one IntegrationMessage per "data:" line. */
  stream: "/internal/integration/stream",
  /** PUT: the integration's own state for the box admin (IntegrationReport). */
  report: "/internal/integration/report",
  /** POST: run a scene. Permission "scenes". */
  scene: (id: string) => `/internal/integration/scenes/${encodeURIComponent(id)}/run`,
  /** POST { on: boolean }: switch a TV on or off. Permission "tvs". */
  tvPower: (id: string) => `/internal/integration/tvs/${encodeURIComponent(id)}/power`,
} as const;

export interface IntegrationScene {
  id: string;
  name: string;
}

export interface IntegrationTv {
  id: string;
  name: string;
  group?: string;
  online: boolean;
  /** The box can switch it on and off (paired for control where the TV needs it). */
  power: boolean;
  /** "Status" permission: what it shows now (a game's name, "Idle", an input). */
  showing?: string;
}

export interface IntegrationGame {
  id: string;
  name: string;
  kind: "game" | "app";
  rooms: number;
}

/** What an integration may see. Lists it has no permission for are left out. */
export interface IntegrationCatalog {
  box: {
    /** Stable for this box (a serial number for Matter, a unique id for Home Assistant). */
    id: string;
    version: string;
    venue: string;
  };
  /** What the venue approved. */
  permissions: string[];
  scenes?: IntegrationScene[];
  tvs?: IntegrationTv[];
  games?: IntegrationGame[];
}

/** One message on the integration stream. The first is always "hello". */
export type IntegrationMessage =
  | { type: "hello"; catalog: IntegrationCatalog }
  /** Scenes, TVs or games changed (renamed, added, removed, switched on or off). */
  | { type: "catalog"; catalog: IntegrationCatalog }
  /** A game event (permission "events"). */
  | { type: "event"; event: BarGamesEvent }
  /** A scene ran, from anywhere (the admin, a schedule, an integration). Permission "scenes". */
  | { type: "scene"; sceneId: string; ok: boolean; by: string; at: string }
  /** Staff pressed one of the buttons from your report's `actions` on the Smart home page. */
  | { type: "action"; action: string; at: string };

/** The integration's own state, shown on the box admin's Smart home page. */
export interface IntegrationReport {
  /** "setup": waiting for the venue (settings, pairing); "ok"; "warn"; "error". */
  state: "setup" | "ok" | "warn" | "error";
  /** One short sentence, e.g. "Connected to Home Assistant" or "Not paired yet". */
  message?: string;
  /**
   * A pairing code for the venue: the box shows `qr` (e.g. Matter's "MT:…" payload) as a
   * QR code and `code` (e.g. the 11-digit manual code) as text.
   */
  pairing?: {
    qr?: string;
    code?: string;
    note?: string;
    /**
     * SDK 0.13.1: when the code stops working (ISO time), e.g. a 15-minute commissioning
     * window. After it the box admin greys the code out and says it expired, even if the
     * integration never sends a new report.
     */
    expiresAt?: string;
  };
  /** A few label/value lines (e.g. "Paired with: Alexa"). At most 12. */
  details?: { label: string; value: string }[];
  /**
   * Buttons for the Smart home page (at most 4), e.g. { id: "reset", label: "Forget all
   * pairings", confirm: "Alexa and Google will lose the box." }. A press arrives on the
   * stream as { type: "action", action: id }. Ids: lowercase letters, digits and dashes.
   */
  actions?: { id: string; label: string; confirm?: string }[];
}
