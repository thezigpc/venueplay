# Plugged-in screens (HDMI / DisplayPort on the box)

Status: **scaffolding.** `apps/broker/src/drivers/local/` lists connected outputs (read-only,
from `/sys/class/drm`) when the broker runs with `DRIVERS=roku,airplay,local`. Nothing can
be shown on them yet. Build the rest once a screen is attached to a test box.

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

1. **Rendering on the real outputs:** a kiosk Wayland compositor (cage or sway) in the
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

**Limits:** the box's Intel graphics drive about 3 screens (it depends on the model's
ports). 4K at 60 fps on DisplayPort; older HDMI ports top out at 4K30.
