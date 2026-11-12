// Media providers (SDK 0.9.0): apps such as YouTube that put their own content on TVs.

import { useEffect, useState } from "react";
import { api, type MediaItem, type MediaProvider } from "../api";
import { useLoad } from "../useLoad";

const STATE: Record<string, string> = {
  linked: "ready",
  starting: "starting…",
  playing: "playing",
  paused: "paused",
  local: "someone is using it directly",
  unlinked: "not linked",
  error: "error",
};

/** Lazily loaded list of a provider's items. */
export function useMediaItems(gameId: string | undefined) {
  const [items, setItems] = useState<MediaItem[] | undefined>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!gameId) return;
    api.mediaItems(gameId).then(
      (r) => setItems(r.items),
      (e: Error) => setError(e.message),
    );
  }, [gameId]);
  return { items, error };
}

/** On a TV card: what the media app shows on this TV, and a list picker. */
export function MediaControls({ displayId, providers, reload }: { displayId: string; providers: MediaProvider[]; reload: () => unknown }) {
  const mine = providers.flatMap((p) => p.targets.filter((t) => t.displayId === displayId).map((t) => ({ p, t })));
  if (!mine.length) return null;
  return (
    <>
      {mine.map(({ p, t }) => (
        <ProviderOnTv key={p.gameId} provider={p} target={t} displayId={displayId} reload={reload} />
      ))}
    </>
  );
}

function ProviderOnTv({ provider, target, displayId, reload }: { provider: MediaProvider; target: MediaProvider["targets"][number]; displayId: string; reload: () => unknown }) {
  const [open, setOpen] = useState(false);
  const { items, error } = useMediaItems(open ? provider.gameId : undefined);
  const [pick, setPick] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const lists = (items ?? []).filter((i) => i.kind === "list");
  const play = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.mediaPlay(provider.gameId, pick, displayId);
      setMsg(r.ok ? (r.pending ? `Starting ${provider.displayName} on this TV…` : "Playing.") : (r.message ?? "It didn't start."));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      void reload();
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      const r = await api.mediaStop(provider.gameId, displayId);
      setMsg(r.ok ? "Stopped." : (r.message ?? "It didn't stop."));
    } finally {
      setBusy(false);
      void reload();
    }
  };
  return (
    <div className="media">
      <p>
        <b>{provider.displayName}:</b> {STATE[target.state] ?? target.state}
        {target.nowPlaying ? ` · ${target.nowPlaying.title}${target.nowPlaying.listName ? ` (${target.nowPlaying.listName})` : ""}` : ""}
      </p>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)}>
          Play a {provider.displayName} list…
        </button>
      ) : (
        <span className="inline">
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">{items ? (lists.length ? "Pick a list…" : "No lists yet") : "Loading…"}</option>
            {lists.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {i.count ? ` (${i.count})` : ""}
              </option>
            ))}
          </select>
          <button className="primary" disabled={!pick || busy} onClick={() => void play()}>
            Play
          </button>
          {(target.state === "playing" || target.state === "paused" || target.state === "starting") && (
            <button disabled={busy} onClick={() => void stop()}>
              Stop
            </button>
          )}
        </span>
      )}
      {target.state === "local" && <p className="muted">Picking a list takes this TV back.</p>}
      {(msg || error) && <p className="muted">{msg || error}</p>}
    </div>
  );
}

/** Tonight page: plans (several TVs at once) from media apps. */
export function PlansCard() {
  const media = useLoad(api.media, 15_000);
  const providers = media.data?.providers ?? [];
  if (!providers.length) return null;
  return (
    <section className="card">
      <h2>Plans</h2>
      {providers.map((p) => (
        <ProviderPlans key={p.gameId} provider={p} />
      ))}
    </section>
  );
}

function ProviderPlans({ provider }: { provider: MediaProvider }) {
  const { items, error } = useMediaItems(provider.gameId);
  const [msg, setMsg] = useState("");
  const plans = (items ?? []).filter((i) => i.kind === "plan");
  return (
    <div>
      <b>{provider.displayName}</b>
      {error && <p className="error">{error}</p>}
      {items && !plans.length && <p className="muted">No plans yet (make them in {provider.displayName}'s own settings).</p>}
      <div className="buttons">
        {plans.map((pl) => (
          <button
            key={pl.id}
            onClick={() =>
              void api.mediaPlay(provider.gameId, pl.id).then(
                (r) => setMsg(r.ok ? `Starting "${pl.name}"…` : (r.message ?? "It didn't start.")),
                (e: Error) => setMsg(e.message),
              )
            }
          >
            Start: {pl.name}
          </button>
        ))}
      </div>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
