# Plugged-in screens (HDMI / DisplayPort on the box)

Status (box 0.13.6): **one screen works.** The first connected output shows up as a TV and
can show anything a TV can (rooms, the idle screen, scenes, startup choices).
- The broker runs `cage` (a one-app Wayland compositor) with Chromium full screen on the real
  output, with no encoder. Page changes go over DevTools, so the screen doesn't blank.
- "Off" shows black (no CEC yet).
- `seatd` hands the screen to cage. It runs as root inside the broker container
  (`deploy/broker-start`); the broker itself runs as `node` with no capabilities.
- Needs `DRIVERS` to include `local` (the compose default does), `/dev/dri`, and the video
  and render groups.

## Decisions (2026-11-12)

- **Sound:** off. Games don't need it.
- **Power and input:** through **HDMI-CEC adapters**, chosen per screen (Intel graphics
  usually can't do CEC itself). Known adapters first: Pulse-Eight USB-CEC (`/dev/ttyACM*`,
  libcec's `cec-client`). The field `cecAdapter` on a display record is reserved for it.
  No adapter: the screen's picture can still be blanked over the cable (DPMS).
- **Box status screen (yes):** a plugged-in screen with nothing assigned shows the box's own
  status: its address, the setup QR code, Tailscale state. It makes first-time setup of a
  new box easy.
- **Startup:** the TV startup rules ("When the box starts") already exist for every TV
  (Roku, AirPlay); plugged-in screens get them for free. A rule waits up to 30 minutes for
  its screen to appear, so a screen switched on after the box still gets its menu.

## What's left to build

1. ~~Rendering on the real outputs~~ (done for one screen; more than one needs one cage per
   output, or cage across outputs). Original note: a kiosk Wayland compositor (cage or sway) in the
   broker container with one Chromium per output, no encoder. The container needs
   `/dev/dri` (it already has it for QuickSync) and a seat manager (`seatd`), so nothing new
   goes on the host. Reuse the AirPlay channel's Chromium flags and the DevTools previews.
2. **Hotplug:** watch connector status (udev, or poll sysfs) so screens appear and go
   offline on their own.
3. **Per-screen settings:** the mode list comes from the screen (EDID), not the fixed
   720p/1080p list. Add rotation (portrait menu boards), zoom (4K at a distance) and an
   overscan margin.
4. **CEC:** power, input, and "is it on" through the screen's adapter.
5. **Status screen:** the page above, shown on any plugged-in screen with nothing assigned.

**4K (box 0.19.1):** cage uses the screen's preferred mode, and Chromium gets a device scale
factor of width/1920 when the screen is wider than 1920 (2 on a 4K TV), so TV pages lay out at
1920x1080 CSS, as on every other path, and draw with all the screen's pixels.

**Box 0.23.0:** the broker image is Debian 13, and cage 0.2 / wlroots 0.18 give Chromium real touch (`LOCAL_TOUCH=native`, the image's default): taps reach dropdowns and dialogs like on any tablet. The DevTools passthrough below stays as `LOCAL_TOUCH=devtools`.

**Kiosk controls (box 0.25.0):** on a touch screen the pointer is hidden, and away from the page
the box sent, Back and Home buttons sit at the bottom left (above GameKit's on-screen keyboard).
Home goes back to what was cast to that screen; Back goes back a page, or home when there's
nowhere to go back to. A swipe in from the left edge also goes back. Casting a new page forgets
the history before it, so Back never returns to an earlier cast. Every plugged-in screen (touch
or not) reloads a page that didn't load (Chromium's error page, or a 5xx such as Cloudflare's 502
while a game restarts): after 5 s, then doubling up to a minute, until it loads.

**Touch (box 0.21.0):** a touchscreen's USB cable goes into the box; its video goes in like any
screen's. Then the TV's Setup tab has "Touch screen: people can tap it" (it names the
touchscreen the box found).
- **Off (the default):** the screen takes no input at all, even with a keyboard or touchscreen
  plugged in. cage always runs with the DRM backend only (`WLR_BACKENDS=drm`).
- **On (box 0.22.0):** the broker runs `touch-reader.py`, which reads every touchscreen's evdev
  node and prints touch frames. The broker turns them into DevTools
  `Input.dispatchTouchEvent`s on the page, in its CSS pixels. Chromium also gets no pinch zoom,
  no swipe-back and no pop-ups.
  - **Why not cage:** cage 0.1.4 / wlroots 0.15 (Debian 12) never offers touch to Chromium
    (wl_seat capabilities 0, "could not create touch point"), though libinput reads the
    screen fine. Moving the broker image to Debian 13 (cage 0.2, wlroots 0.18) is the
    long-term fix.
  - **Dropdowns:** Chromium's `<select>` list is a separate pop-up that touch can't reach. The
    broker adds a page script (`touchPage.ts`, box 0.22.1) that shows the choices on the page for
    every game. GameKit 0.10.6 does the same inside games; the broker's runs first.
  - **Dialogs (box 0.22.1):** `alert`, `confirm`, `prompt` and "leave this page?" are separate
    windows too, and the page is frozen while one is open. On a touch screen the broker answers
    them (Yes, OK, the prompt's default). An alert's text then shows on the page for 5 s. No
    Cancel there until the Debian 13 image gives cage real touch.
  - **Container:** `broker-start` adds the `/dev/input` group to the broker process.
  - **Venue pages only:** a DevTools session fails any page load (main page or frame) outside
    the venue's own sites, meaning the domain of every page the box sent that screen.
  - **Typing:** games show GameKit 0.10.0's `<OnScreenKeyboard />`.
- **Container:** the broker gets `/dev/input` (char major 13) and `/run/udev` (read-only, for
  libinput). One touchscreen per box for now; with several screens, touch isn't matched to a
  screen yet.

**Limits:** the box's Intel graphics drive about 3 screens (it depends on the model's
ports). 4K at 60 fps on DisplayPort; older HDMI ports top out at 4K30.
