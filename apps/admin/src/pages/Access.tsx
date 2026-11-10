import { useEffect, useState } from "react";
import { api, type Access } from "../api";
import { useAction, useLoad } from "../useLoad";

export function AccessPage() {
  const access = useLoad(api.access);
  const { busy, run } = useAction(access.reload, access.setError);
  const [a, setA] = useState<Access | undefined>();
  const [cidr, setCidr] = useState("");
  const [label, setLabel] = useState("");
  useEffect(() => setA(access.data), [access.data]);
  if (!a) return <div className="card">{access.error || "Loading…"}</div>;

  return (
    <div className="grid">
      <section className="card">
        <h2>Who can play</h2>
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
        <label>
          Extra venue ranges (one per line, e.g. 203.0.113.0/24)
          <textarea rows={3} value={a.venueCidrs.join("\n")} onChange={(e) => setA({ ...a, venueCidrs: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} />
        </label>
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
