// Screens plugged straight into the box (HDMI / DisplayPort). SCAFFOLDING ONLY: it lists
// connected outputs (read-only, from /sys/class/drm) so they appear on the TVs page, but
// can't show anything yet. Design and decisions: docs/LOCAL-SCREENS.md.
//
// Enable with DRIVERS=roku,airplay,local. Off by default.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Capabilities, DeliveryMethod, DisplayContent, DisplayDevice, DisplayDriver, Health, ShowResult } from "../../types.js";
import { NotBuiltYet } from "../../types.js";

export interface Connector {
  /** e.g. "HDMI-A-1", "DP-2" */
  name: string;
  connected: boolean;
  /** Modes the screen reports (EDID), best first, e.g. ["3840x2160", "1920x1080"]. */
  modes: string[];
}

/** Reads DRM connectors from sysfs ("card0-HDMI-A-1/status" = "connected"). */
export function readConnectors(drmDir = "/sys/class/drm"): Connector[] {
  let entries: string[];
  try {
    entries = readdirSync(drmDir).sort();
  } catch {
    return []; // no DRM (container without the GPU, or not Linux)
  }
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8").trim();
    } catch {
      return "";
    }
  };
  return entries
    .filter((e) => /^card\d+-/.test(e))
    .map((e) => ({
      name: e.replace(/^card\d+-/, ""),
      connected: read(path.join(drmDir, e, "status")) === "connected",
      modes: [...new Set(read(path.join(drmDir, e, "modes")).split("\n").filter(Boolean))],
    }));
}

export class LocalScreenDriver implements DisplayDriver {
  readonly id = "local";

  constructor(private readonly drmDir = "/sys/class/drm") {}

  async discover(): Promise<DisplayDevice[]> {
    return readConnectors(this.drmDir)
      .filter((c) => c.connected)
      .map((c) => ({
        id: `local:${c.name}`,
        driver: this.id,
        name: `Screen on ${c.name}`,
        address: `drm:${c.name}`,
        model: c.modes[0] ? `up to ${c.modes[0]}` : undefined,
        isTv: true,
        meta: { connector: c.name, modes: c.modes },
      }));
  }

  async capabilities(): Promise<Capabilities> {
    // Power and inputs come with an HDMI-CEC adapter (per screen); not built yet.
    return { delivery: ["local" as DeliveryMethod], power: false, inputs: [] };
  }

  async power(): Promise<void> {
    throw new NotBuiltYet("plugged-in screens: power control (HDMI-CEC adapter) isn't built yet");
  }

  async setInput(): Promise<void> {
    throw new NotBuiltYet("plugged-in screens: input switching (HDMI-CEC adapter) isn't built yet");
  }

  async show(_device: DisplayDevice, content: DisplayContent): Promise<ShowResult> {
    if (content.kind === "off") return { ok: true };
    return { ok: false, message: "Plugged-in screens are listed but can't show anything yet (docs/LOCAL-SCREENS.md)." };
  }

  async stop(): Promise<void> {}

  async health(device: DisplayDevice): Promise<Health> {
    const c = readConnectors(this.drmDir).find((x) => `local:${x.name}` === device.id);
    return c?.connected ? { online: true } : { online: false, detail: "unplugged or switched off" };
  }
}
