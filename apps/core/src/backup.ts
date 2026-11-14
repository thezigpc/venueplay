// Box 0.16.0: settings backup and restore.
//
// One file holds everything a venue would hate to set up again: core's settings (venue,
// branding, games list, scenes, schedules, closing time, access, Wi-Fi, Cloudflare…), the
// broker's (TVs, groups, AirPlay/Vizio/Apple TV pairings, sound settings) and every game's
// own /data (card packs, menu uploads, leaderboards…). Bluetooth pairings live in a
// root-only folder and aren't included: re-pair speakers after a restore.
//
// It holds passwords and tokens, so the admin offers a passphrase: AES-256-GCM with a key
// from scrypt. Without one the file is plain gzip'd JSON.
//
// Restore writes core's and the broker's files, then restarts both (compose starts them
// again). Game data can only go into a game's container once it exists, so it's left in
// restore-pending.json.gz and put back after the restart, game by game, as each comes up.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const BACKUP_FORMAT = "bargames-backup";
const MAGIC = Buffer.from("BGBK1\n");
/** core files that belong to this machine, not the venue: never backed up or restored. */
const CORE_SKIP = new Set(["host-hooks.json", "restore-pending.json"]);
const CORE_FILE = /^[a-z0-9-]+\.json$/;
export const PENDING_FILE = "restore-pending.json.gz";

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: 1;
  /** Box version that made it. */
  box: string;
  venue: string;
  createdAt: string;
  /** core data file name → its text. */
  core: Record<string, string>;
  /** broker data file name → base64. */
  broker: Record<string, string>;
  /** game id → its /data as a base64 tar. */
  games: Record<string, string>;
  /** What couldn't be read (plain words). */
  skipped: string[];
}

export interface BackupDeps {
  dataDir: string;
  boxVersion: string;
  venueName: () => string;
  gameIds: () => string[];
  brokerFiles: () => Promise<Record<string, string>>;
  exportData?: (gameId: string) => Promise<Buffer>;
}

export async function createBackup(d: BackupDeps): Promise<BackupFile> {
  const skipped: string[] = [];
  const core: Record<string, string> = {};
  for (const f of readdirSync(d.dataDir).sort()) {
    if (!CORE_FILE.test(f) || CORE_SKIP.has(f)) continue;
    try {
      core[f] = readFileSync(path.join(d.dataDir, f), "utf8");
    } catch {
      skipped.push(`core ${f}`);
    }
  }
  const broker = await d.brokerFiles().catch(() => {
    skipped.push("TV settings and pairings (the broker didn't answer)");
    return {};
  });
  const games: Record<string, string> = {};
  for (const id of d.gameIds()) {
    if (!d.exportData) break;
    try {
      games[id] = (await d.exportData(id)).toString("base64");
    } catch {
      skipped.push(`${id}'s data (its container isn't there)`);
    }
  }
  return { format: BACKUP_FORMAT, version: 1, box: d.boxVersion, venue: d.venueName(), createdAt: new Date().toISOString(), core, broker, games, skipped };
}

/** The file to download: gzip'd JSON, or encrypted with the passphrase. */
export function packBackup(b: BackupFile, passphrase?: string): Buffer {
  const gz = gzipSync(Buffer.from(JSON.stringify(b)));
  if (!passphrase) return gz;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(gz), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

export function isEncrypted(buf: Buffer): boolean {
  return buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Reads a backup file; throws plain-words errors (wrong passphrase, not a backup…). */
export function unpackBackup(buf: Buffer, passphrase?: string): BackupFile {
  let gz = buf;
  if (isEncrypted(buf)) {
    if (!passphrase) throw new Error("This backup is protected: enter its passphrase.");
    const o = MAGIC.length;
    const salt = buf.subarray(o, o + 16);
    const iv = buf.subarray(o + 16, o + 28);
    const tag = buf.subarray(o + 28, o + 44);
    const key = scryptSync(passphrase, salt, 32);
    const dc = createDecipheriv("aes-256-gcm", key, iv);
    dc.setAuthTag(tag);
    try {
      gz = Buffer.concat([dc.update(buf.subarray(o + 44)), dc.final()]);
    } catch {
      throw new Error("Wrong passphrase, or the file is damaged.");
    }
  }
  let b: BackupFile;
  try {
    b = JSON.parse(gunzipSync(gz).toString("utf8")) as BackupFile;
  } catch {
    throw new Error("That isn't a Bar Games settings backup.");
  }
  if (b?.format !== BACKUP_FORMAT || b.version !== 1 || typeof b.core !== "object") throw new Error("That isn't a Bar Games settings backup (or it's from a newer box).");
  for (const [f, text] of Object.entries(b.core)) {
    if (!CORE_FILE.test(f) || typeof text !== "string") throw new Error(`The backup has an unexpected file: ${f}`);
    try {
      JSON.parse(text);
    } catch {
      throw new Error(`The backup's ${f} is damaged.`);
    }
  }
  return { ...b, broker: b.broker ?? {}, games: b.games ?? {}, skipped: b.skipped ?? [] };
}

/**
 * Writes core's files (atomically, owner-only) and leaves the game data for after the
 * restart. The caller restores the broker's files and then restarts core.
 */
export function writeCoreFiles(dataDir: string, b: BackupFile): string[] {
  const written: string[] = [];
  for (const [f, text] of Object.entries(b.core)) {
    if (!CORE_FILE.test(f) || CORE_SKIP.has(f)) continue;
    const target = path.join(dataDir, f);
    writeFileSync(`${target}.restore`, text, { mode: 0o600 });
    renameSync(`${target}.restore`, target);
    written.push(f);
  }
  if (Object.keys(b.games).length) writeFileSync(path.join(dataDir, PENDING_FILE), gzipSync(Buffer.from(JSON.stringify({ games: b.games }))), { mode: 0o600 });
  return written;
}

/**
 * After a restore's restart: puts each game's data back once its container exists, then
 * restarts that game. Gives up on a game after `waitMs` (its image may not pull).
 */
export async function resumePendingRestore(d: {
  dataDir: string;
  state: (id: string) => Promise<string>;
  importData?: (id: string, tar: Buffer) => Promise<void>;
  restart: (id: string) => Promise<void>;
  log: { info: (a: string, m: string, x?: Record<string, unknown>) => void; warn: (a: string, m: string, x?: Record<string, unknown>) => void };
  waitMs?: number;
  pollMs?: number;
}): Promise<void> {
  const file = path.join(d.dataDir, PENDING_FILE);
  if (!existsSync(file) || !d.importData) return;
  let games: Record<string, string>;
  try {
    games = (JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as { games: Record<string, string> }).games ?? {};
  } catch {
    rmSync(file, { force: true });
    return;
  }
  const until = Date.now() + (d.waitMs ?? 15 * 60_000);
  const left = new Map(Object.entries(games));
  while (left.size && Date.now() < until) {
    for (const [id, tar] of [...left]) {
      const st = await d.state(id).catch(() => "unknown");
      if (st === "missing" || st === "unknown") continue;
      try {
        await d.importData(id, Buffer.from(tar, "base64"));
        await d.restart(id).catch(() => undefined);
        d.log.info("backup", "game data restored", { game: id });
      } catch (err) {
        d.log.warn("backup", "game data restore failed", { game: id, err: (err as Error).message });
      }
      left.delete(id);
    }
    if (left.size) await new Promise((r) => setTimeout(r, d.pollMs ?? 5000));
  }
  if (left.size) d.log.warn("backup", "gave up restoring game data", { games: [...left.keys()] });
  rmSync(file, { force: true });
}
