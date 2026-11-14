// Scenes ("Game night", "Closing time") and scheduled sessions (SDK 0.9.0 box features).

import { isApp } from "@bargames/sdk";
import { useEffect, useState } from "react";
import { api, type Closing, type Display, type Game, type Scene, type SceneAction, type Schedule } from "../api";
import { inputLabel } from "./Displays";
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
            + Add "Closing time" (ends rooms, stops the music, says goodnight; leaves the TVs alone)
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
          scenes={list}
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

/** One TV's part of a scene, in the order the box runs it: power on, what it shows, power off. */
export function tvActions(displayId: string, show: string, power: string, channel: string, appName?: (id: string) => string | undefined): SceneAction[] {
  const out: SceneAction[] = [];
  if (power === "on") out.push({ displayId, do: "power", on: true });
  if (power !== "off" && show) {
    if (show === "idle" || show === "off") out.push({ displayId, do: show });
    else if (show.startsWith("game:")) out.push({ displayId, do: "game", gameId: show.slice(5) });
    else if (show.startsWith("input:")) out.push({ displayId, do: "input", input: show.slice(6) });
    else if (show.startsWith("app:")) {
      const n = appName?.(show.slice(4));
      out.push({ displayId, do: "app", appId: show.slice(4), ...(n ? { appName: n } : {}) });
    } else if (show === "channel" && channel.trim()) out.push({ displayId, do: "channel", channel: channel.trim() });
  }
  if (power === "off") out.push({ displayId, do: "power", on: false });
  return out;
}

function SceneEditor({ games, displays, scenes, onDone }: { games: Game[]; displays: Display[]; scenes: Scene[]; onDone: () => void }) {
  // Box 0.16.0 extras and sequences.
  const [stopSound, setStopSound] = useState(false);
  const [clearAnn, setClearAnn] = useState(false);
  const [clearCd, setClearCd] = useState(false);
  const [nextId, setNextId] = useState("");
  const [nextMin, setNextMin] = useState(15);
  const [name, setName] = useState("");
  const [pick, setPick] = useState<Record<string, string>>({});
  const [power, setPower] = useState<Record<string, string>>({});
  const [channel, setChannel] = useState<Record<string, string>>({});
  const [apps, setApps] = useState<Record<string, { id: string; name: string }[]>>({});
  const [endRooms, setEndRooms] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const castable = games.filter((g) => g.enabled && g.manifest.routes.table);
  // The TVs' own apps (Roku channels, Apple TV apps), for "open an app" steps.
  useEffect(() => {
    for (const d of displays.filter((x) => x.capabilities?.apps && x.health?.online !== false)) {
      api.tvApps(d.id).then(
        (r) => setApps((a) => ({ ...a, [d.id]: r.apps })),
        () => undefined,
      );
    }
  }, [displays]);
  const save = async () => {
    const actions = displays.flatMap((d) => tvActions(d.id, pick[d.id] ?? "", power[d.id] ?? "", channel[d.id] ?? "", (id) => apps[d.id]?.find((a) => a.id === id)?.name));
    try {
      await api.saveScene({
        id: slug(name),
        name,
        actions,
        ...(endRooms ? { endRooms: true } : {}),
        ...(text.trim() ? { announcement: { text: text.trim() } } : clearAnn ? { clearAnnouncement: true } : {}),
        ...(stopSound ? { stopSound: true } : {}),
        ...(clearCd ? { clearCountdown: true } : {}),
        ...(nextId ? { next: { sceneId: nextId, afterMinutes: nextMin } } : {}),
      } as Scene);
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
      {displays.map((d) => {
        const caps = d.capabilities;
        const off = power[d.id] === "off";
        return (
          <fieldset key={d.id} className="scene-tv">
            <legend>{d.label || d.name}</legend>
            {caps?.power && (
              <label>
                Power
                <select value={power[d.id] ?? ""} onChange={(e) => setPower({ ...power, [d.id]: e.target.value })}>
                  <option value="">Leave as it is</option>
                  <option value="on">Turn on first</option>
                  <option value="off">Turn off</option>
                </select>
              </label>
            )}
            <label>
              What it shows
              <select value={off ? "" : (pick[d.id] ?? "")} disabled={off} onChange={(e) => setPick({ ...pick, [d.id]: e.target.value })}>
                <option value="">Leave alone</option>
                <optgroup label="From the box">
                  {castable.map((g) => (
                    <option key={g.id} value={`game:${g.id}`}>
                      {g.context.game.displayName}
                      {isApp(g.manifest) ? "" : " (new room)"}
                    </option>
                  ))}
                  <option value="idle">Idle screen</option>
                  <option value="off">Stop casting</option>
                </optgroup>
                {(caps?.inputs.length ?? 0) > 0 && (
                  <optgroup label="TV input">
                    {caps!.inputs.map((i) => (
                      <option key={i} value={`input:${i}`}>
                        {inputLabel(i, d.driver)}
                      </option>
                    ))}
                  </optgroup>
                )}
                {caps?.tvChannels && (
                  <optgroup label="TV channel (antenna)">
                    <option value="channel">A channel number…</option>
                  </optgroup>
                )}
                {caps?.apps && (apps[d.id]?.length ?? 0) > 0 && (
                  <optgroup label={d.driver === "roku" ? "Roku channel (app)" : "App on the TV"}>
                    {apps[d.id]!.map((a) => (
                      <option key={a.id} value={`app:${a.id}`}>
                        {a.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            {!off && pick[d.id] === "channel" && (
              <label>
                Channel
                <input inputMode="decimal" placeholder="e.g. 7.1" value={channel[d.id] ?? ""} onChange={(e) => setChannel({ ...channel, [d.id]: e.target.value.replace(/[^\d.]/g, "").slice(0, 8) })} />
              </label>
            )}
            {caps?.control && !caps.control.paired && <p className="muted small-print">Pair its TV control (TV panel &gt; Setup) to add power, inputs or apps here.</p>}
          </fieldset>
        );
      })}
      <label className="inline">
        <input type="checkbox" checked={endRooms} onChange={(e) => setEndRooms(e.target.checked)} style={{ width: "auto" }} /> End every open room first
      </label>
      <label className="inline">
        <input type="checkbox" checked={stopSound} onChange={(e) => setStopSound(e.target.checked)} style={{ width: "auto" }} /> Stop all sound (music, apps)
      </label>
      <label>
        Announcement (optional)
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {!text.trim() && (
        <label className="inline">
          <input type="checkbox" checked={clearAnn} onChange={(e) => setClearAnn(e.target.checked)} style={{ width: "auto" }} /> Take the announcement down
        </label>
      )}
      <label className="inline">
        <input type="checkbox" checked={clearCd} onChange={(e) => setClearCd(e.target.checked)} style={{ width: "auto" }} /> Clear the countdown
      </label>
      <label>
        Then (a sequence, optional)
        <div className="inline">
          <select value={nextId} onChange={(e) => setNextId(e.target.value)} aria-label="Scene to apply next">
            <option value="">Nothing after this</option>
            {scenes.map((s) => (
              <option key={s.id} value={s.id}>
                apply {s.name}
              </option>
            ))}
          </select>
          {nextId && (
            <select value={nextMin} onChange={(e) => setNextMin(Number(e.target.value))} aria-label="After how long">
              {[1, 5, 10, 15, 20, 30, 45, 60, 90, 120].map((m) => (
                <option key={m} value={m}>
                  {m} min later
                </option>
              ))}
            </select>
          )}
        </div>
      </label>
      <p className="muted small-print">TVs left on "Leave alone" aren't touched, so a scene can skip a TV that's showing something else (an Apple TV on input 1, say).</p>
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

const NIGHTS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fmt12 = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/**
 * Box 0.16.0: closing time. A time per night and the scene (or the first scene of a
 * sequence) to run then. After-midnight times belong to the night before.
 */
export function ClosingCard() {
  const closing = useLoad(api.closing);
  const scenes = useLoad(api.scenes);
  const [form, setForm] = useState<Closing | undefined>();
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (closing.data && !form) setForm(closing.data);
  }, [closing.data, form]);
  const list = scenes.data?.scenes ?? [];
  if (!form)
    return (
      <section className="card">
        <h2>Closing time</h2>
        <p className="muted">{closing.error || "…"}</p>
      </section>
    );
  const save = async (next: Closing) => {
    setMsg("");
    try {
      setForm(await api.saveClosing(next));
      setMsg("Saved.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const scene = list.find((s) => s.id === form.sceneId);
  return (
    <section className="card">
      <h2>Closing time</h2>
      <p className="muted">At closing time each night the box applies a scene: end the games, stop the music, say goodnight, whatever the scene does. It only touches the TVs the scene names. A time after midnight counts as the night before (Friday at 2:00 AM is early Saturday).</p>
      <label>
        Scene to apply
        <select value={form.sceneId ?? ""} onChange={(e) => setForm({ ...form, sceneId: e.target.value || undefined })}>
          <option value="">Pick a scene…</option>
          {list.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.next ? ` (then ${list.find((x) => x.id === s.next!.sceneId)?.name ?? s.next.sceneId} ${s.next.afterMinutes} min later)` : ""}
            </option>
          ))}
        </select>
      </label>
      {!list.length && <p className="muted small-print">Make a scene first (Tonight → Scenes), for example "Closing time".</p>}
      <div className="closing-nights">
        {NIGHTS.map((n, i) => (
          <label key={n} className="inline">
            <span className="closing-night">{n} night</span>
            <input type="time" value={form.nights[i] ?? ""} onChange={(e) => setForm({ ...form, nights: form.nights.map((t, j) => (j === i ? e.target.value : t)) })} aria-label={`${n} night closing time`} />
            {form.nights[i] && (
              <button type="button" className="ghost" onClick={() => setForm({ ...form, nights: form.nights.map((t, j) => (j === i ? "" : t)) })}>
                Not this night
              </button>
            )}
          </label>
        ))}
      </div>
      <label className="inline">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} style={{ width: "auto" }} /> On
      </label>
      <div className="buttons">
        <button className="primary" onClick={() => void save(form)}>
          Save
        </button>
        {scene && (
          <button
            className="danger"
            onClick={() =>
              window.confirm(`Apply ${scene.name} now?${scene.endRooms ? " It ends every open room." : ""}`) &&
              void api.applyScene(scene.id).then(
                () => setMsg(`${scene.name} applied.`),
                (e: Error) => setMsg(e.message),
              )
            }
          >
            Run it now
          </button>
        )}
      </div>
      {form.enabled && scene && (
        <p className="muted">
          {form.nights
            .map((t, i) => (t ? `${NIGHTS[i].slice(0, 3)} ${fmt12(t)}` : ""))
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {msg && <p className="muted">{msg}</p>}
    </section>
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
