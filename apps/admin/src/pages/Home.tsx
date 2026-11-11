import { useEffect, useState } from "react";
import { api, type Display, type Game, type RoomSummary } from "../api";
import { useAction, useLoad } from "../useLoad";

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

      <CastCard games={castable} displays={displays.data ?? []} displaysError={displays.error} groups={groups} />

      <RoomsCard games={(games.data ?? []).filter((g) => g.enabled && g.manifest.sdk.level >= 3)} />

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

/** Labels for the standard room commands, in button order. create_room is the Cast card's job. */
const ROOM_COMMANDS: [string, string][] = [
  ["start", "Start"],
  ["pause", "Pause"],
  ["resume", "Resume"],
  ["next_round", "Next round"],
  ["end", "End room"],
];

/** Open rooms of every controllable game: run them from the iPad, and resolve pending claims. */
function RoomsCard({ games }: { games: Game[] }) {
  const [rooms, setRooms] = useState<Record<string, RoomSummary[]>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const ids = games.map((g) => g.id).join(",");

  const load = () =>
    Promise.all(games.map((g) => api.gameStatus(g.id).then((s) => [g.id, s.rooms ?? []] as const, () => [g.id, [] as RoomSummary[]] as const))).then((list) => setRooms(Object.fromEntries(list)));

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (game: Game, command: string, roomCode: string, args?: Record<string, unknown>) => {
    if (command === "end" && !confirm(`End room ${roomCode}? Players are sent home.`)) return;
    setBusy(true);
    try {
      const r = await api.command(game.id, { command, roomCode, args });
      setNote(r.ok ? (r.message ?? `${game.context.game.displayName} ${roomCode}: done.`) : `Refused: ${r.message ?? "no reason given"}`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
      void load();
    }
  };

  const total = games.reduce((n, g) => n + (rooms[g.id]?.length ?? 0), 0);
  if (!games.length) return null;
  return (
    <section className="card">
      <h2>Rooms</h2>
      {total === 0 && <p className="muted">No open rooms right now.</p>}
      {games.map((g) =>
        (rooms[g.id] ?? []).map((r) => (
          <div key={`${g.id}/${r.code}`} className="room">
            <div className="row">
              <div>
                <b>
                  {g.context.game.displayName} · {r.code}
                </b>
                <small>
                  {r.kind} · {r.players} player(s){r.phase ? ` · ${r.phase}` : ""}
                  {r.title ? ` · ${r.title}` : ""}
                </small>
              </div>
            </div>
            {(r.pendingClaims ?? []).map((c) => (
              <div key={c.id} className="claim">
                <span>
                  <b>Claim</b> {c.player ?? "a player"}
                  {c.detail ? `: ${c.detail}` : ""}
                </span>
                {g.manifest.commands.includes("confirm_claim") && (
                  <button className="primary" disabled={busy} onClick={() => void send(g, "confirm_claim", r.code, { claimId: c.id })}>
                    Confirm
                  </button>
                )}
                {g.manifest.commands.includes("reject_claim") && (
                  <button className="danger" disabled={busy} onClick={() => void send(g, "reject_claim", r.code, { claimId: c.id })}>
                    Reject
                  </button>
                )}
              </div>
            ))}
            <div className="buttons">
              {ROOM_COMMANDS.filter(([c]) => g.manifest.commands.includes(c)).map(([c, label]) => (
                <button key={c} className={c === "end" ? "danger" : undefined} disabled={busy} onClick={() => void send(g, c, r.code)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )),
      )}
      {note && <pre className="note">{note}</pre>}
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
  const canCreate = Boolean(game && game.manifest.sdk.level >= 3 && game.manifest.commands.includes("create_room"));

  useEffect(() => {
    setRooms([]);
    setResult(undefined);
    if (!game) return;
    setChoice(game.manifest.sdk.level >= 3 && game.manifest.commands.includes("create_room") ? NEW : TYPED);
    api
      .gameStatus(game.id)
      .then((s) => setRooms(s.rooms ?? []))
      .catch(() => setRooms([]));
  }, [gameId]); // eslint-disable-line react-hooks/exhaustive-deps

  const castTo = async (target: { group?: string; displayIds?: string[] }) => {
    if (!game) return setResult({ text: "Pick a game first." });
    const roomCode = choice === NEW ? undefined : choice === TYPED ? typed.trim() : choice;
    if (choice === TYPED && !roomCode) return setResult({ text: "Enter the room code." });
    setBusy(true);
    setResult({ text: choice === NEW ? "Creating a room and starting the TVs…" : "Starting the TVs…" });
    try {
      const r = await api.cast({ gameId: game.id, roomCode, ...target });
      const entries = Object.entries(r.results);
      const failed = entries.filter(([, v]) => !v.ok);
      const name = (id: string) => displays.find((d) => d.id === id)?.label || displays.find((d) => d.id === id)?.name || id;
      const lines = [`${r.created ? "New room" : "Room"} ${r.roomCode} on ${entries.length - failed.length} of ${entries.length} TV(s).`];
      for (const [id, v] of entries) if (!v.ok || v.message) lines.push(`${name(id)}: ${v.message ?? "failed"}`);
      setResult({ text: lines.join("\n"), hostUrl: r.hostUrl, pairHint: failed.some(([, v]) => v.needsCode) });
      if (r.created) setRooms((x) => [...x, { code: r.roomCode, kind: "venue", players: 0 }]);
      if (r.created) setChoice(r.roomCode);
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
        <option value="">Game…</option>
        {games.map((g) => (
          <option key={g.id} value={g.id}>
            {g.context.game.displayName}
          </option>
        ))}
      </select>
      {game && (
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
      {game && choice === TYPED && <input placeholder="Room code" value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" />}
      {game && !canCreate && <p className="muted">This game can't create rooms from the box yet: start one on a phone, then pick it here.</p>}
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
