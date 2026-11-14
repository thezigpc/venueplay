// Settings → Smart home: integrations (SDK 0.12.0) such as Matter (Alexa, Google Home,
// Apple Home) and Home Assistant. Each is its own module: installed from its repo, turned on
// with the venue's approval of what it asks for, updated and removed on its own.

import { useState } from "react";
import { api, type Integration } from "../api";
import { useLoad } from "../useLoad";

export function SmartHomePage() {
  const list = useLoad(api.integrations, 5000);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const items = list.data?.integrations ?? [];

  const install = async () => {
    setBusy(true);
    setNote("");
    try {
      const r = await api.install(url.trim());
      if (r.game.manifest.kind !== "integration") setNote(`${r.game.manifest.name} is a game or app, not an integration: it's under Games & apps.`);
      else setNote(`${r.upgraded ? "Updated" : "Added"} ${r.game.manifest.name} ${r.game.manifest.version}. Turn it on below.`);
      setUrl("");
      await list.reload();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-gap">
      <p className="muted">Connect the box to Alexa, Google Home, Apple Home or Home Assistant, so they can run your scenes and switch your TVs. Each connection is its own module: turn it on, update it or remove it without touching the rest of the box.</p>
      {list.error && <p className="error">{list.error}</p>}
      {list.data && !items.length && <p className="muted">Nothing connected yet. Add a connection with its GitHub address below.</p>}
      {items.map((i) => (
        <IntegrationCard key={i.id} item={i} reload={list.reload} />
      ))}
      <section className="card stack-gap">
        <h2>Add a connection</h2>
        <div className="inline">
          <input placeholder="https://github.com/owner/integration" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Integration repo address" autoCapitalize="none" />
          <button className="primary" disabled={!url.trim() || busy} onClick={() => void install()}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
        {note && <p className="muted">{note}</p>}
      </section>
    </div>
  );
}

function statusOf(i: Integration): { dot: "on" | "off" | "warn"; text: string } {
  if (!i.enabled) return { dot: "off", text: "Off" };
  if (i.state !== "running") return { dot: "warn", text: i.state === "unknown" ? "Starting…" : `Not running (${i.state})` };
  const r = i.report;
  if (!r) return { dot: "warn", text: i.connected ? "Connected to the box" : "Starting…" };
  const dot = r.state === "ok" ? "on" : r.state === "setup" ? "warn" : r.state === "warn" ? "warn" : "off";
  return { dot, text: r.message || { ok: "Working", setup: "Waiting for setup", warn: "Needs a look", error: "Not working" }[r.state] };
}

function IntegrationCard({ item: i, reload }: { item: Integration; reload: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const st = statusOf(i);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
      if (done) setMsg(done);
      setAsking(false);
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (on: boolean) => {
    if (on && i.needsApproval.length) return setAsking(true);
    void act(() => api.enableIntegration(i.id, on));
  };
  const upd = i.update?.available && i.update.latest ? i.update : undefined;

  return (
    <section className={`card stack-gap integration${i.enabled ? "" : " off"}`}>
      <div className="game-row">
        <span className="game-icon" aria-hidden="true">
          {i.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="game-main">
          <b>{i.name}</b> <span className="muted">{i.version}</span>
          <div className="muted game-sub">
            <span className={`dot ${st.dot}`} /> {st.text}
          </div>
        </div>
        {upd && <span className="pill warn">Update ready</span>}
        <label className="toggle" title={i.enabled ? "On" : "Off"}>
          <input type="checkbox" role="switch" checked={i.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} aria-label={`${i.name} is ${i.enabled ? "on" : "off"}`} />
          <span aria-hidden="true" />
        </label>
      </div>
      {i.description && <p className="muted">{i.description}</p>}

      {(asking || (i.enabled && i.needsApproval.length > 0)) && (
        <div className="approve stack-gap">
          <b>{i.enabled ? `The new version of ${i.name} also asks to:` : `${i.name} asks to:`}</b>
          <ul>
            {i.permissions
              .filter((p) => (i.enabled ? i.needsApproval.includes(p.id) : true))
              .map((p) => (
                <li key={p.id}>{p.text}</li>
              ))}
          </ul>
          {i.blocked.length > 0 ? (
            <p className="warn">It wants to use the venue network directly, which the box only allows for connections from a trusted source ({i.source}).</p>
          ) : (
            <div className="inline">
              <button className="primary" disabled={busy} onClick={() => void act(() => (i.enabled ? api.approveIntegration(i.id) : api.enableIntegration(i.id, true, true)))}>
                {i.enabled ? "Allow" : "Allow and turn on"}
              </button>
              {!i.enabled && (
                <button type="button" disabled={busy} onClick={() => setAsking(false)}>
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {i.enabled && i.report?.pairing && <Pairing item={i} />}
      {i.enabled && (i.report?.details?.length ?? 0) > 0 && (
        <dl className="details">
          {i.report!.details!.map((d) => (
            <div key={d.label}>
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {i.settings.length > 0 && <SettingsForm item={i} reload={reload} />}

      <div className="buttons">
        {i.enabled &&
          (i.report?.actions ?? []).map((a) => (
            <button key={a.id} type="button" disabled={busy || !i.connected} onClick={() => (!a.confirm || window.confirm(a.confirm)) && void act(() => api.integrationAction(i.id, a.id), `Sent: ${a.label}.`)}>
              {a.label}
            </button>
          ))}
        {upd && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => window.confirm(`Update ${i.name} from ${i.version} to ${upd.latest}?${i.enabled ? " It restarts, which takes a few seconds." : ""}`) && void act(() => api.updateGame(i.id), `Updated to ${upd.latest}.`)}
          >
            Update to {upd.latest}
          </button>
        )}
        <button className="danger" disabled={busy} onClick={() => window.confirm(`Remove ${i.name}? Its settings and pairings are kept, in case you add it again.`) && void act(() => api.removeGame(i.id))}>
          Remove
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}

function Pairing({ item: i }: { item: Integration }) {
  const p = i.report!.pairing!;
  // SDK 0.13.1: a code with an end time greys out once it's past (the page reloads every 5 s).
  const ends = p.expiresAt ? Date.parse(p.expiresAt) : NaN;
  const expired = Number.isFinite(ends) && ends <= Date.now();
  const minutesLeft = Number.isFinite(ends) && !expired ? Math.max(1, Math.ceil((ends - Date.now()) / 60_000)) : undefined;
  return (
    <div className={`pairing${expired ? " expired" : ""}`}>
      {p.qr && <img src={api.integrationQrUrl(i.id, i.reportAt)} alt={`Pairing QR code for ${i.name}${expired ? " (expired)" : ""}`} width={180} height={180} />}
      <div className="stack-gap">
        {expired && <p className="warn">This code has expired. Ask {i.name} for a new one (for example its "Pair another app" button).</p>}
        {minutesLeft !== undefined && <p className="muted">Works for about {minutesLeft} more minute{minutesLeft === 1 ? "" : "s"}.</p>}
        {p.note && <p>{p.note}</p>}
        {p.code && (
          <p>
            Or type this code: <b className="pair-code">{p.code.replace(/^(\d{4})(\d{3})(\d{4})$/, "$1-$2-$3")}</b>
          </p>
        )}
      </div>
    </div>
  );
}

function SettingsForm({ item: i, reload }: { item: Integration; reload: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const missing = i.settings.filter((s) => s.required && !s.set);
  const changed = Object.keys(values).length > 0;
  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      await api.integrationSettings(i.id, values);
      setValues({});
      setMsg(i.enabled ? "Saved; it restarted with them." : "Saved.");
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="stream-settings" open={missing.length > 0}>
      <summary>Settings{missing.length ? ` (${missing.length} to fill in)` : ""}</summary>
      {i.settings.map((s) => (
        <label key={s.name}>
          {s.label}
          {s.required ? "" : " (optional)"}
          <input
            type={s.secret ? "password" : "text"}
            autoComplete="off"
            autoCapitalize="none"
            placeholder={s.secret && s.set ? "Saved (type to replace)" : s.placeholder}
            value={values[s.name] ?? (s.secret ? "" : (s.value ?? ""))}
            onChange={(e) => setValues({ ...values, [s.name]: e.target.value })}
          />
          {s.help && <small className="muted">{s.help}</small>}
        </label>
      ))}
      <div className="inline">
        <button className="primary" disabled={busy || !changed} onClick={() => void save()}>
          Save
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </details>
  );
}
