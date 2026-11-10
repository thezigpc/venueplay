import { useState } from "react";
import { api, type Display } from "../api";
import { useAction, useLoad } from "../useLoad";

export function DisplaysPage() {
  const displays = useLoad(api.displays, 15_000);
  const { busy, run } = useAction(displays.reload, displays.setError);
  const [host, setHost] = useState("");
  const [note, setNote] = useState("");

  return (
    <div className="grid">
      <section className="card wide">
        <h2>TVs</h2>
        <div className="buttons">
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await api.discover();
                setNote(`Found ${r.found} device(s).${r.errors.length ? ` Problems: ${r.errors.join("; ")}` : ""}`);
              })
            }
          >
            Find TVs
          </button>
          <input placeholder="Add Roku by IP" value={host} onChange={(e) => setHost(e.target.value)} />
          <button disabled={!host || busy} onClick={() => run(() => api.addRoku(host).then(() => setHost("")))}>
            Add
          </button>
        </div>
        {note && <p className="muted">{note}</p>}
        {displays.error && <p className="error">{displays.error}</p>}
      </section>
      {(displays.data ?? []).map((d) => (
        <DisplayCard key={d.id} d={d} busy={busy} run={run} />
      ))}
    </div>
  );
}

function DisplayCard({ d, busy, run }: { d: Display; busy: boolean; run: (fn: () => Promise<unknown>) => void }) {
  const [label, setLabel] = useState(d.label ?? "");
  const [group, setGroup] = useState(d.group ?? "");
  const [delivery, setDelivery] = useState(d.delivery ?? "");
  const online = d.health?.online;
  return (
    <section className="card">
      <h2>
        <span className={`dot ${online ? "on" : "off"}`} /> {d.label || d.name}
      </h2>
      <p className="muted">
        {d.model} · {d.isTv ? "TV" : "player"} · {d.health?.powerMode ?? (online ? "online" : "offline")}
      </p>
      {d.content && d.content.kind === "url" && <p className="muted">Showing: {d.content.url}</p>}
      <label>
        Name
        <input placeholder={d.name} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label>
        Group
        <input placeholder="e.g. main, patio" value={group} onChange={(e) => setGroup(e.target.value)} />
      </label>
      <label>
        Delivery
        <select value={delivery} onChange={(e) => setDelivery(e.target.value)}>
          <option value="">Auto ({d.capabilities?.delivery[0] ?? "none"})</option>
          {(d.capabilities?.delivery ?? []).map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <div className="buttons">
        <button className="primary" disabled={busy} onClick={() => run(() => api.patchDisplay(d.id, { label, group, delivery: delivery || undefined }))}>
          Save
        </button>
        {d.capabilities?.power && (
          <>
            <button disabled={busy} onClick={() => run(() => api.power(d.id, true))}>
              On
            </button>
            <button disabled={busy} onClick={() => run(() => api.power(d.id, false))}>
              Off
            </button>
          </>
        )}
      </div>
    </section>
  );
}
