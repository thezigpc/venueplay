import type { JsonStore } from "@bargames/common";
import type { Capabilities, DeliveryMethod, DisplayContent, DisplayDevice, DisplayDriver, Health, ShowResult } from "./types.js";

export interface DisplayRecord extends DisplayDevice {
  /** Venue's own label, e.g. "Bar left". */
  label?: string;
  group?: string;
  /** Preferred delivery; defaults to the driver's best. */
  delivery?: DeliveryMethod;
  lastSeen?: string;
  content?: DisplayContent;
}

export interface DisplayView extends DisplayRecord {
  capabilities?: Capabilities;
  health?: Health;
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

  async view(withHealth = false): Promise<DisplayView[]> {
    return Promise.all(
      this.list().map(async (d) => {
        const drv = this.drivers.get(d.driver);
        if (!drv) return d;
        const [capabilities, health] = await Promise.all([drv.capabilities(d).catch(() => undefined), withHealth ? drv.health(d) : undefined]);
        return { ...d, capabilities, health };
      }),
    );
  }

  /** Runs every driver's discovery and merges results (keeps venue labels/groups). */
  async discover(timeoutMs = 3000): Promise<{ found: number; errors: string[] }> {
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
    await this.merge(found);
    return { found: found.length, errors };
  }

  async merge(found: DisplayDevice[]): Promise<void> {
    const now = new Date().toISOString();
    await this.store.update((s) => {
      for (const dev of found) {
        const i = s.displays.findIndex((d) => d.id === dev.id);
        if (i >= 0) s.displays[i] = { ...s.displays[i], ...dev, lastSeen: now };
        else s.displays.push({ ...dev, lastSeen: now });
      }
      s.displays.sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name));
    });
  }

  async patch(id: string, patch: Partial<Pick<DisplayRecord, "label" | "group" | "delivery">>): Promise<DisplayRecord> {
    const cur = this.get(id);
    if (!cur) throw new Error(`no display ${id}`);
    const next = { ...cur, ...patch };
    await this.store.update((s) => {
      s.displays = s.displays.map((d) => (d.id === id ? next : d));
    });
    return next;
  }

  async remove(id: string): Promise<void> {
    await this.store.update((s) => {
      s.displays = s.displays.filter((d) => d.id !== id);
    });
  }

  resolve(target: Target): DisplayRecord[] {
    if (target.displayIds?.length) return target.displayIds.map((id) => this.get(id)).filter((d): d is DisplayRecord => Boolean(d));
    if (target.group) return this.list().filter((d) => d.group === target.group);
    return [];
  }

  /** Shows content on every target display; each display uses its own best delivery. */
  async show(target: Target, content: DisplayContent): Promise<Record<string, ShowResult>> {
    const results: Record<string, ShowResult> = {};
    await Promise.all(
      this.resolve(target).map(async (d) => {
        try {
          const drv = this.driverFor(d);
          const delivery = d.delivery ?? (await drv.capabilities(d)).delivery[0];
          if (!delivery) return void (results[d.id] = { ok: false, message: "no delivery method available" });
          results[d.id] = await drv.show(d, content, delivery);
          if (results[d.id].ok) await this.setContent(d.id, content);
        } catch (err) {
          results[d.id] = { ok: false, message: String(err) };
        }
      }),
    );
    return results;
  }

  private async setContent(id: string, content: DisplayContent) {
    await this.store.update((s) => {
      s.displays = s.displays.map((d) => (d.id === id ? { ...d, content } : d));
    });
  }
}
