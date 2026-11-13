#!/bin/sh
# Installs the box's host helpers (run once per box, with sudo, from deploy/host):
#   - bargames-reboot.path/.service: the admin's "Reboot box" button.
#   - bargames-update.path/.service: the admin's "Update Bar Games" button (bgctl self-update).
#   - bargames-wifi.path/.service: the admin's Box Wi-Fi page (saved networks via netplan;
#     the script is copied to /usr/local/lib/bargames so root never runs a user-writable file).
# Nothing else goes on the host; everything else runs in containers.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
deploy=$(cd "$here/.." && pwd)
data=$(cd "$deploy/data/core" && pwd)
for u in bargames-reboot.path bargames-reboot.service bargames-update.path bargames-update.service bargames-wifi.path bargames-wifi.service; do
  [ -f "$here/$u" ] || continue
  sed "s#@DATA@#$data#g; s#@DEPLOY@#$deploy#g" "$here/$u" > "/etc/systemd/system/$u"
done
wifi=false
if [ -f "$here/bargames-wifi" ] && [ -f /etc/systemd/system/bargames-wifi.path ] && command -v python3 > /dev/null && command -v wpa_supplicant > /dev/null; then
  install -d -m 755 /usr/local/lib/bargames
  install -m 755 "$here/bargames-wifi" /usr/local/lib/bargames/bargames-wifi
  wifi=true
fi
rm -f "$data/reboot.request" "$data/update.request" "$data/wifi.request"
systemctl daemon-reload
systemctl enable --now bargames-reboot.path
[ -f /etc/systemd/system/bargames-update.path ] && systemctl enable --now bargames-update.path
if [ "$wifi" = true ]; then systemctl enable --now bargames-wifi.path; fi
printf '{"reboot":true,"update":true,"wifi":%s,"installedAt":"%s"}\n' "$wifi" "$(date -u +%FT%TZ)" > "$data/host-hooks.json"
echo "installed: bargames-reboot.path, bargames-update.path$([ "$wifi" = true ] && echo ', bargames-wifi.path') (watching $data)"
