# Bar Games SDK (`@bargames/sdk`)

How to make a web game run on a Bar Games box: venue branding, events for Home
Assistant, and remote control from the venue's iPad. Every step is optional. A game
works on the box at level 0 with no code changes, and still runs **standalone**
(off a box) at every level.

## Integration levels

| Level | You add | The venue gets |
|---|---|---|
| **0: Hosted** | A `bargames.json` and a container image | Hosting, venue Wi-Fi gate, PIN, on/off, casting to TVs, a theme stylesheet injected into your HTML |
| **1: Branded** | Read the venue context and use the `--venue-*` CSS variables | The game in the venue's colors, logo and name |
| **2: Connected** | `bg.emit(...)` on game events | Home Assistant triggers, live events on the iPad, stats |
| **3: Controllable** | `bg.onCommand(...)` and a status provider | Start/pause/end from the iPad, schedules, Home Assistant actions |

`examples/hello-game` is a complete level-3 game in about 150 lines. **Retrofitting an
existing game?** Follow [integration/README.md](../integration/README.md). It's the
step-by-step guide, and it comes with the packaged SDK and snippets.

## 1. The manifest: `bargames.json`

```jsonc
{
  "id": "bingo",                       // slug; default hostname label (bingo.example.com)
  "name": "Bingo",
  "version": "1.4.0",                  // semver
  "image": "ghcr.io/you/bingo:1.4.0@sha256:…",   // pin by digest for releases
  "port": 3002,                        // your server's port inside the container
  "sdk": { "version": "0.1.0", "level": 3 },
  "routes": {
    "player": "/",
    "table": "/room/{code}?role=table",  // big-screen view; {code} = room code
    "host": "/?host=1"
  },
  "health": "/health",
  "events": ["room_created", "round_started", "claim_pending", "winner", "game_over"],
  "commands": ["start", "pause", "resume", "end"],
  "brandable": ["displayName", "tagline", "accent"],
  "sessionKinds": ["venue", "patron", "private"],
  "resources": { "memory": "512m", "cpus": 1 },
  "network": { "internet": false },      // false = no internet, no LAN (recommended)
  "env": { "GAME_NAME": "Bingo Night" }  // static, non-secret; BG_* is reserved
}
```

Check it with `bargames validate .` (the CLI ships with the SDK).

**Apps (SDK 0.6.0):** `"kind": "app"` marks an app (a menu, signage…) instead of a game:
no rooms, `sessionKinds` unused, level 1. `routes.table` (its TV view, no `{code}`) is
optional; with it the box casts the app without a room and can put it on idle TVs or start
it on a TV at boot. The box installs and updates apps on its Apps tab and lists them apart
from the games (`ctx.venue.apps`). `kind` defaults to `"game"`. SDK 0.5.0's
`"kind": "display"` is read as `"app"`; boxes older than 0.5.0 ignore `kind`.
Helpers: `isApp(manifest)` (`isDisplayModule` is its 0.5.0 alias).

## 2. What the box gives your container

| Env var | Meaning |
|---|---|
| `PORT` | The port from your manifest |
| `BG_GAME_ID` | Your game id |
| `BG_CORE_URL` | Where the SDK reaches the box (internal network) |
| `BG_GAME_TOKEN` | Secret for events/commands. **Never send it to browsers** |
| `BG_PUBLIC_URL` | Your public origin, e.g. `https://bingo.example.com` |
| `BG_DATA_DIR` | `/data`: your only writable, persistent directory |

**Sandbox rules:**
- The root filesystem is read-only, plus a 64 MB `/tmp`.
- The container runs non-privileged with no capabilities and memory/CPU limits.
- Its network is private, and only the box's gateway can reach it.

**Requests arrive through the gateway with:**
- `x-bargames-via: 1`
- `x-bargames-client-ip`
- `x-bargames-access`: `local`, `venue-ip`, `whitelist` or `pin`
- `x-forwarded-proto`

WebSockets (socket.io) are proxied.

## 3. Server: `@bargames/sdk/server`

```ts
import { createBarGames } from "@bargames/sdk/server";

const bg = createBarGames({ gameId: "bingo", defaultName: process.env.GAME_NAME ?? "Bingo Night" });

app.use(bg.middleware());               // serves /__bargames/* (venue.json, theme.css, command, status)

// Level 2: events. Fire-and-forget; queued and retried briefly; no-op when standalone.
bg.emit({ type: "winner", roomCode: room.code, sessionKind: room.kind, data: { name: player.name } });

// Level 3: commands from the iPad / schedules / Home Assistant.
bg.onCommand("start", ({ roomCode }) => {
  const room = rooms.get(roomCode!);
  if (!room) return { ok: false, message: "no such room" };
  room.start();
  return { ok: true };
});
bg.setStatusProvider(() => ({
  rooms: [...rooms.values()].map((r) => ({ code: r.code, kind: r.kind, players: r.players.size, phase: r.phase })),
}));

// Venue branding on the server (e.g. for server-rendered pages or the GAME_NAME default).
const ctx = await bg.venue();           // cached 30 s; standalone defaults off a box

// Real player IP (rate limits, logs). On a box: from the gateway. Off a box:
// cf-connecting-ip, else the socket address. Works with socket.io's socket.request.
const ip = bg.clientIp(req);
```

Gateway headers (`x-bargames-*`) are trusted only when `bg.connected`, so nobody can
spoof them on a standalone deployment.

**Standard events:**
`room_created`, `room_closed`, `players_changed`, `round_started`, `round_ended`,
`claim_pending`, `winner`, `game_over`. Custom events must start with `x-`, for
example `x-pool-break`.

**Standard commands:**
`start`, `pause`, `resume`, `next_round`, `end`.

## 4. Browser: `@bargames/sdk/client`

```ts
import { getVenue, applyTheme, gameName, watchVenue } from "@bargames/sdk/client";

const venue = await getVenue();         // null when served without the SDK middleware
applyTheme(venue, { title: true });     // no-op when null or standalone: off a box nothing changes
document.querySelector("h1")!.textContent = gameName(venue, "Bingo Night");
```

`isOnBox(ctx)` tells you whether the game is running on a box. `watchVenue` only fires
on a box. If the page isn't served by the game server (a Vite dev server on another
port), pass `{ base: serverUrl }` to `getVenue` or `watchVenue`.

Then style with the variables. Always include a fallback, so the game still looks right
when it runs standalone:

```css
body { background: var(--venue-bg, #101528); color: var(--venue-text, #f4f6ff); font-family: var(--venue-font, system-ui); }
.ball { background: var(--venue-primary, #f2b33d); }
.accent { color: var(--venue-accent, #4cc9f0); }
```

The variables are:
- `--venue-bg`
- `--venue-surface`
- `--venue-text`
- `--venue-primary`
- `--venue-accent`
- `--venue-font`
- `--venue-radius`
- `--venue-logo` (a CSS `url()`)

**React hook** (the games use React 18):

```tsx
import { applyTheme, watchVenue, type VenueContext } from "@bargames/sdk/client";
import { useEffect, useState } from "react";

export function useVenue(): VenueContext | null {
  const [ctx, setCtx] = useState<VenueContext | null>(null);
  useEffect(() => watchVenue((c) => { applyTheme(c); setCtx(c); }), []);
  return ctx;
}
```

**The venue around the game (SDK 0.4.0).** All of these are empty / no-ops standalone:

```ts
import { gamesLink, announcementBanner, gamesListUrl, otherGames, activeAnnouncement } from "@bargames/sdk/client";

const link = gamesLink(venue, { container: landingEl }); // "← All games" + "Also playing: …", landing page only
const news = announcementBanner(venue);                   // staff announcement, sticky strip at the top (phone pages)
watchVenue((c) => { link.update(c); news.update(c); }, 30_000);
```

- `gamesListUrl(ctx)`: the venue's games list (`ctx.venue.playUrl`).
- `otherGames(ctx)`: the other games on tonight (`ctx.venue.games`, this one left out).
- `activeAnnouncement(ctx)`: `{ id, text, until? }` unless expired.
- `gamesLinkHtml(ctx)` / `GAMES_LINK_CSS`: the link's escaped HTML and CSS, for your own
  rendering. The box's gateway adds the same link to the landing page of games without
  the SDK (level 0).
- In status, `joinPath` on a room (e.g. `/join/KQ7P`) puts a **Join** button for it on
  the venue's games list (venue and patron rooms only).

**SDK 0.8.0 additions:**
- `bg.checkVenuePassword(password, clientIp?)` (server): true when it's the venue box's admin
  password, so the game's admin login accepts it too (the box limits guesses). Kit 0.5.0:
  `createAdminAuth({ venuePassword: (pw, ip) => bg.checkVenuePassword(pw, ip) })`.
- Box admin login sets the venue-wide staff cookie, so `bg.isStaff` holds on direct visits.

**SDK 0.7.0 additions:**
- `bg.isStaff(req)` (server): true for staff signed in to the box admin (the gateway's
  `x-bargames-staff: 1`, trusted only on a box). With the game kit:
  `adminRouter({ ..., trusted: (req) => bg.isStaff(req) })` and `staffSignIn()` on the
  client. Manifest `routes.admin`: the page the box links to.
- `CreateRoomArgs.firstJoinerHosts`: the box put the room on a TV with no host; the first
  player to join becomes the host.

**SDK 0.5.0 additions:**
- `ctx.venue.location` (`{ latitude, longitude, label? }`), `ctx.venue.timezone` (IANA),
  `ctx.venue.units` (`"imperial" | "metric"`), `ctx.venue.modules` (display modules;
  never in `ctx.venue.games`).
- `--venue-on-primary` / `theme.colors.onPrimary?`: text on the primary color. Absent,
  `onPrimary(colors)` picks #111111 or #ffffff by contrast.
- `markSharedScreen(on?)` / `isSharedScreen()`: mark a page as a TV/shared screen
  (`<html data-bargames-screen="shared">`). `tableMode` does it for you. The announcement
  banner hides there; `ANNOUNCEMENT_HIDE_CSS` does the same for your own markup with
  class `bargames-announcement`.
- `tableMode` keeps the screen awake; a game needs no wake-lock code of its own while
  it's on.

**Big-screen (`table`) views:**
- Design for 1080p, seen from across a room: text 3vh or larger, no hover, and safe margins of about 4–5%.
- The broker loads the table view in Chromium and casts it. Keep animations light: a static board at 10–15 fps is cheaper than 30 fps motion.

## 5. Session kinds

Rooms are `venue` (run by staff, shown on the venue TVs), `patron` (started by a guest
from the landing page) or `private` (a booking). Pass the kind in events. Typical uses:
- Only the host gets controls in `venue` rooms.
- In `patron` rooms, the first player becomes host.

## 6. Retrofitting an existing game (e.g. Bingo)

See [integration/README.md](../integration/README.md).

## 7. Testing without a box

The `bargames` CLI ships with a pretend box:

| Command | What it does |
|---|---|
| `bargames mock-box [dir]` | Fake core on :7199 (venue context in loud test colors, prints and validates your events) and a fake gateway on :7080 in front of your game (adds the `x-bargames-*` headers, proxies WebSockets) |
| `bargames check [dir]` | Conformance checks: health, venue.json, theme.css, status auth and shape, every declared command wired |
| `bargames status` | Room status, as the box's iPad sees it |
| `bargames command <name> --room CODE` | Sends a command |

## Versioning

- `PROTOCOL_VERSION` changes only on breaking changes. The box supports the current and previous major version.
- New SDK versions only add optional fields, helpers and commands. The box never checks
  `sdk.version`: it goes by `sdk.level` and the declared events and commands, so a game
  on an older SDK keeps working and just doesn't use the newer features.
- Manifests declare `sdk.version`.
- `minBoxVersion` keeps a game off boxes that are too old for it.
