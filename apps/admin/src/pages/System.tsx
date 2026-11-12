import { useEffect, useRef, useState } from "react";
import { bgUrl } from "@bargames/sdk";
import { api, type SystemStats } from "../api";

const gb = (b?: number) => (b === undefined ? "?" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const ago = (sec: number) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const level = (pct?: number, warn = 75, bad = 90) => (pct === undefined ? "" : pct >= bad ? "error" : pct >= warn ? "warn" : "ok");

function Bar({ pct }: { pct?: number }) {
  return (
    <div className="bar">
      <div className={`fill ${level(pct)}`} style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
    </div>
  );
}

/** Box health, refreshed every 5 s, and the Reboot button. */
export function SystemPage() {
  const [s, setS] = useState<SystemStats | undefined>();
  const [error, setError] = useState("");
  const [rebooting, setRebooting] = useState("");
  const prevNet = useRef<{ at: number; rx: number; tx: number } | undefined>();
  const [rate, setRate] = useState<{ rx: number; tx: number } | undefined>();

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.systemStats().then(
        (x) => {
          if (!alive) return;
          setS(x);
          setError("");
          const rx = (x.network ?? []).reduce((n, i) => n + i.rxBytes, 0);
          const tx = (x.network ?? []).reduce((n, i) => n + i.txBytes, 0);
          const at = Date.parse(x.at);
          const p = prevNet.current;
          if (p && at > p.at) setRate({ rx: ((rx - p.rx) * 8) / ((at - p.at) / 1000), tx: ((tx - p.tx) * 8) / ((at - p.at) / 1000) });
          prevNet.current = { at, rx, tx };
        },
        (e: Error) => alive && setError(e.message),
      );
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const reboot = async () => {
    const what = [
      s?.box.openRooms ? `${s.box.openRooms} open room(s) will close` : "",
      s?.casting?.tvs ? `${s.casting.tvs} TV(s) stop casting until the box is back` : "",
    ].filter(Boolean);
    if (!window.confirm(`Reboot the box now? It takes a minute or two.${what.length ? `\n\n${what.join("\n")}` : ""}\n\nTVs with a startup choice come back on it by themselves.`)) return;
    try {
      const r = await api.reboot();
      setRebooting(r.message ?? "Rebooting…");
      // Wait for it to go down, then come back.
      const started = Date.now();
      let wentDown = false;
      const poll = setInterval(() => {
        fetch(bgUrl("/health"), { cache: "no-store" })
          .then((x) => {
            if (x.ok && (wentDown || Date.now() - started > 90_000)) {
              clearInterval(poll);
              setRebooting("");
              window.location.reload();
            }
          })
          .catch(() => (wentDown = true));
      }, 3000);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (rebooting) return <section className="card wide"><h2>Rebooting</h2><p>{rebooting}</p></section>;
  if (!s) return <div className="card">{error || "Loading…"}</div>;
  const h = s.host;
  const hot = h.temps.reduce((m, t) => Math.max(m, t.celsius), 0);

  return (
    <div className="grid">
      <section className="card">
        <h2>Box</h2>
        <p className="muted">
          {h.hostname} · Bar Games {s.box.version} · up {ago(h.uptimeSec)} (services {ago(s.box.coreUptimeSec)})
        </p>
        <p className="muted">
          {h.cpuModel} · {h.cores} threads
        </p>
        <p>
          {s.box.games} game(s)/app(s) on · {s.box.openRooms} open room(s) · {s.casting ? `${s.casting.streaming}/${s.casting.tvs} TV(s) casting` : "casting service not answering"}
        </p>
      </section>

      <section className="card">
        <h2>CPU</h2>
        <p>
          {h.cpuPercent === undefined ? "measuring…" : `${h.cpuPercent}%`} · load {h.load.map((x) => x.toFixed(2)).join(" / ")}
        </p>
        <Bar pct={h.cpuPercent} />
        {h.gpu && (
          <p className="muted">
            Graphics (encoder) clock: {h.gpu.curMhz} of {h.gpu.maxMhz} MHz
          </p>
        )}
      </section>

      <section className="card">
        <h2>Memory and disk</h2>
        <p>
          Memory: {gb(h.memory.totalBytes - h.memory.availableBytes)} of {gb(h.memory.totalBytes)} ({h.memory.usedPercent}%)
        </p>
        <Bar pct={h.memory.usedPercent} />
        {h.disk && (
          <>
            <p>
              Disk: {gb(h.disk.totalBytes - h.disk.freeBytes)} of {gb(h.disk.totalBytes)} ({h.disk.usedPercent}%), {gb(h.disk.freeBytes)} free
            </p>
            <Bar pct={h.disk.usedPercent} />
          </>
        )}
      </section>

      <section className="card">
        <h2>Temperatures</h2>
        {h.temps.length ? (
          <ul className="plain">
            {h.temps.map((t) => (
              <li key={t.label} className={level(t.celsius, 80, 95)}>
                {t.label}: {t.celsius} °C
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No sensors found.</p>
        )}
        {hot >= 90 && <p className="error">Running hot: check the box's airflow.</p>}
      </section>

      <section className="card">
        <h2>Network</h2>
        {rate && (
          <p>
            Now: ↓ {(rate.rx / 1e6).toFixed(1)} Mbps · ↑ {(rate.tx / 1e6).toFixed(1)} Mbps
          </p>
        )}
        <ul className="plain">
          {(s.network ?? []).map((i) => (
            <li key={i.name}>
              {i.name}: ↓ {gb(i.rxBytes)} · ↑ {gb(i.txBytes)} since boot
            </li>
          ))}
        </ul>
      </section>

      <section className="card wide">
        <h2>Containers</h2>
        {s.containers ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>CPU</th>
                <th>Memory</th>
              </tr>
            </thead>
            <tbody>
              {s.containers.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className={c.state === "running" ? "" : "warn"}>{c.status || c.state}</td>
                  <td>{c.cpuPercent === undefined ? "" : `${c.cpuPercent}%`}</td>
                  <td>{c.memBytes === undefined ? "" : gb(c.memBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Container stats are only available on a box.</p>
        )}
      </section>

      <section className="card wide">
        <h2>Bar Games version</h2>
        <p>
          Installed: <b>{s.box.version}</b>
          {s.box.latest ? (
            <>
              {" "}
              · latest release: <b>{s.box.latest}</b>
            </>
          ) : (
            " · latest release: unknown (no internet?)"
          )}
        </p>
        {s.update?.running ? (
          <p className="warn">Updating… the box restarts its services; this page reconnects by itself.</p>
        ) : s.box.version === "dev" ? (
          <p className="muted">This box runs from source (development). Switch it to releases once with: bgctl self-update</p>
        ) : s.box.latest && s.box.latest !== s.box.version ? (
          s.update?.available ? (
            <button
              className="primary"
              onClick={() => {
                const what = [s.box.openRooms ? `${s.box.openRooms} open room(s) will close` : "", s.casting?.tvs ? "TVs pause for a moment" : ""].filter(Boolean);
                const nl = String.fromCharCode(10);
                if (!window.confirm(`Update Bar Games from ${s.box.version} to ${s.box.latest}?${what.length ? nl + nl + what.join(nl) : ""}${nl}${nl}A snapshot is taken first; a failed update rolls back by itself.`)) return;
                void api.updateBox(s.box.latest).then(
                  (r) => setRebooting(r.message ?? "Updating…"),
                  (e: Error) => setError(e.message),
                );
              }}
            >
              Update to {s.box.latest}
            </button>
          ) : (
            <p className="warn">An update is available. This box can't update itself yet: once, on the box, run sudo ~/bargames/deploy/host/install.sh</p>
          )
        ) : (
          <p className="ok">Up to date.</p>
        )}
        {s.update?.lastExit !== undefined && !s.update.running && (
          <details>
            <summary className={s.update.lastExit === 0 ? "ok" : "error"}>Last update: {s.update.lastExit === 0 ? "succeeded" : "failed (rolled back)"}</summary>
            <pre className="note">{(s.update.logTail ?? []).join(String.fromCharCode(10))}</pre>
          </details>
        )}
      </section>

      <section className="card wide">
        <h2>Reboot</h2>
        <p className="muted">Restarts the whole box. Open rooms close; TVs come back on their startup choices.</p>
        {s.reboot.available ? (
          <button className="danger" onClick={() => void reboot()}>
            Reboot the box
          </button>
        ) : (
          <p className="warn">This box can't reboot itself yet. Once, on the box: sudo ~/bargames/deploy/host/install.sh</p>
        )}
        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}
