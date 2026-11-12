// Box health for the admin's System page. Host-wide numbers come from the kernel (a
// container sees the host's /proc/meminfo, /proc/stat, /proc/loadavg and /sys sensors);
// per-container numbers from the Docker API (through the socket proxy).

import { readdirSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Temp {
  label: string;
  celsius: number;
}

export interface HostStats {
  hostname: string;
  cpuModel: string;
  cores: number;
  /** Busy share of all cores since the previous reading (0-100), undefined on the first. */
  cpuPercent?: number;
  load: [number, number, number];
  memory: { totalBytes: number; availableBytes: number; usedPercent: number };
  disk?: { path: string; totalBytes: number; freeBytes: number; usedPercent: number };
  uptimeSec: number;
  temps: Temp[];
  gpu?: { curMhz: number; maxMhz: number };
}

const read = (p: string): string => {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
};
const list = (p: string): string[] => {
  try {
    return readdirSync(p).sort();
  } catch {
    return [];
  }
};

/** Total and idle jiffies across all CPUs, from /proc/stat. */
export function parseProcStat(text: string): { total: number; idle: number } | undefined {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return undefined;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (n[3] ?? 0) + (n[4] ?? 0); // idle + iowait
  return { total: n.reduce((a, b) => a + b, 0), idle };
}

export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } {
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0) * 1024;
  return { totalBytes: kb("MemTotal"), availableBytes: kb("MemAvailable") };
}

/** Temperatures from thermal zones and hwmon sensors (CPU package, cores, NVMe, Wi-Fi). */
export function readTemps(sys = "/sys/class"): Temp[] {
  const out: Temp[] = [];
  for (const z of list(path.join(sys, "thermal")).filter((x) => x.startsWith("thermal_zone"))) {
    const t = Number(read(path.join(sys, "thermal", z, "temp")));
    const type = read(path.join(sys, "thermal", z, "type"));
    if (t > 0 && type) out.push({ label: type === "x86_pkg_temp" ? "CPU package" : type, celsius: Math.round(t / 100) / 10 });
  }
  for (const h of list(path.join(sys, "hwmon"))) {
    const dir = path.join(sys, "hwmon", h);
    const name = read(path.join(dir, "name"));
    if (name !== "coretemp" && name !== "nvme") continue; // the rest repeat the thermal zones
    for (const f of list(dir).filter((x) => /^temp\d+_input$/.test(x))) {
      const t = Number(read(path.join(dir, f)));
      const label = read(path.join(dir, f.replace("_input", "_label"))) || name;
      if (t > 0 && !(name === "coretemp" && /package/i.test(label))) out.push({ label: name === "nvme" ? `NVMe ${label}` : label, celsius: Math.round(t / 100) / 10 });
    }
  }
  return out;
}

export class HostSampler {
  private prev?: { total: number; idle: number };

  constructor(
    private readonly o: { proc?: string; sys?: string; diskPath?: string } = {},
  ) {}

  read(): HostStats {
    const proc = this.o.proc ?? "/proc";
    const sys = this.o.sys ?? "/sys/class";
    const cpu = parseProcStat(read(path.join(proc, "stat")));
    let cpuPercent: number | undefined;
    if (cpu && this.prev && cpu.total > this.prev.total) {
      cpuPercent = Math.round((1 - (cpu.idle - this.prev.idle) / (cpu.total - this.prev.total)) * 1000) / 10;
    }
    if (cpu) this.prev = cpu;
    const mem = parseMeminfo(read(path.join(proc, "meminfo")));
    const load = read(path.join(proc, "loadavg")).split(" ").slice(0, 3).map(Number) as [number, number, number];
    let disk: HostStats["disk"];
    try {
      const p = this.o.diskPath ?? "/data";
      const s = statfsSync(p);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      disk = { path: p, totalBytes: total, freeBytes: free, usedPercent: total ? Math.round((1 - free / total) * 1000) / 10 : 0 };
    } catch {
      disk = undefined;
    }
    let gpu: HostStats["gpu"];
    for (const card of list(path.join(sys, "drm")).filter((x) => /^card\d+$/.test(x))) {
      const cur = Number(read(path.join(sys, "drm", card, "gt_cur_freq_mhz")));
      const max = Number(read(path.join(sys, "drm", card, "gt_max_freq_mhz")));
      if (max) gpu = { curMhz: cur, maxMhz: max };
    }
    const cpus = os.cpus();
    return {
      hostname: os.hostname(),
      cpuModel: cpus[0]?.model?.trim() ?? "",
      cores: cpus.length,
      cpuPercent,
      load: load.length === 3 && load.every((x) => Number.isFinite(x)) ? load : [0, 0, 0],
      memory: { ...mem, usedPercent: mem.totalBytes ? Math.round((1 - mem.availableBytes / mem.totalBytes) * 1000) / 10 : 0 },
      disk,
      uptimeSec: Math.round(os.uptime()),
      temps: readTemps(sys),
      gpu,
    };
  }
}

export interface ContainerStat {
  name: string;
  state: string;
  status: string;
  cpuPercent?: number;
  memBytes?: number;
  memLimitBytes?: number;
}

/** CPU % from one Docker stats sample (it carries the previous reading in precpu_stats). */
export function containerCpuPercent(s: {
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
}): number | undefined {
  const cpu = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sys = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  if (!(cpu >= 0) || !(sys > 0)) return undefined;
  return Math.round((cpu / sys) * (s.cpu_stats?.online_cpus ?? 1) * 1000) / 10;
}
