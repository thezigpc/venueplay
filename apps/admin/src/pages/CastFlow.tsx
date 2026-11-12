// "Put something on a TV": one flow instead of a row of buttons. Pick what, which room (for
// a game), which TVs, then one button. It says what will happen before it happens.

import { isApp } from "@bargames/sdk";
import { useEffect, useState } from "react";
import { api, type Display, type Game, type MediaProvider, type RoomSummary } from "../api";
import { useMediaItems } from "./MediaControls";

const NEW = "__new__";
const TYPED = "__typed__";
const IDLE = "__idle__";

type Result = { lines: string[]; hostUrl?: string; pairHint?: boolean; ok: boolean };

export function CastFlow({ games, displays, media, preselect, onClose }: { games: Game[]; displays: Display[]; media: MediaProvider[]; preselect?: string; onClose: () => void }) {
  const castable = games.filter((g) => g.enabled && g.manifest.routes.table);
  const providers = media.filter((p) => games.some((g) => g.id === p.gameId && g.enabled));
  const [what, setWhat] = useState("");
  const [room, setRoom] = useState(NEW);
  const [typed, setTyped] = useState("");
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [item, setItem] = useState("");
  const [picked, setPicked] = useState<string[]>(preselect ? [preselect] : []);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | undefined>();

  const game = castable.find((g) => `game:${g.id}` === what);
  const provider = providers.find((p) => `media:${p.gameId}` === what);
  const isGame = Boolean(game && !isApp(game.manifest));
  const canCreate = Boolean(game && game.manifest.sdk.level >= 3 && game.manifest.commands.includes("create_room"));
  const { items } = useMediaItems(provider?.gameId);

  useEffect(() => {
    setRooms([]);
    setResult(undefined);
    if (!game || isApp(game.manifest)) return;
    setRoom(canCreate ? NEW : TYPED);
    api.gameStatus(game.id).then(
      (s) => setRooms(s.rooms ?? []),
      () => setRooms([]),
    );
  }, [what]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes it, like any dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const nameOf = (id: string) => displays.find((d) => d.id === id)?.label || displays.find((d) => d.id === id)?.name || id;
  /** Why a TV can't be picked for this choice, if it can't. */
  const blocked = (d: Display): string | undefined => {
    if (d.health?.online === false) return "offline";
    if (provider && !provider.targets.some((t) => t.displayId === d.id)) return `not linked to ${provider.displayName}`;
    return undefined;
  };
  const usable = displays.filter((d) => !blocked(d));
  const chosen = picked.filter((id) => usable.some((d) => d.id === id));
  const groups = [...new Set(usable.map((d) => d.group).filter(Boolean))] as string[];
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const whatName = what === IDLE ? "The idle screen" : game ? game.context.game.displayName : provider ? provider.displayName : "";
  const roomText = !isGame ? "" : room === NEW ? ", a new room" : room === TYPED ? (typed.trim() ? `, room ${typed.trim().toUpperCase()}` : "") : `, room ${room}`;
  const itemName = provider ? items?.find((i) => i.id === item)?.name : undefined;
  const missing = !what ? "Pick what to show." : provider && !item ? "Pick a list." : isGame && room === TYPED && !typed.trim() ? "Enter the room code." : !chosen.length ? "Pick at least one TV." : "";
  const summary = missing || `${whatName}${roomText}${itemName ? `: ${itemName}` : ""}, on ${chosen.length === 1 ? nameOf(chosen[0]) : `${chosen.length} TVs`}`;

  const go = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      if (what === IDLE) {
        const r = await api.idleTvs({ displayIds: chosen });
        const bad = Object.entries(r).filter(([, v]) => !v.ok);
        setResult({ ok: !bad.length, lines: [`Idle screen on ${chosen.length - bad.length} of ${chosen.length} TV(s).`, ...bad.map(([id, v]) => `${nameOf(id)}: ${v.message ?? "failed"}`)] });
      } else if (provider) {
        const lines: string[] = [];
        let ok = true;
        for (const id of chosen) {
          const r = await api.mediaPlay(provider.gameId, item, id).catch((e: Error) => ({ ok: false, message: e.message, pending: false }));
          ok &&= r.ok;
          lines.push(`${nameOf(id)}: ${r.ok ? (r.pending ? "starting, give it a moment" : "playing") : (r.message ?? "failed")}`);
        }
        setResult({ ok, lines });
      } else if (game) {
        const roomCode = !isGame || room === NEW ? undefined : room === TYPED ? typed.trim() : room;
        const r = await api.cast({ gameId: game.id, roomCode, displayIds: chosen, ...(isGame && room === NEW ? { firstJoinerHosts: true } : {}) });
        const entries = Object.entries(r.results);
        const failed = entries.filter(([, v]) => !v.ok);
        const head = isGame ? `${r.created ? "New room" : "Room"} ${r.roomCode}` : game.context.game.displayName;
        const lines = [`${head} on ${entries.length - failed.length} of ${entries.length} TV(s).`];
        if (r.created) lines.push("The first person to scan the TV's QR code hosts.");
        for (const [id, v] of entries) if (!v.ok || v.message) lines.push(`${nameOf(id)}: ${v.message ?? "failed"}`);
        setResult({ ok: !failed.length, lines, hostUrl: r.hostUrl, pairHint: failed.some(([, v]) => v.needsCode) });
      }
    } catch (e) {
      setResult({ ok: false, lines: [(e as Error).message] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Put something on a TV">
        <div className="sheet-head">
          <h2>Put something on a TV</h2>
          <button type="button" className="ghost close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="sheet-body">
          <h3>1 · What</h3>
          <div className="choice-grid">
            {castable.map((g) => (
              <Choice key={g.id} on={what === `game:${g.id}`} onClick={() => setWhat(`game:${g.id}`)} title={g.context.game.displayName} sub={isApp(g.manifest) ? "App" : "Game"} />
            ))}
            {providers.map((p) => (
              <Choice key={p.gameId} on={what === `media:${p.gameId}`} onClick={() => setWhat(`media:${p.gameId}`)} title={p.displayName} sub="Lists and plans" />
            ))}
            <Choice on={what === IDLE} onClick={() => setWhat(IDLE)} title="Idle screen" sub="Play QR and Wi-Fi" />
          </div>
          {!castable.length && !providers.length && <p className="muted">No game or app is on. Turn one on under Games.</p>}

          {isGame && (
            <>
              <h3>2 · Which room</h3>
              <div className="choice-list">
                {canCreate && <Choice on={room === NEW} onClick={() => setRoom(NEW)} title="A new room" sub="The first player to scan the QR hosts" />}
                {rooms.map((r) => (
                  <Choice key={r.code} on={room === r.code} onClick={() => setRoom(r.code)} title={r.code} sub={`Open now · ${r.players} player${r.players === 1 ? "" : "s"}${r.title ? ` · ${r.title}` : ""}`} />
                ))}
                <Choice on={room === TYPED} onClick={() => setRoom(TYPED)} title="Another room" sub="Type its code" />
              </div>
              {room === TYPED && <input placeholder="Room code" value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" aria-label="Room code" />}
              {!canCreate && <p className="muted small-print">This game can't create rooms from the box: start one on a phone, then pick it here.</p>}
            </>
          )}

          {provider && (
            <>
              <h3>2 · Which list</h3>
              <select value={item} onChange={(e) => setItem(e.target.value)} aria-label="List or plan">
                <option value="">{items ? "Pick a list or plan…" : "Loading…"}</option>
                {(items ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                    {i.kind === "plan" ? " (plan)" : ""}
                  </option>
                ))}
              </select>
            </>
          )}

          <h3>{isGame || provider ? "3" : "2"} · Where</h3>
          <div className="chips">
            {displays.map((d) => {
              const why = blocked(d);
              const on = !why && picked.includes(d.id);
              return (
                <button key={d.id} type="button" className={`chip${on ? " on" : ""}`} aria-pressed={on} disabled={Boolean(why)} onClick={() => toggle(d.id)}>
                  {d.label || d.name}
                  {why ? ` · ${why}` : ""}
                </button>
              );
            })}
          </div>
          {usable.length > 1 && (
            <div className="inline">
              <button type="button" className="ghost link" onClick={() => setPicked(usable.map((d) => d.id))}>
                Every TV
              </button>
              {groups.map((g) => (
                <button key={g} type="button" className="ghost link" onClick={() => setPicked(usable.filter((d) => d.group === g).map((d) => d.id))}>
                  {g}
                </button>
              ))}
              {picked.length > 0 && (
                <button type="button" className="ghost link" onClick={() => setPicked([])}>
                  None
                </button>
              )}
            </div>
          )}
          {!displays.length && <p className="muted">No TVs yet: add them under TVs.</p>}

          {result && (
            <div className={`cast-result ${result.ok ? "ok" : "warn"}`} role="status">
              {result.lines.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
              {result.pairHint && <p>A TV needs pairing once: open it under TVs, Setup, and type the code it shows.</p>}
              {result.hostUrl && (
                <p>
                  <a href={result.hostUrl} target="_blank" rel="noreferrer">
                    Open the host controls for this room
                  </a>
                </p>
              )}
            </div>
          )}
        </div>

        <div className="sheet-foot">
          <span className={missing ? "muted" : ""}>{summary}</span>
          {result?.ok ? (
            <button type="button" className="primary big" onClick={onClose}>
              Done
            </button>
          ) : (
            <button type="button" className="primary big" disabled={busy || Boolean(missing)} onClick={() => void go()}>
              {busy ? "Starting…" : "Show it"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Choice({ on, onClick, title, sub }: { on: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button type="button" className={`choice${on ? " on" : ""}`} aria-pressed={on} onClick={onClick}>
      <b>{title}</b>
      <span>{sub}</span>
    </button>
  );
}
