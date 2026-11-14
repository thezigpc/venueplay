# Bar Games platform: project notes

Plan: GAMEPLAN.md · Vision: VISION.md · SDK guide: docs/SDK.md · Overview: README.md

Repo: https://github.com/thezigpc/venueplay (public, branch `main`). Commits use the user's GitHub no-reply email (repo-local git config). The product and code are still called "Bar Games" (`@bargames/*`); only the repo is named venueplay.

## Conventions
- npm workspaces, TypeScript (NodeNext), Express 4, React 18 + Vite 5, Node 22 images. These match the user's other games (Bingo, CAH, Pool).
- Tests use `node:test` through tsx (`npm test`). Every package has `src/*.test.ts`.
- Use `npm run build` before running anything compiled. `tsc -b` builds the referenced projects in order.
- The game SDK (`packages/sdk`) must stay dependency-free and browser-safe, except the Node-only `server.ts`, `cli.ts`, `devbox.ts`, `integration.ts` and `audio.ts`.
- Integrations (kind "integration", box 0.14.0) are connector modules (Matter, Home Assistant) in their own repos. They get no routes, DNS or casting. `GameRegistry.list()` leaves them out (use `all()` / `integrations()`); they talk only to `/internal/integration/*` with the permissions the venue approved. Guide: docs/INTEGRATIONS.md.
- Sound (box 0.15.0, SDK 0.13.0) belongs to the box, not the apps:
  - **The broker plays it**, in `apps/broker/src/audio/`: the box's jack/HDMI via aplay, Bluetooth speakers via BlueZ + BlueALSA (bluetoothctl, no D-Bus library), and AirPlay TVs via pyatv (`atv-stream.py`).
  - **Apps with `audio.play`** call `/internal/audio/*` on core. Core hands the broker a one-time source URL on its loopback port and fetches the file from the app.
  - **Admin:** Settings → Connected devices, through `/api/broker/audio/*`.
  - **Container:** Docker hides `/proc/asound`, so outputs come from `aplay -l`, and screen detection from `/sys/class/drm`.
  - Guide: docs/AUDIO.md.
- The broker's API listens only where core reaches it: compose sets `HOST: 127.0.0.1,docker0` (a comma list of IPs and interface names; anything unresolved falls back to 0.0.0.0). Port 7210 (Venuebox apps) stays on the LAN.
- Ignored TVs (box 0.15.2, `DisplayRecord.ignored`) are left out of the broker's `GET /displays` unless `?all=1`, never health-checked, and refused by `show`. Anything that lists TVs gets that for free; only the admin's TVs page and core's startup runner ask for `all=1`.
- Real 4K (box 0.16.1): doubletake's H.264 always uses the receiver's *nominal* canvas (1080p on an Apple TV 4K), so 2160p is only real with HEVC: `-video-codec hevc -hwaccel nvenc`, used when the broker sees `/dev/nvidiactl`. A box with an Nvidia GPU needs the 580-server driver (Pascal's last branch), nvidia-container-toolkit, and `BROKER_RUNTIME=nvidia` in deploy/.env. Intel stays renderD128 for VA-API.
- Settings backup (box 0.16.0, docs/BACKUP.md): one file with core's and the broker's `*.json` and every game's `/data` (Docker archive API), optional passphrase (AES-256-GCM/scrypt). Restore restarts core and broker; game data goes back after the restart from `data/core/restore-pending.json.gz`. `bgctl backup [folder]` saves it from the host (USB drive).
- `bgctl self-update` waits for core, gateway and broker to be healthy (each has a compose health check) and rolls back otherwise. Its snapshot leaves out `data/bluetooth` (root-only).
- Game repos consume the SDK as a vendored tarball from `integration/` (built with `npm run sdk:pack`). **Bump the SDK version for every re-pack.** A changed tarball with the same name breaks `npm ci` in the games (lockfile integrity). Keep `integration/README.md` in step with SDK changes.
- Off a box, the SDK must change nothing in a game (no theme, no events, gateway headers ignored). Games rely on this.
- Cloudflare: the box only touches DNS records that are CNAMEs to its own tunnel. Core runs `cloudflared` (`bargames-tunnel`) through the socket proxy.
- Venue-wide concerns (branding, access, events, Home Assistant) belong in the platform, never in individual games.

## Gotchas
- Node `fetch` drops a custom `Host` header. Use `node:http` `request` in tests that need host routing.
- The compose file checks `${VAR:?}` even for profile-disabled services, so use `${VAR:-}` for optional ones.
- The gateway trusts `CF-Connecting-IP` only because games aren't reachable except through it. Never publish game ports.
- Core needs `ATTACH_CONTAINERS` (core and gateway container names) so they can join each game's internal network.
- Python edits on this Windows box: use `encoding="utf8", newline=""`. Otherwise text mode writes CRLF and cp1252, and multi-line matches on CRLF files fail silently.

## The dev box
- **Releasing the box:** bump `VERSION`, push to main; the "Box images" workflow builds `ghcr.io/thezigpc/bargames` + `bargames-broker` and tags `v<VERSION>` (the packages are public). Then on the box: `bgctl self-update` (snapshot, pull, health check, rollback on failure), or the System page's Update button. Don't copy source onto a box that pins `BARGAMES_VERSION`: a local build would be tagged as that release.
- Its address, login and bench devices are in `CLAUDE.local.md` (git-ignored, this machine only). Never put them in committed files: this repo is public.
- **Install only what's needed on the box host.** Everything else goes in containers.
- Don't send power, input or launch commands to the user's devices without asking. Read-only discovery is fine.
- **Game updates from the command line (`bgctl`, on the box):** `~/bargames/deploy/bgctl update <game> --wait 20`; also `status`, `check [game]`, `update --all`, `install <GitHub repo URL> --enable --wait 20`, `startup`, `--json`. It runs inside the core container with core's ops token (`data/core/ops.token`; never copy it anywhere). An update restarts the game and closes its open rooms, so run it when the user (or a game session acting for them) asks.
