// Scenes ("Game night", "Closing time") and scheduled sessions (SDK 0.9.0 box features).

import { isApp } from "@bargames/sdk";
import { useState } from "react";
import { api, type Display, type Game, type Scene, type Schedule } from "../api";
import { useLoad } from "../useLoad";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "scene";

/** Saved TV layouts, applied with one tap. "Closing time" is a built-in preset. */
export function ScenesCard({ games, displays }: { games: Game[]; displays: Display[] }) {
  const scenes = useLoad(api.scenes);
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState(false);
  const list = scenes.data?.scenes ?? [];
  const preset = scenes.data?.presets.find((p) => p.id === "closing-time");
  const apply = async (s: Scene) => {
    if (s.endRooms && !window.confirm(`${s.name}: this ends every open room. Go ahead?`)) return;
    setMsg(`Applying ${s.name}…`);
    try {
      const r = await api.applyScene(s.id);
      const bad = r.steps.filter((x) => !x.ok);
      setMsg(bad.length ? `${s.name}: ${bad.length} step(s) didn't work: ${bad.map((x) => `${x.step}${x.message ? ` (${x.message})` : ""}`).join("; ")}` : `${s.name} applied.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Scenes</h2>
      <p className="muted">Saved TV setups, applied in one tap.</p>
      <div className="buttons">
        {list.map((s) => (
          <button key={s.id} className={s.id === "closing-time" ? "danger" : "primary"} onClick={() => void apply(s)}>
            {s.name}
          </button>
        ))}
      </div>
      {preset && !list.some((s) => s.id === "closing-time") && (
        <p>
          <button className="ghost" onClick={() => void api.saveScene(preset).then(() => scenes.reload())}>
            + Add "Closing time" (ends rooms, says goodnight, TVs to the idle screen)
          </button>
        </p>
      )}
      {!editing ? (
        <button className="ghost" onClick={() => setEditing(true)}>
          + New scene
        </button>
      ) : (
        <SceneEditor
          games={games}
          displays={displays}
          onDone={() => {
            setEditing(false);
            void scenes.reload();
          }}
        />
      )}
      {list.length > 0 && (
        <details>
          <summary>Delete a scene</summary>
          {list.map((s) => (
            <button key={s.id} className="danger" onClick={() => window.confirm(`Delete ${s.name}?`) && void api.deleteScene(s.id).then(() => scenes.reload())}>
              {s.name}
            </button>
          ))}
        </details>
      )}
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}

function SceneEditor({ games, displays, onDone }: { games: Game[]; displays: Display[]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [pick, setPick] = useState<Record<string, string>>({});
  const [endRooms, setEndRooms] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const castable = games.filter((g) => g.enabled && g.manifest.routes.table);
  const save = async () => {
    const actions = Object.entries(pick)
      .filter(([, v]) => v)
      .map(([displayId, v]) => (v === "idle" || v === "off" ? { displayId, do: v } : { displayId, do: "game", gameId: v.slice(5) }));
    try {
      await api.saveScene({ id: slug(name), name, actions, ...(endRooms ? { endRooms: true } : {}), ...(text.trim() ? { announcement: { text: text.trim() } } : {}) } as Scene);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="media">
      <label>
        Name
        <input value={name} placeholder="Game night" onChange={(e) => setName(e.target.value)} />
      </label>
      {displays.map((d) => (
        <label key={d.id}>
          {d.label || d.name}
          <select value={pick[d.id] ?? ""} onChange={(e) => setPick({ ...pick, [d.id]: e.target.value })}>
            <option value="">Leave alone</option>
            {castable.map((g) => (
              <option key={g.id} value={`game:${g.id}`}>
                {g.context.game.displayName}
                {isApp(g.manifest) ? "" : " (new room)"}
              </option>
            ))}
            <option value="idle">Idle screen</option>
            <option value="off">Off</option>
          </select>
        </label>
      ))}
      <label className="inline">
        <input type="checkbox" checked={endRooms} onChange={(e) => setEndRooms(e.target.checked)} style={{ width: "auto" }} /> End every open room first
      </label>
      <label>
        Announcement (optional)
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="buttons">
        <button className="primary" disabled={!name.trim()} onClick={() => void save()}>
          Save scene
        </button>
        <button onClick={onDone}>Cancel</button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

/** "Bingo every Thursday at 8 PM on the bar TVs", with an optional countdown. Or a scene at a time. */
export function SchedulesCard({ games, displays }: { games: Game[]; displays: Display[] }) {
  const schedules = useLoad(api.schedules);
  const scenes = useLoad(api.scenes);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Schedule>({ id: "", kind: "game", days: [5, 6], time: "20:00", enabled: true, countdownMinutes: 5 });
  const [err, setErr] = useState("");
  const groups = [...new Set(displays.map((d) => d.group).filter(Boolean))] as string[];
  const gameName = (id?: string) => games.find((g) => g.id === id)?.context.game.displayName ?? id;
  const sceneName = (id?: string) => scenes.data?.scenes.find((s) => s.id === id)?.name ?? id;
  const save = async () => {
    setErr("");
    try {
      const what = form.kind === "game" ? gameName(form.gameId) : sceneName(form.sceneId);
      await api.saveSchedule({ ...form, id: form.id || slug(`${what}-${form.time}`) });
      setAdding(false);
      void schedules.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Schedules</h2>
      <p className="muted">Start a game on the TVs, or apply a scene, at a set time (venue time zone).</p>
      {(schedules.data?.schedules ?? []).map((s) => (
        <div key={s.id} className="row">
          <div>
            <b>{s.kind === "game" ? gameName(s.gameId) : sceneName(s.sceneId)}</b>
            <small>
              {s.days.map((d) => DAYS[d]).join(", ")} at {s.time}
              {s.kind === "game" ? ` · ${s.displayIds?.length ? `${s.displayIds.length} TV(s)` : s.group}` : " · scene"}
              {s.countdownMinutes ? ` · ${s.countdownMinutes} min countdown` : ""}
              {s.enabled ? "" : " · paused"}
            </small>
          </div>
          <div className="buttons">
            <button onClick={() => void api.saveSchedule({ ...s, enabled: !s.enabled }).then(() => schedules.reload())}>{s.enabled ? "Pause" : "Resume"}</button>
            <button className="danger" onClick={() => void api.deleteSchedule(s.id).then(() => schedules.reload())}>
              Delete
            </button>
          </div>
        </div>
      ))}
      {!adding ? (
        <button className="ghost" onClick={() => setAdding(true)}>
          + New schedule
        </button>
      ) : (
        <div className="media schedule-form">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "game" | "scene" })}>
            <option value="game">Start a game</option>
            <option value="scene">Apply a scene</option>
          </select>
          {form.kind === "game" ? (
            <>
              <select value={form.gameId ?? ""} onChange={(e) => setForm({ ...form, gameId: e.target.value })}>
                <option value="">Game…</option>
                {games
                  .filter((g) => g.enabled && !isApp(g.manifest) && g.manifest.commands.includes("create_room"))
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.context.game.displayName}
                    </option>
                  ))}
              </select>
              <select
                value={form.group ? `group:${form.group}` : (form.displayIds?.[0] ?? "")}
                onChange={(e) => setForm(e.target.value.startsWith("group:") ? { ...form, group: e.target.value.slice(6), displayIds: undefined } : { ...form, displayIds: e.target.value ? [e.target.value] : undefined, group: undefined })}
              >
                <option value="">TVs…</option>
                {groups.map((g) => (
                  <option key={g} value={`group:${g}`}>
                    Group: {g}
                  </option>
                ))}
                {displays.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label || d.name}
                  </option>
                ))}
              </select>
              <label>
                Countdown before (minutes, 0 = none)
                <input type="number" min={0} max={120} value={form.countdownMinutes ?? 0} onChange={(e) => setForm({ ...form, countdownMinutes: Number(e.target.value) || undefined })} />
              </label>
            </>
          ) : (
            <select value={form.sceneId ?? ""} onChange={(e) => setForm({ ...form, sceneId: e.target.value })}>
              <option value="">Scene…</option>
              {(scenes.data?.scenes ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <div className="field">
            <span>Days</span>
            <div className="day-picks" role="group" aria-label="Days">
              {DAYS.map((d, i) => {
                const on = form.days.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    className={`day-pick${on ? " on" : ""}`}
                    aria-pressed={on}
                    onClick={() => setForm({ ...form, days: on ? form.days.filter((x) => x !== i) : [...form.days, i].sort() })}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
          <label>
            Time
            <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
          </label>
          <div className="buttons">
            <button className="primary" onClick={() => void save()}>
              Save schedule
            </button>
            <button onClick={() => setAdding(false)}>Cancel</button>
          </div>
          {err && <p className="error">{err}</p>}
        </div>
      )}
    </section>
  );
}
