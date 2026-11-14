import { useState } from "react";
import { api, type Display, type RoomsOverview } from "../api";
import { useLoad } from "../useLoad";

type Game = RoomsOverview["games"][number];
type Room = Game["rooms"][number];

/** Labels for the standard room commands, in button order. create_room is the Cast card's job. */
const ROOM_COMMANDS: [string, string][] = [
  ["start", "Start"],
  ["pause", "Pause"],
  ["resume", "Resume"],
  ["next_round", "Next round"],
  ["end", "End room"],
];

const ago = (iso?: string) => {
  if (!iso) return undefined;
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min)) return undefined;
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`;
};

/** Bird's-eye view of every room on every game: run them, resolve claims, put them on TVs. */
export function RoomsPage() {
  const overview = useLoad(api.rooms, 5_000);
  const displays = useLoad(api.displays, 15_000);
  const [filter, setFilter] = useState("");
  const [claimsOnly, setClaimsOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const games = overview.data?.games ?? [];
  const all = games.flatMap((g) => g.rooms.map((r) => ({ g, r })));
  const shown = all.filter(({ g, r }) => (!filter || g.id === filter) && (!claimsOnly || (r.pendingClaims?.length ?? 0) > 0));
  const totals = {
    rooms: all.length,
    players: all.reduce((n, x) => n + x.r.players, 0),
    tvs: all.reduce((n, x) => n + x.r.tvs.length, 0),
    claims: all.reduce((n, x) => n + (x.r.pendingClaims?.length ?? 0), 0),
  };

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote(await fn());
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
      void overview.reload();
    }
  };
  const command = (g: Game, command: string, r: Room, args?: Record<string, unknown>) =>
    act(async () => {
      if (command === "end" && !confirm(`End ${g.name} room ${r.code}? Players are sent home.`)) return "";
      const res = await api.command(g.id, { command, roomCode: r.code, args });
      return res.ok ? (res.message ?? `${g.name} ${r.code}: done.`) : `Refused: ${res.message ?? "no reason given"}`;
    });

  return (
    <div className="grid">
      <section className="card wide">
        <h2>Rooms</h2>
        <div className="stats">
          <Stat n={totals.rooms} label="open rooms" />
          <Stat n={totals.players} label="players" />
          <Stat n={totals.tvs} label="on TVs" />
          <Stat n={totals.claims} label="claims waiting" warn={totals.claims > 0} />
        </div>
        <div className="buttons">
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All games</option>
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.rooms.length})
              </option>
            ))}
          </select>
          <label className="switch">
            <input type="checkbox" checked={claimsOnly} onChange={(e) => setClaimsOnly(e.target.checked)} />
            <span>Only rooms with claims</span>
          </label>
        </div>
        {overview.error && <p className="error">{overview.error}</p>}
        {games.filter((g) => g.error).map((g) => (
          <p key={g.id} className="warn">
            {g.name}: {g.error}
          </p>
        ))}
        {!overview.data && !overview.error && <p className="muted">Loading…</p>}
        {overview.data && shown.length === 0 && <p className="muted">{all.length ? "No rooms match." : "No open rooms right now."}</p>}
        {note && <pre className="note">{note}</pre>}
      </section>

      {shown.map(({ g, r }) => (
        <section key={`${g.id}/${r.code}`} className={`card room${(r.pendingClaims?.length ?? 0) > 0 ? " attention" : ""}`}>
          <h2>
            {g.publicUrl ? (
              <a href={g.publicUrl} target="_blank" rel="noreferrer">
                {g.name} ↗
              </a>
            ) : (
              g.name
            )}{" "}
            · {r.code}
            {r.title ? <small> {r.title}</small> : null}
          </h2>
          <p className="muted">
            <span className={`badge ${r.kind}`}>{r.kind}</span> {r.phase ?? ""} · {r.players}
            {r.maxPlayers ? `/${r.maxPlayers}` : ""} player(s)
            {r.tables !== undefined ? ` · ${r.tables} screen(s)` : ""}
            {r.hostConnected !== undefined ? ` · host ${r.hostConnected ? "here" : "away"}` : ""}
            {r.hostName ? ` (${r.hostName})` : ""}
          </p>
          {(r.createdAt || r.lastActivityAt) && (
            <p className="muted">
              {r.createdAt ? `Opened ${ago(r.createdAt)}` : ""}
              {r.createdAt && r.lastActivityAt ? " · " : ""}
              {r.lastActivityAt ? `last activity ${ago(r.lastActivityAt)}` : ""}
            </p>
          )}
          {(r.pendingClaims ?? []).map((c) => (
            <div key={c.id} className="claim">
              <span>
                <b>Claim</b> {c.player ?? "a player"}
                {c.detail ? `: ${c.detail}` : ""}
                {c.at ? <small> {ago(c.at)}</small> : null}
              </span>
              {g.commands.includes("confirm_claim") && (
                <button className="primary" disabled={busy} onClick={() => void command(g, "confirm_claim", r, { claimId: c.id })}>
                  Confirm
                </button>
              )}
              {g.commands.includes("reject_claim") && (
                <button className="danger" disabled={busy} onClick={() => void command(g, "reject_claim", r, { claimId: c.id })}>
                  Reject
                </button>
              )}
            </div>
          ))}
          <div className="buttons">
            {ROOM_COMMANDS.filter(([c]) => g.commands.includes(c)).map(([c, label]) => (
              <button key={c} className={c === "end" ? "danger" : undefined} disabled={busy} onClick={() => void command(g, c, r)}>
                {label}
              </button>
            ))}
          </div>
          {r.hostUrl && <HostLink g={g} r={r} />}
          <RoomTvs g={g} r={r} displays={displays.data ?? []} busy={busy} act={act} />
        </section>
      ))}
    </div>
  );
}

function Stat({ n, label, warn }: { n: number; label: string; warn?: boolean }) {
  return (
    <div className={`stat${warn ? " warn" : ""}`}>
      <b>{n}</b>
      <span>{label}</span>
    </div>
  );
}

/**
 * Box 0.15.5: a room the box opened on the TVs has no host phone. Staff take it over here
 * at any time: open the host controls on this device, or scan the code with a phone.
 */
function HostLink({ g, r }: { g: Game; r: Room }) {
  const [qr, setQr] = useState(false);
  return (
    <div className="host-link">
      <div className="buttons">
        <a className="button primary" href={r.hostUrl} target="_blank" rel="noreferrer">
          Host this room
        </a>
        <button type="button" onClick={() => setQr(!qr)}>
          {qr ? "Hide code" : "Host on a phone"}
        </button>
      </div>
      {qr && (
        <div className="host-qr">
          <img src={api.hostQrUrl(g.id, r.code)} alt={`Code that opens the host controls of ${g.name} ${r.code}`} width={180} height={180} />
          <p className="muted small-print">Scan with the phone that will run the game. Anyone with this code can host the room, so don't leave it on screen.</p>
        </div>
      )}
    </div>
  );
}

/** Which TVs show this room, plus one-tap "put it on" / "take it off". */
function RoomTvs({ g, r, displays, busy, act }: { g: Game; r: Room; displays: Display[]; busy: boolean; act: (fn: () => Promise<string>) => Promise<void> }) {
  const [pick, setPick] = useState("");
  const others = displays.filter((d) => !r.tvs.some((t) => t.id === d.id));
  return (
    <div className="tvs">
      <p className="muted">{r.tvs.length ? `On TV: ${r.tvs.map((t) => t.name).join(", ")}` : "Not on a TV"}</p>
      <div className="buttons">
        {others.length > 0 && (
          <>
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Put on a TV…</option>
              <option value="__all__">All TVs</option>
              {others.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label || d.name}
                </option>
              ))}
            </select>
            <button
              disabled={busy || !pick}
              onClick={() =>
                void act(async () => {
                  const ids = pick === "__all__" ? displays.map((d) => d.id) : [pick];
                  const res = await api.cast({ gameId: g.id, roomCode: r.code, displayIds: ids });
                  const failed = Object.entries(res.results).filter(([, v]) => !v.ok);
                  setPick("");
                  return failed.length ? failed.map(([id, v]) => `${id}: ${v.message ?? "failed"}`).join("\n") : `${g.name} ${r.code} on ${ids.length} TV(s).`;
                })
              }
            >
              Show
            </button>
          </>
        )}
        {r.tvs.length > 0 && (
          <button disabled={busy} onClick={() => void act(async () => (await api.idleTvs({ displayIds: r.tvs.map((t) => t.id) }), "Those TVs are on the idle screen."))}>
            Take off TVs
          </button>
        )}
      </div>
    </div>
  );
}
