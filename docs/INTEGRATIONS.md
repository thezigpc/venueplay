# Integrations: connecting the box to other systems

**Who this is for:** a Claude Code session building an integration module, such as Matter
(Alexa, Google Home, Apple Home) or Home Assistant, in its own repository. Read the whole
file before you start.

An **integration** is a module of kind `"integration"` (SDK 0.12.0, box 0.14.0). It's
installed, updated, turned on and removed like a game or app, but:

- **It has no pages.** It isn't on the games list, the gateway, the venue's DNS or the TVs.
  The venue manages it under **Settings → Smart home**.
- **It gets only what the venue approves.** It declares permissions in `bargames.json`. The
  venue approves them when it turns the integration on, and the box refuses everything else
  with a 403.
- **It talks to the box's integration API.** It can read a catalog of scenes, TVs and games,
  listen on a live stream, run scenes, switch TVs on and off, and report its own state (the
  admin shows that report, including a pairing QR code).

The SDK package is in `C:\CodeProjects\GameBroker\integration\bargames-sdk-<version>.tgz`.
Vendor it the same way the games do: see the integration [README](../integration/README.md),
step 3. **Don't edit anything under `C:\CodeProjects\GameBroker`.** If you need something
from the box, write it down as an "SDK request" in your report.

## The manifest

```json
{
  "id": "homeassistant",
  "name": "Home Assistant",
  "kind": "integration",
  "version": "0.1.0",
  "description": "Your scenes and TVs in Home Assistant, and game events for automations.",
  "image": "ghcr.io/<owner>/<repo>:0.1.0",
  "sdk": { "version": "0.12.0", "level": 0 },
  "network": { "internet": true },
  "resources": { "memory": "256m", "cpus": 0.5 },
  "integration": {
    "permissions": ["scenes", "tvs", "status", "events"],
    "settings": [
      { "name": "MQTT_URL", "label": "MQTT broker address", "required": true, "placeholder": "mqtt://homeassistant.local:1883" },
      { "name": "MQTT_USERNAME", "label": "MQTT username" },
      { "name": "MQTT_PASSWORD", "label": "MQTT password", "secret": true }
    ]
  }
}
```

- **Fields you can leave out:** `port`, `routes` and `health`. An integration with
  `port: 0`, or no port at all, runs no web server, and the box skips the health check.
  `bargames validate .` checks the manifest.
- **`network.internet: true`:** lets the container reach the LAN and the internet through
  Docker's NAT. Home Assistant's MQTT broker needs this. With `false`, the container can
  only reach the box.

### Permissions

| Permission | What the venue approves |
|---|---|
| `scenes` | See and run the venue's scenes. Also hear when any scene runs |
| `tvs` | See the TVs (name, group, online), and switch the ones the box can control on or off |
| `status` | See which games and apps are on, how many rooms each has open, and what each TV shows |
| `events` | Hear game events (`round_started`, `winner`, …) as they happen |
| `lan` | Run on the box's host network: needed for Matter's mDNS discovery and commissioning. **Only granted to integrations from a trusted GitHub owner** (default: `thezigpc`; set by the box's `TRUSTED_OWNERS`). The integration must be installed from that owner's GitHub repo |

Ask only for what you use. If a new version asks for more, it keeps running with the old
permissions until the venue approves the new ones on the Smart home page.

### Settings

Settings are values the venue enters on the Smart home page: a broker address, a login,
and so on. The box stores them owner-only and passes each one to your container as an
environment variable named after it. Saving restarts the container.

- **Secret settings** (`"secret": true`) are never shown again after they're saved.
- **Rules:** names are CAPITALS_AND_UNDERSCORES, never `BG_*` or `PORT`.
- **Missing values:** a required setting can still be empty when your container starts.
  Handle that, and report `state: "setup"` with a message that says what's missing.

## What your container gets

| Env | Value |
|---|---|
| `BG_CORE_URL` | The box's API. With `lan`, that's `http://127.0.0.1:7100` (core's loopback port) |
| `BG_GAME_TOKEN` | Your token. Send it as `Authorization: Bearer …`. Never log it |
| `BG_GAME_ID` | Your manifest id |
| `BG_PERMISSIONS` | What the venue approved, comma-separated, e.g. `scenes,tvs,events` |
| `BG_DATA_DIR` | `/data`, a volume that survives updates and restarts. Keep pairings and state here |
| *your settings* | e.g. `MQTT_URL` |

The container runs with a read-only root filesystem, no Linux capabilities, a writable
`/tmp` (64 MB, noexec) and `/data`. It's limited by the `resources` in your manifest.

## The SDK helper

```ts
import { createIntegration } from "@bargames/sdk/integration";

const box = createIntegration();            // reads BG_CORE_URL and BG_GAME_TOKEN

const stop = box.connect({
  onCatalog: (catalog, first) => sync(catalog), // on every (re)connect, then on each change
  onEvent: (e) => publishEvent(e),              // permission "events"
  onScene: (s) => markRan(s.sceneId, s.ok),     // any scene run, from anywhere
  onConnection: (up) => setAvailable(up),
  onAction: (id) => id === "reset" && forgetPairings(), // a button from your report
});

await box.runScene("bingo-night");            // → { ok, steps: [{ step, ok, message? }] }
await box.tvPower("roku:abc123", false);
await box.report({ state: "ok", message: "Connected to Home Assistant", details: [{ label: "Entities", value: "14" }] });
```

- **`catalog`:** `{ box: { id, version, venue }, permissions, scenes?, tvs?, games? }`.
  - Lists you have no permission for are left out.
  - `box.id` is stable for the box: use it as a Matter serial number or as the root of Home
    Assistant unique ids.
  - Scene and TV ids are stable too. A TV id can change only when the box moves a TV to a
    better driver, for example from AirPlay to the Vizio driver. The catalog then shows the
    new id: treat it as a new device and drop the old one.
- **The stream:** it reconnects with backoff, and its first message is always the full
  catalog. After that, a `catalog` message arrives whenever what you can see changes: a scene
  added or renamed, a TV renamed or going offline, a game switched on.
- **`report`:** this is what the venue sees on the Smart home page.
  - When to send it: on start, on every change, and again after the stream reconnects. Reports
    live in memory, so a box restart clears them.
  - `state`: `"setup"` (waiting for the venue), `"ok"`, `"warn"` or `"error"`.
  - `message`: one short sentence.
  - `pairing`: `{ qr, code, note, expiresAt? }`. The admin draws `qr` as a QR code, for
    example Matter's `MT:…` payload, and shows `code` as text, for example the 11-digit manual
    pairing code. `expiresAt` (SDK 0.13.1, an ISO time) is when the code stops working, such
    as a 15-minute commissioning window: the admin shows the minutes left, then greys the
    code out and says it expired, even if your integration never reports again.
  - `details`: up to 12 label/value lines.
  - `actions`: up to 4 buttons for the Smart home page, each `{ id, label, confirm? }`, for
    example `{ id: "reset", label: "Forget all pairings", confirm: "Alexa and Google will lose
    the box." }`. A press arrives through `connect({ onAction })` with the button's id. Keep the
    buttons in every report while they apply.
- **Off a box:** `createIntegration()` with no `BG_CORE_URL` sets `onBox: false`, every call
  rejects with `BoxUnavailable`, and `connect()` does nothing.

The raw HTTP API is in `INTEGRATION_PATHS` (in `@bargames/sdk`) if you'd rather not use the
helper:

| Method and path | Use |
|---|---|
| `GET /internal/integration/catalog` | The catalog |
| `GET /internal/integration/stream` | Server-sent events: `hello`, `catalog`, `event`, `scene` and `action` messages |
| `PUT /internal/integration/report` | Send your report |
| `POST /internal/integration/scenes/:id/run` | Run a scene |
| `POST /internal/integration/tvs/:id/power` | Body `{ on }`: switch a TV on or off |

## Developing without a box

```bash
npx bargames mock-box .          # a fake core on :7199 that knows your manifest
BG_CORE_URL=http://127.0.0.1:7199 BG_GAME_TOKEN=dev-token npm run dev
```

**What the mock box gives you:**
- **Approval:** it treats everything your manifest declares as approved.
- **Scenes:** three: `bingo-night`, `last-call` and `all-tvs-off`.
- **TVs:** three fake TVs. "Lounge" can't be switched on or off, and "Patio" goes offline and
  comes back every 60 seconds, so your code sees `catalog` updates.
- **Events:** a pretend game event every 30 seconds, alternating `round_started` and `winner`.
- **Logging:** it prints every scene run, TV switch and report, including the pairing payload.
- **Test controls (SDK 0.13.1)**, on the mock gateway (default port 7080), no login:

  | Request | Does |
  |---|---|
  | `GET /__bargames/dev/integration` | What the mock box holds: open streams, your last report, the catalog |
  | `POST /__bargames/dev/integration/action/<id>` | Presses a button from your latest report (an `action` on the stream) |
  | `POST /__bargames/dev/integration/drop` | Drops every stream, as a box restart does; check you reconnect and report again. `?for=N` (SDK 0.13.2) keeps every integration endpoint answering 503 for N seconds |
  | `PUT /__bargames/dev/integration/catalog` | Body `{ scenes?, tvs?, games? }` replaces those lists and sends a `catalog` message. TV power follows it (SDK 0.13.2): unknown TV 404, `power: false` 400, offline 502 |
  | `DELETE /__bargames/dev/integration/catalog` | Back to the pretend lists |

## Publishing and installing

1. **Publish:** publish the container image with the games' GitHub Actions workflow
   (`integration/snippets/publish-image.yml`), tagged with the version. The package must be
   public, so the box can pull it without a login.
2. **Install:** on the box, run
   `bgctl install https://github.com/<owner>/<repo> --wait 20`, or paste the address into
   **Settings → Smart home → Add a connection**.
3. **Turn it on:** the venue does that on the Smart home page, approving what it asks for.
   `bgctl install --enable` doesn't turn integrations on.
4. **Release updates:** bump `version` in `bargames.json` and publish a new image. The box's
   update check finds it, and `bgctl update <id> --wait 20` or the page's Update button
   installs it.

## Rules

- **Don't hold the box up.**
  - Start without the network and without your settings, and report `setup`.
  - Retry with backoff, and never crash-loop.
  - A missing setting or an unreachable broker is a `setup` or `warn` report, not an exit.
- **Keep credentials safe.** Never log the token, settings marked `secret`, pairing secrets or
  anything else in `/data`. Keep them out of reports as well.
- **Leave scenes and TVs to the box.** Don't keep your own copy of what scenes do. Run them
  through the box, so the venue edits them in one place.
- **Assume the box moves between networks** (from home to the venue, for example). Pairings in
  `/data` must survive a new IP address. Matter's mDNS re-announces on its own; MQTT clients
  must reconnect.
- **Keep private details out of the repo.** The repos may be public, so never commit LAN
  addresses, names, MQTT logins or pairing codes. In examples, use the documentation ranges
  (192.0.2.x).
