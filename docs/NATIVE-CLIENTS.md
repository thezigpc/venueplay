# Native clients: apps on the TV that pair with the box

Status: **planning.** Nothing built yet. Client projects (scaffolding only):
`C:\CodeProjects\VenueboxRokuClient`, `VenueboxAndroidClient`, `VenueboxiOSClient`,
`VenueboxDesktopClient` (Windows and macOS, plus Linux for child boxes).
This file is the shared contract: the box side and every client follow it.

## Why

Today the box drives TVs with nothing installed on them. It renders each game's TV page in
its own Chromium, encodes it (QuickSync) and mirrors it over AirPlay. That works with any
AirPlay TV, but every TV page costs the box an encoder and adds 1–2 s of delay.

A small app on the TV (or on a PC driving it), paired once with the box, can do better:

| Client | How it shows a game | Box cost | Delay |
|---|---|---|---|
| Windows / macOS / Linux PC (`VenueboxDesktopClient`) | Its own Chromium (Electron), **one window per attached screen** | none | ~0 |
| Android / Google TV (`VenueboxAndroidClient`) | Opens the TV page itself in a WebView (Chromium): **no encoding** | none | ~0 |
| iPad / iPhone (`VenueboxiOSClient`, iOS) | WKWebView, same as Android | none | ~0 |
| Apple TV (`VenueboxiOSClient`, tvOS target) | tvOS has **no web view**: plays the box's HLS stream (AVPlayer) | one encode, shared | 2–6 s |
| Roku (`VenueboxRokuClient`) | Roku has **no browser**: plays the box's HLS stream (SceneGraph Video) | one encode, shared | 2–6 s |

So PCs, Android/Google TV and iPads get the biggest win: they render the game themselves.
Roku and Apple TV still need the box to encode, but **HLS is encoded once per page and
fanned out to any number of TVs**, with no AirPlay pairing quirks, and the app can show the
box's status, reconnect on its own, and start at power-on.

**Child boxes.** A venue's cheap PC or mini PC running the desktop client is a "child box":
one device, several TVs (one per HDMI/DisplayPort output), paired once, each output listed
as its own TV on the box's TVs page. A Linux mini PC with the client is the cheapest way to
add 2–3 wired TVs with no encoding on the main box.

## Delivery methods (broker)

The broker already has the slots (`apps/broker/src/types.ts`, `DeliveryMethod`):
- `native-url`: the client opens a URL itself (desktop, Android, iOS).
- `roku-hls`: the box renders + encodes HLS; the client plays it. Apple TV uses it too
  (rename to `hls` when it's built). Today `hlsUrl()` throws "not built".
- `airplay`: unchanged, for TVs without our app.

Each paired screen is a **display** like any other (a `venuebox` driver), so casting, idle
screens, startup choices, previews and the TVs page all work unchanged.

## Pairing (once per device)

Pairing is per **device**; a device reports one or more **screens**, and each screen is a
display on the box (id `<device id>:<screen id>`).

1. **Discovery.** The box advertises `_venuebox._tcp` over mDNS (address, box id, name).
   Clients list boxes found on the LAN; "enter the box address" is the fallback (other
   VLAN, mDNS blocked). Clients reach the box over the **venue's own network only**.
   Tailscale is for our management and remote support, not for clients; connecting
   remote clients over Tailscale would be an option only for a venue that pays for its
   own Tailscale plan (not planned for v1).
2. **Code.** The client asks the box to pair (`POST /pair/start` with its device info:
   platform, model, screens, app version) and gets a **6-digit code**, which it shows on
   screen. Staff type the code on the box's TVs page (like AirPlay pairing today).
3. **Credentials.** The box answers the client's poll with a device id and a long-lived
   **device token**, stored on the device (OS credential store: Windows Credential
   Manager / DPAPI, macOS and iOS Keychain, Android Keystore, Roku registry). Staff can
   rename, group or **revoke** the device on the TVs page; revoking kills the token.

Pairing endpoints are served by core on the LAN only (the gateway's `local` access rule),
never through the Cloudflare tunnel.

## Control channel

After pairing the client keeps one **WebSocket** to the box
(`wss://<box>/__venuebox/client`, token in the first message), reconnecting with backoff.

Box → client:
- `show { screen, url, kind: "native-url" | "hls", title }`: open a TV page (WebView) or
  play an HLS URL (player) on one screen. The box only sends delivery methods the client
  declared.
- `off { screen }`, `reload { screen }`
- `identify { screen, label }`: flash the screen's name (find which TV is which)
- `preview { screen, requestId }`: send a picture of the screen
- The idle screen is an ordinary `show` (kind `native-url`); there's no separate `idle`
  message. Its URL is usually a **`data:text/html` page**, not http(s): WebView clients must
  load it (Android: decode and `loadDataWithBaseURL`; a long data: URL in `loadUrl` is
  unreliable).
- **TV pages are laid out for a 1920x1080 CSS viewport** (every box path does this: AirPlay,
  local screens, the desktop client; 4K panels at scale 2). WebView clients must pin the
  viewport to 1920 CSS px and scale to the panel. A TV's default density gives about 960 CSS
  px, and pages then hit their phone layouts.
- Planned, not built: `settings { screen, … }` (per-TV zoom/overscan/rotation from the TVs
  page). Clients ignore message types they don't know, so it can be added later.

Client → box:
- `hello { token, platform, model, appVersion, screens: [{ id, name, w, h, hz }], deliveries: [...] }`
  (one screen for TVs and phones; one per output on a desktop client)
- `screens [...]`: a monitor/TV was plugged in or unplugged (desktop); the box adds the
  new displays and marks missing ones offline
- `state { screen, showing, playing | buffering | error, detail }` (feeds the TVs page and
  the startup rules' "online" check)
- `preview { screen, jpeg }` on request (WebView clients; HLS previews come from the box)

The protocol is versioned (`v: 1` in `hello`); the box keeps the previous version working,
the same rule as the game SDK.

## v1 as built (box side, 2026-11-12)

- **Where:** the broker (it owns the displays and shares the host's network), port
  **7210** (`CLIENT_PORT`), plain HTTP/WebSocket for the venue LAN (never through the
  Cloudflare tunnel; Tailscale is for management only, not a client path). Clients use
  `http://<box LAN address>:7210`. `VENUEBOX=off` turns it off.
- **Endpoints and messages:** exactly as typed in
  `apps/broker/src/venuebox/protocol.ts` (the source of truth for field names):
  `GET /health`, `POST /pair/start`, `GET /pair/status?id=`, WebSocket `/client`.
  The first message is `hello`; the box answers `welcome` (device id, name, a label per
  screen) or `error` + close (4401 bad token, 4403 revoked, 4400 protocol, 4409 replaced
  by a newer connection of the same device). The box pings every 30 s.
- **Pairing codes** last 10 minutes; 3 pending per source address, 20 in all. The token is
  handed out once (the next status poll is 404).
- **Reconnects:** on `hello` (and for newly plugged screens) the box re-sends what each
  screen was showing.
- **Admin:** TVs page, "Venuebox apps" card (pair by code, rename, remove) and Identify on
  each Venuebox screen's card. Core reaches it through `/api/broker/venuebox*`.
- **Discovery (box 0.16.2):** the broker answers mDNS (DNS-SD) on the venue LAN, so apps
  find the box without typing an address that DHCP can change:
  - browse **`_venuebox._tcp.local`** (a PTR query to 224.0.0.251:5353; any DNS-SD library:
    Bonjour/`Zeroconf`, Android `NsdManager`, Roku has none, so it takes the address);
  - the instance name is the **venue's name** (Settings → Venue), the SRV record gives port
    **7210** and host `bargames-<id>.local`, A records give every LAN IPv4 address of the box;
  - TXT: `v=1`, `id=<12 hex>` (stable for this box: remember the box by it, not by its IP),
    `name=<venue name>`, `path=/venuebox`;
  - the box announces itself at start and every 2 minutes, and answers legacy-unicast
    queries (from a port other than 5353) directly.
  Pairing still needs the 6-digit code; discovery only finds the box. `DISCOVERY=off` turns it
  off. Networks with client isolation block mDNS too: keep "type the address" as the fallback.
- Not yet: HLS for Roku/Apple TV; a route that sends `reload`.

## Clients as built

- **Android / Google TV, v0.1.0 (2026-11-16):** repo `thezigpc/VenueboxAndroidClient`, APK on
  its GitHub release (package `com.bargames.venuebox`, Android 8.0+, Leanback; debug-signed,
  sideload only). mDNS discovery with a typed-address fallback, Keystore-encrypted token,
  `native-url` shows (data: idle pages too), identify, preview, off, start at boot.
  - **Start at boot** on Android 10+ needs "Display over other apps": grant it from the app's
    panel, or with `adb shell appops set com.bargames.venuebox SYSTEM_ALERT_WINDOW allow`.
  - Tested on the Android TV 14 emulator against a box. Not yet on a real stick.
  - Before venues install updates, it needs one shared release signing key, kept out of
    every repo. An APK signed with a different key can't upgrade the installed app.

## Box side (when building starts)

1. Core: pairing endpoints and the device registry (data/core/devices.json), LAN-only.
2. Broker: `venuebox` driver over the control channel, one display per screen;
   `native-url` delivery.
3. Broker: HLS output: the existing Xvfb + Chromium channel feeds GStreamer
   `vah264enc` → `hlssink2` (already in the broker image: gst-plugins-bad), segments served
   by the gateway to LAN clients only; one encode per page + settings, like AirPlay channels.
4. mDNS advert (`_venuebox._tcp`) from the broker (host network).
5. Admin TVs page: "Pair a Venuebox app" (enter code), device rows with their screens,
   revoke.

## What each client needs to develop (tooling, accounts)

| | Dev machine | Accounts / cost | Device setup |
|---|---|---|---|
| Windows / macOS / Linux desktop | Windows is fine: Node + Electron, `electron-builder` for installers. Mac builds need macOS (or GitHub Actions macOS runners) | Optional: a Windows code-signing certificate (avoids SmartScreen warnings); the Apple Developer Program for a notarized Mac app | Install, pair once, start at login; one window per screen |
| Roku | Windows is fine: BrightScript/SceneGraph, VS Code + BrightScript extension, Node (`brighterscript`, `roku-deploy`) | Roku developer account: free (channel store publishing optional) | Developer mode on the Roku (Home x3, Up x2, Right, Left, Right, Left, Right); sideload a zip over the LAN |
| Android / Google TV | Windows is fine: Android Studio, Android SDK, JDK 17, `adb` | Google Play Console $25 one-time, only to publish; sideloading needs nothing | Developer options + network ADB on the TV/stick |
| iOS / iPadOS / tvOS | **A Mac with Xcode is required** (Apple tooling only runs on macOS); CI can use GitHub Actions macOS runners | Apple Developer Program $99/year for TestFlight and installs that don't expire after 7 days | Pair the device with Xcode |

The iOS/tvOS client and the Mac build of the desktop client need a Mac (or macOS CI).
Everything else can be built from this Windows PC.
