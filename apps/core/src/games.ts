import { randomToken, type JsonStore } from "@bargames/common";
import type { GameBranding, GameManifest, IntegrationPermission } from "@bargames/sdk";
import { isHexColor, isIntegration } from "@bargames/sdk";
import { isLabel } from "./hostnames.js";
import type { InstalledGame } from "./state.js";

/** Names a game can't take: they're box paths on the venue's hostname. */
export const RESERVED_PATHS = ["admin", "api", "internal", "health", "assets"];

export interface GamePatch {
  enabled?: boolean;
  branding?: GameBranding;
  hostnameAlias?: string | null;
  ownHostname?: boolean;
}

export class GameRegistry {
  constructor(private readonly store: JsonStore<{ games: InstalledGame[] }>) {}

  /** Games and apps: everything players, TVs, hostnames and the gateway deal with. */
  list(): InstalledGame[] {
    return this.store.get().games.filter((g) => !isIntegration(g.manifest));
  }

  /** Integrations (SDK 0.12.0): connectors with no pages (Settings → Smart home). */
  integrations(): InstalledGame[] {
    return this.store.get().games.filter((g) => isIntegration(g.manifest));
  }

  /** Everything installed: what runs in a container and gets update checks. */
  all(): InstalledGame[] {
    return this.store.get().games;
  }

  get(id: string): InstalledGame | undefined {
    return this.all().find((g) => g.id === id);
  }

  byToken(token: string): InstalledGame | undefined {
    return token ? this.all().find((g) => g.token === token) : undefined;
  }

  /** Approves an integration's permissions (all it declares now). */
  async grant(id: string, permissions: IntegrationPermission[]): Promise<InstalledGame> {
    const game = this.get(id);
    if (!game) throw new HttpError(404, `no integration ${id}`);
    const next: InstalledGame = { ...game, granted: [...new Set(permissions)].sort() as IntegrationPermission[], updatedAt: new Date().toISOString() };
    await this.store.update((d) => {
      d.games = d.games.map((g) => (g.id === id ? next : g));
    });
    return next;
  }

  /** Installs or upgrades. Upgrades keep the venue's settings, branding and token. */
  async install(input: {
    manifest: GameManifest;
    source: InstalledGame["source"];
    verified: boolean;
    devTarget?: string;
  }): Promise<{ game: InstalledGame; upgraded: boolean }> {
    const now = new Date().toISOString();
    const existing = this.get(input.manifest.id);
    const game: InstalledGame = existing
      ? { ...existing, manifest: input.manifest, source: input.source, verified: input.verified, updatedAt: now, devTarget: input.devTarget ?? existing.devTarget }
      : {
          id: input.manifest.id,
          manifest: input.manifest,
          source: input.source,
          verified: input.verified,
          installedAt: now,
          updatedAt: now,
          enabled: false,
          branding: {},
          token: randomToken(),
          devTarget: input.devTarget,
        };
    await this.store.update((d) => {
      d.games = [...d.games.filter((g) => g.id !== game.id), game].sort((a, b) => a.id.localeCompare(b.id));
    });
    return { game, upgraded: Boolean(existing) };
  }

  async patch(id: string, patch: GamePatch): Promise<InstalledGame> {
    const game = this.get(id);
    if (!game) throw new HttpError(404, `no game ${id}`);
    const next: InstalledGame = { ...game, updatedAt: new Date().toISOString() };
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.branding) next.branding = sanitizeBranding(game.manifest, patch.branding);
    if (patch.ownHostname !== undefined) next.ownHostname = patch.ownHostname ? true : undefined;
    if (patch.hostnameAlias !== undefined) {
      const alias = patch.hostnameAlias?.trim().toLowerCase() || undefined;
      if (alias && !isLabel(alias)) throw new HttpError(400, "hostnameAlias must be a single DNS label (a-z, 0-9, -)");
      if (alias && RESERVED_PATHS.includes(alias)) throw new HttpError(400, `"${alias}" is reserved by the box`);
      const clash = alias && this.all().find((g) => g.id !== id && (g.hostnameAlias ?? g.id) === alias);
      if (clash) throw new HttpError(409, `hostname "${alias}" is used by ${clash.id}`);
      next.hostnameAlias = alias;
    }
    await this.store.update((d) => {
      d.games = d.games.map((g) => (g.id === id ? next : g));
    });
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.all().length;
    await this.store.update((d) => {
      d.games = d.games.filter((g) => g.id !== id);
    });
    return this.all().length < before;
  }
}

/** Keeps only the slots the game declared brandable, with basic validation. */
export function sanitizeBranding(manifest: GameManifest, b: GameBranding): GameBranding {
  const slots = new Set(manifest.brandable);
  const out: GameBranding = {};
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  if (slots.has("displayName")) out.displayName = text(b.displayName, 40);
  if (slots.has("tagline")) out.tagline = text(b.tagline, 80);
  if (slots.has("icon") && typeof b.iconUrl === "string" && /^(https?:\/\/|\/)/.test(b.iconUrl)) out.iconUrl = b.iconUrl;
  if (slots.has("accent") && isHexColor(b.accent)) out.accent = b.accent;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as GameBranding;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
