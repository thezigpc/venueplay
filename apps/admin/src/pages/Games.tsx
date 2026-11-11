import { useState } from "react";
import { api, type Game } from "../api";
import { useAction, useLoad } from "../useLoad";

export function GamesPage() {
  const games = useLoad(api.games);
  const { busy, run } = useAction(games.reload, games.setError);
  const [url, setUrl] = useState("");
  const [sub, setSub] = useState("");
  const [notes, setNotes] = useState<string[]>([]);

  const install = () =>
    run(async () => {
      const r = await api.install(url, sub.trim().toLowerCase());
      setNotes([`${r.upgraded ? "Updated" : "Installed"} ${r.game.manifest.name} ${r.game.manifest.version}${r.game.verified ? "" : " (unverified source)"}`, ...r.warnings]);
      setUrl("");
      setSub("");
    });

  return (
    <div className="grid">
      <section className="card wide">
        <h2>Add a game</h2>
        <p className="muted">Paste a GitHub repo or a bargames.json URL. Market installs come later. Leave the subdomain empty to use the game's id; you can change it later.</p>
        <div className="inline">
          <input placeholder="https://github.com/owner/game" value={url} onChange={(e) => setUrl(e.target.value)} />
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
      </section>
      {(games.data ?? []).map((g) => (
        <GameCard key={g.id} game={g} busy={busy} run={run} />
      ))}
    </div>
  );
}

function GameCard({ game, busy, run }: { game: Game; busy: boolean; run: (fn: () => Promise<unknown>) => void }) {
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
        {game.host} · SDK level {game.manifest.sdk.level} · {game.state} · {game.verified ? "verified" : <span className="warn">unverified source</span>}
      </p>
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
