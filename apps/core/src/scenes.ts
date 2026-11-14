// Scenes and scheduled sessions (SDK 0.9.0 box features).
//
// A scene is a saved set of TV actions plus optional extras ("Game night", "Closing time"),
// applied with one tap or on a schedule. A scheduled session starts a game room on TVs at a
// time ("Bingo every day at 8 PM"), with an optional countdown before it.

export type SceneAction =
  | { displayId: string; do: "game"; gameId: string }
  | { displayId: string; do: "media"; gameId: string; itemId: string }
  | { displayId: string; do: "idle" }
  | { displayId: string; do: "off" }
  /** TV control (needs the TV's remote: Roku, paired Vizio or Apple TV). */
  | { displayId: string; do: "power"; on: boolean }
  | { displayId: string; do: "input"; input: string }
  | { displayId: string; do: "app"; appId: string; appName?: string }
  | { displayId: string; do: "channel"; channel: string };

/** What a TV can do, as the broker reports it (capabilities). */
export interface TvCaps {
  power?: boolean;
  inputs?: string[];
  apps?: boolean;
  tvChannels?: boolean;
}

export const TV_CHANNEL = /^\d{1,4}(\.\d{1,3})?$/;
/** After a scene switches a TV on, its next step is retried this often while the TV wakes (about 12 s). */
export const WAKE_TRIES = 5;
export const WAKE_RETRY_MS = 3000;
export const TV_APP_ID = /^[A-Za-z0-9_.-]{1,100}$/;

export interface Scene {
  id: string;
  name: string;
  actions: SceneAction[];
  /** End every open room first (closing time). */
  endRooms?: boolean;
  /** Post (or replace) the staff announcement. */
  announcement?: { text: string; minutes?: number };
  /** Start a countdown. */
  countdown?: { label: string; minutes: number };
  /** Box 0.16.0: stop every sound the box is playing (music, apps, test sounds). */
  stopSound?: boolean;
  /** Box 0.16.0: take the staff announcement down. */
  clearAnnouncement?: boolean;
  /** Box 0.16.0: clear the lobby countdown. */
  clearCountdown?: boolean;
  /**
   * Box 0.16.0: a sequence. After this scene, apply another one this many minutes later
   * ("Last call" → 15 min → "Closing"). Kept in memory: a core restart drops a pending step.
   */
  next?: { sceneId: string; afterMinutes: number };
}

/**
 * Box 0.16.0: closing time. One time per night, Sunday night = 0 … Saturday night = 6
 * ("" = not that night). A time before 12:00 means after midnight, so Friday night "02:00"
 * runs early Saturday. At that time the box applies `sceneId` (and its sequence, if any).
 */
export interface ClosingSettings {
  enabled: boolean;
  sceneId?: string;
  nights: string[];
}
export const DEFAULT_CLOSING: ClosingSettings = { enabled: false, nights: ["", "", "", "", "", "", ""] };

export function cleanClosing(v: unknown, sceneExists: (id: string) => boolean): ClosingSettings | string {
  if (typeof v !== "object" || v === null) return "closing: { enabled, sceneId, nights: [7 × \"HH:MM\" or \"\"] }";
  const c = v as Record<string, unknown>;
  const nights = Array.isArray(c.nights) ? (c.nights as unknown[]).map((t) => (typeof t === "string" ? t.trim() : "")) : [];
  if (nights.length !== 7) return "nights: 7 entries, Sunday night first";
  for (const t of nights) if (t && !HHMM.test(t)) return `nights: "${t}" isn't HH:MM (24-hour)`;
  const enabled = c.enabled === true;
  const sceneId = typeof c.sceneId === "string" && c.sceneId ? c.sceneId : undefined;
  if (sceneId && !sceneExists(sceneId)) return "sceneId: a saved scene";
  if (enabled && !sceneId) return "pick the scene to run at closing time";
  if (enabled && !nights.some(Boolean)) return "set a closing time for at least one night";
  return { enabled, ...(sceneId ? { sceneId } : {}), nights };
}

/** Closing time as ordinary scene schedules (the scheduler runs them like any other). */
export function closingSchedules(c: ClosingSettings | undefined): Schedule[] {
  if (!c?.enabled || !c.sceneId) return [];
  return c.nights.flatMap((time, night) =>
    time ? [{ id: `closing-${night}`, kind: "scene" as const, sceneId: c.sceneId, days: [time < "12:00" ? (night + 1) % 7 : night], time, enabled: true }] : [],
  );
}

export interface Schedule {
  id: string;
  /** "game": a new room on the TVs. "scene": apply a scene. */
  kind: "game" | "scene";
  gameId?: string;
  sceneId?: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** "HH:MM", 24-hour, venue time. */
  time: string;
  displayIds?: string[];
  group?: string;
  title?: string;
  /** Start a countdown this many minutes before (game sessions). */
  countdownMinutes?: number;
  enabled: boolean;
}

const ID = /^[a-z0-9-]{1,40}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function cleanScene(v: unknown, exists: { game: (id: string) => boolean; display: (id: string) => boolean; caps?: (id: string) => TvCaps | undefined; scene?: (id: string) => boolean }): Scene | string {
  if (typeof v !== "object" || v === null) return "scene: { id, name, actions, endRooms?, announcement?, countdown? }";
  const s = v as Record<string, unknown>;
  const id = typeof s.id === "string" && ID.test(s.id) ? s.id : undefined;
  const name = typeof s.name === "string" ? s.name.trim().slice(0, 40) : "";
  if (!id) return "id: lowercase letters, digits, dashes";
  if (!name) return "name required";
  if (!Array.isArray(s.actions) || s.actions.length > 64) return "actions: up to 64";
  const actions: SceneAction[] = [];
  for (const a of s.actions as Record<string, unknown>[]) {
    const displayId = typeof a?.displayId === "string" ? a.displayId : "";
    if (!displayId || !exists.display(displayId)) return `unknown TV ${displayId}`;
    const caps = exists.caps?.(displayId) ?? {};
    if (a.do === "idle" || a.do === "off") actions.push({ displayId, do: a.do });
    else if (a.do === "power") {
      if (!caps.power) return `${displayId} can't be switched on or off by the box (pair its TV control first?)`;
      actions.push({ displayId, do: "power", on: a.on === true });
    } else if (a.do === "input") {
      if (typeof a.input !== "string" || !(caps.inputs ?? []).includes(a.input)) return `${displayId} has no input ${String(a.input)} the box can switch to`;
      actions.push({ displayId, do: "input", input: a.input });
    } else if (a.do === "app") {
      if (!caps.apps) return `${displayId} can't open apps from the box (pair its TV control first?)`;
      if (typeof a.appId !== "string" || !TV_APP_ID.test(a.appId)) return `app for ${displayId}: an app id from the TV's app list`;
      actions.push({ displayId, do: "app", appId: a.appId, ...(typeof a.appName === "string" && a.appName.trim() ? { appName: a.appName.trim().slice(0, 60) } : {}) });
    } else if (a.do === "channel") {
      if (!caps.tvChannels) return `${displayId} can't tune TV channels`;
      const channel = typeof a.channel === "string" ? a.channel.trim() : "";
      if (!TV_CHANNEL.test(channel)) return "channel: like 7 or 7.1";
      actions.push({ displayId, do: "channel", channel });
    }
    else if (a.do === "game" && typeof a.gameId === "string" && exists.game(a.gameId)) actions.push({ displayId, do: "game", gameId: a.gameId });
    else if (a.do === "media" && typeof a.gameId === "string" && exists.game(a.gameId) && typeof a.itemId === "string" && a.itemId) actions.push({ displayId, do: "media", gameId: a.gameId, itemId: a.itemId });
    else return `action for ${displayId}: do game | media | idle | off | power | input | app | channel`;
  }
  const out: Scene = { id, name, actions };
  if (s.endRooms === true) out.endRooms = true;
  const ann = s.announcement as Record<string, unknown> | undefined;
  if (ann && typeof ann.text === "string" && ann.text.trim()) {
    const minutes = ann.minutes === undefined ? undefined : Number(ann.minutes);
    if (minutes !== undefined && !(minutes >= 1 && minutes <= 1440)) return "announcement.minutes: 1-1440";
    out.announcement = { text: ann.text.trim().replace(/\s+/g, " ").slice(0, 200), ...(minutes ? { minutes } : {}) };
  }
  const cd = s.countdown as Record<string, unknown> | undefined;
  if (cd && typeof cd.label === "string" && cd.label.trim()) {
    const minutes = Number(cd.minutes);
    if (!(minutes >= 0.25 && minutes <= 180)) return "countdown.minutes: 0.25-180";
    out.countdown = { label: cd.label.trim().slice(0, 60), minutes };
  }
  if (s.stopSound === true) out.stopSound = true;
  if (s.clearAnnouncement === true && !out.announcement) out.clearAnnouncement = true;
  if (s.clearCountdown === true && !out.countdown) out.clearCountdown = true;
  const next = s.next as Record<string, unknown> | undefined;
  if (next && typeof next === "object") {
    const after = Number(next.afterMinutes);
    if (typeof next.sceneId !== "string" || !next.sceneId) return "next.sceneId: the scene to apply next";
    if (next.sceneId === id) return "next: a scene can't follow itself";
    if (!(after >= 1 && after <= 240)) return "next.afterMinutes: 1-240";
    if (exists.scene && !exists.scene(next.sceneId)) return "next.sceneId: a saved scene";
    out.next = { sceneId: next.sceneId, afterMinutes: Math.round(after) };
  }
  return out;
}

/**
 * The built-in "Closing time" preset: end rooms, stop the music, say goodnight. Box 0.16.0:
 * it leaves the TVs alone (a TV may be on something else, like an Apple TV); add TV steps
 * in a scene of your own.
 */
export function closingTimeScene(_displayIds: string[] = []): Scene {
  return {
    id: "closing-time",
    name: "Closing time",
    endRooms: true,
    stopSound: true,
    clearCountdown: true,
    announcement: { text: "We're closing. Thanks for playing, see you next time!", minutes: 60 },
    actions: [],
  };
}

export function cleanSchedule(v: unknown, exists: { game: (id: string) => boolean; scene: (id: string) => boolean }): Schedule | string {
  if (typeof v !== "object" || v === null) return "schedule: { id, kind, days, time, … }";
  const s = v as Record<string, unknown>;
  const id = typeof s.id === "string" && ID.test(s.id) ? s.id : undefined;
  if (!id) return "id: lowercase letters, digits, dashes";
  if (s.kind !== "game" && s.kind !== "scene") return "kind: game or scene";
  const days = Array.isArray(s.days) ? [...new Set((s.days as unknown[]).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  if (!days.length) return "days: at least one of 0-6 (Sunday = 0)";
  if (typeof s.time !== "string" || !HHMM.test(s.time)) return "time: HH:MM (24-hour)";
  const out: Schedule = { id, kind: s.kind, days, time: s.time, enabled: s.enabled !== false };
  if (s.kind === "game") {
    if (typeof s.gameId !== "string" || !exists.game(s.gameId)) return "gameId: an installed game";
    out.gameId = s.gameId;
    if (Array.isArray(s.displayIds) && s.displayIds.length) out.displayIds = (s.displayIds as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 64);
    else if (typeof s.group === "string" && s.group.trim()) out.group = s.group.trim();
    else return "pick the TVs (displayIds) or a group";
    if (typeof s.title === "string" && s.title.trim()) out.title = s.title.trim().slice(0, 60);
    if (s.countdownMinutes !== undefined) {
      const m = Number(s.countdownMinutes);
      if (!(m >= 1 && m <= 120)) return "countdownMinutes: 1-120";
      out.countdownMinutes = m;
    }
  } else {
    if (typeof s.sceneId !== "string" || !exists.scene(s.sceneId)) return "sceneId: a saved scene";
    out.sceneId = s.sceneId;
  }
  return out;
}

/** The venue's local weekday and "HH:MM" right now. */
export function localNow(now: Date, timeZone = "UTC"): { day: number; time: string; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { day, time: `${parts.hour}:${parts.minute}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

/** "20:00" minus 5 minutes → "19:55" (same day; earlier than 00:00 isn't supported). */
export function minusMinutes(time: string, minutes: number): string | undefined {
  const [h, m] = time.split(":").map(Number);
  const t = h * 60 + m - Math.round(minutes);
  return t < 0 ? undefined : `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** What's due at this minute: schedules starting now, and countdowns to start now. */
export function dueNow(schedules: Schedule[], now: Date, timeZone: string | undefined, fired: Record<string, string>): { start: Schedule[]; countdown: Schedule[] } {
  const { day, time, date } = localNow(now, timeZone);
  const start: Schedule[] = [];
  const countdown: Schedule[] = [];
  for (const s of schedules) {
    if (!s.enabled || !s.days.includes(day)) continue;
    if (s.time === time && fired[`${s.id}|start`] !== date) start.push(s);
    if (s.kind === "game" && s.countdownMinutes && minusMinutes(s.time, s.countdownMinutes) === time && fired[`${s.id}|countdown`] !== date) countdown.push(s);
  }
  return { start, countdown };
}
