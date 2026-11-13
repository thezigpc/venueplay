// @bargames/sdk/integration: the Node helper for integrations (SDK 0.12.0). Node-only.
//
//   import { createIntegration } from "@bargames/sdk/integration";
//   const box = createIntegration();          // reads BG_CORE_URL and BG_GAME_TOKEN
//   const stop = box.connect({
//     onCatalog: (c) => sync(c.scenes, c.tvs), // first on connect, then on every change
//     onEvent: (e) => { if (e.type === "winner") … },
//   });
//   await box.runScene("bingo-night");
//   await box.report({ state: "ok", message: "Paired with Alexa" });
//
// Off a box (no BG_CORE_URL) every call rejects with BoxUnavailable and connect() does
// nothing, so an integration can be developed against `bargames mock-box`.

import { ENV, INTEGRATION_PATHS, type BarGamesEvent, type IntegrationCatalog, type IntegrationMessage, type IntegrationReport } from "./protocol.js";

export interface IntegrationOptions {
  /** Default: process.env.BG_CORE_URL. */
  coreUrl?: string;
  /** Default: process.env.BG_GAME_TOKEN. */
  token?: string;
  fetch?: typeof fetch;
  /** Called with connection problems (the stream reconnects by itself). */
  onWarn?: (message: string) => void;
}

export interface StreamHandlers {
  /** The catalog: on every (re)connect, and whenever scenes, TVs or games change. */
  onCatalog?: (catalog: IntegrationCatalog, first: boolean) => void;
  onEvent?: (event: BarGamesEvent) => void;
  onScene?: (msg: Extract<IntegrationMessage, { type: "scene" }>) => void;
  /** Staff pressed one of your report's `actions` (its id). */
  onAction?: (action: string) => void;
  /** Connected (true) or lost, reconnecting (false). */
  onConnection?: (up: boolean) => void;
}

export class BoxUnavailable extends Error {}
export class BoxError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const env = (k: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[k];

export function createIntegration(opts: IntegrationOptions = {}) {
  const coreUrl = (opts.coreUrl ?? env(ENV.coreUrl) ?? "").replace(/\/$/, "");
  const token = opts.token ?? env(ENV.token) ?? "";
  const doFetch = opts.fetch ?? fetch;
  const onBox = Boolean(coreUrl && token);

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (!onBox) throw new BoxUnavailable("not running on a Bar Games box (no BG_CORE_URL / BG_GAME_TOKEN)");
    const res = await doFetch(coreUrl + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new BoxError(res.status, data.error ?? `HTTP ${res.status}`);
    return data;
  };

  return {
    /** True when running on a box. */
    onBox,
    /** Permissions the venue approved (from BG_PERMISSIONS; the catalog has them too). */
    permissions: (env("BG_PERMISSIONS") ?? "").split(",").filter(Boolean),
    catalog: () => call<IntegrationCatalog>("GET", INTEGRATION_PATHS.catalog),
    /** Runs a scene; resolves with each step's result. */
    runScene: (id: string) => call<{ ok: boolean; steps: { step: string; ok: boolean; message?: string }[] }>("POST", INTEGRATION_PATHS.scene(id)),
    tvPower: (id: string, on: boolean) => call<{ ok: boolean }>("POST", INTEGRATION_PATHS.tvPower(id), { on }),
    /** Tells the box admin how this integration is doing. Send it on start and on every change. */
    report: (r: IntegrationReport) => call<{ ok: boolean }>("PUT", INTEGRATION_PATHS.report, r),
    /** Opens the live stream (reconnects with backoff). Returns a function that closes it. */
    connect(h: StreamHandlers): () => void {
      if (!onBox) return () => undefined;
      let stopped = false;
      let ctrl: AbortController | undefined;
      let first = true;
      const run = async () => {
        let delay = 1000;
        while (!stopped) {
          ctrl = new AbortController();
          try {
            const res = await doFetch(coreUrl + INTEGRATION_PATHS.stream, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: ctrl.signal });
            if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status}`);
            h.onConnection?.(true);
            delay = 1000;
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let nl: number;
              while ((nl = buf.indexOf("\n\n")) >= 0) {
                const chunk = buf.slice(0, nl);
                buf = buf.slice(nl + 2);
                const data = chunk
                  .split("\n")
                  .filter((l) => l.startsWith("data:"))
                  .map((l) => l.slice(5).trimStart())
                  .join("\n");
                if (!data) continue;
                let msg: IntegrationMessage;
                try {
                  msg = JSON.parse(data) as IntegrationMessage;
                } catch {
                  continue;
                }
                if (msg.type === "hello" || msg.type === "catalog") {
                  h.onCatalog?.(msg.catalog, first);
                  first = false;
                } else if (msg.type === "event") h.onEvent?.(msg.event);
                else if (msg.type === "scene") h.onScene?.(msg);
                else if (msg.type === "action") h.onAction?.(msg.action);
              }
            }
            if (!stopped) throw new Error("stream closed by the box");
          } catch (err) {
            if (stopped) return;
            h.onConnection?.(false);
            opts.onWarn?.(`${(err as Error).message}; reconnecting in ${Math.round(delay / 1000)} s`);
            await new Promise((r) => setTimeout(r, delay));
            delay = Math.min(delay * 2, 30_000);
          }
        }
      };
      void run();
      return () => {
        stopped = true;
        ctrl?.abort();
      };
    },
  };
}

export type Integration = ReturnType<typeof createIntegration>;
