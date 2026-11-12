import { isApp } from "@bargames/sdk";
import { useState } from "react";
import { api, type Game, type UpdateInfo } from "../api";
import { useAction, useLoad } from "../useLoad";

export function GamesPage() {
  return <CatalogPage kind="game" />;
}

/** Apps (SDK 0.6.0): menus, signage and other non-games. Installed and updated like games. */
export function AppsPage() {
  return <CatalogPage kind="app" />;
}

function CatalogPage({ kind }: { kind: "game" | "app" }) {
  const app = kind === "app";
  const noun = app ? "app" : "game";
  const games = useLoad(api.games);
  const updates = useLoad(api.updates);
  const reloadAll = async () => {
    await Promise.all([games.reload(), updates.reload()]);
  };
  const { busy, run } = useAction(reloadAll, games.setError);
  const [checking, setChecking] = useState(false);
  const available = (updates.data?.games ?? []).filter((u) => u.available);
  const [url, setUrl] = useState("");
  const [sub, setSub] = useState("");
  const [notes, setNotes] = useState<string[]>([]);

  const install = () =>
    run(async () => {
      const r = await api.install(url, sub.trim().toLowerCase());
      const elsewhere = isApp(r.game.manifest) !== app ? ` It's ${app ? "a game" : "an app"}, so it's under ${app ? "Games" : "Apps"}.` : "";
      setNotes([`${r.upgraded ? "Updated" : "Installed"} ${r.game.manifest.name} ${r.game.manifest.version}${r.game.verified ? "" : " (unverified source)"}.${elsewhere}`, ...r.warnings]);
      setUrl("");
      setSub("");
    });

  return (
    <div className="grid">
      <section className="card wide">
        <h2>Add {app ? "an app" : "a game"}</h2>
        <p className="muted">
          {app ? "Apps are the things that aren't games: the menu, signage, and more to come. " : ""}Paste a GitHub repo or a bargames.json URL. Leave the subdomain empty to use the {noun}'s id; you can change it later.
        </p>
        <div className="inline">
          <input placeholder={`https://github.com/owner/${noun}`} value={url} onChange={(e) => setUrl(e.target.value)} />
          <input placeholder="Subdomain (optional)" value={sub} onChange={(e) => setSub(e.target.value)} autoCapitalize="none" style={{ maxWidth: 200 }} />
          <button className="primary" disabled={!url || busy} onClick={install}>
            Install
          </button>
        </div>
        {notes.map((n, i) => (
          <p key={i} className={i ? "warn" : "ok"}>
            {n}
          </p>
        ))}
        {games.error && <p className="error">{games.error}</p>}
        <div className="inline">
          <button
            disabled={checking || busy}
            onClick={() => {
              setChecking(true);
              api
                .checkUpdates()
                .then(() => updates.reload())
                .catch((e: Error) => games.setError(e.message))
                .finally(() => setChecking(false));
            }}
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
          <span className="muted">
            {available.length ? `${available.length} update(s) available. ` : ""}
            {updates.data?.lastRun ? `Last checked ${new Date(updates.data.lastRun).toLocaleString()}.` : "The box checks every 6 hours."}
          </span>
        </div>
      </section>
      {(games.data ?? []).filter((g) => isApp(g.manifest) === app).length === 0 && games.data && (
        <section className="card">
          <p className="muted">No {noun}s installed yet.</p>
        </section>
      )}
      {(games.data ?? []).filter((g) => isApp(g.manifest) === app).map((g) => (
        <GameCard key={g.id} game={g} busy={busy} run={run} update={updates.data?.games.find((u) => u.gameId === g.id)} />
      ))}
    </div>
  );
}

function UpdateBanner({ game, update, busy, run }: { game: Game; update?: UpdateInfo; busy: boolean; run: (fn: () => Promise<unknown>) => void }) {
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
        Update available: {update.installed} → {update.latest}
      </b>
      <button className="primary" disabled={busy} onClick={go}>
        Update
      </button>
      {update.note && <span className="muted">{update.note}</span>}
    </div>
  );
}

function GameCard({ game, busy, run, update }: { game: Game; busy: boolean; run: (fn: () => Promise<unknown>) => void; update?: UpdateInfo }) {
  const slots = new Set(game.manifest.brandable);
  const [name, setName] = useState(game.branding.displayName ?? "");
  const [tagline, setTagline] = useState(game.branding.tagline ?? "");
  const [accent, setAccent] = useState(game.branding.accent ?? "");
  const [alias, setAlias] = useState(game.hostnameAlias ?? "");
  const label = (alias.trim().toLowerCase() || game.id);
  const current = game.hostnameAlias ?? game.id;
  const previewHost = game.host.startsWith(`${current}.`) || game.host.startsWith(`${current}-`) ? label + game.host.slice(current.length) : game.host;
  const url = game.context.game.publicUrl;

  return (
    <section className="card">
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
      <p className="muted">
        {isApp(game.manifest) ? "App · " : ""}
        {game.host} · SDK level {game.manifest.sdk.level} · {game.state} · {game.verified ? "verified" : <span className="warn">unverified source</span>}
      </p>
      <UpdateBanner game={game} update={update} busy={busy} run={run} />
      {game.manifest.routes.host && url && (
        <p>
          <a href={new URL(game.manifest.routes.host, url).toString()} target="_blank" rel="noreferrer">
            Open {game.context.game.displayName}'s own settings ↗
          </a>
        </p>
      )}
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
        Subdomain
        <input placeholder={game.id} value={alias} onChange={(e) => setAlias(e.target.value)} autoCapitalize="none" />
        <small className="muted">
          {label === current ? `Players use ${game.host}` : `After saving: ${previewHost} (DNS updates within a minute; the old address stops working)`}
        </small>
      </label>
      <div className="buttons">
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(() => api.patchGame(game.id, { branding: { displayName: name || undefined, tagline: tagline || undefined, accent: accent || undefined }, hostnameAlias: alias || null }))
          }
        >
          Save
        </button>
        <button disabled={busy} onClick={() => run(() => api.patchGame(game.id, { enabled: !game.enabled }))}>
          {game.enabled ? "Turn off" : "Turn on"}
        </button>
        <button className="danger" disabled={busy} onClick={() => confirm(`Remove ${game.manifest.name}? Its data is kept.`) && run(() => api.removeGame(game.id))}>
          Remove
        </button>
      </div>
    </section>
  );
}
