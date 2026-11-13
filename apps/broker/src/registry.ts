import type { JsonStore } from "@bargames/common";
import type { Capabilities, DeliveryMethod, DisplayContent, DisplayDevice, DisplayDriver, Health, ShowResult, StreamSettings, StreamState } from "./types.js";

export interface DisplayRecord extends DisplayDevice {
  /** Venue's own label, e.g. "Bar left". */
  label?: string;
  group?: string;
  /** Preferred delivery; defaults to the driver's best. */
  delivery?: DeliveryMethod;
  lastSeen?: string;
  content?: DisplayContent;
  /**
   * Box 0.15.2: the venue set this TV aside (it's at the other site, unplugged…). The box
   * leaves it alone: no health checks, no casting, no scenes or startup choices, not in
   * games' or integrations' TV lists. Its name, room, pairings and settings are kept.
   */
  ignored?: boolean;
}

export interface DisplayView extends DisplayRecord {
  capabilities?: Capabilities;
  /** TV apps the box can start on it (media providers). */
  launchable?: string[];
  health?: Health;
  stream?: StreamState;
}

/** The screen a TV shows while it pairs: self-contained, no network needed. */
export function pairingScreen(tvName: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><title>Pairing</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#101528;color:#f4f6ff;font:600 4vh system-ui,sans-serif;text-align:center">
<div><div style="font-size:9vh">&#128250;</div><p style="font-size:6vh;margin:2vh 0">${esc(tvName)} is connected</p>
<p style="opacity:.7">Bar Games box &middot; paired over AirPlay</p></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export type Target = { displayIds?: string[]; group?: string };

export class DisplayRegistry {
  constructor(
    private readonly store: JsonStore<{ displays: DisplayRecord[] }>,
    private readonly drivers: Map<string, DisplayDriver>,
  ) {}

  list(): DisplayRecord[] {
    return this.store.get().displays;
  }

  get(id: string): DisplayRecord | undefined {
    return this.list().find((d) => d.id === id);
  }

  driverFor(d: DisplayDevice): DisplayDriver {
    const drv = this.drivers.get(d.driver);
    if (!drv) throw new Error(`no driver ${d.driver}`);
    return drv;
  }

  /** Every TV with its live state. Ignored TVs are left out unless asked for, and never contacted. */
  async view(withHealth = false, includeIgnored = false): Promise<DisplayView[]> {
    return Promise.all(
      this.list()
        .filter((d) => includeIgnored || !d.ignored)
        .map(async (d) => {
        const drv = this.drivers.get(d.driver);
        if (!drv || d.ignored) return d;
        const [capabilities, health] = await Promise.all([drv.capabilities(d).catch(() => undefined), withHealth ? drv.health(d) : undefined]);
        return { ...d, capabilities, health, stream: drv.streamState?.(d), launchable: drv.launchableApps?.(d) ?? [] };
      }),
    );
  }

  /** Runs every driver's discovery and merges results (keeps venue labels/groups). */
  async discover(timeoutMs = 3000): Promise<{ found: number; errors: string[]; replaced: Record<string, string> }> {
    const errors: string[] = [];
    const found: DisplayDevice[] = [];
    await Promise.all(
      [...this.drivers.values()].map(async (drv) => {
        try {
          found.push(...(await drv.discover(timeoutMs)));
        } catch (err) {
          errors.push(`${drv.id}: ${String(err)}`);
        }
      }),
    );
    const kept = dropAirplayDuplicates(found, this.list());
    const replaced = await this.merge(kept);
    return { found: kept.length, errors, replaced };
  }

  /**
   * Adds or refreshes displays. A TV saved earlier as plain "AirPlay" that a native driver
   * now finds at the same address (a Vizio) becomes that driver's display: its name, room,
   * delivery, stream settings and content carry over. Returns old id → new id.
   */
  async merge(found: DisplayDevice[]): Promise<Record<string, string>> {
    found = dropAirplayDuplicates(found, this.list());
    const now = new Date().toISOString();
    const replaced: Record<string, string> = {};
    const before = this.list();
    await this.store.update((s) => {
      for (const dev of found) {
        const i = s.displays.findIndex((d) => d.id === dev.id);
        if (i >= 0) {
          s.displays[i] = { ...s.displays[i], ...dev, lastSeen: now };
          continue;
        }
        const host = hostOf(dev.address);
        const old = dev.driver !== "airplay" ? s.displays.find((d) => d.driver === "airplay" && hostOf(d.address) === host) : undefined;
        const carried: Partial<DisplayRecord> = {};
        if (old) {
          for (const k of ["label", "group", "delivery", "streamSettings", "content"] as const) if (old[k] != null) (carried as Record<string, unknown>)[k] = old[k];
          s.displays = s.displays.filter((d) => d !== old);
          replaced[old.id] = dev.id;
        }
        s.displays.push({ ...carried, ...dev, lastSeen: now });
      }
      s.displays.sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name));
    });
    // The old record's AirPlay session is keyed by its old id: end it, then resume under the new one.
    for (const [oldId, newId] of Object.entries(replaced)) {
      const old = before.find((d) => d.id === oldId);
      if (old && this.drivers.get("airplay")) await this.drivers.get("airplay")!.stop(old).catch(() => undefined);
      const cur = this.get(newId);
      if (cur?.content && playable(cur.content).kind === "url") await this.show({ displayIds: [newId] }, cur.content).catch(() => undefined);
    }
    return replaced;
  }

  async patch(id: string, patch: Partial<Pick<DisplayRecord, "label" | "group" | "delivery">> & { streamSettings?: StreamSettings | null }): Promise<DisplayRecord> {
    const cur = this.get(id);
    if (!cur) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    const { streamSettings, ...rest } = patch;
    const next: DisplayRecord = { ...cur, ...rest };
    if (streamSettings === null) delete next.streamSettings;
    else if (streamSettings) next.streamSettings = streamSettings;
    await this.store.update((s) => {
      s.displays = s.displays.map((d) => (d.id === id ? next : d));
    });
    // New settings take effect now on a TV that's casting: show its content again.
    if (streamSettings !== undefined && JSON.stringify(cur.streamSettings) !== JSON.stringify(next.streamSettings) && this.driverFor(next).streamState?.(next)) {
      if (next.content && playable(next.content).kind === "url") await this.show({ displayIds: [id] }, next.content).catch(() => undefined);
    }
    return next;
  }

  /**
   * Media providers: start a TV app. Stops whatever the box was casting to it first (an
   * AirPlay mirror would cover the app), then records what's showing so idle repaints skip it.
   */
  async launchApp(id: string, app: string, provider: string, title?: string): Promise<{ ok: true } | { ok: false; reason: "unsupported" | "offline" | "ecp-blocked" | "error"; message: string }> {
    const d = this.get(id);
    if (!d) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    const drv = this.driverFor(d);
    if (!drv.launchApp || !(drv.launchableApps?.(d) ?? []).includes(app)) return { ok: false, reason: "unsupported", message: `The box can't start ${app} on ${d.label || d.name}; open it on the TV yourself.` };
    if (drv.streamState?.(d)) await drv.stop(d).catch(() => undefined);
    const r = await drv.launchApp(d, app);
    if (r.ok) await this.setContent(id, { kind: "external", provider, app, ...(title ? { title } : {}) });
    return r;
  }

  /**
   * Media providers: record that a TV now shows an app (no launch needed). Stops what the box
   * was casting there: an AirPlay mirror left running reconnects and covers the app.
   */
  async markExternal(id: string, provider: string, app: string, title?: string): Promise<void> {
    const d = this.get(id);
    if (!d) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    const drv = this.driverFor(d);
    if (drv.streamState?.(d)) await drv.stop(d).catch(() => undefined);
    await this.setContent(id, { kind: "external", provider, app, ...(title ? { title } : {}) });
  }

  /** DIAL screen id of an app on this TV (memory-only cache, 10 minutes). */
  private readonly dialCache = new Map<string, { at: number; id?: string }>();
  async dialScreenId(id: string, app: string): Promise<string | undefined> {
    const d = this.get(id);
    if (!d) return undefined;
    const key = `${id}|${app}`;
    const hit = this.dialCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id;
    const screenId = await this.driverFor(d).dialScreenId?.(d, app).catch(() => undefined);
    this.dialCache.set(key, { at: Date.now(), id: screenId });
    return screenId;
  }

  /** Installed apps (cached a minute; the one on screen is always fresh). */
  private readonly appsCache = new Map<string, { at: number; apps: { id: string; name: string }[] }>();
  async listApps(id: string): Promise<{ apps: { id: string; name: string }[]; active?: string }> {
    const d = this.get(id);
    if (!d) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    const drv = this.driverFor(d);
    if (!drv.listApps) throw Object.assign(new Error(`${d.label || d.name} can't list its apps`), { status: 400 });
    const r = await drv.listApps(d);
    this.appsCache.set(id, { at: Date.now(), apps: r.apps });
    return r;
  }

  /** App icons, kept in memory (they rarely change). */
  private readonly iconCache = new Map<string, { type: string; data: Buffer } | null>();
  async appIcon(id: string, appId: string): Promise<{ type: string; data: Buffer } | undefined> {
    const d = this.get(id);
    if (!d) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    const key = `${id}|${appId}`;
    if (this.iconCache.has(key)) return this.iconCache.get(key) ?? undefined;
    const icon = await this.driverFor(d).appIcon?.(d, appId);
    if (this.iconCache.size > 500) this.iconCache.clear();
    this.iconCache.set(key, icon ?? null);
    return icon;
  }

  /** Starts an installed app from the remote: stops the box's cast first, then records it. */
  async launchChannel(id: string, appId: string): Promise<void> {
    const d = this.get(id);
    if (!d) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    const drv = this.driverFor(d);
    if (!drv.launchChannel) throw Object.assign(new Error(`${d.label || d.name} can't start apps`), { status: 400 });
    if (drv.streamState?.(d)) await drv.stop(d).catch(() => undefined);
    await drv.launchChannel(d, appId);
    const name = this.appsCache.get(id)?.apps.find((a) => a.id === appId)?.name ?? appId;
    await this.setContent(id, { kind: "external", provider: "remote", app: name });
  }

  /**
   * Switches the TV to one of its own inputs, or tunes its own tuner. Stops the box's cast
   * first (it would cover the input on a Roku), then records it so idle repaints leave it be.
   */
  async setInput(id: string, input: string): Promise<void> {
    const d = this.get(id);
    if (!d) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    const drv = this.driverFor(d);
    if (!(await drv.capabilities(d)).inputs.includes(input)) throw Object.assign(new Error(`${d.label || d.name} has no input "${input}" the box can switch to`), { status: 400 });
    if (drv.streamState?.(d)) await drv.stop(d).catch(() => undefined);
    await drv.setInput(d, input);
    await this.setContent(id, { kind: "external", provider: "remote", app: inputName(input) });
  }

  async tuneChannel(id: string, channel: string): Promise<void> {
    const d = this.get(id);
    if (!d) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    const drv = this.driverFor(d);
    if (!drv.tuneChannel || !(await drv.capabilities(d)).tvChannels) throw Object.assign(new Error(`${d.label || d.name} can't tune TV channels`), { status: 400 });
    if (drv.streamState?.(d)) await drv.stop(d).catch(() => undefined);
    await drv.tuneChannel(d, channel);
    await this.setContent(id, { kind: "external", provider: "remote", app: `Channel ${channel}` });
  }

  /** A small JPEG of what this TV is being sent, or undefined when it isn't casting. */
  async preview(id: string): Promise<Buffer | undefined> {
    const d = this.get(id);
    if (!d) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    return this.driverFor(d).preview?.(d);
  }

  /** Drops displays that no longer exist (a revoked Venuebox device, unplugged screens). */
  async removeMany(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const gone = new Set(ids);
    await this.store.update((s) => {
      s.displays = s.displays.filter((d) => !gone.has(d.id));
    });
  }

  /** Forgets a TV: stops whatever the box sends it (best effort), then drops its record. A later scan finds it again. */
  async remove(id: string): Promise<void> {
    const d = this.get(id);
    if (d) {
      try {
        const drv = this.driverFor(d);
        await drv.stop(d);
        await drv.forget?.(d);
      } catch {
        /* offline or unknown driver: forget it anyway */
      }
    }
    await this.store.update((s) => {
      s.displays = s.displays.filter((d) => d.id !== id);
    });
  }

  resolve(target: Target): DisplayRecord[] {
    if (target.displayIds?.length) return target.displayIds.map((id) => this.get(id)).filter((d): d is DisplayRecord => Boolean(d));
    if (target.group) return this.list().filter((d) => d.group === target.group && !d.ignored);
    return [];
  }

  /**
   * Ignore a TV, or stop ignoring it. Ignoring stops what the box casts to it and clears
   * what it should show, so nothing reconnects to it or puts it back after a restart.
   */
  async setIgnored(id: string, ignored: boolean): Promise<DisplayRecord> {
    const cur = this.get(id);
    if (!cur) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    if (ignored && !cur.ignored) await this.driverFor(cur).stop(cur).catch(() => undefined);
    await this.store.update((s) => {
      s.displays = s.displays.map((d) => {
        if (d.id !== id) return d;
        const next: DisplayRecord = { ...d, ignored: ignored || undefined };
        if (!ignored) delete next.ignored;
        if (ignored) delete next.content;
        return next;
      });
    });
    return this.get(id)!;
  }

  /**
   * Stops everything the box sends to every TV (ignored ones too): casts, the idle screen,
   * plugged-in screens. Doesn't power anything off or change inputs. What each TV showed is
   * cleared, so nothing comes back after a restart. Returns the TVs it stopped.
   */
  async detachAll(): Promise<{ stopped: string[]; failed: Record<string, string> }> {
    const stopped: string[] = [];
    const failed: Record<string, string> = {};
    await Promise.all(
      this.list().map(async (d) => {
        try {
          await this.driverFor(d).stop(d);
          stopped.push(d.id);
        } catch (err) {
          failed[d.id] = String(err);
        }
      }),
    );
    await this.store.update((s) => {
      s.displays = s.displays.map((d) => {
        const { content: _c, ...rest } = d;
        return rest;
      });
    });
    return { stopped, failed };
  }

  /** Shows content on every target display; each display uses its own best delivery. */
  async show(target: Target, content: DisplayContent): Promise<Record<string, ShowResult>> {
    const results: Record<string, ShowResult> = {};
    await Promise.all(
      this.resolve(target).map(async (d) => {
        if (d.ignored) return void (results[d.id] = { ok: false, message: `${d.label || d.name} is ignored (TVs page: Stop ignoring)` });
        try {
          const drv = this.driverFor(d);
          const delivery = d.delivery ?? (await drv.capabilities(d)).delivery[0];
          if (!delivery) return void (results[d.id] = { ok: false, message: "no delivery method available" });
          results[d.id] = await drv.show(d, playable(content), delivery);
          if (results[d.id].ok) await this.setContent(d.id, content);
        } catch (err) {
          results[d.id] = { ok: false, message: String(err) };
        }
      }),
    );
    return results;
  }

  /**
   * Pairing. Without a code: shows the pairing screen, which makes the TV ask for its
   * AirPlay code (or connects right away when it's already paired). With a code:
   * completes it. Either way, once connected the TV goes back to what it was showing.
   */
  async pair(id: string, code?: string): Promise<ShowResult & { paired?: boolean }> {
    const d = this.get(id);
    if (!d) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    const drv = this.driverFor(d);
    if (!drv.pair) return { ok: false, message: `${d.name} doesn't need pairing` };
    const r = code ? await drv.pair(d, code) : await drv.show(d, { kind: "url", url: pairingScreen(d.label || d.name) }, "airplay");
    if (r.ok && !r.message) {
      this.afterPairing(d.id);
      return { ...r, paired: true, message: code ? "Paired." : "Already paired: it connected without a code." };
    }
    return r;
  }

  /** TV-control pairing (Vizio): {} makes the TV show a PIN, { code } completes it. */
  async pairControl(id: string, code?: string): Promise<ShowResult> {
    const d = this.get(id);
    if (!d) throw Object.assign(new Error(`no display ${id}`), { status: 404 });
    const drv = this.driverFor(d);
    if (!drv.pairControl) return { ok: false, message: `${d.label || d.name} doesn't need pairing for control` };
    return drv.pairControl(d, code);
  }

  private afterPairing(id: string) {
    setTimeout(() => {
      const d = this.get(id);
      if (!d) return;
      const back = d.content && playable(d.content).kind === "url" ? this.show({ displayIds: [id] }, d.content) : this.driverFor(d).stop(d);
      void Promise.resolve(back).catch(() => undefined);
    }, 8000).unref?.();
  }

  /** After a restart: put every TV back on what it was showing. */
  async resume(): Promise<void> {
    for (const d of this.list()) {
      if (!d.ignored && d.content && playable(d.content).kind === "url") await this.show({ displayIds: [d.id] }, d.content).catch(() => undefined);
    }
  }

  private async setContent(id: string, content: DisplayContent) {
    await this.store.update((s) => {
      s.displays = s.displays.map((d) => (d.id === id ? { ...d, content } : d));
    });
  }
}

/** "hdmi2" → "HDMI 2", for what the TV shows. */
export function inputName(input: string): string {
  const m = /^hdmi-?(\d+)$/i.exec(input);
  if (m) return `HDMI ${m[1]}`;
  return ({ tuner: "Antenna", comp: "Composite", cast: "TV home", av: "AV", av1: "AV" } as Record<string, string>)[input.toLowerCase()] ?? input;
}

export const hostOf = (address: string): string | undefined => {
  try {
    return new URL(address).hostname;
  } catch {
    return undefined;
  }
};

/**
 * Rokus (and future native drivers) also advertise AirPlay. Keep the richer driver:
 * drop "airplay" devices whose IP belongs to a non-AirPlay display, found now or known.
 */
export function dropAirplayDuplicates(found: DisplayDevice[], known: DisplayDevice[]): DisplayDevice[] {
  const native = new Set([...found, ...known].filter((d) => d.driver !== "airplay").map((d) => hostOf(d.address)));
  return found.filter((d) => d.driver !== "airplay" || !native.has(hostOf(d.address)));
}

/** Drivers only stream pages: an idle screen with a page is streamed like any URL. */
export function playable(content: DisplayContent): DisplayContent {
  return content.kind === "idle" && content.url ? { kind: "url", url: content.url, title: content.title ?? "Idle" } : content;
}
