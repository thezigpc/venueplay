// Box Wi-Fi: the box's own connection (not the venue's guest Wi-Fi on the placards).
// Saved networks are joined whenever they're in range; the cable stays preferred, so the
// box can be carried to a venue without a cable and still come online by itself.

import { useState } from "react";
import { api, type WifiAdapter, type WifiSeen, type WifiView } from "../api";
import { useAction, useLoad } from "../useLoad";

/** dBm → 0-4 bars. */
const bars = (dbm?: number) => (dbm === undefined ? 0 : dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -72 ? 2 : dbm >= -80 ? 1 : 0);
const signalText = (dbm?: number) => (dbm === undefined ? "" : ["very weak", "weak", "fair", "good", "strong"][bars(dbm)]);

function Bars({ dbm }: { dbm?: number }) {
  const n = bars(dbm);
  return (
    <span className="wifi-bars" aria-label={`signal ${signalText(dbm)}`} title={dbm !== undefined ? `${dbm} dBm` : undefined}>
      {[1, 2, 3, 4].map((i) => (
        <i key={i} className={i <= n ? "on" : ""} style={{ height: `${i * 25}%` }} />
      ))}
    </span>
  );
}

export function WifiPage() {
  const wifi = useLoad(api.wifi, 4000);
  const { busy, run } = useAction(wifi.reload, wifi.setError);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [hidden, setHidden] = useState(false);
  const [show, setShow] = useState(false);
  const [scanAsked, setScanAsked] = useState(0);
  const w = wifi.data;
  if (!w) return <div className="card">{wifi.error || "Loading…"}</div>;

  if (!w.available) {
    return (
      <div className="card">
        <h2>Not set up on this box yet</h2>
        <p className="muted">
          The box manages Wi-Fi through a small helper on the host. Update the box from <b>Settings › Box and updates</b>, or run <code>sudo deploy/host/install.sh</code> on it once.
        </p>
      </div>
    );
  }

  const st = w.status;
  const adapter: WifiAdapter | undefined = st?.adapters?.[0];
  const cable = st?.cables?.find((c) => c.plugged) ?? st?.cables?.[0];
  const viaWifi = Boolean(adapter && st?.internetVia === adapter.name);
  const viaCable = Boolean(cable && st?.internetVia === cable.name);
  const seen = new Map<string, WifiSeen>((st?.scan?.networks ?? []).map((n) => [n.ssid, n]));
  const savedNames = new Set(w.networks.map((n) => n.ssid));
  const scanning = scanAsked > 0 && Date.now() - scanAsked < 30_000 && !(Date.parse(st?.scan?.at ?? "") >= scanAsked - 2000);

  const forget = (name: string) => {
    const onIt = adapter?.ssid === name && !cable?.plugged;
    if (onIt && !window.confirm(`The box is online through "${name}" right now and has no cable. Removing it disconnects the box, and this page with it. Remove anyway?`)) return;
    void run(() => api.forgetWifi(name));
  };

  return (
    <div className="grid">
      <section className="card">
        <h2>Right now</h2>
        {!st ? (
          <p className="muted">Checking…</p>
        ) : (
          <>
            <div className="row">
              <div>
                <b>Cable</b>
                <small>{cable ? (cable.plugged ? `Plugged in${cable.addresses[0] ? ` · ${cable.addresses[0]}` : ""}` : "Unplugged") : "No wired port found"}</small>
              </div>
              {viaCable && <span className="pill ok">Internet</span>}
            </div>
            <div className="row">
              <div>
                <b>Wi-Fi{adapter ? "" : ": no adapter"}</b>
                <small>
                  {!adapter
                    ? "This box has no Wi-Fi adapter."
                    : adapter.state === "connected"
                      ? `Connected to ${adapter.ssid}${adapter.band ? ` (${adapter.band})` : ""}${adapter.signal !== undefined ? ` · ${signalText(adapter.signal)} signal` : ""}${adapter.addresses[0] ? ` · ${adapter.addresses[0]}` : ""}`
                      : w.networks.length
                        ? adapter.state === "scanning" || adapter.state === "associating" || adapter.state === "authenticating"
                          ? "Looking for a saved network…"
                          : "Not connected: no saved network in range"
                        : "Off: no saved networks"}
                </small>
              </div>
              {adapter?.state === "connected" && <Bars dbm={adapter.signal} />}
              {viaWifi && <span className="pill ok">Internet</span>}
            </div>
            {!st.internetVia && <p className="error">The box has no internet connection right now.</p>}
            {st.apply && !st.apply.ok && <p className="error">Last change didn't apply: {st.apply.error}</p>}
          </>
        )}
        <p className="muted small-print">The cable is always preferred. When it's unplugged, the box uses whichever saved network is in range, and switches back when the cable returns.</p>
      </section>

      <section className="card">
        <h2>Saved networks</h2>
        {w.networks.length === 0 && <p className="muted">None yet. Save the networks of the venues you take the box to; it joins them by itself, even straight after it starts.</p>}
        {w.networks.map((n) => {
          const inRange = seen.get(n.ssid);
          const current = adapter?.state === "connected" && adapter.ssid === n.ssid;
          return (
            <div className="row" key={n.ssid}>
              <div>
                <b>{n.ssid}</b>
                <small>
                  {[current ? "connected" : inRange ? `in range · ${signalText(inRange.signal)}` : st?.scan?.at ? "not in range" : "", n.secured ? "password saved" : "open network", n.hidden ? "hidden" : ""].filter(Boolean).join(" · ")}
                </small>
              </div>
              <button className="danger" disabled={busy} onClick={() => forget(n.ssid)}>
                Remove
              </button>
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2>Add a network</h2>
        <div className="buttons">
          <button type="button" disabled={busy || scanning || !adapter} onClick={() => {
              setScanAsked(Date.now());
              void run(() => api.scanWifi());
            }}
          >
            {scanning ? "Scanning…" : "Scan for networks"}
          </button>
          {st?.scan?.at && <span className="muted small">Last scan {new Date(st.scan.at).toLocaleTimeString()}</span>}
        </div>
        {st?.scan?.error && <p className="error">{st.scan.error}</p>}
        {(st?.scan?.networks?.length ?? 0) > 0 && (
          <div className="wifi-seen">
            {st!.scan!.networks!.slice(0, 15).map((n) => (
              <button
                type="button"
                key={n.ssid}
                className={`chip${ssid === n.ssid ? " on" : ""}`}
                disabled={n.enterprise}
                title={n.enterprise ? "Needs a username (enterprise Wi-Fi): not supported" : `${n.band} · ${n.signal} dBm`}
                onClick={() => {
                  setSsid(n.ssid);
                  setHidden(false);
                }}
              >
                <Bars dbm={n.signal} /> {n.ssid}
                {n.secure ? " 🔒" : ""}
                {savedNames.has(n.ssid) ? " · saved" : ""}
              </button>
            ))}
          </div>
        )}
        <form
          className="wifi-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.saveWifi({ ssid, password, hidden });
              setSsid("");
              setPassword("");
              setHidden(false);
              setShow(false);
            });
          }}
        >
          <label>
            Network name
            <input value={ssid} onChange={(e) => setSsid(e.target.value)} maxLength={32} autoComplete="off" spellCheck={false} />
          </label>
          <label>
            Password
            <span className="inline">
              <input type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="Leave empty for an open network" />
              <button type="button" onClick={() => setShow(!show)}>
                {show ? "Hide" : "Show"}
              </button>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            Hidden network (doesn't show up in a scan)
          </label>
          {seen.get(ssid)?.secure && !password && <p className="muted small-print">This network needs a password.</p>}
          <button type="submit" className="primary" disabled={busy || !ssid || (password.length > 0 && password.length < 8)}>
            {savedNames.has(ssid) ? "Update network" : "Save network"}
          </button>
        </form>
        <p className="muted small-print">WPA2/WPA3 password or open networks. Networks that need a username, or a sign-in page (hotel-style), won't work.</p>
      </section>

      {wifi.error && <p className="error wide">{wifi.error}</p>}
    </div>
  );
}

/** One line for the Settings hub. */
export function wifiSummary(w?: WifiView): string {
  if (!w) return "…";
  if (!w.available) return "Not set up on this box";
  const a = w.status?.adapters?.[0];
  const n = w.networks.length;
  const saved = `${n} saved network${n === 1 ? "" : "s"}`;
  if (a?.state === "connected") return `${w.status?.internetVia === a.name ? "Online through" : "Connected to"} ${a.ssid} · ${saved}`;
  return n ? `Cable · ${saved}` : "Cable only · no saved networks";
}
