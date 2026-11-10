import { tableUrl } from "@bargames/sdk";
import { useState } from "react";
import { api } from "../api";
import { useAction, useLoad } from "../useLoad";

/** "Tonight": the screen staff use most. Games on/off, put a room on TVs, live events. */
export function HomePage() {
  const games = useLoad(api.games, 10_000);
  const displays = useLoad(api.displays, 15_000);
  const events = useLoad(api.events, 5_000);
  const { busy, run } = useAction(games.reload, games.setError);
  const [room, setRoom] = useState("");
  const [gameId, setGameId] = useState("");
  const [result, setResult] = useState("");

  const groups = [...new Set((displays.data ?? []).map((d) => d.group).filter(Boolean))] as string[];
  const castable = (games.data ?? []).filter((g) => g.enabled && g.manifest.routes.table);

  const castTo = async (target: { group?: string; displayIds?: string[] }) => {
    const g = castable.find((x) => x.id === gameId);
    if (!g || !room) return setResult("Pick a game and enter its room code.");
    const url = new URL(tableUrl(g.manifest, room.toUpperCase())!, g.context.game.publicUrl).toString();
    const r = await api.show(target, { kind: "url", url });
    const failed = Object.entries(r).filter(([, v]) => !v.ok);
    setResult(failed.length ? failed.map(([id, v]) => `${id}: ${v.message}`).join("\n") : `Showing on ${Object.keys(r).length} TV(s).`);
  };

  return (
    <div className="grid">
      <section className="card">
        <h2>Games</h2>
        {games.error && <p className="error">{games.error}</p>}
        {(games.data ?? []).map((g) => (
          <div className="row" key={g.id}>
            <div>
              <b>{g.context.game.displayName}</b>
              <small>{g.host}</small>
            </div>
            <label className="switch">
              <input type="checkbox" checked={g.enabled} disabled={busy} onChange={(e) => run(() => api.patchGame(g.id, { enabled: e.target.checked }))} />
              <span>{g.enabled ? "On" : "Off"}</span>
            </label>
          </div>
        ))}
        {games.data?.length === 0 && <p className="muted">No games installed yet. Add one under Games.</p>}
      </section>

      <section className="card">
        <h2>Put a room on the TVs</h2>
        <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
          <option value="">Game…</option>
          {castable.map((g) => (
            <option key={g.id} value={g.id}>
              {g.context.game.displayName}
            </option>
          ))}
        </select>
        <input placeholder="Room code" value={room} onChange={(e) => setRoom(e.target.value)} autoCapitalize="characters" />
        <div className="buttons">
          <button className="primary" onClick={() => castTo({ displayIds: (displays.data ?? []).map((d) => d.id) })}>
            All TVs
          </button>
          {groups.map((g) => (
            <button key={g} onClick={() => castTo({ group: g })}>
              {g}
            </button>
          ))}
          <button className="danger" onClick={() => api.show({ displayIds: (displays.data ?? []).map((d) => d.id) }, { kind: "off" }).then(() => setResult("TVs cleared."))}>
            Clear all
          </button>
        </div>
        {result && <pre className="note">{result}</pre>}
        {displays.error && <p className="error">TVs: {displays.error}</p>}
      </section>

      <section className="card wide">
        <h2>Live events</h2>
        {(events.data ?? []).length === 0 && <p className="muted">Nothing yet. Events from games show up here (and go to Home Assistant).</p>}
        <ul className="events">
          {(events.data ?? []).map((e, i) => (
            <li key={i}>
              <time>{new Date(e.at).toLocaleTimeString()}</time> <b>{e.type}</b> {e.gameId}
              {e.roomCode ? ` · ${e.roomCode}` : ""}
              {e.data ? <code>{JSON.stringify(e.data)}</code> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
