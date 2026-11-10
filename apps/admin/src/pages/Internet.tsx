import { useEffect, useState } from "react";
import { api, type CfHost, type CfStatus, type CfZone } from "../api";
import { useAction, useLoad } from "../useLoad";

const PATTERNS = ["{game}.{domain}", "{game}-{venue}.{domain}", "{game}.internal.{domain}", "{game}.{venue}.{domain}"];
const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * Cloudflare setup, as a guided walk-through:
 * 1 domain in Cloudflare · 2 API token · 3 pick domain + addresses · 4 connect · status.
 */
export function InternetPage() {
  const st = useLoad(api.cloudflare, 15_000);
  if (!st.data) return <div className="card">{st.error || "Loading…"}</div>;
  return st.data.connected ? <Connected status={st.data} reload={st.reload} /> : <Wizard status={st.data} reload={st.reload} />;
}

function Wizard({ status, reload }: { status: CfStatus; reload: () => unknown }) {
  const [error, setError] = useState("");
  const { busy, run } = useAction(reload, setError);
  const [token, setToken] = useState("");
  const [zones, setZones] = useState<CfZone[]>();
  const [zoneId, setZoneId] = useState("");
  const [pattern, setPattern] = useState("{game}.{domain}");
  const [adminRemote, setAdminRemote] = useState(false);
  const [plan, setPlan] = useState<{ hosts: CfHost[]; warnings: string[] }>();

  // A saved token: load its domains straight away.
  useEffect(() => {
    if (status.hasToken && !zones) api.cloudflareZones().then(setZones).catch((e: Error) => setError(e.message));
  }, [status.hasToken, zones]);
  useEffect(() => {
    if (zones?.length === 1) setZoneId(zones[0].id);
  }, [zones]);
  useEffect(() => {
    setPlan(undefined);
    if (!zoneId) return;
    api.cloudflarePlan(zoneId, pattern).then(setPlan).catch((e: Error) => setError(e.message));
  }, [zoneId, pattern]);

  const conflicts = plan?.hosts.filter((h) => h.status === "conflict") ?? [];

  return (
    <div className="grid">
      <section className="card wide">
        <h2>Put the games online with Cloudflare</h2>
        <p>
          Guests reach the games at addresses on your own domain (like <b>play.yourbar.com</b>). The box makes a private Cloudflare Tunnel, so nothing on
          your router needs opening, and only people on the venue's Wi-Fi (or with the venue PIN) get in. You need a free Cloudflare account and a
          domain. This takes about five minutes.
        </p>
      </section>

      <section className="card">
        <h2>1 · Your domain in Cloudflare</h2>
        <ol className="steps">
          <li>
            Sign in at <a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer">dash.cloudflare.com</a> (or create a free account).
          </li>
          <li>
            If your domain isn't there yet: <b>Add a domain</b>, choose the <b>Free</b> plan, then change the domain's nameservers at your registrar
            (GoDaddy, Namecheap…) to the two Cloudflare shows you.
          </li>
          <li>Wait until Cloudflare shows the domain as <b>Active</b>. That's usually minutes, sometimes a few hours.</li>
        </ol>
        <p className="muted">Already using the domain for a website or email? That's fine. The box only adds its own addresses and never changes your existing records.</p>
      </section>

      <section className="card">
        <h2>2 · An API token for the box {status.hasToken && <small>✓ saved ({status.tokenHint})</small>}</h2>
        <ol className="steps">
          <li>
            Open <a href={TOKEN_URL} target="_blank" rel="noreferrer">My Profile → API Tokens</a> and click <b>Create Token</b>, then{" "}
            <b>Create Custom Token</b> (at the bottom).
          </li>
          <li>Name it <code>Bar Games box</code>.</li>
          <li>
            Add these three permissions (click <b>+ Add more</b> between them):
            <table className="perm">
              <tbody>
                <tr><td>Account</td><td>Cloudflare Tunnel</td><td>Edit</td></tr>
                <tr><td>Zone</td><td>DNS</td><td>Edit</td></tr>
                <tr><td>Zone</td><td>Zone</td><td>Read</td></tr>
              </tbody>
            </table>
          </li>
          <li>
            <b>Account Resources:</b> Include → your account. <b>Zone Resources:</b> Include → Specific zone → your domain.
          </li>
          <li>
            Click <b>Continue to summary</b> → <b>Create Token</b>, copy it (Cloudflare shows it only once) and paste it here.
          </li>
        </ol>
        <div className="inline">
          <input type="password" placeholder={status.hasToken ? "Paste a new token to replace it" : "Paste the API token"} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          <button
            className="primary"
            disabled={busy || !token}
            onClick={() =>
              run(async () => {
                setZones((await api.cloudflareToken(token)).zones);
                setToken("");
              })
            }
          >
            Check token
          </button>
        </div>
        <p className="muted">The token is stored only on this box and is never shown again.</p>
      </section>

      {zones && (
        <section className="card wide">
          <h2>3 · Domain and addresses</h2>
          <div className="inline">
            <label>
              Domain
              <select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                <option value="">Choose…</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                    {z.status !== "active" ? ` (${z.status})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Address style
              <select value={pattern} onChange={(e) => setPattern(e.target.value)}>
                {PATTERNS.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
          </div>
          {plan && (
            <>
              <p>The box will use these addresses:</p>
              <ul className="hosts">
                {plan.hosts.map((h) => (
                  <li key={h.host} className={h.status === "conflict" ? "error" : ""}>
                    <b>{h.host}</b> {h.status === "ok" ? "✓ already set up" : h.status === "create" ? "· will be created" : `✗ ${h.detail}`}
                  </li>
                ))}
              </ul>
              {plan.warnings.map((w) => (
                <p key={w} className="warn">
                  {w}
                </p>
              ))}
              {conflicts.length > 0 && (
                <p className="warn">
                  Some names are already used on your domain. Pick another address style, or rename the admin/landing page labels on the Venue tab. You can
                  connect anyway; those addresses just won't work until fixed.
                </p>
              )}
              <label className="switch">
                <input type="checkbox" checked={adminRemote} onChange={(e) => setAdminRemote(e.target.checked)} />
                Let staff open the admin page from outside the venue (it still needs the admin password)
              </label>
            </>
          )}
        </section>
      )}

      {plan && (
        <div className="wide">
          <h2>4 · Connect</h2>
          <button className="primary big" disabled={busy} onClick={() => run(() => api.cloudflareConnect(zoneId, pattern, adminRemote))}>
            {busy ? "Connecting… (creating the tunnel and addresses)" : "Connect to Cloudflare"}
          </button>
        </div>
      )}
      {error && <p className="error wide">{error}</p>}
    </div>
  );
}

function Connected({ status, reload }: { status: CfStatus; reload: () => unknown }) {
  const [error, setError] = useState("");
  const { busy, run } = useAction(reload, setError);
  const healthy = status.tunnel?.status === "healthy";
  const sync = status.lastSync;
  return (
    <div className="grid">
      <section className="card">
        <h2>
          <span className={`dot ${healthy ? "on" : "warn"}`} /> Online via Cloudflare
        </h2>
        <p>
          Domain <b>{status.zone}</b> · account {status.account}
        </p>
        <p>
          Tunnel <b>{status.tunnel?.name}</b>: {status.tunnel?.status}
          {status.tunnel ? ` · ${status.tunnel.connections} connection${status.tunnel.connections === 1 ? "" : "s"}` : ""}
        </p>
        <p>Connector on this box: {status.connector}</p>
        {!healthy && (
          <p className="warn">
            Not healthy yet. Right after connecting this takes up to a minute. If it stays this way, check that the box has internet access.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Addresses {sync && <small>checked {new Date(sync.at).toLocaleTimeString()}</small>}</h2>
        <ul className="hosts">
          {(sync?.hosts ?? []).map((h) => (
            <li key={h.host} className={h.status === "conflict" ? "error" : ""}>
              {h.status === "ok" ? (
                <a href={`https://${h.host}`} target="_blank" rel="noreferrer">
                  {h.host}
                </a>
              ) : (
                <b>{h.host}</b>
              )}{" "}
              {h.status === "ok" ? "✓" : `✗ ${h.detail ?? ""}`}
            </li>
          ))}
        </ul>
        {sync?.errors.map((e) => (
          <p key={e} className="error">
            {e}
          </p>
        ))}
        <p className="muted">New games and renamed addresses are added automatically within a few seconds.</p>
        <button disabled={busy} onClick={() => run(api.cloudflareSync)}>
          Check again
        </button>
      </section>

      <section className="card wide">
        <h2>Disconnect</h2>
        <p className="muted">
          Stops the tunnel and removes the addresses the box created. Your other records on {status.zone} are not touched. Games stay reachable on the
          venue network at this box's IP.
        </p>
        <button
          className="danger"
          disabled={busy}
          onClick={() => confirm(`Take the games offline and remove the box's addresses from ${status.zone}?`) && run(api.cloudflareDisconnect)}
        >
          Disconnect from Cloudflare
        </button>
      </section>
      {error && <p className="error wide">{error}</p>}
    </div>
  );
}
