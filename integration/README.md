# Bar Games integration: guide for a game repo

**Who this is for:** a Claude Code session working in a game repository
(BingoDigitalGame, CAHDigitalGame, DigitalPoolGame, …) that has been asked to add
Bar Games support. Read this whole file before changing anything.

**The integration folder:** `C:\CodeProjects\GameBroker\integration\`
| File | Use |
|---|---|
| `README.md` | This guide: the task, the rules, the steps, the definition of done |
| `bargames-sdk-<version>.tgz` | The SDK package to vendor into the game (zero dependencies) |
| `snippets/bargames.ts` | Server module to copy and adapt |
| `snippets/useVenue.ts` | React hook for branding |
| `snippets/bargames.example.json` | An example manifest (Bingo) |

For the full API, see `C:\CodeProjects\GameBroker\docs\SDK.md`. For a complete working
level-3 game in about 150 lines, see `C:\CodeProjects\GameBroker\examples\hello-game\`.

**Don't edit anything under `C:\CodeProjects\GameBroker`.** If you need something from
the SDK or the platform, write it under "SDK requests" in your report (step 9).

---

## What Bar Games is, in one paragraph

A Bar Games box is a small server at a venue (a bar, kava bar or office). It hosts web
games in Docker containers and puts them on the venue's domain behind Cloudflare (for
example `bingo.kavabar.com`). It only lets in people on the venue's Wi-Fi, casts a
game's big-screen "table" view to the TVs, and lets staff control games from an iPad.
It also sends game events to Home Assistant, so a bingo win can flash the lights. A game
that integrates with the SDK gets four things:
- the venue's name and colors (**branding**);
- a report of what happens (**events**);
- control from the iPad (**commands**);
- a status listing of its rooms.

## The rules (non-negotiable)

1. **Standalone behavior must not change at all.** The game also runs on its own
   (`bingo.4pg.org` and the user's dev sites). With no `BG_*` environment variables,
   every page, color, name, route, log line and test result must stay exactly as it is
   today. The SDK is built for this: `emit` is a no-op, `applyTheme` ignores standalone,
   `watchVenue` never fires, and `clientIp` returns the old value. Anything you add
   yourself that only makes sense on a box goes behind `bg.connected` (server) or
   `isOnBox(ctx)` (client).
2. **Keep everything the game already has:**
   - its own `/admin` page and password;
   - `GAME_NAME`;
   - its room flow, roles, rate limits and the existing `cf-connecting-ip` behavior
     (replace it with `clientIp()`, which keeps that behavior off a box).
3. **Never send `BG_GAME_TOKEN` to a browser**, and never log it.
4. **On a box, the container is sandboxed:**
   - the root filesystem is read-only, so writes may only go to `/data` and `/tmp`;
   - there's no internet and no LAN, so the server can't call out (browsers still can);
   - it runs with no capabilities;
   - memory is limited.
5. **Don't refactor beyond what the integration needs.** Follow the repo's own
   CLAUDE.md conventions, and keep its tests passing. Add tests for what you add.
6. **Don't deploy anything** to the user's production or dev sites as part of this work.

## Integration levels: aim for level 3

| Level | You add | Result on a box |
|---|---|---|
| 0 | `bargames.json` and an image that runs read-only | Hosted, gated, castable |
| 1 | The SDK middleware, the `--venue-*` CSS variables, the venue name | The venue's name and colors |
| 2 | `bg.emit(...)` at state changes | Home Assistant triggers, live feed on the iPad |
| 3 | `bg.onCommand(...)` and `bg.setStatusProvider(...)` | Start, pause and end from the iPad; room list |

Work through them in order, and get each level fully working before starting the next.

---

## Step 1: Vendor the SDK

1. Copy `C:\CodeProjects\GameBroker\integration\bargames-sdk-0.1.0.tgz` to
   `<repo>\vendor\` (create the folder).
2. Add the dependency to **both** the `server` and `client` workspace `package.json`:
   ```json
   "@bargames/sdk": "file:../vendor/bargames-sdk-0.1.0.tgz"
   ```
3. Run `npm install` at the repo root and commit the lockfile change along with it.
4. **Dockerfile:** the `npm ci` layer needs the tarball. Next to the other
   `COPY …package.json` lines, before `RUN npm ci`, add:
   ```dockerfile
   COPY vendor ./vendor
   ```
5. The CLI is now available as `npx bargames` (try `npx bargames` with no arguments).

**Updating later:** a newer SDK arrives as a new file name, for example
`bargames-sdk-0.2.0.tgz`. Replace the file, update both `package.json` entries, and run
`npm install`. Never overwrite a tarball under the same name: the lockfile's integrity
hash would then fail `npm ci`.

## Step 2: The manifest, `bargames.json`, at the repo root

Start from `snippets/bargames.example.json`, then fill it in from the repo:

| Field | How to fill it |
|---|---|
| `id` | A short lowercase slug: `bingo`, `cah`, `pool`. It's also the default hostname. |
| `name`, `version` | The game's name, and the version from the root `package.json` (semver) |
| `image` | `bargames/<id>:<version>`. For now the box builds images locally. |
| `port` | The server's default `PORT` from `server/src/config.ts` |
| `routes.player` | Where a guest starts (usually `/`) |
| `routes.table` | **The TV view for a room, using `{code}`.** Requirements are in step 7. |
| `routes.host` | Where a host starts or controls a room |
| `health` | `/health` (all the games already have it) |
| `events`, `commands` | Exactly what you implement in steps 5 and 6. Nothing more. |
| `brandable` | `["displayName", "tagline", "accent"]` |
| `resources.memory` | `256m` is enough for these games. Use more only if you measured a need. |
| `network.internet` | `false` |
| `env` | `{ "DATA_DIR": "/data" }`, so persisted state lands in the box's volume. Static and non-secret only. Never `BG_*`. |

Check it with `npx bargames validate .`. A warning about the image not being pinned by
digest is expected for now.

## Step 3: Server wiring (level 1)

1. Copy `snippets/bargames.ts` to `server/src/bargames.ts`. Set `gameId` to the
   manifest `id`, and `defaultName` to the game's existing default-name expression.
2. In `server/src/index.ts`, mount the middleware **before** `/api` routes, static files
   and the SPA catch-all (`app.get("*", …)` would otherwise swallow `/__bargames/*`):
   ```ts
   import { bg } from "./bargames.js";
   app.use(bg.middleware());
   ```
3. **Name:** the client gets its title from `/api/config` (`useGameName`). Make that
   route return the venue's name on a box and leave it unchanged otherwise:
   ```ts
   app.get("/api/config", async (_req, res) => {
     res.json({ gameName: await displayName(process.env.GAME_NAME || DEFAULT_GAME_NAME) });
   });
   ```
   Every screen that already uses `useGameName()` is then branded with no client change.
4. **Client IP:** replace every
   `req.get("cf-connecting-ip") ?? req.socket.remoteAddress` and every socket.io
   `handshake.headers["cf-connecting-ip"]` lookup with `clientIp(req)` /
   `clientIp(socket.request)`.
   - **Why:** on a box, LAN players come through the box's gateway. Without this change,
     they would all share one IP, so one person's failed joins would rate-limit the whole
     bar.
5. On shutdown (the existing SIGTERM handler), call `void bg.flush()` before exiting.

## Step 4: Client branding (level 1)

1. Copy `snippets/useVenue.ts` to `client/src/useVenue.ts`. Point the `serverUrl`
   import at whatever the client already uses for the server origin. Call `useVenue()`
   once at the app root.
2. **Map the game's existing colors to the venue variables, with fallbacks to the
   current values.** For example, in `index.css`:
   ```css
   :root {
     --bg: var(--venue-bg, #101528);          /* current value stays as the fallback */
     --accent: var(--venue-accent, #4cc9f0);
   }
   ```
   - The variables are `--venue-bg`, `--venue-surface`, `--venue-text`,
     `--venue-primary`, `--venue-accent`, `--venue-font`, `--venue-radius` and
     `--venue-logo` (a CSS `url()`).
   - Standalone, these variables are never set, so every fallback applies and nothing
     changes.
3. **Choose carefully.** Map the venue's colors onto the game's *chrome*: backgrounds,
   surfaces, headings and primary buttons. Leave meaning-carrying colors alone: bingo
   ball letters, card suits, pool ball colors, win/lose states, and anything that
   encodes game state. If the game has a theme picker (CAH's table style presets, for
   example), the venue theme only replaces the default, and the picker keeps working.
4. **Logo (optional):** where the game shows its title on the table view, show the venue
   logo too when `isOnBox(ctx) && ctx.game.theme.logoUrl`.
5. **Readability:** the venue chooses its colors, and the box warns them about poor
   contrast. Don't put venue colors on text that sits on top of the game's own fixed
   colors.

## Step 5: Events (level 2)

Emit from the server at the points where the game already changes state, usually in
`Room.ts` / `RoomManager.ts`, right where the state changes and the broadcast happens:

```ts
bg.emit({ type: "winner", roomCode: room.code, sessionKind: room.kind, data: { name: player.name } });
```

| Event | When | `data` (keep it small) |
|---|---|---|
| `room_created` | A room is created | `{ title? }` |
| `room_closed` | A room closes (host, idle sweep or shutdown) | `{ reason }` |
| `players_changed` | The player count changes. **At most once every 2 s per room** (debounce), and not for reconnects. | `{ players }` |
| `round_started` | A game, round or rack begins | `{ round }` and game-specific detail |
| `round_ended` | A round finishes without the session ending | `{ round }` |
| `claim_pending` | A claim waits on the host (for example, a bingo call) | `{ name }` |
| `winner` | A round or game has a winner | `{ name, …game-specific }` |
| `game_over` | The whole session is finished | `{ winners? }` |
| `x-<game>-<thing>` | Custom, used sparingly. Something a venue would want to trigger lights or sound on. | free-form |

- **Fire-and-forget:** never `await` emit, and never wrap it in game logic. It can't
  throw, and off a box it does nothing.
- **Privacy:** only display names that players typed. No IPs, no socket ids, no
  messages or card text.
- **`sessionKind`:** add a `kind: "venue" | "patron" | "private"` field to the room,
  defaulting to `"patron"`. The box will later create `"venue"` rooms, so keep the field
  even though everything is `"patron"` today.
- **Declare** every type you emit in `bargames.json` `events`.

## Step 6: Commands and status (level 3)

```ts
bg.onCommand("start", ({ roomCode, args }) => { … return { ok: true } ; });
bg.setStatusProvider(() => ({ rooms: [...] }));
```

- **A command acts as the room's host.** Run it through the same `Room` method the
  host's socket intent uses, so validation, state changes, timers and the broadcast to
  every client happen exactly the same way. Don't write a second, parallel code path.
- **Return values:**
  - `{ ok: false, message }` for an unknown room or a state where the command makes no
    sense (for example, `start` while already playing);
  - never throw;
  - return within about 2 s.
- **Command meanings.** Implement only the ones that fit the game, and list exactly
  those in the manifest:
  | Command | Meaning |
  |---|---|
  | `start` | Begin play from the lobby, as the host's start button does |
  | `pause` / `resume` | Pause and resume automatic progress (auto-call, turn timers) |
  | `next_round` | Move on to the next game, round or rack, keeping the players |
  | `end` | End the session. Close the room the way the host's "close room" does. |
- **Status:** one entry per room:
  - `code`;
  - `kind`;
  - `players` (players only, not tables or viewers);
  - `phase` (the game's own phase names);
  - optional `title` and `hostConnected`.

## Step 7: The table (TV) view

The box opens `routes.table` with a real room code in a headless Chromium at 1920×1080,
then casts it to TVs. **Nobody can click or type on that screen.** Check each item, and
fix whatever fails:

- [ ] The URL alone joins the room as a display. There's no name prompt, consent prompt,
      "tap to start", or anything that needs a gesture.
- [ ] Nothing depends on audio autoplay. Sound is a bonus, not a requirement.
- [ ] It fills 1920×1080 with no scrolling. Text is readable from across a room (about
      3vh or larger), with no hover-only information, and safe margins of about 4–5%.
- [ ] It recovers on its own from a server restart or a dropped socket: it reconnects
      and shows the room again, or a clear "room closed" screen.
- [ ] It's light on animation. A static board is cheaper to cast than constant motion.

If the table route needs a key or role parameter, the `{code}` URL must still work
display-only. If it can't, write that in your report.

## Step 8: Container compatibility (level 0)

- The image must run with:
  - a read-only root filesystem;
  - a writable `/data` volume and `/tmp`;
  - no capabilities;
  - `PORT` set by the box.

  Find every place the server writes files (admin settings, password store, logs) and
  make sure they all go under `DATA_DIR`.
- Add a non-root user to the final stage:
  ```dockerfile
  RUN mkdir -p /data && chown node:node /data
  USER node
  ```
- Test it, if Docker is available:
  ```bash
  docker build -t bargames/<id>:dev .
  docker run --rm --read-only --tmpfs /tmp --cap-drop ALL -v bgtest:/data -e PORT=<port> -p <port>:<port> bargames/<id>:dev
  ```
- Fonts and scripts loaded *by the browser* from CDNs still work. Anything the *server*
  fetches from the internet won't work on a box.

## Step 9: Test it like a box, then report

**Automated tests (`npm test`):** keep all existing tests passing, then add:
- a standalone test: no `BG_*` env, `/api/config` returns the old name, and
  `/__bargames/venue.json` says `"standalone": true`;
- tests for each command handler: a good room, an unknown room, and a wrong state;
- a test that `clientIp` is used where rate limiting reads the IP.

**Against a pretend box** (the SDK ships one). Use three terminals, all in the repo root:

1. Build the client so the server serves it, then start the mock box:
   ```bash
   npm run build
   npx bargames mock-box .
   ```
   This starts a fake core on `:7199` and a fake gateway on `:7080` that forwards to
   your game. It prints the env vars to use, and then every event your game emits.
2. Start the game server with those env vars:
   ```bash
   BG_GAME_ID=<id> BG_CORE_URL=http://127.0.0.1:7199 BG_GAME_TOKEN=dev-token PORT=<port> node server/dist/index.js
   ```
3. Run the checks and drive the game:
   ```bash
   npx bargames check            # must end with "all checks passed"
   npx bargames status
   npx bargames command start --room <CODE>
   ```

Then open `http://localhost:7080` and play a round: create a room, join from a second
browser, open the table route.
- **Expect:** the test branding (teal background, pink and yellow, Georgia font, name
  "<Name> (mock)") and the events appearing in terminal 1.
- **Finally,** run the game the normal way (`npm run dev`, no `BG_*` vars) and confirm
  it looks and behaves exactly as before.

**Report:** write `BARGAMES.md` at the game repo's root containing:
- the level reached, plus the `npx bargames check` output;
- the events, each with where it's emitted (`file:line`) and its `data` shape;
- the commands, each with the Room method it maps to and its refusal cases;
- the table route and the result of each step 7 checklist item;
- the container: the paths written to under `/data`, and the read-only test result;
- what you changed in standalone code paths, and how you verified nothing changed;
- **SDK requests:** anything the SDK or platform should do differently.

The Bar Games side uses that file to install and test the game on a real box.
