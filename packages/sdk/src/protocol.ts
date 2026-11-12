// The contract between a game and the Bar Games box. Everything here is plain data,
// safe to import from browser code, Node code, and the box itself.

export const SDK_VERSION = "0.5.0";
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
  /** Every game that's on tonight, this one included (SDK 0.4.0+ boxes). */
  games?: VenueGameLink[];
  /** A message from the staff for every game page ("Last call at 1:30"), if one is up. */
  announcement?: Announcement;
  /** Display modules on the box (menus, signage): not games, listed apart (SDK 0.5.0+). */
  modules?: VenueGameLink[];
  /** Where the venue is, if the staff set it (weather, sunset times). SDK 0.5.0+. */
  location?: VenueLocation;
  /** The venue's IANA time zone, e.g. "America/New_York". SDK 0.5.0+. */
  timezone?: string;
  /** Units the venue prefers. SDK 0.5.0+. */
  units?: "imperial" | "metric";
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
    /** This game's public origin, e.g. https://bingo.example.com */
    publicUrl?: string;
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

export const STANDARD_COMMANDS = ["create_room", "start", "pause", "resume", "next_round", "end", "confirm_claim", "reject_claim"] as const;
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
}

// ---------------------------------------------------------------- wiring

/** Environment variables the box sets on every game container. */
export const ENV = {
  gameId: "BG_GAME_ID",
  coreUrl: "BG_CORE_URL",
  token: "BG_GAME_TOKEN",
  publicUrl: "BG_PUBLIC_URL",
  dataDir: "BG_DATA_DIR",
} as const;

/** Reserved paths on every game hostname. */
export const PATHS = {
  venue: "/__bargames/venue.json",
  themeCss: "/__bargames/theme.css",
  command: "/__bargames/command",
  status: "/__bargames/status",
  pin: "/__bargames/pin",
} as const;

/** Headers the gateway adds to every proxied request. */
export const HEADERS = {
  via: "x-bargames-via",
  clientIp: "x-bargames-client-ip",
  access: "x-bargames-access",
} as const;

/** Why the gateway let a request in. */
export type AccessReason = "local" | "venue-ip" | "whitelist" | "pin";
