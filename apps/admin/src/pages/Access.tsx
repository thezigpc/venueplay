import { useEffect, useState } from "react";
import { api, type Access } from "../api";
import { useAction, useLoad } from "../useLoad";

export function AccessPage() {
  const access = useLoad(api.access);
  const { busy, run } = useAction(access.reload, access.setError);
  const [a, setA] = useState<Access | undefined>();
  const [cidr, setCidr] = useState("");
  const [label, setLabel] = useState("");
  const [venueRange, setVenueRange] = useState("");
  useEffect(() => setA(access.data), [access.data]);
  if (!a) return <div className="card">{access.error || "Loading…"}</div>;

  return (
    <div className="grid">
      <section className="card">
        <h2>Who can play</h2>
        <div className="seg" role="radiogroup" aria-label="Who can play">
          <button type="button" role="radio" aria-checked={!a.open} className={!a.open ? "on" : ""} onClick={() => setA({ ...a, open: false })}>
            Venue only
          </button>
          <button type="button" role="radio" aria-checked={Boolean(a.open)} className={a.open ? "on" : ""} onClick={() => setA({ ...a, open: true })}>
            Anyone
          </button>
        </div>
        <p className="muted small-print">
          {a.open
            ? "Anyone with the link can play, from anywhere (mobile data, home). Turn on the venue PIN below to keep it to people who know it. The admin page still follows its own setting."
            : "Players must be on the venue's internet, an extra venue address, or the whitelist."}
        </p>
        <label className="check">
          <input type="checkbox" checked={a.autoVenueIp} onChange={(e) => setA({ ...a, autoVenueIp: e.target.checked })} />
          Allow the venue's own internet connection (detected automatically, IPv4 + IPv6)
        </label>
        <label className="check">
          <input type="checkbox" checked={a.pinEnabled} onChange={(e) => setA({ ...a, pinEnabled: e.target.checked })} />
          Require a venue PIN
        </label>
        {a.pinEnabled && (
          <label>
            PIN (4-8 digits)
            <input inputMode="numeric" value={a.pin} onChange={(e) => setA({ ...a, pin: e.target.value.replace(/\D/g, "").slice(0, 8) })} />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={a.adminRemote} onChange={(e) => setA({ ...a, adminRemote: e.target.checked })} />
          Allow this admin page from outside the venue (still needs the password)
        </label>
        <h3 className="sub-head">Extra venue addresses</h3>
        <p className="muted small-print">An IP or range counted as "the venue", e.g. a second internet line (203.0.113.0/24). Add several at once with commas or spaces.</p>
        {a.venueCidrs.map((c) => (
          <div className="row" key={c}>
            <b>{c}</b>
            <button className="danger" onClick={() => setA({ ...a, venueCidrs: a.venueCidrs.filter((x) => x !== c) })}>
              Remove
            </button>
          </div>
        ))}
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const add = venueRange.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
            if (!add.length) return;
            setA({ ...a, venueCidrs: [...new Set([...a.venueCidrs, ...add])] });
            setVenueRange("");
          }}
        >
          <input placeholder="IP or range" value={venueRange} onChange={(e) => setVenueRange(e.target.value)} aria-label="Venue IP or range" />
          <button type="submit" disabled={!venueRange.trim()}>
            Add
          </button>
        </form>
        {a.venueCidrs.length > 0 && <p className="muted small-print">Save access below to keep changes.</p>}
      </section>

      <section className="card">
        <h2>Whitelist</h2>
        {a.whitelist.map((w, i) => (
          <div className="row" key={i}>
            <div>
              <b>{w.cidr}</b>
              <small>
                {w.label}
                {w.expiresAt ? ` · until ${new Date(w.expiresAt).toLocaleString()}` : ""}
              </small>
            </div>
            <button className="danger" onClick={() => setA({ ...a, whitelist: a.whitelist.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        <div className="inline">
          <input placeholder="IP or range" value={cidr} onChange={(e) => setCidr(e.target.value)} />
          <input placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button
            disabled={!cidr}
            onClick={() => {
              setA({ ...a, whitelist: [...a.whitelist, { cidr: cidr.trim(), label: label || undefined }] });
              setCidr("");
              setLabel("");
            }}
          >
            Add
          </button>
        </div>
      </section>

      <div className="wide">
        {access.error && <p className="error">{access.error}</p>}
        <button className="primary big" disabled={busy} onClick={() => run(() => api.saveAccess(a))}>
          Save access
        </button>
      </div>
    </div>
  );
}
