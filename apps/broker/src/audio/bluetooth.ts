// Bluetooth speakers through BlueZ's own command-line client (bluetoothctl). The broker
// image runs bluetoothd and BlueALSA (deploy/broker-start); speakers play through
// BlueALSA's ALSA device ("bluealsa:DEV=<address>,PROFILE=a2dp").

import { spawn } from "node:child_process";

export interface BtDevice {
  address: string;
  name: string;
  paired: boolean;
  connected: boolean;
  trusted: boolean;
  /** Takes music (an A2DP sink: a speaker, headphones, a soundbar). */
  audio: boolean;
  rssi?: number;
  icon?: string;
}

export interface BtJob {
  state: "pairing" | "connecting" | "failed" | "done";
  message?: string;
  at: number;
}

export interface BtStatus {
  /** bluetoothd is running and the box has an adapter. */
  available: boolean;
  message?: string;
  powered: boolean;
  scanning: boolean;
}

/** Runs bluetoothctl with arguments; resolves with its output and exit code (never rejects). */
export type CtlRunner = (args: string[], timeoutMs: number) => Promise<{ code: number; out: string }>;

export const nodeCtlRunner: CtlRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    let out = "";
    let settled = false;
    const p = spawn("bluetoothctl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out });
    };
    const timer = setTimeout(() => {
      p.kill("SIGTERM");
      done(124);
    }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    p.on("error", (err) => {
      out += String(err);
      done(127);
    });
    p.on("close", (code) => done(code ?? 1));
  });

const ADDR = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
export const isBtAddress = (s: string): boolean => ADDR.test(s);

/** bluetoothctl colours and redraws its prompt; keep the text. */
const clean = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "\n");

/** `bluetoothctl devices` → addresses and names. */
export function parseDeviceList(text: string): { address: string; name: string }[] {
  const out: { address: string; name: string }[] = [];
  for (const line of clean(text).split("\n")) {
    const m = /^\s*Device ([0-9A-F:]{17})\s*(.*)$/.exec(line);
    if (m && isBtAddress(m[1])) out.push({ address: m[1], name: m[2].trim() || m[1] });
  }
  return out;
}

const A2DP_SINK = "0000110b-0000-1000-8000-00805f9b34fb";

/** `bluetoothctl info <addr>` → a device. */
export function parseInfo(address: string, text: string): BtDevice | undefined {
  const t = clean(text);
  if (!/Device [0-9A-F:]{17}/.test(t) || !/^\s*(Paired|Name|Alias):/m.test(t)) return undefined;
  const field = (k: string) => new RegExp(`^\\s*${k}:\\s*(.*)$`, "m").exec(t)?.[1]?.trim();
  const yes = (k: string) => field(k) === "yes";
  const cls = Number.parseInt(field("Class") ?? "", 16);
  const icon = field("Icon");
  const audio = t.toLowerCase().includes(A2DP_SINK) || (Number.isFinite(cls) && ((cls >> 8) & 0x1f) === 0x04) || Boolean(icon?.startsWith("audio"));
  const rssi = Number(field("RSSI")?.split(" ")[0]);
  return {
    address,
    name: field("Alias") || field("Name") || address,
    paired: yes("Paired"),
    connected: yes("Connected"),
    trusted: yes("Trusted"),
    audio,
    ...(Number.isFinite(rssi) ? { rssi } : {}),
    ...(icon ? { icon } : {}),
  };
}

/** BlueZ's error names in words a venue can act on. */
export function btProblem(out: string): string {
  const t = clean(out);
  if (/AuthenticationFailed|AuthenticationCanceled|AuthenticationRejected/.test(t)) return "The speaker refused to pair. Put it in pairing mode again and retry.";
  if (/ConnectionAttemptFailed|page-timeout|Host is down/i.test(t)) return "The speaker didn't answer. Check it's on, nearby, and in pairing mode.";
  if (/profile-unavailable/.test(t)) return "The box's Bluetooth audio service isn't running. Restart the box.";
  if (/AlreadyExists/.test(t)) return "Already paired.";
  if (/not available|No default controller/i.test(t)) return "The box has no Bluetooth adapter it can use.";
  if (/Failed to connect to the D-Bus|org\.freedesktop\.DBus\.Error/.test(t)) return "The box's Bluetooth service isn't running.";
  const failed = /Failed to \w+: (\S+)/.exec(t)?.[1];
  return failed ? `Bluetooth: ${failed.replace(/^org\.bluez\.Error\./, "")}` : "Bluetooth didn't respond.";
}

export class Bluetooth {
  private jobs = new Map<string, BtJob>();
  private scanUntil = 0;

  constructor(private readonly run: CtlRunner = nodeCtlRunner) {}

  async status(): Promise<BtStatus> {
    const r = await this.run(["show"], 5000);
    if (r.code !== 0 || !/Controller [0-9A-F:]{17}/.test(clean(r.out))) return { available: false, message: btProblem(r.out), powered: false, scanning: false };
    const t = clean(r.out);
    return { available: true, powered: /Powered: yes/.test(t), scanning: /Discovering: yes/.test(t) || Date.now() < this.scanUntil };
  }

  /** Switches the adapter on if it's off (after a reboot, or rfkill). */
  async powerOn(): Promise<void> {
    const s = await this.status();
    if (s.available && !s.powered) await this.run(["power", "on"], 5000);
  }

  /** Known and nearby devices with what the box is doing with each (pairing, failed…). */
  async devices(): Promise<(BtDevice & { job?: BtJob })[]> {
    const out = await this.infoOf(parseDeviceList((await this.run(["devices"], 5000)).out).slice(0, 60));
    const now = Date.now();
    for (const [addr, job] of this.jobs) if (job.state !== "pairing" && job.state !== "connecting" && now - job.at > 120_000) this.jobs.delete(addr);
    return out.map((d) => (this.jobs.has(d.address) ? { ...d, job: this.jobs.get(d.address) } : d));
  }

  private pairedCache: { at: number; list: BtDevice[] } | undefined;

  /**
   * Paired devices only (the sound outputs), cached for 3 s: the outputs list is read on
   * every admin poll and every play, and a scan can leave dozens of nearby devices behind.
   */
  async paired(): Promise<BtDevice[]> {
    if (this.pairedCache && Date.now() - this.pairedCache.at < 3000) return this.pairedCache.list;
    const r = await this.run(["devices", "Paired"], 5000);
    // BlueZ before 5.65 has no filter: it lists every device (or refuses); then ask each one.
    const filtered = r.code === 0 && !/invalid|usage/i.test(r.out);
    const list = (await this.infoOf(parseDeviceList(filtered ? r.out : (await this.run(["devices"], 5000)).out).slice(0, 60))).filter((d) => d.paired);
    this.pairedCache = { at: Date.now(), list };
    return list;
  }

  private async infoOf(list: { address: string }[]): Promise<BtDevice[]> {
    const out: BtDevice[] = [];
    for (let i = 0; i < list.length; i += 8) {
      const batch = await Promise.all(list.slice(i, i + 8).map(async (d) => parseInfo(d.address, (await this.run(["info", d.address], 5000)).out)));
      for (const dev of batch) if (dev) out.push(dev);
    }
    return out;
  }

  /** After pairing, connecting or forgetting: the outputs list must show it now. */
  private changed() {
    this.pairedCache = undefined;
  }

  async info(address: string): Promise<BtDevice | undefined> {
    if (!isBtAddress(address)) return undefined;
    return parseInfo(address, (await this.run(["info", address], 5000)).out);
  }

  /** Looks for speakers for `seconds` (in the background; poll devices()). */
  async scan(seconds = 20): Promise<void> {
    await this.powerOn();
    this.scanUntil = Date.now() + seconds * 1000;
    void this.run(["--timeout", String(seconds), "scan", "on"], (seconds + 5) * 1000);
  }

  /** Pair, trust and connect, in the background. Progress shows in devices()[].job. */
  pair(address: string): void {
    if (!isBtAddress(address)) throw Object.assign(new Error("bad Bluetooth address"), { status: 400 });
    const cur = this.jobs.get(address);
    if (cur && (cur.state === "pairing" || cur.state === "connecting")) return;
    this.jobs.set(address, { state: "pairing", at: Date.now() });
    void (async () => {
      const p = await this.run(["--agent", "NoInputNoOutput", "pair", address], 40_000);
      if (p.code !== 0 && !/AlreadyExists|Pairing successful/.test(p.out)) return void this.jobs.set(address, { state: "failed", message: btProblem(p.out), at: Date.now() });
      await this.run(["trust", address], 10_000);
      this.jobs.set(address, { state: "connecting", at: Date.now() });
      const c = await this.run(["connect", address], 30_000);
      this.changed();
      this.jobs.set(address, c.code === 0 ? { state: "done", at: Date.now() } : { state: "failed", message: `Paired, but ${btProblem(c.out).replace(/^./, (x) => x.toLowerCase())}`, at: Date.now() });
    })();
  }

  async connect(address: string): Promise<void> {
    if (!isBtAddress(address)) throw Object.assign(new Error("bad Bluetooth address"), { status: 400 });
    const r = await this.run(["connect", address], 12_000);
    this.changed();
    if (r.code !== 0) throw Object.assign(new Error(btProblem(r.out)), { status: 409 });
  }

  async disconnect(address: string): Promise<void> {
    if (!isBtAddress(address)) throw Object.assign(new Error("bad Bluetooth address"), { status: 400 });
    await this.run(["disconnect", address], 15_000);
    this.changed();
  }

  /** Unpairs and forgets the speaker. */
  async forget(address: string): Promise<void> {
    if (!isBtAddress(address)) throw Object.assign(new Error("bad Bluetooth address"), { status: 400 });
    this.jobs.delete(address);
    const r = await this.run(["remove", address], 15_000);
    this.changed();
    if (r.code !== 0 && !/not available/.test(r.out)) throw Object.assign(new Error(btProblem(r.out)), { status: 409 });
  }

  /** Before playing: connects a paired speaker that isn't connected (speakers drop off when idle). */
  async ensureConnected(address: string): Promise<void> {
    const d = await this.info(address);
    if (!d?.paired) throw Object.assign(new Error("That speaker isn't paired with the box any more. Pair it again under Connected devices."), { status: 409 });
    if (!d.connected) await this.connect(address);
  }
}
