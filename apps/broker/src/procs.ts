// Real child processes for the AirPlay streamer (see airplay.ts for the fakeable interface).

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "@bargames/common";
import type { CtlReply, Proc, ProcRunner } from "./airplay.js";

export class NodeProcRunner implements ProcRunner {
  constructor(
    private readonly log: Logger,
    runDir: string,
  ) {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
  }

  spawn(tag: string, cmd: string, args: string[], env: Record<string, string> = {}): Proc {
    // Own process group, so killing it also ends Chromium's helper processes.
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const lines: string[] = [];
    let alive = true;
    const keep = (buf: Buffer) => {
      for (const l of buf.toString("utf8").split("\n")) if (l.trim()) lines.push(l.slice(0, 300));
      if (lines.length > 40) lines.splice(0, lines.length - 40);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (err) => {
      alive = false;
      lines.push(String(err));
    });
    child.on("exit", (code, signal) => {
      alive = false;
      this.log.debug("proc", "exited", { tag, code, signal });
    });
    return {
      get alive() {
        return alive;
      },
      tail: () => [...lines],
      kill: () => {
        if (!alive || !child.pid) return;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        const pid = child.pid;
        setTimeout(() => {
          if (alive) {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              /* gone */
            }
          }
        }, 3000).unref();
      },
    };
  }

  ctl(socket: string, args: string[]): Promise<CtlReply> {
    return new Promise((resolve, reject) => {
      execFile("doubletake-ctl", ["-socket", socket, ...args], { timeout: 40_000 }, (err, stdout, stderr) => {
        const text = stdout.trim();
        try {
          return resolve(JSON.parse(text) as CtlReply);
        } catch {
          if (err) return reject(new Error((stderr || text || err.message).trim().slice(0, 300)));
          resolve({ ok: false, error: text.slice(0, 300) });
        }
      });
    });
  }

  async waitForDisplay(n: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(`/tmp/.X11-unix/X${n}`)) {
      if (Date.now() > deadline) throw new Error(`display :${n} not ready`);
      await sleep(100);
    }
  }

  cleanSlot(n: number, socket: string): void {
    for (const f of [`/tmp/.X${n}-lock`, `/tmp/.X11-unix/X${n}`, socket]) rmSync(f, { force: true });
  }

  sleep(ms: number): Promise<void> {
    return sleep(ms);
  }
}
