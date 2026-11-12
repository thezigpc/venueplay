#!/bin/sh
# Installs the box's host helpers (run once per box, with sudo, from deploy/host):
#   - bargames-reboot.path/.service: the admin's "Reboot box" button.
#   - bargames-update.path/.service: the admin's "Update Bar Games" button (bgctl self-update).
# Nothing else goes on the host; everything else runs in containers.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
deploy=$(cd "$here/.." && pwd)
data=$(cd "$deploy/data/core" && pwd)
for u in bargames-reboot.path bargames-reboot.service bargames-update.path bargames-update.service; do
  [ -f "$here/$u" ] || continue
  sed "s#@DATA@#$data#g; s#@DEPLOY@#$deploy#g" "$here/$u" > "/etc/systemd/system/$u"
done
rm -f "$data/reboot.request" "$data/update.request"
systemctl daemon-reload
systemctl enable --now bargames-reboot.path
[ -f /etc/systemd/system/bargames-update.path ] && systemctl enable --now bargames-update.path
printf '{"reboot":true,"update":true,"installedAt":"%s"}\n' "$(date -u +%FT%TZ)" > "$data/host-hooks.json"
echo "installed: bargames-reboot.path, bargames-update.path (watching $data)"
