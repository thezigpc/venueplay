// TV startup rules: what each TV shows when the BOX boots ("the patio TV starts on the
// menu"). Core restarts on every deploy, so rules only run when the machine itself has
// just booted (host uptime, which containers share). TVs often come up after the box
// (still powering on, joining Wi-Fi), so for a while after boot each TV gets its rule
// the first time it's seen online.

import type { Logger } from "@bargames/common";

export type StartupRule =
  /** The default: the broker puts back whatever the TV was showing. */
  | { mode: "last" }
  | { mode: "idle" }
  /** Leave the TV alone (nothing cast). */
  | { mode: "off" }
  /** A game (new venue room on this TV) or a menu/display module. */
  | { mode: "game"; gameId: string };

export function checkStartupRule(r: unknown, gameExists: (id: string) => boolean): string | undefined {
  if (typeof r !== "object" || r === null) return "rule: { mode: last | idle | off | game, gameId? }";
  const v = r as Record<string, unknown>;
  if (v.mode === "last" || v.mode === "idle" || v.mode === "off") return undefined;
  if (v.mode === "game") return typeof v.gameId === "string" && gameExists(v.gameId) ? undefined : "gameId: an installed game or menu";
  return "mode: last, idle, off or game";
}

/** The box booted this recently (seconds of host uptime when core started): run startup rules. */
export const BOOT_WINDOW_SEC = 10 * 60;

export interface StartupDeps {
  rules: () => Record<string, StartupRule>;
  /** TVs and whether they answer right now. */
  displays: () => Promise<{ id: string; online: boolean }[]>;
  apply: (displayId: string, rule: StartupRule) => Promise<void>;
  log: Logger;
}

export class StartupRunner {
  private pending = new Map<string, number>(); // displayId → failed attempts
  private timer?: ReturnType<typeof setInterval>;
  private until = 0;

  constructor(
    private d: StartupDeps,
    private o: { windowMs?: number; intervalMs?: number; maxAttempts?: number } = {},
  ) {}

  /** Starts watching: every TV with a rule other than "last" gets it once it's online. */
  start(): void {
    this.pending = new Map(
      Object.entries(this.d.rules())
        .filter(([, r]) => r.mode !== "last")
        .map(([id]) => [id, 0]),
    );
    if (!this.pending.size) return;
    this.until = Date.now() + (this.o.windowMs ?? 30 * 60_000);
    this.d.log.info("startup", "applying TV startup choices", { tvs: [...this.pending.keys()] });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.o.intervalMs ?? 20_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get waiting(): string[] {
    return [...this.pending.keys()];
  }

  /** One pass: apply rules to TVs that are online now. */
  async tick(): Promise<void> {
    if (!this.pending.size || Date.now() > this.until) {
      if (this.pending.size) this.d.log.warn("startup", "gave up on TVs that never came online", { tvs: this.waiting });
      this.pending.clear();
      return this.stop();
    }
    const online = new Set((await this.d.displays().catch(() => [])).filter((x) => x.online).map((x) => x.id));
    const rules = this.d.rules();
    for (const [id, attempts] of [...this.pending]) {
      const rule = rules[id];
      if (!rule || rule.mode === "last") {
        this.pending.delete(id);
        continue;
      }
      if (!online.has(id)) continue;
      try {
        await this.d.apply(id, rule);
        this.pending.delete(id);
        this.d.log.info("startup", "TV started", { tv: id, rule });
      } catch (err) {
        const n = attempts + 1;
        if (n >= (this.o.maxAttempts ?? 5)) {
          this.pending.delete(id);
          this.d.log.warn("startup", "TV startup failed", { tv: id, rule, err: String(err) });
        } else this.pending.set(id, n);
      }
    }
    if (!this.pending.size) this.stop();
  }
}
