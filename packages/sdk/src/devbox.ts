// Node-only developer tools behind the `bargames` CLI: a pretend box for testing a
// game's integration without the platform. Not exported to browsers.
//
//   mock-box: fake core (venue context + event sink + two fake TVs) and a fake gateway
//             in front of the game (adds the x-bargames-* headers, proxies HTTP and WebSockets).
//   command / status: call the game the way the box's iPad does.
//   check:    automated conformance checks.

import { createServer, request, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { isApp, isIntegration, MANIFEST_FILE, tableUrl, validateManifest, type GameManifest } from "./manifest.js";
import { AUDIO_PATHS, HEADERS, INTEGRATION_PATHS, PATHS, PROTOCOL_VERSION, STANDARD_EVENTS, type AudioEndReason, type AudioOutput, type AudioPlayOptions, type AudioSession, type IntegrationCatalog, type IntegrationMessage, type IntegrationReport, type CastDisplay, type CastTargets, type Countdown, type GameStatus, type MediaItem, type VenueContext, type VenueTheme } from "./protocol.js";
import { DEFAULT_THEME } from "./theme.js";
import { joinUrl, normalizeBasePath } from "./base.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const DEV_TOKEN = "dev-token";

/** A loud theme, so it's obvious on screen when branding is applied. */
export const TEST_THEME: VenueTheme = {
  ...DEFAULT_THEME,
  colors: { background: "#0b2a2a", surface: "#12403f", text: "#f2fffd", primary: "#ff4fa3", accent: "#ffd23f" },
  font: "Georgia, serif",
  radius: 18,
};

export function loadManifest(dirOrFile: string): GameManifest | undefined {
  const file = existsSync(dirOrFile) && !dirOrFile.endsWith(".json") ? path.join(dirOrFile, MANIFEST_FILE) : dirOrFile;
  if (!existsSync(file)) return undefined;
  const r = validateManifest(JSON.parse(readFileSync(file, "utf8")));
  return r.ok ? r.manifest : undefined;
}

/** The mock box's games list page, served by its fake gateway. */
export const MOCK_GAMES_PATH = "/__bargames/dev/games";
/** The mock gateway's staff cookie (open PATHS.staff to set it). */
export const MOCK_STAFF_COOKIE = "bg_staff_mock";
/** SDK 0.11.1: the pretend box admin page (venue.adminUrl on the mock box). */
export const MOCK_ADMIN_PATH = "/__bargames/dev/admin";
/**
 * SDK 0.13.1: controls for testing an integration on the mock box (fake gateway, no login):
 *   GET    …/integration                what the mock box holds (streams, last report, catalog)
 *   POST   …/integration/action/<id>    press one of your report's buttons (a stream "action")
 *   POST   …/integration/drop           drop every stream, as a core restart does
 *   PUT    …/integration/catalog        { scenes?, tvs?, games? }: replace those lists (sends "catalog")
 *   DELETE …/integration/catalog        back to the built-in pretend lists
 */
export const MOCK_INTEGRATION_PATH = "/__bargames/dev/integration";

export function mockContext(gameId: string, displayName: string, publicUrl: string, opts: { announcement?: string; announcementShow?: "everywhere" | "phones" | "tvs"; announcementPosition?: "top" | "bottom"; app?: boolean; /** @deprecated */ display?: boolean } = {}): VenueContext {
  const app = Boolean(opts.app ?? opts.display);
  const self = { id: gameId, displayName, tagline: "Branded by the mock box", url: publicUrl };
  return {
    protocol: PROTOCOL_VERSION,
    venue: {
      name: "Test Venue",
      theme: TEST_THEME,
      wifi: { ssid: "TestVenueGuest" },
      playUrl: new URL(MOCK_GAMES_PATH, publicUrl).toString(),
      games: [
        ...(app ? [] : [self]),
        // A pretend second game, so "Also playing" has something to show.
        { id: "other-game", displayName: "Other Game (fake)", url: new URL(`${MOCK_GAMES_PATH}#other-game`, publicUrl).toString() },
      ],
      // Apps (menus) are listed apart from games.
      apps: app ? [self] : [],
      modules: app ? [self] : [],
      location: { latitude: 40.7128, longitude: -74.006, label: "Test City" },
      timezone: "America/New_York",
      units: "imperial",
      ...(opts.announcement ? { announcement: { id: "mock-1", text: opts.announcement, ...(opts.announcementShow ? { show: opts.announcementShow } : {}), ...(opts.announcementPosition ? { position: opts.announcementPosition } : {}) } } : {}),
      // SDK 0.11.1: a pretend box admin, so BoxAdminLink / boxAdminUrl() show up on the mock.
      adminUrl: new URL(MOCK_ADMIN_PATH, publicUrl).toString(),
    },
    game: { id: gameId, displayName, tagline: "Branded by the mock box", publicUrl, theme: TEST_THEME, ...(normalizeBasePath(new URL(publicUrl).pathname) ? { basePath: normalizeBasePath(new URL(publicUrl).pathname) } : {}) },
    standalone: false,
    generatedAt: new Date().toISOString(),
  };
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function readBody(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s;
}

// ---------------------------------------------------------------- mock-box

export interface MockBoxOptions {
  gameId: string;
  displayName: string;
  /** Where the game server listens, e.g. http://127.0.0.1:3002 */
  gameUrl: string;
  corePort: number;
  gatewayPort: number;
  manifest?: GameManifest;
  /** Fake venue TV PIN for casting from the game. Empty: no PIN. */
  tvPin?: string;
  /** false: act like a venue that turned "casting from games" off. */
  castFromGames?: boolean;
  /** A pretend staff announcement, shown by announcementBanner(). */
  announcement?: string;
  /** SDK 0.11.1: where the pretend announcement shows, and top or bottom. */
  announcementShow?: "everywhere" | "phones" | "tvs";
  announcementPosition?: "top" | "bottom";
  /** The pretend box admin password bg.checkVenuePassword() accepts (default "box-password"). */
  venuePassword?: string;
  /** SDK 0.10.0: serve the game under this prefix ("/bingo"), like the box's path routing. */
  basePath?: string;
  /**
   * SDK 0.13.1: the venue address the game is told it has (venue.json game.publicUrl), e.g.
   * "https://play.example.net/bingo", to test long "Join at" addresses. The mock gateway
   * still answers on localhost; only what the game prints and puts in QR codes changes.
   */
  publicUrl?: string;
}

/** The mock box's pretend venue TVs. */
export const FAKE_TVS: readonly { id: string; name: string; group: string; unpaired?: boolean }[] = [
  { id: "fake-bar", name: "Bar (fake TV)", group: "Main room" },
  { id: "fake-patio", name: "Patio (fake TV)", group: "Patio" },
  // Answers like a TV the venue hasn't paired yet, so games can test that message.
  { id: "fake-unpaired", name: "Lounge (fake TV, not paired)", group: "Main room", unpaired: true },
];

/** SDK 0.12.0: the mock box's pretend scenes, for integrations. */
export const MOCK_SCENES: readonly { id: string; name: string }[] = [
  { id: "bingo-night", name: "Bingo night" },
  { id: "last-call", name: "Last call" },
  { id: "all-tvs-off", name: "All TVs off" },
];
let fakePatioOnline = true;

/** What an integration sees on the mock box (permissions from its manifest). */
export function mockCatalog(perms: Set<string>, edits: Partial<Pick<IntegrationCatalog, "scenes" | "tvs" | "games">> = {}): IntegrationCatalog {
  const cat: IntegrationCatalog = { box: { id: "mock0000box00001", version: "dev", venue: "Test Venue" }, permissions: [...perms].sort() };
  if (perms.has("scenes")) cat.scenes = edits.scenes ?? MOCK_SCENES.map((s) => ({ ...s }));
  if (perms.has("tvs") || perms.has("status"))
    cat.tvs = edits.tvs ?? FAKE_TVS.map((t) => ({ id: t.id, name: t.name, group: t.group, online: t.id === "fake-patio" ? fakePatioOnline : !t.unpaired, power: !t.unpaired, ...(perms.has("status") && t.id === "fake-bar" ? { showing: "Bingo · TEST" } : {}) }));
  if (perms.has("status")) cat.games = edits.games ?? [{ id: "bingo", name: "Bingo", kind: "game", rooms: 1 }, { id: "menu", name: "Menu", kind: "app", rooms: 0 }];
  return cat;
}

/** SDK 0.13.0: the mock box's pretend sound outputs. */
export const MOCK_OUTPUTS: readonly AudioOutput[] = [
  { id: "box:0-0", name: "Box headphone jack (fake)", kind: "box", available: true, default: true, volume: 60 },
  { id: "bt:00:11:22:33:44:55", name: "Patio speaker (fake Bluetooth)", kind: "bluetooth", available: true, default: false, volume: 60 },
  { id: "tv:fake-bar", name: "Bar (fake TV, AirPlay)", kind: "tv", available: true, default: false, volume: 60, detail: "Over AirPlay. Stops anything the box is casting to this TV while it plays" },
];

/** Pretend playback with the real box's rules: one session per output, the app's file fetched with its token. */
class MockAudio {
  private sessions: (AudioSession & { playedMs: number; resumedAt?: number })[] = [];
  private volumes = new Map<string, number>();
  constructor(private readonly gameUrl: string) {}

  private pos(s: (typeof this.sessions)[number]): number {
    return s.playedMs + (s.resumedAt ? Date.now() - s.resumedAt : 0);
  }
  private view(s: (typeof this.sessions)[number]): AudioSession {
    const { playedMs: _p, resumedAt: _r, ...v } = s;
    return { ...v, positionMs: Math.round(s.state === "ended" || s.state === "error" ? s.positionMs : this.pos(s)) };
  }
  private tick() {
    const now = Date.now();
    for (const s of this.sessions) {
      if ((s.state === "playing" || s.state === "starting") && this.pos(s) >= (s.durationMs ?? 30_000)) {
        s.positionMs = s.durationMs ?? 30_000;
        s.state = "ended";
        s.endReason = "finished";
        s.endedAt = new Date().toISOString();
        s.resumedAt = undefined;
        console.log(`${c.ok("audio")} ended: ${s.title ?? s.id}`);
      }
    }
    this.sessions = this.sessions.filter((s) => !s.endedAt || now - Date.parse(s.endedAt) < 60_000);
  }
  private live(id: string) {
    return this.sessions.find((s) => s.id === id && s.state !== "ended" && s.state !== "error");
  }
  private end(s: (typeof this.sessions)[number], state: "ended" | "error", message: string, reason: AudioEndReason) {
    s.positionMs = Math.round(this.pos(s));
    s.state = state;
    s.endReason = reason;
    s.message = message;
    s.endedAt = new Date().toISOString();
    s.resumedAt = undefined;
  }

  async handle(req: IncomingMessage, json: (status: number, body: unknown) => void): Promise<void> {
    this.tick();
    const url = (req.url ?? "").split("?")[0];
    const outputs = () => MOCK_OUTPUTS.map((x) => ({ ...x, volume: this.volumes.get(x.id) ?? x.volume }));
    if (url === AUDIO_PATHS.outputs && req.method === "GET") return json(200, outputs());
    if (url === AUDIO_PATHS.sessions && req.method === "GET") return json(200, this.sessions.map((s) => this.view(s)));
    if (url === AUDIO_PATHS.play && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}") as Partial<AudioPlayOptions>;
      if (typeof b.path !== "string" || !b.path.startsWith("/") || b.path.startsWith("//")) return json(400, { error: "path: a path on your own server, like /tracks/12.mp3" });
      const out = b.output ? MOCK_OUTPUTS.find((x) => x.id === b.output) : MOCK_OUTPUTS[0];
      if (!out) return json(404, { error: "no such output" });
      const old = this.sessions.find((s) => s.output === out.id && this.live(s.id));
      if (old) this.end(old, "ended", `Replaced by something else on ${out.name}.`, "replaced");
      const s: (typeof this.sessions)[number] = {
        id: Math.random().toString(16).slice(2, 18),
        output: out.id,
        owner: "app:dev",
        state: "starting",
        positionMs: 0,
        startedAt: new Date().toISOString(),
        playedMs: 0,
        ...(b.title ? { title: String(b.title).slice(0, 120) } : {}),
        ...(b.artist ? { artist: String(b.artist).slice(0, 120) } : {}),
        ...(b.album ? { album: String(b.album).slice(0, 120) } : {}),
        ...(typeof b.durationMs === "number" && b.durationMs > 0 ? { durationMs: Math.round(b.durationMs) } : {}),
      };
      this.sessions.push(s);
      // Like the box: fetch the file from the app, with its token, and fail the session if it can't.
      const ctrl = new AbortController();
      fetch(new URL(b.path, this.gameUrl), { headers: { authorization: `Bearer ${DEV_TOKEN}`, "x-bargames-audio": "1", range: "bytes=0-" }, signal: ctrl.signal })
        .then((r) => {
          ctrl.abort();
          if (!r.ok) {
            console.log(c.bad(`✗ audio: GET ${b.path} answered ${r.status}; the box couldn't play it`));
            return this.end(s, "error", r.status === 404 ? "Couldn't play that audio: the app's audio file wasn't found." : "Couldn't play that audio: the app refused the box's request for its audio.", "error");
          }
          if (s.state === "starting") {
            s.state = "playing";
            s.resumedAt = Date.now();
          }
          console.log(`${c.ok("audio")} playing ${s.title ?? b.path} on ${out.name} (${r.headers.get("content-type") ?? "no content-type"}, pretend ${Math.round((s.durationMs ?? 30_000) / 1000)} s)`);
        })
        .catch(() => {
          console.log(c.bad(`✗ audio: couldn't reach ${b.path} on your app (${this.gameUrl})`));
          this.end(s, "error", "Couldn't play that audio: the app didn't answer.", "error");
        });
      return json(200, this.view(s));
    }
    const m = /^\/internal\/audio\/sessions\/([^/]+)\/(pause|resume|stop)$/.exec(url);
    if (m && req.method === "POST") {
      const s = this.sessions.find((x) => x.id === decodeURIComponent(m[1]));
      if (!s) return json(404, { error: "no such session" });
      if (!this.live(s.id)) return json(409, { error: "That has finished playing." });
      if (m[2] === "pause" && s.state !== "paused") {
        s.playedMs = this.pos(s);
        s.resumedAt = undefined;
        s.state = "paused";
      } else if (m[2] === "resume" && s.state === "paused") {
        s.resumedAt = Date.now();
        s.state = "playing";
      } else if (m[2] === "stop") this.end(s, "ended", "Stopped.", "stopped");
      console.log(`${c.ok("audio")} ${m[2]}: ${s.title ?? s.id}`);
      return json(200, this.view(s));
    }
    const v = /^\/internal\/audio\/outputs\/([^/]+)\/volume$/.exec(url);
    if (v && req.method === "PUT") {
      const id = decodeURIComponent(v[1]);
      const out = MOCK_OUTPUTS.find((x) => x.id === id);
      if (!out) return json(404, { error: "no such output" });
      if (!this.sessions.some((s) => s.output === id && this.live(s.id))) return json(403, { error: "Only the app playing on an output can change its volume." });
      const volume = Number(JSON.parse((await readBody(req)) || "{}").volume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 100) return json(400, { error: "volume: 0-100" });
      this.volumes.set(id, Math.round(volume));
      console.log(`${c.ok("audio")} volume ${Math.round(volume)} on ${out.name}`);
      return json(200, outputs().find((x) => x.id === id));
    }
    return json(404, { error: `mock box: no ${req.method} ${url}` });
  }
}

export function mockBox(o: MockBoxOptions) {
  let countdown: Countdown | undefined;
  /** What the fake Roku (fake-bar) shows: "home" until a launch. */
  let fakeRokuApp = "home";
  const base = normalizeBasePath(o.basePath);
  const origin = `http://localhost:${o.gatewayPort}`;
  /** What the game is told its address is (--public-url), else the mock gateway's. */
  /** The mock gateway's own address: every link that must open on this machine. */
  const localUrl = origin + base;
  const publicUrl = o.publicUrl ? o.publicUrl.replace(/\/+$/, "") : localUrl;
  const declared = new Set(o.manifest?.events ?? []);
  // SDK 0.13.1: integration test controls (MOCK_INTEGRATION_PATH).
  const perms = new Set<string>(o.manifest && isIntegration(o.manifest) ? (o.manifest.integration?.permissions ?? []) : []);
  let catalogEdits: Partial<Pick<IntegrationCatalog, "scenes" | "tvs" | "games">> = {};
  let lastReport: IntegrationReport | undefined;
  const streams = new Set<{ send: (m: IntegrationMessage) => void; drop: () => void }>();
  const catalog = () => mockCatalog(perms, catalogEdits);
  const broadcast = (m: IntegrationMessage) => {
    for (const st of streams) st.send(m);
  };
  /** fake TV id -> room code it shows. */
  const showing = new Map<string, string>();
  let pinFailures = 0;

  const gameRooms = async (): Promise<GameStatus> =>
    fetch(new URL(PATHS.status, o.gameUrl), { headers: { authorization: `Bearer ${DEV_TOKEN}` }, signal: AbortSignal.timeout(3000) })
      .then((r) => r.json() as Promise<GameStatus>)
      .catch(() => ({ rooms: [] }));

  /** Same rules as the real box: casting on, the PIN when set, 5 wrong PINs -> 429. */
  const castGate = (pin: unknown): [number, string] | undefined => {
    if (o.castFromGames === false) return [403, "casting from games is turned off at this venue"];
    if (!o.tvPin) return undefined;
    if (pinFailures >= 5) return [429, "too many wrong PINs, try again in a minute"];
    if (typeof pin !== "string" || !pin) return [403, "TV PIN required"];
    if (pin !== o.tvPin) {
      pinFailures++;
      return [403, "wrong TV PIN"];
    }
    pinFailures = 0;
    return undefined;
  };
  const pinReset = setInterval(() => (pinFailures = 0), 60_000);
  pinReset.unref();
  const mockAudio = new MockAudio(o.gameUrl);

  // Fake core: what the SDK inside the game talks to (BG_CORE_URL).
  const core = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${DEV_TOKEN}`) {
      console.log(c.bad(`✗ core: ${req.method} ${req.url} with a wrong/missing token (expected BG_GAME_TOKEN=${DEV_TOKEN})`));
      return json(401, { error: "bad game token" });
    }
    if (req.url === "/internal/venue-password" && req.method === "POST") {
      const { password } = JSON.parse((await readBody(req)) || "{}") as { password?: string };
      const ok = password === (o.venuePassword ?? "box-password");
      console.log(`${ok ? c.ok("box password accepted") : c.warn("box password refused")} (bg.checkVenuePassword)`);
      return json(200, { ok });
    }
    // SDK 0.9.0
    if (req.url === "/internal/attention" && req.method === "POST") {
      const { items } = JSON.parse((await readBody(req)) || "{}") as { items?: { level: string; message: string }[] };
      console.log(`${c.warn("attention")} ${(items ?? []).length ? (items ?? []).map((i) => `[${i.level}] ${i.message}`).join(" · ") : "(cleared)"}`);
      return json(200, { ok: true, count: (items ?? []).length });
    }
    if (req.url === "/internal/countdown" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}") as { label?: string; minutes?: number };
      if (!b.label || !(Number(b.minutes) > 0)) return json(400, { error: "label and minutes required" });
      countdown = { id: Date.now().toString(36), label: b.label, endsAt: new Date(Date.now() + Number(b.minutes) * 60_000).toISOString(), gameId: o.gameId, joinUrl: publicUrl };
      console.log(`${c.ok("countdown")} "${b.label}" ${b.minutes} min (in the venue context now)`);
      return json(200, countdown);
    }
    if (req.url === "/internal/countdown" && req.method === "DELETE") {
      countdown = undefined;
      return json(200, { ok: true });
    }
    if (req.url === "/internal/results" && req.method === "POST") {
      const r = JSON.parse((await readBody(req)) || "{}") as { results?: { player?: { name?: string }; place?: number; score?: number }[] };
      if (!Array.isArray(r.results) || !r.results.length || r.results.some((x) => !x?.player?.name)) {
        console.log(c.bad("✗ results: need results: [{ player: { name }, place?, score? }]"));
        return json(400, { error: "results: [{ player: { name }, place?, score? }]" });
      }
      console.log(`${c.ok("results")} ${r.results.map((x) => `${x.place ? `#${x.place} ` : ""}${x.player!.name}${x.score !== undefined ? ` (${x.score})` : ""}`).join(", ")}`);
      return json(200, { ok: true });
    }
    if (req.url === "/internal/tvs" && req.method === "GET") {
      if (!o.manifest?.media) return json(403, { error: "declare media in bargames.json to use this" });
      const launch = o.manifest.media.launch;
      return json(200, {
        tvs: FAKE_TVS.map((t, i) => ({
          id: t.id,
          name: t.name,
          group: t.group,
          kind: i === 0 ? "roku" : "airplay",
          online: !t.unpaired,
          canLaunch: i === 0 ? launch.filter((a) => a === "youtube") : [],
          ...(i === 0 && launch.includes("youtube") ? { youtubeScreenId: "fake-screen-id-bar" } : {}),
          // SDK 0.10.4: the fake Roku starts on its home screen; a launch puts the app up.
          ...(i === 0 ? { activeApp: fakeRokuApp } : {}),
        })),
      });
    }
    if (req.url === "/internal/launch-app" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}") as { displayId?: string; app?: string };
      if (!o.manifest?.media?.launch.includes(String(b.app))) return json(200, { ok: false, reason: "not-allowed", message: `${b.app} isn't in media.launch` });
      if (b.displayId !== FAKE_TVS[0].id) return json(200, { ok: false, reason: "unsupported", message: "only the fake Roku (fake-bar) can start apps" });
      console.log(`${c.ok("launch")} ${b.app} on ${b.displayId} (pretend)`);
      fakeRokuApp = String(b.app);
      return json(200, { ok: true });
    }
    // SDK 0.13.0: audio. Pretend outputs; "playing" runs in real time (durationMs, else 30 s).
    if (req.url?.startsWith("/internal/audio/")) {
      if (!o.manifest?.audio?.play) {
        console.log(c.bad(`✗ ${req.method} ${req.url}: add "audio": { "play": true } to bargames.json`));
        return json(403, { error: 'This app didn\'t ask to play sound: add "audio": { "play": true } to bargames.json.' });
      }
      return mockAudio.handle(req, json);
    }
    // SDK 0.12.0: integrations. Everything they declare counts as approved here.
    if (req.url?.startsWith("/internal/integration/")) {
      if (!o.manifest || !isIntegration(o.manifest)) return json(401, { error: 'not an integration (kind "integration" in bargames.json)' });
      const need = (p: string) => {
        if (perms.has(p)) return false;
        console.log(c.bad(`✗ ${req.method} ${req.url}: needs the "${p}" permission in integration.permissions`));
        json(403, { error: `the venue hasn't allowed "${p}" for this integration` });
        return true;
      };
      const url = req.url.split("?")[0];
      if (url === INTEGRATION_PATHS.catalog && req.method === "GET") return json(200, catalog());
      if (url === INTEGRATION_PATHS.stream && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const send = (m: IntegrationMessage) => res.write(`data: ${JSON.stringify(m)}\n\n`);
        const st = { send, drop: () => res.end() };
        streams.add(st);
        send({ type: "hello", catalog: catalog() });
        console.log(`${c.ok("stream")} connected; a pretend game event every 30 s, a TV going on/offline every 60 s`);
        let n = 0;
        const t = setInterval(() => {
          n++;
          if (perms.has("events")) send({ type: "event", event: { type: n % 2 ? "round_started" : "winner", gameId: "bingo", roomCode: "TEST", data: n % 2 ? { round: n } : { name: "Sam" }, at: new Date().toISOString() } });
          if (n % 2 === 0) {
            fakePatioOnline = !fakePatioOnline;
            send({ type: "catalog", catalog: catalog() });
          }
        }, 30_000);
        req.on("close", () => {
          clearInterval(t);
          streams.delete(st);
        });
        return;
      }
      if (url === INTEGRATION_PATHS.report && req.method === "PUT") {
        const r = JSON.parse((await readBody(req)) || "{}") as IntegrationReport;
        if (!["setup", "ok", "warn", "error"].includes(r.state)) return json(400, { error: "state: setup, ok, warn or error" });
        if (r.pairing?.expiresAt !== undefined && !Number.isFinite(Date.parse(r.pairing.expiresAt))) console.log(c.bad(`✗ report: pairing.expiresAt "${r.pairing.expiresAt}" isn't an ISO time; the box ignores it`));
        lastReport = r;
        if (r.pairing?.expiresAt) console.log(`${c.dim(`    pairing code expires ${r.pairing.expiresAt}`)}`);
        if (r.actions?.length) console.log(c.dim(`    buttons: ${r.actions.map((a) => a.id).join(", ")} (press one: curl -X POST ${origin}${MOCK_INTEGRATION_PATH}/action/<id>)`));
        console.log(`${c.ok("report")} [${r.state}] ${r.message ?? ""}${r.pairing ? `\n    pairing: ${[r.pairing.qr, r.pairing.code].filter(Boolean).join(" · ")}` : ""}${(r.details ?? []).map((d) => `\n    ${d.label}: ${d.value}`).join("")}`);
        return json(200, { ok: true });
      }
      const scene = /^\/internal\/integration\/scenes\/([^/]+)\/run$/.exec(url);
      if (scene && req.method === "POST") {
        if (need("scenes")) return;
        const id = decodeURIComponent(scene[1]);
        if (!MOCK_SCENES.some((s) => s.id === id)) return json(404, { error: `no scene ${id}` });
        console.log(`${c.ok("scene")} ${id} ran (pretend)`);
        return json(200, { ok: true, steps: [{ step: `pretend scene ${id}`, ok: true }] });
      }
      const power = /^\/internal\/integration\/tvs\/([^/]+)\/power$/.exec(url);
      if (power && req.method === "POST") {
        if (need("tvs")) return;
        const id = decodeURIComponent(power[1]);
        const { on } = JSON.parse((await readBody(req)) || "{}") as { on?: unknown };
        if (typeof on !== "boolean") return json(400, { error: "on: true or false" });
        const tv = FAKE_TVS.find((t) => t.id === id);
        if (!tv) return json(404, { error: `no TV ${id}` });
        if (tv.unpaired) return json(400, { error: `${tv.name} can't be switched on or off by the box` });
        console.log(`${c.ok("TV power")} ${id} ${on ? "on" : "off"} (pretend)`);
        return json(200, { ok: true });
      }
      return json(404, { error: "not found" });
    }
    if (req.url?.startsWith("/internal/profiles")) return json(501, { error: "player profiles aren't built yet" });
    if (req.url === "/internal/venue") {
      const ctx = mockContext(o.gameId, o.displayName, localUrl, { announcement: o.announcement, announcementShow: o.announcementShow, announcementPosition: o.announcementPosition, app: o.manifest ? isApp(o.manifest) : false });
      // --public-url: the game's own address is the pretend venue one; box links stay local.
      if (publicUrl !== localUrl) {
        ctx.game.publicUrl = publicUrl;
        for (const g of [...(ctx.venue.games ?? []), ...(ctx.venue.apps ?? []), ...(ctx.venue.modules ?? [])]) if (g.id === o.gameId) g.url = publicUrl;
      }
      if (countdown && Date.parse(countdown.endsAt) > Date.now()) ctx.venue.countdown = countdown;
      return json(200, ctx);
    }
    if (req.url === "/internal/displays" && req.method === "GET") {
      if (o.castFromGames === false) return json(200, { enabled: false, pinRequired: false, displays: [] } satisfies CastTargets);
      const displays: CastDisplay[] = FAKE_TVS.map((t) => ({ id: t.id, name: t.name, group: t.group, busy: showing.has(t.id), showingThisGame: showing.has(t.id), roomCode: showing.get(t.id) }));
      return json(200, { enabled: true, pinRequired: Boolean(o.tvPin), displays } satisfies CastTargets);
    }
    if ((req.url === "/internal/cast" || req.url === "/internal/cast/stop") && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { roomCode?: unknown; displayIds?: unknown; pin?: unknown };
      const gate = castGate(body.pin);
      if (gate) {
        console.log(c.warn(`! cast refused: ${gate[1]}`));
        return json(gate[0], { error: gate[1] });
      }
      const ids = Array.isArray(body.displayIds) ? body.displayIds.map(String) : [];
      if (!ids.length) return json(400, { error: "pick at least one TV" });
      const results: Record<string, { ok: boolean; message?: string }> = {};
      if (req.url === "/internal/cast/stop") {
        for (const id of ids) {
          if (showing.delete(id)) console.log(`${c.ok("TV off")} ${id}`);
          results[id] = { ok: true };
        }
        return json(200, { ok: true, results });
      }
      const room = body.roomCode;
      if (!o.manifest?.routes.table) return json(400, { error: "this game has no TV view (routes.table in bargames.json)" });
      const display = isApp(o.manifest);
      if (!display) {
        if (typeof room !== "string" || !room) return json(400, { error: "roomCode required" });
        if (!(await gameRooms()).rooms?.some((r) => r.code === room)) {
          console.log(c.bad(`✗ cast: room ${room} isn't in your status; the box only casts rooms the game lists`));
          return json(404, { error: `no room ${room}` });
        }
      }
      // Apps have no rooms: the box casts their TV view as is.
      const url = joinUrl(localUrl, display ? o.manifest.routes.table : tableUrl(o.manifest, room as string)!);
      for (const id of ids) {
        const tv = FAKE_TVS.find((t) => t.id === id);
        if (!tv) {
          results[id] = { ok: false, message: "no such TV" };
          continue;
        }
        if (tv.unpaired) {
          (results as Record<string, { ok: boolean; message?: string; needsCode?: boolean }>)[id] = { ok: false, needsCode: true, message: `${tv.name} is showing an AirPlay code. Enter it under TVs (needed once per TV).` };
          console.log(`${c.warn("TV needs pairing")} ${id} (what an unpaired TV answers)`);
          continue;
        }
        showing.set(id, typeof room === "string" && room ? room : o.gameId);
        results[id] = { ok: true };
        console.log(`${c.ok("TV cast")} ${id} → ${url}`);
      }
      const failed = Object.values(results).filter((r) => !r.ok).length;
      return json(200, { ok: failed === 0, message: failed ? `${failed} TV(s) didn't start` : undefined, results });
    }
    if (req.url === "/internal/events" && req.method === "POST") {
      const evt = JSON.parse((await readBody(req)) || "{}") as { type?: string; roomCode?: string; sessionKind?: string; data?: unknown };
      const problems: string[] = [];
      if (!evt.type || !(STANDARD_EVENTS as readonly string[]).includes(evt.type) && !/^x-[a-z0-9-]+$/.test(evt.type)) problems.push("type must be a standard event or start with x-");
      // game_result comes from bg.reportResults() itself, so it needn't be declared (SDK 0.11.4).
      if (evt.type && evt.type !== "game_result" && o.manifest && !declared.has(evt.type)) problems.push(`"${evt.type}" isn't listed in bargames.json "events"`);
      if (evt.roomCode !== undefined && typeof evt.roomCode !== "string") problems.push("roomCode must be a string");
      if (evt.sessionKind && !["venue", "patron", "private"].includes(evt.sessionKind)) problems.push("sessionKind must be venue|patron|private");
      const line = `${evt.type} ${c.dim(`room=${evt.roomCode ?? "-"} kind=${evt.sessionKind ?? "-"}`)} ${evt.data ? JSON.stringify(evt.data) : ""}`;
      console.log(problems.length ? c.bad(`✗ event ${line}\n    ${problems.join("\n    ")}`) : `${c.ok("● event")} ${line}`);
      return problems.length ? json(400, { error: problems.join("; ") }) : (res.writeHead(204), res.end());
    }
    json(404, { error: "not found" });
  });

  // Fake gateway: what a browser on the venue LAN goes through.
  const target = new URL(o.gameUrl);
  const forwardHeaders = (req: IncomingMessage): OutgoingHttpHeaders => {
    const h: OutgoingHttpHeaders = { ...req.headers };
    for (const k of Object.values(HEADERS)) delete h[k];
    delete h["cf-connecting-ip"];
    h[HEADERS.via] = "1";
    h[HEADERS.clientIp] = req.socket.remoteAddress ?? "";
    h[HEADERS.access] = "local";
    // Staff sign-in (SDK 0.7.0): the cookie from MOCK_STAFF_PATH becomes the staff header.
    const cookies = String(req.headers.cookie ?? "").split(";").map((c) => c.trim()).filter(Boolean);
    if (cookies.includes(`${MOCK_STAFF_COOKIE}=1`)) h[HEADERS.staff] = "1";
    const rest = cookies.filter((c) => !c.startsWith(`${MOCK_STAFF_COOKIE}=`)).join("; ");
    if (rest) h.cookie = rest;
    else delete h.cookie;
    h["x-forwarded-proto"] = "http";
    h["x-forwarded-for"] = req.socket.remoteAddress ?? "";
    h["x-forwarded-host"] = req.headers.host ?? "";
    return h;
  };
  /** Where a request goes under the prefix: the game's own path, a redirect, or nowhere. */
  const underBase = (url: string): { path?: string; redirect?: string } => {
    if (!base) return { path: url };
    const [p, q] = [url.split("?")[0], url.includes("?") ? url.slice(url.indexOf("?")) : ""];
    if (p === base) return { redirect: `${base}/${q}` };
    if (p === "/") return { redirect: `${base}/` };
    return p.startsWith(base + "/") ? { path: url.slice(base.length) } : {};
  };
  const gateway = createServer((req, res) => {
    // Pretend staff sign-in: what the box's "Settings" link does (no box login to check here).
    // /__bargames/staff?next=/admin signs you in; ?off=1 signs you out.
    const staffPath = req.url?.split("?")[0];
    if (staffPath === PATHS.staff || (base && staffPath === base + PATHS.staff)) {
      const q = new URL(req.url!, "http://x").searchParams;
      const asked = q.get("next")?.startsWith("/") && !q.get("next")!.startsWith("//") ? q.get("next")! : "/";
      // Like the box: a game path without the prefix gets it ("/admin" → "/menu/admin").
      const next = !base || asked === base || asked.startsWith(base + "/") ? asked : base + asked;
      const off = q.get("off") === "1";
      res.writeHead(303, { location: next, "set-cookie": `${MOCK_STAFF_COOKIE}=${off ? "" : "1"}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${off ? 0 : 43200}` });
      console.log(`${c.ok(off ? "staff signed out" : "staff signed in")} (requests now ${off ? "without" : "with"} ${HEADERS.staff}: 1)`);
      return void res.end();
    }
    if (req.url?.split("?")[0].startsWith(MOCK_INTEGRATION_PATH)) return void integrationControl(req, res);
    if (req.url?.split("?")[0] === MOCK_ADMIN_PATH) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end("<!doctype html><meta charset=utf-8><title>Box admin (mock)</title><h1>Box admin (mock)</h1><p>On a real box this is the venue's admin. Your BoxAdminLink works.</p>");
    }
    if (req.url?.split("?")[0] === MOCK_GAMES_PATH) return void mockGamesList(o, localUrl).then((html) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    // Path routing (SDK 0.10.0): like the box, strip the prefix before the game sees the request.
    const routed = underBase(req.url ?? "/");
    if (routed.redirect) {
      res.writeHead(302, { location: routed.redirect });
      return void res.end();
    }
    if (routed.path === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      return void res.end(`mock gateway: the game is served under ${base}/ (started with --base ${base})`);
    }
    const up = request({ host: target.hostname, port: target.port, method: req.method, path: routed.path, headers: forwardHeaders(req) }, (r) => {
      // The game's own redirects ("/admin") get the prefix back, as the box gateway does.
      const loc = r.headers.location;
      if (base && typeof loc === "string" && loc.startsWith("/") && !loc.startsWith("//") && !loc.startsWith(base + "/")) r.headers.location = base + loc;
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`mock gateway: can't reach the game at ${o.gameUrl}. Is it running?`);
    });
    req.pipe(up);
  });
  gateway.on("upgrade", (req, socket, head) => {
    const path = underBase(req.url ?? "/").path;
    if (path === undefined) return void socket.destroy();
    const up = connect(Number(target.port || 80), target.hostname, () => {
      const h = forwardHeaders(req);
      const lines = [`${req.method} ${path} HTTP/1.1`, ...Object.entries(h).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v === undefined ? [] : [`${k}: ${v}`]))];
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });

  /** SDK 0.13.1: MOCK_INTEGRATION_PATH, for testing an integration's reactions. */
  async function integrationControl(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!o.manifest || !isIntegration(o.manifest)) return json(400, { error: 'not an integration (kind "integration" in bargames.json)' });
    const sub = req.url!.split("?")[0].slice(MOCK_INTEGRATION_PATH.length);
    if ((sub === "" || sub === "/") && req.method === "GET") return json(200, { streams: streams.size, report: lastReport ?? null, catalog: catalog() });
    const act = /^\/action\/([^/]+)$/.exec(sub);
    if (act && req.method === "POST") {
      const id = decodeURIComponent(act[1]);
      // Like the box: only buttons from the latest report can be pressed.
      if (!lastReport?.actions?.some((a) => a.id === id)) return json(404, { error: `no button "${id}" in your latest report (actions: ${(lastReport?.actions ?? []).map((a) => a.id).join(", ") || "none"})` });
      if (!streams.size) return json(409, { error: "no stream connected; the press would be lost" });
      broadcast({ type: "action", action: id, at: new Date().toISOString() });
      console.log(`${c.ok("action")} pressed "${id}" (sent on ${streams.size} stream(s))`);
      return json(200, { ok: true, streams: streams.size });
    }
    if (sub === "/drop" && req.method === "POST") {
      const n = streams.size;
      for (const st of [...streams]) st.drop();
      streams.clear();
      console.log(`${c.warn("stream dropped")} ${n} stream(s) closed, as when the box restarts; your integration should reconnect`);
      return json(200, { ok: true, dropped: n });
    }
    if (sub === "/catalog" && (req.method === "PUT" || req.method === "DELETE")) {
      if (req.method === "DELETE") catalogEdits = {};
      else {
        let b: Record<string, unknown>;
        try {
          b = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        } catch {
          return json(400, { error: "body: JSON { scenes?, tvs?, games? }" });
        }
        const next = { ...catalogEdits };
        for (const k of ["scenes", "tvs", "games"] as const) {
          if (b[k] === undefined) continue;
          if (!Array.isArray(b[k]) || (b[k] as unknown[]).some((x) => !x || typeof x !== "object" || typeof (x as { id?: unknown }).id !== "string" || typeof (x as { name?: unknown }).name !== "string")) {
            return json(400, { error: `${k}: an array of objects with id and name` });
          }
          (next as Record<string, unknown>)[k] = b[k];
        }
        catalogEdits = next;
      }
      broadcast({ type: "catalog", catalog: catalog() });
      console.log(`${c.ok("catalog")} ${req.method === "DELETE" ? "back to the pretend lists" : "edited"} (sent on ${streams.size} stream(s))`);
      return json(200, catalog());
    }
    json(404, { error: `mock box: no ${req.method} ${MOCK_INTEGRATION_PATH}${sub}` });
  }

  core.listen(o.corePort, "127.0.0.1");
  gateway.listen(o.gatewayPort);
  core.on("close", () => clearInterval(pinReset));
  return { core, gateway, publicUrl: localUrl, venueUrl: publicUrl, showing };
}

/** What the real games list shows for this game: its open rooms and their Join links. */
async function mockGamesList(o: MockBoxOptions, publicUrl: string): Promise<string> {
  if (o.manifest && isApp(o.manifest)) {
    const e = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Games (mock box)</title>
<body style="font-family:system-ui;max-width:520px;margin:24px auto;padding:0 16px"><h1>Test Venue (mock)</h1>
<p>The real box lists apps apart from the games, as a link.</p>
<p><a href="${e(publicUrl)}">${e(o.displayName)}</a></p>
<h2 id="other-game">Other Game (fake)</h2><p>A pretend game.</p></body>`;
  }
  const st = await fetch(new URL(PATHS.status, o.gameUrl), { headers: { authorization: `Bearer ${DEV_TOKEN}` }, signal: AbortSignal.timeout(3000) })
    .then((r) => r.json() as Promise<GameStatus>)
    .catch(() => ({ rooms: [] }) as GameStatus);
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const rooms = (st.rooms ?? []).filter((r) => r.kind !== "private");
  const items = rooms
    .map((r) => `<li>${esc(r.code)} · ${r.players} player(s)${r.joinPath ? ` · <a href="${esc(joinUrl(publicUrl, r.joinPath))}">Join</a>` : " · <i>no joinPath, so no Join link</i>"}</li>`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Games (mock box)</title>
<body style="font-family:system-ui;max-width:520px;margin:24px auto;padding:0 16px"><h1>Test Venue: games (mock)</h1>
<p>The real box shows this list at the venue's play address. "← All games" links land here.</p>
<h2><a href="${esc(publicUrl)}">${esc(o.displayName)}</a></h2><ul>${items || "<li>No open rooms</li>"}</ul>
<h2 id="other-game">Other Game (fake)</h2><p>A pretend second game for "Also playing".</p></body>`;
}

// ---------------------------------------------------------------- command / status

export async function callGame(gameUrl: string, p: string, body?: unknown, token = DEV_TOKEN): Promise<{ status: number; body: unknown }> {
  const res = await fetch(new URL(p, gameUrl), {
    method: body ? "POST" : "GET",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------- check

/**
 * Conformance checks against a running game started with the mock-box env
 * (BG_CORE_URL, BG_GAME_TOKEN=dev-token). Returns false if any check failed.
 */
export async function check(manifest: GameManifest, gameUrl: string, opts: { room?: string; live?: boolean } = {}): Promise<boolean> {
  let onMock = false;
  let failed = 0;
  const pass = (m: string) => console.log(`${c.ok("✓")} ${m}`);
  const fail = (m: string, hint?: string) => {
    failed++;
    console.log(`${c.bad("✗")} ${m}${hint ? `\n    ${c.dim(hint)}` : ""}`);
  };
  const warn = (m: string) => console.log(`${c.warn("!")} ${m}`);
  const level = manifest.sdk.level;
  console.log(c.b(`${manifest.id}@${manifest.version} · level ${level} · ${gameUrl}`));

  const health = await callGame(gameUrl, manifest.health, undefined, "").catch((e: Error) => ({ status: 0, body: e.message }));
  if (health.status === 0) {
    fail(`game not reachable at ${gameUrl}`, `start it with the env printed by "bargames mock-box"`);
    return false;
  }
  health.status === 200 ? pass(`health ${manifest.health} → 200`) : fail(`health ${manifest.health} → ${health.status}`, "the box restarts games whose health check fails");

  if (level >= 1) {
    const v = await callGame(gameUrl, PATHS.venue, undefined, "");
    const ctx = v.body as VenueContext;
    if (v.status !== 200 || typeof ctx !== "object") fail(`${PATHS.venue} → ${v.status}`, "mount bg.middleware() before your routes (and before any SPA catch-all)");
    else if (ctx.standalone) fail(`${PATHS.venue} says standalone`, "start the game with BG_CORE_URL / BG_GAME_TOKEN from mock-box");
    else if (ctx.game.displayName.includes("(mock)")) {
      onMock = true;
      pass(`${PATHS.venue} returns the box's branding ("${ctx.game.displayName}")`);
    }
    else warn(`${PATHS.venue} returned "${ctx.game.displayName}" (expected the mock's name; is BG_CORE_URL pointing at mock-box?)`);
    const css = await callGame(gameUrl, PATHS.themeCss, undefined, "");
    css.status === 200 && String(css.body).includes("--venue-bg") ? pass(`${PATHS.themeCss} served`) : fail(`${PATHS.themeCss} → ${css.status}`);
  }

  if (isApp(manifest)) {
    // Apps: a phone page and (usually) a TV view, no rooms. Room checks don't apply.
    if (manifest.media && level >= 3) await checkMedia();
    for (const [what, p] of [["phone page (routes.player)", manifest.routes.player], ["TV view (routes.table)", manifest.routes.table]] as const) {
      if (!p) continue;
      const page = await callGame(gameUrl, p, undefined, "").catch(() => ({ status: 0, body: "" }));
      page.status === 200 ? pass(`${what} ${p} → 200`) : fail(`${what} ${p} → ${page.status}`);
    }
    if (manifest.sdk.level < 1) warn("apps should be level 1, so they get the venue's theme, location and time zone");
    console.log(failed ? c.bad(`\n${failed} check(s) failed`) : c.ok("\nall checks passed"));
    return failed === 0;
  }

  if (level >= 2 && manifest.events.length === 0) warn(`level ${level} but "events" is empty in bargames.json`);
  if (level >= 2 && manifest.routes.table) {
    manifest.events.includes("room_closed")
      ? pass(`"room_closed" declared (the box takes a closed room off the TVs at once)`)
      : fail(`"room_closed" isn't in bargames.json "events"`, "castable games must emit it when a room closes, so the box can clear its TVs right away");
  }

  if (level >= 3) {
    const anon = await callGame(gameUrl, PATHS.status, undefined, "");
    anon.status === 401 ? pass("status refuses requests without the game token") : fail(`status without token → ${anon.status} (must be 401)`);
    const st = await callGame(gameUrl, PATHS.status);
    const rooms = (st.body as { rooms?: unknown })?.rooms;
    if (st.status === 200 && Array.isArray(rooms)) {
      pass(`status → ${rooms.length} room(s)`);
      for (const r of rooms as Record<string, unknown>[]) {
        if (typeof r.code !== "string" || typeof r.players !== "number" || !["venue", "patron", "private"].includes(String(r.kind))) {
          fail(`room summary ${JSON.stringify(r)} needs code (string), kind (venue|patron|private), players (number)`);
          break;
        }
        if (r.joinPath !== undefined && (typeof r.joinPath !== "string" || !r.joinPath.startsWith("/") || r.joinPath.startsWith("//"))) {
          fail(`room ${String(r.code)}: joinPath must be a path on the game's address, like "/join/${String(r.code)}"`);
          break;
        }
        if (r.pendingClaims !== undefined && (!Array.isArray(r.pendingClaims) || r.pendingClaims.some((x) => typeof (x as { id?: unknown })?.id !== "string"))) {
          fail(`room ${String(r.code)}: pendingClaims must be an array of { id: string, player?, detail?, at? }`);
          break;
        }
      }
      const open = (rooms as Record<string, unknown>[]).filter((r) => r.kind !== "private");
      if (open.length && open.every((r) => r.joinPath === undefined)) warn(`no joinPath on your rooms: the venue's games list can't show "Join" links (SDK 0.4.0)`);
    } else fail(`status → ${st.status}`, "call bg.setStatusProvider(() => ({ rooms: [...] }))");
    const bogus = await callGame(gameUrl, PATHS.command, { command: "definitely-not-a-command" });
    bogus.status === 404 ? pass("unknown commands are rejected") : fail(`unknown command → ${bogus.status} (expected 404)`);
    if (!manifest.commands.length) fail("level 3 needs at least one command in bargames.json");
    const claims = ["confirm_claim", "reject_claim"].filter((x) => manifest.commands.includes(x));
    if (claims.length === 1) warn(`"${claims[0]}" without its partner: staff need both to resolve a claim`);
    if (claims.length && !manifest.events.includes("claim_pending")) warn(`claim commands but no "claim_pending" event: the box won't know a claim is waiting`);
    if (!manifest.commands.includes("create_room")) warn(`no "create_room" command: staff can't put this game on the TVs without a room code from a phone`);
    for (const cmd of manifest.commands) {
      if (cmd === "create_room") continue; // creates instead of refusing; checked below
      const r = await callGame(gameUrl, PATHS.command, { command: cmd, roomCode: "ZZZZ-NO-SUCH-ROOM" });
      const ok = r.status === 200 && (r.body as { ok?: boolean })?.ok === false;
      ok ? pass(`command "${cmd}" is wired (and refuses a missing room)`) : fail(`command "${cmd}" → ${r.status} ${JSON.stringify(r.body)}`, `bg.onCommand("${cmd}", …) must return { ok: false, message } for an unknown room`);
    }
  }

  // SDK 0.9.0: media providers (games and apps).
  async function checkMedia() {
    const st = await callGame(gameUrl, PATHS.status);
    const media = (st.body as { media?: { targets?: unknown } })?.media;
    if (media === undefined) warn("media provider: status has no media.targets yet (fine until a TV is mapped)");
    else if (!Array.isArray(media.targets)) fail("status.media.targets must be an array of { displayId, label, state }");
    else pass(`status.media.targets → ${media.targets.length} TV(s)`);
    const list = await callGame(gameUrl, PATHS.command, { command: "media_list" });
    const items = ((list.body as { data?: { items?: MediaItem[] } })?.data?.items ?? undefined) as MediaItem[] | undefined;
    if (list.status === 200 && Array.isArray(items) && items.every((i) => typeof i.id === "string" && (i.kind === "list" || i.kind === "plan"))) pass(`media_list → ${items.length} item(s)`);
    else fail(`media_list → ${list.status} ${JSON.stringify(list.body).slice(0, 120)}`, "bg.onMediaList(() => [{ id, name, kind: \"list\" | \"plan\" }])");
    for (const cmd of ["media_play", "media_stop"]) if (!manifest.commands.includes(cmd)) fail(`"${cmd}" isn't in bargames.json "commands"`);
  }
  if (manifest.media && level >= 3 && !isApp(manifest)) await checkMedia();

  // Creating rooms on a live game by mistake: only against the mock box's game unless --live.
  const roomsOk = onMock || opts.live === true;
  if (!roomsOk && level >= 3 && manifest.commands.includes("create_room")) {
    warn(`skipping create_room/end: ${gameUrl} isn't connected to the mock box (a live game?). Point --game at your mock-box game, or pass --live to run them anyway`);
  }
  if (roomsOk && level >= 3 && manifest.commands.includes("create_room")) {
    const r = await callGame(gameUrl, PATHS.command, { command: "create_room", args: { kind: "venue", purpose: "display" } });
    const res = r.body as { ok?: boolean; data?: { roomCode?: unknown; hostUrl?: unknown }; message?: string };
    const code = res?.data?.roomCode;
    if (r.status !== 200 || !res?.ok || typeof code !== "string" || !code) {
      fail(`create_room → ${r.status} ${JSON.stringify(r.body)}`, "bg.onCreateRoom(() => ({ roomCode })) must create a room and return its code");
    } else {
      pass(`create_room → room ${code}${typeof res.data?.hostUrl === "string" ? " (with hostUrl)" : ""}`);
      const st = await callGame(gameUrl, PATHS.status);
      const listed = ((st.body as { rooms?: { code: string; kind: string }[] })?.rooms ?? []).find((x) => x.code === code);
      if (!listed) fail(`room ${code} isn't in status`, "status must list rooms the box created");
      else listed.kind === "venue" ? pass(`status lists ${code} as a venue room`) : fail(`room ${code} has kind "${listed.kind}" (expected "venue")`);
      const table = tableUrl(manifest, code);
      if (table) {
        const page = await callGame(gameUrl, table, undefined, "").catch(() => ({ status: 0, body: "" }));
        page.status === 200 ? pass(`table view ${table} → 200`) : fail(`table view ${table} → ${page.status}`);
      }
      if (manifest.commands.includes("end")) {
        const end = await callGame(gameUrl, PATHS.command, { command: "end", roomCode: code });
        (end.body as { ok?: boolean })?.ok ? pass(`end closes ${code}`) : fail(`end ${code} → ${JSON.stringify(end.body)}`);
        const after = await callGame(gameUrl, PATHS.status);
        const still = ((after.body as { rooms?: { code: string }[] })?.rooms ?? []).some((x) => x.code === code);
        still ? fail(`room ${code} is still in status after "end"`, "a closed room must leave status (and emit room_closed)") : pass(`${code} left status after "end"`);
      }
    }
  }

  if (opts.room) {
    const st = await callGame(gameUrl, PATHS.status);
    const r = ((st.body as { rooms?: Record<string, unknown>[] })?.rooms ?? []).find((x) => x.code === opts.room);
    if (!r) fail(`--room ${opts.room}: not in status`);
    else {
      pass(`--room ${opts.room}: ${JSON.stringify(r)}`);
      const claims = r.pendingClaims;
      if (claims === undefined) warn(`--room ${opts.room}: no pendingClaims (make a claim in that room first to test them)`);
      else if (Array.isArray(claims) && claims.every((x) => typeof (x as { id?: unknown })?.id === "string")) pass(`--room ${opts.room}: ${claims.length} pending claim(s), shape ok`);
      else fail(`--room ${opts.room}: pendingClaims must be [{ id: string, player?, detail?, at? }]`);
      for (const k of ["createdAt", "lastActivityAt"] as const) {
        if (r[k] !== undefined && Number.isNaN(Date.parse(String(r[k])))) fail(`--room ${opts.room}: ${k} must be an ISO time`);
      }
      const table = tableUrl(manifest, opts.room);
      if (table) {
        const page = await callGame(gameUrl, table, undefined, "").catch(() => ({ status: 0, body: "" }));
        page.status === 200 ? pass(`table view ${table} → 200`) : fail(`table view ${table} → ${page.status}`);
      }
    }
  }

  console.log(failed ? c.bad(`\n${failed} check(s) failed`) : c.ok("\nall checks passed"));
  return failed === 0;
}
