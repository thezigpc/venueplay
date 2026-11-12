// bgctl: the box's command line for staff and maintainers with shell access to the box.
// Runs inside the core container (deploy/bgctl wraps `docker exec`), reads core's ops
// token from the data folder, and calls core on localhost. Nothing leaves the box.
//
//   bgctl status                      games, versions, and any update waiting
//   bgctl check [game]                re-check the games' sources now
//   bgctl update <game…> | --all      install newer versions and restart them
//         --wait <minutes>            wait for an image that's still building
//         --json                      machine-readable output

import { readFileSync } from "node:fs";
import path from "node:path";

interface UpdateInfo {
  latest?: string;
  available: boolean;
  note?: string;
  error?: string;
  checkedAt: string;
}
interface Row {
  id: string;
  name: string;
  version: string;
  kind: string;
  enabled: boolean;
  state: string;
  source: string;
  update?: UpdateInfo;
}
interface Listing {
  box: string;
  lastCheck?: string;
  games: Row[];
}

const HELP = `bgctl: Bar Games box command line

  bgctl status                     games, versions, and updates waiting
  bgctl check [game]               re-check the games' sources now
  bgctl update <game...>           install newer versions and restart them
  bgctl update --all               every game with an update
     --wait <minutes>              keep checking while a new image is still building
     --json                        machine-readable output

Updating restarts the game: its open rooms close. A version that won't start is
rolled back to the previous one.`;

export class OpsError extends Error {}

export function opsClient(baseUrl: string, token: string, doFetch: typeof fetch = fetch) {
  const call = async <T>(method: string, p: string, body?: unknown): Promise<T> => {
    const res = await doFetch(baseUrl + p, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new OpsError(data.error ?? `HTTP ${res.status}`);
    return data;
  };
  return {
    games: () => call<Listing>("GET", "/internal/ops/games"),
    check: (gameId?: string) => call<Listing>("POST", "/internal/ops/check", { gameId }),
    update: (id: string) => call<{ id: string; from: string; to: string; warnings: string[] }>("POST", `/internal/ops/update/${encodeURIComponent(id)}`),
  };
}

type Client = ReturnType<typeof opsClient>;

function describe(r: Row): string {
  const u = r.update;
  const what = !u ? (r.source.startsWith("http") ? "not checked yet" : `installed from ${r.source}, no update checks`) : u.error ? `check failed: ${u.error}` : u.available ? `UPDATE ${u.latest} ready` : (u.note ?? "up to date");
  return `${r.id.padEnd(14)} ${r.version.padEnd(9)} ${(r.enabled ? r.state : "off").padEnd(8)} ${what}`;
}

/** Runs one bgctl command. Returns the exit code; output goes through `out`. */
export async function runOps(argv: string[], client: Client, out: (line: string) => void = console.log, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<number> {
  const json = argv.includes("--json");
  const waitIdx = argv.indexOf("--wait");
  const waitMin = waitIdx >= 0 ? Number(argv[waitIdx + 1]) : 0;
  if (waitIdx >= 0 && !(waitMin > 0 && waitMin <= 120)) {
    out("--wait takes minutes, 1-120");
    return 2;
  }
  const args = argv.filter((a, i) => !a.startsWith("--") && !(waitIdx >= 0 && i === waitIdx + 1));
  const [cmd = "status", ...rest] = args;
  const print = (l: Listing) => {
    if (json) return out(JSON.stringify(l, null, 2));
    out(`box ${l.box} · last check ${l.lastCheck ? new Date(l.lastCheck).toLocaleString() : "not yet"}`);
    for (const r of l.games) out(describe(r));
  };

  if (cmd === "help" || argv.includes("--help") || argv.includes("-h")) {
    out(HELP);
    return 0;
  }
  if (cmd === "status") {
    print(await client.games());
    return 0;
  }
  if (cmd === "check") {
    print(await client.check(rest[0]));
    return 0;
  }
  if (cmd !== "update") {
    out(`unknown command "${cmd}"\n\n${HELP}`);
    return 2;
  }

  const all = argv.includes("--all");
  if (!all && !rest.length) {
    out("update what? bgctl update <game...> or bgctl update --all");
    return 2;
  }
  let listing = await client.check();
  const known = new Set(listing.games.map((g) => g.id));
  const unknown = rest.filter((id) => !known.has(id));
  if (unknown.length) {
    out(`not on this box: ${unknown.join(", ")} (installed: ${[...known].join(", ") || "none"})`);
    return 1;
  }
  let targets = all ? listing.games.filter((g) => g.update?.available).map((g) => g.id) : rest;
  const results: { id: string; ok: boolean; from?: string; to?: string; message: string }[] = [];
  const deadline = Date.now() + waitMin * 60_000;

  for (;;) {
    const pending: string[] = [];
    for (const id of targets) {
      const row = listing.games.find((g) => g.id === id)!;
      const u = row.update;
      if (u?.available) {
        if (!json) out(`${id}: updating ${row.version} → ${u.latest}…`);
        try {
          const r = await client.update(id);
          results.push({ id, ok: true, from: r.from, to: r.to, message: `updated ${r.from} → ${r.to}${r.warnings.length ? ` (${r.warnings.join("; ")})` : ""}` });
        } catch (e) {
          results.push({ id, ok: false, message: (e as Error).message });
        }
      } else if (u && !u.error && u.latest && u.latest !== row.version && u.note && /isn't published|can't be downloaded/.test(u.note) && Date.now() < deadline) {
        pending.push(id); // newer version announced, image still on its way
      } else {
        const ok = !u?.error;
        results.push({ id, ok, message: u?.error ? `check failed: ${u.error}` : (u?.note ?? "no update") });
      }
    }
    if (!pending.length) break;
    if (!json) out(`waiting for ${pending.join(", ")} (image still building)… checking again in 30 s`);
    await sleep(30_000);
    listing = await client.check();
    targets = pending;
  }

  if (json) out(JSON.stringify({ results }, null, 2));
  else {
    if (all && !results.length) out("nothing to update");
    for (const r of results) out(`${r.ok ? "ok  " : "FAIL"} ${r.id}: ${r.message}`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

const isMain = process.argv[1] && path.basename(process.argv[1]).replace(/\.ts$/, ".js") === "ops.js";
if (isMain) {
  const dataDir = process.env.DATA_DIR ?? "/data";
  let token = "";
  try {
    token = readFileSync(path.join(dataDir, "ops.token"), "utf8").trim();
  } catch {
    console.error(`can't read ${path.join(dataDir, "ops.token")}: is core running (it creates the token on start)?`);
    process.exit(1);
  }
  const base = `http://127.0.0.1:${process.env.PORT ?? 7100}`;
  runOps(process.argv.slice(2), opsClient(base, token))
    .then((code) => process.exit(code))
    .catch((e: Error) => {
      console.error(e instanceof OpsError ? `error: ${e.message}` : `can't reach core at ${base}: ${e.message}`);
      process.exit(1);
    });
}
