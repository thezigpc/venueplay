// Runs atv-helper.py (pyatv, Apple's Companion protocol) as one long-lived child process and
// talks JSON lines to it. Restarts it if it dies; a request waiting on a dead helper fails.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Logger } from "@bargames/common";

export type AtvCode = "auth" | "offline" | "pin" | "unsupported" | "error";

export class AtvError extends Error {
  constructor(
    message: string,
    readonly code: AtvCode,
  ) {
    super(message);
  }
}

/** One call to the helper. Injectable for tests. */
export type AtvCall = (op: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

export class AtvHelper {
  private proc?: ChildProcessWithoutNullStreams;
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly o: { python: string; script: string; log?: Logger }) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const proc = spawn(this.o.python, ["-I", this.o.script], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    createInterface({ input: proc.stdout }).on("line", (line) => {
      let msg: { id?: number; ok?: boolean; result?: unknown; code?: AtvCode; error?: string };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      const w = msg.id === undefined ? undefined : this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id!);
      clearTimeout(w.timer);
      if (msg.ok) w.resolve(msg.result);
      else w.reject(new AtvError(msg.error ?? "Apple TV helper error", msg.code ?? "error"));
    });
    createInterface({ input: proc.stderr }).on("line", (line) => this.o.log?.warn("appletv", line.slice(0, 300)));
    proc.on("exit", (code) => {
      this.o.log?.warn("appletv", "helper exited", { code });
      for (const [id, w] of this.waiting) {
        clearTimeout(w.timer);
        w.reject(new AtvError("the Apple TV helper stopped; try again", "error"));
        this.waiting.delete(id);
      }
    });
    proc.on("error", (err) => this.o.log?.warn("appletv", "helper failed to start", { err: String(err) }));
    return proc;
  }

  call: AtvCall = (op, args = {}, timeoutMs = 25_000) =>
    new Promise((resolve, reject) => {
      const proc = this.start();
      const id = this.next++;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new AtvError("the Apple TV didn't answer in time", "offline"));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ ...args, id, op, timeoutSec: Math.max(1, timeoutMs / 1000 - 2) })}\n`);
    });

  stop(): void {
    this.proc?.kill();
  }
}
