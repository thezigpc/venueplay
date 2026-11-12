# Bar Games platform: project notes

Plan: GAMEPLAN.md · Vision: VISION.md · SDK guide: docs/SDK.md · Overview: README.md

Repo: https://github.com/thezigpc/venueplay (private, branch `main`). Commits use the user's GitHub no-reply email (repo-local git config). The product and code are still called "Bar Games" (`@bargames/*`); only the repo is named venueplay.

## Conventions
- npm workspaces, TypeScript (NodeNext), Express 4, React 18 + Vite 5, Node 22 images. These match the user's other games (Bingo, CAH, Pool).
- Tests use `node:test` through tsx (`npm test`). Every package has `src/*.test.ts`.
- Use `npm run build` before running anything compiled. `tsc -b` builds the referenced projects in order.
- The game SDK (`packages/sdk`) must stay dependency-free and browser-safe, except the Node-only `server.ts`, `cli.ts` and `devbox.ts`.
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

## Dev box: bg-box (192.168.77.13)
- Ubuntu Server 26.04 (minimized install). **Install only what's needed on the host.** Everything else goes in containers.
- `ssh -i ~/.ssh/<ssh-key> <user>@192.168.77.13`. (Login details are in CLAUDE.local.md.)
- The stack is in `~/bargames/deploy` (`docker compose`). Admin UI: http://192.168.77.13/ from the LAN. The user sets the password on the first visit; first-run setup is accepted only from the LAN.
- The render GID is 991. The bench Rokus are an Express 3930RW (192.168.77.132) and a Streaming Stick 3800X (192.168.77.133). Both report AirPlay.
- Don't send power, input or launch commands to the user's devices without asking. Read-only discovery is fine.
- **Game updates from the command line (`bgctl`):** `ssh -i ~/.ssh/<ssh-key> <user>@192.168.77.13 '~/bargames/deploy/bgctl update <game> --wait 20'`.
  Also `bgctl status`, `bgctl check [game]`, `bgctl update --all`, `bgctl install <GitHub repo URL> --enable --wait 20` (first install), `bgctl startup` (apply the TVs' "When the box starts" choices now), `--json`. It runs inside the core container with core's ops token (`data/core/ops.token`; never copy it anywhere).
  An update restarts the game and closes its open rooms, so run it when the user (or a game session acting for them) asks. `--wait` covers an image that's still building.
