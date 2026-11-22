// mpv's JSON IPC (--input-ipc-server): one JSON object per line over a Unix socket. Commands
// carry a request_id; replies and events come back on the same stream. Box 0.28.2, from the
// Venuebox desktop client (src/mpv-ipc.ts), which drives mpv the same way.

import { connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";

export interface MpvEvent {
  event: string;
  [k: string]: unknown;
}

export class MpvIpc extends EventEmitter {
  private sock?: Socket;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;

  /** Connects, retrying while mpv starts up (it creates the pipe a moment after launch). */
  async connect(path: string, timeoutMs = 8000): Promise<void> {
    const end = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < end && !this.closed) {
      try {
        this.sock = await new Promise<Socket>((resolve, reject) => {
          const s = connect(path);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!this.sock) throw new Error(this.closed ? "closed" : `the player didn't open its control channel (${(lastErr as Error)?.message ?? "timeout"})`);
    this.sock.setEncoding("utf8");
    this.sock.on("data", (d: string) => this.onData(d));
    this.sock.on("error", () => {});
    this.sock.on("close", () => this.shutdown());
  }

  private onData(d: string) {
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.request_id === "number" && this.pending.has(msg.request_id)) {
        const p = this.pending.get(msg.request_id)!;
        this.pending.delete(msg.request_id);
        clearTimeout(p.timer);
        if (msg.error === "success") p.resolve(msg.data);
        else p.reject(new Error(String(msg.error ?? "error")));
      } else if (typeof msg.event === "string") {
        this.emit("event", msg as MpvEvent);
        if (msg.event === "property-change" && typeof msg.name === "string") this.emit("property", msg.name, msg.data);
      }
    }
  }

  /** Sends a command (e.g. ["set_property", "pause", true]); resolves with its data. */
  command(args: unknown[], timeoutMs = 4000): Promise<unknown> {
    if (!this.sock || this.closed) return Promise.reject(new Error("the player isn't running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("the player didn't answer"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock!.write(`${JSON.stringify({ command: args, request_id: id })}\n`);
    });
  }

  /** Property changes arrive as "property" events (name, value). */
  observe(name: string, id: number): Promise<unknown> {
    return this.command(["observe_property", id, name]);
  }

  get open(): boolean {
    return Boolean(this.sock) && !this.closed;
  }

  private shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("the player closed"));
    }
    this.pending.clear();
    this.emit("close");
  }

  close() {
    this.sock?.destroy();
    this.shutdown();
  }
}
