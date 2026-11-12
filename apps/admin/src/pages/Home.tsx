import { isApp } from "@bargames/sdk";
import { useEffect, useState } from "react";
import { api, type Display, type Game, type RoomSummary } from "../api";
import { useAction, useLoad } from "../useLoad";
import { AttentionCard, CountdownCard, LeaderboardCard } from "./TonightExtras";

/** "Tonight": the screen staff use most. Games on/off, put a room on TVs, live events. */
export function HomePage() {
  const games = useLoad(api.games, 10_000);
  const displays = useLoad(api.displays, 15_000);
  const events = useLoad(api.events, 5_000);
  const { busy, run } = useAction(games.reload, games.setError);

  const groups = [...new Set((displays.data ?? []).map((d) => d.group).filter(Boolean))] as string[];
  const castable = (games.data ?? []).filter((g) => g.enabled && g.manifest.routes.table);

  return (
    <div className="grid">
      <AttentionCard />
      <section className="card">
        <h2>
          Games
          {games.data?.[0]?.context.venue.playUrl && (
            <small>
              {" "}
              <a href={games.data[0].context.venue.playUrl} target="_blank" rel="noreferrer">
                Players' page ↗
              </a>
            </small>
          )}
        </h2>
        {games.error && <p className="error">{games.error}</p>}
        {(games.data ?? []).map((g) => (
          <div className="row" key={g.id}>
            <div>
              {g.context.game.publicUrl ? (
                <a href={g.context.game.publicUrl} target="_blank" rel="noreferrer" title="Open the game's site">
                  <b>{g.context.game.displayName}</b> ↗
                </a>
              ) : (
                <b>{g.context.game.displayName}</b>
              )}
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

      <CastCard games={castable} displays={displays.data ?? []} displaysError={displays.error} groups={groups} />

      <AnnouncementCard />
      <CountdownCard games={games.data ?? []} />
      <LeaderboardCard />


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

const DURATIONS = [
  { label: "Until I take it down", minutes: 0 },
  { label: "15 minutes", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "3 hours", minutes: 180 },
];

/** A message on every game page, the players' page and idle TVs ("Last call at 1:30"). */
function AnnouncementCard() {
  const current = useLoad(api.announcement, 30_000);
  const { busy, run } = useAction(current.reload, current.setError);
  const [text, setText] = useState("");
  const [minutes, setMinutes] = useState(0);
  const a = current.data;
  return (
    <section className="card">
      <h2>Announcement</h2>
      {current.error && <p className="error">{current.error}</p>}
      {a ? (
        <div className="announce-live">
          <p>
            <b>{a.text}</b>
          </p>
          <small className="muted">{a.until ? `Comes down at ${new Date(a.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Up until you take it down"}</small>
          <div className="buttons">
            <button disabled={busy} onClick={() => run(() => api.clearAnnouncement())}>
              Take it down
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">Shown across the top of every game, on the players' page and on idle TVs.</p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          void run(async () => {
            await api.announce(text, minutes || undefined);
            setText("");
          });
        }}
      >
        <input value={text} maxLength={200} placeholder="Last call at 1:30" onChange={(e) => setText(e.target.value)} aria-label="Announcement text" />
        <div className="inline">
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="How long">
            {DURATIONS.map((d) => (
              <option key={d.minutes} value={d.minutes}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="primary" disabled={busy || !text.trim()}>{a ? "Replace" : "Post"}</button>
        </div>
      </form>
    </section>
  );
}

const NEW = "__new__";
const TYPED = "__typed__";

/** Put a game on TVs: a new venue room (the game creates it), an open room, or a typed code. */
function CastCard({ games, displays, displaysError, groups }: { games: Game[]; displays: Display[]; displaysError: string; groups: string[] }) {
  const [gameId, setGameId] = useState("");
  const [choice, setChoice] = useState(NEW);
  const [typed, setTyped] = useState("");
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; hostUrl?: string; pairHint?: boolean } | undefined>();
  const game = games.find((g) => g.id === gameId);
  const display = Boolean(game && isApp(game.manifest));
  const canCreate = Boolean(game && game.manifest.sdk.level >= 3 && game.manifest.commands.includes("create_room"));

  useEffect(() => {
    setRooms([]);
    setResult(undefined);
    if (!game || isApp(game.manifest)) return;
    setChoice(game.manifest.sdk.level >= 3 && game.manifest.commands.includes("create_room") ? NEW : TYPED);
    api
      .gameStatus(game.id)
      .then((s) => setRooms(s.rooms ?? []))
      .catch(() => setRooms([]));
  }, [gameId]); // eslint-disable-line react-hooks/exhaustive-deps

  const castTo = async (target: { group?: string; displayIds?: string[] }) => {
    if (!game) return setResult({ text: "Pick a game first." });
    const roomCode = display || choice === NEW ? undefined : choice === TYPED ? typed.trim() : choice;
    if (!display && choice === TYPED && !roomCode) return setResult({ text: "Enter the room code." });
    setBusy(true);
    setResult({ text: !display && choice === NEW ? "Creating a room and starting the TVs…" : "Starting the TVs…" });
    try {
      const r = await api.cast({ gameId: game.id, roomCode, ...target });
      const entries = Object.entries(r.results);
      const failed = entries.filter(([, v]) => !v.ok);
      const name = (id: string) => displays.find((d) => d.id === id)?.label || displays.find((d) => d.id === id)?.name || id;
      const what = display ? game.context.game.displayName : `${r.created ? "New room" : "Room"} ${r.roomCode}`;
      const lines = [`${what} on ${entries.length - failed.length} of ${entries.length} TV(s).`];
      for (const [id, v] of entries) if (!v.ok || v.message) lines.push(`${name(id)}: ${v.message ?? "failed"}`);
      setResult({ text: lines.join("\n"), hostUrl: r.hostUrl, pairHint: failed.some(([, v]) => v.needsCode) });
      const created = r.created ? r.roomCode : undefined;
      if (created) setRooms((x) => [...x, { code: created, kind: "venue", players: 0 }]);
      if (created) setChoice(created);
    } catch (e) {
      setResult({ text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Put a game on the TVs</h2>
      <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
        <option value="">Game or app…</option>
        {games.map((g) => (
          <option key={g.id} value={g.id}>
            {g.context.game.displayName}
          </option>
        ))}
      </select>
      {game && !display && (
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          {canCreate && <option value={NEW}>New room</option>}
          {rooms.map((r) => (
            <option key={r.code} value={r.code}>
              Room {r.code} · {r.players} player(s){r.title ? ` · ${r.title}` : ""}
            </option>
          ))}
          <option value={TYPED}>Enter a room code…</option>
        </select>
      )}
      {game && !display && choice === TYPED && <input placeholder="Room code" value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" />}
      {game && !display && !canCreate && <p className="muted">This game can't create rooms from the box yet: start one on a phone, then pick it here.</p>}
      <div className="buttons">
        <button className="primary" disabled={busy || !game || !displays.length} onClick={() => void castTo({ displayIds: displays.map((d) => d.id) })}>
          All TVs
        </button>
        {groups.map((g) => (
          <button key={g} disabled={busy || !game} onClick={() => void castTo({ group: g })}>
            {g}
          </button>
        ))}
        {displays.length > 1 &&
          displays.map((d) => (
            <button key={d.id} disabled={busy || !game} onClick={() => void castTo({ displayIds: [d.id] })}>
              {d.label || d.name}
            </button>
          ))}
        <button disabled={busy} onClick={() => void api.idleTvs().then(() => setResult({ text: "TVs on the idle screen." }), (e: Error) => setResult({ text: e.message }))}>
          Idle screen
        </button>
        <button
          className="danger"
          disabled={busy}
          onClick={() => void api.show({ displayIds: displays.map((d) => d.id) }, { kind: "off" }).then(() => setResult({ text: "TVs cleared." }))}
        >
          Clear all
        </button>
      </div>
      {result && <pre className="note">{result.text}</pre>}
      {result?.pairHint && <p className="muted">A TV needs pairing once: TVs tab, Pair, then type the code it shows.</p>}
      {result?.hostUrl && (
        <p>
          <a href={result.hostUrl} target="_blank" rel="noreferrer">
            Open the host controls for this room
          </a>
        </p>
      )}
      {displaysError && <p className="error">TVs: {displaysError}</p>}
      {!displays.length && !displaysError && <p className="muted">No TVs yet: add them on the TVs tab.</p>}
    </section>
  );
}
