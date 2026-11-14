# Settings backup and restore (box 0.16.0)

One file holds what a venue would hate to set up again:

| Part | What's in it |
|---|---|
| Core | Venue, branding, hostnames, games and apps (and their tokens), scenes, schedules, closing time, announcement presets, who can play (PIN), Wi-Fi, Cloudflare, app secrets, the admin password, leaderboards |
| Broker | Every TV with its name, group and picture settings, AirPlay / Vizio / Apple TV pairings, sound outputs and volumes |
| Games | Each game's and app's own `/data` (card packs, menu pictures, saved lists…) |

**Not included:**
- **Bluetooth pairings:** they live in a root-only folder. Pair speakers again after a restore.
- **Machine files:** the ops token, host hooks and update requests stay with the machine.

**Passphrase:** the file holds passwords and tokens. With a passphrase (8+ characters) it's encrypted with AES-256-GCM, using a key derived by scrypt. Nobody can open it without the passphrase, and nobody can recover a lost one.

## Making one

- **Admin:** Settings → Backup and restore → Download a backup.
- **On the box:**
  - `./bgctl backup [folder]` saves `bargames-settings-<UTC time>.bgbackup`. The default folder is `../backups/settings`.
  - `BG_BACKUP_PASSPHRASE=… ./bgctl backup /mnt/bg-archive` encrypts it and writes it to the USB drive.
  - It keeps the newest 30 files in that folder.

## Restoring

Settings → Backup and restore → pick the file, enter its passphrase, then Restore. In order:
1. **Broker:** writes its files and restarts.
2. **Core:** writes its files and restarts. Compose starts both again.
3. **Games:**
   - Each game's data goes back once its container is up again, and the game restarts.
   - After a move to a new box this may take a while, because the images are pulled first. Core waits up to 15 minutes.

Things to know:
- **The admin password** becomes the one in the backup.
- **Moving to a new box:** the Cloudflare settings come along too. Turn the old box off first, so two boxes don't serve the same address.
- **Open game rooms** close when the games restart.

## API

| Request | Use |
|---|---|
| `POST /api/backup` | The file (admin). Header `x-backup-passphrase` (URI-encoded) encrypts it; `x-backup-skipped` (response) lists what couldn't be read |
| `POST /api/backup/restore` | The file as the body (`application/octet-stream`), with the same passphrase header |
| `POST /internal/ops/backup` | The same file for `bgctl` (ops token) |
| Broker `GET /backup`, `POST /backup/restore` | Its `*.json` files, base64 (core only) |
