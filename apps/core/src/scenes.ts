// Scenes and scheduled sessions (SDK 0.9.0 box features).
//
// A scene is a saved set of TV actions plus optional extras ("Game night", "Closing time"),
// applied with one tap or on a schedule. A scheduled session starts a game room on TVs at a
// time ("Bingo every day at 8 PM"), with an optional countdown before it.

/**
 * Box 0.20.0: after a game step, where its host controls go. "open": the device that
 * applied the scene opens them; "ask": it offers a button first. Scenes run by a schedule,
 * closing time or Home Assistant post a "Host it" item on Tonight instead.
 */
export type HostMode = "open" | "ask";

/**
 * Box 0.26.0: a scene is a list of steps, run top to bottom. A TV step acts on one or more
 * TVs at once (in parallel: "turn on every TV"); a game step on several TVs is one room
 * shown on all of them. Waits and the extras (end rooms, announcement, countdown, sound) are
 * steps too, so they go anywhere in the order.
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
  /** End every open room (closing time). */
  | { do: "endRooms" }
  /** Post (or replace) the staff announcement. */
  | { do: "announce"; text: string; minutes?: number }
  | { do: "clearAnnouncement" }
  /** Start the lobby countdown. */
  | { do: "countdown"; label: string; minutes: number }
  | { do: "clearCountdown" }
  /** Stop every sound the box is playing (music, apps, test sounds). */
  | { do: "stopSound" };
export type TvStep = Extract<SceneStep, { tvs: string[] }>;
export const isTvStep = (s: SceneStep): s is TvStep => "tvs" in s;

/** Before box 0.26.0: one TV per action, with the extras as scene flags (still accepted, converted). */
export type SceneAction =
  | { displayId: string; do: "game"; gameId: string; host?: HostMode }
  | { displayId: ""; do: "wait"; seconds: number }
  | { displayId: string; do: "media"; gameId: string; itemId: string }
  | { displayId: string; do: "idle" }
  | { displayId: string; do: "off" }
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
/** Box 0.20.0: one wait step, and all of a scene's waits together. */
export const MAX_WAIT_SECONDS = 600;
export const MAX_TOTAL_WAIT_SECONDS = 1800;
/** Does applying this scene take a while (waits)? */
export const sceneRunsLong = (s: Scene) => s.steps.some((a) => a.do === "wait");

export interface Scene {
  id: string;
  name: string;
  /** Box 0.26.0: what the scene does, in order. */
  steps: SceneStep[];
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

const sameStep = (a: SceneStep, b: SceneStep) => {
  if (!isTvStep(a) || !isTvStep(b) || a.do !== b.do || a.do === "game" || a.do === "media") return false;
  const { tvs: _a, ...x } = a;
  const { tvs: _b, ...y } = b;
  return JSON.stringify(x) === JSON.stringify(y);
};

/**
 * Box 0.26.0: a scene saved before steps (one TV per action, extras as flags) as steps, in
 * the order it always ran: end rooms, announcement, countdown, clears, sound, then the TVs.
 * Back-to-back identical TV actions (power on tv1, power on tv2) become one step on both.
 * Game actions stay one per TV: each had its own room.
 */
export function upgradeScene(v: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(v.steps) || !Array.isArray(v.actions)) return v;
  const { actions, endRooms, announcement, countdown, clearAnnouncement, clearCountdown, stopSound, ...rest } = v as Record<string, unknown> & { actions: Record<string, unknown>[] };
  const steps: Record<string, unknown>[] = [];
  if (endRooms === true) steps.push({ do: "endRooms" });
  const ann = announcement as { text?: unknown; minutes?: unknown } | undefined;
  if (ann && typeof ann.text === "string" && ann.text.trim()) steps.push({ do: "announce", text: ann.text, ...(ann.minutes !== undefined ? { minutes: ann.minutes } : {}) });
  const cd = countdown as { label?: unknown; minutes?: unknown } | undefined;
  if (cd && typeof cd.label === "string" && cd.label.trim()) steps.push({ do: "countdown", label: cd.label, minutes: cd.minutes });
  if (clearAnnouncement === true && !steps.some((x) => x.do === "announce")) steps.push({ do: "clearAnnouncement" });
  if (clearCountdown === true && !steps.some((x) => x.do === "countdown")) steps.push({ do: "clearCountdown" });
  if (stopSound === true) steps.push({ do: "stopSound" });
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    if (a.do === "wait") {
      steps.push({ do: "wait", seconds: a.seconds });
      continue;
    }
    const { displayId, ...step } = a;
    const next = { ...step, tvs: [displayId] };
    const last = steps[steps.length - 1];
    if (last && Array.isArray(last.tvs) && sameStep(last as SceneStep, next as SceneStep) && !(last.tvs as unknown[]).includes(displayId)) (last.tvs as unknown[]).push(displayId);
    else steps.push(next);
  }
  return { ...rest, steps };
}

/** A saved scene, whatever box wrote it. */
export const sceneOf = (v: Scene | Record<string, unknown>): Scene => upgradeScene(v as Record<string, unknown>) as unknown as Scene;

export function cleanScene(v: unknown, exists: { game: (id: string) => boolean; display: (id: string) => boolean; caps?: (id: string) => TvCaps | undefined; scene?: (id: string) => boolean }): Scene | string {
  if (typeof v !== "object" || v === null) return "scene: { id, name, steps, next? }";
  const s = upgradeScene(v as Record<string, unknown>);
  const id = typeof s.id === "string" && ID.test(s.id) ? s.id : undefined;
  const name = typeof s.name === "string" ? s.name.trim().slice(0, 40) : "";
  if (!id) return "id: lowercase letters, digits, dashes";
  if (!name) return "name required";
  if (!Array.isArray(s.steps) || s.steps.length > 64) return "steps: up to 64";
  const steps: SceneStep[] = [];
  let waited = 0;
  for (const a of s.steps as Record<string, unknown>[]) {
    if (typeof a !== "object" || a === null) return "steps: objects with a \"do\"";
    if (a.do === "wait") {
      const seconds = Math.round(Number(a.seconds));
      if (!(seconds >= 1 && seconds <= MAX_WAIT_SECONDS)) return `wait: 1-${MAX_WAIT_SECONDS} seconds (longer: a sequence, "then apply a scene N minutes later")`;
      waited += seconds;
      if (waited > MAX_TOTAL_WAIT_SECONDS) return `waits: ${MAX_TOTAL_WAIT_SECONDS / 60} minutes in all at most`;
      steps.push({ do: "wait", seconds });
      continue;
    }
    if (a.do === "endRooms" || a.do === "clearAnnouncement" || a.do === "clearCountdown" || a.do === "stopSound") {
      steps.push({ do: a.do });
      continue;
    }
    if (a.do === "announce") {
      const text = typeof a.text === "string" ? a.text.trim().replace(/\s+/g, " ").slice(0, 200) : "";
      if (!text) return "announcement: the text to show";
      const minutes = a.minutes === undefined || a.minutes === null || a.minutes === "" ? undefined : Number(a.minutes);
      if (minutes !== undefined && !(minutes >= 1 && minutes <= 1440)) return "announcement.minutes: 1-1440";
      steps.push({ do: "announce", text, ...(minutes ? { minutes } : {}) });
      continue;
    }
    if (a.do === "countdown") {
      const label = typeof a.label === "string" ? a.label.trim().slice(0, 60) : "";
      const minutes = Number(a.minutes);
      if (!label) return "countdown: a label (\"Bingo starts\")";
      if (!(minutes >= 0.25 && minutes <= 180)) return "countdown.minutes: 0.25-180";
      steps.push({ do: "countdown", label, minutes });
      continue;
    }
    const tvs = [...new Set((Array.isArray(a.tvs) ? (a.tvs as unknown[]) : []).filter((t): t is string => typeof t === "string" && t.length > 0))];
    if (!tvs.length) return `${String(a.do)}: pick at least one TV`;
    if (tvs.length > 64) return "a step: 64 TVs at most";
    for (const t of tvs) if (!exists.display(t)) return `unknown TV ${t}`;
    const caps = (t: string) => exists.caps?.(t) ?? {};
    if (a.do === "idle" || a.do === "off") steps.push({ do: a.do, tvs });
    else if (a.do === "power") {
      const bad = tvs.find((t) => !caps(t).power);
      if (bad) return `${bad} can't be switched on or off by the box (pair its TV control first?)`;
      steps.push({ do: "power", tvs, on: a.on === true });
    } else if (a.do === "input") {
      const bad = tvs.find((t) => typeof a.input !== "string" || !(caps(t).inputs ?? []).includes(a.input));
      if (bad) return `${bad} has no input ${String(a.input)} the box can switch to`;
      steps.push({ do: "input", tvs, input: a.input as string });
    } else if (a.do === "app") {
      const bad = tvs.find((t) => !caps(t).apps);
      if (bad) return `${bad} can't open apps from the box (pair its TV control first?)`;
      if (typeof a.appId !== "string" || !TV_APP_ID.test(a.appId)) return `app for ${tvs.join(", ")}: an app id from the TV's app list`;
      steps.push({ do: "app", tvs, appId: a.appId, ...(typeof a.appName === "string" && a.appName.trim() ? { appName: a.appName.trim().slice(0, 60) } : {}) });
    } else if (a.do === "channel") {
      const bad = tvs.find((t) => !caps(t).tvChannels);
      if (bad) return `${bad} can't tune TV channels`;
      const channel = typeof a.channel === "string" ? a.channel.trim() : "";
      if (!TV_CHANNEL.test(channel)) return "channel: like 7 or 7.1";
      steps.push({ do: "channel", tvs, channel });
    } else if (a.do === "game" && typeof a.gameId === "string" && exists.game(a.gameId)) steps.push({ do: "game", tvs, gameId: a.gameId, ...(a.host === "open" || a.host === "ask" ? { host: a.host } : {}) });
    else if (a.do === "media" && typeof a.gameId === "string" && exists.game(a.gameId) && typeof a.itemId === "string" && a.itemId) steps.push({ do: "media", tvs, gameId: a.gameId, itemId: a.itemId });
    else return `step for ${tvs.join(", ")}: do game | media | idle | off | power | input | app | channel | wait | endRooms | announce | clearAnnouncement | countdown | clearCountdown | stopSound`;
  }
  const out: Scene = { id, name, steps };
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
    steps: [{ do: "endRooms" }, { do: "announce", text: "We're closing. Thanks for playing, see you next time!", minutes: 60 }, { do: "clearCountdown" }, { do: "stopSound" }],
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
