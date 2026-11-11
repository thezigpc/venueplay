# Bar Games Box: Game Plan

> Working name. The code folder is still `GameBroker`. The big picture (platform layers, SDK levels, branding) is in [VISION.md](VISION.md).

A self-contained game-night appliance for a bar, kava bar or office. It does three jobs:

1. **Hosts the games** (Bingo, Pool, No Filter, and the rest) on the box itself.
2. **Casts the big-screen `table` views** to the venue's TVs. It bridges Roku now, and Google
   TV and others later.
3. **Links to Home Assistant**, so game events can trigger the room (lights, sound) and HA
   can drive the TVs.

Setup needs only a **Cloudflare account and a domain**. The box creates its own Cloudflare
Tunnel and DNS records. Players can only connect from the venue's network or from addresses
on a whitelist.

## Architecture

```
 Phones on the venue Wi-Fi ──┐
 iPad (host / control) ──────┤  https://pool.example.com, nofilter.…, bingo.…, admin.…, ha.…
                             ▼
                     Cloudflare edge  (TLS, DNS; optional WAF IP rule)
                             │  Cloudflare Tunnel (outbound only, no open ports)
┌────────────── Bar Games Box: M720, 8th-gen i5, 16 GB, Ubuntu 26.04 + Docker ───────────┐
│  cloudflared ──► gateway  (routes by hostname, venue-IP gate, "join the Wi-Fi" page)   │
│                     │                                                                  │
│      ┌──────────────┼──────────────┬──────────────┬──────────────┐                     │
│    bingo          pool          nofilter        admin (control      ha.* ──► HA box    │
│   (game)         (game)          (game)         page + API)          (LAN)             │
│      ▲              ▲               ▲                │                                 │
│      └──── table views loaded from localhost ───┐    │                                 │
│                                                 │    ▼                                 │
│   Broker: Chromium per group → QuickSync → drivers (roku/AirPlay, roku-hls, cast …)    │
│   TV control (ECP, Cast, pyatv) · watchdog · HA bridge (MQTT) · game event listener    │
└────────────────────────────────────────────────────────────────────────────────────────┘
         │ MQTT                                   │ AirPlay / HLS / Cast over the LAN
         ▼                                        ▼
  HA box: older Lenovo, HAOS + Mosquitto     5 Roku TVs (Google TVs later)
```

- **The TVs keep working without the internet.** The box's Chromium loads the table views
  straight from the local game containers, so an internet outage doesn't black out the
  TVs. Phones still need the internet, unless split DNS is set up (see Phase 5).
- **Everything runs in containers.** Each game is a Docker image pulled from a registry,
  and the box's update channel pulls new versions.

## Deployment: all Docker

The whole Bar Games app runs in Docker. The host (standard: Ubuntu Server LTS) only needs
Docker and the Intel graphics kernel driver (`i915`, included by default).
Install means running one script that writes a compose file and runs `up -d`.

| Container | Network | Special access |
|---|---|---|
| `bargames-core`: main page, API, package manager | bridge | The Docker API, **through a socket proxy** limited to managing game containers, networks and volumes |
| `gateway` | bridge + one network per game | — |
| `cloudflared` | bridge | — |
| `broker`: Chromium, encoders, drivers, watchdog, HA bridge | **`network_mode: host`** (SSDP/mDNS discovery, AirPlay connections back from the TVs) | `/dev/dri` + the `render` group (QuickSync); `shm_size: 2g` (Chromium); a virtual display inside the container |
| games (`bg-pool`, `bg-bingo`, …) | one isolated network per game | none (sandbox rules) |

- **Self-update:** `bargames-core` pulls new tagged images and recreates the containers.
  Before every update it takes a `docker-backup` snapshot.
- **Linux hosts only.** Docker Desktop on Windows or Mac can't do host networking or
  `/dev/dri`. A box without Intel QuickSync would fall back to encoding on the CPU and
  drive fewer TVs.
- **Portable:** the same compose file runs on bare-metal Ubuntu or Debian, in a Proxmox LXC, or,
  later, wrapped as an HA add-on.

## Hosting and domains

**Setup wizard** (on the box's first boot, opened from the LAN):

1. The owner pastes a **Cloudflare API token**. Its permissions are limited to one domain:
   Tunnel edit, DNS edit and, optionally, WAF/Lists edit.
2. The owner picks the domain and the hostnames.
3. The box creates the tunnel, its routing config and the DNS CNAME records, and starts
   `cloudflared`.

The fallback is to paste a ready-made tunnel token and set up the hostnames by hand in
the Cloudflare dashboard.

**The hostname pattern can be picked on the main Bar Games page.** The box rewrites the
tunnel routes and DNS records whenever the pattern changes.

| Pattern | Example | HTTPS on Cloudflare |
|---|---|---|
| `{game}.{domain}` | `pool.example.com` | The free certificate covers it |
| `{game}-{venue}.{domain}` | `pool-kavabar.example.com` | The free certificate covers it |
| `{game}.{sub}.{domain}` | `pool.internal.example.com` | Needs Advanced Certificate Manager (about $10 a month) or a dedicated subdomain zone. The setup page warns and checks the certificate before switching |

| Hostname | What it is | Who can get in |
|---|---|---|
| `bingo.` `pool.` `nofilter.` … | Games (players' phones, the host's iPad) | **The venue's network plus the whitelist** |
| `admin.` (or `tv.`) | Bar Games control page: TVs, groups, games | The venue's network **plus PIN**; optionally Cloudflare Access (one-time email code) for remote use |
| `ha.` | Home Assistant on the HA box, proxied over the LAN | HA's own login through the tunnel (a pattern already proven). Needs `http: use_x_forwarded_for` and `trusted_proxies` set to the box's address. Leave Cloudflare Access off this hostname: its login page breaks the HA phone app |
| *(none)* | Your support access | Tailscale. Never public |

## Venue-only access ("same public IP")

**Main check: the gateway on the box.**

- Requests coming through the tunnel carry `CF-Connecting-IP`, the visitor's real
  address. The gateway compares it with:
  - the box's **own current public IPv4 address**, which it finds itself and rechecks every
    few minutes, since venue internet addresses change;
  - the **venue's IPv6 prefix**: phones on IPv6 each have their own address, so the gateway
    must allow the venue's whole /64 or /56;
  - the **whitelist**: individual IPs or ranges, edited on the admin page, each with an
    optional expiry.
- Visitors who don't match get a friendly page: "Join the [venue] Wi-Fi to play", with the
  network name and a QR code.
- The gateway only accepts requests that come through the tunnel. The game containers
  aren't exposed on the network, so the IP header can't be faked by connecting to them
  directly.

**More checks, set on the main Bar Games page:**
- **Venue PIN:** an optional code players enter once per session (it's stored in a cookie). It can be shown on the TV idle screen, and it changes each night.
- **Game on/off:** each game can be switched on or off, or scheduled ("Bingo: Thu 7–10 pm"). When a game is off:
  - its hostname shows a "No game in session" page;
  - its container is stopped, which saves resources;
  - it isn't exposed at all.

  HA can switch games on or off as well.

**Optional hard block: Cloudflare WAF.** One custom rule plus one IP list, both included in
the free plan, block visitors before they reach the tunnel. The box keeps the list up to
date through the API when its public IP changes. The block page is Cloudflare's, so the
gateway's friendly page stays the default.

**Limits to tell the owner about:**
- A phone on mobile data is blocked, which is intended. The block page tells the player to join the Wi-Fi.
- Some internet types share one public IP with neighbours: CGNAT, Starlink, 5G home
  internet. With those, "same public IP" is a weaker fence. Add a venue PIN or room
  code as a second check where it matters.

## Game packages and the market

Games are installed and updated as **packages**. A package can come from:
- **the Market:** a site you host yourself, with a signed catalog;
- **a URL:** a GitHub repo or release page.

**A package** is a manifest plus a container image:

```jsonc
// bargames.json (at the repo root, or listed in the market catalog)
{
  "id": "pool", "name": "Pool", "version": "1.4.0",
  "image": "ghcr.io/<owner>/pool:1.4.0@sha256:…",   // pinned by digest
  "port": 3000,
  "routes": { "player": "/", "table": "/room/{code}?role=table", "host": "/?host=1" },
  "health": "/healthz",
  "events": ["round_started", "winner", "game_over"],  // passed on to HA
  "resources": { "memory": "512m", "cpus": 1 },
  "minBoxVersion": "0.3.0"
}
```

| Source | Trust | Updates |
|---|---|---|
| **Market** (your self-hosted site) | The catalog is **signed with your key**, and the box checks the signature | The box checks the catalog every night. Updates can install automatically or wait for one click, per game |
| **URL** (GitHub) | Shown as **"Unverified source"**, with the manifest's permissions displayed before install | The box follows the repo's releases or tags |

**Rules for running games (every package, both sources):**
- Each game runs in its own Docker network. Only the gateway can reach it.
- Games get **no access to the LAN**: no TVs, no HA box, no router. Internet access is allowed only if the manifest asks for it.
- Games run non-privileged, with no host networking, a read-only root filesystem, a data volume for that game only, and the CPU and memory limits from the manifest.
- Each game gets one internal endpoint for sending events, with its own token. That's the only way a game reaches the broker or HA.
- Before an update, the box takes a snapshot of the game's data volume. If the health check fails after the update, the box rolls back automatically.

**Game SDK (small, shared):** a manifest schema, a helper for sending events, the route
conventions (player / table / host), and the venue headers the gateway adds (session,
PIN verified). The existing games (Bingo, Pool, No Filter) become the first packages.

**Content:** No Filter ships with royalty-free sample cards. Anyone who loads other decks
is responsible for honouring their copyright. Say so in the game's install screen and in
the Market listing.

## Casting: driver model

**Site today:** 5 Roku TVs. Google TVs and others may come later. Every kind of TV sits
behind a **driver**:

- **Native:** the TV runs the table page itself. This gives exact sync and no
  encoding on the box.
- **Streamed:** the box renders the page and sends video.

```ts
interface DisplayDriver {
  discover(): AsyncIterable<FoundDevice>;     // SSDP / mDNS / Cast discovery
  pair(device): Promise<Credentials>;          // AirPlay PIN, ADB key, ...
  capabilities(device): Capabilities;          // native web? AirPlay? HLS? power / input control?
  power(device, on: boolean): Promise<void>;
  setInput(device, input: string): Promise<void>;
  show(device, content: Content): Promise<Session>;  // native URL or stream
  stop(device): Promise<void>;
  health(device): Promise<Health>;
}
```

| Driver / delivery method | TV | Delivery | Delay | Status |
|---|---|---|---|---|
| `roku` + `airplay-direct` | Roku TVs with AirPlay | Streamed: doubletake mirroring | ~0.1–0.3 s | **Now** |
| `roku` + `roku-hls` | Roku TVs without AirPlay | Streamed: sideloaded Roku player app | ~3–10 s | **Now** (fallback) |
| `cast-receiver` | Google TV, Chromecast, Android TVs with Cast built in | **Native:** our own Cast web receiver app runs the table page | Real time | Later |
| `androidtv-adb` | Google TV / Android TV | Native: ADB launches a kiosk browser | Real time | Later (fallback) |
| `appletv` | Apple TV | Streamed: AirPlay; controlled with pyatv | ~0.1–0.3 s | Optional |

**Load:** five AirPlay TVs means five QuickSync encodes, which fits in the UHD 630's budget of
about 6–8. Native drivers cost nothing to encode.

**A Cast receiver page and the local network:** a Cast receiver page has to be
HTTPS from a public hostname, so it loads through the tunnel. It's exempt from the IP
gate only if Cloudflare reports the visitor as the venue's own IP, which it will be,
because the TVs are on the venue's network.

## Home Assistant link

The box announces itself to HA over MQTT (HA's MQTT discovery), so HA creates the
entities automatically:

| HA entity | Examples |
|---|---|
| `select` per group | Content: Bingo / Pool / No Filter / Idle screen / Off |
| `switch` per TV | Power; casting on/off |
| `button` | Scenes: "Game Night", "All TVs off", "Show idle screen"; restart streams |
| `sensor` | Active game, room code, player count, stream health, CPU and encoder load, public IP, tunnel status |
| `event` | `round_started`, `bingo_claimed`, `winner`, `game_over` |

Because the games now run on the box, game events can come straight from the game
servers through a small shared event hook. That replaces the hidden `table` client idea
from the earlier plan.

## Phases

### Phase 0: Prove the risky parts (test bench)

**Dev bench** (at the user's own location): a Roku Express 3930RW (HD, has AirPlay) plus a Samsung smart TV.

| Test | Roku player | Samsung TV | Still needs a real Roku TV |
|---|---|---|---|
| Find devices on the network (SSDP/mDNS) | ✅ | ✅ | |
| ECP: launch, keys, sideloaded HLS player app | ✅ | — | |
| AirPlay mirroring (doubletake) | ✅ (Express 3930RW has AirPlay) | ✅ (Samsung 2018 and later has AirPlay 2) | |
| Two receivers at once and how far apart they are | ✅ (Roku + Samsung) | ✅ | |
| ECP TV power-on and switching HDMI inputs | — | — | ✅ on site |

- [ ] doubletake → one Roku TV over AirPlay, an hour of stability; then 2 TVs at once and measure how far apart they are
- [ ] Sideload a minimal Roku HLS player app; measure delay
- [ ] Roku ECP: power, HDMI input, launch an app ("Control by mobile apps" set to Permissive)
- [ ] Cloudflare: a tunnel plus a gateway that checks `CF-Connecting-IP`; test from venue Wi-Fi (IPv4 **and** IPv6) and from mobile data
- [ ] Site facts: model numbers of the 5 TVs, AirPlay support on each, network layout, ISP (CGNAT?), IPv6

### Phase 1: Hardware and base systems
- [ ] BIOS on both boxes (power on after AC loss, Wake on LAN, UEFI, firmware)
- [ ] HA box: HAOS plus the Mosquitto, Tailscale and backup add-ons
- [ ] Bar Games box: Ubuntu Server 26.04 LTS, Docker, QuickSync (`vainfo`), Tailscale, `docker-backup` → NAS

### Phase 2: Packages, gateway and tunnel
- [ ] Manifest schema (`bargames.json`) and the Game SDK (event helper, route conventions, venue headers)
- [ ] Turn Bingo, Pool and No Filter into packages: images on GHCR, settings only through environment variables, a health endpoint, events
- [ ] Package manager on the box: install from the Market or a URL, sandbox rules, updates, snapshot before update, automatic rollback
- [ ] Gateway: route by hostname, venue-IP and IPv6-prefix gate, whitelist, venue PIN, game on/off and schedules, "join the Wi-Fi" and "no game in session" pages
- [ ] `cloudflared` plus the setup wizard (create the tunnel and DNS through the API; a hostname pattern picker with a certificate check)

### Phase 2b: Market site (self-hosted)
- [ ] A signed catalog (`catalog.json` plus a signature), a listing page for each game, and a version history
- [ ] A publishing tool: build the image → push to GHCR → update and sign the catalog

### Phase 3: Broker core
- [ ] `DisplayDriver` interface, TV registry, groups
- [ ] `roku` driver: ECP control plus AirPlay and HLS delivery
- [ ] Renderer (Chromium per group, GPU-rendered), encoders, watchdog, idle screen

**Status 2026-11-10 (AirPlay casting working on the bench):**
- Xvfb → Chromium kiosk → doubletake v0.5.0 → QuickSync (`vah264enc`), 1080p30 at about 4 Mbps, mirrored to the Roku Express (3930RW).
- One channel per page: TVs showing the same room share one encode.
- Pairing from the TVs tab. The mouse is hidden.
- Casts resume after a broker restart, and a watchdog restarts crashed processes and reconnects dropped TVs.
- SDK 0.2.0 adds `create_room` ("New room" when casting) and casting from inside a game (venue switch plus TV PIN).
- Still to do: the idle screen, `roku-hls`, and measuring two TVs at once.

**Later (evolving):** deeper integration with the games.
- Shared admin passwords/sign-in, and each game's admin pages opened from the box admin.
- More common code moved from the games into the platform.

### Phase 4: Control page (`admin.`)
- [ ] PIN login; TV grid; game picker; send to all / group / single TV; panic button
- [ ] Game host view built in (the iPad is the remote and the game host)
- [ ] Settings: domain and hostnames, whitelist, Cloudflare status, pairing, updates

### Phase 5: Home Assistant link and hardening
- [ ] MQTT discovery, game events, starter automations
- [ ] Optional WAF list sync; optional split DNS (the router points game hostnames at the box, with a Let's Encrypt certificate obtained through the Cloudflare token) so phones work during internet outages
- [ ] Health alerts (box → HA → you), tagged releases, a snapshot before every update

### Phase 6: On-site install and handoff
- [ ] Wire both boxes; reserve their IPs; set up the 5 TVs (Permissive control, Fast TV Start, AirPlay on)
- [ ] Pair and test each TV; label TVs and groups; a one-page staff guide; remote support through Tailscale

### Later: other TV types
- [ ] `cast-receiver` driver (register the receiver app, $5 one-time) → Google TVs
- [ ] `androidtv-adb` fallback; `appletv` if needed

## Main risks

| Risk | What we do about it |
|---|---|
| AirPlay is reverse-engineered and could break after a TV firmware update | `roku-hls` fallback; pin known-good doubletake versions |
| Venue Wi-Fi can't carry 5 streams of 8–15 Mbps plus every player's phone | Wire the TVs where possible; a separate SSID or VLAN for the TVs; lower bitrates |
| IPv6 or CGNAT weakens the venue-IP gate | Allow the IPv6 prefix; offer a venue PIN or room code as a second check |
| Two-level hostnames break HTTPS | Use one-level hostnames by default; warn in the setup wizard |
| The Cloudflare API token leaks | Scope it to one domain and the minimum permissions; stored encrypted on the box, never in backups that leave the site |
| Card content copyright | No Filter ships only royalty-free sample cards. Anyone who deploys it is responsible for any other decks they load (stated at install and in the Market listing) |
| A third-party game from a URL is malicious or buggy | Sandbox (no LAN access, resource limits, non-privileged), an "Unverified source" warning, automatic rollback |
| The Market's signing key leaks | Keep the key offline or in a hardware key; the box supports rotating keys |

## Open questions

1. The 5 Roku TVs: model numbers and AirPlay support on each? Is the Apple TV still in use?
2. Venue network: Wi-Fi or wired TVs, guest network or VLANs, ISP and CGNAT, IPv6?
3. Final name (for the box and for the Market).
4. Where will the Market be hosted (dockerhost1 behind a tunnel?), and will the game images live on GHCR or in your own registry?
