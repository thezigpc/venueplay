// Apps that play sound (SDK 0.13.0, manifest audio.play): they list the box's outputs and
// play their own audio on one. The broker does the playing; core checks the app and hands
// the broker a one-time source URL on core's loopback port, which core answers by fetching
// the file from the app's own server. The app's address never leaves the box, and the
// broker never talks to games.

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Logger } from "@bargames/common";
import { isIntegration, type AudioOutput, type AudioSession } from "@bargames/sdk";
import type { Express, Request, RequestHandler, Response } from "express";
import { HttpError, type GameRegistry } from "./games.js";
import type { InstalledGame } from "./state.js";

/** What the broker says about an output (apps/broker/src/audio/types.ts OutputView). */
interface BrokerOutput {
  id: string;
  kind: "box" | "bluetooth" | "tv";
  name: string;
  label?: string;
  available: boolean;
  detail?: string;
  volume: number;
  default: boolean;
  session?: AudioSession;
}

const LIVE = new Set(["starting", "playing", "paused"]);
const SOURCE_TTL_MS = 12 * 60 * 60_000;
const MAX_SOURCES_PER_APP = 50;

const h =
  (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);

const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);

/** A path on the app's own server ("/tracks/12.mp3"); never a full URL or a way out of it. */
export function checkAudioPath(p: unknown): string {
  if (typeof p !== "string" || !p.startsWith("/") || p.startsWith("//") || p.length > 2000 || /[\s\\]/.test(p) || /(^|\/)\.\.(\/|$)/.test(p)) {
    throw new HttpError(400, "path: a path on your own server, like /tracks/12.mp3");
  }
  return p;
}

export class AppAudio {
  private sources = new Map<string, { gameId: string; path: string; at: number }>();

  constructor(
    private readonly o: {
      games: GameRegistry;
      brokerCall: (method: string, sub: string, body?: unknown) => Promise<unknown>;
      /** Where the broker (host network) reaches core: http://127.0.0.1:7100 on a box. */
      sourceBase: string;
      /** The app's own server, as core reaches it. */
      target: (g: InstalledGame) => string;
      fetch: typeof fetch;
      log: Logger;
    },
  ) {}

  /** Apps, and games, that declare audio.play and are on. */
  private appOf(game: InstalledGame): InstalledGame {
    if (isIntegration(game.manifest)) throw new HttpError(401, "bad game token");
    if (!game.manifest.audio?.play) throw new HttpError(403, 'This app didn\'t ask to play sound: add "audio": { "play": true } to bargames.json.');
    if (!game.enabled) throw new HttpError(403, "This app is turned off.");
    return game;
  }

  private async outputs(): Promise<BrokerOutput[]> {
    return ((await this.o.brokerCall("GET", "/audio/outputs")) as BrokerOutput[]) ?? [];
  }

  private async mySession(game: InstalledGame, id: string): Promise<AudioSession> {
    const mine = (await this.o.brokerCall("GET", `/audio/sessions?owner=${encodeURIComponent(`app:${game.id}`)}`)) as AudioSession[];
    const s = mine.find((x) => x.id === id);
    if (!s) throw new HttpError(404, "no such session (sessions you didn't start, or that ended a while ago, aren't listed)");
    return s;
  }

  private newSource(gameId: string, path: string): string {
    const now = Date.now();
    for (const [k, v] of this.sources) if (now - v.at > SOURCE_TTL_MS) this.sources.delete(k);
    const mine = [...this.sources].filter(([, v]) => v.gameId === gameId);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - MAX_SOURCES_PER_APP + 1))) this.sources.delete(k);
    const token = randomBytes(24).toString("hex");
    this.sources.set(token, { gameId, path, at: now });
    return token;
  }

  /** The output as an app sees it: busy when someone else plays on it. */
  private view(o: BrokerOutput, gameId: string): AudioOutput {
    const live = o.session && LIVE.has(o.session.state) ? o.session : undefined;
    return {
      id: o.id,
      name: o.label || o.name,
      kind: o.kind,
      available: o.available,
      default: o.default,
      volume: o.volume,
      ...(o.detail ? { detail: o.detail } : {}),
      ...(live && live.owner !== `app:${gameId}` ? { busy: true } : {}),
    };
  }

  mount(app: Express, gameAuth: (req: Request) => InstalledGame): void {
    const auth = (req: Request) => this.appOf(gameAuth(req));

    app.get(
      "/internal/audio/outputs",
      h(async (req, res) => {
        const game = auth(req);
        res.json((await this.outputs()).map((o) => this.view(o, game.id)));
      }),
    );

    /** { path, output?, title?, artist?, album?, durationMs?, replace? } */
    app.post(
      "/internal/audio/play",
      h(async (req, res) => {
        const game = auth(req);
        const b = (req.body ?? {}) as Record<string, unknown>;
        const path = checkAudioPath(b.path);
        const outputs = await this.outputs();
        const want = str(b.output, 120);
        const out = want ? outputs.find((o) => o.id === want) : outputs.find((o) => o.default);
        if (!out) throw new HttpError(want ? 404 : 409, want ? "no such output" : "This box has no sound output.");
        const busy = out.session && LIVE.has(out.session.state) && out.session.owner !== `app:${game.id}` && out.session.owner !== "admin" ? out.session : undefined;
        if (busy && b.replace !== true) {
          const other = this.o.games.get(busy.owner.replace(/^app:/, ""));
          throw new HttpError(409, `${other?.manifest.name ?? "Something else"} is playing on ${out.label || out.name}. Pass replace: true to take it over.`);
        }
        const token = this.newSource(game.id, path);
        const session = await this.o.brokerCall("POST", "/audio/play", {
          url: `${this.o.sourceBase}/internal/audio/source/${token}`,
          owner: `app:${game.id}`,
          output: out.id,
          title: str(b.title, 120),
          artist: str(b.artist, 120),
          album: str(b.album, 120),
          durationMs: typeof b.durationMs === "number" && Number.isFinite(b.durationMs) && b.durationMs > 0 ? Math.round(b.durationMs) : undefined,
        });
        res.json(session);
      }),
    );

    app.get(
      "/internal/audio/sessions",
      h(async (req, res) => {
        const game = auth(req);
        res.json(await this.o.brokerCall("GET", `/audio/sessions?owner=${encodeURIComponent(`app:${game.id}`)}`));
      }),
    );

    app.post(
      "/internal/audio/sessions/:id/:action(pause|resume|stop)",
      h(async (req, res) => {
        const game = auth(req);
        await this.mySession(game, req.params.id);
        res.json(await this.o.brokerCall("POST", `/audio/sessions/${encodeURIComponent(req.params.id)}/${req.params.action}`, {}));
      }),
    );

    /** { volume: 0-100 }: only while this app plays on that output (the venue sets it otherwise). */
    app.put(
      "/internal/audio/outputs/:id/volume",
      h(async (req, res) => {
        const game = auth(req);
        const volume = Number(req.body?.volume);
        if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new HttpError(400, "volume: 0-100");
        const out = (await this.outputs()).find((o) => o.id === req.params.id);
        if (!out) throw new HttpError(404, "no such output");
        if (!(out.session && LIVE.has(out.session.state) && out.session.owner === `app:${game.id}`)) {
          throw new HttpError(403, "Only the app playing on an output can change its volume.");
        }
        const updated = (await this.o.brokerCall("PATCH", `/audio/outputs/${encodeURIComponent(out.id)}`, { volume: Math.round(volume) })) as BrokerOutput;
        res.json(this.view(updated, game.id));
      }),
    );

    /**
     * The broker fetches the audio here (loopback only: the gateway never routes /internal).
     * The token is the permission; core fetches the file from the app with the app's token,
     * so the app can tell the box's request from anyone else's. Range requests pass through.
     */
    app.get(
      "/internal/audio/source/:token",
      h(async (req, res) => {
        const src = this.sources.get(req.params.token);
        const game = src && Date.now() - src.at < SOURCE_TTL_MS ? this.o.games.get(src.gameId) : undefined;
        if (!src || !game || !game.enabled) throw new HttpError(404, "no such source");
        const ctrl = new AbortController();
        req.on("close", () => ctrl.abort());
        const headers: Record<string, string> = { authorization: `Bearer ${game.token}`, "x-bargames-audio": "1" };
        if (typeof req.headers.range === "string") headers.range = req.headers.range;
        const r = await this.o.fetch(`${this.o.target(game)}${src.path}`, { headers, signal: ctrl.signal }).catch(() => undefined);
        if (!r) throw new HttpError(502, "the app didn't answer");
        res.status(r.status);
        for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
          const v = r.headers.get(k);
          if (v) res.setHeader(k, v);
        }
        if (!r.body) return void res.end();
        Readable.fromWeb(r.body as unknown as WebReadableStream<Uint8Array>)
          .on("error", () => res.destroy())
          .pipe(res);
      }),
    );
  }
}
