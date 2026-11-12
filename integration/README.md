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
| `snippets/VenueExtras.tsx` | React components for the games link and announcements (SDK 0.4.0, hide on shared screens 0.5.0) |
| `snippets/bargames.example.json` | An example manifest (Bingo) |
| `snippets/publish-image.yml` | GitHub Actions workflow that publishes the image (step 10) |

For the full API, see `C:\CodeProjects\GameBroker\docs\SDK.md`. For a complete working
level-3 game in about 150 lines, see `C:\CodeProjects\GameBroker\examples\hello-game\`.

**Don't edit anything under `C:\CodeProjects\GameBroker`.** If you need something from
the SDK or the platform, write it under "SDK requests" in your report (step 9).

## What's new in SDK 0.11.0 (announcements anywhere, quickly; a way back to the box admin)

- **Venue changes arrive in seconds.** On box 0.12.0 the gateway holds `watchVenue()`'s
  request until the venue changes, so an announcement goes up and comes down within a few
  seconds (it was up to a minute). Nothing to change: update the SDK. Off a box, it polls as before.
- **Announcements say where they show:** `announcement.show` is `"everywhere"` (default),
  `"phones"` or `"tvs"`, and `announcement.position` is `"top"` (default) or `"bottom"`.
  `announcementBanner()` (and kit 0.7.0's `VenueAnnouncement`) follow both. **Use it on your TV
  view too** (after `tableMode()`/`markSharedScreen()`): it hides itself where it doesn't belong.
  Drawing your own? Respect `show` against your page being shared or not.
- **0.11.1 mock box:** `--announce "…" --announce-show tvs --announce-position bottom` sets the
  pretend announcement's placement, and venue.adminUrl points at a pretend admin page, so
  `BoxAdminLink` shows up on the mock.
- **"← Box admin":** `venue.adminUrl` is the box admin's address; `boxAdminUrl(ctx)` returns it
  on a box (undefined standalone). Put a link at the top of your admin pages (kit 0.7.0:
  `<BoxAdminLink ctx={venue} />`), so staff who opened your settings from the box get back.

## What's new in SDK 0.10.0 (games under a path: venue.example.com/bingo)

The box is moving to one hostname per venue: the games list at `https://<venue host>/`, each
game at `/<game>/`. A game that can't run under a path keeps its own subdomain, so nothing
breaks; adopt this when you can. It also lets a self-hosted game sit behind any reverse
proxy (`BASE_PATH=/bingo`). Unset, the game runs at the root exactly as before.

- **The proxy strips the prefix.** Your server keeps its routes: `/api`, `/admin`,
  `/socket.io`, `/__bargames/*`. Nothing to change on the server's routing.
- **Your server learns the prefix** from `BG_BASE_PATH` (set by the box) or `BASE_PATH`
  (self-hosted): `bg.basePath`, or `basePathFromEnv()`. `VenueContext.game.basePath` too.
- **Put it in your HTML** when you serve index.html: `injectBasePath(html, bg.basePath)` adds
  `<meta name="bargames-base" content="/bingo">` and `<base href="/bingo/">`. With the game
  kit (0.6.0+) use `serveSpa(app, { dist })`, which does it for you.
- **Build the client with Vite `base: "./"`** so asset URLs are relative.
- **Client links:** `bgUrl("/api/rooms")` → `/bingo/api/rooms`; `basePath()` for React
  Router's `basename`; socket.io: `io(origin, { path: socketIoPath() })` (not
  `io(origin + "/bingo")`: socket.io reads a URL's path as a namespace). The SDK's own
  `getVenue()` / `watchVenue()` already use the prefix.
- **`bg.publicUrl(path)`** keeps the prefix (`https://venue.example.com/bingo/join/ABCD`).
  `joinUrl(base, path)` does the same for your own links.
- **Declare it** in bargames.json: `"routing": { "basePath": true }`. Without it the box keeps
  the game on its subdomain.
- **0.10.4 (media apps):** `bg.tvs()` adds `activeApp` per TV, asked of the TV itself (Roku):
  your launchable app (`"youtube"`), `"home"`, or `"other"`. Trust it over a link's own idea
  of "open" (a YouTube link can say connected after the app closed): not `"youtube"` →
  `bg.launchApp()`, wait, then play. The mock box's fake Roku starts on `"home"`.
- **0.10.3:** `bg.basePath` logs a warning, and `mock-box --base` refuses to start, when the
  prefix isn't a path (the Git Bash rewrite). Kit 0.6.2: `serveSpa` answers missing files
  (under /assets/, or with a file extension) with 404 instead of the page.
- **0.10.2:** the client `joinUrl(ctx, path)` keeps the prefix (it dropped it in 0.10.0/0.10.1;
  update if you build join links or QRs with it). `injectBasePath` at the root now adds
  `<base href="/">` (unless the page has its own), so a Vite `base: "./"` build works on deep
  links like `/room/ABCD` there too.
- **0.10.1:** the mock box's staff sign-in also answers at `/<base>/__bargames/staff`, and a
  `next` without the prefix gets it, like the box (`next=/admin` → `/my-game/admin`).
- **Git Bash on Windows** rewrites `/my-game` into `C:/Program Files/Git/my-game`: run with
  `MSYS_NO_PATHCONV=1` (e.g. `MSYS_NO_PATHCONV=1 npx bargames mock-box --base /my-game`).
- **Test it:** `npx bargames mock-box --base /my-game`, start the game with the
  `BG_BASE_PATH` it prints, and click through `http://localhost:7080/my-game/`: every page,
  join link, QR, socket and the admin. The mock gateway strips the prefix, redirects `/` to
  it, puts it back on your redirects, and 404s anything outside it (a bare `"/api/…"` fetch
  shows up there).

## What's new in SDK 0.9.0 (results, countdowns, attention, media apps)

**Use 0.9.1:** `bargames check` now runs the media checks for apps too (0.9.0 skipped them), and `validate` no longer warns about level 3 on media apps.

All optional; a game on 0.8.0 keeps working. Off a box every new call is a no-op. Full plan:
`C:\CodeProjects\GameBroker\docs\SDK-0.9.md`. Vendor `bargames-sdk-0.9.0.tgz` (kit 0.5.1
still fits).

1. **Results → leaderboards.** When a game ends, call
   `bg.reportResults({ roomCode, results: [{ player: { name }, place: 1 }, { player: { name }, place: 2, score: 1200 }] })`.
   The box keeps tonight's (from 4 AM venue time) and all-time boards per game, shows
   "Tonight's winners" on the games list and idle TVs, and the venue context carries
   `venue.leaderboards`. It also emits the standard event `game_result`. Rewards will hook
   into these results later, with nothing more to do in games.
2. **Lobby countdown.** `bg.startCountdown({ label: "Bingo starts in", minutes: 5, roomCode })`
   shows a ticking countdown, with a Join link to that room, on phones, the games list and
   idle TVs; `bg.clearCountdown()` ends yours. On pages: `countdownBanner(ctx)` (client),
   or `activeCountdown(ctx)` + `formatCountdown(s)` for your own markup. Staff can start
   one from the box too, and scheduled sessions do.
3. **Needs attention.** `bg.setAttention([{ level: "warn", message: "Google disconnected", actionPath: "/admin#google" }])`
   puts items on the box's Tonight page with an "Open" link into your admin (staff are
   signed in through the box). Send `[]` to clear; send the full list each time.
4. **Media apps** (apps that put their own content on TVs; the YouTube app): manifest
   `"media": { "launch": ["youtube"] }`, sdk.level 3, commands `media_list`, `media_play`,
   `media_stop` (helpers `bg.onMediaList/onMediaPlay/onMediaStop`), `status.media.targets`,
   `bg.tvs()` (every venue TV, with `canLaunch` and, for YouTube on Rokus, a DIAL
   `youtubeScreenId`), `bg.launchApp(displayId, app)`. The box's command timeout is 5 s:
   answer `media_play` with `pending: true` while a TV app starts, and let status show
   `starting` → `playing`. Types: `MediaItem`, `MediaTarget`, `MediaPlayArgs`, `BoxTv`.
5. **Stubs to build on later** (they compile today, do nothing yet): `bg.profile(req)` →
   undefined and `venueProfile()` → null (player profiles); `bg.audioOutputs()` → [] and
   `bg.playSound()` → `{ ok: false, reason: "not-built" }` (venue sound outputs: keep
   playing sounds locally for now).
6. **Checks:** `npx bargames check` no longer creates or ends rooms on a game that isn't
   connected to the mock box (pass `--live`, last, to override). It checks media apps'
   `media_list` and `status.media`. The mock box answers every new call (results,
   countdown, attention, tvs/launchApp with a fake Roku, profiles 501).

## What's new in SDK 0.8.0 (the box's password works in every game)

1. **Vendor** `bargames-sdk-0.8.0.tgz` and game kit **0.5.0**
   (`gh release download v0.5.0 --repo thezigpc/gamekit --pattern "*.tgz" --dir vendor --clobber`).
2. **The box admin password opens your admin too.** Typed into your game's admin login, the
   venue box's admin password works, even before your game has a password of its own.
   - Kit games: `createAdminAuth({ ..., venuePassword: (pw, ip) => bg.checkVenuePassword(pw, ip) })`.
     The box is only asked when your own password doesn't match.
   - Own login code: when the password is wrong (or none is set), try
     `await bg.checkVenuePassword(password, bg.clientIp(req))`.
   - The box limits wrong guesses itself (per game + client, and box-wide). Off a box it's
     always false.
   - Mock box: the box password is `box-password` (MockBoxOptions.venuePassword).
3. **Kit 0.5.1: the box's password takes over on a box.** Pass `onBox: bg.connected` to
   `createAdminAuth` as well. `/api/admin/status` then says `venueLogin: true` (show the
   sign-in form for the box password, not first-run setup) and `setupAllowed` (false unless
   the box vouches for staff); `/api/admin/setup` refuses guests, so nobody on the venue
   Wi-Fi can claim your admin by setting its password first. Off a box nothing changes.
   Own login code: do the same yourself on a box (no first-run setup unless `bg.isStaff`).
4. **Signed in to the box = signed in to your admin.** Logging in to the box admin on its
   venue address (admin.<domain>) now sets the staff cookie for the whole venue domain, so
   `staffSignIn()` (0.7.0) works when staff open your admin directly, not only from the
   box's Settings button. Nothing to change if you did 0.7.0's staff sign-in.

## What's new in SDK 0.7.0 (staff sign-in, first joiner hosts)

**Use 0.7.1:** 0.7.0's `onCreateRoom` dropped `firstJoinerHosts`, so no game could see it. 0.7.1 passes it through; nothing else changed.

1. **Vendor** `bargames-sdk-0.8.0.tgz` and, for kit games, game kit **0.4.0**
   (`gh release download v0.4.0 --repo thezigpc/gamekit --pattern "*.tgz" --dir vendor --clobber`).
2. **Staff sign-in.** Staff signed in to the box admin open your game's settings from the
   box (Games/Apps tab, "Settings") without your game's password:
   - `bargames.json`: declare the page as `routes.admin` (e.g. `"/admin"`). Apps that put
     it in `routes.host` (0.6.0) keep working, but add `routes.admin` too.
   - Server: `adminRouter({ auth, clientIp, trusted: (req) => bg.isStaff(req) })` (kit), or
     check `bg.isStaff(req)` yourself. It's true only for requests through the box's
     gateway from a browser the box signed in; always false standalone.
   - Client: on the admin page, before the password form, `const token = await
     staffSignIn(serverUrl)` (kit 0.4.0, `@bargames/gamekit/client`); a token means
     signed in, so skip the form. `undefined`: show the normal login.
   - Test it on the mock box: open `/__bargames/staff?next=/admin` on the mock gateway
     (`?off=1` signs out); requests then carry `x-bargames-staff: 1`.
3. **First joiner hosts.** Staff can now put a game on one TV from the box's TVs page. The
   box sends `create_room` with `args.firstJoinerHosts: true`: nobody is the host yet,
   so **the first player who joins (scanning the TV's QR code) becomes the host**, with the
   same powers as a phone host who created the room. Without the flag, keep today's
   behavior (a venue room the box controls). Games without a host role can ignore it.
4. **Slow casts:** a cast from inside the game now answers within about 6 s (the box says
   "starting" if TVs are still connecting). If you call it through the kit, you can also
   give it longer: `call.withTimeout(30_000)("castToTvs", …)`.

## What's new in SDK 0.6.0 (apps)

Games: nothing to do (vendor 0.6.0 with your next release if you like).

- **Apps:** `"kind": "app"` is the official name for what 0.5.0 called a display module
  (menus, signage, anything that isn't a game). `"display"` still works and is read as
  `"app"`. The box has an **Apps** tab next to Games, where apps are installed, updated and
  configured the same way.
- An app's TV view (`routes.table`) is now optional: an app without one just can't be cast
  or used on idle TVs.
- `ctx.venue.apps` lists the apps (`ctx.venue.modules` is the same list under its 0.5.0
  name). `isApp(manifest)` replaces `isDisplayModule` (kept as an alias).
- An app's `routes.host` gets an "Open its own settings" link on the box's Apps tab.

## What's new in SDK 0.5.0 (for games already on 0.4.0)

Nothing breaks, and nothing here is urgent: a 0.4.0 game keeps working on a 0.5.0 box.
Pick it up with your next release.

1. **Vendor the new tarball** (step 1, "Updating later"): `bargames-sdk-0.5.0.tgz`,
   both `package.json` entries, `npm install`, and `"sdk": { "version": "0.5.0", … }`.
2. **Shared screens hide the announcement on their own.** `tableMode(ctx)` now marks
   the page (`<html data-bargames-screen="shared">`), and `announcementBanner` hides
   itself there. A page that becomes a TV some other way (a table that joined a plain
   room URL with `?display=1`) calls `markSharedScreen()` (it returns an undo function).
   Your own announcement markup can use `ANNOUNCEMENT_HIDE_CSS` and the class
   `bargames-announcement`. The `hidden` prop/`remove()` from 0.4.0 still work; you can
   drop that wiring once `tableMode` or `markSharedScreen` is in place.
3. **Text on the venue's main color:** `--venue-on-primary` (and
   `theme.colors.onPrimary`, optional). The box picks dark or light ink for the primary
   color unless the venue chose one. Use it for anything you draw on `--venue-primary`
   (the SDK's announcement strip does).
4. **Wake lock:** `tableMode` already keeps the screen awake. Drop the game's own
   wake-lock code while `tableMode` is on (keep it standalone if you want it there).
5. **Venue location, time zone and units:** `ctx.venue.location` (`latitude`,
   `longitude`, `label`), `ctx.venue.timezone` (IANA), `ctx.venue.units`
   (`"imperial" | "metric"`). Optional; for anything time- or weather-aware.
6. **Menus are listed apart:** display modules (menus, signage) arrive in
   `ctx.venue.modules`, never in `ctx.venue.games`, so "Also playing" doesn't list them.
   Nothing to do.
7. **Updates on the box:** the box now checks each game's GitHub repo every 6 hours and
   shows "Update available" once the new image can be downloaded. Its Update button
   restarts the game on the new image, and rolls back if it won't start. See step 10.

## Apps (menus, signage…): SDK 0.6.0

A package with `"kind": "app"` in `bargames.json` is an app, not a game: no rooms, no
players, no join codes. The menu is the first one. (SDK 0.5.0 called these display
modules, `"kind": "display"`; that still works.)

- **Manifest:** `"kind": "app"`, `sdk.level` 1, `routes.player` (the phone page),
  `routes.table` (the TV view, no `{code}`; optional, but without it the app can't be cast
  or used on idle TVs), optional `routes.host` (its own settings page, linked from the
  box's Apps tab). `sessionKinds` isn't used. Ask for `network.internet: true` if it fetches
  anything outside the box (weather); game containers have no internet otherwise.
- **On the box:** installed and updated on the **Apps** tab; listed apart from the games
  on the venue's games list (a button above them); left out of "Also playing"; cast to
  TVs from the iPad without a room; selectable under Venue > "Idle TVs show" and as a
  TV's "When the box starts" choice (so a menu TV comes back by itself after a power cut).
  When a game room's TV goes idle, it shows the app.
- **TV view:** call `tableMode(ctx)` (pointer, wake lock, shared-screen marker). It runs
  unattended for hours, so it must survive network blips and pick up changes without a
  reload. Show the staff announcement yourself (`activeAnnouncement(ctx)`): idle TVs
  showing an app don't get the box's idle screen.
- **Phone page:** the landing page, so `gamesLink`/`<BackToGames />` at the bottom and the
  announcement at the top, as for games.
- **Checks:** `npx bargames check` checks the phone page and the TV view and skips the
  room checks; the mock box lists the app apart and casts its TV view without a room.

## What's new in SDK 0.4.0 (for games already on 0.3.0)

Nothing breaks: a game left on 0.3.0 keeps working on a 0.4.0 box, it just doesn't
show the new things. They're all on a box only; standalone, nothing changes (rule 1).

1. **Vendor the new tarball** (step 1, "Updating later"): `bargames-sdk-0.4.0.tgz`,
   both `package.json` entries, `npm install`, and `"sdk": { "version": "0.4.0", … }`.
2. **"← All games" on the landing page** (step 4, item 6): a link back to the venue's
   games list, with "Also playing: …" (the venue's other games) under it. Landing page
   only: not during play, never on the TV view. `gamesLink(ctx)`, or the React
   `<BackToGames />` in `snippets/VenueExtras.tsx` (or the game kit).
3. **Staff announcements** (step 4, item 7): "Last call at 1:30", typed on the box's
   iPad, shown as a dismissible strip at the top of the game's phone pages.
   `announcementBanner(ctx)`, or `<VenueAnnouncement />`. Not on the TV view: the box
   puts announcements on idle TVs itself.
4. **`joinPath` in status** (step 6): the venue's games list now shows each game's open
   rooms; set `joinPath` (e.g. `/join/KQ7P`) and it gets a **Join** button. Private
   rooms are never listed. `npx bargames check` warns when no room has one.
5. **Developer tools:** the mock box's "← All games" goes to a pretend games list at
   `/__bargames/dev/games` (your open rooms and their Join links); the context lists a
   fake second game; `mock-box --announce "Last call at 1:30"` posts a pretend
   announcement.

## What's new in SDK 0.3.0 (for games already on 0.2.x)

1. **Vendor the new tarball** (step 1, "Updating later"): `bargames-sdk-0.3.0.tgz`,
   both `package.json` entries, `npm install`, and `"sdk": { "version": "0.3.0", … }`.
2. **`room_closed` is required for castable games** (step 5). The box takes a closed
   room off the TVs the moment it hears it (TVs go to the venue's idle screen). Every
   way a room closes must emit it, and the room must leave status. `npx bargames check`
   now fails without it, and checks that `end` removes the room from status.
3. **More in status, for the box's Rooms page** (step 6, all optional):
   `createdAt`, `lastActivityAt`, `tables`, `maxPlayers`, `hostName`.
4. **`bg.publicUrl(path)`** (step 3): room links and QR codes on the venue's address,
   which follows a subdomain rename. Off a box it returns undefined: keep your own link.
5. **`tableMode(ctx)`** (step 7) for the TV view: hides the pointer, keeps the screen
   awake, gives you `--bg-safe-x/--bg-safe-y` and a standard "Reconnecting…" /
   "Room closed" banner. Replace the game's own versions of those on a box.
6. **Developer tools:** a third fake TV, `fake-unpaired`, answers like an unpaired TV;
   `npx bargames check --room CODE` checks one live room (its claims, times, table view);
   `npx bargames help` lists every command and the claim `--args`.

## What's new in SDK 0.2.1 (for games already on 0.2.0)

1. **Vendor the new tarball** (step 1, "Updating later"): `bargames-sdk-0.2.1.tgz`,
   both `package.json` entries, `npm install`, and `"sdk": { "version": "0.2.1", … }`.
2. **`confirm_claim` / `reject_claim`** (step 6, only for games with claims such as a
   BINGO call): staff resolve a pending claim from the box's iPad. List pending claims
   in status as `pendingClaims`.
3. **The mock box has two fake TVs** (step 9): test the step 6b "TVs" control with
   `npx bargames mock-box . --tv-pin 1234`.

Nothing else changed; 0.2.0 games keep working on a 0.2.1 box.

## What's new in SDK 0.2.0 (for games already on 0.1.0)

1. **Vendor the new tarball** (step 1, "Updating later"):
   the newest tarball (now `bargames-sdk-0.9.0.tgz`), both `package.json` entries, `npm install`, and set
   `"sdk": { "version": "0.9.0", … }` in `bargames.json`.
2. **`create_room`** (step 6): the box can start a venue room for the TVs.
3. **Casting from inside the game** (step 6b, optional): the host's screen can put
   the room on the venue's TVs, with the venue's TV PIN. It's box-only, so nothing
   changes standalone.
4. **Table view:** the box hides the mouse. Nothing on the TV may need a pointer
   (step 7).
5. Run `npx bargames check` again (it now tests `create_room`), bump the game's
   `version` and `image` tag, and update `BARGAMES.md`.

Everything from 0.1.0 still works unchanged.

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
   Adding the image-publishing workflow (step 10) is part of the work. Pushing to
   GitHub, which triggers it, happens only when the user asks for it.
7. **The box never builds your code from a working copy.** It gets the image from a
   registry (step 10), so everything the image needs must be committed and the
   Dockerfile must build from a clean checkout.

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

1. Copy `C:\CodeProjects\GameBroker\integration\bargames-sdk-0.8.0.tgz` to
   `<repo>\vendor\` (create the folder).
2. Add the dependency to **both** the `server` and `client` workspace `package.json`:
   ```json
   "@bargames/sdk": "file:../vendor/bargames-sdk-0.9.1.tgz"
   ```
3. Run `npm install` at the repo root and commit the lockfile change along with it.
4. **Dockerfile:** the `npm ci` layer needs the tarball. Next to the other
   `COPY …package.json` lines, before `RUN npm ci`, add:
   ```dockerfile
   COPY vendor ./vendor
   ```
5. The CLI is now available as `npx bargames` (try `npx bargames` with no arguments).

**Updating later:** a newer SDK arrives as a new file name, for example
`bargames-sdk-0.9.1.tgz`. Replace the file, update both `package.json` entries, and run
`npm install`. Never overwrite a tarball under the same name: the lockfile's integrity
hash would then fail `npm ci`.

## Step 2: The manifest, `bargames.json`, at the repo root

Start from `snippets/bargames.example.json`, then fill it in from the repo:

| Field | How to fill it |
|---|---|
| `id` | A short lowercase slug: `bingo`, `cah`, `pool`. It's also the default hostname. |
| `name`, `version` | The game's name, and the version from the root `package.json` (semver) |
| `image` | `ghcr.io/<github owner, lowercase>/<id>:<version>`, e.g. `ghcr.io/thezigpc/bingo:0.1.0`. The tag **must equal `version`**. The box pulls this exact name, and step 10's workflow publishes it. |
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

**Versions are immutable.** The box keeps a local copy of each image tag and never
re-downloads a tag it already has. Any change you want on a box therefore needs a new
`version`, with the `image` tag changed to match, in the same commit.

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
6. **"← All games" (SDK 0.4.0), landing page only.** Put the venue's games link at the
   bottom of the page a player first lands on (create/join), and nowhere else: not in a
   room, not on the host screen, never on the TV view. With React, copy
   `snippets/VenueExtras.tsx` (or use the game kit's `<BackToGames />`) and render
   `<BackToGames ctx={venue} />` at the end of the landing page. Without React:
   ```ts
   const link = gamesLink(ctx, { container: landingEl }); // adds nothing standalone
   // newer contexts from watchVenue: link.update(ctx); leaving the landing page: link.remove()
   ```
   It shows "Also playing: Bingo · Pool" under the link; pass `alsoPlaying: false` to
   leave that out. For your own markup, `gamesListUrl(ctx)` and `otherGames(ctx)` give
   you the data (undefined / empty standalone).
7. **Staff announcements (SDK 0.4.0).** Render `<VenueAnnouncement ctx={venue} />` once
   at the root of the **phone** app, or call `announcementBanner(ctx)` and feed it
   `update(ctx)` from `watchVenue`. It's a sticky strip at the top of the page with a
   close button, and comes down on its own when it expires.
   - **Where:** every phone page, including pre-join pages (landing, join screen) and
     the game's own admin pages. Never on a TV/shared screen: the box puts
     announcements on idle TVs itself.
   - **On TV pages it hides itself (SDK 0.5.0):** `tableMode(ctx)` marks the page as a
     shared screen. When only the room page knows it's a TV (a table that joined a plain
     room URL), call `markSharedScreen()` there. On 0.4.0, pass `hidden` instead:
     `<VenueAnnouncement ctx={venue} hidden={isSharedScreen} />` (`announcementBanner`:
     call `remove()`).
   - **Colors:** draw it on `--venue-primary` with `--venue-on-primary` text (0.5.0).
   - **Layering:** it sits at `z-index: 2147483646`, above the game's modals and toasts,
     on purpose (it's one line and dismissible). Don't try to layer over it. Check your
     layout still works with it: no full-height `position: fixed` page that hides it.
   - **Polling:** announcements arrive with the venue poll. On the snippet's `useVenue`,
     pass `intervalMs: 30_000` to `watchVenue` (the current snippet does; older copies
     poll every 60 s). The game kit's `useVenue` already polls every 30 s.

## Step 5: Events (level 2)

Emit from the server at the points where the game already changes state, usually in
`Room.ts` / `RoomManager.ts`, right where the state changes and the broadcast happens:

```ts
bg.emit({ type: "winner", roomCode: room.code, sessionKind: room.kind, data: { name: player.name } });
```

| Event | When | `data` (keep it small) |
|---|---|---|
| `room_created` | A room is created | `{ title? }` |
| `room_closed` | A room closes, **every way it can** (host, `end`, idle sweep, admin, shutdown). Required for castable games (SDK 0.3.0): the box takes the room off the TVs at once. | `{ reason }` |
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
  defaulting to `"patron"`. Rooms the box creates with `create_room` (step 6) are
  `"venue"`.
- **Declare** every type you emit in `bargames.json` `events`.
- **Closed means gone:** after `room_closed`, the room must no longer appear in status.
  The box also sweeps every 30 s and clears TVs whose room vanished from status, so a
  crash doesn't leave a dead room on a TV, but the event is what makes it instant.

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
  | `confirm_claim` / `reject_claim` | Accept or turn down a pending claim (SDK 0.2.1, see below) |
- **Status:** one entry per room:
  - `code`;
  - `kind`;
  - `players` (players only, not tables or viewers);
  - `phase` (the game's own phase names);
  - optional `title` and `hostConnected`;
  - `pendingClaims` if the game has claims (below);
  - for the box's **Rooms** page (SDK 0.3.0, optional but cheap): `createdAt` and
    `lastActivityAt` (ISO times), `tables` (TV/table clients connected), `maxPlayers`,
    `hostName`;
  - `joinPath` (SDK 0.4.0): where a new player joins the room, as a path on the game's
    address, e.g. `/join/KQ7P`. The venue's games list shows open venue and patron
    rooms with a **Join** button that goes there. Never list a private room's path
    (the box skips private rooms anyway).

### `create_room`: the box starts a room for the TVs (SDK 0.2.0)

When staff choose **Put a game on the TVs → New room** on the iPad, the box asks the
game for a room, then casts that room's table view. Without this, staff must first
start a room on a phone and type its code.

```ts
bg.onCreateRoom(({ kind, title }) => {
  const room = rooms.createVenueRoom({ kind, title }); // kind is "venue"
  return { roomCode: room.code, hostUrl: `/join/${room.code}?key=${room.hostKey}` };
});
```

- **The room has no host phone.** It must:
  - stay alive with nobody hosting it. Don't idle-close it while a table (TV) client is
    connected; `end` closes it;
  - accept players joining by code, exactly like a normal room;
  - be fully driven by the other commands (`start`, `pause`, `next_round`, `end`).
- **`hostUrl` (optional):** a path or URL that gives the host controls for this room,
  including any host key. The box shows it only to venue staff, as "Open the host
  controls", so the iPad can run the room. Leave it out if the game has no such link.
- **Refusing:** throw an `Error`; its message is shown to staff. Never return without a
  `roomCode`.
- **Status** must list the new room with `kind: "venue"`.
- List `create_room` in the manifest's `commands`. `npx bargames check` then creates a
  room, checks status and the table route, and closes it with `end`.

### `confirm_claim` / `reject_claim`: staff resolve a claim (SDK 0.2.1)

For games where a player's claim waits for a human (a BINGO call, a disputed score).
Venue rooms have no host phone, so staff resolve claims from the box's iPad: the Home
page's **Rooms** card shows each pending claim with **Confirm** and **Reject**.

```ts
import type { ClaimArgs } from "@bargames/sdk/server";

bg.onCommand("confirm_claim", ({ roomCode, args }) => {
  const room = roomCode ? rooms.get(roomCode) : undefined;
  if (!room) return { ok: false, message: "no such room" };
  const { claimId } = (args ?? {}) as ClaimArgs; // omitted: the oldest pending claim
  return room.confirmClaimFromBox(claimId);      // same path as the host's "confirm" button
});
// reject_claim: the same shape; args.reason is an optional reason for the player.
```

- **Status** lists the waiting claims on each room, oldest first:
  `pendingClaims: [{ id, player, detail, at }]`. `id` is any stable string your game
  recognises (`player` and `detail` are what staff read, e.g. "Sam", "Line on row 3").
  Leave it out or empty when nothing is waiting.
- **Refuse** with `{ ok: false, message }` when the claim is gone or already decided
  (a host on a phone may have got there first). Never throw.
- Emit `claim_pending` when a claim starts waiting, and `winner` when one is confirmed,
  as before.
- List **both** commands in the manifest. `npx bargames check` warns if only one is
  listed or `claim_pending` isn't declared, and checks the `pendingClaims` shape.

## Step 6b: Casting from inside the game (SDK 0.2.0, optional)

A game's own host can put their room on the venue's TVs from the game's host screen.
**This only exists on a box.** Off a box, `bg.displays()` returns `enabled: false`, and
`cast`/`stopCast` refuse without touching the network. Rule 1 still holds: nothing
appears in a standalone game.

The venue decides in the box admin (TVs → "Casting from games") whether hosts may
cast, and whether they must enter the venue's **TV PIN**. Whoever pairs and sets up the
TVs does that in the box admin, never in the game.

```ts
// server: only for the room's host (use the game's existing host check)
const targets = await bg.displays();
//   → { enabled, pinRequired, displays: [{ id, name, group, busy, showingThisGame, roomCode }] }
const r = await bg.cast(room.code, ["roku:X123"], { pin });   // → { ok, message, results }
await bg.stopCast(["roku:X123"], { pin });                    // only clears TVs showing this game
```

- **Wire it through the host's socket intents**, for example `listTvs` and
  `castToTvs { ids, pin }`. Check the requester is the room's host first. Never expose
  these calls to players.
- **UI:** show a "TVs" control in the host screen **only when `targets.enabled`**. List
  TVs by `name`, mark `busy` or `showingThisGame`, and ask for the PIN only when
  `pinRequired`. Show `message` from failed results as-is (for example "Wrong TV PIN" or
  "Too many wrong TV PINs").
- `results[id].needsCode` means the TV hasn't been paired with the box yet. Tell the
  host to ask staff; pairing happens in the box admin.
- The box only casts rooms your status lists, and only this game's table route.
- Refresh `displays()` when the host opens the control. Don't poll it.
- **Test it with the mock box** (step 9): it has fake TVs `fake-bar` and `fake-patio`,
  plus `fake-unpaired`, which answers `needsCode` like a TV the venue hasn't paired. It follows the same rules as a real box (rooms must be in status,
  wrong-PIN lockout). `--tv-pin 1234` requires a PIN; `--no-cast` acts like a venue
  that turned casting from games off. Each cast prints the table URL the TV would show.

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
- [ ] Nothing assumes a pointer. The box hides the mouse, and staff control the room
      from the iPad (commands) or the game's host screen. So there are no "click to…"
      hints, hover effects, or on-screen buttons that the room needs.

If the table route needs a key or role parameter, the `{code}` URL must still work
display-only. If it can't, write that in your report.

**`tableMode(ctx)` (SDK 0.3.0)** covers the pointer, wake and banner items for you:

```ts
import { getVenue, tableMode } from "@bargames/sdk/client";

const tm = tableMode(await getVenue());          // does nothing off a box
socket.on("disconnect", () => tm.setState("reconnecting"));
socket.on("connect", () => tm.setState("connected"));
socket.on("room:closed", () => tm.setState("closed"));   // "This room has closed"
// Layout: padding: var(--bg-safe-y, 0) var(--bg-safe-x, 0);
```

Keep the game's own reconnect handling; `tableMode` only shows the state. It also keeps
the screen awake, so drop the game's own wake-lock code while it's on (SDK 0.5.0 also
marks the page as a shared screen, which hides the announcement strip). On a box the
TV goes to the venue idle screen shortly after the room closes anyway.

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
  **Existing self-hosted deployments:** once the image runs as `node` (uid 1000), a
  `./data` bind mount that root created is no longer writable. Before their next rebuild,
  run `sudo chown -R 1000:1000 ./data` on that host, and say so in the game's
  release notes or deploy docs. (Named volumes on a box are created for the game: nothing
  to do there.)
- Test it, if Docker is available:
  ```bash
  docker build -t bargames/<id>:dev .
  docker run --rm --read-only --tmpfs /tmp --cap-drop ALL -v bgtest:/data -e PORT=<port> -p <port>:<port> bargames/<id>:dev
  ```
- Fonts and scripts loaded *by the browser* from CDNs still work. Anything the *server*
  fetches from the internet won't work on a box.
- **It must build from a clean checkout.** Both the publishing workflow (step 10) and a
  possible future build on the box run a plain `docker build .` at the repo root:
  - no build args or secrets;
  - target `linux/amd64`, because boxes are Intel PCs;
  - nothing that exists only on your machine, such as an uncommitted `vendor/` tarball, a
    local `.env`, or a prebuilt `dist/`.

  Prove it:
  ```bash
  git clone <repo> /tmp/clean && cd /tmp/clean && docker build -t bargames/<id>:clean .
  ```
  Keep `.dockerignore` excluding `node_modules`, `dist`, `.env` and runtime data, so a
  local build matches the CI build.

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
   your game. It prints the env vars to use, and then every event your game emits
   and every cast to its fake TVs. Add `--tv-pin 1234` to test the PIN prompt.
   **If the manifest's port is already in use on your PC** (a live copy of the game, a
   beta), run the test server on a spare port and point every command at it with
   `--game http://127.0.0.1:<spare port>`. Otherwise `check`, `status` and `command`
   talk to the other copy. A `venue.json` that "isn't the box's branding" or isn't JSON
   usually means exactly that.
2. Start the game server with those env vars:
   ```bash
   BG_GAME_ID=<id> BG_CORE_URL=http://127.0.0.1:7199 BG_GAME_TOKEN=dev-token PORT=<port> node server/dist/index.js
   ```
3. Run the checks and drive the game:
   ```bash
   npx bargames check            # must end with "all checks passed"
   npx bargames check --room <CODE>   # one live room: claims, times, table view
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
- **the image**:
  - the `image` name;
  - the result of the clean-checkout build;
  - whether the workflow has run, and whether the package is public (step 10);
- **SDK requests:** anything the SDK or platform should do differently.

The Bar Games side uses that file to install and test the game on a real box.

## Step 10: Publish the image

A venue installs a game by pasting its GitHub URL into the box. The box reads
`bargames.json` from the default branch and **pulls the `image` it names**. It does not
build from source, and it has no registry credentials. So the image must be published
to a **public** registry before anyone installs that version. If it isn't, the install
looks like it worked, but the game's address returns 502.

We publish to GitHub Container Registry (GHCR) with GitHub Actions. That needs no
accounts or secrets beyond the repo's own `GITHUB_TOKEN`.

1. Copy `snippets/publish-image.yml` to `.github/workflows/publish-image.yml`. It needs
   no edits. It runs whenever `bargames.json` changes on `main`, and can also be started
   from the Actions tab. It:
   - reads `image` and `version` from `bargames.json`;
   - fails if `image` isn't `ghcr.io/<owner>/<name>:<version>`;
   - skips a version that's already published (they're immutable);
   - builds `linux/amd64` from the checkout and pushes it, labeled with the repo, so the
     package links to it.
2. Make sure `image` in `bargames.json` follows step 2 (lowercase owner, tag ==
   `version`). Run `npx bargames validate .`.
3. **Stop and hand over to the user.** Pushing is their call (rule 6). Tell them:
   - push `main`; the "Publish image" workflow should go green. **On a brand-new repo**
     the first push doesn't trigger the `bargames.json` path filter, so start the first
     run by hand (Actions tab > Publish image > Run workflow, or
     `gh workflow run publish-image.yml`);
   - **first publish only:** GHCR packages start out *private*. Open
     `https://github.com/users/<owner>/packages/container/<name>/settings`, go to
     "Danger Zone", choose "Change visibility", and select **Public**. Otherwise the box
     gets "pull access denied".
4. **Verify anonymously** that the box will be able to pull it. Expect `200`:
   ```bash
   img=<owner>/<name>; tag=<version>
   tok=$(curl -s "https://ghcr.io/token?scope=repository:$img:pull" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
   curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $tok" \
     -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json" \
     "https://ghcr.io/v2/$img/manifests/$tag"
   ```
   Anything else (`401`, `403` or `404`) means the package is still private or hasn't been
   published yet. GHCR answers both the same way, so check the Actions run first.

**Releasing a new version later:**
1. Bump `version` and the `image` tag together in one commit, and push.
2. Wait for the workflow to go green.
3. On the box: the Games tab shows "Update available" within 6 hours (or press
   "Check for updates"). It only offers a version once its image can be downloaded.
   **Update** installs it and restarts the game on the new image; open rooms close, so
   do it between sessions. If the new version won't start, the box puts the previous one
   back and says why. (Re-pasting the GitHub URL does the same.)
4. **Or have the box session pull it now.** If the user wants it, message the GameBroker
   session (ListAgents; its name starts with `gamebroker`) once you've pushed: "<game id>
   <version> is pushed, please update the box". It runs `bgctl update <game id> --wait 20`
   on the box, which waits for the image build to finish, updates, and reports back.
   Only when the user asks for it: an update restarts the game and closes open rooms.

Never re-publish an existing tag. The box would keep running its cached copy.

**Build from source (not available yet):** the box may later build images itself from
the GitHub source at a pinned commit, for games without a registry. Step 8's
"clean checkout" rule already keeps a game ready for that. Until then, a published image
is the only way a game reaches a box.
