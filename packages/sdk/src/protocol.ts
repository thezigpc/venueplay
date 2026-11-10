// The contract between a game and the Bar Games box. Everything here is plain data,
// safe to import from browser code, Node code, and the box itself.

export const SDK_VERSION = "0.1.0";
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
  /** The venue landing page, e.g. https://play.example.com */
  playUrl?: string;
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

export const STANDARD_COMMANDS = ["start", "pause", "resume", "next_round", "end"] as const;
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

export interface RoomSummary {
  code: string;
  kind: SessionKind;
  players: number;
  phase?: string;
  title?: string;
  hostConnected?: boolean;
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
