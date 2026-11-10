# Putting the box online with Cloudflare

The box publishes its games through a **Cloudflare Tunnel**. The box dials out to
Cloudflare, so there's no port forwarding, no static IP, and nothing to change on the
venue's router. The admin UI's **Internet** tab walks you through it. This page covers
the same steps, plus what happens behind the scenes and how to troubleshoot.

## What you need

- A free Cloudflare account.
- A domain whose nameservers point at Cloudflare (it shows as **Active** in the
  dashboard). A domain that already runs a website or email is fine: the box only adds
  its own records.
- The box set up and reachable on the LAN: `http://<box IP>/`.

## Steps

### 1. Add the domain to Cloudflare (skip if it's already there)

1. In [dash.cloudflare.com](https://dash.cloudflare.com), go to **Add a domain**, then pick the **Free** plan.
2. At the registrar (GoDaddy, Namecheap…), replace the nameservers with the two Cloudflare gives you.
3. Wait for **Active**. That's usually minutes, sometimes a few hours.

### 2. Create an API token for the box

Go to [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens), then
**Create Token**, then **Create Custom Token**.

| Setting | Value |
|---|---|
| Token name | `Bar Games box` |
| Permissions | **Account · Cloudflare Tunnel · Edit**<br>**Zone · DNS · Edit**<br>**Zone · Zone · Read** |
| Account Resources | Include · *your account* |
| Zone Resources | Include · Specific zone · *your domain* |
| Client IP filtering | Optional: the venue's public IP |
| TTL | Leave empty |

Then click **Continue to summary**, then **Create Token**, and copy the token. Cloudflare
shows it only once.

### 3. Connect, in the admin UI → Internet

1. Paste the token, then click **Check token**. The box lists the domains the token can see.
2. Pick the domain and an address style. The preview shows every address the box will
   create (`admin.`, `play.`, one per game) and flags any name that's already in use.
3. Optionally, let staff reach the admin page from outside the venue. It still needs the
   admin password.
4. Click **Connect to Cloudflare**. Within about a minute the status turns **healthy**,
   and `https://play.<your domain>` works.

## What the box does

| Step | Cloudflare API |
|---|---|
| Find or create the tunnel `bargames-<venue>-<box id>` (remotely managed) | `GET/POST /accounts/{id}/cfd_tunnel` |
| Get the connector token | `GET …/cfd_tunnel/{id}/token` |
| Route every address to the gateway, and anything else to a 404 | `PUT …/cfd_tunnel/{id}/configurations` |
| Add a proxied `CNAME <host> → <tunnel id>.cfargotunnel.com` per address | `POST /zones/{id}/dns_records` |
| Run `cloudflared` as the container `bargames-tunnel` (read-only, no capabilities, 128 MB) | Docker, through the socket proxy |

**Keeping it in sync:** the box re-checks its addresses every 15 seconds. When a game is
installed or removed, or an address style or alias changes, the box adds the new
records and removes its own stale ones.

**Ownership rule:** the box treats a record as its own only if it's a CNAME to *its*
tunnel. It never edits or deletes anything else in the zone. A name that's already taken
shows up as a conflict for you to resolve.

**Where the secrets are:** the API token and tunnel token live in
`deploy/data/core/cloudflare.json` (mode 600) and never go back to the browser.

**Disconnect** (Internet tab) does the following:
- stops the connector;
- deletes the box's records and the tunnel;
- keeps the API token for reconnecting;
- returns the box to LAN-only addresses.

## Who gets in

Traffic through the tunnel carries `CF-Connecting-IP`. The gateway lets it in only from:
- the venue's own public IP (auto-detected; IPv6 per /64);
- the whitelist on the Access tab;
- anyone who knows the venue PIN, if it's turned on.

Everyone else sees a "join the venue Wi-Fi" page. LAN requests that don't come through
the tunnel are always allowed.

## Address styles and certificates

Cloudflare's free certificate covers `yourdomain.com` and **one level** below it
(`pool.yourdomain.com`). Two-level styles such as `{game}.internal.{domain}` need
**Advanced Certificate Manager** (paid), or browsers will show a certificate error. The
wizard warns you when a style needs it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "token is invalid or was revoked" | Create a new token and paste it. |
| "missing the permission …" | Edit the token in Cloudflare and add the named permission. |
| "can't see any domains" | Add **Zone · Zone · Read**, and include the domain under Zone Resources. |
| Domain shows `(pending)` | The nameserver change hasn't finished. Wait, then click **Check token** again. |
| An address shows ✗ "already used by …" | Delete that record in Cloudflare, or rename the label on the Venue tab or pick another style. |
| Status stays `inactive`/`down` | On the box, run `docker logs bargames-tunnel`. Check that it has internet access and that outbound port 7844 (UDP/TCP) isn't blocked. |
| "Disconnect" couldn't delete the tunnel | Delete `bargames-…` under **Zero Trust → Networks → Tunnels**. |
| Guests see "join the Wi-Fi" while on the Wi-Fi | The venue's public IP changed or isn't detected. Check the Access tab, or add the IP by hand. |
