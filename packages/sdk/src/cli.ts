#!/usr/bin/env node
// bargames: developer CLI for game packages.
//   bargames validate [dir|file]   check bargames.json
//   bargames init [dir]            write a starter bargames.json
//   bargames mock-box [dir] [--game URL] [--port N] [--core-port N] [--name S] [--tv-pin N] [--no-cast]
//   bargames command <name> [--room CODE] [--args JSON] [--game URL]
//   bargames status [--game URL]
//   bargames check [dir] [--game URL] [--room CODE]

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MANIFEST_FILE, validateManifest } from "./manifest.js";
import { SDK_VERSION } from "./protocol.js";
import { callGame, check, DEV_TOKEN, loadManifest, mockBox } from "./devbox.js";

const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : argv[++i];
  else positional.push(argv[i]);
}
const [cmd = "help", target = "."] = positional;
/** The game server's own address (not the mock gateway). */
const gameUrlFor = (port?: number) => flags.game ?? `http://127.0.0.1:${port ?? 3000}`;

function manifestPath(p: string): string {
  return existsSync(p) && statSync(p).isDirectory() ? path.join(p, MANIFEST_FILE) : p;
}

switch (cmd) {
  case "validate": {
    const file = manifestPath(target);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      console.error(`✗ cannot read ${file}: ${(err as Error).message}`);
      process.exit(1);
    }
    const result = validateManifest(json);
    for (const w of result.warnings) console.warn(`! ${w}`);
    if (!result.ok) {
      for (const e of result.errors) console.error(`✗ ${e}`);
      process.exit(1);
    }
    console.log(`✓ ${result.manifest.id}@${result.manifest.version} (sdk level ${result.manifest.sdk.level})`);
    break;
  }
  case "init": {
    const file = manifestPath(target);
    if (existsSync(file)) {
      console.error(`✗ ${file} already exists`);
      process.exit(1);
    }
    const id = path.basename(path.resolve(target)).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "my-game";
    const starter = {
      id,
      name: id,
      version: "0.1.0",
      image: `ghcr.io/OWNER/${id}:0.1.0`,
      port: 3000,
      sdk: { version: SDK_VERSION, level: 1 },
      routes: { player: "/", table: "/room/{code}?role=table", host: "/?host=1" },
      health: "/health",
      events: [],
      commands: [],
      brandable: ["displayName", "accent"],
      resources: { memory: "512m", cpus: 1 },
      network: { internet: false },
    };
    writeFileSync(file, JSON.stringify(starter, null, 2) + "\n");
    console.log(`✓ wrote ${file}`);
    break;
  }
  case "mock-box": {
    const m = loadManifest(target);
    if (!m) console.warn(`! no valid ${MANIFEST_FILE} in ${target}; event names won't be checked against it`);
    const gameId = flags.id ?? m?.id ?? "game";
    const corePort = Number(flags["core-port"] ?? 7199);
    const gatewayPort = Number(flags.port ?? 7080);
    const gameUrl = gameUrlFor(m?.port);
    const name = flags.name ?? `${m?.name ?? gameId} (mock)`;
    const tvPin = flags["tv-pin"] ?? "";
    const box = mockBox({ gameId, displayName: name, gameUrl, corePort, gatewayPort, manifest: m, tvPin, castFromGames: flags["no-cast"] === undefined, announcement: flags.announce });
    const gamePort = new URL(gameUrl).port;
    console.log(`mock box for "${gameId}"

  1. Start your game server with these env vars (port ${gamePort}):
       bash:        BG_GAME_ID=${gameId} BG_CORE_URL=http://127.0.0.1:${corePort} BG_GAME_TOKEN=${DEV_TOKEN} PORT=${gamePort} <your start command>
       PowerShell:  $env:BG_GAME_ID="${gameId}"; $env:BG_CORE_URL="http://127.0.0.1:${corePort}"; $env:BG_GAME_TOKEN="${DEV_TOKEN}"; $env:PORT="${gamePort}"
  2. Open ${box.publicUrl} : your game behind a pretend gateway, in test branding
     (teal / pink / yellow, Georgia font, named "${name}").
  3. In another terminal, from the game repo:
       npx bargames check     npx bargames status     npx bargames command start --room ABCD

  4. Fake TVs ("fake-bar", "fake-patio", and "fake-unpaired", which answers like an unpaired TV) answer bg.displays() / bg.cast()${tvPin ? `, TV PIN ${tvPin}` : ", no TV PIN (try --tv-pin 1234)"}.
     Each cast prints the table URL: open it to see what that TV would show.
  5. "← All games" (gamesLink) goes to ${box.publicUrl}/__bargames/dev/games, a pretend games list with
     your open rooms and their Join links (joinPath). ${flags.announce ? `Announcement: "${flags.announce}".` : `Try --announce "Last call at 1:30" for announcementBanner().`}

Events and casts from your game print below (✗ = would be rejected, or isn't declared in bargames.json).
`);
    break;
  }
  case "command": {
    const name = positional[1];
    if (!name) {
      console.error("usage: bargames command <name> [--room CODE] [--args JSON] [--game URL]");
      process.exit(1);
    }
    const m = loadManifest(".");
    const r = await callGame(gameUrlFor(m?.port), "/__bargames/command", { command: name, roomCode: flags.room, args: flags.args ? JSON.parse(flags.args) : undefined });
    console.log(r.status, JSON.stringify(r.body, null, 2));
    process.exit(r.status === 200 && (r.body as { ok?: boolean }).ok ? 0 : 1);
    break;
  }
  case "status": {
    const m = loadManifest(".");
    const r = await callGame(gameUrlFor(m?.port), "/__bargames/status");
    console.log(r.status, JSON.stringify(r.body, null, 2));
    process.exit(r.status === 200 ? 0 : 1);
    break;
  }
  case "check": {
    const m = loadManifest(target);
    if (!m) {
      console.error(`✗ no valid ${MANIFEST_FILE} in ${target} (run: bargames validate ${target})`);
      process.exit(1);
    }
    process.exit((await check(m, gameUrlFor(m.port), { room: flags.room })) ? 0 : 1);
    break;
  }
  default:
    console.log(`bargames ${SDK_VERSION}

  bargames validate [dir|file]   check bargames.json
  bargames init [dir]            write a starter bargames.json
  bargames mock-box [dir]        pretend box: fake core on :7199 + fake gateway on :7080 in front of your game
                                 --tv-pin 1234: require a TV PIN for casting · --no-cast: casting turned off
                                 --announce "Last call at 1:30": a pretend staff announcement
      [--game http://127.0.0.1:PORT] [--port 7080] [--core-port 7199] [--name "Display Name"]
  bargames check [dir]           conformance checks against your running game
      [--room CODE]              also check one live room (its pendingClaims, times, table view)
  bargames status                room status, as the box's iPad sees it
  bargames command <name>        send a command, as the box's iPad does:
      create_room                  --args '{"kind":"venue","title":"Friday"}'
      start · pause · resume · next_round · end           --room CODE
      confirm_claim · reject_claim --room CODE [--args '{"claimId":"c1","reason":"Not a line"}']
                                   (no claimId: the room's oldest pending claim)

  --game defaults to http://127.0.0.1:<port from bargames.json>.`);
}
