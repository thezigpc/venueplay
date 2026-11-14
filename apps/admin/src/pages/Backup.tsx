// Settings → Backup and restore (box 0.16.0). One file with the box's settings, the TV
// pairings and every game's own data. It holds passwords and tokens, so a passphrase is
// offered (and recommended); bgctl backup saves the same file onto the box's USB drive.

import { useState } from "react";
import { api } from "../api";

export function BackupPage() {
  return (
    <div className="grid">
      <MakeBackup />
      <Restore />
    </div>
  );
}

function MakeBackup() {
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const make = async () => {
    setErr("");
    setMsg("");
    if (pass && pass.length < 8) return setErr("Use at least 8 characters, or leave the passphrase empty.");
    if (pass !== pass2) return setErr("The passphrases don't match.");
    setBusy(true);
    try {
      const r = await api.backup(pass || undefined);
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMsg(`Saved ${r.name} (${Math.max(1, Math.round(r.blob.size / 1024))} KB)${pass ? ", protected with your passphrase" : ""}.${r.skipped.length ? ` Left out: ${r.skipped.join("; ")}.` : ""}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2>Make a backup</h2>
      <p className="muted">
        One file with everything you'd hate to set up again: the venue, branding, games and apps, scenes, schedules and closing time, who can play, Wi-Fi and internet settings, every TV with its pairings,
        sound settings, and each game's own data (card packs, menu pictures, leaderboards). Bluetooth speakers aren't included: pair them again after a restore.
      </p>
      <p className="muted">The file holds the admin password, the venue PIN and the box's tokens. Keep it somewhere safe, and give it a passphrase.</p>
      <label>
        Passphrase (recommended)
        <input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="At least 8 characters" />
      </label>
      {pass && (
        <label>
          Passphrase again
          <input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
        </label>
      )}
      <p className="muted small-print">Without the passphrase the backup can't be restored. Nobody can recover it for you.</p>
      <div className="buttons">
        <button className="primary" disabled={busy} onClick={() => void make()}>
          {busy ? "Making the backup…" : "Download a backup"}
        </button>
      </div>
      <p className="muted small-print">
        On the box itself, <code>bgctl backup /mnt/bg-archive</code> saves the same file onto the USB drive (set <code>BG_BACKUP_PASSPHRASE</code> to protect it). It keeps the newest 30 there.
      </p>
      {msg && <p className="muted">{msg}</p>}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function Restore() {
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const restore = async () => {
    if (!file) return;
    if (!window.confirm("Restore this backup? It replaces this box's settings, TVs and pairings, and puts each game's data back. The box restarts its services (about a minute) and open game rooms close.")) return;
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const r = await api.restoreBackup(file, pass || undefined);
      const when = new Date(r.from).toLocaleString();
      setMsg(
        `Restored the backup of ${r.venue} from ${when}${r.broker ? "" : " (the TV settings couldn't be restored)"}. The box is restarting; this page reconnects by itself. ` +
          (r.games.length ? `Games' data goes back as each game starts again: ${r.games.join(", ")}.` : ""),
      );
      setTimeout(() => window.location.reload(), 20_000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2>Restore a backup</h2>
      <p className="muted">Puts a backup back on this box, or moves a venue onto a new box. The admin password becomes the one in the backup.</p>
      <label>
        Backup file
        <input type="file" accept=".bgbackup,application/octet-stream" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <label>
        Its passphrase (if it has one)
        <input type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      <p className="muted small-print">
        Moving to a new box? Restoring also brings the internet (Cloudflare) settings: turn the old box off first, so two boxes don't answer for the same address.
      </p>
      <div className="buttons">
        <button className="danger" disabled={busy || !file} onClick={() => void restore()}>
          {busy ? "Restoring…" : "Restore"}
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
      {err && <p className="error">{err}</p>}
    </section>
  );
}
