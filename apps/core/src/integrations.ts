// Integrations (SDK 0.12.0): connectors between the box and other systems (Matter, Home
// Assistant, a POS). Each is an installed module of kind "integration" with its own
// container and token. It talks to this API and gets only what the venue approved:
//
//   GET  /internal/integration/catalog            scenes, TVs, games it may see
//   GET  /internal/integration/stream             live: catalog changes, game events, scene runs
//   PUT  /internal/integration/report             its own state for the admin (pairing QR…)
//   POST /internal/integration/scenes/:id/run     "scenes"
//   POST /internal/integration/tvs/:id/power      "tvs"
//
// The admin side (/api/integrations…) lists them, approves permissions, keeps their
// settings (owner-only, like secret settings) and turns them on and off.

import { bearer, type Logger } from "@bargames/common";
import {
  INTEGRATION_PERMISSIONS,
  PERMISSION_TEXT,
  isIntegration,
  type BarGamesEvent,
  type IntegrationCatalog,
  type IntegrationGame,
  type IntegrationMessage,
  type IntegrationPermission,
  type IntegrationReport,
  type IntegrationTv,
} from "@bargames/sdk";
import type { Express, Request, RequestHandler, Response } from "express";
import QRCode from "qrcode";
import type { EventBus } from "./events.js";
import { HttpError, type GameRegistry } from "./games.js";
import type { GameRuntime } from "./runtime/types.js";
import type { Scene } from "./scenes.js";
import type { InstalledGame, State } from "./state.js";

/** The broker's display, as far as integrations care. */
export interface HubDisplay {
  id: string;
  name: string;
  label?: string;
  group?: string;
  health?: { online?: boolean };
  capabilities?: { power?: boolean };
  content?: { kind: string; title?: string };
}

export interface IntegrationDeps {
  games: GameRegistry;
  state: State;
  runtime: GameRuntime;
  bus: EventBus;
  log: Logger;
  box: { id: string; version: string };
  /** GitHub owners whose integrations may run on the host network. "*" = any. */
  trustedOwners: string[];
  displays: () => Promise<HubDisplay[]>;
  gameRows: () => IntegrationGame[];
  runScene: (scene: Scene, by: string) => Promise<{ step: string; ok: boolean; message?: string }[]>;
  tvPower: (displayId: string, on: boolean) => Promise<void>;
  /** Default 20 s: how often connected integrations' catalogs are compared for changes. */
  pollMs?: number;
}

interface Stream {
  id: string;
  perms: Set<IntegrationPermission>;
  res: Response;
  last?: string;
}

const h =
  (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);

/** The permissions in force: approved and still declared. */
export function effectivePermissions(g: InstalledGame): IntegrationPermission[] {
  const declared = new Set(g.manifest.integration?.permissions ?? []);
  return (g.granted ?? []).filter((p) => declared.has(p));
}

/** Declared permissions the venue hasn't approved yet. */
export function missingPermissions(g: InstalledGame): IntegrationPermission[] {
  const granted = new Set(g.granted ?? []);
  return (g.manifest.integration?.permissions ?? []).filter((p) => !granted.has(p));
}

/** The GitHub owner an installed module came from, or undefined (uploaded, other host). */
export function sourceOwner(g: InstalledGame): string | undefined {
  if (g.source.kind !== "url") return undefined;
  try {
    const u = new URL(g.source.ref);
    if (u.hostname !== "raw.githubusercontent.com" && u.hostname !== "github.com" && u.hostname !== "api.github.com") return undefined;
    const parts = u.pathname.split("/").filter(Boolean);
    const owner = u.hostname === "api.github.com" ? parts[1] : parts[0];
    return owner?.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isTrusted(g: InstalledGame, owners: string[]): boolean {
  if (owners.includes("*")) return true;
  const owner = sourceOwner(g);
  return Boolean(owner && owners.includes(owner));
}

/** Validates what an integration reports about itself. */
export function cleanReport(r: unknown): IntegrationReport | string {
  if (!r || typeof r !== "object") return "report: an object";
  const x = r as Record<string, unknown>;
  if (!["setup", "ok", "warn", "error"].includes(x.state as string)) return "state: setup, ok, warn or error";
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const out: IntegrationReport = { state: x.state as IntegrationReport["state"] };
  const message = str(x.message, 200);
  if (message) out.message = message;
  if (x.pairing && typeof x.pairing === "object") {
    const p = x.pairing as Record<string, unknown>;
    const pairing = { qr: str(p.qr, 512), code: str(p.code, 40), note: str(p.note, 200) };
    if (pairing.qr || pairing.code) out.pairing = Object.fromEntries(Object.entries(pairing).filter(([, v]) => v)) as IntegrationReport["pairing"];
  }
  if (Array.isArray(x.details)) {
    out.details = x.details
      .filter((d): d is { label: string; value: string } => Boolean(d && typeof d === "object" && str((d as { label?: unknown }).label, 40) && typeof (d as { value?: unknown }).value === "string"))
      .slice(0, 12)
      .map((d) => ({ label: d.label.trim().slice(0, 40), value: d.value.slice(0, 120) }));
  }
  if (Array.isArray(x.actions)) {
    const actions = x.actions
      .filter((a): a is { id: string; label: string; confirm?: unknown } => Boolean(a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string" && /^[a-z][a-z0-9-]{0,31}$/.test((a as { id: string }).id) && str((a as { label?: unknown }).label, 40)))
      .slice(0, 4)
      .map((a) => ({ id: a.id, label: a.label.trim().slice(0, 40), ...(str(a.confirm, 200) ? { confirm: str(a.confirm, 200)! } : {}) }));
    if (actions.length) out.actions = actions;
  }
  return out;
}

export class IntegrationHub {
  private readonly streams = new Set<Stream>();
  private readonly reports = new Map<string, { report: IntegrationReport; at: string }>();
  private poll?: NodeJS.Timeout;
  private pending?: NodeJS.Timeout;

  constructor(private readonly d: IntegrationDeps) {
    d.bus.subscribe((evt) => this.event(evt));
  }

  // ---------------------------------------------------------------- catalog

  async catalogFor(perms: Set<IntegrationPermission>): Promise<IntegrationCatalog> {
    const cat: IntegrationCatalog = {
      box: { id: this.d.box.id, version: this.d.box.version, venue: this.d.state.venue.get().name },
      permissions: [...perms].sort(),
    };
    if (perms.has("scenes")) cat.scenes = this.d.state.scenes.get().scenes.map((s) => ({ id: s.id, name: s.name })).sort((a, b) => a.name.localeCompare(b.name));
    if (perms.has("tvs") || perms.has("status")) {
      const list = await this.d.displays().catch(() => [] as HubDisplay[]);
      cat.tvs = list.map((x) => {
        const tv: IntegrationTv = { id: x.id, name: x.label || x.name, online: Boolean(x.health?.online), power: Boolean(x.capabilities?.power) };
        if (x.group) tv.group = x.group;
        if (perms.has("status") && x.content && x.content.kind !== "off") tv.showing = x.content.title || (x.content.kind === "idle" ? "Idle" : x.content.kind);
        return tv;
      });
    }
    if (perms.has("status")) cat.games = this.d.gameRows();
    return cat;
  }

  /** Something integrations see changed (scenes, TVs, games): re-send catalogs that differ. */
  changed(): void {
    if (!this.streams.size || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.pushCatalogs();
    }, 300);
    this.pending.unref?.();
  }

  private async pushCatalogs(): Promise<void> {
    for (const s of this.streams) {
      const catalog = await this.catalogFor(s.perms).catch(() => undefined);
      if (!catalog) continue;
      const key = JSON.stringify(catalog);
      if (key === s.last) continue;
      s.last = key;
      this.send(s, { type: "catalog", catalog });
    }
  }

  // ---------------------------------------------------------------- stream

  private send(s: Stream, msg: IntegrationMessage): void {
    try {
      s.res.write(`data: ${JSON.stringify(msg)}\n\n`);
    } catch {
      this.streams.delete(s);
    }
  }

  private event(evt: BarGamesEvent): void {
    for (const s of this.streams) if (s.perms.has("events")) this.send(s, { type: "event", event: evt });
  }

  /** A scene ran (admin, schedule or integration): integrations with "scenes" hear it. */
  sceneRan(sceneId: string, ok: boolean, by: string): void {
    const at = new Date().toISOString();
    for (const s of this.streams) if (s.perms.has("scenes")) this.send(s, { type: "scene", sceneId, ok, by, at });
  }

  /** Closes an integration's streams (turned off, removed, permissions changed). */
  disconnect(id: string): void {
    for (const s of this.streams) {
      if (s.id !== id) continue;
      this.streams.delete(s);
      s.res.end();
    }
    this.reports.delete(id);
  }

  private startPolling(): void {
    if (this.poll) return;
    this.poll = setInterval(() => {
      if (!this.streams.size) {
        clearInterval(this.poll);
        this.poll = undefined;
        return;
      }
      void this.pushCatalogs();
    }, this.d.pollMs ?? 20_000);
    this.poll.unref?.();
  }

  // ---------------------------------------------------------------- auth

  private auth(req: Request, need?: IntegrationPermission): { game: InstalledGame; perms: Set<IntegrationPermission> } {
    const game = this.d.games.byToken(bearer(req.headers.authorization));
    if (!game || !isIntegration(game.manifest)) throw new HttpError(401, "bad integration token");
    if (!game.enabled) throw new HttpError(403, "this integration is turned off");
    const perms = new Set(effectivePermissions(game));
    if (need && !perms.has(need)) throw new HttpError(403, `the venue hasn't allowed "${need}" for this integration`);
    return { game, perms };
  }

  // ---------------------------------------------------------------- routes

  mountInternal(app: Express): void {
    app.get(
      "/internal/integration/catalog",
      h(async (req, res) => {
        const { perms } = this.auth(req);
        res.json(await this.catalogFor(perms));
      }),
    );

    app.get(
      "/internal/integration/stream",
      h(async (req, res) => {
        const { game, perms } = this.auth(req);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        const s: Stream = { id: game.id, perms, res };
        const catalog = await this.catalogFor(perms);
        s.last = JSON.stringify(catalog);
        this.streams.add(s);
        this.send(s, { type: "hello", catalog });
        this.startPolling();
        const beat = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {
            /* closed */
          }
        }, 25_000);
        req.on("close", () => {
          clearInterval(beat);
          this.streams.delete(s);
        });
        this.d.log.info("integrations", "stream connected", { integration: game.id });
      }),
    );

    app.put(
      "/internal/integration/report",
      h((req, res) => {
        const { game } = this.auth(req);
        const report = cleanReport(req.body);
        if (typeof report === "string") throw new HttpError(400, report);
        const before = this.reports.get(game.id)?.report;
        this.reports.set(game.id, { report, at: new Date().toISOString() });
        if (before?.state !== report.state) this.d.log.info("integrations", "state", { integration: game.id, state: report.state, message: report.message });
        res.json({ ok: true });
      }),
    );

    app.post(
      "/internal/integration/scenes/:id/run",
      h(async (req, res) => {
        const { game } = this.auth(req, "scenes");
        const scene = this.d.state.scenes.get().scenes.find((s) => s.id === req.params.id);
        if (!scene) throw new HttpError(404, `no scene ${req.params.id}`);
        const steps = await this.d.runScene(scene, game.id);
        res.json({ ok: steps.every((s) => s.ok), steps });
      }),
    );

    app.post(
      "/internal/integration/tvs/:id/power",
      h(async (req, res) => {
        this.auth(req, "tvs");
        const on = (req.body ?? {}).on;
        if (typeof on !== "boolean") throw new HttpError(400, "on: true or false");
        const tv = (await this.d.displays()).find((x) => x.id === req.params.id);
        if (!tv) throw new HttpError(404, `no TV ${req.params.id}`);
        if (!tv.capabilities?.power) throw new HttpError(400, `${tv.label || tv.name} can't be switched on or off by the box`);
        await this.d.tvPower(tv.id, on);
        this.changed();
        res.json({ ok: true });
      }),
    );
  }

  /** Admin routes: mount after the admin login check. */
  mountAdmin(app: Express, hooks: { updateOf: (id: string) => unknown; afterChange: (g: InstalledGame) => Promise<void> }): void {
    const view = async (g: InstalledGame) => {
      const values = this.d.state.appSecrets.get()[g.id] ?? {};
      const declared = g.manifest.integration?.permissions ?? [];
      const trusted = isTrusted(g, this.d.trustedOwners);
      return {
        id: g.id,
        name: g.manifest.name,
        version: g.manifest.version,
        description: g.manifest.description,
        homepage: g.manifest.homepage,
        source: g.source.kind === "url" ? g.source.ref : g.source.kind,
        trusted,
        enabled: g.enabled,
        state: await this.d.runtime.state(g.id).catch(() => "unknown"),
        permissions: declared.map((p) => ({ id: p, text: PERMISSION_TEXT[p], granted: Boolean(g.granted?.includes(p)) })),
        needsApproval: missingPermissions(g),
        /** "lan" can't be approved: the source isn't trusted. */
        blocked: declared.includes("lan") && !trusted ? ["lan"] : [],
        settings: (g.manifest.integration?.settings ?? []).map((s) => ({ ...s, set: values[s.name] !== undefined, ...(s.secret || values[s.name] === undefined ? {} : { value: values[s.name] }) })),
        report: this.reports.get(g.id)?.report,
        reportAt: this.reports.get(g.id)?.at,
        connected: [...this.streams].some((s) => s.id === g.id),
        update: hooks.updateOf(g.id),
      };
    };
    const find = (id: string) => {
      const g = this.d.games.get(id);
      if (!g || !isIntegration(g.manifest)) throw new HttpError(404, "no such integration");
      return g;
    };
    const approve = async (g: InstalledGame) => {
      const declared = g.manifest.integration?.permissions ?? [];
      if (declared.includes("lan") && !isTrusted(g, this.d.trustedOwners)) {
        throw new HttpError(403, `${g.manifest.name} wants to use the venue network directly, which the box only allows for integrations from a trusted source.`);
      }
      return this.d.games.grant(g.id, declared);
    };

    app.get(
      "/api/integrations",
      h(async (_req, res) => res.json({ permissions: INTEGRATION_PERMISSIONS.map((p) => ({ id: p, text: PERMISSION_TEXT[p] })), integrations: await Promise.all(this.d.games.integrations().map(view)) })),
    );

    /** { on, approve? }: turn on (approving what it asks for) or off. */
    app.post(
      "/api/integrations/:id/enable",
      h(async (req, res) => {
        let g = find(req.params.id);
        const { on, approve: ok } = (req.body ?? {}) as { on?: unknown; approve?: unknown };
        if (typeof on !== "boolean") throw new HttpError(400, "on: true or false");
        if (on) {
          if (ok === true) g = await approve(g);
          if (missingPermissions(g).length) throw new HttpError(409, `approve what ${g.manifest.name} asks for first`);
          g = await this.d.games.patch(g.id, { enabled: true });
          await this.d.runtime.ensureRunning(g);
        } else {
          g = await this.d.games.patch(g.id, { enabled: false });
          this.disconnect(g.id);
          await this.d.runtime.stop(g.id);
        }
        this.d.log.info("integrations", on ? "turned on" : "turned off", { integration: g.id });
        await hooks.afterChange(g);
        res.json(await view(g));
      }),
    );

    /** Approves what an updated integration now asks for; restarts it if it's on. */
    app.post(
      "/api/integrations/:id/approve",
      h(async (req, res) => {
        let g = await approve(find(req.params.id));
        if (g.enabled) {
          this.disconnect(g.id);
          await this.d.runtime.ensureRunning(g);
        }
        g = find(g.id);
        this.d.log.info("integrations", "permissions approved", { integration: g.id, permissions: g.granted });
        res.json(await view(g));
      }),
    );

    /** { values: { NAME: "value" | null } }: only the settings it declares. Restarts it if on. */
    app.put(
      "/api/integrations/:id/settings",
      h(async (req, res) => {
        const g = find(req.params.id);
        const values = ((req.body ?? {}) as { values?: Record<string, unknown> }).values;
        if (!values || typeof values !== "object") throw new HttpError(400, "values: { NAME: value }");
        const declared = new Map((g.manifest.integration?.settings ?? []).map((s) => [s.name, s]));
        for (const [k, v] of Object.entries(values)) {
          if (!declared.has(k)) throw new HttpError(400, `${g.manifest.name} has no setting ${k}`);
          if (v !== null && (typeof v !== "string" || v.length > 4096)) throw new HttpError(400, `${k}: up to 4096 characters, or null to clear`);
        }
        await this.d.state.appSecrets.update((s) => {
          const mine = { ...(s[g.id] ?? {}) };
          for (const [k, v] of Object.entries(values)) {
            if (v === null || v === "") delete mine[k];
            else mine[k] = v as string;
          }
          if (Object.keys(mine).length) s[g.id] = mine;
          else delete s[g.id];
        });
        this.d.log.info("integrations", "settings saved", { integration: g.id, names: Object.keys(values) });
        if (g.enabled) await this.d.runtime.ensureRunning(g);
        res.json(await view(g));
      }),
    );

    /** Staff pressed one of the buttons the integration reported: hand it over on its stream. */
    app.post(
      "/api/integrations/:id/actions/:action",
      h((req, res) => {
        const g = find(req.params.id);
        const action = this.reports.get(g.id)?.report.actions?.find((a) => a.id === req.params.action);
        if (!action) throw new HttpError(404, `${g.manifest.name} doesn't offer that right now`);
        const mine = [...this.streams].filter((s) => s.id === g.id);
        if (!mine.length) throw new HttpError(409, `${g.manifest.name} isn't connected to the box right now`);
        const at = new Date().toISOString();
        for (const s of mine) this.send(s, { type: "action", action: action.id, at });
        this.d.log.info("integrations", "action", { integration: g.id, action: action.id });
        res.json({ ok: true });
      }),
    );

    /** The pairing code it reported (e.g. Matter's "MT:…"), as a QR code. */
    app.get(
      "/api/integrations/:id/pairing.svg",
      h(async (req, res) => {
        const g = find(req.params.id);
        const qr = this.reports.get(g.id)?.report.pairing?.qr;
        if (!qr) throw new HttpError(404, "no pairing code right now");
        const svg = await QRCode.toString(qr, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
        res.type("image/svg+xml").set("cache-control", "no-store").send(svg);
      }),
    );
  }
}
