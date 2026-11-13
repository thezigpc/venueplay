// The box's sound outputs and what's playing on them (Settings → Connected devices).

/** box: the box's own jack or HDMI. bluetooth: a paired speaker. tv: a TV or speaker over AirPlay. */
export type OutputKind = "box" | "bluetooth" | "tv";

export interface OutputTarget {
  id: string;
  kind: OutputKind;
  /** What the hardware or the TV calls itself. */
  name: string;
  /** box: ALSA device ("plughw:0,3"). bluetooth: the speaker's address. tv: the TV's IP/host. */
  address: string;
  /** False when it can't play now (speaker not paired any more, TV gone). */
  available: boolean;
  detail?: string;
}

export interface OutputView extends OutputTarget {
  /** The venue's name for it, if they gave one. */
  label?: string;
  volume: number;
  default: boolean;
  session?: SessionView;
}

export type SessionState = "starting" | "playing" | "paused" | "ended" | "error";

export interface TrackInfo {
  title?: string;
  artist?: string;
  album?: string;
  /** Length, when the app knows it (shown as progress). */
  durationMs?: number;
}

export interface SessionView extends TrackInfo {
  id: string;
  output: string;
  /** Who started it: "app:<id>", "admin" (test sound). */
  owner: string;
  state: SessionState;
  positionMs: number;
  startedAt: string;
  endedAt?: string;
  /** Why it ended or failed, in plain words. */
  message?: string;
}

/** Saved per box (data/broker/audio.json). */
export interface AudioSettings {
  defaultOutput?: string;
  volumes: Record<string, number>;
  labels: Record<string, string>;
}

export const DEFAULT_VOLUME = 60;
