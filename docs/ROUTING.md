# Addresses: one hostname per venue (decided 2026-11-12)

Goal: fewer hostnames and DNS records. A venue (tenant) is one hostname, plus optionally one
for the admin.

## Decisions
- **Games and apps live under the venue's main hostname by path** (default):
  `https://<play host>/` is the games list, `/<game>` each game or app (the game's id, or
  its alias). The play host is the existing "games list address" setting (`play.`,
  `venue.`, or a tenant name like `pachakava.zigbarplatform.com`).
- **Per game, a subdomain is an option** (venue setting on the Games/Apps card). Games that
  can't run under a path (no SDK, or not updated yet) keep their subdomain automatically.
- **Admin at `/admin` on the same hostname by default.** A separate admin hostname
  (`<tenant>-admin.<domain>`, one level deep so the free certificate covers it) is an option,
  shown in the admin as the **security recommendation**: on one origin, any game page can
  act as signed-in staff (browsers isolate by hostname, not path). Client boxes set up by
  the operator use the separate `-admin` hostname.
- **Cloudflare modes:**
  - *Full* (today): the box holds an API token and manages its tunnel and DNS records. The
    operator's own boxes.
  - *Tunnel only* (new): the operator creates the tunnel and the tenant's hostnames in their
    own Cloudflare; the box gets only the tunnel connector token and can't touch the zone.
    Client and test boxes.
- **Base path is a standard game ability, not box-only.** The kit and SDK support running a
  game under any prefix (`BASE_PATH=/bingo`), so a self-hosted standalone game can sit behind
  any reverse proxy too. Default `""`: a standalone game still installs at the root.

## Mechanism (SDK 0.10.0)
- The prefix is stripped by the proxy (the box gateway, or the self-hoster's proxy): app
  servers keep their routes (`/api`, `/admin`, `/socket.io`) unchanged.
- The game learns its prefix from one setting: `BG_BASE_PATH` (set by the box) or
  `BASE_PATH` (self-hosted). SDK server `bg.basePath`; `VenueContext.game.basePath`.
- The game's HTML gets `<meta name="bargames-base" content="/bingo">` (and `<base href>`)
  when it's served (kit `serveSpa()`), so the client knows its prefix before any request.
  SDK client `basePath()` / `bgUrl(path)`; socket.io path `${base}/socket.io`.
- Vite builds with `base: "./"` (relative assets work under any prefix).
- Manifest `"routing": { "basePath": true }` declares support.
- Box: join links, cast URLs, staff links and the games list build
  `https://<play host>/<game>/…`; old subdomain addresses redirect to the path.

## Order
1. SDK + kit base-path support; mock box serves a game under a prefix.
2. Gateway path routing (`/<game>/…`, WebSockets too), per-game subdomain option, redirects.
3. Admin at `/admin` (default) or a separate admin hostname (option + recommendation).
4. Cloudflare tunnel-only mode.
5. A round for each game (Bingo, No Filter, Menu, YouTube).

## As built (box 0.10.0)
- Steps 1 and 2 are done: SDK 0.10.0, game kit 0.6.0, gateway path routing, core URLs.
- A game is served at `<play host>/<alias or id>` when its manifest has `"routing": { "basePath": true }`
  and the venue didn't tick "Give it its own hostname" (`ownHostname`). Core sets `BG_BASE_PATH`
  and a `BG_PUBLIC_URL` with the path, which recreates the container once.
- The gateway matches host + prefix before host alone. It strips the prefix (HTTP and
  WebSockets), redirects `/<id>` to `/<id>/`, puts the prefix back on the game's `Location`
  headers and staff/PIN returns, and sends `X-Forwarded-Prefix`.
- Path games drop out of the box's hostname list, so the Cloudflare sync removes their CNAMEs
  and tunnel routes. The old subdomain gets a 301 route to the path, which only helps while
  the name still resolves (a LAN name or a wildcard record).
- Reserved names (a game can't take them): admin, api, internal, health, assets.
- Same origin means shared cookies and storage: games must key storage per game (the kit's
  session store already does) and scope their cookies to their prefix.

## As built (box 0.11.0): the admin
- Default: the admin is at `<play host>/admin` (route `path: "/admin"`, kind admin). Its old
  hostname gets a 301 route there and leaves the DNS list.
- Option (Venue → Addresses, `adminOwnHost`): its own hostname from `adminLabel`, suggested
  as `<play label>-admin` (one level deep). This is the security recommendation, and the
  setup for client boxes.
- Core serves the admin page with the prefix injected (from the gateway's `X-Forwarded-Prefix`)
  and scopes its session cookie (`bg_admin`) to `/admin/`. The gateway also strips that cookie
  from every non-admin request.
- From the LAN by IP, the admin answers at the root and at `/admin`.
- Known trade-off (accepted 2026-11-12, decided again at the admin-hostname option): on one
  hostname a game page's script can call `/admin/api/*` with the staff's session, and can read
  other games' localStorage.
