// Tonight page cards for SDK 0.9.0: needs attention, lobby countdown, leaderboards.

import { useEffect, useState } from "react";
import { api, type Game } from "../api";
import { useLoad } from "../useLoad";

/** What needs staff: games' own items (with a link into their admin) and the box's (TVs offline). */
export function AttentionCard() {
  const att = useLoad(api.attention, 15_000);
  const items = att.data?.items ?? [];
  if (!items.length) return null;
  const open = (source: string, actionPath?: string) => {
    const tab = window.open("about:blank", "_blank");
    api.staffLink(source, actionPath).then(
      (r) => (tab ? (tab.location.href = r.url) : (window.location.href = r.url)),
      () => tab?.close(),
    );
  };
  return (
    <section className="card wide attention">
      <h2>Needs attention</h2>
      {items.map((i, n) => (
        <div key={n} className={`row ${i.level}`}>
          <div>
            <b>{i.sourceName}</b>
            <small>{i.message}</small>
          </div>
          {i.source !== "_box" && (
            <button type="button" onClick={() => open(i.source, i.actionPath)}>
              Open ↗
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

const fmt = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

/** "Trivia starts in 5:00" on phones, the games list and idle TVs. */
export function CountdownCard({ games }: { games: Game[] }) {
  const cd = useLoad(api.countdown, 10_000);
  const [label, setLabel] = useState("Next game starts in");
  const [minutes, setMinutes] = useState(5);
  const [gameId, setGameId] = useState("");
  const [now, setNow] = useState(Date.now());
  const [msg, setMsg] = useState("");
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const live = cd.data && Date.parse(cd.data.endsAt) > now ? cd.data : undefined;
  const start = () =>
    api.startCountdown(label, minutes, gameId || undefined).then(
      () => {
        setMsg("");
        void cd.reload();
      },
      (e: Error) => setMsg(e.message),
    );
  return (
    <section className="card">
      <h2>Countdown</h2>
      {live ? (
        <>
          <p>
            <b>
              {live.label} {fmt(Math.ceil((Date.parse(live.endsAt) - now) / 1000))}
            </b>
          </p>
          <button className="danger" onClick={() => void api.clearCountdown().then(() => cd.reload())}>
            End it now
          </button>
        </>
      ) : (
        <>
          <p className="muted">Shows on players' phones, the games list and idle TVs.</p>
          <label>
            Text
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <div className="inline">
            <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {[1, 2, 5, 10, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
            <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
              <option value="">No game link</option>
              {games
                .filter((g) => g.enabled)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.context.game.displayName}
                  </option>
                ))}
            </select>
            <button className="primary" disabled={!label.trim()} onClick={() => void start()}>
              Start
            </button>
          </div>
        </>
      )}
      {msg && <p className="error">{msg}</p>}
    </section>
  );
}

/** Tonight's and all-time winners per game (from games that report results). */
export function LeaderboardCard() {
  const lb = useLoad(api.leaderboards, 30_000);
  const [allTime, setAllTime] = useState(false);
  const games = lb.data?.games ?? [];
  return (
    <section className="card">
      <h2>
        Leaderboards{" "}
        <small>
          <button className="ghost" onClick={() => setAllTime(!allTime)}>
            {allTime ? "Show tonight" : "Show all time"}
          </button>
        </small>
      </h2>
      {!games.length && <p className="muted">No results yet. Games that report results (SDK 0.9.0) show up here, on the games list and on idle TVs.</p>}
      {games.map((g) => {
        const rows = (allTime ? g.allTime : g.tonight).filter((r) => r.games > 0);
        return (
          <div key={g.gameId}>
            <b>{g.displayName}</b>
            {rows.length ? (
              <ol className="plain">
                {rows.slice(0, 5).map((r) => (
                  <li key={r.name}>
                    {r.name}: {r.wins} win{r.wins === 1 ? "" : "s"} · {r.games} game{r.games === 1 ? "" : "s"}
                    {r.best !== undefined ? ` · best ${r.best}` : ""}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">Nothing {allTime ? "yet" : "tonight"}.</p>
            )}
          </div>
        );
      })}
      {games.length > 0 && (
        <button className="danger" onClick={() => window.confirm("Clear all leaderboards (tonight and all time)?") && void api.resetLeaderboards().then(() => lb.reload())}>
          Reset leaderboards
        </button>
      )}
      <p className="muted">Rewards (prizes for winners) are coming soon.</p>
    </section>
  );
}
