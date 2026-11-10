// The display driver contract. Every TV platform (Roku, Google TV/Cast, Apple TV,
// Samsung, …) implements DisplayDriver; the rest of the box only sees displays,
// groups and content.

/**
 * native-url: the TV opens the page itself (Cast receiver, kiosk browser). Exact sync, no encoding.
 * airplay:    the box renders + encodes and mirrors over AirPlay (doubletake).
 * roku-hls:   the box renders + encodes HLS; a sideloaded Roku app plays it.
 */
export type DeliveryMethod = "native-url" | "airplay" | "roku-hls" | "mock";

export interface DisplayDevice {
  /** Stable id: "<driver>:<serial/udn>". */
  id: string;
  driver: string;
  name: string;
  /** Base address the driver talks to, e.g. http://192.168.1.50:8060 */
  address: string;
  model?: string;
  isTv?: boolean;
  meta?: Record<string, unknown>;
}

export interface Capabilities {
  /** Supported deliveries, best first. */
  delivery: DeliveryMethod[];
  power: boolean;
  /** Inputs that setInput accepts, e.g. ["hdmi1","hdmi2","hdmi3","tuner"]. */
  inputs: string[];
}

export type DisplayContent =
  | { kind: "url"; url: string; title?: string }
  | { kind: "idle" }
  | { kind: "off" };

export interface ShowResult {
  ok: boolean;
  delivery?: DeliveryMethod;
  message?: string;
}

export interface Health {
  online: boolean;
  powerMode?: string;
  detail?: string;
}

export interface DisplayDriver {
  readonly id: string;
  discover(timeoutMs?: number): Promise<DisplayDevice[]>;
  capabilities(device: DisplayDevice): Promise<Capabilities>;
  power(device: DisplayDevice, on: boolean): Promise<void>;
  setInput(device: DisplayDevice, input: string): Promise<void>;
  show(device: DisplayDevice, content: DisplayContent, delivery: DeliveryMethod): Promise<ShowResult>;
  stop(device: DisplayDevice): Promise<void>;
  health(device: DisplayDevice): Promise<Health>;
  /** Optional one-time pairing (AirPlay PIN, ADB key, …). */
  pair?(device: DisplayDevice, input?: Record<string, string>): Promise<{ ok: boolean; message?: string }>;
}

/**
 * Turns a URL into a stream a TV can receive (renderer + encoder + sender).
 * Implemented in Phase 3 (Chromium per group → QuickSync → doubletake / HLS).
 */
export interface StreamService {
  startAirplay(device: DisplayDevice, content: { url: string }): Promise<ShowResult>;
  hlsUrl(content: { url: string }): Promise<string>;
  stopFor(deviceId: string): Promise<void>;
}

export class NotBuiltYet extends Error {}
