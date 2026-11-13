import { useEffect, useState } from "react";
import { isApp } from "@bargames/sdk";
import { MediaControls, useMediaItems } from "./MediaControls";
import { Remote, TvApps } from "./Remote";
import { go } from "../nav";
import { api, type CastSettings, type Display, type Game, type MediaProvider, type StartupRule, type StreamSettings } from "../api";

const PREVIEWS_KEY = "bargames.tvPreviews";
export const readPreviews = () => {
  try {
    return localStorage.getItem(PREVIEWS_KEY) !== "off";
  } catch {
    return true;
  }
};
import { useAction, useLoad } from "../useLoad";

export function DisplaysPage({ selected, tab }: { selected?: string; tab?: string }) {
  const displays = useLoad(api.displaysAll, 10_000);
  const startup = useLoad(api.tvStartup);
  const media = useLoad(api.media, 5000);
  const games = useLoad(api.games);
  const reloadAll = async () => {
    await Promise.all([displays.reload(), startup.reload()]);
  };
  const { busy, run } = useAction(reloadAll, displays.setError);
  const [adding, setAdding] = useState(false);
  const [group, setGroup] = useState("");
  const [note, setNote] = useState("");
  const [previews, setPreviews] = useState(readPreviews);
  const togglePreviews = (on: boolean) => {
    setPreviews(on);
    try {
      localStorage.setItem(PREVIEWS_KEY, on ? "on" : "off");
    } catch {
      /* this iPad only */
    }
  };
  const all = displays.data ?? [];
  const list = all.filter((d) => !d.ignored);
  const ignoredTvs = all.filter((d) => d.ignored);
  const groups = [...new Set(list.map((d) => d.group).filter(Boolean))] as string[];
  const shown = list.filter((d) => !group || d.group === group);
  const sel = list.find((d) => d.id === selected);
  const detachAll = () => {
    if (!window.confirm("Detach the box from every TV?\n\nIt stops everything the box casts and plays on them, including YouTube started from the box. TVs aren't switched off: they go back to their own home screen.")) return;
    run(async () => {
      const r = await api.detachAll();
      const failed = Object.keys(r.failed).length + r.media.filter((m) => !m.ok).length;
      setNote(`Detached from ${r.stopped.length} TV${r.stopped.length === 1 ? "" : "s"}.${failed ? ` ${failed} didn't answer; they'll stop when they reconnect.` : ""}`);
    });
  };
  const providers = media.data?.providers ?? [];

  return (
    <div className={`tv-layout${sel ? " has-panel" : ""}`}>
      <div className="tv-main">
        <div className="page-head">
          <h1>TVs</h1>
          <button type="button" disabled={busy || !list.length} onClick={() => run(async () => void (await api.idleTvs(), setNote("Every TV is on the idle screen.")))}>
            All to idle screen
          </button>
          <button type="button" disabled={busy || !all.length} onClick={detachAll}>
            Detach from all TVs
          </button>
          <button type="button" aria-expanded={adding} onClick={() => setAdding(!adding)}>
            Add a TV
          </button>
        </div>
        {note && <p className="muted">{note}</p>}
        {displays.error && <p className="error">{displays.error}</p>}
        {adding && (
          <div className="grid stack-gap">
            <AddTvCard busy={busy} run={run} setNote={setNote} previews={previews} togglePreviews={togglePreviews} hasStartup={Object.keys(startup.data ?? {}).length > 0} />
            <VenueboxCard reload={displays.reload} />
            <CastFromGames />
          </div>
        )}
        {groups.length > 0 && (
          <div className="chips" role="group" aria-label="Filter by room">
            <button type="button" className={`chip${group ? "" : " on"}`} aria-pressed={!group} onClick={() => setGroup("")}>
              All · {list.length}
            </button>
            {groups.map((g) => (
              <button key={g} type="button" className={`chip${group === g ? " on" : ""}`} aria-pressed={group === g} onClick={() => setGroup(g)}>
                {g} · {list.filter((d) => d.group === g).length}
              </button>
            ))}
          </div>
        )}
        <div className="tv-wall">
          {shown.map((d) => (
            <TvTile key={d.id} d={d} media={providers} previews={previews} selected={d.id === sel?.id} onClick={() => go("tvs", d.id)} />
          ))}
        </div>
        {displays.data && !all.length && <p className="muted">No TVs yet. Use "Add a TV" to find the Rokus and Apple TVs on this network.</p>}
        {ignoredTvs.length > 0 && (
          <details className="ignored-tvs">
            <summary>
              Ignored TVs · {ignoredTvs.length}
            </summary>
            <p className="muted small-print">The box leaves these alone: it doesn't check on them, cast to them or use them in scenes. Their names, rooms and pairings are kept.</p>
            {ignoredTvs.map((d) => (
              <div key={d.id} className="game-row">
                <div className="game-main">
                  <b>{d.label || d.name}</b>
                  <div className="muted game-sub">{[d.group, kindOf(d)].filter(Boolean).join(" · ")}</div>
                </div>
                <button type="button" disabled={busy} onClick={() => run(async () => void (await api.ignoreDisplay(d.id, false), setNote(`${d.label || d.name} is back.`)))}>
                  Stop ignoring
                </button>
              </div>
            ))}
          </details>
        )}
        {list.length > 0 && !sel && <p className="muted small-print">Tap a TV to control it.</p>}
      </div>
      {sel && (
        <TvPanel key={sel.id} d={sel} tab={tab} busy={busy} run={run} reload={displays.reload} previews={previews} startup={startup.data?.[sel.id]} games={games.data ?? []} media={providers} reloadMedia={media.reload} />
      )}
    </div>
  );
}

const STREAM_LABEL: Record<string, string> = {
  streaming: "casting",
  connecting: "connecting…",
  pin_required: "waiting for its AirPlay code",
  dropped: "lost connection, retrying",
  error: "error",
};

/** One line on what a TV shows now, and whether that needs attention. */
export function describeTv(d: Display, media: MediaProvider[] = []): { text: string; warn: boolean } {
  if (d.health?.online === false) return { text: "Not answering", warn: true };
  const target = media.flatMap((p) => p.targets.filter((t) => t.displayId === d.id).map((t) => ({ p, t }))).find((x) => ["playing", "paused", "starting"].includes(x.t.state));
  if (target) return { text: `${target.p.displayName}${target.t.nowPlaying?.listName ? ` · ${target.t.nowPlaying.listName}` : ""} · ${target.t.state}`, warn: false };
  if (d.stream) {
    const state = d.stream.state === "streaming" ? "" : ` · ${STREAM_LABEL[d.stream.state] ?? d.stream.state}`;
    return { text: `${d.content?.kind === "idle" ? "Idle screen" : (d.content?.title ?? "Showing a page")}${state}`, warn: d.stream.state !== "streaming" && d.stream.state !== "connecting" };
  }
  if (d.content?.kind === "external") return { text: d.content.title ?? d.content.app ?? "A TV app", warn: false };
  if (d.content?.kind === "idle") return { text: "Idle screen", warn: false };
  return { text: "Nothing from the box", warn: false };
}

const kindOf = (d: Display) => (d.driver === "airplay" ? (d.model ? `AirPlay · ${d.model}` : "AirPlay") : d.driver === "venuebox" ? "Venuebox app" : (d.model ?? d.driver));

/** A TV on the wall: what it shows (a live picture when the box is casting to it), name, room. */
export function TvTile({ d, media, previews, selected, onClick, children }: { d: Display; media: MediaProvider[]; previews: boolean; selected?: boolean; onClick?: () => void; children?: React.ReactNode }) {
  const now = describeTv(d, media);
  const body = (
    <>
      {previews && d.stream ? (
        <TvPreview id={d.id} />
      ) : (
        <span className={`tv-screen${d.health?.online === false ? " offline" : ""}`}>{now.text}</span>
      )}
      <b>{d.label || d.name}</b>
      <span className={now.warn ? "warn tv-sub" : "tv-sub"}>{[d.group, previews && d.stream ? now.text : kindOf(d)].filter(Boolean).join(" · ")}</span>
    </>
  );
  if (!onClick)
    return (
      <div className="tv-tile">
        {body}
        {children}
      </div>
    );
  return (
    <button type="button" className={`tv-tile${selected ? " selected" : ""}`} aria-pressed={selected} onClick={onClick}>
      {body}
    </button>
  );
}

/** Finding and adding TVs, and the page's own switches. */
function AddTvCard({ busy, run, setNote, previews, togglePreviews, hasStartup }: { busy: boolean; run: (fn: () => Promise<unknown>) => void; setNote: (s: string) => void; previews: boolean; togglePreviews: (on: boolean) => void; hasStartup: boolean }) {
  const [host, setHost] = useState("");
  const [kind, setKind] = useState<"roku" | "airplay" | "vizio" | "appletv">("roku");
  const add = { roku: api.addRoku, airplay: api.addAirplay, vizio: api.addVizio, appletv: api.addAppleTv }[kind];
  return (
    <section className="card wide">
      <h2>Add a TV</h2>
      <div className="buttons">
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await api.discover();
              setNote(`Found ${r.found} device(s).${r.errors.length ? ` Problems: ${r.errors.join("; ")}` : ""}`);
            })
          }
        >
          Find TVs on this network
        </button>
        <select value={kind} onChange={(e) => setKind(e.target.value as "roku" | "airplay" | "vizio" | "appletv")} aria-label="Kind of TV">
          <option value="roku">Roku</option>
          <option value="vizio">Vizio (SmartCast)</option>
          <option value="appletv">Apple TV</option>
          <option value="airplay">Other AirPlay TV</option>
        </select>
        <input placeholder="Or add by IP address" value={host} onChange={(e) => setHost(e.target.value)} aria-label="IP address" />
        <button disabled={!host || busy} onClick={() => run(() => add(host).then(() => setHost("")))}>
          Add
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={previews} onChange={(e) => togglePreviews(e.target.checked)} /> Show a live picture of what each TV is showing
      </label>
      {hasStartup && (
        <div className="inline">
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await api.runTvStartup();
                setNote(r.waiting.length ? `Starting ${r.waiting.length} TV(s) as after a reboot; offline TVs are retried for 30 minutes.` : "No TV has a startup choice.");
              })
            }
          >
            Try startup choices now
          </button>
          <span className="muted">Does what a reboot does, without rebooting.</span>
        </div>
      )}
    </section>
  );
}

const PANEL_TABS = [
  { id: "now", label: "Now" },
  { id: "remote", label: "Remote" },
  { id: "apps", label: "Apps" },
  { id: "setup", label: "Setup" },
] as const;

/** Everything for one TV, in tabs: what it shows now, its remote, its apps, its setup. */
function TvPanel({
  d,
  tab,
  busy,
  run,
  reload,
  previews,
  startup,
  games,
  media,
  reloadMedia,
}: {
  d: Display;
  tab?: string;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => void;
  reload: () => unknown;
  previews: boolean;
  startup?: StartupRule;
  games: Game[];
  media: MediaProvider[];
  reloadMedia: () => unknown;
}) {
  const [settings, setSettings] = useState<StreamSettings | null>(d.streamSettings ?? null);
  const [label, setLabel] = useState(d.label ?? "");
  const [group, setGroup] = useState(d.group ?? "");
  const [delivery, setDelivery] = useState(d.delivery ?? "");
  const [saved, setSaved] = useState("");
  const online = d.health?.online;
  const stream = d.stream;
  const canPair = d.capabilities?.delivery.includes("airplay");
  const hasRemote = (d.capabilities?.remoteKeys?.length ?? 0) > 0;
  const hasApps = Boolean(d.capabilities?.apps);
  const tabs = PANEL_TABS.filter((t) => (t.id === "remote" ? hasRemote : t.id === "apps" ? hasApps : true));
  const active = tabs.find((t) => t.id === tab)?.id ?? "now";
  const now = describeTv(d, media);

  return (
    <aside className="tv-panel" aria-label={d.label || d.name}>
      <div className="tv-panel-head">
        <div>
          <h2>{d.label || d.name}</h2>
          <span className="muted">
            {[d.group, kindOf(d), d.health?.powerMode ?? (online ? "online" : "offline")].filter(Boolean).join(" · ")}
          </span>
        </div>
        <button type="button" className="ghost close" aria-label="Close" onClick={() => go("tvs")}>
          ×
        </button>
      </div>
      <div className="seg" role="tablist" aria-label="TV controls">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === active} className={t.id === active ? "on" : ""} onClick={() => go("tvs", d.id, t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {active === "now" && (
        <div className="tv-panel-body">
          {previews && stream ? <TvPreview id={d.id} /> : <span className={`tv-screen big${online === false ? " offline" : ""}`}>{now.text}</span>}
          <p className={now.warn ? "warn" : ""}>
            <b>{now.text}</b>
            {stream?.settings ? <span className="muted"> · {stream.settings}</span> : null}
            {stream?.detail ? <span className="muted"> ({stream.detail})</span> : null}
          </p>
          {canPair && stream?.needsCode && <Pairing d={d} needsCode reload={reload} />}
          <ShowOnTv d={d} games={games} reload={reload} />
          <MediaControls displayId={d.id} providers={media} reload={reloadMedia} />
          <div className="buttons">
            <button disabled={busy} onClick={() => run(() => api.idleTvs({ displayIds: [d.id] }))}>
              Idle screen
            </button>
            {stream && (
              <button disabled={busy} onClick={() => run(() => api.show({ displayIds: [d.id] }, { kind: "off" }))}>
                Stop casting
              </button>
            )}
            {d.capabilities?.power && (
              <>
                <button disabled={busy} onClick={() => run(() => api.power(d.id, true))}>
                  Power on
                </button>
                <button disabled={busy} onClick={() => run(() => api.power(d.id, false))}>
                  Power off
                </button>
              </>
            )}
            {d.driver === "venuebox" && online && (
              <button type="button" onClick={() => void api.identify(d.id)}>
                Flash its name
              </button>
            )}
          </div>
          {(d.capabilities?.inputs.length ?? 0) > 0 && (
            <div className="tv-inputs">
              <span className="muted">Input</span>
              <div className="buttons">
                {d.capabilities!.inputs.map((i) => (
                  <button key={i} type="button" disabled={busy || online === false} onClick={() => run(() => api.setInput(d.id, i))}>
                    {inputLabel(i, d.driver)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {d.capabilities?.control && !d.capabilities.control.paired && (
            <p className="muted small-print">
              {d.driver === "appletv" ? "To use this Apple TV's remote and apps from here, pair it once:" : "To switch this TV on and off, change its input or use its remote from here, pair it once:"} <a href={`#tvs/${encodeURIComponent(d.id)}/setup`} onClick={(e) => (e.preventDefault(), go("tvs", d.id, "setup"))}>Setup &gt; Pair TV control</a>.
            </p>
          )}
        </div>
      )}

      {active === "remote" && hasRemote && (
        <div className="tv-panel-body">
          <Remote d={d} keys={d.capabilities!.remoteKeys!} embedded />
        </div>
      )}

      {active === "apps" && hasApps && (
        <div className="tv-panel-body">
          <TvApps d={d} online={online !== false} />
        </div>
      )}

      {active === "setup" && (
        <div className="tv-panel-body">
          <label>
            Name
            <input placeholder={d.name} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label>
            Room (group)
            <input placeholder="e.g. Main room, Patio" value={group} onChange={(e) => setGroup(e.target.value)} />
          </label>
          <label>
            How the box sends to it
            <select value={delivery} onChange={(e) => setDelivery(e.target.value)}>
              <option value="">Auto ({d.capabilities?.delivery[0] ?? "none"})</option>
              {(d.capabilities?.delivery ?? []).map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          {canPair && <StreamSettingsFields value={settings} onChange={setSettings} />}
          <div className="buttons">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.patchDisplay(d.id, { label, group, delivery: delivery || undefined, ...(canPair ? { streamSettings: settings } : {}) });
                  setSaved("Saved.");
                })
              }
            >
              Save
            </button>
            {saved && <span className="ok">{saved}</span>}
          </div>
          <StartupChoice d={d} rule={startup} games={games} run={run} busy={busy} media={media.filter((p) => p.targets.some((t) => t.displayId === d.id))} />
          {d.capabilities?.control && <ControlPairing d={d} paired={d.capabilities.control.paired} reload={reload} />}
          {canPair && <Pairing d={d} needsCode={Boolean(stream?.needsCode)} reload={reload} />}
          <div className="forget-tv">
            <h3 className="sub-head">Ignore this TV</h3>
            <p className="muted small-print">
              For a TV that's away (at the other site, or unplugged). The box stops checking on it and leaves it out of casting, scenes and startup choices, but keeps its name, room and pairings. Bring it back from "Ignored TVs" at the bottom of this page.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.ignoreDisplay(d.id, true);
                  go("tvs");
                })
              }
            >
              Ignore this TV
            </button>
          </div>
          <div className="forget-tv">
            <h3 className="sub-head">Forget this TV</h3>
            <p className="muted small-print">
              Removes it from the box, with its startup choice. Use it for TVs from another venue. A TV still on this network comes back the next time you scan.
            </p>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                const note = stream ? "\n\nThe box stops casting to it." : "";
                if (!window.confirm(`Forget "${d.label || d.name}"?${note}`)) return;
                run(async () => {
                  await api.forgetDisplay(d.id);
                  go("tvs");
                });
              }}
            >
              Forget this TV
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

/**
 * Put a game or app on this TV now. A game gets a new room, hosted by whoever joins first
 * from the TV's QR code (games on SDK 0.7.0); an app (the menu) just shows.
 */
function ShowOnTv({ d, games, reload }: { d: Display; games: Game[]; reload: () => unknown }) {
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const castable = games.filter((g) => g.enabled && g.manifest.routes.table && (isApp(g.manifest) || g.manifest.commands.includes("create_room")));
  if (!castable.length) return null;
  const show = async () => {
    const g = castable.find((x) => x.id === pick);
    if (!g) return;
    setBusy(true);
    setMsg(isApp(g.manifest) ? `Starting ${g.context.game.displayName}…` : `Creating a ${g.context.game.displayName} room…`);
    try {
      const r = await api.cast({ gameId: g.id, displayIds: [d.id], firstJoinerHosts: true });
      const res = r.results[d.id];
      setMsg(
        res && !res.ok
          ? (res.message ?? "The TV didn't start.")
          : r.roomCode
            ? `Room ${r.roomCode} is on the TV. The first person to scan its QR code hosts.`
            : `${g.context.game.displayName} is on the TV.`,
      );
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      void reload();
    }
  };
  return (
    <div>
      <label>
        Show on this TV
        <span className="inline">
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Pick a game or app…</option>
            {castable.map((g) => (
              <option key={g.id} value={g.id}>
                {g.context.game.displayName}
                {isApp(g.manifest) ? "" : " (new room)"}
              </option>
            ))}
          </select>
          <button className="primary" type="button" disabled={!pick || busy} onClick={() => void show()}>
            Show
          </button>
        </span>
      </label>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

/** Venuebox apps (desktop, Android, iOS…): pair by the code they show; rename; remove. */
function VenueboxCard({ reload }: { reload: () => unknown }) {
  const view = useLoad(api.venuebox, 10_000);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const pair = async () => {
    setMsg("");
    try {
      const dev = await api.pairVenuebox(code, name);
      setMsg(`Paired ${dev.name}: ${dev.screens.length} screen(s) added below.`);
      setCode("");
      setName("");
      await Promise.all([view.reload(), reload()]);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  if (view.error && !view.data) return null; // Venuebox clients turned off on this box
  const devices = view.data?.devices ?? [];
  return (
    <section className="card wide">
      <h2>Venuebox apps</h2>
      <p className="muted">
        PCs, Android TVs and iPads running the Venuebox app. They render games themselves (no encoding on the box). To pair one, open the app, point it at this box, and type the code it shows.
      </p>
      <div className="inline">
        <input placeholder="6-digit code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} style={{ maxWidth: 140 }} />
        <input placeholder="Name (optional), e.g. Patio PC" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" disabled={code.length !== 6} onClick={() => void pair()}>
          Pair
        </button>
      </div>
      {(view.data?.pending ?? []).length > 0 && (
        <p className="muted">
          Waiting to pair: {view.data!.pending.map((p) => `${p.name} (${p.platform}, ${p.screens} screen(s))`).join(", ")}
        </p>
      )}
      {msg && <p className="muted">{msg}</p>}
      {devices.map((dv) => (
        <div key={dv.id} className="row">
          <div>
            <b>
              <span className={`dot ${dv.online ? "on" : "off"}`} /> {dv.name}
            </b>
            <small>
              {dv.platform}
              {dv.model ? ` · ${dv.model}` : ""} · {dv.screens.length} screen(s){dv.appVersion ? ` · app ${dv.appVersion}` : ""} · {dv.online ? "online" : dv.lastSeen ? `last seen ${new Date(dv.lastSeen).toLocaleString()}` : "never connected"}
            </small>
          </div>
          <div className="buttons">
            <button
              onClick={() => {
                const n = window.prompt("Name for this device", dv.name);
                if (n?.trim()) void api.renameVenuebox(dv.id, n.trim()).then(() => Promise.all([view.reload(), reload()]));
              }}
            >
              Rename
            </button>
            <button
              className="danger"
              onClick={() => window.confirm(`Remove ${dv.name}? Its screens disappear from the box, and it has to pair again.`) && void api.revokeVenuebox(dv.id).then(() => Promise.all([view.reload(), reload()]))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** "When the box starts": what this TV shows after the box boots (saved right away). */
function StartupChoice({ d, rule, games, run, busy, media }: { d: Display; rule?: StartupRule; games: Game[]; run: (fn: () => Promise<unknown>) => void; busy: boolean; media: MediaProvider[] }) {
  const value = !rule || rule.mode === "last" ? "last" : rule.mode === "game" ? `game:${rule.gameId}` : rule.mode === "media" ? `media:${rule.gameId}:${rule.itemId}` : rule.mode;
  const provider = media[0];
  const { items } = useMediaItems(provider?.gameId);
  const castable = games.filter((g) => g.manifest.routes.table);
  const choose = (v: string) => {
    const next: StartupRule = v.startsWith("game:")
      ? { mode: "game", gameId: v.slice(5) }
      : v.startsWith("media:")
        ? { mode: "media", gameId: v.split(":")[1], itemId: v.split(":").slice(2).join(":") }
        : { mode: v as "last" | "idle" | "off" };
    run(() => api.setTvStartup(d.id, next));
  };
  return (
    <label>
      When the box starts
      <select value={value} disabled={busy} onChange={(e) => choose(e.target.value)}>
        <option value="last">Keep what it was showing</option>
        <option value="idle">The idle screen</option>
        {castable
          .filter((g) => isApp(g.manifest))
          .map((g) => (
            <option key={g.id} value={`game:${g.id}`}>
              {g.context.game.displayName}
              {g.enabled ? "" : " (turned off)"}
            </option>
          ))}
        {castable
          .filter((g) => !isApp(g.manifest) && g.manifest.commands.includes("create_room"))
          .map((g) => (
            <option key={g.id} value={`game:${g.id}`}>
              {g.context.game.displayName}: a new room
              {g.enabled ? "" : " (turned off)"}
            </option>
          ))}
        {provider &&
          (items ?? [])
            .filter((i) => i.kind === "list")
            .map((i) => (
              <option key={i.id} value={`media:${provider.gameId}:${i.id}`}>
                {provider.displayName}: {i.name}
              </option>
            ))}
        <option value="off">Nothing (leave the TV alone)</option>
      </select>
    </label>
  );
}

/** What the box is sending this TV, refreshed every few seconds while the card is on screen. */
function TvPreview({ id }: { id: string }) {
  const [src, setSrc] = useState(() => api.previewUrl(id));
  const [ok, setOk] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setSrc(api.previewUrl(id)), 4000);
    return () => clearInterval(t);
  }, [id]);
  return (
    <div className="tv-preview">
      <img src={src} alt="What this TV is showing" onLoad={() => setOk(true)} onError={() => setOk(false)} style={{ display: ok ? "block" : "none" }} />
      {!ok && <span className="muted">No picture yet</span>}
    </div>
  );
}

const DEFAULT_SETTINGS: StreamSettings = { resolution: "1080p", fps: 30 };

/** Resolution, frame rate and bitrate for this TV (AirPlay). */
function StreamSettingsFields({ value, onChange }: { value: StreamSettings | null; onChange: (s: StreamSettings | null) => void }) {
  const v = value ?? DEFAULT_SETTINGS;
  const set = (patch: Partial<StreamSettings>) => onChange({ ...v, ...patch });
  return (
    <details className="stream-settings">
      <summary>
        Picture: {value ? `${v.resolution}, ${v.fps} fps${v.bitrateKbps ? `, ${v.bitrateKbps} kbps` : ""}` : "box default (1080p, 30 fps)"}
      </summary>
      <label className="inline">
        <input type="checkbox" checked={value === null} onChange={(e) => onChange(e.target.checked ? null : DEFAULT_SETTINGS)} style={{ width: "auto" }} /> Use the box default
      </label>
      {value !== null && (
        <>
          <label>
            Resolution
            <select value={v.resolution} onChange={(e) => set({ resolution: e.target.value as StreamSettings["resolution"] })}>
              <option value="1080p">1080p (sharpest)</option>
              <option value="720p">720p (lighter on the box and Wi-Fi)</option>
            </select>
          </label>
          <label>
            Frame rate
            <select value={v.fps} onChange={(e) => set({ fps: Number(e.target.value) as StreamSettings["fps"] })}>
              <option value={15}>15 fps (static boards, menus)</option>
              <option value={24}>24 fps</option>
              <option value={30}>30 fps (default)</option>
              <option value={60}>60 fps (smoothest, most work)</option>
            </select>
          </label>
          <label>
            Bitrate
            <select value={v.bitrateKbps ?? 0} onChange={(e) => set({ bitrateKbps: Number(e.target.value) || undefined })}>
              <option value={0}>Automatic</option>
              <option value={2000}>2 Mbps (weak Wi-Fi)</option>
              <option value={4000}>4 Mbps</option>
              <option value={8000}>8 Mbps</option>
              <option value={12000}>12 Mbps (wired, fast motion)</option>
            </select>
          </label>
        </>
      )}
      <p className="muted">Saving restarts the stream to this TV with the new settings. TVs on the same page with the same settings share one encoder.</p>
    </details>
  );
}


/** "hdmi2" → "HDMI 2"; a Vizio's "cast" is its SmartCast home screen. */
export function inputLabel(input: string, driver?: string): string {
  const m = /^hdmi-?(\d+)$/i.exec(input);
  if (m) return `HDMI ${m[1]}`;
  const names: Record<string, string> = { tuner: "Antenna", comp: "Composite", cast: driver === "vizio" ? "SmartCast" : "Cast", av: "AV" };
  return names[input.toLowerCase()] ?? input;
}

function controlText(driver: string, paired: boolean): string {
  if (driver === "appletv")
    return paired
      ? "Paired: the box can use this Apple TV's remote, open its apps, type into search boxes, and wake it or put it to sleep. Remove the pairing on the Apple TV in Settings > Remotes and Devices."
      : "Pair once so the box can use this Apple TV's remote, open its apps, type into it, and wake it or put it to sleep. Someone needs to see the TV: the Apple TV shows a 4-digit PIN.";
  return paired
    ? "Paired: the box can switch this TV on and off, change its input and use its remote. To switch it on from off, the TV's Power Mode must be Quick Start (Menu > System > Power Mode)."
    : "Pair once so the box can switch this TV on and off, change its input and use its remote. Someone needs to see the TV: it shows a 4-digit PIN. For switching on from off, set the TV's Power Mode to Quick Start (Menu > System > Power Mode).";
}

/**
 * TV control (Vizio, Apple TV): Pair → the TV shows a 4-digit PIN → enter it here. Needed once per TV;
 * after that the box can switch it on and off, change its input and use its remote.
 */
function ControlPairing({ d, paired, reload }: { d: Display; paired: boolean; reload: () => unknown }) {
  const [phase, setPhase] = useState<"idle" | "starting" | "code" | "sending">("idle");
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const start = async () => {
    setPhase("starting");
    setMsg("Asking the TV for a PIN…");
    try {
      const r = await api.pairControl(d.id);
      setPhase(r.needsCode ? "code" : "idle");
      setMsg(r.needsCode ? "Enter the PIN the TV is showing." : (r.message ?? "Pairing failed."));
    } catch (e) {
      setPhase("idle");
      setMsg((e as Error).message);
    }
  };
  const send = async () => {
    setPhase("sending");
    try {
      const r = await api.pairControl(d.id, code);
      setCode("");
      setPhase(r.ok ? "idle" : "code");
      setMsg(r.ok ? (r.message ?? "Paired.") : `${r.message ?? "Pairing failed."} Press "New PIN" for another try.`);
    } catch (e) {
      setPhase("code");
      setMsg((e as Error).message);
    }
    void reload();
  };
  return (
    <div className="pairing">
      <h3 className="sub-head">TV control</h3>
      <p className="muted small-print">{controlText(d.driver, paired)}</p>
      {phase === "code" || phase === "sending" ? (
        <div className="buttons">
          <input inputMode="numeric" autoComplete="one-time-code" placeholder="PIN on the TV" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} />
          <button className="primary" disabled={code.length < 4 || phase === "sending"} onClick={() => void send()}>
            Pair
          </button>
          <button disabled={phase === "sending"} onClick={() => void start()}>
            New PIN
          </button>
        </div>
      ) : (
        <button disabled={phase === "starting"} onClick={() => void start()}>
          {phase === "starting" ? "Pairing…" : paired ? "Pair TV control again" : "Pair TV control"}
        </button>
      )}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

/** AirPlay pairing: Pair → the TV shows a code → enter it here. Needed once per TV. */
function Pairing({ d, needsCode, reload }: { d: Display; needsCode: boolean; reload: () => unknown }) {
  const [phase, setPhase] = useState<"idle" | "starting" | "code" | "sending">(needsCode ? "code" : "idle");
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (needsCode && phase === "idle") setPhase("code");
  }, [needsCode, phase]);

  const start = async () => {
    setPhase("starting");
    setMsg("Connecting to the TV…");
    try {
      const r = await api.pair(d.id);
      if (r.needsCode) {
        setPhase("code");
        setMsg("Enter the code the TV is showing.");
      } else {
        setPhase("idle");
        setMsg(r.ok ? (r.message ?? "Paired.") : (r.message ?? "Pairing failed."));
      }
    } catch (e) {
      setPhase("idle");
      setMsg((e as Error).message);
    }
    void reload();
  };
  const send = async () => {
    setPhase("sending");
    try {
      const r = await api.pair(d.id, code);
      setCode("");
      if (r.ok) {
        setPhase("idle");
        setMsg("Paired. The TV goes back to what it was showing in a few seconds.");
      } else if (r.needsCode) {
        setPhase("code");
        setMsg("That code didn't work. Check the TV for a new one.");
      } else {
        setPhase("idle");
        setMsg(r.message ?? "Pairing failed.");
      }
    } catch (e) {
      setPhase("code");
      setMsg((e as Error).message);
    }
    void reload();
  };

  return (
    <div className="pairing">
      {phase === "code" || phase === "sending" ? (
        <div className="buttons">
          <input inputMode="numeric" autoComplete="one-time-code" placeholder="Code on the TV" value={code} onChange={(e) => setCode(e.target.value.trim())} />
          <button className="primary" disabled={!code || phase === "sending"} onClick={() => void send()}>
            Pair
          </button>
          <button disabled={phase === "sending"} onClick={() => void start()}>
            New code
          </button>
        </div>
      ) : (
        <button disabled={phase === "starting"} onClick={() => void start()}>
          {phase === "starting" ? "Pairing…" : "Pair (AirPlay)"}
        </button>
      )}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

/** Whether game hosts may cast their rooms to these TVs from inside the game. */
function CastFromGames() {
  const settings = useLoad(api.castSettings);
  const [s, setS] = useState<CastSettings>({ fromGames: false, pin: "" });
  const [saved, setSaved] = useState("");
  const { busy, run } = useAction(settings.reload, settings.setError);
  useEffect(() => {
    if (settings.data) setS(settings.data);
  }, [settings.data]);
  return (
    <section className="card wide">
      <h2>Casting from games</h2>
      <p className="muted">
        Lets a game's host put their room on these TVs from inside the game (for games that support it). Staff can always cast from the Home tab.
      </p>
      <label className="switch">
        <input type="checkbox" checked={s.fromGames} onChange={(e) => setS({ ...s, fromGames: e.target.checked })} />
        <span>{s.fromGames ? "Allowed" : "Off"}</span>
      </label>
      <label>
        TV PIN (optional, 4-8 digits). Hosts must enter it to cast. Leave empty for no PIN.
        <input inputMode="numeric" placeholder="none" value={s.pin} onChange={(e) => setS({ ...s, pin: e.target.value.replace(/\D/g, "").slice(0, 8) })} />
      </label>
      <div className="buttons">
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api.saveCastSettings(s);
              setSaved("Saved.");
            })
          }
        >
          Save
        </button>
      </div>
      {saved && <p className="muted">{saved}</p>}
      {settings.error && <p className="error">{settings.error}</p>}
    </section>
  );
}
