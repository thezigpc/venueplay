// Scenes ("Game night", "Closing time") and scheduled sessions (SDK 0.9.0 box features).
// Box 0.26.0: a scene is a list of steps; a TV step acts on several TVs at once.

import { isApp } from "@bargames/sdk";
import { useEffect, useState } from "react";
import { api, type Closing, type Display, type Game, type HostMode, type Scene, type SceneRun, type SceneStep, type Schedule } from "../api";
import { go } from "../nav";
import { inputLabel } from "./Displays";
import { useLoad } from "../useLoad";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "scene";

type TvStep = Extract<SceneStep, { tvs: string[] }>;
const isTvStep = (s: SceneStep): s is TvStep => "tvs" in s;
const endsRooms = (s: Scene) => s.steps.some((x) => x.do === "endRooms");
const tvName = (displays: Display[], id: string) => {
  const d = displays.find((x) => x.id === id);
  return d ? d.label || d.name : id;
};
const duration = (s: number) => (s < 60 ? `${s} s` : s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`);
const WAITS = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600];

/** Which TVs can take a step (power needs the TV's remote, an input needs that input…). */
function canTake(d: Display, step: SceneStep): boolean {
  const c = d.capabilities;
  if (step.do === "power") return Boolean(c?.power);
  if (step.do === "input") return Boolean(c?.inputs.includes(step.input));
  if (step.do === "app") return Boolean(c?.apps);
  if (step.do === "channel") return Boolean(c?.tvChannels);
  return isTvStep(step);
}

/** One line per step, for the list and the summary. */
export function describeStep(step: SceneStep, displays: Display[], games: Game[]): string {
  const gameName = (id: string) => games.find((g) => g.id === id)?.context.game.displayName ?? id;
  const on = isTvStep(step) ? (step.tvs.length ? step.tvs.map((t) => tvName(displays, t)).join(", ") : "no TVs yet") : "";
  switch (step.do) {
    case "wait":
      return `Wait ${duration(step.seconds)}`;
    case "power":
      return `Turn ${step.on ? "on" : "off"}: ${on}`;
    case "input":
      return `Switch to ${inputLabel(step.input, displays.find((d) => step.tvs.includes(d.id))?.driver)}: ${on}`;
    case "app":
      return `Open ${step.appName ?? step.appId}: ${on}`;
    case "channel":
      return `Channel ${step.channel}: ${on}`;
    case "game":
      return `${gameName(step.gameId)}${step.tvs.length > 1 ? " (one room on all)" : ""}${step.host ? ", host controls" : ""}: ${on}`;
    case "media":
      return `${gameName(step.gameId)} list: ${on}`;
    case "idle":
      return `Idle screen: ${on}`;
    case "off":
      return `Stop casting: ${on}`;
    case "endRooms":
      return "End every open room";
    case "announce":
      return `Announcement: "${step.text}"${step.minutes ? ` for ${step.minutes} min` : ""}`;
    case "clearAnnouncement":
      return "Take the announcement down";
    case "countdown":
      return `Countdown: ${step.label}, ${step.minutes} min`;
    case "clearCountdown":
      return "Clear the countdown";
    case "stopSound":
      return "Stop all sound (music, apps)";
  }
}

/** "4 steps · 15 s of waits · 3 TVs". */
export function sceneSummary(s: Scene): string {
  const waits = s.steps.reduce((t, x) => t + (x.do === "wait" ? x.seconds : 0), 0);
  const tvs = new Set(s.steps.flatMap((x) => (isTvStep(x) ? x.tvs : [])));
  return [`${s.steps.length} step${s.steps.length === 1 ? "" : "s"}`, waits ? `${duration(waits)} of waits` : "", tvs.size ? `${tvs.size} TV${tvs.size === 1 ? "" : "s"}` : "no TVs", s.next ? "then another scene" : ""].filter(Boolean).join(" · ");
}

const ADD: { kind: string; label: string }[] = [
  { kind: "power-on", label: "Turn TVs on" },
  { kind: "power-off", label: "Turn TVs off" },
  { kind: "input", label: "Switch the TV input" },
  { kind: "game", label: "Show a game or app (from the box)" },
  { kind: "idle", label: "Idle screen" },
  { kind: "off", label: "Stop casting" },
  { kind: "app", label: "Open an app on the TV (Roku, Apple TV)" },
  { kind: "channel", label: "TV channel (antenna)" },
  { kind: "wait", label: "Wait" },
  { kind: "announce", label: "Post an announcement" },
  { kind: "clearAnnouncement", label: "Take the announcement down" },
  { kind: "countdown", label: "Start a countdown" },
  { kind: "clearCountdown", label: "Clear the countdown" },
  { kind: "endRooms", label: "End every open room" },
  { kind: "stopSound", label: "Stop all sound" },
];

function newStep(kind: string, displays: Display[], castable: Game[]): SceneStep {
  const inputs = displays.flatMap((d) => d.capabilities?.inputs ?? []);
  switch (kind) {
    case "power-on":
    case "power-off":
      return { do: "power", on: kind === "power-on", tvs: displays.filter((d) => d.capabilities?.power).map((d) => d.id) };
    case "input":
      return { do: "input", input: inputs[0] ?? "hdmi1", tvs: [] };
    case "game":
      return { do: "game", gameId: castable[0]?.id ?? "", tvs: [] };
    case "idle":
    case "off":
      return { do: kind, tvs: [] };
    case "app":
      return { do: "app", appId: "", tvs: [] };
    case "channel":
      return { do: "channel", channel: "", tvs: [] };
    case "wait":
      return { do: "wait", seconds: 5 };
    case "announce":
      return { do: "announce", text: "" };
    case "countdown":
      return { do: "countdown", label: "Starting soon", minutes: 5 };
    default:
      return { do: kind as "endRooms" | "clearAnnouncement" | "clearCountdown" | "stopSound" };
  }
}

/** What's missing before a step can be saved ("" when it's fine). */
function stepProblem(step: SceneStep): string {
  if (isTvStep(step) && !step.tvs.length) return "Pick at least one TV.";
  if (step.do === "game" && !step.gameId) return "Pick a game or app.";
  if (step.do === "app" && !step.appId) return "Pick an app.";
  if (step.do === "channel" && !/^\d{1,4}(\.\d{1,3})?$/.test(step.channel)) return "A channel number, like 7 or 7.1.";
  if (step.do === "announce" && !step.text.trim()) return "Write the announcement.";
  if (step.do === "countdown" && !step.label.trim()) return "Give the countdown a label.";
  return "";
}

/** Starting points for a new scene. */
function templates(displays: Display[], castable: Game[], preset?: Scene): { id: string; label: string; scene: () => Scene }[] {
  const power = displays.filter((d) => d.capabilities?.power).map((d) => d.id);
  const all = displays.map((d) => d.id);
  const firstGame = castable.find((g) => !isApp(g.manifest)) ?? castable[0];
  return [
    { id: "blank", label: "Blank", scene: () => ({ id: "", name: "", steps: [] }) },
    ...(power.length ? [{ id: "on", label: "Turn every TV on", scene: () => ({ id: "", name: "TVs on", steps: [{ do: "power", on: true, tvs: power }] as SceneStep[] }) }] : []),
    {
      id: "night",
      label: "Game night: TVs on, wait, then a game",
      scene: () => ({
        id: "",
        name: "Game night",
        steps: [...(power.length ? ([{ do: "power", on: true, tvs: power }, { do: "wait", seconds: 10 }] as SceneStep[]) : []), { do: "game", gameId: firstGame?.id ?? "", tvs: all }],
      }),
    },
    ...(power.length ? [{ id: "off", label: "Turn every TV off", scene: () => ({ id: "", name: "TVs off", steps: [{ do: "power", on: false, tvs: power }] as SceneStep[] }) }] : []),
    ...(preset ? [{ id: "closing", label: "Closing time (ends rooms, stops the music, says goodnight)", scene: () => ({ ...preset, id: "", steps: structuredClone(preset.steps) }) }] : []),
  ];
}

/** Saved TV layouts, applied with one tap. "Closing time" is a built-in preset. */
export function ScenesCard({ games, displays: allDisplays }: { games: Game[]; displays: Display[] }) {
  const displays = allDisplays.filter((d) => !d.ignored);
  const scenes = useLoad(api.scenes);
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState<{ scene: Scene; isNew: boolean }>();
  const [running, setRunning] = useState<SceneRun>();
  const [hostOffer, setHostOffer] = useState<SceneRun["host"]>();
  const list = scenes.data?.scenes ?? [];
  const preset = scenes.data?.presets.find((p) => p.id === "closing-time");
  const castable = games.filter((g) => g.enabled && g.manifest.routes.table);
  const finish = (r: SceneRun) => {
    setRunning(undefined);
    const bad = r.steps.filter((x) => !x.ok);
    setMsg(bad.length ? `${r.name}: ${bad.length} step(s) didn't work: ${bad.map((x) => `${x.step}${x.message ? ` (${x.message})` : ""}`).join("; ")}` : `${r.name} applied.`);
    // Box 0.20.0: this device applied it, so it gets the room's host controls.
    if (r.host && !r.cancelled) {
      if (r.host.mode === "open") openHost(r.host);
      else setHostOffer(r.host);
    }
  };
  const apply = async (s: Scene) => {
    if (endsRooms(s) && !window.confirm(`${s.name}: this ends every open room. Go ahead?`)) return;
    setMsg(`Applying ${s.name}…`);
    setHostOffer(undefined);
    try {
      let r = await api.applyScene(s.id);
      while (!r.finished) {
        setRunning(r);
        setMsg("");
        await new Promise((ok) => setTimeout(ok, 2000));
        r = await api.sceneRun(r.id);
      }
      finish(r);
    } catch (e) {
      setRunning(undefined);
      setMsg((e as Error).message);
    }
  };
  const startNew = (templateId: string) => {
    const t = templates(displays, castable, preset).find((x) => x.id === templateId);
    if (t) setEditing({ scene: t.scene(), isNew: true });
  };
  return (
    <section className="card">
      <h2>Scenes</h2>
      <p className="muted">Saved TV setups, applied in one tap.</p>
      {!editing && (
        <div className="scene-list">
          {list.map((s) => (
            <div key={s.id} className="scene-row">
              <button className={endsRooms(s) ? "danger" : "primary"} onClick={() => void apply(s)}>
                {s.name}
              </button>
              <span className="muted small-print">{sceneSummary(s)}</span>
              <span className="scene-row-tools">
                <button type="button" className="ghost small" onClick={() => setEditing({ scene: structuredClone(s), isNew: false })}>
                  Edit
                </button>
                <button type="button" className="ghost small" onClick={() => setEditing({ scene: { ...structuredClone(s), id: "", name: `${s.name} copy`.slice(0, 40) }, isNew: true })}>
                  Copy
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {editing ? (
        <SceneEditor
          key={editing.scene.id || "new"}
          initial={editing.scene}
          isNew={editing.isNew}
          games={games}
          displays={displays}
          scenes={list}
          onDone={(saved, run) => {
            setEditing(undefined);
            void scenes.reload();
            if (saved && run) void apply(saved);
          }}
        />
      ) : (
        <label className="inline">
          <span>+ New scene</span>
          <select value="" onChange={(e) => startNew(e.target.value)} aria-label="Start a new scene from">
            <option value="">Start from…</option>
            {templates(displays, castable, list.some((s) => s.id === "closing-time") ? undefined : preset).map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {running && (
        <p className="scene-run" role="status">
          {running.name}: step {running.done} of {running.total}
          {running.current?.startsWith("waiting") ? ` (${running.current})` : ""}…{" "}
          <button type="button" className="ghost" onClick={() => void api.cancelSceneRun(running.id)}>
            Cancel the rest
          </button>
        </p>
      )}
      {hostOffer && (
        <p>
          <button type="button" className="primary" onClick={() => openHost(hostOffer)}>
            Host {hostOffer.name}
            {hostOffer.code ? ` ${hostOffer.code}` : ""}
          </button>{" "}
          <button type="button" className="ghost" onClick={() => setHostOffer(undefined)}>
            Not now
          </button>
        </p>
      )}
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}

/** Box 0.20.0: host controls open inside the admin, with a way back (same window, also on a home-screen iPad). */
export function openHost(h: { name: string; code?: string; url: string }): void {
  go("tonight", "host", h.url, `${h.name}${h.code ? ` · ${h.code}` : ""}`);
}

function SceneEditor({ initial, isNew, games, displays, scenes, onDone }: { initial: Scene; isNew: boolean; games: Game[]; displays: Display[]; scenes: Scene[]; onDone: (saved?: Scene, run?: boolean) => void }) {
  const [name, setName] = useState(initial.name);
  const [steps, setSteps] = useState<SceneStep[]>(initial.steps);
  const [nextId, setNextId] = useState(initial.next?.sceneId ?? "");
  const [nextMin, setNextMin] = useState(initial.next?.afterMinutes ?? 15);
  const [apps, setApps] = useState<Record<string, { id: string; name: string }[]>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
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
  const change = (i: number, step: SceneStep) => setSteps(steps.map((s, j) => (j === i ? step : s)));
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  };
  const problems = steps.map(stepProblem);
  const id = isNew ? (() => {
    const base = slug(name);
    let out = base;
    for (let n = 2; scenes.some((s) => s.id === out); n++) out = `${base.slice(0, 36)}-${n}`;
    return out;
  })() : initial.id;
  const save = async (run: boolean) => {
    setErr("");
    setBusy(true);
    try {
      const saved = await api.saveScene({ id, name: name.trim(), steps, ...(nextId ? { next: { sceneId: nextId, afterMinutes: nextMin } } : {}) });
      onDone(saved, run);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const draft: Scene = { id, name, steps, ...(nextId ? { next: { sceneId: nextId, afterMinutes: nextMin } } : {}) };
  return (
    <div className="media scene-editor">
      <h3>{isNew ? "New scene" : `Edit ${initial.name}`}</h3>
      <label>
        Name
        <input value={name} placeholder="Game night" maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <p className="muted small-print">{sceneSummary(draft)}. Steps run top to bottom; a step's TVs all go at once.</p>
      <ol className="scene-steps">
        {steps.map((step, i) => (
          <li key={i} className="scene-step">
            <div className="scene-step-head">
              <strong>{describeStep(step, displays, games)}</strong>
              <span className="scene-row-tools">
                <button type="button" className="ghost small" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" className="ghost small" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button type="button" className="ghost small" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </span>
            </div>
            <StepFields step={step} onChange={(s) => change(i, s)} displays={displays} castable={castable} apps={apps} games={games} />
            {problems[i] && <p className="error small-print">{problems[i]}</p>}
          </li>
        ))}
      </ol>
      {!steps.length && <p className="muted">No steps yet. Add the first one below.</p>}
      <label>
        Add a step
        <select value="" onChange={(e) => e.target.value && setSteps([...steps, newStep(e.target.value, displays, castable)])}>
          <option value="">Pick what happens next…</option>
          {ADD.map((a) => (
            <option key={a.kind} value={a.kind}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Then (a sequence, optional)
        <div className="inline">
          <select value={nextId} onChange={(e) => setNextId(e.target.value)} aria-label="Scene to apply next">
            <option value="">Nothing after this</option>
            {scenes
              .filter((s) => s.id !== id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  apply {s.name}
                </option>
              ))}
          </select>
          {nextId && (
            <select value={nextMin} onChange={(e) => setNextMin(Number(e.target.value))} aria-label="After how long">
              {[...new Set([1, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, nextMin])].sort((a, b) => a - b).map((m) => (
                <option key={m} value={m}>
                  {m} min later
                </option>
              ))}
            </select>
          )}
        </div>
      </label>
      <p className="muted small-print">TVs a scene doesn't name aren't touched, so a scene can skip a TV that's showing something else. For "switch the TV to input 1, then cast to the Apple TV": an input step, a short wait, then the game step.</p>
      <div className="buttons">
        <button className="primary" disabled={busy || !name.trim() || problems.some(Boolean)} onClick={() => void save(false)}>
          Save
        </button>
        <button disabled={busy || !name.trim() || !steps.length || problems.some(Boolean)} onClick={() => void save(true)}>
          Save and run it
        </button>
        <button onClick={() => onDone()}>Cancel</button>
        {!isNew && (
          <button
            className="danger"
            onClick={() => window.confirm(`Delete ${initial.name}?`) && void api.deleteScene(initial.id).then(() => onDone(), (e: Error) => setErr(e.message))}
          >
            Delete
          </button>
        )}
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

/** The settings of one step: what it does, and (TV steps) which TVs. */
function StepFields({ step, onChange, displays, castable, apps, games }: { step: SceneStep; onChange: (s: SceneStep) => void; displays: Display[]; castable: Game[]; apps: Record<string, { id: string; name: string }[]>; games: Game[] }) {
  if (step.do === "wait")
    return (
      <label className="inline">
        Wait
        <select value={step.seconds} onChange={(e) => onChange({ ...step, seconds: Number(e.target.value) })}>
          {[...new Set([...WAITS, step.seconds])].sort((a, b) => a - b).map((s) => (
            <option key={s} value={s}>
              {duration(s)}
            </option>
          ))}
        </select>
      </label>
    );
  if (step.do === "announce")
    return (
      <>
        <label>
          Announcement
          <input value={step.text} maxLength={200} placeholder="Bingo starts in 10 minutes!" onChange={(e) => onChange({ ...step, text: e.target.value })} />
        </label>
        <label className="inline">
          Stays up
          <select value={step.minutes ?? 0} onChange={(e) => onChange({ ...step, minutes: Number(e.target.value) || undefined })}>
            <option value={0}>until taken down</option>
            {[5, 10, 15, 30, 60, 120, 240].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
      </>
    );
  if (step.do === "countdown")
    return (
      <div className="inline">
        <label>
          Label
          <input value={step.label} maxLength={60} onChange={(e) => onChange({ ...step, label: e.target.value })} />
        </label>
        <label>
          Minutes
          <input type="number" min={1} max={180} value={step.minutes} onChange={(e) => onChange({ ...step, minutes: Math.max(1, Math.min(180, Number(e.target.value) || 1)) })} />
        </label>
      </div>
    );
  if (!isTvStep(step)) return null;

  const fit = (s: SceneStep): SceneStep => (isTvStep(s) ? { ...s, tvs: s.tvs.filter((t) => displays.some((d) => d.id === t && canTake(d, s))) } : s);
  const inputs = [...new Set(displays.flatMap((d) => d.capabilities?.inputs ?? []))];
  const appList = [...new Map(Object.values(apps).flat().map((a) => [a.id, a])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const eligible = displays.filter((d) => canTake(d, step));
  const others = displays.length - eligible.length;
  const toggle = (id: string, on: boolean) => onChange({ ...step, tvs: on ? [...step.tvs.filter((t) => t !== id), id] : step.tvs.filter((t) => t !== id) });
  return (
    <>
      {step.do === "power" && (
        <label className="inline">
          Power
          <select value={step.on ? "on" : "off"} onChange={(e) => onChange({ ...step, on: e.target.value === "on" })}>
            <option value="on">Turn on</option>
            <option value="off">Turn off</option>
          </select>
        </label>
      )}
      {step.do === "input" && (
        <label className="inline">
          Input
          <select value={step.input} onChange={(e) => onChange(fit({ ...step, input: e.target.value }))}>
            {[...new Set([...inputs, step.input])].map((i) => (
              <option key={i} value={i}>
                {inputLabel(i, displays.find((d) => d.capabilities?.inputs.includes(i))?.driver)}
              </option>
            ))}
          </select>
        </label>
      )}
      {step.do === "game" && (
        <>
          <label className="inline">
            Show
            <select value={step.gameId} onChange={(e) => onChange({ ...step, gameId: e.target.value })}>
              {!step.gameId && <option value="">Pick a game or app…</option>}
              {castable.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.context.game.displayName}
                  {isApp(g.manifest) ? "" : " (new room)"}
                </option>
              ))}
              {step.gameId && !castable.some((g) => g.id === step.gameId) && <option value={step.gameId}>{games.find((g) => g.id === step.gameId)?.context.game.displayName ?? step.gameId} (turned off)</option>}
            </select>
          </label>
          <label className="inline">
            Host controls
            <select value={step.host ?? ""} onChange={(e) => onChange({ ...step, host: (e.target.value || undefined) as HostMode | undefined })}>
              <option value="">Don't open them</option>
              <option value="open">Open them on the device that runs the scene</option>
              <option value="ask">Ask first ("Host Bingo ABCD?")</option>
            </select>
          </label>
        </>
      )}
      {step.do === "app" && (
        <label className="inline">
          App
          <select value={step.appId} onChange={(e) => onChange({ ...step, appId: e.target.value, appName: appList.find((a) => a.id === e.target.value)?.name })}>
            {!step.appId && <option value="">{appList.length ? "Pick an app…" : "Loading the TVs' apps…"}</option>}
            {step.appId && !appList.some((a) => a.id === step.appId) && <option value={step.appId}>{step.appName ?? step.appId}</option>}
            {appList.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {step.do === "channel" && (
        <label className="inline">
          Channel
          <input inputMode="decimal" placeholder="e.g. 7.1" value={step.channel} onChange={(e) => onChange({ ...step, channel: e.target.value.replace(/[^\d.]/g, "").slice(0, 8) })} />
        </label>
      )}
      <div className="tv-chips" role="group" aria-label="TVs">
        {eligible.map((d) => (
          <label key={d.id} className={`tv-chip${step.tvs.includes(d.id) ? " on" : ""}`}>
            <input type="checkbox" checked={step.tvs.includes(d.id)} onChange={(e) => toggle(d.id, e.target.checked)} />
            {d.label || d.name}
          </label>
        ))}
        {eligible.length > 1 && (
          <button type="button" className="ghost small" onClick={() => onChange({ ...step, tvs: step.tvs.length === eligible.length ? [] : eligible.map((d) => d.id) })}>
            {step.tvs.length === eligible.length ? "None" : "All"}
          </button>
        )}
      </div>
      {!eligible.length && <p className="muted small-print">No TV can do this yet. Pair a TV's control (TVs → the TV → Setup) for power, inputs and apps.</p>}
      {eligible.length > 0 && others > 0 && step.do !== "game" && step.do !== "idle" && step.do !== "off" && <p className="muted small-print">{others} other TV{others === 1 ? "" : "s"} can't do this (no TV control paired, or no such input).</p>}
    </>
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
              window.confirm(`Apply ${scene.name} now?${endsRooms(scene) ? " It ends every open room." : ""}`) &&
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
