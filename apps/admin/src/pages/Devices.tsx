// Settings → Connected devices (box 0.15.0): where the box's sound goes. The box's own jack
// and HDMI, Bluetooth speakers paired here, and TVs over AirPlay. Apps that play sound
// (music requests, game sounds) use these outputs; the venue picks the default and volumes.

import { useEffect, useRef, useState } from "react";
import { api, type AudioOutputView, type AudioSessionView, type BluetoothDevice, type Game } from "../api";
import { useLoad } from "../useLoad";

const KIND: Record<AudioOutputView["kind"], string> = { box: "Box", bluetooth: "Bluetooth", tv: "TV · AirPlay" };

export function DevicesPage() {
  const audio = useLoad(api.audio, 3000);
  const games = useLoad(api.games);
  const a = audio.data;
  const appName = (owner: string) => (owner === "admin" ? "Test sound" : (games.data?.find((g) => `app:${g.id}` === owner)?.context.game.displayName ?? owner.replace(/^app:/, "")));
  const soundApps = (games.data ?? []).filter((g) => g.manifest.audio?.play);

  return (
    <div className="stack-gap">
      <p className="muted">Where the box plays sound: its own audio jack, a screen plugged into it, Bluetooth speakers you pair here, and TVs over AirPlay. Apps that play sound, such as music requests, use these. You choose the default and the volume.</p>
      {audio.error && <p className="error">{audio.error}</p>}
      {a && !a.available && <p className="muted">This box has no sound outputs it can use.</p>}

      {a && a.available && (
        <section className="card stack-gap">
          <h2>Sound outputs</h2>
          {!a.outputs.length && <p className="muted">None found.</p>}
          {a.outputs.map((o) => (
            <OutputRow key={o.id} o={o} appName={appName} reload={audio.reload} />
          ))}
        </section>
      )}

      {a?.bluetooth && <BluetoothCard reload={audio.reload} />}

      <section className="card stack-gap">
        <h2>Apps that play sound</h2>
        {soundApps.length ? (
          <ul className="plain-list">
            {soundApps.map((g: Game) => (
              <li key={g.id}>
                <b>{g.context.game.displayName}</b> <span className="muted">{g.enabled ? "on" : "off"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None installed. Apps that want to play sound say so, and appear here.</p>
        )}
      </section>
    </div>
  );
}

function OutputRow({ o, appName, reload }: { o: AudioOutputView; appName: (owner: string) => string; reload: () => Promise<void> }) {
  const [volume, setVolume] = useState(o.volume);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setVolume(o.volume);
  }, [o.volume]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const changeVolume = (v: number) => {
    setVolume(v);
    dragging.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      dragging.current = false;
      void api.audioOutput(o.id, { volume: v }).catch((e: Error) => setMsg(e.message));
    }, 300);
  };
  const rename = () => {
    const name = window.prompt(`Name for ${o.name} (empty: back to "${o.name}")`, o.label ?? o.name);
    if (name !== null) void act(() => api.audioOutput(o.id, { label: name.trim() && name.trim() !== o.name ? name.trim() : null }));
  };
  const s: AudioSessionView | undefined = o.session && ["starting", "playing", "paused"].includes(o.session.state) ? o.session : undefined;

  return (
    <div className={`output-row${o.available ? "" : " off"}`}>
      <div className="game-row">
        <div className="game-main">
          <b>{o.label || o.name}</b> <span className="pill">{KIND[o.kind]}</span> {o.default && <span className="pill ok">Default</span>}
          <div className="muted game-sub">
            {o.label && <span>{o.name} · </span>}
            {o.detail}
          </div>
          {s && (
            <div className="game-sub">
              <span className={`dot ${s.state === "paused" ? "warn" : "on"}`} /> {s.state === "paused" ? "Paused" : "Playing"}: {s.title ? `${s.title}${s.artist ? ` · ${s.artist}` : ""}` : "sound"} <span className="muted">({appName(s.owner)})</span>
            </div>
          )}
        </div>
      </div>
      <div className="inline">
        <label className="volume">
          <span className="muted">Volume</span>
          <input type="range" min={0} max={100} step={5} value={volume} disabled={!o.available} onChange={(e) => changeVolume(Number(e.target.value))} aria-label={`Volume for ${o.label || o.name}`} />
          <span className="volume-value">{volume}</span>
        </label>
      </div>
      <div className="buttons">
        <button type="button" disabled={busy || !o.available} onClick={() => void act(() => api.audioTest(o.id))}>
          Test sound
        </button>
        {s && (
          <button type="button" disabled={busy} onClick={() => void act(() => api.audioStop(s.id))}>
            Stop
          </button>
        )}
        {!o.default && (
          <button type="button" disabled={busy} onClick={() => void act(() => api.audioOutput(o.id, { default: true }))}>
            Make default
          </button>
        )}
        <button type="button" disabled={busy} onClick={rename}>
          Rename
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

function BluetoothCard({ reload: reloadOutputs }: { reload: () => Promise<void> }) {
  const [scanUntil, setScanUntil] = useState(0);
  const scanning = Date.now() < scanUntil;
  const bt = useLoad(api.bluetooth, scanning ? 2500 : 8000);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!scanning) return;
    const t = setTimeout(() => setTick((n) => n + 1), scanUntil - Date.now() + 100);
    return () => clearTimeout(t);
  }, [scanning, scanUntil]);

  const status = bt.data?.status;
  const devices = bt.data?.devices ?? [];
  const paired = devices.filter((d) => d.paired && d.audio);
  const nearby = devices.filter((d) => !d.paired && (d.audio || showAll)).sort((x, y) => (y.rssi ?? -999) - (x.rssi ?? -999));
  const others = devices.filter((d) => !d.paired && !d.audio).length;

  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setMsg("");
    try {
      await fn();
      if (done) setMsg(done);
      await Promise.all([bt.reload(), reloadOutputs()]);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const scan = () => act("scan", async () => setScanUntil(Date.now() + (await api.bluetoothScan()).seconds * 1000));

  return (
    <section className="card stack-gap">
      <h2>Bluetooth speakers</h2>
      {bt.error && <p className="error">{bt.error}</p>}
      {status && !status.available && <p className="warn">{status.message ?? "Bluetooth isn't working on this box."}</p>}
      {status?.available && (
        <>
          {paired.length ? (
            paired.map((d) => (
              <div key={d.address} className="game-row">
                <div className="game-main">
                  <b>{d.name}</b>
                  <div className="muted game-sub">
                    <span className={`dot ${d.connected ? "on" : "off"}`} /> {d.connected ? "Connected" : "Not connected (the box connects when it plays)"}
                    {jobText(d) && ` · ${jobText(d)}`}
                  </div>
                </div>
                <div className="buttons">
                  {d.connected ? (
                    <button type="button" disabled={Boolean(busy)} onClick={() => void act(d.address, () => api.bluetoothAction(d.address, "disconnect"))}>
                      Disconnect
                    </button>
                  ) : (
                    <button type="button" disabled={Boolean(busy)} onClick={() => void act(d.address, () => api.bluetoothAction(d.address, "connect"), `Connected to ${d.name}.`)}>
                      {busy === d.address ? "Connecting…" : "Connect"}
                    </button>
                  )}
                  <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => window.confirm(`Forget ${d.name}? You'd have to pair it again to use it.`) && void act(d.address, () => api.bluetoothForget(d.address))}>
                    Forget
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="muted">No speakers paired yet.</p>
          )}

          <div className="stack-gap">
            <p className="muted">To add a speaker, put it in pairing mode (usually: hold its Bluetooth button until the light flashes), then press Find speakers.</p>
            <div className="buttons">
              <button className="primary" disabled={scanning || Boolean(busy)} onClick={() => void scan()}>
                {scanning ? "Looking for speakers…" : "Find speakers"}
              </button>
              {others > 0 && (
                <button type="button" onClick={() => setShowAll(!showAll)}>
                  {showAll ? "Speakers only" : `Show other devices (${others})`}
                </button>
              )}
            </div>
            {nearby.map((d) => (
              <div key={d.address} className="game-row">
                <div className="game-main">
                  <b>{d.name}</b>
                  <div className="muted game-sub">
                    {d.audio ? "Speaker or headphones" : "Not a speaker"}
                    {d.rssi !== undefined && ` · signal ${signal(d.rssi)}`}
                    {jobText(d) && ` · ${jobText(d)}`}
                  </div>
                </div>
                <button type="button" className="primary" disabled={Boolean(busy) || d.job?.state === "pairing" || d.job?.state === "connecting"} onClick={() => void act(d.address, () => api.bluetoothAction(d.address, "pair"))}>
                  {d.job?.state === "pairing" ? "Pairing…" : d.job?.state === "connecting" ? "Connecting…" : "Pair"}
                </button>
              </div>
            ))}
            {scanning && !nearby.length && <p className="muted">Nothing yet…</p>}
          </div>
        </>
      )}
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}

function jobText(d: BluetoothDevice): string {
  if (!d.job) return "";
  if (d.job.state === "failed") return d.job.message ?? "Didn't work";
  if (d.job.state === "done") return "Paired";
  return d.job.state === "pairing" ? "Pairing…" : "Connecting…";
}

const signal = (rssi: number) => (rssi >= -60 ? "strong" : rssi >= -75 ? "good" : "weak");
