// The Roku remote on the TVs page: a real-remote layout, big touch targets, a flash on each
// press, hold-to-repeat for arrows and volume, and keyboard arrows/Enter/Backspace on a desktop.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api, type Display } from "../api";

const REPEATS = new Set(["Up", "Down", "Left", "Right", "VolumeUp", "VolumeDown", "Rev", "Fwd"]);
const KEYBOARD: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Select",
  Backspace: "Back",
  Escape: "Back",
  Home: "Home",
  " ": "Play",
};

export function Remote({ d, keys, embedded = false }: { d: Display; keys: string[]; embedded?: boolean }) {
  const has = new Set(keys);
  const [open, setOpen] = useState(embedded);
  const [lit, setLit] = useState("");
  const [msg, setMsg] = useState("");
  const [text, setText] = useState("");
  const hold = useRef<{ t?: ReturnType<typeof setTimeout>; i?: ReturnType<typeof setInterval> }>({});
  const online = d.health?.online !== false;

  const send = (key: string) => {
    if (!has.has(key)) return;
    setLit(key);
    setTimeout(() => setLit((k) => (k === key ? "" : k)), 160);
    api.key(d.id, key).then(
      () => setMsg(""),
      (e: Error) => setMsg(e.message),
    );
  };
  const stopHold = () => {
    clearTimeout(hold.current.t);
    clearInterval(hold.current.i);
    hold.current = {};
  };
  useEffect(() => stopHold, []);
  const press = (key: string) => (e: PointerEvent) => {
    e.preventDefault();
    send(key);
    if (!REPEATS.has(key)) return;
    stopHold();
    // Hold to repeat: after 400 ms, every 150 ms (volume a little slower).
    hold.current.t = setTimeout(() => {
      hold.current.i = setInterval(() => send(key), key.startsWith("Volume") ? 220 : 150);
    }, 400);
  };
  const btn = (key: string, label: string, cls = "") =>
    has.has(key) ? (
      <button
        key={key}
        type="button"
        className={`rk ${cls} ${lit === key ? "lit" : ""}`}
        aria-label={key}
        disabled={!online}
        onPointerDown={press(key)}
        onPointerUp={stopHold}
        onPointerLeave={stopHold}
        onPointerCancel={stopHold}
        onContextMenu={(e) => e.preventDefault()}
      >
        {label}
      </button>
    ) : null;
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const key = KEYBOARD[e.key];
    if (key && has.has(key)) {
      e.preventDefault();
      send(key);
    }
  };

  if (!open)
    return (
      <p>
        <button type="button" onClick={() => setOpen(true)}>
          Remote
        </button>
      </p>
    );
  return (
    <div className="remote-panel" tabIndex={0} onKeyDown={onKey} aria-label={`Remote for ${d.label || d.name}`}>
      {!embedded && (
        <div className="remote-head">
          <b>{d.label || d.name}</b>
          <button type="button" className="ghost" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
      {!online && <p className="warn">This TV isn't answering right now.</p>}
      <div className="rk-row">
        {btn("Back", "↩", "small")}
        {btn("Home", "⌂", "small")}
        {btn("Info", "✱", "small")}
      </div>
      <div className="dpad-ring">
        {btn("Up", "▲", "up")}
        {btn("Left", "◀", "left")}
        {btn("Select", "OK", "ok")}
        {btn("Right", "▶", "right")}
        {btn("Down", "▼", "down")}
      </div>
      <div className="rk-row">
        {btn("InstantReplay", "↺", "small")}
        {btn("Search", "🔍", "small")}
        {btn("Backspace", "⌫", "small")}
      </div>
      <div className="rk-row">
        {btn("Rev", "⏪")}
        {btn("Play", "⏯")}
        {btn("Fwd", "⏩")}
      </div>
      {has.has("VolumeUp") && (
        <div className="rk-row">
          {btn("VolumeDown", "🔉")}
          {btn("VolumeMute", "🔇")}
          {btn("VolumeUp", "🔊")}
        </div>
      )}
      {has.has("ChannelUp") && (
        <div className="rk-row">
          {btn("ChannelDown", "CH −")}
          {btn("ChannelUp", "CH +")}
        </div>
      )}
      {!embedded && d.capabilities?.apps && <TvApps d={d} online={online} />}
      {d.capabilities?.text && (
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text) return;
          api.typeText(d.id, text).then(
            () => setText(""),
            (err: Error) => setMsg(err.message),
          );
        }}
      >
        <input placeholder="Type into a search box" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={!text || !online}>
          Send
        </button>
      </form>
      )}
      <p className="muted small-print">
        Hold arrows or volume to repeat. On a keyboard: arrows, Enter, Backspace. Home or Back leaves what the box is casting.
        {d.driver === "appletv" ? " Back is the Apple remote's Back/Menu button; Play is play/pause." : ""}
      </p>
      {msg && <p className="error">{msg}</p>}
    </div>
  );
}

/** The TV's installed apps (Roku channels): tap one to open it on the TV. */
export function TvApps({ d, online }: { d: Display; online: boolean }) {
  const [apps, setApps] = useState<{ id: string; name: string }[] | undefined>();
  const [active, setActive] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [filter, setFilter] = useState("");

  const load = () =>
    api.tvApps(d.id).then(
      (r) => {
        setApps(r.apps);
        setActive(r.active);
        setError("");
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    if (online) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.id, online]);

  const launch = (a: { id: string; name: string }) => {
    if (d.content?.kind && d.content.kind !== "external" && d.content.kind !== "off" && !window.confirm(`Open ${a.name}? The box stops sending to this TV.`)) return;
    setBusy(a.id);
    api.launchTvApp(d.id, a.id).then(
      () => {
        setActive(a.id);
        setBusy("");
      },
      (e: Error) => {
        setError(e.message);
        setBusy("");
      },
    );
  };

  if (error) return <p className="warn small-print">Apps: {error}</p>;
  if (!apps) return online ? <p className="muted small-print">Loading the TV's apps…</p> : null;
  const shown = apps.filter((a) => a.name.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <details className="tv-apps" open>
      <summary>Apps on this TV ({apps.length})</summary>
      {apps.length > 12 && <input placeholder="Find an app" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      <div className="tv-app-grid">
        {shown.map((a) => (
          <button type="button" key={a.id} className={`tv-app${a.id === active ? " active" : ""}`} disabled={!online || busy === a.id} onClick={() => launch(a)} title={`Open ${a.name} on the TV`}>
            <img src={api.tvAppIconUrl(d.id, a.id)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
            <span>{a.name}</span>
          </button>
        ))}
      </div>
    </details>
  );
}
