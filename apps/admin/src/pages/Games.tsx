import { adminPath, isApp } from "@bargames/sdk";
import { useState } from "react";
import { api, type Game, type UpdateInfo } from "../api";
import { useAction, useLoad } from "../useLoad";

/** Games and apps in one list: a row each, with the rarely needed settings behind "More". */
export function GamesPage() {
  const games = useLoad(api.games, 15_000);
  const updates = useLoad(api.updates);
  const rooms = useLoad(api.rooms, 15_000);
  const reloadAll = async () => {
    await Promise.all([games.reload(), updates.reload()]);
  };
  const { busy, run } = useAction(reloadAll, games.setError);
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState("");
  const [url, setUrl] = useState("");
  const [sub, setSub] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const all = games.data ?? [];
  const updateOf = (g: Game) => updates.data?.games.find((u) => u.gameId === g.id);
  const ready = all.filter((g) => {
    const u = updateOf(g);
    return u?.available && u.installed === g.manifest.version;
  });
  const openRooms = (id: string) => rooms.data?.games.find((g) => g.id === id)?.rooms.length ?? 0;

  const install = () =>
    run(async () => {
      const r = await api.install(url, sub.trim().toLowerCase());
      setNotes([`${r.upgraded ? "Updated" : "Installed"} ${r.game.manifest.name} ${r.game.manifest.version}${r.game.verified ? "" : " (unverified source)"}. Turn it on in the list below.`, ...r.warnings]);
      setUrl("");
      setSub("");
    });
  const check = () => {
    setChecking(true);
    api
      .checkUpdates()
      .then(() => updates.reload())
      .catch((e: Error) => games.setError(e.message))
      .finally(() => setChecking(false));
  };

  const list = (items: Game[]) =>
    items.map((g) => (
      <GameRow key={g.id} game={g} busy={busy} run={run} update={updateOf(g)} rooms={openRooms(g.id)} open={open === g.id} toggle={() => setOpen(open === g.id ? "" : g.id)} />
    ));
  const gamesOnly = all.filter((g) => !isApp(g.manifest));
  const apps = all.filter((g) => isApp(g.manifest));

  return (
    <div>
      <div className="page-head">
        <h1>Games and apps</h1>
        <button type="button" disabled={checking || busy} onClick={check}>
          {checking ? "Checking…" : "Check for updates"}
        </button>
        <button type="button" className="primary" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          Add a game or app
        </button>
      </div>
      {games.error && <p className="error">{games.error}</p>}

      {adding && (
        <section className="card stack-gap">
          <h2>Add a game or app</h2>
          <p className="muted">Paste a GitHub repo or a bargames.json address. Leave the name empty to use its id; you can change it later.</p>
          <div className="inline">
            <input placeholder="https://github.com/owner/game" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Repo or manifest address" />
            <input placeholder="Address name (optional)" value={sub} onChange={(e) => setSub(e.target.value)} autoCapitalize="none" style={{ maxWidth: 220 }} aria-label="Address name" />
            <button className="primary" disabled={!url || busy} onClick={install}>
              Install
            </button>
          </div>
        </section>
      )}
      {notes.map((n, i) => (
        <p key={i} className={i ? "warn" : "ok"}>
          {n}
        </p>
      ))}

      {ready.length > 0 && (
        <section className="card stack-gap update-ready">
          <h2>
            {ready.length} update{ready.length === 1 ? "" : "s"} ready
          </h2>
          {ready.map((g) => (
            <div key={g.id}>
              <UpdateBanner game={g} update={updateOf(g)} busy={busy} run={run} rooms={openRooms(g.id)} named />
            </div>
          ))}
        </section>
      )}

      <section className="card game-list">
        {all.length === 0 && games.data && <p className="muted">Nothing installed yet. Use "Add a game or app".</p>}
        {gamesOnly.length > 0 && <h2 className="list-head">Games</h2>}
        {list(gamesOnly)}
        {apps.length > 0 && <h2 className="list-head">Apps</h2>}
        {list(apps)}
      </section>
      <p className="muted small-print">
        {updates.data?.lastRun ? `Updates last checked ${new Date(updates.data.lastRun).toLocaleString()}.` : "The box checks for updates every 6 hours."}
      </p>
    </div>
  );
}

function GameRow({ game, busy, run, update, rooms, open, toggle }: { game: Game; busy: boolean; run: (fn: () => Promise<unknown>) => void; update?: UpdateInfo; rooms: number; open: boolean; toggle: () => void }) {
  const name = game.context.game.displayName;
  const url = game.context.game.publicUrl;
  const hasUpdate = Boolean(update?.available && update.installed === game.manifest.version);
  const state = !game.enabled ? "Turned off" : rooms ? `${rooms} open room${rooms === 1 ? "" : "s"}` : game.state && game.state !== "running" ? game.state : "";
  const setOn = (on: boolean) => {
    if (!on && rooms && !window.confirm(`Turn ${name} off? Its ${rooms} open room${rooms === 1 ? "" : "s"} will close.`)) return;
    run(() => api.patchGame(game.id, { enabled: on }));
  };
  return (
    <div className={`game-row-wrap${game.enabled ? "" : " off"}`}>
      <div className="game-row">
        {game.context.game.iconUrl ? (
          <img className="game-icon" src={game.context.game.iconUrl} alt="" />
        ) : (
          <span className="game-icon" aria-hidden="true">
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="game-main">
          <b>{name}</b> <span className="muted">{game.manifest.version}</span>
          <div className="muted game-sub">
            {url ? (
              <a href={url} target="_blank" rel="noreferrer">
                {url.replace(/^https?:\/\//, "")}
              </a>
            ) : (
              game.host
            )}
            {state ? ` · ${state}` : ""}
          </div>
        </div>
        {hasUpdate ? <span className="pill warn">Update ready</span> : game.enabled && update && !update.error ? <span className="pill ok">Up to date</span> : null}
        {adminPath(game.manifest) && game.enabled && <OpenSettings game={game} compact />}
        <label className="toggle" title={game.enabled ? "On" : "Off"}>
          <input type="checkbox" role="switch" checked={game.enabled} disabled={busy} onChange={(e) => setOn(e.target.checked)} aria-label={`${name} is ${game.enabled ? "on" : "off"}`} />
          <span aria-hidden="true" />
        </label>
        <button type="button" className="ghost more" aria-expanded={open} aria-label={`More for ${name}`} onClick={toggle}>
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
      </div>
      {open && <GameCard game={game} busy={busy} run={run} update={update} embedded />}
    </div>
  );
}

function UpdateBanner({ game, update, busy, run, rooms = 0, named = false }: { game: Game; update?: UpdateInfo; busy: boolean; run: (fn: () => Promise<unknown>) => void; rooms?: number; named?: boolean }) {
  const [done, setDone] = useState("");
  if (done) return <p className="ok">{done}</p>;
  if (!update || update.installed !== game.manifest.version) return null;
  if (update.error) return <p className="muted">Update check: {update.error}</p>;
  if (!update.available) return update.note && update.note !== "up to date" ? <p className="muted">Update: {update.note}</p> : null;
  const go = () => {
    const live = game.enabled ? "\n\nIt restarts, so open rooms close (players can start new ones a moment later)." : "";
    if (!window.confirm(`Update ${game.context.game.displayName} from ${update.installed} to ${update.latest}?${live}`)) return;
    run(async () => {
      const r = await api.updateGame(game.id);
      setDone(`Updated from ${r.from} to ${r.game.manifest.version}.${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}`);
    });
  };
  return (
    <div className="inline update">
      <b>
        {named ? `${game.context.game.displayName}: ` : "Update available: "}
        {update.installed} to {update.latest}
      </b>
      {named && game.enabled && <span className="muted">Restarts it{rooms ? ` and closes its ${rooms} open room${rooms === 1 ? "" : "s"}` : ""}.</span>}
      <button className="primary" disabled={busy} onClick={go}>
        Update
      </button>
      {update.note && <span className="muted">{update.note}</span>}
    </div>
  );
}

/**
 * Opens the game's/app's own admin page, signed in as staff (SDK 0.7.0 games skip their
 * own password; older ones still ask for it).
 */
function OpenSettings({ game, compact = false }: { game: Game; compact?: boolean }) {
  const [note, setNote] = useState("");
  const open = () => {
    // Open the tab now (inside the tap), or iPad Safari blocks it as a pop-up.
    const tab = window.open("about:blank", "_blank");
    api.staffLink(game.id).then(
      (r) => {
        if (tab) tab.location.href = r.url;
        else window.location.href = r.url;
        setNote(r.staffAware ? "" : `${game.context.game.displayName} doesn't support box sign-in yet, so it may still ask for its own password.`);
      },
      (e: Error) => {
        tab?.close();
        setNote(e.message);
      },
    );
  };
  if (compact)
    return (
      <button type="button" onClick={open} title={note || `Open ${game.context.game.displayName}'s own settings`}>
        Settings
      </button>
    );
  return (
    <p>
      <button type="button" onClick={open}>
        Settings: {game.context.game.displayName} ↗
      </button>
      {note && <small className="muted"> {note}</small>}
    </p>
  );
}

/**
 * Secret settings (API keys, OAuth clients) for this game/app: stored on the box only,
 * handed to it as environment variables. Values are write-only: never shown again.
 */
function SecretSettings({ game }: { game: Game }) {
  const list = useLoad(() => api.secrets(game.id));
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (n: string, v: string | null) => {
    setBusy(true);
    setMsg("");
    try {
      await api.setSecret(game.id, n, v);
      setMsg(v === null ? `Removed ${n}.` : `Saved ${n}${game.enabled ? "; restarted with it" : ""}.`);
      setName("");
      setValue("");
      await list.reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const secrets = list.data?.secrets ?? [];
  return (
    <details className="stream-settings">
      <summary>Secret settings{secrets.length ? ` (${secrets.length})` : ""}</summary>
      <p className="muted">For keys the game or app asks for (e.g. a Google client). Stored on this box only; values are never shown again.</p>
      {secrets.map((s) => (
        <div key={s.name} className="inline">
          <code>{s.name}</code>
          <span className="muted">set ({s.length} characters)</span>
          <button className="danger" disabled={busy} onClick={() => window.confirm(`Remove ${s.name}?`) && void save(s.name, null)}>
            Remove
          </button>
        </div>
      ))}
      <div className="inline">
        <input placeholder="NAME" value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} style={{ maxWidth: 260 }} autoCapitalize="characters" />
        <input type="password" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
        <button disabled={busy || !name || !value} onClick={() => void save(name, value)}>
          Save
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </details>
  );
}

function GameCard({ game, busy, run, update, embedded = false }: { game: Game; busy: boolean; run: (fn: () => Promise<unknown>) => void; update?: UpdateInfo; embedded?: boolean }) {
  const slots = new Set(game.manifest.brandable);
  const [name, setName] = useState(game.branding.displayName ?? "");
  const [tagline, setTagline] = useState(game.branding.tagline ?? "");
  const [accent, setAccent] = useState(game.branding.accent ?? "");
  const [alias, setAlias] = useState(game.hostnameAlias ?? "");
  const [ownHost, setOwnHost] = useState(Boolean(game.ownHostname));
  const pathCapable = Boolean(game.manifest.routing?.basePath);
  const onPath = Boolean(game.context.game.basePath);
  const label = (alias.trim().toLowerCase() || game.id);
  const current = game.hostnameAlias ?? game.id;
  const previewHost = game.host.startsWith(`${current}.`) || game.host.startsWith(`${current}-`) ? label + game.host.slice(current.length) : game.host;
  const url = game.context.game.publicUrl;

  return (
    <section className={embedded ? "game-detail" : "card"}>
      {!embedded && (
        <h2>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" title="Open the game's site">
              {game.context.game.displayName} ↗
            </a>
          ) : (
            game.context.game.displayName
          )}{" "}
          <small>{game.manifest.version}</small>
        </h2>
      )}
      <p className="muted">
        {isApp(game.manifest) ? "App · " : ""}
        {game.host} · SDK level {game.manifest.sdk.level} · {game.state} · {game.verified ? "verified" : <span className="warn">unverified source</span>}
      </p>
      <UpdateBanner game={game} update={update} busy={busy} run={run} />
      {!embedded && adminPath(game.manifest) && <OpenSettings game={game} />}
      <SecretSettings game={game} />
      {slots.has("displayName") && (
        <label>
          Display name
          <input placeholder={game.manifest.name} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      {slots.has("tagline") && (
        <label>
          Tagline
          <input value={tagline} onChange={(e) => setTagline(e.target.value)} />
        </label>
      )}
      {slots.has("accent") && (
        <label>
          Accent color
          <input type="color" value={accent || game.context.venue.theme.colors.accent} onChange={(e) => setAccent(e.target.value)} />
        </label>
      )}
      <label>
        {onPath && !ownHost ? "Address name" : "Subdomain"}
        <input placeholder={game.id} value={alias} onChange={(e) => setAlias(e.target.value)} autoCapitalize="none" />
        <small className="muted">
          {onPath && !ownHost
            ? `Players use ${game.host}/${label}`
            : label === current
              ? `Players use ${game.host}`
              : `After saving: ${previewHost} (DNS updates within a minute; the old address stops working)`}
        </small>
      </label>
      {pathCapable ? (
        <label className="check">
          <input type="checkbox" checked={ownHost} onChange={(e) => setOwnHost(e.target.checked)} />
          Give it its own hostname
          <small className="muted">
            Off (recommended): it lives on the games list's address, at /{label}, with no extra DNS record or tunnel route. On: {label}.… gets its own record.
          </small>
        </label>
      ) : (
        <p className="muted">
          <small>This version can't run under a path yet (no "routing" in its bargames.json), so it keeps its own hostname.</small>
        </p>
      )}
      <div className="buttons">
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(() => api.patchGame(game.id, { branding: { displayName: name || undefined, tagline: tagline || undefined, accent: accent || undefined }, hostnameAlias: alias || null, ...(pathCapable ? { ownHostname: ownHost } : {}) }))
          }
        >
          Save
        </button>
        {!embedded && (
        <button disabled={busy} onClick={() => run(() => api.patchGame(game.id, { enabled: !game.enabled }))}>
          {game.enabled ? "Turn off" : "Turn on"}
        </button>
        )}
        <button className="danger" disabled={busy} onClick={() => confirm(`Remove ${game.manifest.name}? Its data is kept.`) && run(() => api.removeGame(game.id))}>
          Remove
        </button>
      </div>
    </section>
  );
}
