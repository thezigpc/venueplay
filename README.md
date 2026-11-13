# Bar Games platform

A self-hosted game-night box for venues. It runs these services:
- it **hosts** web games in sandboxed containers;
- it **gates** them to the venue's network with Cloudflare Tunnel, venue-IP checks and a PIN;
- it **casts** big-screen views to the venue's TVs (Roku first);
- it **connects** game events to Home Assistant;
- an iPad page controls all of it.

The plan is in [GAMEPLAN.md](GAMEPLAN.md), the big picture is in [VISION.md](VISION.md),
and the game integration guide is in [docs/SDK.md](docs/SDK.md).

## Layout

| Path | What |
|---|---|
| `packages/sdk` | `@bargames/sdk`: the game SDK (manifest, venue context, events, commands, `bargames` CLI) |
| `packages/common` | Shared Node helpers and the core → gateway config contract |
| `apps/core` | API, admin auth, game registry, Docker runtime (sandbox), event bus |
| `apps/gateway` | Routes each hostname; venue-IP/IPv6/whitelist gate; PIN; landing page; theme injection; WebSockets |
| `apps/broker` | TV drivers (`DisplayDriver`): Roku (SSDP + ECP), AirPlay receivers (mDNS), Vizio SmartCast (mDNS; AirPlay for content, PIN-paired SmartCast API for power, input and remote), Apple TV (AirPlay for content; remote, apps, typing and sleep/wake over the Companion protocol through pyatv in `apps/broker/atv/`, PIN-paired), screens plugged into the box, Venuebox apps, mock. Casting renders each page in Chromium and streams it over AirPlay |
| `apps/admin` | iPad admin UI (React + Vite), served by core |
| `examples/hello-game` | Reference game at SDK level 3 |
| `deploy/` | Dockerfile, compose (core, gateway, broker, docker-socket-proxy); core runs cloudflared itself |
| `integration/` | **Hand-off for game repos:** the guide, the packaged SDK (`npm run sdk:pack`) and snippets |

Ports: core 7100 · gateway 7080 · broker 7200 (host network) · hello-game 7300.

## Develop

```bash
npm install
npm run build
npm test                   # node:test across all packages
npm run dev                # core, gateway, broker (no TVs), admin (Vite :5173), hello-game
npm run seed:dev           # admin password "devpassword" + hello-game installed and on
```

Then open:
- http://localhost:5173 for the admin UI;
- http://play.localhost:7080 for the landing page;
- http://hello.localhost:7080 for the game.

`*.localhost` resolves to 127.0.0.1 in browsers. To add virtual TVs, run the broker
with `MOCK_DISPLAYS=3 DRIVERS=roku,mock`.

Field tool: `npm run discover -w @bargames/broker [ip]` lists Rokus and what they report.

## Deploy (bg-box)

```bash
# on the box, in ~/bargames
cd deploy && cp .env.example .env    # fill in secrets
mkdir -p data/core data/broker
docker compose up -d --build
```

Then open **http://&lt;box IP&gt;/** from any device on the LAN. On the first visit it
asks you to choose the admin password; after that it's the admin login.

- Any hostname the box doesn't serve, asked from the LAN (the IP, `bg-box`, …), opens
  the admin console.
- Until a password is set, the landing page sends LAN visitors to setup.
- Setup is refused through the Cloudflare tunnel, so nobody outside the venue can claim
  a fresh box.

Host helpers: run `sudo deploy/host/install.sh` once. The admin's Reboot and Update
buttons and the **Box Wi-Fi** page need it; later updates started from the admin reinstall
it by themselves. The helpers are systemd path units that watch request files in
`data/core`. Nothing else is installed on the host.

**Box Wi-Fi** (Settings > Box Wi-Fi):
- Saved networks go to `/etc/netplan/90-bargames-wifi.yaml` (owner-only), for the first
  Wi-Fi adapter only. The box joins whichever saved network is in range, including at boot.
- The cable is always preferred: Wi-Fi routes have metric 600 against the cable's 100.
  Taking the box to a venue with no cable works by itself.
- Only the Wi-Fi side is restarted on a change. If the cable's route goes away anyway, the
  old file is put back.
- Supported: WPA2/WPA3 passwords, open and hidden networks. Not supported: enterprise
  (username) networks and captive portals.

Core runs games through `tecnativa/docker-socket-proxy`, never through the raw
Docker socket. Each game gets:
- its own `internal` network, with only core and the gateway attached, so it has no internet or LAN access;
- a read-only root filesystem;
- no capabilities;
- memory and CPU limits.

## Status (2026-11-10)

**Done and tested:**
- the SDK
- core API and admin auth
- the gateway (IP gate, PIN, hub, injection)
- broker discovery and control, with the Roku driver and mock TVs
- the admin UI
- the Docker runtime and sandbox, verified on bg-box
- the Cloudflare setup wizard (Internet tab: tunnel, routes, DNS, connector), described in [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md)
- the game integration hand-off in `integration/`, with the SDK's mock box and conformance check

**Not built yet:**
- the casting pipeline (Chromium → QuickSync → AirPlay/HLS)
- the Home Assistant/MQTT sink
- signed Market catalogs
- the placard generator
- schedules
- player profiles and the Clover connector
