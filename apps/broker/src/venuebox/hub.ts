// The broker side of Venuebox clients: the pairing HTTP endpoints, the WebSocket control
// channel, and a DisplayDriver ("venuebox") so each paired screen is a display like a Roku.

import type { Logger } from "@bargames/common";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Capabilities, DisplayContent, DisplayDevice, DisplayDriver, Health, ShowResult, StreamState } from "../types.js";
import { type Device, type DeviceStore, type Pairings } from "./devices.js";
import { checkScreens, CLIENT_PROTOCOL, CLOSE, type BoxMsg, type ClientMsg, type Delivery, type Screen } from "./protocol.js";

export const DRIVER_ID = "venuebox";
export const displayId = (deviceId: string, screenId: string) => `${DRIVER_ID}:${deviceId}:${screenId}`;

interface Session {
  ws: WebSocket;
  device: Device;
  screens: Screen[];
  deliveries: Delivery[];
  /** Last state each screen reported. */
  state: Map<string, { showing: string; status: string; detail?: string }>;
  previews: Map<string, (jpeg: Buffer | undefined) => void>;
  alive: boolean;
}

export interface HubDeps {
  devices: DeviceStore;
  pairings: Pairings;
  log: Logger;
  boxName: () => string;
  /** The displays changed (device paired, screens plugged/unplugged, revoked): merge them. */
  displaysChanged: (devices: DisplayDevice[], removedIds: string[]) => Promise<void>;
  /** A device (re)connected: put back what its screens were showing. */
  reconnected: (displayIds: string[]) => void;
}

export class VenueboxHub implements DisplayDriver {
  readonly id = DRIVER_ID;
  private readonly sessions = new Map<string, Session>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  private pinger?: NodeJS.Timeout;

  constructor(private readonly d: HubDeps) {}

  // ---------------------------------------------------------------- HTTP + WebSocket

  listen(port: number, host = "0.0.0.0"): Server {
    const server = createServer((req, res) => void this.http(req, res).catch((err) => this.send(res, 500, { error: String(err) })));
    server.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://x").pathname !== "/client") return void socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, req));
    });
    this.pinger = setInterval(() => this.ping(), 30_000);
    this.pinger.unref();
    return server.listen(port, host);
  }

  close(): void {
    if (this.pinger) clearInterval(this.pinger);
    for (const s of this.sessions.values()) s.ws.close(1001, "box shutting down");
    this.wss.close();
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/health") return this.send(res, 200, { ok: true, box: this.d.boxName(), protocol: CLIENT_PROTOCOL });
    if (req.method === "POST" && url.pathname === "/pair/start") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req, 16 * 1024));
      } catch {
        return this.send(res, 400, { error: "send JSON" });
      }
      const screens = checkScreens(body.screens);
      const platform = typeof body.platform === "string" ? body.platform.slice(0, 32) : "";
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : "";
      if (!screens || !platform || !name) return this.send(res, 400, { error: "need name, platform and screens [{ id, name, w, h, hz? }]" });
      const p = this.d.pairings.start(
        { name, platform, screens, model: typeof body.model === "string" ? body.model.slice(0, 80) : undefined, appVersion: typeof body.appVersion === "string" ? body.appVersion.slice(0, 32) : undefined },
        req.socket.remoteAddress ?? "?",
      );
      if (!p) return this.send(res, 429, { error: "too many pairing requests; wait a few minutes" });
      this.d.log.info("venuebox", "pairing requested", { name, platform, screens: screens.length, from: req.socket.remoteAddress });
      return this.send(res, 200, { pairingId: p.id, code: p.code, expiresAt: new Date(p.expiresAt).toISOString(), pollMs: 2000 });
    }
    if (req.method === "GET" && url.pathname === "/pair/status") {
      const s = this.d.pairings.status(url.searchParams.get("id") ?? "");
      if (!s) return this.send(res, 404, { status: "expired" });
      return this.send(res, 200, s.status === "approved" ? { ...s, wsPath: "/client" } : s);
    }
    this.send(res, 404, { error: "not found" });
  }

  private accept(ws: WebSocket, req: IncomingMessage) {
    let session: Session | undefined;
    const fail = (code: number, msg: BoxMsg & { type: "error" }) => {
      ws.send(JSON.stringify(msg));
      ws.close(code, msg.code);
    };
    const helloTimer = setTimeout(() => !session && fail(CLOSE.protocol, { type: "error", code: "bad-hello", message: "send hello first" }), 10_000);
    ws.on("message", (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw)) as ClientMsg;
      } catch {
        return;
      }
      if (!session) {
        clearTimeout(helloTimer);
        if (msg.type !== "hello") return fail(CLOSE.protocol, { type: "error", code: "bad-hello", message: "the first message must be hello" });
        if (msg.v !== CLIENT_PROTOCOL) return fail(CLOSE.protocol, { type: "error", code: "version", message: `this box speaks protocol ${CLIENT_PROTOCOL}` });
        const device = this.d.devices.byToken(msg.token);
        if (!device) return fail(CLOSE.badToken, { type: "error", code: "bad-token", message: "not paired with this box (or revoked): pair again" });
        const screens = checkScreens(msg.screens) ?? device.screens;
        const deliveries = (Array.isArray(msg.deliveries) ? msg.deliveries : ["native-url"]).filter((x): x is Delivery => x === "native-url" || x === "hls");
        session = { ws, device, screens, deliveries, state: new Map(), previews: new Map(), alive: true };
        void this.connected(session, msg, req);
        return;
      }
      this.onMessage(session, msg);
    });
    ws.on("pong", () => session && (session.alive = true));
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (session && this.sessions.get(session.device.id) === session) {
        this.sessions.delete(session.device.id);
        for (const done of session.previews.values()) done(undefined);
        this.d.log.info("venuebox", "device disconnected", { device: session.device.name });
      }
    });
  }

  private async connected(s: Session, hello: ClientMsg & { type: "hello" }, req: IncomingMessage) {
    const old = this.sessions.get(s.device.id);
    if (old) old.ws.close(CLOSE.replaced, "connected again elsewhere");
    this.sessions.set(s.device.id, s);
    const device = (await this.d.devices.update(s.device.id, { screens: s.screens, lastSeen: new Date().toISOString(), model: hello.model ?? s.device.model, appVersion: hello.appVersion ?? s.device.appVersion })) ?? s.device;
    s.device = device;
    this.welcome(s);
    this.d.log.info("venuebox", "device connected", { device: device.name, platform: hello.platform, screens: s.screens.length, from: req.socket.remoteAddress });
    await this.syncDisplays(device, s.screens);
    this.d.reconnected(s.screens.map((x) => displayId(device.id, x.id)));
  }

  private welcome(s: Session) {
    this.post(s, { type: "welcome", v: CLIENT_PROTOCOL, deviceId: s.device.id, name: s.device.name, screens: s.screens.map((x) => ({ id: x.id, label: this.label(s.device, x) })) });
  }

  private onMessage(s: Session, msg: ClientMsg) {
    if (msg.type === "state" && typeof msg.screen === "string") {
      s.state.set(msg.screen, { showing: String(msg.showing ?? ""), status: String(msg.status ?? ""), detail: typeof msg.detail === "string" ? msg.detail.slice(0, 200) : undefined });
    } else if (msg.type === "screens") {
      const screens = checkScreens(msg.screens);
      if (!screens) return;
      const before = new Set(s.screens.map((x) => x.id));
      s.screens = screens;
      void this.d.devices.update(s.device.id, { screens }).then(async (d) => {
        if (d) s.device = d;
        this.welcome(s);
        await this.syncDisplays(s.device, screens);
        // New screens: put back what they showed before (if they were ever paired).
        this.d.reconnected(screens.filter((x) => !before.has(x.id)).map((x) => displayId(s.device.id, x.id)));
      });
    } else if (msg.type === "preview" && typeof msg.requestId === "string") {
      const done = s.previews.get(msg.requestId);
      if (!done) return;
      s.previews.delete(msg.requestId);
      done(typeof msg.jpeg === "string" && msg.jpeg.length < 400_000 ? Buffer.from(msg.jpeg, "base64") : undefined);
    }
  }

  private ping() {
    for (const s of this.sessions.values()) {
      if (!s.alive) {
        s.ws.terminate();
        continue;
      }
      s.alive = false;
      s.ws.ping();
    }
  }

  private post(s: Session, msg: BoxMsg) {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(msg));
  }

  // ---------------------------------------------------------------- admin

  /** Staff typed a pairing code on the TVs page. */
  async approve(code: string, name?: string): Promise<Device> {
    const p = this.d.pairings.byCode(code);
    if (!p) throw Object.assign(new Error("No device is showing that code (it may have expired; codes last 10 minutes)."), { status: 404 });
    const { device, token } = await this.d.devices.add({ ...p.request, name: name?.trim().slice(0, 60) || p.request.name });
    this.d.pairings.approve(p.id, device.id, token);
    await this.syncDisplays(device, device.screens);
    this.d.log.info("venuebox", "device paired", { device: device.name, screens: device.screens.length });
    return device;
  }

  async revoke(id: string): Promise<boolean> {
    const device = this.d.devices.get(id);
    if (!device) return false;
    await this.d.devices.remove(id);
    const s = this.sessions.get(id);
    if (s) {
      this.post(s, { type: "error", code: "revoked", message: "This device was removed from the box." });
      s.ws.close(CLOSE.revoked, "revoked");
      this.sessions.delete(id);
    }
    await this.d.displaysChanged([], device.screens.map((x) => displayId(id, x.id)));
    this.d.log.info("venuebox", "device revoked", { device: device.name });
    return true;
  }

  async rename(id: string, name: string): Promise<Device | undefined> {
    const d = await this.d.devices.update(id, { name: name.trim().slice(0, 60) });
    const s = this.sessions.get(id);
    if (d && s) {
      s.device = d;
      this.welcome(s);
    }
    return d;
  }

  devicesView() {
    return {
      devices: this.d.devices.list().map(({ tokenHash: _t, ...d }) => ({ ...d, online: this.sessions.has(d.id) })),
      pending: this.d.pairings.list(),
    };
  }

  /** Flash the screen's name on it (which TV is which). */
  identify(device: DisplayDevice): boolean {
    const { s, screen } = this.find(device);
    if (!s || !screen) return false;
    this.post(s, { type: "identify", screen: screen.id, label: this.label(s.device, screen) });
    return true;
  }

  private label(d: Device, screen: Screen): string {
    return d.screens.length > 1 || screen.name !== screen.id ? `${d.name} · ${screen.name}` : d.name;
  }

  private async syncDisplays(device: Device, screens: Screen[]) {
    const all = this.d.devices.get(device.id)?.screens ?? screens;
    await this.d.displaysChanged(
      screens.map((x) => this.toDisplay(device, x)),
      all.filter((x) => !screens.some((y) => y.id === x.id)).map((x) => displayId(device.id, x.id)),
    );
  }

  private toDisplay(device: Device, screen: Screen): DisplayDevice {
    return {
      id: displayId(device.id, screen.id),
      driver: DRIVER_ID,
      name: this.label(device, screen),
      address: `venuebox:${device.id}`,
      model: `${device.platform}${device.model ? ` · ${device.model}` : ""} · ${screen.w}×${screen.h}${screen.hz ? `@${Math.round(screen.hz)}` : ""}`,
      isTv: true,
      meta: { deviceId: device.id, screenId: screen.id, platform: device.platform, appVersion: device.appVersion },
    };
  }

  private find(device: DisplayDevice): { s?: Session; screen?: Screen } {
    const [, deviceId, screenId] = device.id.split(":");
    const s = this.sessions.get(deviceId);
    return { s, screen: s?.screens.find((x) => x.id === screenId) };
  }

  // ---------------------------------------------------------------- DisplayDriver

  async discover(): Promise<DisplayDevice[]> {
    return this.d.devices.list().flatMap((d) => d.screens.map((x) => this.toDisplay(d, x)));
  }

  async capabilities(device: DisplayDevice): Promise<Capabilities> {
    const { s } = this.find(device);
    // Offline devices keep their last declared ability (native-url for every v1 client).
    return { delivery: s ? s.deliveries.filter((x) => x === "native-url") : ["native-url"], power: false, inputs: [] };
  }

  async power(): Promise<void> {
    throw Object.assign(new Error("Venuebox screens don't switch TVs on or off (yet)"), { status: 400 });
  }

  async setInput(): Promise<void> {
    throw Object.assign(new Error("Venuebox screens have no inputs"), { status: 400 });
  }

  async show(device: DisplayDevice, content: DisplayContent): Promise<ShowResult> {
    const { s, screen } = this.find(device);
    if (!s || !screen) return { ok: false, message: `${device.name} isn't connected to the box right now.` };
    if (content.kind === "off") {
      this.post(s, { type: "off", screen: screen.id });
      return { ok: true, delivery: "native-url" };
    }
    if (!content.url) return { ok: false, message: "nothing to show" };
    this.post(s, { type: "show", screen: screen.id, url: content.url, kind: "native-url", title: content.title });
    return { ok: true, delivery: "native-url" };
  }

  async stop(device: DisplayDevice): Promise<void> {
    await this.show(device, { kind: "off" });
  }

  async health(device: DisplayDevice): Promise<Health> {
    const { s, screen } = this.find(device);
    if (!s) return { online: false, detail: "app not connected" };
    if (!screen) return { online: false, detail: "screen unplugged" };
    return { online: true };
  }

  streamState(device: DisplayDevice): StreamState | undefined {
    const { s, screen } = this.find(device);
    const st = screen && s?.state.get(screen.id);
    if (!st || !st.showing) return undefined;
    const map: Record<string, string> = { playing: "streaming", loading: "connecting", error: "error" };
    return { delivery: "native-url", url: st.showing, state: map[st.status] ?? st.status, needsCode: false, detail: st.detail, settings: `${screen!.w}×${screen!.h} · rendered on the device` };
  }

  /** Asks the device for a JPEG of the screen (3 s timeout). */
  preview(device: DisplayDevice): Promise<Buffer | undefined> {
    const { s, screen } = this.find(device);
    if (!s || !screen) return Promise.resolve(undefined);
    const requestId = randomBytes(6).toString("hex");
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        s.previews.delete(requestId);
        resolve(undefined);
      }, 3000);
      s.previews.set(requestId, (jpeg) => {
        clearTimeout(t);
        resolve(jpeg);
      });
      this.post(s, { type: "preview", screen: screen.id, requestId });
    });
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c: Buffer) => {
      s += c;
      if (s.length > limit) {
        reject(new Error("too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}
