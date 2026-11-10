# Bar Games: Platform Vision

This is the big-picture companion to [GAMEPLAN.md](GAMEPLAN.md). The game plan covers how
to build the first box. This document covers what the box becomes: a **venue game
platform**. Games plug into it, venues brand it as their own, and you run the ecosystem.

## The layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 6. Fleet (later, optional)  Your view across venues: health, updates     │
├─────────────────────────────────────────────────────────────────────────┤
│ 5. Ecosystem                Market, Game SDK, third-party games          │
├─────────────────────────────────────────────────────────────────────────┤
│ 4. Venue                    Branding, renames, schedule, PIN, staff,     │
│                             idle screen / signage, stats                 │
├─────────────────────────────────────────────────────────────────────────┤
│ 3. Displays                 Casting drivers (Roku now, Cast/others later)│
├─────────────────────────────────────────────────────────────────────────┤
│ 2. Game runtime contract    What a game must or may do: SDK + manifest   │
├─────────────────────────────────────────────────────────────────────────┤
│ 1. Platform                 Box OS, Docker, core, gateway, tunnel, HA    │
└─────────────────────────────────────────────────────────────────────────┘
```

The rule that keeps this manageable: **venue-wide concerns live in the platform, never in
each game.** Branding, access, scheduling, notifications and Home Assistant are all done
once, in the platform, and every game picks them up through the SDK.

## Game integration levels

Existing and third-party games don't all have to be updated at once. Each level adds
features, and the manifest declares which level a game supports (`"sdk": { "version":
"1.x", "level": 2 }`).

| Level | The game does | The platform provides | Example |
|---|---|---|---|
| **0: Hosted** | Nothing. It's any web app container with a table URL in its manifest | Hosting, venue gate, PIN, on/off, casting | A third-party game added by URL |
| **1: Branded** | Reads the venue theme (CSS variables, logo, display name) | The venue's look, plus the venue's name for the game | A game that respects `--bg-accent` and uses `venue.gameName` |
| **2: Connected** | Reports its lifecycle and events (`room_created`, `round_started`, `winner`, player count) | HA triggers, TV idle and auto-switching, stats, notifications | Lights flash on a bingo winner |
| **3: Controllable** | Accepts commands (start, pause, next round, end) and reports its state | Control from the Bar Games iPad page, HA actions, schedules that start games automatically | "Start Bingo at 7 pm" runs with no one at the iPad |

**A level-1 bonus that needs no game changes:** the gateway can add a venue theme
stylesheet and a small branding script to HTML responses. A level-0 game then gets the
venue's colors and logo for free, though it may not look perfect.

**Retrofit order:** Bingo goes to level 3 first, since it has the clearest host flow and
proves the whole contract. Then Pool and No Filter. The SDK only stabilises once two
games use it.

## The Game SDK (`@bargames/sdk`)

| Part | Contents |
|---|---|
| `manifest` | JSON schema and validator for `bargames.json`: routes, level, brandable slots, events, commands, resources |
| `server` | `venue()` (the venue context, from environment variables or the core API), `emit(event, data)`, `onCommand(name, handler)`, `health()`, session helpers |
| `client` | `useVenue()` / `getVenue()`, a theme provider (CSS variables), `<VenueLogo>`, `<JoinQR>`, table-mode helpers (safe areas for TVs, 10-ft text sizes), a PIN-aware fetch |
| `protocol` | Shared TypeScript types for events, commands and venue context. Versioned with semver; the box supports the current and previous major versions |
| `devkit` | `bargames dev`: runs a game locally with a fake venue, fake gateway headers and an event inspector. `bargames pack`: validates the manifest and builds and tags the image |

The games already share a `shared/` package pattern, so the SDK is the same idea pulled
out into a published package.

## Branding

**Venue profile** (set once, used everywhere):
- Name, logo (light and dark versions), colors (primary, accent, background), font (from a short list of web-safe and Google fonts)
- The Wi-Fi network name plus a QR code, social handles, the venue PIN policy
- Idle screen content: specials, upcoming game nights, sponsor slides
- Optional: brand sounds (win sting, round start)

**Per-game overrides** (on top of the venue profile):
- **Display name** ("Bingo" → "Kava Bingo Night"), icon, tagline
- Accent colour and logo placement
- **Hostname alias** (`bingo.` → `kavabingo.`), with the tunnel and DNS updated automatically
- Content packs, if the game declares them: bingo patterns, No Filter decks, trivia categories

**How it reaches games:**
- Level 1 and up: through the SDK.
- Level 0: through gateway injection.
- The TV idle screen and the iPad page use the same profile.

**Guardrails:**
- The theme tokens are checked for contrast, so a venue can't make text unreadable on a TV across the room.
- Games declare which slots are brandable, and anything else stays fixed. This protects a game's layout and its developer's attribution.

## Session types: the bar version and patron rooms

The games keep their normal room model. Any group can start its own room and play on
phones with their own shared screen. The **bar version** is one *type* of session that
the platform handles differently, not a separate build of the game.

| Session type | Started by | Shared screen | Branding | Typical use |
|---|---|---|---|---|
| **Venue event** | Host / iPad / schedule / HA | The venue's TVs (cast) | Full venue branding, announced on the idle screen | Thursday Bingo night |
| **Patron room** | Anyone on the venue network, from the venue hub page | A phone or tablet on their table, or a **claimed TV** | Venue branding, plus the group's own name | Four friends start Pool at their table |
| **Private room** | Staff, for a booking | One or more assigned TVs | Venue plus an event name ("Sarah's 30th") | Parties and corporate nights |

**Platform policy (set on the main page):**
- Which games allow patron rooms
- A limit on how many rooms can run at once
- Room time limits and idle timeouts
- **TV claiming:** a patron room can ask for an idle TV. Staff approve it, or idle TVs are approved automatically. A venue event always takes priority and takes the TVs back
- **Content rules per session type and time of day**, for example No Filter only in patron or private rooms, and never before 9 pm

**Venue hub page** (`play.`): one landing page for players. It shows "Join tonight's Bingo"
(the live venue event), "Start your own game" (patron rooms), and the venue branding. The
per-game hostnames still work for direct links and QR codes.

**For the SDK:** the session type is part of the venue context (`session.kind = "venue" |
"patron" | "private"`). A game can adjust to it: for example, host-only controls in venue
events, and the first player becomes host in patron rooms.

**Casting budget:**
- **Encoding:** every claimed TV takes one stream from the shared encoder pool, which holds about 5–8 streams on the M720.
- **Rendering:** each *different* game shown on the TVs needs its own Chromium window. Rendering, not encoding, is the real limit. Estimate: **2–3 at full 30 fps**, and more if light games like Bingo and No Filter render at 10–15 fps or at 720p. The broker gives each game a frame-rate profile.
- **Same game on several TVs:** shares one Chromium window. Phone-only private rooms use **nothing** on the broker.
- **Native-Cast TVs**, added later, use nothing either.
- The broker shows the remaining capacity, and refuses a TV claim (or lowers the quality) before the box gets overloaded. Measured in Phase 5.

## Placards: scan to play

Placards around the venue (table tents, stickers, coasters, a door poster) carry the
**same QR code for the whole venue**, pointing to the games landing page
(`play.example.com`). Nothing is tied to a table. The landing page is where a patron
sees what's on and **creates a room**.

**Playing with the person next to you:**
1. Scan the placard → the landing page opens → pick a game → **Create room**.
2. The creator's phone shows the **room's QR code** and a short room code. The person
   next to them scans the creator's phone (or types the code) and joins.
3. A live venue event, such as tonight's Bingo, is pinned at the top of the landing page,
   so scanning a placard during an event is a one-tap join.
4. Optional: "Show on a TV" claims an idle TV, using the usual approval rules.

**Wi-Fi:** the venue check needs the phone to be on the venue's Wi-Fi. The placard
therefore has **two QR codes: ① Join Wi-Fi (the standard `WIFI:` QR code) → ② Play**.
Someone who scans Play on mobile data gets the friendly "Join the Wi-Fi" page, and they
can then scan ① on the same placard. Optional, for venues that want it: the TV idle screen
can also show the Play QR code.

**Placard generator (admin page):** printable PDFs in the venue's branding (table tent,
sticker, coaster, poster). Each has the Wi-Fi QR code, the Play QR code, the short URL,
and the venue PIN line if PIN is on. One design, printed as many times as needed.
If the hostname pattern changes, the box warns that the placards need reprinting, or keeps
the old hostname working as a redirect.

## Player profiles

Profiles come in three increasingly linked tiers, and each venue picks the highest tier it
allows:

| Tier | How it works | Gives |
|---|---|---|
| **Guest** | A nickname and avatar stored in a cookie | Names on screens, per-night stats |
| **Venue profile** | Signed in with an email link or a phone code; stored **on the box** | Persistent stats, badges, leaderboards, "champion of the month", favorite games |
| **POS-linked** | The venue profile is linked to the venue's POS customer record (Clover first) | Rewards: prizes and discounts that appear at checkout, recognition of regulars |

**Clover integration** (a connector, using the same driver pattern as TVs, so Square and
Toast can be added later):
- **Linking:** match on phone number. The player confirms with a code, and only then is the
  profile tied to the Clover customer record.
- **Rewards out:** a winner gets a **discount or reward on their next or open order**
  through the Clover REST API. Staff see it at checkout. A Clover webhook confirms when it's
  redeemed.
- **Signals in (optional):** "a regular checked in" (a visit) → a welcome on the idle screen
  or a free bonus card.
- **Setup:** one venue can use a merchant API token. Selling to many Clover venues needs an
  app in the Clover App Market (an approval process).

**Rules for profiles:**
- **The data stays at the venue.** Profiles live on the box and are included in its backups.
  Cross-venue profiles would require the fleet layer, so not now.
- **Collect as little as possible:** a nickname, plus an email or phone number only for
  sign-in and linking. Profiles can be exported and deleted. A plain-language privacy page on
  the hub.
- **Every game is free to enter** (venue policy). Rewards come from playing or winning.
  POS signals can add perks, such as a welcome or a bonus, but are never a condition for
  joining a game.
- **Text messages** (phone codes, reminders) bring messaging-consent rules and costs. Default
  to email sign-in links, and keep marketing messages opt-in only.

## Other ideas that belong in the platform

| Idea | Why it matters to a bar | Layer |
|---|---|---|
| **Idle screen and signage** | The TVs are never dead: between games they show the venue's brand, tonight's schedule, the join QR and specials. HA can switch scenes | Venue + Displays |
| **Schedules** | "Bingo every Thursday 7–10": the games and TVs turn on, the room opens, the staff just host | Venue + level 3 |
| **Staff roles** | Owner (everything), Host (iPad: run games), Staff (panic button and TV power only) | Venue |
| **Light player identity** | An optional nickname per venue, stored in a cookie. Venue leaderboards, "champion of the month". **No accounts, no personal data** | Venue + SDK |
| **Venue stats** | Games played, players per night, busiest times. This proves the value to the owner; shown on the main page and as HA sensors | Venue |
| **Notifications** | One events bus feeds HA, an optional webhook, and push notifications to staff (for example, "a bingo claim is waiting"). Games just emit events | Platform |
| **Offline-first** | The TVs and the iPad keep working during an internet outage; split DNS for phones | Platform |
| **Fleet** (if this becomes a product) | One page showing every box's health, versions, and remote updates. The box stays fully standalone; the fleet link is opt-in | Fleet |

## Decisions to make before Phase 2

1. **Repo structure.** Recommended: one platform **monorepo** for core, gateway, broker, SDK, Market and devkit. Games stay in **their own repos** and depend on the published SDK, which is the same position a third-party developer is in.
2. **Is this a product?** The answer decides the fleet layer, licensing and keys, Market payments, and how much to polish the setup wizard. Build so it can become one, but don't build the fleet layer yet.
3. **Venue profile format**, which is frozen early because every game will read it. Draft it as part of the SDK `protocol` package.
4. **The final name**, for the box, the Market and the SDK package scope.
