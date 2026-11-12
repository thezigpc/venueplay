#!/bin/sh
# Installs the box's host helpers (run once per box, with sudo, from deploy/host):
#   - bargames-reboot.path/.service: the admin's "Reboot box" button.
# Nothing else goes on the host; everything else runs in containers.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
data=$(cd "$here/../data/core" && pwd)
for u in bargames-reboot.path bargames-reboot.service; do
  sed "s#@DATA@#$data#g" "$here/$u" > "/etc/systemd/system/$u"
done
rm -f "$data/reboot.request"
systemctl daemon-reload
systemctl enable --now bargames-reboot.path
printf '{"reboot":true,"installedAt":"%s"}\n' "$(date -u +%FT%TZ)" > "$data/host-hooks.json"
echo "installed: bargames-reboot.path (watching $data/reboot.request)"
