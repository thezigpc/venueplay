import { useEffect, useState } from "react";
import { isApp } from "@bargames/sdk";
import { MediaControls, useMediaItems } from "./MediaControls";
import { api, type CastSettings, type Display, type Game, type MediaProvider, type StartupRule, type StreamSettings } from "../api";

const PREVIEWS_KEY = "bargames.tvPreviews";
const readPreviews = () => {
  try {
    return localStorage.getItem(PREVIEWS_KEY) !== "off";
  } catch {
    return true;
  }
};
import { useAction, useLoad } from "../useLoad";

export function DisplaysPage() {
  const displays = useLoad(api.displays, 10_000);
  const startup = useLoad(api.tvStartup);
  const media = useLoad(api.media, 5000);
  const games = useLoad(api.games);
  const reloadAll = async () => {
    await Promise.all([displays.reload(), startup.reload()]);
  };
  const { busy, run } = useAction(reloadAll, displays.setError);
  const [host, setHost] = useState("");
  const [kind, setKind] = useState<"roku" | "airplay">("roku");
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

  return (
    <div className="grid">
      <section className="card wide">
        <h2>TVs</h2>
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
            Find TVs
          </button>
          <select value={kind} onChange={(e) => setKind(e.target.value as "roku" | "airplay")}>
            <option value="roku">Roku</option>
            <option value="airplay">AirPlay (Apple TV, AirPlay TV)</option>
          </select>
          <input placeholder="Add by IP" value={host} onChange={(e) => setHost(e.target.value)} />
          <button disabled={!host || busy} onClick={() => run(() => (kind === "roku" ? api.addRoku(host) : api.addAirplay(host)).then(() => setHost("")))}>
            Add
          </button>
        </div>
        <label className="inline">
          <input type="checkbox" checked={previews} onChange={(e) => togglePreviews(e.target.checked)} style={{ width: "auto" }} /> Show what each TV is showing
          (previews refresh every few seconds)
        </label>
        {Object.keys(startup.data ?? {}).length > 0 && (
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
        {note && <p className="muted">{note}</p>}
        {displays.error && <p className="error">{displays.error}</p>}
      </section>
      <VenueboxCard reload={displays.reload} />
      {(displays.data ?? []).map((d) => (
        <DisplayCard key={d.id} d={d} busy={busy} run={run} reload={displays.reload} previews={previews} startup={startup.data?.[d.id]} games={games.data ?? []} media={media.data?.providers ?? []} reloadMedia={media.reload} />
      ))}
      <CastFromGames />
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

function DisplayCard({
  d,
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
  const online = d.health?.online;
  const stream = d.stream;
  const canPair = d.capabilities?.delivery.includes("airplay");
  return (
    <section className="card">
      <h2>
        <span className={`dot ${online ? (stream?.state === "streaming" ? "on" : stream ? "warn" : "on") : "off"}`} /> {d.label || d.name}
      </h2>
      <p className="muted">
        {d.driver === "airplay" ? `AirPlay${d.model ? ` · ${d.model}` : ""}` : `${d.model} · ${d.isTv ? "TV" : "player"}`} · {d.health?.powerMode ?? (online ? "online" : "offline")}
      </p>
      {stream ? (
        <p className="muted">
          {d.content?.title ?? "Showing"}: <b>{STREAM_LABEL[stream.state] ?? stream.state}</b>
          {stream.settings ? ` · ${stream.settings}` : ""}
          {stream.detail ? ` (${stream.detail})` : ""}
        </p>
      ) : (
        d.content?.kind === "url" && <p className="muted">Last shown: {d.content.title ?? d.content.url}</p>
      )}
      {previews && stream && <TvPreview id={d.id} />}
      {canPair && <Pairing d={d} needsCode={Boolean(stream?.needsCode)} reload={reload} />}
      <label>
        Name
        <input placeholder={d.name} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label>
        Group
        <input placeholder="e.g. main, patio" value={group} onChange={(e) => setGroup(e.target.value)} />
      </label>
      <label>
        Delivery
        <select value={delivery} onChange={(e) => setDelivery(e.target.value)}>
          <option value="">Auto ({d.capabilities?.delivery[0] ?? "none"})</option>
          {(d.capabilities?.delivery ?? []).map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <MediaControls displayId={d.id} providers={media} reload={reloadMedia} />
      <ShowOnTv d={d} games={games} reload={reload} />
      <StartupChoice d={d} rule={startup} games={games} run={run} busy={busy} media={media.filter((p) => p.targets.some((t) => t.displayId === d.id))} />
      {canPair && <StreamSettingsFields value={settings} onChange={setSettings} />}
      <div className="buttons">
        <button
          className="primary"
          disabled={busy}
          onClick={() => run(() => api.patchDisplay(d.id, { label, group, delivery: delivery || undefined, ...(canPair ? { streamSettings: settings } : {}) }))}
        >
          Save
        </button>
        {stream && (
          <button disabled={busy} onClick={() => run(() => api.show({ displayIds: [d.id] }, { kind: "off" }))}>
            Stop casting
          </button>
        )}
        {d.capabilities?.power && (
          <>
            <button disabled={busy} onClick={() => run(() => api.power(d.id, true))}>
              On
            </button>
            <button disabled={busy} onClick={() => run(() => api.power(d.id, false))}>
              Off
            </button>
          </>
        )}
      </div>
      {(d.capabilities?.remoteKeys?.length ?? 0) > 0 && <Remote d={d} keys={d.capabilities!.remoteKeys!} />}
      {d.driver === "venuebox" && online && (
        <p>
          <button type="button" onClick={() => void api.identify(d.id)}>
            Identify (show its name on screen)
          </button>
        </p>
      )}
    </section>
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

const DPAD: [string, string][][] = [
  [["", ""], ["Up", "▲"], ["", ""]],
  [["Left", "◀"], ["Select", "OK"], ["Right", "▶"]],
  [["", ""], ["Down", "▼"], ["", ""]],
];
const ROW_KEYS: [string, string][] = [
  ["Back", "↩ Back"],
  ["Home", "⌂ Home"],
  ["InstantReplay", "↺"],
  ["Info", "✱"],
];
const PLAY_KEYS: [string, string][] = [
  ["Rev", "⏪"],
  ["Play", "⏯"],
  ["Fwd", "⏩"],
];
const VOLUME_KEYS: [string, string][] = [
  ["VolumeDown", "Vol −"],
  ["VolumeMute", "Mute"],
  ["VolumeUp", "Vol +"],
];

/** The Roku remote. Pressing Home or Back leaves whatever the box is casting. */
function Remote({ d, keys }: { d: Display; keys: string[] }) {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const has = new Set(keys);
  const press = (key: string) => {
    setMsg("");
    api.key(d.id, key).catch((e: Error) => setMsg(e.message));
  };
  const btn = ([key, label]: [string, string], i: number) =>
    key && has.has(key) ? (
      <button key={key} type="button" onClick={() => press(key)}>
        {label}
      </button>
    ) : (
      <span key={`gap${i}`} />
    );
  return (
    <details className="remote">
      <summary>Remote</summary>
      <div className="dpad">{DPAD.flat().map(btn)}</div>
      <div className="buttons">{ROW_KEYS.map(btn)}</div>
      <div className="buttons">{PLAY_KEYS.map(btn)}</div>
      {has.has("VolumeUp") && <div className="buttons">{VOLUME_KEYS.map(btn)}</div>}
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text) return;
          api.typeText(d.id, text).then(() => setText(""), (err: Error) => setMsg(err.message));
        }}
      >
        <input placeholder="Type into a search box" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={!text}>
          Send
        </button>
      </form>
      <p className="muted">Home or Back leaves what the box is casting; cast again from Home to put it back.</p>
      {msg && <p className="error">{msg}</p>}
    </details>
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
