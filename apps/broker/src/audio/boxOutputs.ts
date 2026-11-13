// The box's own sound outputs (headphone jack, HDMI/DisplayPort), from `aplay -l`.
// (Docker hides /proc/asound inside containers; aplay asks the devices in /dev/snd.)

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { OutputTarget } from "./types.js";

/**
 * `aplay -l` → playback devices worth offering. Lines look like
 *   card 0: sofhdadsp [sof-hda-dsp], device 0: HDA Analog (*) []
 *   card 0: sofhdadsp [sof-hda-dsp], device 3: HDMI1 (*) [HDMI 1]
 * Duplicate "Deep Buffer" devices are left out (aplay -l lists playback devices only).
 */
export function parseAplayList(text: string, screenPresent: boolean): OutputTarget[] {
  const out: OutputTarget[] = [];
  let hdmi = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = /^card (\d+): [^,]*, device (\d+): (.*?)\s*\[[^\]]*\]\s*$/.exec(line.trim());
    if (!m) continue;
    const [, card, dev, rawName] = m;
    const name = rawName.replace(/\s*\(\*\)\s*$/, "").trim();
    if (/deep ?buffer/i.test(name)) continue;
    const c = Number(card);
    const d = Number(dev);
    const isHdmi = /hdmi|displayport|\bdp\b/i.test(name);
    if (isHdmi) hdmi += 1;
    out.push({
      id: `box:${c}-${d}`,
      kind: "box",
      name: isHdmi ? `Box HDMI/DisplayPort ${hdmi}` : /analog|headphone|line/i.test(name) ? "Box headphone jack" : `Box ${name}`,
      address: `plughw:${c},${d}`,
      available: isHdmi ? screenPresent : true,
      detail: isHdmi ? (screenPresent ? "A screen plugged into the box plays the sound" : "No screen is plugged into the box") : "The box's own audio jack (to an amplifier or powered speakers)",
    });
  }
  return out;
}

/** True when a screen is plugged into the box (a DRM HDMI/DP connector reports "connected"). */
export function screenPresent(drm = "/sys/class/drm"): boolean {
  try {
    return readdirSync(drm)
      .filter((n) => /-(HDMI|DP)-/.test(n))
      .some((n) => {
        try {
          return readFileSync(path.join(drm, n, "status"), "utf8").trim() === "connected";
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

let cache: { at: number; list: OutputTarget[] } | undefined;

/** The box's outputs, re-read at most every 10 s (aplay -l takes a moment). */
export function boxOutputs(): OutputTarget[] {
  if (cache && Date.now() - cache.at < 10_000) return cache.list;
  let list: OutputTarget[] = [];
  try {
    list = parseAplayList(execFileSync("aplay", ["-l"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }), screenPresent());
  } catch {
    // no sound hardware visible ("no soundcards found")
  }
  cache = { at: Date.now(), list };
  return list;
}
