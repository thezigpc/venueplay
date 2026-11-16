// Box 0.19.0: guest hosts. Staff give a guest (a patron guest-hosting karaoke, a visiting KJ)
// one app's controls with a QR code, and nothing else on the box. Shown on Tonight (every app
// that takes guests) and in an app's details (that app only).

import { useState } from "react";
import { api, type GuestLinkRow, type GuestsOverview } from "../api";
import { useAction, useLoad } from "../useLoad";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function GuestHostsCard({ gameId, embedded = false }: { gameId?: string; embedded?: boolean }) {
  const data = useLoad(() => api.guests(), 30_000);
  const { busy, run } = useAction(data.reload, data.setError);
  const apps = (data.data?.apps ?? []).filter((a) => !gameId || a.gameId === gameId);
  if (!data.data && !data.error) return null;
  if (data.data && !apps.length) return null;
  const body = (
    <>
      {data.error && <p className="error">{data.error}</p>}
      {apps.map((a) => (
        <GuestApp key={a.gameId} app={a} overview={data.data!} busy={busy} run={run} showName={!gameId && apps.length > 1} />
      ))}
    </>
  );
  if (embedded) {
    return (
      <div className="stack-gap guest-hosts">
        <h3>Guest hosts</h3>
        {body}
      </div>
    );
  }
  return (
    <section className="card stack-gap guest-hosts">
      <h2>Guest hosts</h2>
      {body}
    </section>
  );
}

function GuestApp({ app, overview, busy, run, showName }: { app: GuestsOverview["apps"][number]; overview: GuestsOverview; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void> | void; showName: boolean }) {
  const [label, setLabel] = useState("");
  const [hours, setHours] = useState<string>("");
  const [shown, setShown] = useState<{ id: string; label: string; url: string; qrSvg: string; expiresAt?: string } | null>(null);
  const [msg, setMsg] = useState("");
  const links = overview.links.filter((l) => l.gameId === app.gameId);
  const active = links.filter((l) => l.active);
  const hosts = active.filter((l) => l.role === "host");
  const cohostsOf = (id: string) => active.filter((l) => l.parentId === id);
  const untilClosing = overview.closingAt ? `Until closing (${time(overview.closingAt)})` : `For ${overview.defaultHours} hours`;

  const create = async () => {
    setMsg("");
    try {
      const r = await api.newGuest(app.gameId, label.trim(), hours ? Number(hours) : undefined);
      setShown({ id: r.id, label: r.label, url: r.url, qrSvg: r.qrSvg, expiresAt: r.expiresAt });
      setLabel("");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const showAgain = async (l: GuestLinkRow) => {
    setMsg("");
    try {
      const r = await api.guestLink(l.id);
      setShown({ id: l.id, label: l.label, url: r.url, qrSvg: r.qrSvg, expiresAt: l.expiresAt });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const revoke = (l: GuestLinkRow) => {
    const kids = cohostsOf(l.id).length;
    if (!window.confirm(`Turn off ${l.label}'s link now?${kids ? ` Their ${kids} co-host${kids === 1 ? "" : "s"} lose access too.` : ""}`)) return;
    if (shown?.id === l.id) setShown(null);
    void run(() => api.revokeGuest(l.id));
  };

  return (
    <div className="stack-gap">
      {showName && <h3>{app.name}</h3>}
      {!app.enabled && <p className="muted">{app.name} is turned off. Turn it on to give out guest links.</p>}
      <p className="muted small-print">
        A guest host gets {app.name}'s controls on their phone, and nothing else on the box. Settings stay with staff.
      </p>

      {app.enabled && (
        <div className="inline">
          <input placeholder="Who it's for (e.g. Dana – karaoke)" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} aria-label="Who the guest link is for" />
          <select value={hours} onChange={(e) => setHours(e.target.value)} aria-label="How long the link lasts">
            <option value="">{untilClosing}</option>
            <option value="2">For 2 hours</option>
            <option value="4">For 4 hours</option>
            <option value="8">For 8 hours</option>
          </select>
          <button type="button" className="primary" disabled={busy || !label.trim()} onClick={() => void create()}>
            Make guest link
          </button>
        </div>
      )}

      {shown && (
        <div className="host-qr">
          <span className="qr-svg" dangerouslySetInnerHTML={{ __html: shown.qrSvg }} />
          <div>
            <p>
              Scan with <b>{shown.label}</b>'s phone{shown.expiresAt ? `. It works until ${time(shown.expiresAt)}` : ""}, or{" "}
              <a href={shown.url} target="_blank" rel="noreferrer">
                open it here
              </a>
              .
            </p>
            <p className="muted small-print">Anyone with this code gets the controls until it ends, so don't leave it on screen. You can turn it off below.</p>
            <button type="button" className="ghost" onClick={() => setShown(null)}>
              Hide code
            </button>
          </div>
        </div>
      )}

      {hosts.length > 0 && (
        <ul className="guest-list">
          {hosts.map((h) => (
            <li key={h.id}>
              <div className="inline">
                <span>
                  <b>{h.label}</b> <span className="muted">· host · until {time(h.expiresAt)}</span>
                </span>
                <button type="button" className="ghost" disabled={busy} onClick={() => void showAgain(h)}>
                  Show code
                </button>
                <button type="button" disabled={busy} onClick={() => revoke(h)}>
                  Turn off
                </button>
              </div>
              {cohostsOf(h.id).map((c) => (
                <div key={c.id} className="inline guest-cohost">
                  <span>
                    {c.label} <span className="muted">· co-host, added by {h.label}</span>
                  </span>
                  <button type="button" disabled={busy} onClick={() => revoke(c)}>
                    Turn off
                  </button>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
      {app.enabled && !hosts.length && <p className="muted">No guest hosts right now.</p>}

      {app.cohostsSupported && (
        <label className="check">
          <input type="checkbox" checked={app.cohosts} disabled={busy} onChange={(e) => void run(() => api.guestSettings(app.gameId, e.target.checked))} />
          Guest hosts can add a co-host (theirs ends with their own link)
        </label>
      )}
      {msg && <p className="error">{msg}</p>}
    </div>
  );
}
