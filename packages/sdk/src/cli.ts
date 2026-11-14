#!/usr/bin/env node
// bargames: developer CLI for game packages.
//   bargames validate [dir|file]   check bargames.json
//   bargames init [dir]            write a starter bargames.json
//   bargames mock-box [dir] [--game URL] [--port N] [--core-port N] [--name S] [--tv-pin N] [--no-cast]
//   bargames command <name> [--room CODE] [--args JSON] [--game URL]
//   bargames status [--game URL]
//   bargames check [dir] [--game URL] [--room CODE] [--live (last: also create/end rooms on a game not on the mock box)]

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MANIFEST_FILE, validateManifest } from "./manifest.js";
import { SDK_VERSION } from "./protocol.js";
import { normalizeBasePath } from "./base.js";
import { callGame, check, DEV_TOKEN, loadManifest, mockBox } from "./devbox.js";

const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : argv[++i];
  else positional.push(argv[i]);
}
// SDK 0.13.2: --help / -h anywhere prints the help (it used to start a mock box).
const wantsHelp = argv.includes("--help") || argv.includes("-h");
const [cmd = "help", target = "."] = wantsHelp ? ["help"] : positional;
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
    if (flags.base && flags.base !== "/" && !normalizeBasePath(flags.base)) {
      console.error(`--base "${flags.base}" isn't a path like /my-game. In Git Bash, run with MSYS_NO_PATHCONV=1 (it turns /my-game into C:/Program Files/Git/my-game).`);
      process.exit(1);
    }
    let publicUrl: string | undefined;
    if (flags["public-url"]) {
      try {
        const u = new URL(flags["public-url"]);
        if (!/^https?:$/.test(u.protocol)) throw new Error();
        publicUrl = u.toString().replace(/\/+$/, "");
      } catch {
        console.error(`--public-url "${flags["public-url"]}" isn't an address like https://play.example.net/${m?.id ?? "my-game"}`);
        process.exit(1);
      }
    }
    const box = mockBox({ gameId, displayName: name, gameUrl, corePort, gatewayPort, manifest: m, tvPin, castFromGames: flags["no-cast"] === undefined, announcement: flags.announce, announcementShow: flags["announce-show"] as never, announcementPosition: flags["announce-position"] as never, basePath: flags.base, publicUrl });
    // SDK 0.13.2: a busy port is an error, not a silent second box (two sessions' boxes collided).
    for (const [srv, port, flag] of [[box.core, corePort, "--core-port"], [box.gateway, gatewayPort, "--port"]] as const) {
      srv.on("error", (err: NodeJS.ErrnoException) => {
        console.error(err.code === "EADDRINUSE" ? `✗ port ${port} is in use (another mock box?). Pick another with ${flag} N, and point BG_CORE_URL at the core port.` : `✗ mock box: ${err.message}`);
        process.exit(1);
      });
    }
    const gamePort = new URL(gameUrl).port;
    const baseEnv = new URL(box.publicUrl).pathname.replace(/\/$/, "");
    console.log(`mock box for "${gameId}"

  1. Start your game server with these env vars (port ${gamePort}):
       bash:        BG_GAME_ID=${gameId} BG_CORE_URL=http://127.0.0.1:${corePort} BG_GAME_TOKEN=${DEV_TOKEN} PORT=${gamePort}${baseEnv ? ` BG_BASE_PATH=${baseEnv}` : ""} <your start command>
       PowerShell:  $env:BG_GAME_ID="${gameId}"; $env:BG_CORE_URL="http://127.0.0.1:${corePort}"; $env:BG_GAME_TOKEN="${DEV_TOKEN}"; $env:PORT="${gamePort}"${baseEnv ? `; $env:BG_BASE_PATH="${baseEnv}"` : ""}
     ${baseEnv ? `Served under ${baseEnv}/ (path routing, SDK 0.10.0).` : "Try --base /" + gameId + " to test path routing (https://venue/" + gameId + "/), SDK 0.10.0."}
  2. Open ${box.publicUrl} : your game behind a pretend gateway, in test branding
     (teal / pink / yellow, Georgia font, named "${name}").
  3. In another terminal, from the game repo:
       npx bargames check     npx bargames status     npx bargames command start --room ABCD

  4. Fake TVs ("fake-bar", "fake-patio", and "fake-unpaired", which answers like an unpaired TV) answer bg.displays() / bg.cast()${tvPin ? `, TV PIN ${tvPin}` : ", no TV PIN (try --tv-pin 1234)"}.
     Each cast prints the table URL: open it to see what that TV would show.
  5. "← All games" (gamesLink) goes to ${box.publicUrl}/__bargames/dev/games, a pretend games list with
     your open rooms and their Join links (joinPath). ${flags.announce ? `Announcement: "${flags.announce}".` : `Try --announce "Last call at 1:30" for announcementBanner().`}

${publicUrl ? `  6. Your game is told its venue address is ${publicUrl} (--public-url): Join links and QR codes use it,\n     but open the game at ${box.publicUrl}.\n` : `  6. Try --public-url https://play.example.net/${gameId} to test a long venue address in "Join at" lines.\n`}${m?.kind === "integration" ? `  7. Integration controls: curl ${new URL(box.publicUrl).origin}/__bargames/dev/integration (GET: what the box holds;\n     POST /action/<id>: press a report button; POST /drop: drop the stream; PUT/DELETE /catalog: edit the lists).\n` : ""}
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
    process.exit((await check(m, gameUrlFor(m.port), { room: flags.room, live: flags.live !== undefined })) ? 0 : 1);
    break;
  }
  default:
    console.log(`bargames ${SDK_VERSION}

  bargames validate [dir|file]   check bargames.json
  bargames init [dir]            write a starter bargames.json
  bargames mock-box [dir]        pretend box: fake core on :7199 + fake gateway on :7080 in front of your game
                                 --tv-pin 1234: require a TV PIN for casting · --no-cast: casting turned off
                                 --announce "Last call at 1:30": a pretend staff announcement
                                 --announce-show phones|tvs|everywhere · --announce-position top|bottom (SDK 0.11.1)
                                 --base /my-game: serve the game under a path prefix, like the box's path routing
                                 --public-url https://play.example.net/my-game: the venue address the game is told (SDK 0.13.1)
                                 dev controls on the gateway port: POST /__bargames/dev/audio/end?reason=replaced|disconnected|error|stopped,
                                 /__bargames/dev/integration (GET; POST /action/<id>, /drop[?for=N]; PUT/DELETE /catalog)
                                 with --base, /<ROOM CODE> answers like the box's short room links (SDK 0.13.2)
      [--game http://127.0.0.1:PORT] [--port 7080] [--core-port 7199] [--name "Display Name"]
  bargames check [dir]           conformance checks against your running game (rooms only on the mock box's game; add --live last to override)
      [--room CODE]              also check one live room (its pendingClaims, times, table view)
  bargames status                room status, as the box's iPad sees it
  bargames command <name>        send a command, as the box's iPad does:
      create_room                  --args '{"kind":"venue","title":"Friday"}'
      start · pause · resume · next_round · end           --room CODE
      confirm_claim · reject_claim --room CODE [--args '{"claimId":"c1","reason":"Not a line"}']
                                   (no claimId: the room's oldest pending claim)

  --game defaults to http://127.0.0.1:<port from bargames.json>.`);
}
